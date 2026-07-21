import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import {
  parsePermissionIntentAlias,
  resolveAgentIdFromSessionMetadata,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { withSessionUserMessageDeliveryIntentMeta } from '@happier-dev/protocol';

import { fetchEncryptedTranscriptPageAfterSeq } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
  materializeNextPendingQueueV2MessageViaHttp,
  type PendingQueueMaterializeNextResult,
} from '@/api/session/pendingQueueV2Transport';
import { waitForTranscriptEncryptedMessageByLocalId } from '@/api/session/transcriptMessageLookup';
import { readSettings, type Credentials } from '@/persistence';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import {
  detectSessionTurnActivity,
  isMemoryArtifactDecryptedRow,
  isSessionUserMessage,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { spawnDaemonSession } from '@/daemon/controlClient';
import { buildInactiveUsageLimitResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import { sendSessionMessageViaSocketCommitted } from '@/session/transport/socket/sessionSocketSendMessage';
import {
  decryptSessionPayload,
  encryptSessionPayload,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { detectSessionTurnLifecycleEvent, isBareSessionReadyEvent } from '@/session/shared/sessionTurnLifecycle';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type SendSessionMessageResult =
  | Readonly<{ ok: true; sessionId: string; localId: string; waited: boolean }>
  | Readonly<{
      ok: false;
      code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'timeout' | 'wait_failed';
      candidates?: string[];
      message?: string;
    }>;

export type SendSessionMessageSocketCommit = Readonly<{
  sessionId: string;
  localId: string;
}>;

type SocketCommitResult = Readonly<{
  materializedSeq: number | null;
}>;

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

function isFallbackSafeRuntimeRpcError(error: unknown): boolean {
  if (readRpcErrorCode(error) === 'session_not_found') {
    return true;
  }

  const errorMessage = error instanceof Error ? error.message : String(error ?? '');
  if (
    errorMessage === 'Method not found'
    || errorMessage === 'RPC method not available'
    || errorMessage === 'Socket connect timeout'
  ) {
    return true;
  }

  return errorMessage.toLowerCase().includes('connect_error');
}

async function nudgePendingQueueBestEffort(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<PendingQueueMaterializeNextResult | null> {
  try {
    return await materializeNextPendingQueueV2MessageViaHttp({
      token: params.token,
      sessionId: params.sessionId,
    });
  } catch {
    // Best-effort only. Callers may layer stronger retry loops when materialization
    // is safety-critical, but ordinary socket-fallback sends should still attempt
    // one canonical nudge here.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRuntimeUserMessageSendFailure(value: unknown): Readonly<{
  errorCode: string;
  error: string;
}> | null {
  const record = asRecord(value);
  if (!record || record.ok !== false) return null;
  const errorCode = typeof record.errorCode === 'string' ? record.errorCode : 'runtime_send_failed';
  const error = typeof record.error === 'string' ? record.error : errorCode;
  return { errorCode, error };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolveLocalWakeMachineId(params: Readonly<{
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>): Promise<string | null> {
  try {
    const currentMachineId = readNonEmptyString((await readSettings()).machineId);
    if (!currentMachineId) return null;

    const rawSession = params.rawSession as RawSessionRecord & Readonly<{
      host?: unknown;
      homeDir?: unknown;
    }>;
    const proof = resolveMachineControlLocalityProof({
      sessionMachineId: readNonEmptyString(params.rawSession.machineId) ?? readNonEmptyString(params.metadata.machineId),
      currentMachineId,
      sessionHost: readNonEmptyString(rawSession.host) ?? readNonEmptyString(params.metadata.host),
      sessionHomeDir: readNonEmptyString(rawSession.homeDir) ?? readNonEmptyString(params.metadata.homeDir),
      currentMachineHost: await getPreferredHostName(),
      currentMachineHomeDir: homedir(),
    });
    return proof ? currentMachineId : null;
  } catch {
    return null;
  }
}

function readMaterializedSeqForLocalId(
  result: PendingQueueMaterializeNextResult | null,
  localId: string,
): number | null {
  const message = result?.message;
  if (!message || message.localId !== localId) return null;
  return Number.isSafeInteger(message.seq) && message.seq >= 0 ? message.seq : null;
}

async function resolveInitialTranscriptAfterSeqForSocketCommit(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number | null;
}>): Promise<number | undefined> {
  const materializedSeq = params.materializedSeq;
  if (typeof materializedSeq === 'number' && Number.isSafeInteger(materializedSeq) && materializedSeq >= 0) {
    return Math.max(0, materializedSeq - 1);
  }

  try {
    const materialized = await waitForTranscriptEncryptedMessageByLocalId({
      token: params.token,
      sessionId: params.sessionId,
      localId: params.localId,
      maxWaitMs: 1_500,
    });
    if (materialized && Number.isSafeInteger(materialized.seq) && materialized.seq >= 0) {
      return Math.max(0, materialized.seq - 1);
    }
  } catch {
    // If the prompt is still only pending, the resumed runtime can consume the pending queue.
  }
  return undefined;
}

async function wakeSocketCommittedSessionBestEffort(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  rawSession: RawSessionRecord;
  decryptedMetadata: unknown;
  materializedSeq: number | null;
  permissionModeOverride?: string;
  permissionIntent: PermissionIntent;
  modelOverride?: string | null;
  modelId: string;
}>): Promise<void> {
  const metadata = asRecord(params.decryptedMetadata);
  if (!metadata) return;

  // Avoid guessing a backend for historical sessions with incomplete metadata.
  // The inactive resume helper falls back to Codex; CLI send should not silently
  // change a Claude/OpenCode session into Codex when metadata is undecidable.
  if (!resolveAgentIdFromSessionMetadata(metadata)) return;

  try {
    const localMachineId = await resolveLocalWakeMachineId({
      rawSession: params.rawSession,
      metadata,
    });
    if (!localMachineId) return;

    const spawnOptions = buildInactiveUsageLimitResumeSpawnOptions({
      fallbackMachineId: localMachineId,
      sessionId: params.sessionId,
      rawSession: params.rawSession,
      metadata,
    });
    if (!spawnOptions) return;

    const initialTranscriptAfterSeq = await resolveInitialTranscriptAfterSeqForSocketCommit({
      token: params.token,
      sessionId: params.sessionId,
      localId: params.localId,
      materializedSeq: params.materializedSeq,
    });
    const now = Date.now();

    const spawnRequest: SpawnDaemonSessionRequest = {
      ...(spawnOptions as SpawnDaemonSessionRequest),
      // A local daemon wake must always use the daemon's current machine identity.
      // This also safely adopts legacy sessions whose persisted machine id was replaced
      // while host + home still prove that the session belongs to this installation.
      machineId: localMachineId,
      ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
      ...(params.permissionModeOverride !== undefined
        ? { permissionMode: params.permissionIntent, permissionModeUpdatedAt: now }
        : {}),
      ...(params.modelOverride !== undefined
        ? { modelId: params.modelId || 'default', modelUpdatedAt: now }
        : {}),
    };
    await spawnDaemonSession(spawnRequest);
  } catch {
    // Sending should not fail solely because the local daemon could not be nudged.
    // A waiting caller will still time out, preserving the visible failure signal.
  }
}

function resolvePermissionIntent(params: Readonly<{
  permissionModeOverride?: string;
  decryptedMetadata: unknown;
}>): PermissionIntent {
  if (params.permissionModeOverride) {
    return parsePermissionIntentOrThrow(params.permissionModeOverride);
  }
  const resolved = resolvePermissionIntentFromSessionMetadata(params.decryptedMetadata);
  return resolved?.intent ?? 'default';
}

function resolveModelId(params: Readonly<{
  modelOverride?: string | null;
  decryptedMetadata: unknown;
}>): string {
  if (params.modelOverride !== undefined) {
    return params.modelOverride ?? 'default';
  }
  const resolved = resolveMetadataStringOverrideV1(params.decryptedMetadata, 'modelOverrideV1', 'modelId');
  return resolved?.value ?? '';
}

function unknownCurrentUserTurnActivity(): SessionTurnActivity {
  return {
    pendingUserTurns: 1,
    activeTaskInFlight: false,
    turnInFlight: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.trunc(ms))));
}

function decryptTranscriptRowContent(params: Readonly<{
  content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
}>): unknown | null {
  if (params.content.t === 'plain') {
    return params.content.v;
  }
  try {
    return decryptSessionPayload({
      ctx: params.ctx,
      ciphertextBase64: params.content.c,
    });
  } catch {
    return null;
  }
}

function isAssistantTurnActivity(value: unknown): boolean {
  if (!value || isMemoryArtifactDecryptedRow(value) || isSessionUserMessage(value)) {
    return false;
  }
  if (isBareSessionReadyEvent(value)) {
    return false;
  }
  return detectSessionTurnLifecycleEvent(value) !== null;
}

async function resolveCurrentTurnAfterSeqExclusive(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
}>): Promise<number> {
  const materializedSeq = Math.max(0, Math.trunc(params.materializedSeq));
  const fallbackAfterSeqExclusive = Math.max(0, materializedSeq - 1);

  try {
    const windowSize = 50;
    const rows = await fetchEncryptedTranscriptPageAfterSeq({
      token: params.token,
      sessionId: params.sessionId,
      afterSeq: Math.max(0, materializedSeq - windowSize),
      limit: windowSize + 1,
    });
    const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);
    for (let index = orderedRows.length - 1; index >= 0; index -= 1) {
      const row = orderedRows[index];
      if (row?.localId === params.localId) {
        return Math.max(0, row.seq - 1);
      }
    }

    for (let index = orderedRows.length - 1; index >= 0; index -= 1) {
      const row = orderedRows[index];
      if (!row) {
        continue;
      }
      if (row.content.t === 'plain') {
        if (isSessionUserMessage(row.content.v)) {
          return Math.max(0, row.seq - 1);
        }
        continue;
      }
      try {
        if (isSessionUserMessage(decryptSessionPayload({
          ctx: params.ctx,
          ciphertextBase64: row.content.c,
        }))) {
          return Math.max(0, row.seq - 1);
        }
      } catch {
        continue;
      }
    }

    return fallbackAfterSeqExclusive;
  } catch {
    return fallbackAfterSeqExclusive;
  }
}

async function hasAssistantActivityAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
}>): Promise<boolean> {
  const afterSeq = Math.max(0, Math.trunc(params.materializedSeq) - 1);
  const rows = await fetchEncryptedTranscriptPageAfterSeq({
    token: params.token,
    sessionId: params.sessionId,
    afterSeq,
    limit: 100,
  });
  const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);
  const currentUserSeq = orderedRows.find((row) => row.localId === params.localId)?.seq ?? params.materializedSeq;

  for (const row of orderedRows) {
    if (row.seq <= currentUserSeq) {
      continue;
    }
    const decrypted = decryptTranscriptRowContent({
      content: row.content,
      ctx: params.ctx,
    });
    if (isAssistantTurnActivity(decrypted)) {
      return true;
    }
  }

  return false;
}

