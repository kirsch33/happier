import type { Credentials } from '@/persistence';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';
import {
  listPendingQueueV2LocalIdsFromServer,
  updatePendingQueueV2RequestedActionViaHttp,
} from '@/api/session/pendingQueueV2Transport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { createFreshProviderRecoveryReservationStore } from './freshProviderRecoveryReservation';
import { resolveVendorResumeIdFromSessionMetadata, inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
  SessionWorkStateV1Schema,
  type SessionInitialGoalRequestV1,
} from '@happier-dev/protocol';

const RECOVERY_MESSAGE_MAX_LENGTH = 8_192;

type ResumeFreshResult =
  | Readonly<{ ok: true; sessionId: string; providerSessionId: string }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>;

function readInitialGoalFromMetadata(metadata: unknown): SessionInitialGoalRequestV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = SessionWorkStateV1Schema.safeParse(
    (metadata as Record<string, unknown>).sessionWorkStateV1,
  );
  if (!parsed.success) return null;

  const goal = parsed.data.primaryItemId
    ? parsed.data.items.find((item) => (
      item.id === parsed.data.primaryItemId && item.kind === 'goal'
    ))
    : null;
  if (!goal) return null;

  // Generic work state represents provider blocked/usage/budget states as `blocked`,
  // but Codex only accepts active/paused/complete writes. Restore those goals paused
  // so fresh startup is safe and retains the reason for recovery diagnostics.
  const status = goal.status === 'blocked' ? 'paused' : goal.status;

  return {
    objective: goal.title,
    status,
    ...(goal.statusReason ? { statusReason: goal.statusReason } : {}),
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
  };
}

export type FreshProviderCompletionObservation = Readonly<{
  daemonChildren: readonly Readonly<{
    happySessionId: string;
    startedBy: string;
    pid: number;
    sessionRunnerPid?: number | null;
    vendorResumeId?: string | null;
    processInstanceFingerprint?: string | null;
  }>[];
  sessionLock: Readonly<{ pid: number; processInstanceFingerprint?: string | null }> | null;
  rawActive: boolean;
  pendingIds: readonly string[];
  marker: Readonly<{
    pid?: number;
    happySessionId?: string;
    vendorResumeId?: string;
    hasResume?: boolean;
    hasFreshProviderContextOnce?: boolean;
  }> | null;
}>;

export async function awaitFreshProviderCompletion(params: Readonly<{
  sessionId: string;
  requestId: string;
  previousProviderId: string | null;
  pid: number;
  observe: () => Promise<FreshProviderCompletionObservation>;
  nowMs?: () => number;
  wait: () => Promise<void>;
  timeoutMs: number;
}>): Promise<string | null> {
  const nowMs = params.nowMs ?? Date.now;
  const deadlineMs = nowMs() + params.timeoutMs;
  while (nowMs() < deadlineMs) {
    const observed = await params.observe();
    const matchingChildren = observed.daemonChildren.filter((child) =>
      child.happySessionId === params.sessionId && child.startedBy === 'daemon',
    );
    const tracked = matchingChildren.length === 1 && matchingChildren[0]?.pid === params.pid
      ? matchingChildren[0]
      : null;
    const effectiveRunnerPid = typeof tracked?.sessionRunnerPid === 'number'
      && Number.isInteger(tracked.sessionRunnerPid)
      && tracked.sessionRunnerPid > 0
      ? tracked.sessionRunnerPid
      : tracked?.pid ?? null;
    const trackedProcessInstanceFingerprint = typeof tracked?.processInstanceFingerprint === 'string'
      ? tracked.processInstanceFingerprint.trim()
      : '';
    const lockMatchesTrackedChild = observed.sessionLock?.pid === effectiveRunnerPid
      && trackedProcessInstanceFingerprint.length > 0
      && observed.sessionLock.processInstanceFingerprint === trackedProcessInstanceFingerprint;
    const providerSessionId = typeof tracked?.vendorResumeId === 'string' ? tracked.vendorResumeId.trim() : '';
    const providerIsNew = providerSessionId.length > 0
      && (!params.previousProviderId || providerSessionId !== params.previousProviderId);
    const markerMatches = observed.marker?.pid === effectiveRunnerPid
      && observed.marker.happySessionId === params.sessionId
      && observed.marker.vendorResumeId === providerSessionId
      && observed.marker.hasResume !== true
      && observed.marker.hasFreshProviderContextOnce !== true;
    if (
      tracked
      && lockMatchesTrackedChild
      && observed.rawActive
      && observed.pendingIds.length === 0
      && providerIsNew
      && markerMatches
    ) {
      return providerSessionId;
    }
    await params.wait();
  }
  return null;
}

