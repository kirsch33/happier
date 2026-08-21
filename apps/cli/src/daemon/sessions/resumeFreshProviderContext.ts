import type { Credentials } from '@/persistence';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';
import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { resolveVendorResumeIdFromSessionMetadata, inferAgentIdFromSessionMetadata } from '@happier-dev/agents';

type ResumeFreshResult =
  | Readonly<{ ok: true; sessionId: string; providerSessionId: string }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>;

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
  pendingControlState: string | null;
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
      && observed.pendingControlState === 'servable'
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
  if (rawSession.pendingCount !== 1 || typeof rawSession.pendingVersion !== 'number') {
    return { ok: false, errorCode: 'pending_not_exact', errorMessage: 'The session must have exactly one Pending request.' };
  }
  const pendingIds = await listPendingQueueV2LocalIdsFromServer({ token: params.credentials.token, sessionId });
  if (pendingIds.length !== 1) {
    return { ok: false, errorCode: 'pending_not_exact', errorMessage: 'The session must have exactly one Pending request.' };
  }
  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
  if (!metadata) {
    return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The session metadata cannot be decrypted on this machine.' };
  }
  const base = buildInactiveSessionResumeSpawnOptions({
    sessionId,
    rawSession,
    metadata,
    initialTranscriptAfterSeq: rawSession.seq,
    executionAuthorization: { provenance: 'user_request', requestId: pendingIds[0] },
  });
  if (!base || base.machineId !== params.machineId) {
    return { ok: false, errorCode: 'identity_unavailable', errorMessage: 'The exact session is not owned by this machine.' };
  }
  const activation = await activatePendingInactiveSession({
    credentials: params.credentials,
    machineId: params.machineId,
    sessionId,
    requestId: pendingIds[0],
    pendingVersion: rawSession.pendingVersion,
    expectedPendingSnapshot: { pendingVersion: rawSession.pendingVersion, requestId: pendingIds[0] },
    spawnSession: async (options) => {
      const { resume: _resume, ...withoutVendorResume } = options;
      return await params.spawnSession({
        ...withoutVendorResume,
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
  return providerSessionId
    ? { ok: true, sessionId, providerSessionId }
    : { ok: false, errorCode: 'completion_unproven', errorMessage: 'Provider ID publication and Pending drain completion are not yet proven.' };
}
