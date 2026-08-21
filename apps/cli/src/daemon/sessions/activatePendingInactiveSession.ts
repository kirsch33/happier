import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { Credentials } from '@/persistence';
import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

type PendingInactiveSessionActivationResult =
  | Readonly<{
      status: 'activated';
      runnerAcceptance?: Extract<SpawnSessionResult, { type: 'success' }>['runnerAcceptance'];
      pid?: number;
    }>
  | Readonly<{
      status: 'not-needed';
      reason: 'active' | 'pending-resolved';
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'session-unavailable' | 'snapshot-stale' | 'identity-unavailable' | 'spawn-rejected';
    }>;

export async function activatePendingInactiveSession(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  /** Resume-fresh uses this to reject a second-fetch Pending snapshot that changed before spawn. */
  expectedPendingSnapshot?: Readonly<{ pendingVersion: number; requestId: string }>;
  spawnSession: (options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>) => Promise<SpawnSessionResult>;
}>): Promise<PendingInactiveSessionActivationResult> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  if (!rawSession || rawSession.id !== params.sessionId) {
    return { status: 'rejected', reason: 'session-unavailable' };
  }
  if (rawSession.active === true) {
    return { status: 'not-needed', reason: 'active' };
  }
  if (
    typeof rawSession.pendingVersion === 'number'
    && rawSession.pendingVersion < params.pendingVersion
  ) {
    return { status: 'rejected', reason: 'snapshot-stale' };
  }
  if ((rawSession.pendingCount ?? 0) < 1) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const pendingLocalIds = await listPendingQueueV2LocalIdsFromServer({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  const expectedPendingSnapshot = params.expectedPendingSnapshot;
  if (expectedPendingSnapshot && (
    rawSession.archivedAt !== null
    || rawSession.pendingVersion !== expectedPendingSnapshot.pendingVersion
    || rawSession.pendingCount !== 1
    || pendingLocalIds.length !== 1
    || pendingLocalIds[0] !== expectedPendingSnapshot.requestId
  )) {
    return { status: 'rejected', reason: 'snapshot-stale' };
  }
  if (!pendingLocalIds.includes(params.requestId)) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const metadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession,
  });
  if (!metadata) {
    return { status: 'rejected', reason: 'identity-unavailable' };
  }
  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession,
    metadata,
    initialTranscriptAfterSeq: rawSession.seq,
    executionAuthorization: {
      provenance: 'user_request',
      requestId: params.requestId,
    },
  });
  if (!options || options.machineId !== params.machineId) {
    return { status: 'rejected', reason: 'identity-unavailable' };
  }

  const result = await params.spawnSession(options);
  if (result.type !== 'success' || result.sessionId !== params.sessionId) {
    return { status: 'rejected', reason: 'spawn-rejected' };
  }
  return {
    status: 'activated',
    ...(result.runnerAcceptance ? { runnerAcceptance: result.runnerAcceptance } : {}),
    ...(typeof result.pid === 'number' && Number.isInteger(result.pid) && result.pid > 0 ? { pid: result.pid } : {}),
  };
}