async function waitForAssistantActivityAfterCurrentUserTurn(params: Readonly<{
  token: string;
  sessionId: string;
  localId: string;
  materializedSeq: number;
  ctx: Readonly<{
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
  }>;
  maxWaitMs: number;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + Math.max(1, Math.trunc(params.maxWaitMs));
  let lastAttempt = false;

  while (Date.now() <= deadlineMs) {
    lastAttempt = true;
    try {
      if (await hasAssistantActivityAfterCurrentUserTurn(params)) {
        return true;
      }
    } catch {
      // Missing proof is not success. Keep polling until the caller's wait budget expires.
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(100, remainingMs));
  }

  if (!lastAttempt) {
    return hasAssistantActivityAfterCurrentUserTurn(params).catch(() => false);
  }
  return false;
}

export async function sendSessionMessage(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  message: string;
  wait: boolean;
  timeoutMs: number;
  localId?: string;
  permissionModeOverride?: string;
  modelOverride?: string | null;
  onCommittedViaSocket?: (input: SendSessionMessageSocketCommit) => Promise<void> | void;
}>): Promise<SendSessionMessageResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }
  const sessionId = sessionTarget.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Resolved session transport context is missing session id');
  }

  const localId = typeof params.localId === 'string' && params.localId.trim().length > 0
    ? params.localId.trim()
    : randomUUID();
  const decryptedMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
  });
  const permissionIntent = resolvePermissionIntent({
    permissionModeOverride: params.permissionModeOverride,
    decryptedMetadata,
  });
  const modelId = resolveModelId({
    modelOverride: params.modelOverride,
    decryptedMetadata,
  });

  const record = {
    role: 'user',
    content: { type: 'text', text: params.message },
    meta: withSessionUserMessageDeliveryIntentMeta({
      sentFrom: 'cli',
      // Important: `source: 'cli'` is reserved for CLI-authored transcript traffic that
      // the running agent runtime should treat as "self-sent" (e.g. local provider echoes).
      // A `happier session send` prompt is user intent and must be delivered to the runtime
      // queue even when it is committed by the daemon via session RPC.
      source: 'ui',
      permissionMode: permissionIntent,
      ...(modelId && modelId !== 'default' ? { model: modelId } : {}),
    }, 'explicit_pending'),
  } as const;

  const content =
    sessionTarget.mode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({ t: 'encrypted', c: encryptSessionPayload({ ctx: sessionTarget.ctx, payload: record }) } as const);

  const shouldUseRuntimeRpc = sessionTarget.rawSession.active === true;
  async function commitViaSocket(): Promise<SocketCommitResult> {
    await sendSessionMessageViaSocketCommitted({
      token: params.credentials.token,
      sessionId: sessionId,
      content,
      localId,
      messageRole: 'user',
      sentFrom: 'cli',
      permissionMode: permissionIntent,
    });
    const materialized = await nudgePendingQueueBestEffort({
      token: params.credentials.token,
      sessionId,
    });
    await params.onCommittedViaSocket?.({
      sessionId: sessionId,
      localId,
    });
    return {
      materializedSeq: readMaterializedSeqForLocalId(materialized, localId),
    };
  }
  let socketCommitResult: SocketCommitResult | null = null;
  let runtimeUserMessageSendFailure: Readonly<{ errorCode: string; error: string }> | null = null;
  if (shouldUseRuntimeRpc) {
    try {
      const runtimeResult = await callSessionRpc({
        token: params.credentials.token,
        sessionId: sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
        request: {
          text: params.message,
          localId,
          meta: record.meta,
        },
      });
      runtimeUserMessageSendFailure = readRuntimeUserMessageSendFailure(runtimeResult);
      if (runtimeUserMessageSendFailure) {
        const materialized = await nudgePendingQueueBestEffort({
          token: params.credentials.token,
          sessionId,
        });
        socketCommitResult = {
          materializedSeq: readMaterializedSeqForLocalId(materialized, localId),
        };
        await wakeSocketCommittedSessionBestEffort({
          token: params.credentials.token,
          sessionId,
          localId,
          rawSession: sessionTarget.rawSession,
          decryptedMetadata,
          materializedSeq: socketCommitResult.materializedSeq,
          permissionModeOverride: params.permissionModeOverride,
          permissionIntent,
          modelOverride: params.modelOverride,
          modelId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error ?? '');
      if (errorMessage === 'RPC call timeout') {
        return {
          ok: false,
          code: 'timeout',
          message: errorMessage,
        };
      }
      if (!isFallbackSafeRuntimeRpcError(error)) {
        throw error;
      }

      socketCommitResult = await commitViaSocket();
      await wakeSocketCommittedSessionBestEffort({
        token: params.credentials.token,
        sessionId,
        localId,
        rawSession: sessionTarget.rawSession,
        decryptedMetadata,
        materializedSeq: socketCommitResult.materializedSeq,
        permissionModeOverride: params.permissionModeOverride,
        permissionIntent,
        modelOverride: params.modelOverride,
        modelId,
      });
    }
  } else {
    socketCommitResult = await commitViaSocket();
    await wakeSocketCommittedSessionBestEffort({
      token: params.credentials.token,
      sessionId,
      localId,
      rawSession: sessionTarget.rawSession,
      decryptedMetadata,
      materializedSeq: socketCommitResult.materializedSeq,
      permissionModeOverride: params.permissionModeOverride,
      permissionIntent,
      modelOverride: params.modelOverride,
      modelId,
    });
  }

  if (!params.wait) {
    if (runtimeUserMessageSendFailure) {
      return {
        ok: false,
        code: 'wait_failed',
        message: runtimeUserMessageSendFailure.error,
      };
    }
    return {
      ok: true,
      sessionId: sessionId,
      localId,
      waited: false,
    };
  }

  const deadlineMs = Date.now() + params.timeoutMs;
  let waitSessionSnapshot = sessionTarget.rawSession;
  let currentTurnAfterSeqExclusive: number | null = null;

  try {
    const materialized = await waitForTranscriptEncryptedMessageByLocalId({
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      maxWaitMs: Math.max(1, deadlineMs - Date.now()),
    });
    if (!materialized) {
      return {
        ok: false,
        code: 'timeout',
      };
    }

    try {
      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: sessionId,
      });
      if (!refreshedSession) {
        throw new Error('Session not found after send');
      }
      waitSessionSnapshot = refreshedSession;
    } catch {
      waitSessionSnapshot = sessionTarget.rawSession;
    }
    currentTurnAfterSeqExclusive = await resolveCurrentTurnAfterSeqExclusive({
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
    });

    let initialTurnActivityRequiresTranscriptIdleEvidence = false;
    let initialTurnActivity: SessionTurnActivity;
    try {
      initialTurnActivity = await detectSessionTurnActivity({
        token: params.credentials.token,
        sessionId: sessionId,
        encryptionMode: sessionTarget.mode,
        encryptionKey: sessionTarget.ctx.encryptionKey,
        encryptionVariant: sessionTarget.ctx.encryptionVariant,
        ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
      });
    } catch {
      initialTurnActivity = unknownCurrentUserTurnActivity();
      initialTurnActivityRequiresTranscriptIdleEvidence = true;
    }

    const agentStateCiphertext =
      typeof waitSessionSnapshot.agentState === 'string' ? String(waitSessionSnapshot.agentState).trim() : null;

    await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: Math.max(1, deadlineMs - Date.now()),
      initialTurnActivity,
      initialTurnActivityRequiresTranscriptIdleEvidence,
      recheckTurnActivity: async () =>
        detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId: sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
          ...(typeof currentTurnAfterSeqExclusive === 'number' ? { afterSeqExclusive: currentTurnAfterSeqExclusive } : {}),
        }),
      initialAgentStateCiphertextBase64:
        agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
    });
    const observedAssistantActivity = await waitForAssistantActivityAfterCurrentUserTurn({
      token: params.credentials.token,
      sessionId: sessionId,
      localId,
      materializedSeq: materialized.seq,
      ctx: sessionTarget.ctx,
      maxWaitMs: Math.max(1, deadlineMs - Date.now()),
    });
    if (!observedAssistantActivity) {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    return {
      ok: true,
      sessionId: sessionId,
      localId,
      waited: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (errorMessage === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    return {
      ok: false,
      code: 'wait_failed',
      message: errorMessage || 'Wait for idle failed',
    };
  }
}