export async function resumeFreshProviderContext(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  sessionId: string;
  message?: string;
  reservation: ReturnType<typeof createFreshProviderRecoveryReservationStore>;
  probeSessionRunnerServiceability: () => Promise<Readonly<{ state: string }>>;
  spawnSession: (options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>) => Promise<SpawnSessionResult>;
  awaitCompletion: (input: Readonly<{ sessionId: string; requestId: string; previousProviderId: string | null; pid: number }>) => Promise<string | null>;
}>): Promise<ResumeFreshResult> {
  const sessionId = params.sessionId.trim();
  const runner = await params.probeSessionRunnerServiceability();
  if (runner.state !== 'runner_absent') {
    return { ok: false, errorCode: 'runner_not_absent', errorMessage: 'The session runner must be absent before starting a fresh provider context.' };
  }
  const rawSession = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId, reason: 'manual-recovery' });
  if (!rawSession || rawSession.id !== sessionId || rawSession.archivedAt !== null || rawSession.active === true) {
    return { ok: false, errorCode: 'session_not_inactive', errorMessage: 'The exact session must be unarchived and inactive.' };
  }
  if (
    (rawSession.pendingCount !== 0 && rawSession.pendingCount !== 1)
    || typeof rawSession.pendingVersion !== 'number'
  ) {
    return { ok: false, errorCode: 'pending_shape_mismatch', errorMessage: 'The session must have exactly one Pending request.' };
  }
  let freshRawSession = rawSession;
  let pendingIds = await listPendingQueueV2LocalIdsFromServer({ token: params.credentials.token, sessionId });
  let seededRecoveryRequest = false;
  if (pendingIds.length !== rawSession.pendingCount) {
    return { ok: false, errorCode: 'pending_shape_mismatch', errorMessage: 'The session must have exactly one Pending request.' };
  }
  if (rawSession.pendingCount === 0) {
    const message = typeof params.message === 'string' ? params.message.trim() : '';
    if (!message || message.length > RECOVERY_MESSAGE_MAX_LENGTH) {
      return { ok: false, errorCode: 'pending_shape_mismatch', errorMessage: 'A bounded recovery instruction is required when the session has no Pending request.' };
    }
    const preflightMetadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
    if (!preflightMetadata) {
      return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The session metadata cannot be decrypted on this machine.' };
    }
    const preflightBase = buildInactiveSessionResumeSpawnOptions({
      sessionId,
      rawSession,
      metadata: preflightMetadata,
      initialTranscriptAfterSeq: rawSession.seq,
    });
    if (!preflightBase || preflightBase.machineId !== params.machineId) {
      return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The exact session is not owned by this machine.' };
    }
    const admissionAttempt = await params.reservation.prepareAdmission(sessionId);
    if (!admissionAttempt.ok || !admissionAttempt.localId) {
      return {
        ok: false,
        errorCode: admissionAttempt.ok ? 'reservation_corrupt' : admissionAttempt.code,
        errorMessage: 'A matching durable fresh recovery reservation is required before admission.',
      };
    }
    const seeded = await sendSessionMessage({
      credentials: params.credentials,
      idOrPrefix: sessionId,
      message,
      wait: false,
      timeoutMs: 5_000,
      requestedAction: { v: 1, kind: 'send_now' },
      resumeInactiveSession: false,
      localId: admissionAttempt.localId,
    });
    const seededId = seeded.ok && seeded.sessionId === sessionId && seeded.localId.trim() === admissionAttempt.localId
      ? admissionAttempt.localId
      : '';
    if (!seededId) {
      return { ok: false, errorCode: 'seed_admission_unconfirmed', errorMessage: 'The recovery Pending request was not durably confirmed.' };
    }
    const confirmedRawSession = await fetchSessionByIdCompat({
      token: params.credentials.token,
      sessionId,
      reason: 'manual-recovery',
    });
    if (
      !confirmedRawSession
      || confirmedRawSession.id !== sessionId
      || confirmedRawSession.archivedAt !== null
      || confirmedRawSession.active === true
      || confirmedRawSession.pendingCount !== 1
      || typeof confirmedRawSession.pendingVersion !== 'number'
    ) {
      return { ok: false, errorCode: 'post_seed_snapshot_drift', errorMessage: 'The recovery Pending request did not retain the exact inactive snapshot.' };
    }
    const confirmedPendingIds = await listPendingQueueV2LocalIdsFromServer({ token: params.credentials.token, sessionId });
    if (confirmedPendingIds.length !== 1 || confirmedPendingIds[0] !== seededId) {
      return { ok: false, errorCode: 'post_seed_snapshot_drift', errorMessage: 'The recovery Pending request did not retain exact durable custody.' };
    }
    freshRawSession = confirmedRawSession;
    pendingIds = confirmedPendingIds;
    seededRecoveryRequest = true;
  }
  if (pendingIds.length !== 1) {
    return { ok: false, errorCode: 'pending_shape_mismatch', errorMessage: 'The session must have exactly one Pending request.' };
  }
  if (!seededRecoveryRequest) {
    try {
      await updatePendingQueueV2RequestedActionViaHttp({
        token: params.credentials.token,
        sessionId,
        localId: pendingIds[0],
        requestedAction: { v: 1, kind: 'send_now' },
      });
    } catch {
      return {
        ok: false,
        errorCode: 'pending_action_promotion_failed',
        errorMessage: 'The exact Pending request could not be promoted to durable send-now authority.',
      };
    }
    const promotedRawSession = await fetchSessionByIdCompat({
      token: params.credentials.token,
      sessionId,
      reason: 'manual-recovery',
    });
    const promotedPendingIds = await listPendingQueueV2LocalIdsFromServer({
      token: params.credentials.token,
      sessionId,
    });
    if (
      !promotedRawSession
      || promotedRawSession.id !== sessionId
      || promotedRawSession.archivedAt !== null
      || promotedRawSession.active === true
      || promotedRawSession.pendingCount !== 1
      || typeof promotedRawSession.pendingVersion !== 'number'
      || promotedPendingIds.length !== 1
      || promotedPendingIds[0] !== pendingIds[0]
    ) {
      return {
        ok: false,
        errorCode: 'pending_action_promotion_failed',
        errorMessage: 'The exact Pending request changed while acquiring durable send-now authority.',
      };
    }
    freshRawSession = promotedRawSession;
    pendingIds = promotedPendingIds;
  }
  const pendingVersion = freshRawSession.pendingVersion;
  if (typeof pendingVersion !== 'number') {
    return { ok: false, errorCode: 'pending_shape_mismatch', errorMessage: 'The session must retain an exact Pending version.' };
  }
  const reservationClaim = await params.reservation.claim(sessionId, pendingIds[0], pendingVersion);
  if (!reservationClaim.ok) {
    return { ok: false, errorCode: reservationClaim.code, errorMessage: 'A matching fresh recovery reservation is required.' };
  }
  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: freshRawSession });
  if (!metadata) {
    return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The session metadata cannot be decrypted on this machine.' };
  }
  const base = buildInactiveSessionResumeSpawnOptions({
    sessionId,
    rawSession: freshRawSession,
    metadata,
    initialTranscriptAfterSeq: freshRawSession.seq,
    executionAuthorization: { provenance: 'user_request', requestId: pendingIds[0] },
  });
  if (!base || base.machineId !== params.machineId) {
    return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The exact session is not owned by this machine.' };
  }
  const initialGoal = readInitialGoalFromMetadata(metadata);
  const activation = await activatePendingInactiveSession({
    credentials: params.credentials,
    machineId: params.machineId,
    sessionId,
    requestId: pendingIds[0],
    pendingVersion,
    expectedPendingSnapshot: { pendingVersion, requestId: pendingIds[0] },
    spawnSession: async (options) => {
      const { resume: _resume, ...withoutVendorResume } = options;
      return await params.spawnSession({
        ...withoutVendorResume,
        ...(initialGoal ? { initialGoal } : {}),
        freshProviderContextOnce: true,
      });
    },
  });
  if (
    activation.status !== 'activated'
    || activation.runnerAcceptance !== 'newly_accepted'
    || typeof activation.pid !== 'number'
    || !Number.isInteger(activation.pid)
    || activation.pid <= 0
  ) {
    return { ok: false, errorCode: 'completion_unproven', errorMessage: 'The daemon did not newly accept the fresh provider context.' };
  }
  const previousProviderId = resolveVendorResumeIdFromSessionMetadata(
    inferAgentIdFromSessionMetadata(metadata),
    metadata,
  ) ?? null;
  const providerSessionId = await params.awaitCompletion({
    sessionId,
    requestId: pendingIds[0],
    previousProviderId,
    pid: activation.pid,
  });
  if (!providerSessionId) {
    return { ok: false, errorCode: 'completion_unproven', errorMessage: 'Provider ID publication and Pending drain completion are not yet proven.' };
  }
  const reservationClear = await params.reservation.clearProven(sessionId, pendingIds[0], pendingVersion);
  if (!reservationClear.ok) {
    return { ok: false, errorCode: 'completion_unproven', errorMessage: 'Fresh recovery reservation completion could not be proven.' };
  }
  return { ok: true, sessionId, providerSessionId };
}
