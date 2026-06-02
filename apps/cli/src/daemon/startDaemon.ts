import fs from 'fs/promises';
import os from 'os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

import { ApiClient, isMachineContentPublicKeyMismatchError } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { ApiMachineClient } from '@/api/apiMachine';
import { applyInitialTranscriptAfterSeqToAttachPayload } from '@/daemon/sessionEncryption/applyInitialTranscriptAfterSeqToAttachPayload';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, type Metadata } from '@/api/types';
import {
  resolveCanonicalCodexBackendMode,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration, reloadConfiguration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { buildHappyCliSubprocessLaunchSpec, spawnHappyCLI } from '@/utils/spawnHappyCLI';
import {
  getConnectedServiceRuntimeAuthAdapter,
  getVendorResumeSupport,
  requireCatalogEntry,
  resolveConnectedServiceCredentialLifecycleDescriptor,
  resolveConnectedServiceCandidatePersistedSessionFile,
  resolveConnectedServiceSwitchContinuity,
  resolveAgentCliSubcommand,
  resolveCatalogAgentId,
} from '@/backends/catalog';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import {
  writeDaemonState,
  DaemonLocallyPersistedState,
  acquireDaemonLock,
  releaseDaemonLock,
  clearDaemonState,
  readCredentials,
  readSettings,
} from '@/persistence';
import type { Credentials } from '@/persistence';
import { createSessionAttachFile } from './sessionAttachFile';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';
import { shouldRetryMachineRegistrationError } from './machineRegistrationRetryPolicy';
import { computeRestartDelayMs } from '@/subprocess/supervision/backoff';
import {
  isDaemonStartupSourceServiceManaged,
  resolveDaemonTakeoverRequestedFromEnv,
  resolveDaemonServiceLabelFromEnv,
  resolveDaemonStartupSourceFromEnv,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { DaemonStartupConflictError } from '@/daemon/ownership/DaemonStartupConflictError';
import { evaluateDaemonStartupServiceConflict } from '@/daemon/ownership/daemonServiceInventory';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import { isDaemonRunningCurrentlyInstalledHappyVersion, resolveDaemonSpawnSessionByNonce, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import {
  createDirectPeerTransferRegistry,
  requestDirectPeerTransferToFile,
  startDirectPeerTransferServer,
} from '@/machines/transfer/directPeerTransport';
import { resolveMachineTransferRuntimeConfig } from '@/machines/transfer/transferRuntimeConfig';
import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { resolveSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { resolveRespawnSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveRespawnSessionRuntimeSnapshot';
import { buildInactiveUsageLimitResumeSpawnOptions } from './sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';
import { buildHandoffSessionMetadataFromTrackedSession } from './sessions/buildHandoffSessionMetadataFromTrackedSession';
import { createOnChildExited } from './sessions/onChildExited';
import { publishOrphanedStartupSessionEnds } from './sessions/publishOrphanedStartupSessionEnds';
import { waitForVisibleConsoleSessionWebhook } from './sessions/visibleConsoleSpawnWaiter';
import { createStopSession } from './sessions/stopSession';
import { waitForExistingSessionExitIfStopRequested } from './sessions/waitForExistingSessionExitIfStopRequested';
import { resolveSpawnWebhookResult } from './sessions/resolveSpawnWebhookResult';
import { isSessionRunnerActive as isSessionRunnerActiveInDaemon } from './sessions/isSessionRunnerActive';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { createSessionRunnerRespawnManager } from './processSupervision/sessionRunnerRespawn';
import { buildTrackedSessionRespawnEnvironmentVariables } from './processSupervision/sessionRunnerRespawnDescriptor';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { publishShutdownStateBestEffort } from './lifecycle/publishShutdownState';
import { projectPath } from '@/projectPath';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { selectPreferredTmuxSessionName, TmuxUtilities, isTmuxAvailable } from '@/integrations/tmux';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { reportDaemonObservedSessionExit } from './sessionTermination';

import { getPreferredHostName, initialMachineMetadata } from './machine/metadata';
export { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import {
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
} from './platform/linux/migrateTrackedSessionProcessesOutOfDaemonServiceCgroup';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { applySpawnedChildOomScoreAdjustment } from './platform/linux/applySpawnedChildOomScoreAdjustment';
import { resolveWindowsRemoteSessionConsoleMode } from './platform/windows/windowsSessionConsoleMode';
import { startHappySessionInVisibleWindowsConsole } from './platform/windows/spawnHappyCliVisibleConsole';
import { startHappySessionInWindowsTerminal } from './platform/windows/spawnHappyCliWindowsTerminal';
import {
  buildWindowsHostedTerminalArgs,
  buildWindowsHostedTerminalAttachment,
  buildWindowsTerminalWindowIdentity,
  resolveWindowsTerminalWindowName,
} from './platform/windows/windowsHostedSessionRuntime';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { buildHappySessionControlArgs } from './sessionSpawnArgs';
import { serializeDaemonInitialGoalForEnv, HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY } from '@/agent/runtime/sessionInitialGoal';
import { resolveExistingSessionAttachContext } from './sessionEncryption/resolveExistingSessionAttachContext';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { ensureSessionDirectory } from './startup/ensureSessionDirectory';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { resolveDaemonDiagnosticSubsystemGates } from './startup/diagnosticSubsystemGates';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';
import { resolveSpawnChildEnvironment } from './spawn/resolveSpawnChildEnvironment';
import { buildSpawnChildProcessEnv } from './spawn/buildSpawnChildProcessEnv';
import { resolveStackProcessKindOverrideForSessionSpawn } from './spawn/resolveStackProcessKindOverrideForSessionSpawn';
import { createSpawnConcurrencyGate } from './spawn/createSpawnConcurrencyGate';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from './spawn/spawnRequestCoalescer';
import { normalizeSpawnSessionDirectory } from '@/rpc/handlers/spawnSessionOptionsContract';
import { resolveHappierRuntimeContextEnv } from '@/utils/env/resolveHappierRuntimeContextEnv';
import { startAutomationWorker, type AutomationWorkerHandle } from './automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from './memory/memoryWorker';
import { createDaemonConnectivityCoordinator } from './connection/createDaemonConnectivityCoordinator';
import {
  createDaemonServerWorkBudget,
  createDaemonServerWorkScheduler,
  type DaemonServerWorkScheduler,
} from './serverWork';
import { ConnectedServiceSpawnResumeUnreachableError, resolveConnectedServiceAuthForSpawn } from './connectedServices/resolveConnectedServiceAuthForSpawn';
import { buildSpawnResumeUnreachableErrorResult } from './connectedServices/buildSpawnResumeUnreachableErrorResult';
import { shouldResolveConnectedServiceAuthForSpawn } from './connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { createConnectedServicesAuthUpdatedRestartHandler } from './connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import { readConnectedServiceCredentialUpdateRefsFromAccountUpdate } from './connectedServices/refresh/readConnectedServiceCredentialUpdateRefsFromAccountUpdate';
import { startConnectedServiceRefreshLoop } from './connectedServices/refresh/startConnectedServiceRefreshLoop';
import { ConnectedServiceQuotasCoordinator } from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createConnectedServiceQuotaFetchers } from './connectedServices/quotas/createConnectedServiceQuotaFetchers';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from './connectedServices/quotas/createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './connectedServices/quotas/recordConnectedServiceRuntimeQuotaSnapshotForSession';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { commitConnectedServiceAccountSwitchSessionEvent } from './connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { createConnectedServiceSessionAuthSwitchCore } from './connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
  switchSessionConnectedServiceAuth,
  type SessionConnectedServiceAuthSwitchDiagnostics,
  type SessionConnectedServiceAuthSwitchResult,
} from './connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import {
  requestConnectedServiceSessionRestartSignal,
  type ConnectedServiceDaemonRestartDiagnosticInput,
  type ConnectedServiceDaemonRestartDiagnosticRecord,
} from './connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
  ConnectedServiceSwitchDeferralConflictError,
  createConnectedServiceSwitchDeferralQueue,
  type ConnectedServiceSwitchTarget,
} from './connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { logConnectedServiceDaemonRestartDiagnostic } from './connectedServices/sessionAuthSwitch/logConnectedServiceDaemonRestartDiagnostic';
import { logConnectedServiceAuthSwitchResult } from './connectedServices/sessionAuthSwitch/logConnectedServiceAuthSwitchResult';
import { resolveSharedStateRequiredSwitchContinuity } from './connectedServices/sessionAuthSwitch/resolveSharedStateRequiredSwitchContinuity';
import { createSessionConnectedServiceAuthHotApply } from './connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { resolveInactiveConnectedServiceSessionForAuthSwitch } from './connectedServices/sessionAuthSwitch/resolveInactiveConnectedServiceSessionForAuthSwitch';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from './connectedServices/notifications/dispatchConnectedServiceAccountSwitchNotification';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from './connectedServices/notifications/dispatchConnectedServiceCredentialHealthNotification';
import { ConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler';
import { parseConnectedServiceBindingSelections } from './connectedServices/parseConnectedServicesBindings';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
  SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionContinuationResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { resolveConnectedServiceQuotasDaemonOptions } from './connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from './connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop, type ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import {
  HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
  normalizeDaemonInitialPrompt,
} from '@/agent/runtime/daemonInitialPrompt';
import { parseBooleanEnv, resolveConnectedServicesProviderStateSharingPolicyV1, type AccountSettings, type BackendTargetRefV1, type ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId, ConnectedServiceSwitchEffectiveBinding } from '@/backends/types';
import { writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { normalizeAccountSettingsVersionHint } from '@/settings/accountSettings/accountSettingsVersion';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { UsageLimitRecoveryScheduler } from './connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { TemporaryThrottleRecoveryScheduler } from './connectedServices/temporaryThrottle/TemporaryThrottleRecoveryScheduler';
import { createSessionContinuationRecoveryController } from './connectedServices/continuation/sessionContinuationRecovery';
import {
  replayPendingConnectedServiceContinuationsForTrackedSessions,
  resolveConnectedServiceContinuationProviderContextAvailability,
} from './connectedServices/continuation/connectedServiceContinuationProviderContext';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import {
  createConnectedServiceMaterializationIdentity,
  readConnectedServiceMaterializationIdentityV1,
} from './connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import { resolveConnectedServiceTargetMaterializedRoot } from './connectedServices/materialize/resolveConnectedServiceTargetMaterializedRoot';
import { resolveConnectedServiceMaterializedRootDir } from './connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { hasCommittedUserMessageAfterMs } from '@/api/session/transcriptQueries';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function readBuiltInCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (target?.kind !== 'builtInAgent') return null;
  return typeof target.agentId === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(target.agentId)
    ? (target.agentId as CatalogAgentId)
    : null;
}

function resolveTrackedSessionNotificationTitle(tracked: TrackedSession | null | undefined): string | null {
  return getSessionNotificationTitle(() => tracked?.happySessionMetadataFromLocalWebhook ?? null);
}

function resolveCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId {
  if (target?.kind === 'configuredAcpBackend') {
    return 'customAcp';
  }
  return resolveCatalogAgentId(readBuiltInCatalogAgentIdFromBackendTarget(target));
}

async function recoverTrackedSessionConnectedServiceRuntimeAuthSwitch(input: Readonly<{
  tracked: TrackedSession;
  runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
}>): Promise<Readonly<{ ok: true } | { ok: false; errorCode?: string }>> {
  const selections = input.runtimeAuthSelectionsByServiceId;
  if (!selections || selections.size === 0) return { ok: true };
  const agentId = resolveCatalogAgentIdFromBackendTarget(input.tracked.spawnOptions?.backendTarget);
  const adapter = await getConnectedServiceRuntimeAuthAdapter(agentId);
  if (!adapter) return { ok: true };
  for (const selection of selections.values()) {
    const selectionRecord = selection && typeof selection === 'object' && !Array.isArray(selection)
      ? selection as Readonly<Record<string, unknown>>
      : null;
    if (typeof selectionRecord?.restartAndResume !== 'function') continue;
    const result = await adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId },
      selection,
    });
    if (result['recovered'] === false) {
      return {
        ok: false,
        errorCode: typeof result['reason'] === 'string' ? result['reason'] : 'recovery_failed',
      };
    }
  }
  return { ok: true };
}

function shouldDowngradeLegacyImplicitTmuxRequest(params: Readonly<{
  terminal: SpawnSessionOptions['terminal'] | undefined;
  backendTarget: BackendTargetRefV1 | undefined;
}>): boolean {
  if (params.terminal?.mode !== 'tmux') {
    return false;
  }
  const tmuxOptions = params.terminal.tmux;
  const hasExplicitTmuxConfig = tmuxOptions !== undefined && (
    tmuxOptions.sessionName !== undefined
    || tmuxOptions.isolated !== undefined
    || tmuxOptions.tmpDir !== undefined
  );
  if (hasExplicitTmuxConfig) {
    return false;
  }
  return params.backendTarget === undefined;
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1 as const, bindingsByServiceId: {} };
}

function readConnectedServiceBindingString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toConnectedServiceSwitchEffectiveBinding(
  serviceId: ConnectedServiceId,
  binding: ConnectedServiceBindingsV1['bindingsByServiceId'][string],
): ConnectedServiceSwitchEffectiveBinding | null {
  if (binding.source !== 'connected') return null;
  const selection = readConnectedServiceBindingString(binding.selection);
  if (selection === 'group') {
    const groupId = readConnectedServiceBindingString(binding.groupId);
    if (!groupId) return null;
    const profileId = readConnectedServiceBindingString(binding.profileId);
    return {
      source: 'connected',
      selection: 'group',
      serviceId,
      profileId: profileId || null,
      groupId,
    };
  }
  const profileId = readConnectedServiceBindingString(binding.profileId);
  if (!profileId) return null;
  return {
    source: 'connected',
    selection: 'profile',
    serviceId,
    profileId,
    groupId: null,
  };
}

async function canRepairMissingConnectedServiceMaterializationIdentityForSpawn(input: Readonly<{
  agentId: CatalogAgentId;
  sessionId: string;
  bindings: ConnectedServiceBindingsV1;
  vendorResumeId: string | null;
}>): Promise<boolean> {
  if (!input.vendorResumeId) return false;

  const connectedBindings: ConnectedServiceSwitchEffectiveBinding[] = [];
  for (const [serviceIdRaw, binding] of Object.entries(input.bindings.bindingsByServiceId)) {
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!parsedServiceId.success) continue;
    const effective = toConnectedServiceSwitchEffectiveBinding(parsedServiceId.data, binding);
    if (effective) connectedBindings.push(effective);
  }
  if (connectedBindings.length === 0) return false;

  for (const binding of connectedBindings) {
    const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
      sessionId: input.sessionId,
      agentId: input.agentId,
      serviceId: binding.serviceId,
      previousBinding: binding,
      nextBinding: binding,
      fromBindings: input.bindings,
      toBindings: input.bindings,
      ...(input.vendorResumeId ? { vendorResumeId: input.vendorResumeId } : {}),
    });
    if (continuity.mode !== 'restart_same_home') return false;
  }
  return true;
}

function resolveConnectedServiceRestartProcessGroupPid(tracked: TrackedSession): number | null {
  return tracked.startedBy === 'daemon' && tracked.childProcess && Number.isInteger(tracked.pid) && tracked.pid > 0
    ? tracked.pid
    : null;
}

function readUsageLimitRecoveryIntentFromControlResult(result: unknown): SessionUsageLimitRecoveryV1 | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

function readUsageLimitRecoveryResultStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

async function resumeInactiveSessionWhenUsageLimitReady(params: Readonly<{
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  fallbackMachineId: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>): Promise<boolean> {
  const spawnOptions = buildInactiveUsageLimitResumeSpawnOptions({
    sessionId: params.sessionId,
    fallbackMachineId: params.fallbackMachineId,
    rawSession: params.rawSession,
    metadata: params.metadata,
  });
  if (!spawnOptions) return false;
  const result = await params.spawnSession(spawnOptions);
  return result.type === 'success';
}

async function persistSessionConnectedServiceBindings(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  normalizedBindings: ReturnType<typeof readConnectedServiceBindingsOrEmpty>;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) {
    throw new Error('Session not found while persisting connected-service auth binding');
  }
  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (metadata) => {
      const existingUpdatedAt = typeof metadata.connectedServicesUpdatedAt === 'number'
        && Number.isFinite(metadata.connectedServicesUpdatedAt)
        ? metadata.connectedServicesUpdatedAt
        : 0;
      const existingMaterializationIdentity = readConnectedServiceMaterializationIdentityV1(
        metadata.connectedServiceMaterializationIdentityV1,
      );
      const nextMaterializationIdentity =
        existingMaterializationIdentity ?? params.connectedServiceMaterializationIdentityV1 ?? null;
      return {
        ...metadata,
        connectedServices: params.normalizedBindings,
        connectedServicesUpdatedAt: Math.max(Date.now(), existingUpdatedAt + 1),
        ...(nextMaterializationIdentity
          ? { connectedServiceMaterializationIdentityV1: nextMaterializationIdentity }
          : {}),
      };
    },
    maxAttempts: 6,
  });
}

function resolveContinuationResumePromptMode(
  settings: AccountSettings | null | undefined,
): SessionContinuationResumePromptModeV1 {
  return settings?.usageLimitRecoverySettingsV1?.resumePromptMode === 'off' ? 'off' : 'standard';
}

function createSessionContinuationRecoveryMetadataStore(params: Readonly<{
  credentials: Credentials;
}>) {
  return {
    read: async (sessionId: string) => {
      const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId,
      }).catch(() => null);
      if (!rawSession) return null;
      return tryDecryptSessionMetadata({
        credentials: params.credentials,
        rawSession,
      });
    },
    write: async (sessionId: string, state: unknown) => {
      const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId,
      });
      if (!rawSession) {
        throw new Error('Session not found while persisting continuation recovery state');
      }
      await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId,
        rawSession,
        updater: (metadata) => ({
          ...metadata,
          [SESSION_CONTINUATION_RECOVERY_METADATA_KEY]: state,
        }),
        maxAttempts: 6,
      });
    },
  };
}

function createConnectedServiceContinuationHandler(params: Readonly<{
  credentials: Credentials;
  failureAtMs: number;
  resumePromptMode: SessionContinuationResumePromptModeV1;
}>) {
  const controller = createSessionContinuationRecoveryController({
    nowMs: () => Date.now(),
    store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
  });
  return async (input: Readonly<{
    sessionId: string;
    attemptId: string;
    action: 'hot_applied' | 'restart_requested';
  }>) => {
    await controller.beginAttempt({
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      failureAtMs: params.failureAtMs,
      resumePromptMode: params.resumePromptMode,
    });
    if (input.action === 'restart_requested') return;
    await controller.resolveAttempt({
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      failureAtMs: params.failureAtMs,
      resumePromptMode: params.resumePromptMode,
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: async () =>
        await hasCommittedUserMessageAfterMs({
          token: params.credentials.token,
          sessionId: input.sessionId,
          failureAtMs: params.failureAtMs,
        }),
      sendContinuationPrompt: async ({ prompt }) => {
        const sent = await sendSessionMessage({
          credentials: params.credentials,
          idOrPrefix: input.sessionId,
          message: prompt,
          wait: false,
          timeoutMs: 1,
        });
        if (!sent.ok) {
          throw new Error(`continuation_prompt_send_failed:${sent.code}`);
        }
      },
    });
  };
}

function createConnectedServicePendingContinuationResolver(params: Readonly<{
  credentials: Credentials;
}>) {
  const controller = createSessionContinuationRecoveryController({
    nowMs: () => Date.now(),
    store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
  });
  return async (input: Readonly<{
    sessionId: string;
    exactProviderContextAvailable: boolean;
  }>) => {
    await controller.resolvePendingAttempts({
      sessionId: input.sessionId,
      exactProviderContextAvailable: input.exactProviderContextAvailable,
      hasUserMessageAfterFailure: async ({ failureAtMs }) =>
        await hasCommittedUserMessageAfterMs({
          token: params.credentials.token,
          sessionId: input.sessionId,
          failureAtMs,
        }),
      sendContinuationPrompt: async ({ prompt }) => {
        const sent = await sendSessionMessage({
          credentials: params.credentials,
          idOrPrefix: input.sessionId,
          message: prompt,
          wait: false,
          timeoutMs: 1,
        });
        if (!sent.ok) {
          throw new Error(`continuation_prompt_send_failed:${sent.code}`);
        }
      },
    });
  };
}

async function resolveSessionConnectedServiceSwitchContinuity(input: Readonly<{
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previousBinding: Readonly<{
    source: 'native' | 'connected';
    selection: 'native' | 'profile' | 'group';
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
  }> | null;
  nextBinding: Readonly<{
    source: 'native' | 'connected';
    selection: 'native' | 'profile' | 'group';
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
  }>;
  fromBindingsRaw: unknown;
  toBindings: ReturnType<typeof readConnectedServiceBindingsOrEmpty>;
  accountSettings: AccountSettings | null;
  runtimeAuthSelection?: unknown;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>) {
  const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
    previousBinding: input.previousBinding,
    nextBinding: input.nextBinding,
    fromBindings: readConnectedServiceBindingsOrEmpty(input.fromBindingsRaw),
    toBindings: input.toBindings,
    ...(input.connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
      : {}),
    ...(input.vendorResumeId ? { vendorResumeId: input.vendorResumeId } : {}),
    ...(input.targetMaterializedRoot ? { targetMaterializedRoot: input.targetMaterializedRoot } : {}),
    ...(input.targetMaterializedEnv ? { targetMaterializedEnv: input.targetMaterializedEnv } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.candidatePersistedSessionFile
      ? { candidatePersistedSessionFile: input.candidatePersistedSessionFile }
      : {}),
    ...(input.runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection: input.runtimeAuthSelection }),
  });
  if (continuity.mode === 'hot_apply') {
    return { mode: 'hot_apply' as const };
  }
  if (continuity.mode === 'restart_same_home') {
    return { mode: 'restart_rematerialize' as const };
  }
  if (continuity.mode === 'restart_shared_state_required') {
    return resolveSharedStateRequiredSwitchContinuity({
      agentId: input.agentId,
      accountSettings: input.accountSettings,
      warnings: continuity.reason ? [continuity.reason] : [],
      serviceId: input.serviceId,
      targetMaterializedRoot: input.targetMaterializedRoot ?? null,
      targetMaterializedEnv: input.targetMaterializedEnv ?? null,
      materializationIdentity: input.connectedServiceMaterializationIdentityV1 ?? null,
      vendorResumeId: input.vendorResumeId ?? null,
      cwd: input.cwd ?? null,
      candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
    });
  }
  return {
    mode: 'unsupported' as const,
    errorCode: continuity.reason === 'provider_session_state_unavailable_for_resume'
      ? 'provider_session_state_unavailable_for_resume' as const
      : 'unsupported_service' as const,
    warnings: continuity.reason ? [continuity.reason] : [],
  };
}

function resolveCliSubcommandFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | 'acp-catalog' {
  if (target?.kind === 'configuredAcpBackend') {
    return 'acp-catalog';
  }
  return resolveAgentCliSubcommand(readBuiltInCatalogAgentIdFromBackendTarget(target));
}

async function applyAlreadyRunningExistingSessionRuntimeSnapshot(params: Readonly<{
  sessionId: string;
  incomingOptions: SpawnSessionOptions;
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials: Credentials;
}>): Promise<void> {
  const trackedSessions = Array.from(params.pidToTrackedSession.values())
    .filter((tracked) => tracked.happySessionId === params.sessionId);

  if (trackedSessions.length < 1) return;

  const storedCredentials = await readCredentials().catch(() => null);
  const effectiveCredentials = storedCredentials ?? params.credentials;
  const tokenForFetch = effectiveCredentials?.token ?? '';

  const attachContext = await resolveExistingSessionAttachContext({
    token: tokenForFetch,
    sessionId: params.sessionId,
    agent: params.incomingOptions.backendTarget?.kind === 'builtInAgent'
      ? params.incomingOptions.backendTarget.agentId
      : 'customAcp',
    credentials: effectiveCredentials,
  });

  if (!attachContext.ok) {
    logger.debug('[DAEMON RUN] Failed to resolve runtime snapshot for already-running session resume', {
      sessionId: params.sessionId,
      reason: attachContext.reason,
    });
    return;
  }

  for (const trackedSession of trackedSessions) {
    const runtimeSnapshot = resolveSessionRuntimeSnapshot({
      incomingOptions: params.incomingOptions,
      persistedMetadata: attachContext.metadata,
      persistedVendorResumeId: attachContext.vendorResumeId,
      trackedSpawnOptions: trackedSession.spawnOptions ?? null,
      trackedVendorResumeId: trackedSession.vendorResumeId ?? null,
    });
    trackedSession.spawnOptions = runtimeSnapshot.spawnOptions;
    const vendorResumeId = runtimeSnapshot.snapshot.vendorResumeId?.value;
    if (vendorResumeId) {
      trackedSession.vendorResumeId = vendorResumeId;
    }
  }
}

async function nudgeAlreadyRunningExistingSessionPendingQueue(params: Readonly<{
  sessionId: string;
  daemonToken: string;
}>): Promise<boolean> {
  const token = params.daemonToken.trim();
  if (!token) return false;

  try {
    const materialized = await materializeNextPendingQueueV2MessageViaHttp({
      token,
      sessionId: params.sessionId,
    });
    return materialized.didMaterialize === true;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to nudge pending queue for already-running session resume', {
      sessionId: params.sessionId,
      error: serializeAxiosErrorForLog(error),
    });
    return false;
  }
}

function readAttachPendingQueueNudgeRetryAttempts(): number {
  return resolvePositiveIntEnv(
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS,
    8,
    { min: 1, max: 120 },
  );
}

function readAttachPendingQueueNudgeRetryDelayMs(): number {
  return resolvePositiveIntEnv(
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS,
    500,
    { min: 0, max: 60_000 },
  );
}

async function sleepMs(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sleepMsOrShutdown(delayMs: number, shutdownPromise: Promise<unknown>): Promise<'elapsed' | 'shutdown'> {
  if (delayMs <= 0) return 'elapsed';
  return await new Promise<'elapsed' | 'shutdown'>((resolveSleep) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolveSleep('elapsed');
    }, delayMs);
    timeout.unref?.();

    void shutdownPromise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveSleep('shutdown');
    });
  });
}

function nudgeAttachedExistingSessionPendingQueue(params: Readonly<{
  requestedExistingSessionId: string;
  resolved: SpawnSessionResult;
  daemonToken: string;
}>): SpawnSessionResult {
  const requestedSessionId = params.requestedExistingSessionId.trim();
  if (!requestedSessionId || params.resolved.type !== 'success') {
    return params.resolved;
  }

  const resolvedSessionId = typeof params.resolved.sessionId === 'string'
    ? params.resolved.sessionId.trim()
    : '';
  if (!resolvedSessionId) {
    return params.resolved;
  }

  if (resolvedSessionId !== requestedSessionId) {
    logger.debug('[DAEMON RUN] Skipping pending queue nudge for attach spawn because resolved session id does not match requested existing session id', {
      requestedSessionId,
      resolvedSessionId,
    });
    return params.resolved;
  }

  const maxAttempts = readAttachPendingQueueNudgeRetryAttempts();
  const retryDelayMs = readAttachPendingQueueNudgeRetryDelayMs();
  void (async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const didMaterialize = await nudgeAlreadyRunningExistingSessionPendingQueue({
        sessionId: resolvedSessionId,
        daemonToken: params.daemonToken,
      });
      if (didMaterialize) return;
      if (attempt >= maxAttempts) return;
      await sleepMs(retryDelayMs);
    }
  })().catch((error) => {
    logger.debug('[DAEMON RUN] Attach pending queue background nudge loop failed', {
      requestedSessionId,
      resolvedSessionId,
      error: serializeAxiosErrorForLog(error),
    });
  });
  return params.resolved;
}

function readAccountSettingsChangedHintVersion(update: unknown): number | null {
  if (!update || typeof update !== 'object') return null;
  const body = (update as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  if ((body as { t?: unknown }).t !== 'account-settings-changed') return null;
  return normalizeAccountSettingsVersionHint((body as { settingsVersion?: unknown }).settingsVersion);
}

async function refreshDaemonAccountSettingsForHint(params: Readonly<{
  credentials: Credentials;
  settingsVersion: number | null;
}>): Promise<boolean> {
  const requiresConservativeRefresh = params.settingsVersion === null;
  await refreshAccountSettingsForMinimumVersion({
    credentials: params.credentials,
    minSettingsVersion: params.settingsVersion,
    mode: 'blocking',
    ...(requiresConservativeRefresh ? { forceRefresh: true } : {}),
  });
  return true;
}

function toConnectedServiceAuthSwitchDiagnosticError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const serialized = serializeAxiosErrorForLog(error);
  if (typeof serialized === 'string') return serialized;
  try {
    return JSON.stringify(serialized);
  } catch {
    return String(error);
  }
}

function attachConnectedServiceAuthSwitchDiagnostics(
  result: SessionConnectedServiceAuthSwitchResult,
  diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined,
): SessionConnectedServiceAuthSwitchResult {
  if (!diagnostics || Object.keys(diagnostics).length === 0) return result;
  return {
    ...result,
    diagnostics: {
      ...(!result.ok ? result.diagnostics : {}),
      ...diagnostics,
    },
  } as SessionConnectedServiceAuthSwitchResult;
}

function mapExistingSessionAttachFailureToSpawnError(reason: import('./sessionEncryption/resolveExistingSessionAttachContext').ExistingSessionAttachContextFailureReason): SpawnSessionResult {
  switch (reason) {
    case 'missingSessionId':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session id is required for resume attach.',
      };
    case 'missingToken':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Missing auth token to fetch existing session for resume.',
      };
    case 'notAuthenticated':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'not_authenticated',
      };
    case 'sessionNotFound':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session not found or access denied for resume.',
      };
    case 'fetchFailed':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to fetch existing session for resume.',
      };
    case 'missingCredentials':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Missing credentials to open the session encryption key for resume.',
      };
    case 'invalidEncryptionKey':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Failed to open session encryption key for resume.',
      };
  }
}

export async function startDaemon(options: Readonly<{ takeover?: boolean }> = {}): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const { requestShutdown, resolvesWhenShutdownRequested } = createDaemonShutdownController();

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());
  const diagnosticSubsystemGates = resolveDaemonDiagnosticSubsystemGates(process.env);

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  const inheritedRuntimeId = String(process.env.HAPPIER_DAEMON_RUNTIME_ID ?? '').trim();
  const runtimeId = inheritedRuntimeId || randomUUID();
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);

  try {
    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });
    if (takeoverDecision.kind === 'conflict') {
      const error = new DaemonOwnershipConflictError({
        intent: 'daemon-start',
        owner: takeoverDecision.owner,
      });
      logger.warn('[DAEMON RUN] Daemon ownership conflict prevented daemon startup', {
        title: error.title,
        lines: error.lines,
      });
      throw error;
    }

    const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
      startupSource,
      runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
    });
    if (startupServiceConflict.kind === 'installed-background-service-conflict') {
      const error = new DaemonStartupConflictError({
        action: 'daemon-start-sync',
        services: startupServiceConflict.services,
      });
      logger.warn('[DAEMON RUN] Installed background service prevented manual daemon startup', {
        title: error.title,
        lines: error.lines,
      });
      throw error;
    }

    if (takeoverDecision.kind === 'manual-owner-takeover' || takeoverDecision.kind === 'manual-owner-replace') {
      const takeoverNotice = buildDaemonTakeoverNotice({ action: 'start-sync' });
      logger.warn(
        takeoverDecision.kind === 'manual-owner-takeover'
          ? '[DAEMON RUN] Daemon takeover requested; replacing the current manual daemon runtime'
          : '[DAEMON RUN] Replacing the current stale manual daemon runtime before startup',
        {
          runtimeId,
          ownerCliVersion: takeoverDecision.owner.state.startedWithCliVersion,
          ownerReleaseChannel: takeoverDecision.owner.state.startedWithPublicReleaseChannel,
          title: takeoverNotice.title,
          lines: takeoverNotice.lines,
        },
      );
      await stopDaemon();
    }

    const credentialsGate = await waitForInitialCredentials({
      isInteractive,
      waitForAuthEnabled,
      waitForAuthTimeoutMs,
      credentialsPath: configuration.privateKeyFile,
      refresh: () => reloadConfiguration(),
      readCredentials,
      acquireDaemonLock: () => acquireDaemonLock(5, 200),
      releaseDaemonLock,
      resolvesWhenShutdownRequested,
      logger,
      daemonLockHandle,
    });
    if (credentialsGate.action === 'exit') {
      process.exit(credentialsGate.exitCode);
    }
    if (credentialsGate.action === 'shutdown') {
      return;
    }
    daemonLockHandle = credentialsGate.daemonLockHandle;

    // Ensure auth and machine registration BEFORE we take the daemon lock.
    // This prevents stuck lock files when auth is interrupted or cannot proceed.
    const auth = await authAndSetupMachineIfNeeded();
    const credentials = auth.credentials;
    let machineId = auth.machineId;
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    const api = await ApiClient.create(credentials);
    const preferredHost = await getPreferredHostName();
    const metadataForRegistration: MachineMetadata = { ...initialMachineMetadata, host: preferredHost };
    let preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null = null;

    const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion({
      expectedMachineId: machineId,
    });
    if (!runningDaemonVersionMatches) {
      logger.debug('[DAEMON RUN] Daemon version or machine identity mismatch detected, restarting daemon with current CLI version');
      await stopDaemon();
    } else {
      preflightMachineRegistration = await ensureMachineRegistered({
        api,
        machineId,
        metadata: metadataForRegistration,
        caller: 'startDaemon preflight',
      });
      machineId = preflightMachineRegistration.machineId;
      if (preflightMachineRegistration.didRotateMachineId) {
        logger.debug('[DAEMON RUN] Same-version daemon matched a stale machine id, restarting daemon with recovered machine identity');
        await stopDaemon();
      } else {
        logger.debug('[DAEMON RUN] Daemon version and machine identity match, keeping existing daemon');
        console.log('Daemon already running with matching version');
        process.exit(0);
      }
    }

    // Acquire exclusive lock (proves daemon is running)
    if (!daemonLockHandle) {
      daemonLockHandle = await acquireDaemonLock(5, 200);
    }
    if (!daemonLockHandle) {
      logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
      process.exit(0);
    }

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

        // Setup state - key by PID
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const spawnResourceCleanupByPid = new Map<number, () => void>();
        const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
      const connectedServicesMaterializationBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
      let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
      let connectedServiceRefreshLoopHandle: Readonly<{
        stop: () => void;
        pause: () => void;
        resume: () => void;
      }> | null = null;
      let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
      const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
      const connectedServiceAuthGroupSwitchLeases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
      const connectedServiceRuntimeAuthSwitchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
        nowMs: () => Date.now(),
        windowMs: resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_SWITCH_ATTEMPT_WINDOW_MS,
          10 * 60_000,
          { min: 1_000, max: 24 * 60 * 60_000 },
        ),
      });
      const connectedServiceSessionAuthSwitchCore = createConnectedServiceSessionAuthSwitchCore();
      const inactiveUsageLimitRecoveryCheckRunners = new Map<string, () => Promise<unknown>>();
      const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
        logConnectedServiceDaemonRestartDiagnostic(record);
      };
      const inactiveUsageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
        nowMs: () => Date.now(),
        recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
        recover: async (_intent, { sessionId }) => {
          const runCheckNow = inactiveUsageLimitRecoveryCheckRunners.get(sessionId);
          if (!runCheckNow) {
            return {
              status: 'exhausted',
              lastProbeError: 'usage_limit_recovery_check_runner_unavailable',
            };
          }
          const result = await runCheckNow();
          const resultStatus = readUsageLimitRecoveryResultStatus(result);
          const recovery = readUsageLimitRecoveryIntentFromControlResult(result);
          if (resultStatus === 'ready' || resultStatus === 'resumed') {
            return {
              status: 'ready',
              ...(recovery?.selectedAuth ? { selectedAuth: recovery.selectedAuth } : {}),
            };
          }
          if (recovery?.status === 'exhausted') {
            return {
              status: 'exhausted',
              lastProbeError: recovery.lastProbeError,
            };
          }
          if (
            recovery
            && (recovery.status === 'waiting' || recovery.status === 'armed' || recovery.status === 'checking')
            && typeof recovery.nextCheckAtMs === 'number'
          ) {
            return {
              status: 'wait',
              nextCheckAtMs: recovery.nextCheckAtMs,
              lastProbeError: recovery.lastProbeError,
            };
          }
          return {
            status: 'wait',
            nextCheckAtMs: Date.now() + 60_000,
            lastProbeError: 'usage_limit_recovery_probe_not_ready',
          };
        },
      });
      const connectedServiceGroupHomeCleanupScheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: configuration.activeServerDir,
        hasLiveTarget: ({ serviceId, groupId, agentId }) => getCurrentChildren().some((tracked) => {
          const trackedAgentId = resolveCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
          if (trackedAgentId !== agentId) return false;
          return parseConnectedServiceBindingSelections(tracked.spawnOptions?.connectedServices)
            .some((selection) => selection.kind === 'group' && selection.serviceId === serviceId && selection.groupId === groupId);
        }),
        groupExists: async ({ serviceId, groupId }) => (await api.getConnectedServiceAuthGroup({ serviceId, groupId })) !== null,
      });
      void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
        groupExists: async ({ serviceId, groupId }) => (await api.getConnectedServiceAuthGroup({ serviceId, groupId })) !== null,
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Connected-service group home startup reconciliation failed (non-fatal)', error);
      });
      let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
      let daemonServerWorkOnline = true;
      const daemonServerWorkScheduler: DaemonServerWorkScheduler = createDaemonServerWorkScheduler({
        budget: createDaemonServerWorkBudget({
          maxConcurrentWrites: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_SERVER_WORK_MAX_CONCURRENT_WRITES,
            1,
            { min: 1, max: 8 },
          ),
        }),
        gate: () => daemonServerWorkOnline
          ? { status: 'open' }
          : { status: 'deferred', reason: 'offline' },
        logger,
      });
      let apiMachineForSessions: ApiMachineClient | null = null;
      let automationWorker: AutomationWorkerHandle | null = null;
      let memoryWorker: MemoryWorkerHandle | null = null;
      let apiMachine: ApiMachineClient | null = null;
      let machineConnectionStateCleanup: (() => void) | null = null;
      let shutdownInitiated = false;
      let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;

        // Session spawning awaiter system
            const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
            const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
            const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
            const spawnConcurrencyGate = createSpawnConcurrencyGate(
              resolvePositiveIntEnv(process.env.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
            );

        const spawnRecentSuccessTtlMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
          2000,
          { min: 0, max: 60_000 },
        );
        const spawnRequestCoalescer = createSpawnRequestCoalescer({
          recentSuccessTtlMs: spawnRecentSuccessTtlMs,
        });

        const shutdownSpawnDrainGraceMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS,
          10_000,
          { min: 0, max: 120_000 },
        );
        const shutdownSpawnDrainPollMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_POLL_MS,
          100,
          { min: 10, max: 5_000 },
        );

        let beforeShutdownOnce: Promise<void> | null = null;
        const flushConnectedServiceQuotaPersistenceForShutdown = async (): Promise<void> => {
          const result = await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(2_000);
          if (!result?.timedOut) return;
          logger.warn('[DAEMON RUN] Connected-service quota persistence did not drain before shutdown', result);
        };
        const flushDaemonServerWorkForShutdown = async (): Promise<void> => {
          const result = await daemonServerWorkScheduler.flushAll(2_000);
          if (!result.timedOut) return;
          logger.warn('[DAEMON RUN] Daemon server work did not drain before shutdown', result);
        };
        const beforeShutdown = async (): Promise<void> => {
          if (beforeShutdownOnce) return await beforeShutdownOnce;
          beforeShutdownOnce = (async () => {
            await flushConnectedServiceQuotaPersistenceForShutdown();
            await flushDaemonServerWorkForShutdown();
            const initialInFlightSpawns = pidToAwaiter.size;
            const hasPendingRpcRequests = apiMachineForSessions !== null;
            if (initialInFlightSpawns === 0 && !hasPendingRpcRequests) return;

            logger.debug('[DAEMON RUN] Shutdown requested with in-flight work; deferring shutdown', {
              inFlightSpawns: initialInFlightSpawns,
              pendingRpcDrainEnabled: hasPendingRpcRequests,
              graceMs: shutdownSpawnDrainGraceMs,
              pollMs: shutdownSpawnDrainPollMs,
            });

            const start = Date.now();
            while (pidToAwaiter.size > 0 && Date.now() - start < shutdownSpawnDrainGraceMs) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve) => setTimeout(resolve, shutdownSpawnDrainPollMs));
            }

            const remaining = pidToAwaiter.size;
            if (remaining === 0) {
              logger.debug('[DAEMON RUN] In-flight spawn(s) drained; checking pending RPC requests');
            } else {
              const errorMessage = `Daemon shutting down while ${remaining} spawn(s) still awaiting session webhook.`;
              logger.warn('[DAEMON RUN] In-flight spawn(s) did not drain before shutdown; aborting spawn(s)', {
                inFlight: remaining,
                graceMs: shutdownSpawnDrainGraceMs,
              });

              for (const timeout of pidToSpawnWebhookTimeout.values()) {
                clearTimeout(timeout);
              }

              for (const resolveSpawnResult of pidToSpawnResultResolver.values()) {
                resolveSpawnResult({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                  errorMessage,
                });
              }

              pidToAwaiter.clear();
              pidToSpawnResultResolver.clear();
              pidToSpawnWebhookTimeout.clear();
            }

            if (!apiMachineForSessions) return;

            const elapsedMs = Date.now() - start;
            const remainingRpcGraceMs = Math.max(0, shutdownSpawnDrainGraceMs - elapsedMs);
            if (remainingRpcGraceMs === 0) {
              logger.warn('[DAEMON RUN] No shutdown grace budget left to drain pending RPC requests');
              return;
            }

            let rpcRequestsDrained = false;
            const timeoutHandle = setTimeout(() => {
              if (!rpcRequestsDrained) {
                logger.warn('[DAEMON RUN] Pending RPC requests did not drain before shutdown', {
                  graceMs: remainingRpcGraceMs,
                });
              }
            }, remainingRpcGraceMs);

            try {
              await Promise.race([
                apiMachineForSessions.awaitPendingRpcRequests().then(() => {
                  rpcRequestsDrained = true;
                }),
                new Promise<void>((resolve) => setTimeout(resolve, remainingRpcGraceMs)),
              ]);
            } finally {
              clearTimeout(timeoutHandle);
            }

            if (rpcRequestsDrained) {
              logger.debug('[DAEMON RUN] Pending RPC requests drained; proceeding with shutdown');
            }

            await flushConnectedServiceQuotaPersistenceForShutdown();
            await flushDaemonServerWorkForShutdown();
          })();
          return await beforeShutdownOnce;
        };

        const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> => {
          return await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: pidToTrackedSession.values(),
          });
        };

        // Helper functions
        const getCurrentChildren = () => Array.from(pidToTrackedSession.values());
        const temporaryThrottleRecoveryScheduler = new TemporaryThrottleRecoveryScheduler({
          nowMs: () => Date.now(),
          baseBackoffMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_BASE_BACKOFF_MS,
            1_000,
            { min: 100, max: 60_000 },
          ),
          maxBackoffMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_BACKOFF_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
          ),
          retry: async (_intent, { sessionId }) => {
            const tracked = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
            if (!tracked) {
              return {
                status: 'exhausted',
                lastError: 'temporary_throttle_session_not_found',
              };
            }
            return { status: 'ready' };
          },
          resume: (intent) => {
            logger.debug('[DAEMON RUN] Temporary throttle recovery probe ready', {
              issueFingerprint: intent.issueFingerprint,
            });
          },
        });
        const loadLocalSessionMetadataForHandoff = async (sessionId: string): Promise<SessionHandoffLocalMetadataSource | null> => {
            for (const trackedSession of pidToTrackedSession.values()) {
                if (trackedSession.happySessionId !== sessionId) {
                    continue;
            }
            return buildHandoffSessionMetadataFromTrackedSession({
              trackedSession,
              machineId,
              fallbackHomeDir: os.homedir(),
            });
          }
          return null;
        };

        logger.debug('[DAEMON RUN] Running startup session reattach scan');
        const startupReattachResult = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession, credentials });
        const orphanedDeadDaemonSessions = startupReattachResult.orphanedDeadDaemonSessions;
        logger.debug('[DAEMON RUN] Startup session reattach scan finished', {
          trackedSessionCount: pidToTrackedSession.size,
          orphanedDeadDaemonSessionCount: orphanedDeadDaemonSessions.length,
        });
        if (process.platform === 'linux' && startupSource === 'background-service') {
          const migratedTrackedSessionProcesses = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
            trackedSessions: pidToTrackedSession.values(),
            daemonPid: process.pid,
          });
          if (migratedTrackedSessionProcesses.length > 0) {
            logger.debug('[DAEMON RUN] Moved reattached session runner process(es) out of the daemon service cgroup', {
              migrations: migratedTrackedSessionProcesses,
            });
          }
        }

        const resolvePendingConnectedServiceContinuation =
          createConnectedServicePendingContinuationResolver({ credentials });

        void replayPendingConnectedServiceContinuationsForTrackedSessions({
          trackedSessions: getCurrentChildren(),
          resolvePendingContinuation: resolvePendingConnectedServiceContinuation,
        }).catch((error) => {
          logger.debug('[DAEMON RUN] Failed to replay pending connected-service continuations after startup reattach', error);
        });

        // Handle webhook from happy session reporting itself
        const onHappySessionWebhook = createOnHappySessionWebhook({
          pidToTrackedSession,
          pidToAwaiter,
          onTrackedSessionReported: (tracked) => {
            const sessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
            if (!sessionId) return;
            void (async () => {
              const exactProviderContextAvailable =
                await resolveConnectedServiceContinuationProviderContextAvailability({ tracked });
              await resolvePendingConnectedServiceContinuation({
                sessionId,
                exactProviderContextAvailable,
              });
            })().catch((error) => {
              logger.debug('[DAEMON RUN] Failed to resolve connected-service continuation recovery after session report', error);
            });
          },
        });
        const resolveCanonicalTrackedSessionId = (pid: number): string => {
          const session = pidToTrackedSession.get(pid);
          const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
          if (!sessionId) return '';
          if (/^PID-\d+$/.test(sessionId)) return '';
          return sessionId;
        };

            // Spawn a new session (sessionId reserved for future Happy session resume; vendor resume uses options.resume).
                const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
          let normalizedOptions: SpawnSessionOptions = {
            ...options,
            directory: normalizeSpawnSessionDirectory(options.directory, process.env),
          };
          const key = computeDaemonSpawnRequestKey(normalizedOptions);
          return await spawnRequestCoalescer.run(key, async () => {
            if (typeof normalizedOptions.accountSettingsVersionHint === 'number') {
              try {
                await refreshDaemonAccountSettingsForHint({
                  credentials,
                  settingsVersion: normalizedOptions.accountSettingsVersionHint,
                });
              } catch (error) {
                logger.warn('[DAEMON RUN] Account settings freshness refresh failed before spawn; continuing with last available settings', serializeAxiosErrorForLog(error));
              }
            }
            const normalizedExistingSessionId = typeof normalizedOptions.existingSessionId === 'string' ? normalizedOptions.existingSessionId.trim() : '';
            if (normalizedExistingSessionId) {
              // Idempotency: a resume/attach request must never spawn a duplicate process.
              // This covers both:
              // - sessions we are tracking (including in-flight attaches), and
              // - runners started outside this daemon (lock file check).
              if (await isSessionRunnerActive(normalizedExistingSessionId)) {
                // If the daemon has *just* requested the runner to stop (e.g. aborting a handoff),
                // a best-effort "restart on source" can race and leave the session stopped. When
                // we detect an in-flight stop marker, wait briefly for the runner to exit before
                // applying the idempotent "already running" rule.
                if (configuration.daemonSpawnExistingSessionWaitForExitMs > 0) {
                  await waitForExistingSessionExitIfStopRequested({
                    sessionId: normalizedExistingSessionId,
                    pidToTrackedSession,
                    isSessionRunnerActive,
                    timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                    pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                  });
                }

                if (await isSessionRunnerActive(normalizedExistingSessionId)) {
                  logger.debug(`[DAEMON RUN] Resume requested for ${normalizedExistingSessionId}, but session is already running`);
                  await applyAlreadyRunningExistingSessionRuntimeSnapshot({
                    sessionId: normalizedExistingSessionId,
                    incomingOptions: normalizedOptions,
                    pidToTrackedSession,
                    credentials,
                  });
                  await nudgeAlreadyRunningExistingSessionPendingQueue({
                    sessionId: normalizedExistingSessionId,
                    daemonToken: credentials.token,
                  });
                  return { type: 'success', sessionId: normalizedExistingSessionId };
                }
              }
            }

            return await spawnConcurrencyGate.run(async () => {
              // Do NOT log raw options: it may include secrets (env vars).
              const envKeysPreview = normalizedOptions.environmentVariables && typeof normalizedOptions.environmentVariables === 'object'
                ? Object.keys(normalizedOptions.environmentVariables as Record<string, unknown>)
                : [];
              const resolvedDirectory = normalizedOptions.directory;
              const environmentVariablesValidation = validateEnvVarRecordStrict(normalizedOptions.environmentVariables);
              logger.debugLargeJson('[DAEMON RUN] Spawning session', {
                directory: resolvedDirectory,
                sessionId: normalizedOptions.sessionId,
                machineId: normalizedOptions.machineId,
                approvedNewDirectoryCreation: normalizedOptions.approvedNewDirectoryCreation,
                backendTarget: normalizedOptions.backendTarget,
                profileId: normalizedOptions.profileId,
                hasInitialPrompt: typeof normalizedOptions.initialPrompt === 'string' && normalizedOptions.initialPrompt.trim().length > 0,
                hasInitialTranscriptAfterSeq: typeof normalizedOptions.initialTranscriptAfterSeq === 'number',
                hasInitialGoal: normalizedOptions.initialGoal !== undefined,
                hasResume: typeof normalizedOptions.resume === 'string' && normalizedOptions.resume.trim().length > 0,
                windowsRemoteSessionLaunchMode: normalizedOptions.windowsRemoteSessionLaunchMode,
                windowsRemoteSessionConsole: normalizedOptions.windowsRemoteSessionConsole,
                windowsTerminalWindowName: normalizedOptions.windowsTerminalWindowName,
                environmentVariableCount: envKeysPreview.length,
                environmentVariableKeys: envKeysPreview,
                environmentVariablesValid: environmentVariablesValidation.ok,
                environmentVariablesError: environmentVariablesValidation.ok ? null : environmentVariablesValidation.error,
              });

              if (!environmentVariablesValidation.ok) {
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
                  errorMessage: environmentVariablesValidation.error,
                };
              }

                  let {
                    directory,
                    sessionId,
                    machineId,
                    approvedNewDirectoryCreation = true,
                    existingSessionAttachPayload,
                    resume,
                    existingSessionId,
                    permissionMode,
                    permissionModeUpdatedAt,
                    agentModeId,
                    agentModeUpdatedAt,
                    modelId,
                    modelUpdatedAt,
                    initialTranscriptAfterSeq,
                    initialGoal,
                    initialPrompt,
                    experimentalCodexAcp,
                    codexBackendMode,
                    agentRuntimeDescriptorV1,
                    backendTarget,
                  } = normalizedOptions;
              const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
              const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';
              const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
                codexBackendMode,
                experimentalCodexAcp,
                agentRuntimeDescriptorV1,
              });

              const normalizedInitialPrompt = normalizeDaemonInitialPrompt(initialPrompt);

              // NOTE: existing-session idempotency is handled before entering the spawn concurrency gate.
              let effectiveResume = normalizedResume;
              const catalogAgentId = resolveCatalogAgentIdFromBackendTarget(backendTarget);

              let sessionAttachPayload: import('@/agent/runtime/sessionAttachPayload').SessionAttachFilePayload | null = null;
              let existingSessionPersistedMetadata: Record<string, unknown> | null = null;
              if (normalizedExistingSessionId) {
                if (existingSessionAttachPayload) {
                  sessionAttachPayload = existingSessionAttachPayload;
                } else {
                  const storedCredentials = await readCredentials().catch(() => null);
                  const effectiveCredentials = storedCredentials ?? credentials;
                  const tokenForFetch = effectiveCredentials?.token ?? '';

                  const attachContext = await resolveExistingSessionAttachContext({
                    token: tokenForFetch,
                    sessionId: normalizedExistingSessionId,
                    agent: backendTarget?.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp',
                    credentials: effectiveCredentials,
                  });

                  if (!attachContext.ok) {
                    return mapExistingSessionAttachFailureToSpawnError(attachContext.reason);
                  }

                  sessionAttachPayload = attachContext.attachPayload;
                  existingSessionPersistedMetadata = attachContext.metadata;
                  if (!effectiveResume) {
                    const derivedResume = typeof attachContext.vendorResumeId === 'string' ? attachContext.vendorResumeId.trim() : '';
                    if (derivedResume) {
                      effectiveResume = derivedResume;
                    }
                  }
                }

                sessionAttachPayload = applyInitialTranscriptAfterSeqToAttachPayload(sessionAttachPayload, initialTranscriptAfterSeq);
              }

              if (normalizedExistingSessionId) {
                const runtimeSnapshot = resolveSessionRuntimeSnapshot({
                  incomingOptions: {
                    ...normalizedOptions,
                    ...(effectiveResume ? { resume: effectiveResume } : {}),
                  },
                  persistedMetadata: existingSessionPersistedMetadata,
                  persistedVendorResumeId: effectiveResume || null,
                });
                normalizedOptions = runtimeSnapshot.spawnOptions;
                resume = normalizedOptions.resume;
                permissionMode = normalizedOptions.permissionMode;
                permissionModeUpdatedAt = normalizedOptions.permissionModeUpdatedAt;
                agentModeId = normalizedOptions.agentModeId;
                agentModeUpdatedAt = normalizedOptions.agentModeUpdatedAt;
                modelId = normalizedOptions.modelId;
                modelUpdatedAt = normalizedOptions.modelUpdatedAt;
                effectiveResume = typeof resume === 'string' ? resume.trim() : '';
              }

              // Only gate vendor resume. Happy-session reconnect (existingSessionId) is supported for all agents.
              if (effectiveResume) {
                if (backendTarget?.kind === 'configuredAcpBackend') {
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for configured ACP backend '${backendTarget.backendId}'.`,
                  };
                }
                const vendorResumeSupport = await getVendorResumeSupport(
                  catalogAgentId,
                );
                const ok = vendorResumeSupport(
                  canonicalCodexBackendMode
                    ? { codexBackendMode: canonicalCodexBackendMode }
                    : { experimentalCodexAcp },
                );
                if (!ok) {
                  const supportLevel = requireCatalogEntry(catalogAgentId).vendorResumeSupport;
                  const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
                  };
                }
              }
              let directoryCreated = false;

              const catalogEntry = requireCatalogEntry(catalogAgentId);
              const daemonSpawnHooks = catalogEntry.getDaemonSpawnHooks
                ? await catalogEntry.getDaemonSpawnHooks()
                : null;

              let spawnResourceCleanupOnFailure: (() => void) | null = null;
              let spawnResourceCleanupOnExit: (() => void) | null = null;
              let spawnResourceCleanupArmed = false;
              let sessionAttachCleanup: (() => Promise<void>) | null = null;

              const ensuredDirectory = await ensureSessionDirectory({
                directory: resolvedDirectory,
                approvedNewDirectoryCreation,
              });
              if (!ensuredDirectory.ok) {
                logger.debug(`[DAEMON RUN] Directory setup failed for ${resolvedDirectory}`, ensuredDirectory.response);
                return ensuredDirectory.response;
              }
              directoryCreated = ensuredDirectory.directoryCreated;

              try {

                const cleanupSpawnResources = () => {
                  if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                    spawnResourceCleanupOnFailure();
                    spawnResourceCleanupOnFailure = null;
                    spawnResourceCleanupOnExit = null;
                  }
                };

                let connectedServiceAuth: {
                  env: Record<string, string>;
                  cleanupOnFailure: (() => void) | null;
                  cleanupOnExit: (() => void) | null;
                } | null = null;
                const fallbackMaterializationKey =
                  normalizedExistingSessionId ||
                  (typeof sessionId === 'string' ? sessionId.trim() : '') ||
                  `spawn-${Date.now()}-${randomBytes(8).toString('hex')}`;
                let materializationKey = fallbackMaterializationKey;
                const connectedServiceAuthSessionId =
                  normalizedExistingSessionId ||
                  (typeof sessionId === 'string' ? sessionId.trim() : '') ||
                  undefined;

                if (shouldResolveConnectedServiceAuthForSpawn(normalizedOptions)) {
                  let connectedServiceMaterializationIdentityV1 =
                    readConnectedServiceMaterializationIdentityV1(
                      normalizedOptions.connectedServiceMaterializationIdentityV1,
                    );
                  if (!connectedServiceMaterializationIdentityV1) {
                    if (normalizedExistingSessionId) {
                      const normalizedConnectedServiceBindings = readConnectedServiceBindingsOrEmpty(
                        normalizedOptions.connectedServices,
                      );
                      const canRepairMissingIdentity =
                        await canRepairMissingConnectedServiceMaterializationIdentityForSpawn({
                          agentId: catalogAgentId,
                          sessionId: normalizedExistingSessionId,
                          bindings: normalizedConnectedServiceBindings,
                          vendorResumeId: effectiveResume || null,
                        });
                      if (!canRepairMissingIdentity) {
                        return {
                          type: 'error',
                          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                          errorMessage: 'connected_service_materialization_identity_missing',
                        };
                      }
                      connectedServiceMaterializationIdentityV1 = createConnectedServiceMaterializationIdentity();
                      try {
                        await persistSessionConnectedServiceBindings({
                          credentials,
                          sessionId: normalizedExistingSessionId,
                          normalizedBindings: normalizedConnectedServiceBindings,
                          connectedServiceMaterializationIdentityV1,
                        });
                      } catch (error) {
                        logger.warn('[DAEMON RUN] Failed to repair missing connected-service materialization identity before existing-session spawn', error);
                        return {
                          type: 'error',
                          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                          errorMessage: 'connected_service_materialization_identity_missing',
                        };
                      }
                      logger.warn('[DAEMON RUN] Repaired missing connected-service materialization identity before existing-session spawn', {
                        sessionId: normalizedExistingSessionId,
                        agentId: catalogAgentId,
                      });
                    } else {
                      connectedServiceMaterializationIdentityV1 = createConnectedServiceMaterializationIdentity();
                    }
                  }
                  materializationKey = connectedServiceMaterializationIdentityV1.id;
	                  normalizedOptions = {
	                    ...normalizedOptions,
	                    connectedServiceMaterializationIdentityV1,
	                  };
	                  try {
	                    const connectedServiceAuthQuotaFreshnessMs = resolvePositiveIntEnv(
                      process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                      5 * 60_000,
                      { min: 1_000, max: 60 * 60_000 },
                    );
                    const preTurnSwitchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
                      api,
                      runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                      leases: connectedServiceAuthGroupSwitchLeases,
                      quotaFreshnessMs: connectedServiceAuthQuotaFreshnessMs,
                      nowMs: () => Date.now(),
                      restartSession: async () => {},
                      hydratePersistedQuotaSnapshotsForGroup: async (input) => {
                        await connectedServiceQuotasCoordinator?.hydratePersistedQuotaSnapshotsForGroup(input);
                      },
                      probeQuotaSnapshotsForGroup: async (input) => {
                        await connectedServiceQuotasCoordinator?.probeGroupQuotaSnapshots(input);
                      },
                      emitEvent: (event) => {
                        if (!event.success || event.resultStatus !== 'switched') return;
                        if (connectedServiceAuthSessionId) {
                          void commitConnectedServiceAccountSwitchSessionEvent({
                            credentials,
                            sessionId: connectedServiceAuthSessionId ?? materializationKey,
                            event,
                          }).catch((error) => {
                            logger.debug('[DAEMON RUN] Failed to commit pre-turn connected-service account switch session event (non-fatal)', error);
                          });
                        }
                        const trackedForNotification = connectedServiceAuthSessionId
                          ? getCurrentChildren().find((child) => child.happySessionId === connectedServiceAuthSessionId) ?? null
                          : null;
                        const settingsSnapshot = getActiveAccountSettingsSnapshot();
                        void dispatchConnectedServiceAccountSwitchNotificationAsync({
                          settings: settingsSnapshot?.settings ?? null,
                          settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                          expoPushSender: api.push(),
                          runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                          listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
                          source: {
                            sessionId: connectedServiceAuthSessionId ?? materializationKey,
                            sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                            serviceId: event.serviceId,
                            groupId: event.groupId,
                            fromProfileId: event.fromProfileId,
                            toProfileId: event.toProfileId,
                            reason: event.reason,
                            limitCategory: event.limitCategory ?? null,
                            retryAfterMs: event.retryAfterMs ?? null,
                            quotaScope: event.quotaScope ?? null,
                            providerLimitId: event.providerLimitId ?? null,
                            action: event.action ?? null,
                          },
                          nowMs: () => Date.now(),
                          dedupeWindowMs: resolvePositiveIntEnv(
                            process.env.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                            60_000,
                            { min: 0, max: 24 * 60 * 60_000 },
                          ),
                        }).catch((error) => {
                          logger.debug('[DAEMON RUN] Pre-turn connected-service account switch notification failed (non-fatal)', error);
                        });
                      },
                    });
                    const activeAccountSettings = getActiveAccountSettingsSnapshot();
                    // K1 §2: only continuity-gate the spawn when shared-state continuity was requested
                    // for this agent. The gate proves the post-materialization target the vendor reads;
                    // a fresh (no-resume) spawn or an isolated spawn is not gated.
                    const spawnSharedStateContinuityRequested = resolveConnectedServicesProviderStateSharingPolicyV1(
                      (activeAccountSettings?.settings as { connectedServicesProviderStateSharingSettingsV1?: unknown } | null)
                        ?.connectedServicesProviderStateSharingSettingsV1,
                      catalogAgentId,
                    ).stateMode === 'shared';
                    connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
                      agentId: catalogAgentId,
                      sessionDirectory: resolvedDirectory,
                      connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                      materializationKey,
                      connectedServiceMaterializationIdentityV1,
                      activeServerDir: configuration.activeServerDir,
                      baseDir: connectedServicesMaterializationBaseDir,
                      credentials,
                      api,
                      runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                      quotaFreshnessMs: connectedServiceAuthQuotaFreshnessMs,
                      nowMs: () => Date.now(),
                      sessionId: connectedServiceAuthSessionId,
                      authGroupSwitchCoordinator: preTurnSwitchCoordinator,
                      accountSettings: activeAccountSettings?.settings ?? null,
                      processEnv: process.env,
                      credentialRefreshService: connectedServiceRefreshCoordinator,
                      vendorResumeId: effectiveResume || null,
                      resumeReachabilityRequired: spawnSharedStateContinuityRequested,
                      candidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile(
                        catalogAgentId,
                        existingSessionPersistedMetadata,
                      ),
                    });
                  } catch (error) {
                    // K1 §2: the post-materialization re-verify proved the resumed session is
                    // unreachable in the REAL materialized target. Fail closed BEFORE the vendor
                    // launches with the concrete structured continuity reason, instead of respawning
                    // into a missing session file ("Pi process exited"). D2: we keep the verbatim
                    // SPAWN_VALIDATION_FAILED code + message (legacy consumers unchanged) AND attach a
                    // structured `errorDetail` so the client can programmatically recognize "resume
                    // unreachable" and offer "start fresh under the new account".
                    if (error instanceof ConnectedServiceSpawnResumeUnreachableError) {
                      logger.warn('[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn', {
                        agentId: error.agentId,
                        errorCode: error.errorCode,
                        failurePhase: error.failurePhase,
                        vendorResumeId: error.vendorResumeId,
                        cwd: error.cwd,
                        targetMaterializedRoot: error.targetMaterializedRoot,
                        reason: error.reason,
                      });
                      return buildSpawnResumeUnreachableErrorResult(error);
                    }
                    logger.debug('[DAEMON RUN] Connected services resolution failed', error);
                    return {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                      errorMessage:
                        error instanceof Error
                          ? `Connected services resolution failed: ${error.message}`
                          : 'Connected services resolution failed.',
                    };
                  }
                }

                const spawnEnvironment = await resolveSpawnChildEnvironment({
                  options: { ...normalizedOptions, directory: resolvedDirectory },
                  profileEnvironmentVariables: environmentVariablesValidation.env,
                  daemonSpawnHooks,
                  processEnv: process.env,
                  logDebug: (message) => logger.debug(message),
                  logInfo: (message) => logger.info(message),
                  logWarn: (message) => logger.warn(message),
                  connectedServiceAuth,
                });
                spawnResourceCleanupOnFailure = spawnEnvironment.cleanupOnFailure;
                spawnResourceCleanupOnExit = spawnEnvironment.cleanupOnExit;
                if (!spawnEnvironment.ok) {
                  cleanupSpawnResources();
                  return {
                    type: 'error',
                    errorCode: spawnEnvironment.errorCode,
                    errorMessage: spawnEnvironment.errorMessage,
                  };
                }
                const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
                const extraEnvForChild = spawnEnvironment.extraEnvForChild;
                const materializationDiagnostics = spawnEnvironment.materializationDiagnostics;
                const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
                  expandedEnvironmentVariables: extraEnv,
                  extraEnvForChild,
                });
                const {
                  existingSessionAttachPayload: _existingSessionAttachPayload,
                  initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
                  ...trackedSpawnOptionsBase
                } = normalizedOptions;
                const trackedSpawnOptions: SpawnSessionOptions = {
                  ...trackedSpawnOptionsBase,
                  ...(trackedSessionEnvironmentVariables
                    ? { environmentVariables: trackedSessionEnvironmentVariables }
                    : {}),
                  ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
                };

            const downgradeLegacyImplicitTmuxRequest = shouldDowngradeLegacyImplicitTmuxRequest({
              terminal: normalizedOptions.terminal,
              backendTarget,
            });
            const terminalRequest = resolveTerminalRequestFromSpawnOptions({
              happyHomeDir: configuration.happyHomeDir,
              terminal: downgradeLegacyImplicitTmuxRequest ? undefined : normalizedOptions.terminal,
              environmentVariables: extraEnv,
            });
            let sessionAttachFilePath: string | null = null;
            if (normalizedExistingSessionId) {
              if (!sessionAttachPayload) {
                throw new Error('Missing session attach payload for existing session');
              }
              const attach = await createSessionAttachFile({
                happySessionId: normalizedExistingSessionId,
                payload: sessionAttachPayload,
              });
              sessionAttachFilePath = attach.filePath;
              sessionAttachCleanup = attach.cleanup;
            }

            const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(process.env);
            const daemonServerSelectionEnv = {
              activeServerId: configuration.activeServerId,
              canonicalServerUrl: configuration.serverUrl,
              apiServerUrl: configuration.apiServerUrl,
              webappUrl: configuration.webappUrl,
            };
            const daemonRuntimeContextEnv = resolveHappierRuntimeContextEnv({
              homeDir: configuration.happyHomeDir,
              server: daemonServerSelectionEnv,
            });
            const extraEnvForChildWithMessage = {
              ...extraEnvForChild,
              ...daemonRuntimeContextEnv,
              ...(sessionAttachFilePath
                ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
                : {}),
              ...(normalizedInitialPrompt
                ? { [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: normalizedInitialPrompt }
                : {}),
              ...(initialGoal
                ? { [HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]: serializeDaemonInitialGoalForEnv(initialGoal) }
                : {}),
              ...stackProcessKindOverride,
            };

            const tmuxRequested = terminalRequest.requested === 'tmux';
            const tmuxAvailable = tmuxRequested ? await isTmuxAvailable() : false;
            let useTmux = tmuxAvailable && tmuxRequested;

            const tmuxSessionName = tmuxRequested ? terminalRequest.tmux.sessionName : undefined;
            const tmuxTmpDir = tmuxRequested ? terminalRequest.tmux.tmpDir : null;
            const tmuxCommandEnv: Record<string, string> = {};
            if (tmuxTmpDir) {
              tmuxCommandEnv.TMUX_TMPDIR = tmuxTmpDir;
            }

            let tmuxFallbackReason: string | null = null;

            if (!tmuxAvailable && tmuxRequested) {
              tmuxFallbackReason = 'tmux is not available on this machine';
              logger.debug('[DAEMON RUN] tmux requested but tmux is not available; falling back to regular spawning');
            }

            if (useTmux && tmuxSessionName !== undefined) {
              // Resolve empty-string session name (legacy "current/most recent") deterministically.
              let resolvedTmuxSessionName = tmuxSessionName;
              if (tmuxSessionName === '') {
                try {
                  const tmuxForDiscovery = new TmuxUtilities(undefined, tmuxCommandEnv);
                  const listResult = await tmuxForDiscovery.executeTmuxCommand([
                    'list-sessions',
                    '-F',
                    '#{session_name}\t#{session_attached}\t#{session_last_attached}',
                  ]);
                  resolvedTmuxSessionName =
                    selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
                } catch (error) {
                  logger.debug('[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"', error);
                  resolvedTmuxSessionName = TmuxUtilities.DEFAULT_SESSION_NAME;
                }
              }

              // Try to spawn in tmux session
              const sessionDesc = resolvedTmuxSessionName || 'current/most recent session';
              logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

              const agentSubcommand = resolveCliSubcommandFromBackendTarget(backendTarget);
              const windowName = `happy-${Date.now()}-${agentSubcommand}`;
              const tmuxTarget = `${resolvedTmuxSessionName}:${windowName}`;

              const terminalRuntimeArgs = [
                '--happy-terminal-mode',
                'tmux',
                '--happy-terminal-requested',
                'tmux',
                '--happy-tmux-target',
                tmuxTarget,
                ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
              ];

                  const { commandTokens, tmuxEnv } = buildTmuxSpawnConfig({
                    agent: agentSubcommand,
                    directory: resolvedDirectory,
                    extraEnv: extraEnvForChildWithMessage,
                    tmuxCommandEnv,
                    extraArgs: [
                      ...terminalRuntimeArgs,
                  ...buildHappySessionControlArgs({
                    resume: effectiveResume,
                    existingSessionId: normalizedExistingSessionId,
                    backendTarget,
                    permissionMode,
                    permissionModeUpdatedAt,
                    agentModeId,
                    agentModeUpdatedAt,
                    modelId,
                    modelUpdatedAt,
                  }),
                    ],
                  });
              const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

          // Spawn in tmux with environment variables
          // IMPORTANT: `spawnInTmux` uses `-e KEY=VALUE` flags for the window.
          // Use merged env so tmux mode matches regular process spawn behavior.
          // Note: this may add many `-e` flags; if it becomes a problem we can optimize
          // by diffing against `tmux show-environment` in a follow-up.
              if (tmuxTmpDir) {
                try {
                  await fs.mkdir(tmuxTmpDir, { recursive: true });
                } catch (error) {
                  logger.debug('[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start', error);
                }
              }

              const tmuxResult = await tmux.spawnInTmux(commandTokens, {
                sessionName: resolvedTmuxSessionName,
                windowName: windowName,
                cwd: resolvedDirectory
              }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }
            const tmuxPid = tmuxResult.pid;

            // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
            const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

                // Create a tracked session for tmux windows - now we have the real PID!
                const trackedSession: TrackedSession = {
                  startedBy: 'daemon',
                  happySessionId: normalizedExistingSessionId || undefined,
                  pid: tmuxPid, // Real PID from tmux -P flag
                  spawnOptions: trackedSpawnOptions,
                  tmuxSessionId: tmuxResult.sessionId,
                  tmuxTmpDir: typeof tmuxTmpDir === 'string' && tmuxTmpDir.trim().length > 0 ? tmuxTmpDir.trim() : undefined,
                  vendorResumeId: effectiveResume || undefined,
                  directoryCreated,
                  message: directoryCreated
                    ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
                    : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
                };

                // Add to tracking map so webhook can find it later
                pidToTrackedSession.set(tmuxPid, trackedSession);
              if (connectedServiceAuth && normalizedOptions.connectedServices) {
                connectedServiceRefreshCoordinator?.registerSpawnTarget({
                  pid: tmuxPid,
                  agentId: catalogAgentId,
                  sessionId: connectedServiceAuthSessionId,
                  connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                  connectedServiceSelectionsEnv: connectedServiceAuth.env,
                  materializationKey,
                });
                connectedServiceQuotasCoordinator?.registerSpawnTarget({
                  pid: tmuxPid,
                  sessionId: connectedServiceAuthSessionId,
                  connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                  connectedServiceSelectionsEnv: connectedServiceAuth.env,
                });
              }
                if (spawnResourceCleanupOnExit) {
                  spawnResourceCleanupByPid.set(tmuxPid, spawnResourceCleanupOnExit);
                  spawnResourceCleanupArmed = true;
                }
                if (sessionAttachCleanup) {
                  sessionAttachCleanupByPid.set(tmuxPid, sessionAttachCleanup);
                  sessionAttachCleanup = null;
                }

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxPid} (tmux)`);
            return waitForSessionWebhook({
              pid: tmuxPid,
              pidToAwaiter,
              pidToSpawnResultResolver,
              pidToSpawnWebhookTimeout,
              timeoutErrorMessage: `Session webhook timeout for PID ${tmuxPid} (tmux)`,
              resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(tmuxPid),
              onTimeout: () => {
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxPid} (tmux)`);
              },
              onSuccess: (completedSession) => {
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
              },
            }).then(async (result) =>
              await nudgeAttachedExistingSessionPendingQueue({
                requestedExistingSessionId: normalizedExistingSessionId,
                daemonToken: credentials.token,
                resolved: resolveSpawnWebhookResult({
                pid: tmuxPid,
                result,
                pidToTrackedSession,
                warn: (message) => logger.warn(message),
              }),
              }),
            );
              } else {
                tmuxFallbackReason = tmuxResult.error ?? 'tmux spawn failed';
                logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
                useTmux = false;
              }
            }

            // Regular process spawning (fallback or if tmux not available)
            if (!useTmux) {
              logger.debug(`[DAEMON RUN] Using regular process spawning`);

          const agentCommand = resolveCliSubcommandFromBackendTarget(backendTarget);
              const args = [
                agentCommand,
                '--happy-starting-mode', 'remote',
                '--started-by', 'daemon'
              ];

              if (tmuxRequested) {
                const reason = tmuxFallbackReason ?? 'tmux was not used';
                args.push(
                  '--happy-terminal-mode',
                  'plain',
              '--happy-terminal-requested',
              'tmux',
                  '--happy-terminal-fallback-reason',
                  reason,
                );
              }

              args.push(...buildHappySessionControlArgs({
                resume: effectiveResume,
                existingSessionId: normalizedExistingSessionId,
                backendTarget,
                permissionMode,
                permissionModeUpdatedAt,
                agentModeId,
                agentModeUpdatedAt,
                modelId,
                modelUpdatedAt,
              }));
              const windowsLaunchMode = resolveWindowsRemoteSessionConsoleMode({
                platform: process.platform,
                requested: normalizedOptions.windowsRemoteSessionLaunchMode ?? normalizedOptions.windowsRemoteSessionConsole,
                env: process.env,
              });

              const waitForWindowsHostedSession = async (params: {
                pid: number;
                logLabel: string;
                terminal: NonNullable<Metadata['terminal']>;
              }): Promise<SpawnSessionResult> => {
                if (sessionAttachCleanup) {
                  sessionAttachCleanupByPid.set(params.pid, sessionAttachCleanup);
                  sessionAttachCleanup = null;
                }

                const trackedSession: TrackedSession = {
                  startedBy: 'daemon',
                  happySessionId: normalizedExistingSessionId || undefined,
                  pid: params.pid,
                  spawnOptions: trackedSpawnOptions,
                  vendorResumeId: effectiveResume || undefined,
                  directoryCreated,
                  message: directoryCreated ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
                };
                pidToTrackedSession.set(params.pid, trackedSession);
                if (connectedServiceAuth && normalizedOptions.connectedServices) {
                  connectedServiceRefreshCoordinator?.registerSpawnTarget({
                    pid: params.pid,
                    agentId: catalogAgentId,
                    sessionId: connectedServiceAuthSessionId,
                    connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                    connectedServiceSelectionsEnv: connectedServiceAuth.env,
                    materializationKey,
                  });
                  connectedServiceQuotasCoordinator?.registerSpawnTarget({
                    pid: params.pid,
                    sessionId: connectedServiceAuthSessionId,
                    connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                    connectedServiceSelectionsEnv: connectedServiceAuth.env,
                  });
                }

                if (spawnResourceCleanupOnExit) {
                  spawnResourceCleanupByPid.set(params.pid, spawnResourceCleanupOnExit);
                  spawnResourceCleanupArmed = true;
                }

                const pollMsRaw = typeof process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS === 'string'
                  ? process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS.trim()
                  : '';
                const pollMsParsed = pollMsRaw ? Number(pollMsRaw) : NaN;
                const pollMs = Number.isFinite(pollMsParsed) && pollMsParsed > 0 ? pollMsParsed : 5000;

                logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${params.pid} (${params.logLabel})`);

                return await waitForVisibleConsoleSessionWebhook({
                  pid: params.pid,
                  pollMs,
                  pidToAwaiter,
                  pidToSpawnResultResolver,
                  pidToSpawnWebhookTimeout,
                  onChildExited,
                  resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(params.pid),
                }).then(async (result) => {
                  const resolved = resolveSpawnWebhookResult({
                    pid: params.pid,
                    result,
                    pidToTrackedSession,
                    warn: (message) => logger.warn(message),
                  });
                  if (resolved.type === 'success') {
                    logger.debug(
                      `[DAEMON RUN] Session ${resolved.sessionId} fully spawned with webhook (${params.logLabel})`,
                    );
                    const resolvedSessionId =
                      typeof resolved.sessionId === 'string' ? resolved.sessionId.trim() : '';
                    if (resolvedSessionId) {
                      try {
                        await writeTerminalAttachmentInfo({
                          happyHomeDir: configuration.happyHomeDir,
                          sessionId: resolvedSessionId,
                          terminal: params.terminal,
                        });
                      } catch (error) {
                        logger.debug('[DAEMON RUN] Failed to persist Windows terminal attachment info', error);
                      }
                    }
                  } else if (
                    resolved.type === 'error' &&
                    resolved.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                  ) {
                    logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${params.pid} (${params.logLabel})`);
                  }
                  return resolved;
                });
              };

              const buildWindowsHostedLaunchEnv = (launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>) =>
                buildSpawnChildProcessEnv({
                  processEnv: process.env,
                  extraEnv: {
                    ...extraEnvForChildWithMessage,
                    ...(launchSpec.env ?? {}),
                  },
                  happyHomeDir: configuration.happyHomeDir,
                  serverSelectionEnv: daemonServerSelectionEnv,
                });

              if (windowsLaunchMode === 'windows_terminal' || windowsLaunchMode === 'console') {
                const windowsTerminalIdentity = buildWindowsTerminalWindowIdentity({
                  existingSessionId: normalizedExistingSessionId,
                  reservedSessionId: typeof sessionId === 'string' ? sessionId : undefined,
                  agentCommand,
                  windowName: resolveWindowsTerminalWindowName({
                    requested: normalizedOptions.windowsTerminalWindowName,
                    env: process.env,
                  }),
                });

                const tryConsoleLaunch = async (params: {
                  requested: 'windows_terminal' | 'console';
                  fallbackReason?: string;
                }): Promise<SpawnSessionResult> => {
                  const consoleArgs = buildWindowsHostedTerminalArgs({
                    baseArgs: args,
                    actualMode: 'windows_console',
                    requestedMode: params.requested,
                    fallbackReason: params.fallbackReason,
                  });
                  const launchSpec = buildHappyCliSubprocessLaunchSpec(consoleArgs, {
                    preferWindowsPackagedBinary: true,
                  });
                  const started = await startHappySessionInVisibleWindowsConsole({
                    filePath: launchSpec.filePath,
                    args: launchSpec.args,
                    workingDirectory: resolvedDirectory,
                    env: buildWindowsHostedLaunchEnv(launchSpec),
                  });

                  if (!started.ok) {
                    logger.debug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: started.errorMessage });
                    cleanupSpawnResources();
                    if (sessionAttachCleanup) {
                      await sessionAttachCleanup();
                      sessionAttachCleanup = null;
                    }
                    return {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                      errorMessage: started.errorMessage,
                    };
                  }

                  logger.debug(`[DAEMON RUN] Spawned visible-console session with PID ${started.pid}`);
                  return await waitForWindowsHostedSession({
                    pid: started.pid,
                    logLabel: params.requested === 'windows_terminal' ? 'windows console fallback' : 'visible console',
                    terminal: buildWindowsHostedTerminalAttachment({
                      actualMode: 'windows_console',
                      requestedMode: params.requested,
                      pid: started.pid,
                      fallbackReason: params.fallbackReason,
                    }),
                  });
                };

                if (windowsLaunchMode === 'windows_terminal') {
                  const windowsTerminalArgs = buildWindowsHostedTerminalArgs({
                    baseArgs: args,
                    actualMode: 'windows_terminal',
                    requestedMode: 'windows_terminal',
                    windowId: windowsTerminalIdentity.windowId,
                  });
                  const launchSpec = buildHappyCliSubprocessLaunchSpec(windowsTerminalArgs, {
                    preferWindowsPackagedBinary: true,
                  });
                  const started = await startHappySessionInWindowsTerminal({
                    filePath: launchSpec.filePath,
                    args: launchSpec.args,
                    workingDirectory: resolvedDirectory,
                    env: buildWindowsHostedLaunchEnv(launchSpec),
                    windowId: windowsTerminalIdentity.windowId,
                    title: windowsTerminalIdentity.title,
                  });

                  if (started.ok) {
                    logger.debug(`[DAEMON RUN] Spawned Windows Terminal session with PID ${started.pid}`);
                    return await waitForWindowsHostedSession({
                      pid: started.pid,
                      logLabel: 'windows terminal',
                      terminal: buildWindowsHostedTerminalAttachment({
                        actualMode: 'windows_terminal',
                        requestedMode: 'windows_terminal',
                        pid: started.pid,
                        windowId: windowsTerminalIdentity.windowId,
                        title: windowsTerminalIdentity.title,
                      }),
                    });
                  }

                  logger.debug('[DAEMON RUN] Failed to spawn Windows Terminal session; falling back to console', {
                    error: started.errorMessage,
                  });
                  return await tryConsoleLaunch({
                    requested: 'windows_terminal',
                    fallbackReason: started.errorMessage,
                  });
                }

                return await tryConsoleLaunch({ requested: 'console' });
              }

                  // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
              const childProcessEnv = buildSpawnChildProcessEnv({
                processEnv: process.env,
                extraEnv: extraEnvForChildWithMessage,
                happyHomeDir: configuration.happyHomeDir,
                serverSelectionEnv: daemonServerSelectionEnv,
              });
              const spawnOptions = {
                cwd: resolvedDirectory,
                // Daemon-managed session runners must survive daemon replacement and shutdown.
                // Keep them detached from the daemon lifecycle instead of piping them through it.
                detached: true,
                stdio: 'ignore' as const,
                windowsHide: true,
                env: childProcessEnv,
              };
              const cgroupSelfMigratingLaunchSpec =
                process.platform === 'linux' && startupSource === 'background-service'
                  ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
                    args,
                    daemonPid: process.pid,
                  })
                  : null;
              const happyProcess = cgroupSelfMigratingLaunchSpec
                ? spawnChildProcess(
                  cgroupSelfMigratingLaunchSpec.filePath,
                  cgroupSelfMigratingLaunchSpec.args,
                  {
                    ...spawnOptions,
                    env: {
                      ...childProcessEnv,
                      ...(cgroupSelfMigratingLaunchSpec.env ?? {}),
                    },
                  },
                )
                : spawnHappyCLI(args, spawnOptions, {
                  preferWindowsPackagedBinary: true,
                });

              if (!happyProcess.pid) {
                logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
                if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                  spawnResourceCleanupOnFailure();
                  spawnResourceCleanupOnFailure = null;
                  spawnResourceCleanupOnExit = null;
                }
                if (sessionAttachCleanup) {
                  await sessionAttachCleanup();
                  sessionAttachCleanup = null;
                }
                return {
                  type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
                  errorMessage: 'Failed to spawn Happier process - no PID returned'
                };
              }

              logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);
              happyProcess.unref();
              void applySpawnedChildOomScoreAdjustment({
                pid: happyProcess.pid,
                startupSource,
                logDebug: (message, context) => logger.debug(message, context),
              });
              if (sessionAttachCleanup) {
                sessionAttachCleanupByPid.set(happyProcess.pid, sessionAttachCleanup);
                sessionAttachCleanup = null;
              }

                  const trackedSession: TrackedSession = {
                    startedBy: 'daemon',
                    happySessionId: normalizedExistingSessionId || undefined,
                    pid: happyProcess.pid,
                    childProcess: happyProcess,
                    spawnOptions: trackedSpawnOptions,
                    vendorResumeId: effectiveResume || undefined,
                    directoryCreated,
                    message: directoryCreated ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session there.` : undefined
                  };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);
          if (connectedServiceAuth && normalizedOptions.connectedServices) {
            connectedServiceRefreshCoordinator?.registerSpawnTarget({
              pid: happyProcess.pid,
              agentId: catalogAgentId,
              sessionId: connectedServiceAuthSessionId,
              connectedServicesBindingsRaw: normalizedOptions.connectedServices,
              connectedServiceSelectionsEnv: connectedServiceAuth.env,
              materializationKey,
            });
            connectedServiceQuotasCoordinator?.registerSpawnTarget({
              pid: happyProcess.pid,
              sessionId: connectedServiceAuthSessionId,
              connectedServicesBindingsRaw: normalizedOptions.connectedServices,
              connectedServiceSelectionsEnv: connectedServiceAuth.env,
            });
          }
          if (spawnResourceCleanupOnExit) {
            spawnResourceCleanupByPid.set(happyProcess.pid, spawnResourceCleanupOnExit);
            spawnResourceCleanupArmed = true;
          }

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process exited before session webhook (pid=${happyProcess.pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-exited', code, signal });
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process error before session webhook (pid=${happyProcess.pid})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-error', code: null, signal: null });
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);
              return waitForSessionWebhook({
                pid: happyProcess.pid!,
                pidToAwaiter,
                pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout,
                timeoutErrorMessage: `Session webhook timeout for PID ${happyProcess.pid}`,
                resolveExistingSessionId: () => resolveCanonicalTrackedSessionId(happyProcess.pid!),
                onTimeout: () => {
                  logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
                },
                onSuccess: (completedSession) => {
                  logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            },
          }).then(async (result) =>
            await nudgeAttachedExistingSessionPendingQueue({
              requestedExistingSessionId: normalizedExistingSessionId,
              daemonToken: credentials.token,
              resolved: resolveSpawnWebhookResult({
              pid: happyProcess.pid!,
              result,
              pidToTrackedSession,
              warn: (message) => logger.warn(message),
            }),
            }),
          );
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: 'Unexpected error in session spawning'
        };
              } catch (error) {
                if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                  spawnResourceCleanupOnFailure();
                  spawnResourceCleanupOnFailure = null;
              spawnResourceCleanupOnExit = null;
            }
            if (sessionAttachCleanup) {
              await sessionAttachCleanup();
              sessionAttachCleanup = null;
            }
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.debug('[DAEMON RUN] Failed to spawn session:', error);
                    return {
                      type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                      errorMessage: `Failed to spawn session: ${errorMessage}`
                    };
                  }
              });
          });
                };

            const stopSessionCore = createStopSession({ pidToTrackedSession });
        const sessionRespawnEnabled = parseBooleanEnv(process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, false);
        const sessionRespawnMaxAttempts = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
          10,
          { min: 0, max: 100 },
        );
        const sessionRespawnBaseDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
          1_000,
          { min: 50, max: 5 * 60_000 },
        );
        const sessionRespawnMaxDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
          60_000,
          { min: 50, max: 30 * 60_000 },
        );
        const sessionRespawnJitterMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
          250,
          { min: 0, max: 10_000 },
        );

                const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> => {
              return await isSessionRunnerActive(sessionId);
                };
        const sessionRespawnMaxRestarts = sessionRespawnMaxAttempts === 0 ? null : sessionRespawnMaxAttempts;
            const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
          enabled: sessionRespawnEnabled,
          maxRestarts: sessionRespawnMaxRestarts,
          baseDelayMs: sessionRespawnBaseDelayMs,
          maxDelayMs: sessionRespawnMaxDelayMs,
          jitterMs: sessionRespawnJitterMs,
          isSessionAlreadyRunning,
          spawnSession,
          resolveRespawnOptions: (input) => resolveRespawnSessionRuntimeSnapshot({
            ...input,
            credentials,
            readCredentials,
          }),
          random: () => Math.random(),
          logDebug: (message, payload) => logger.debug(message, payload),
          logWarn: (message) => logger.warn(message),
        });

        const connectedServicesRestartRequestedPids = new Set<number>();
        const connectedServiceTurnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
          timeoutMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TURN_DEFERRAL_TIMEOUT_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
          ),
          disableDeferral: String(process.env.HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL ?? '').trim() === '1',
          emitSessionEvent: (sessionId, event) => {
            void commitConnectedServiceAccountSwitchSessionEvent({
              credentials,
              sessionId,
              event,
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Failed to commit connected-service switch deferral session event (non-fatal)', error);
            });
          },
        });

        const normalizeSwitchTarget = (input: Readonly<{
          serviceId?: string | null;
          profileId?: string | null;
          groupId?: string | null;
          generation?: number | null;
        }>): ConnectedServiceSwitchTarget => ({
          serviceId: typeof input.serviceId === 'string' ? input.serviceId : '',
          profileId: typeof input.profileId === 'string' ? input.profileId : '',
          groupId: typeof input.groupId === 'string' ? input.groupId : '',
          generation: typeof input.generation === 'number' && Number.isFinite(input.generation)
            ? Math.max(0, Math.trunc(input.generation))
            : 0,
        });

        const requestConnectedServiceRestartWithDeferral = async (input: Readonly<{
          sessionId: string;
          tracked: TrackedSession;
          source: 'manual' | 'automatic';
          policy: 'defer_until_turn_boundary' | 'defer_until_idle';
          target: ConnectedServiceSwitchTarget;
          restartSignalDelayMs: number;
          restartDiagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
          onSignalFailureLogMessage: string;
        }>): Promise<Readonly<{ signaled: boolean }>> => {
          // Tracks whether runSwitch actually executed (and thus reserved the pid + signalled). A
          // superseded/cancelled deferral resolves WITHOUT running runSwitch, so callers must not
          // treat a successful return as "signalled" — see the refresh handler's reservation logic.
          let signaled = false;
          try {
            await connectedServiceTurnDeferralQueue.requestSwitch({
              sessionId: input.sessionId,
              source: input.source,
              policy: input.policy,
              target: input.target,
              runSwitch: async () => {
                connectedServicesRestartRequestedPids.add(input.tracked.pid);
                // K5:gated_restart this raw SIGTERM IS the gated restart primitive's signal — it
                // only fires inside the turn-deferral queue's runSwitch (deferred to the turn
                // boundary), and the respawn re-verifies resume reachability (K1).
                await requestConnectedServiceSessionRestartSignal({
                  pid: input.tracked.pid,
                  processGroupPid: resolveConnectedServiceRestartProcessGroupPid(input.tracked),
                  delayMs: input.restartSignalDelayMs,
                  shouldSignal: () => pidToTrackedSession.get(input.tracked.pid) === input.tracked,
                  restartDiagnostic: input.restartDiagnostic,
                  recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
                  onSignalFailure: (error) => {
                    connectedServicesRestartRequestedPids.delete(input.tracked.pid);
                    logger.warn(input.onSignalFailureLogMessage, error);
                  },
                });
                // Reached only when the signal was emitted without throwing (a signal failure
                // re-throws out of here and leaves `signaled` false so the reservation is not
                // claimed by the caller).
                signaled = true;
              },
            });
          } catch (error) {
            if (error instanceof ConnectedServiceSwitchDeferralConflictError && error.code === 'switch_cancelled') {
              logger.debug('[DAEMON RUN] Connected-service deferred restart superseded by a newer switch request', {
                sessionId: input.sessionId,
                serviceId: input.target.serviceId,
                groupId: input.target.groupId,
                generation: input.target.generation,
                source: input.source,
              });
              return { signaled: false };
            }
            throw error;
          }
          return { signaled };
        };

        /**
         * K2: build the FSM hot-apply/gated apply callback used by BOTH the reactive
         * runtime-auth failure coordinator AND the proactive quota coordinator. Routing
         * the proactive quota switch through this (instead of a bare respawn) gives it:
         *  - the same fail-closed reachability gate at respawn (K1) via the FSM's restart path,
         *  - Codex appServer hot-apply IN PLACE when eligible (no respawn, no
         *    ConnectedServiceRestartRequested) + X4 transport invalidation (carried by the
         *    materializer into the hot-apply selection),
         *  - the LOCKED mid-turn-limit contract: continueAfterRuntimeAuthSwitch re-continues
         *    the interrupted user turn under the new account exactly once (hot-apply continues
         *    in place; restart-resume re-drives the last user turn from vendor history). The
         *    exactly-once guard + chain-to-next-member + fail-closed live in the continuation
         *    controller and the switch coordinator/selector respectively.
         * `failureAtMs` anchors the continuation window: the timestamp of the limit/observation
         * that triggered the switch. Side-effect idempotency for tool calls executed before the
         * limit is the provider adapter's responsibility (Codex prefers hot-apply continue-in-place
         * over re-drive to avoid double execution — see applyCodexConnectedServiceAuthGeneration).
         */
        const buildConnectedServiceApplyAuthGeneration = (applyParams: Readonly<{
          failureAtMs: number;
        }>) => async (generationInput: Readonly<{
          sessionId: string;
          serviceId: ConnectedServiceId;
          groupId: string;
          activeProfileId: string | null;
          generation: number;
          reason: string;
        }>): Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string }>> => {
          const activeProfileId = typeof generationInput.activeProfileId === 'string'
            ? generationInput.activeProfileId.trim()
            : '';
          if (!activeProfileId) {
            return { ok: false, errorCode: 'profile_missing' };
          }
          const tracked = getCurrentChildren().find((child) => child.happySessionId === generationInput.sessionId) ?? null;
          if (!tracked) {
            return { ok: false, errorCode: 'session_not_found' };
          }
          const agentId = resolveCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
          const serviceId = ConnectedServiceIdSchema.parse(generationInput.serviceId);
          // K5:fsm_switch reactive + proactive-quota auth-generation apply routes through the FSM
          // (hot-apply-in-place when eligible, else gated restart-resume with reachability + deferral).
          const result = await switchSessionConnectedServiceAuth({
            core: connectedServiceSessionAuthSwitchCore,
            skipCoreLock: true,
            switchReason: 'automatic_runtime_failure',
            sessionEventReason: generationInput.reason,
            getChildren: getCurrentChildren,
            api,
            resolveContinuity: async ({
              tracked: switchTracked,
              sessionId,
              agentId: switchAgentId,
              serviceId: switchServiceId,
              previous,
              next,
              previousBindings,
              normalizedBindings,
              runtimeAuthSelection,
              connectedServiceMaterializationIdentityV1,
              vendorResumeId,
            }) =>
              await resolveSessionConnectedServiceSwitchContinuity({
                sessionId,
                agentId: switchAgentId,
                serviceId: switchServiceId,
                previousBinding: previous,
                nextBinding: next,
                fromBindingsRaw: switchTracked?.spawnOptions?.connectedServices ?? previousBindings,
                toBindings: normalizedBindings,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                connectedServiceMaterializationIdentityV1: readConnectedServiceMaterializationIdentityV1(
                  switchTracked?.spawnOptions?.connectedServiceMaterializationIdentityV1,
                ) ?? connectedServiceMaterializationIdentityV1 ?? null,
                vendorResumeId: switchTracked?.vendorResumeId ?? vendorResumeId ?? null,
                targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
                  agentId: switchAgentId,
                  targetMaterializedEnv: switchTracked?.spawnOptions?.environmentVariables ?? null,
                }),
                targetMaterializedEnv: switchTracked?.spawnOptions?.environmentVariables ?? null,
                cwd: switchTracked?.spawnOptions?.directory ?? null,
                candidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile(
                  switchAgentId,
                  switchTracked?.happySessionMetadataFromLocalWebhook ?? null,
                ),
                ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
              }),
            materializeRuntimeAuthSelection: async (materializerInput) =>
              await materializeSessionConnectedServiceRuntimeAuthSelection({
                credentials,
                api,
                input: materializerInput,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                processEnv: process.env,
              }),
            restartSession: async (restartTracked) => {
              const restartSignalDelayMs = resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
              );
              // K5:fsm_switch the FSM's restart-resume fallback when hot-apply is ineligible;
              // gated through deferral + spawn-time reachability (K1).
              await requestConnectedServiceRestartWithDeferral({
                sessionId: generationInput.sessionId,
                tracked: restartTracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                  serviceId,
                  profileId: activeProfileId,
                  groupId: generationInput.groupId,
                  generation: generationInput.generation,
                }),
                restartSignalDelayMs,
                restartDiagnostic: {
                  trigger: 'automatic_group_switch',
                  sessionId: generationInput.sessionId,
                  agentId,
                  serviceId,
                  profileId: activeProfileId,
                  groupId: generationInput.groupId,
                  generation: generationInput.generation,
                  reason: generationInput.reason,
                },
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session through shared switch primitive',
              });
            },
            hotApply: createSessionConnectedServiceAuthHotApply(),
            recoverAfterRuntimeAuthSwitch: recoverTrackedSessionConnectedServiceRuntimeAuthSwitch,
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
              credentials,
              failureAtMs: applyParams.failureAtMs,
              resumePromptMode: resolveContinuationResumePromptMode(
                getActiveAccountSettingsSnapshot()?.settings ?? null,
              ),
            }),
            persistSessionBindings: async ({
              sessionId,
              normalizedBindings,
              connectedServiceMaterializationIdentityV1,
            }) => {
              await persistSessionConnectedServiceBindings({
                credentials,
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
              });
            },
            registerHotApplyTargets: (switchTracked) => {
              const materializationIdentity = readConnectedServiceMaterializationIdentityV1(
                switchTracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
              );
              if (!materializationIdentity) return;
              connectedServiceRefreshCoordinator?.registerSpawnTarget({
                pid: switchTracked.pid,
                agentId,
                sessionId: switchTracked.happySessionId,
                connectedServicesBindingsRaw: switchTracked.spawnOptions?.connectedServices,
                materializationKey: materializationIdentity.id,
                ...(switchTracked.spawnOptions?.environmentVariables
                  ? { connectedServiceSelectionsEnv: switchTracked.spawnOptions.environmentVariables }
                  : {}),
              });
              connectedServiceQuotasCoordinator?.registerSpawnTarget({
                pid: switchTracked.pid,
                sessionId: switchTracked.happySessionId,
                connectedServicesBindingsRaw: switchTracked.spawnOptions?.connectedServices ?? {},
                ...(switchTracked.spawnOptions?.environmentVariables
                  ? { connectedServiceSelectionsEnv: switchTracked.spawnOptions.environmentVariables }
                  : {}),
              });
            },
            emitSessionEvent: (sessionId, event) => {
              void commitConnectedServiceAccountSwitchSessionEvent({
                credentials,
                sessionId,
                event,
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to commit automatic connected-service account switch session event (non-fatal)', error);
              });
            },
            request: {
              sessionId: generationInput.sessionId,
              agentId,
              bindings: {
                v: 1,
                bindingsByServiceId: {
                  [serviceId]: {
                    source: 'connected',
                    selection: 'group',
                    groupId: generationInput.groupId,
                    profileId: activeProfileId,
                  },
                },
              },
              expectedGroupGenerationByServiceId: {
                [serviceId]: generationInput.generation,
              },
            },
          });
          return result.ok
            ? { ok: true, action: result.action }
            : { ok: false, errorCode: result.errorCode };
        };

            // Handle child process exit
            const onChildExitedBase = createOnChildExited({
              pidToTrackedSession,
              spawnResourceCleanupByPid,
              sessionAttachCleanupByPid,
              getApiMachineForSessions: () => apiMachineForSessions,
          onUnexpectedExit: (tracked, exit) => {
            sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, {
              forceRestart: connectedServicesRestartRequestedPids.has(tracked.pid),
            });
          },
          isExitUnexpectedOverride: (tracked, _exit) => {
            if (!connectedServicesRestartRequestedPids.has(tracked.pid)) return null;
            return true;
          },
          onPidPromoted: ({ fromPid, toPid }) => {
            connectedServiceRefreshCoordinator?.transferPid(fromPid, toPid);
            connectedServiceQuotasCoordinator?.transferPid(fromPid, toPid);
            if (connectedServicesRestartRequestedPids.delete(fromPid)) {
              connectedServicesRestartRequestedPids.add(toPid);
            }
          },
            });
        const onChildExited = (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => {
          const trackedBeforeExit = pidToTrackedSession.get(pid) ?? null;
          const wasConnectedServicesRestartRequested = connectedServicesRestartRequestedPids.has(pid);
          onChildExitedBase(pid, exit);
          if (!pidToTrackedSession.has(pid)) {
            connectedServiceRefreshCoordinator?.unregisterPid(pid);
            connectedServiceQuotasCoordinator?.unregisterPid(pid);
          }
          if (wasConnectedServicesRestartRequested) {
            connectedServicesRestartRequestedPids.delete(pid);
          }
          if (trackedBeforeExit?.happySessionId) {
            const stillLive = getCurrentChildren().some((child) => child.happySessionId === trackedBeforeExit.happySessionId);
            if (!stillLive) {
              connectedServiceTurnDeferralQueue.cancelSession(trackedBeforeExit.happySessionId, 'session_terminated');
            }
            if (!stillLive && !wasConnectedServicesRestartRequested) {
              connectedServiceRuntimeAuthSwitchAttempts.clearSession(trackedBeforeExit.happySessionId);
              connectedServiceSessionAuthSwitchCore.clearSession(trackedBeforeExit.happySessionId);
            }
          }
          void connectedServiceGroupHomeCleanupScheduler.cleanupPendingDeletedGroupHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service group home cleanup tick failed (non-fatal)', error);
          });
        };

        const stopSession = async (sessionId: string): Promise<boolean> => {
          sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
          const stopped = await stopSessionCore(sessionId);
          if (!stopped) return false;
          if (configuration.daemonStopSessionWaitForExitMs > 0) {
            await waitForExistingSessionExitIfStopRequested({
              sessionId,
              pidToTrackedSession,
              isSessionRunnerActive,
              timeoutMs: configuration.daemonStopSessionWaitForExitMs,
              pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
              onExitObserved: (pid, exit) => onChildExited(pid, exit),
            });
          }
          return true;
        };

    const controlToken = randomBytes(32).toString('base64url');

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      machineId,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happier-cli'),
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
      handleSessionConnectedServiceAuthSwitch: async (input) => {
        let diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined;
        const switchStartedAtMs = Date.now();
        const serviceIds = Object.keys(input.bindings.bindingsByServiceId);
        const trackedForSwitch = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
        const previousBindings = readConnectedServiceBindingsOrEmpty(
          trackedForSwitch?.spawnOptions?.connectedServices,
        );
        if (typeof input.accountSettingsVersionHint === 'number') {
          try {
            await refreshDaemonAccountSettingsForHint({
              credentials,
              settingsVersion: input.accountSettingsVersionHint,
            });
            diagnostics = {
              accountSettingsFreshness: {
                requestedVersion: input.accountSettingsVersionHint,
                status: 'succeeded',
              },
            };
          } catch (error) {
            logger.warn('[DAEMON RUN] Account settings freshness refresh failed before connected-service auth switch', serializeAxiosErrorForLog(error));
            diagnostics = {
              accountSettingsFreshness: {
                requestedVersion: input.accountSettingsVersionHint,
                status: 'failed',
                error: toConnectedServiceAuthSwitchDiagnosticError(error),
              },
            };
          }
        }
        // K5:fsm_switch manual (RPC-driven, user-initiated) auth switch through the FSM.
        const result = await switchSessionConnectedServiceAuth({
          core: connectedServiceSessionAuthSwitchCore,
          getChildren: getCurrentChildren,
          resolveInactiveSession: async ({ sessionId }) => {
            const inactiveAgentId = resolveCatalogAgentId(
              (CATALOG_AGENT_IDS as readonly string[]).includes(input.agentId)
                ? input.agentId as Parameters<typeof resolveCatalogAgentId>[0]
                : null,
            );
            const inactive = await resolveInactiveConnectedServiceSessionForAuthSwitch({
              credentials,
              sessionId,
              agentId: inactiveAgentId,
            });
            if (!inactive) return null;
            // Derive the persisted session-file hint from the inactive session metadata via the SAME
            // provider-agnostic catalog helper the tracked/spawn paths use, so the continuity check
            // can prove shared-state resume reachability for an inactive (not-running) session.
            const candidatePersistedSessionFile = resolveConnectedServiceCandidatePersistedSessionFile(
              inactive.agentId,
              inactive.metadata ?? null,
            );
            return {
              ...inactive,
              ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
            };
          },
          api,
          resolveContinuity: async ({
            tracked,
            sessionId,
            agentId,
            serviceId,
            previous,
            next,
            previousBindings,
            normalizedBindings,
            runtimeAuthSelection,
            connectedServiceMaterializationIdentityV1,
            vendorResumeId,
            cwd: inactiveCwd,
            candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
          }) => {
            const effectiveIdentity = readConnectedServiceMaterializationIdentityV1(
              tracked?.spawnOptions?.connectedServiceMaterializationIdentityV1,
            ) ?? connectedServiceMaterializationIdentityV1 ?? null;
            // For an INACTIVE switch (no tracked session) the materialized env/root cannot be read
            // from tracked.spawnOptions. Reconstruct the DETERMINISTIC target materialized root from
            // the materialization identity (the SAME layout the next spawn will materialize into) so
            // the source-aware reachability probe can prove a resumable inactive session instead of
            // fail-closing it. The session cwd + persisted hint come from the inactive resolver.
            const reconstructedRoot = !tracked && effectiveIdentity
              ? resolveConnectedServiceMaterializedRootDir({
                  baseDir: connectedServicesMaterializationBaseDir,
                  agentId,
                  materializationKey: effectiveIdentity.id,
                  materializationIdentity: effectiveIdentity,
                })
              : null;
            const targetMaterializedEnv = tracked?.spawnOptions?.environmentVariables
              ?? (reconstructedRoot
                ? { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: reconstructedRoot }
                : null);
            return await resolveSessionConnectedServiceSwitchContinuity({
              sessionId,
              agentId,
              serviceId,
              previousBinding: previous,
              nextBinding: next,
              fromBindingsRaw: tracked?.spawnOptions?.connectedServices ?? previousBindings,
              toBindings: normalizedBindings,
              accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
              connectedServiceMaterializationIdentityV1: effectiveIdentity,
              vendorResumeId: tracked?.vendorResumeId ?? vendorResumeId ?? null,
              targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
                agentId,
                targetMaterializedEnv,
              }),
              targetMaterializedEnv,
              cwd: tracked?.spawnOptions?.directory ?? inactiveCwd ?? null,
              candidatePersistedSessionFile: tracked
                ? resolveConnectedServiceCandidatePersistedSessionFile(
                    agentId,
                    tracked.happySessionMetadataFromLocalWebhook ?? null,
                  )
                : inactiveCandidatePersistedSessionFile ?? null,
              ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
            });
          },
          materializeRuntimeAuthSelection: async (materializerInput) =>
            await materializeSessionConnectedServiceRuntimeAuthSelection({
              credentials,
              api,
              input: materializerInput,
              accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
              processEnv: process.env,
          }),
          restartSession: async (tracked) => {
            const primaryServiceId = serviceIds.length === 1 ? serviceIds[0] ?? '' : '__multi_service_switch__';
            const primaryBinding = serviceIds.length === 1
              ? input.bindings.bindingsByServiceId[primaryServiceId]
              : null;
            const primaryGeneration = serviceIds.length === 1
              ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
              : undefined;
            const restartSignalDelayMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_AUTH_SWITCH_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            );
            // K5:fsm_switch the FSM's restartSession callback for the manual switch; the FSM
            // owns reachability/continuity and only calls this when a restart-resume is chosen.
            await requestConnectedServiceRestartWithDeferral({
              sessionId: input.sessionId,
              tracked,
              source: 'manual',
              policy: 'defer_until_turn_boundary',
              target: normalizeSwitchTarget({
                serviceId: primaryServiceId,
                profileId: primaryBinding && primaryBinding.source === 'connected' ? primaryBinding.profileId : '',
                groupId: primaryBinding && primaryBinding.source === 'connected' && primaryBinding.selection === 'group'
                  ? primaryBinding.groupId
                  : '',
                generation: serviceIds.length === 1
                  ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
                  : 0,
              }),
              restartSignalDelayMs,
              restartDiagnostic: {
                trigger: 'manual_switch',
                sessionId: input.sessionId,
                agentId: input.agentId,
                serviceId: serviceIds.length === 1 ? serviceIds[0] ?? null : null,
                profileId: primaryBinding && primaryBinding.source === 'connected'
                  ? primaryBinding.profileId
                  : null,
                groupId: primaryBinding && primaryBinding.source === 'connected' && primaryBinding.selection === 'group'
                  ? primaryBinding.groupId
                  : null,
                generation: typeof primaryGeneration === 'number' && Number.isFinite(primaryGeneration)
                  ? Math.max(0, Math.trunc(primaryGeneration))
                  : null,
                reason: 'manual',
              },
              onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth-switched session',
            });
          },
          hotApply: createSessionConnectedServiceAuthHotApply(),
          recoverAfterRuntimeAuthSwitch: recoverTrackedSessionConnectedServiceRuntimeAuthSwitch,
          persistSessionBindings: async ({
            sessionId,
            normalizedBindings,
            connectedServiceMaterializationIdentityV1,
          }) => {
            await persistSessionConnectedServiceBindings({
              credentials,
              sessionId,
              normalizedBindings,
              connectedServiceMaterializationIdentityV1,
            });
          },
          registerHotApplyTargets: (tracked) => {
            const catalogAgentId = resolveCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
            const materializationIdentity = readConnectedServiceMaterializationIdentityV1(
              tracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
            );
            if (!materializationIdentity) return;
            connectedServiceRefreshCoordinator?.registerSpawnTarget({
              pid: tracked.pid,
              agentId: catalogAgentId,
              sessionId: tracked.happySessionId,
              connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
              materializationKey: materializationIdentity.id,
              ...(tracked.spawnOptions?.environmentVariables
                ? { connectedServiceSelectionsEnv: tracked.spawnOptions.environmentVariables }
                : {}),
            });
            connectedServiceQuotasCoordinator?.registerSpawnTarget({
              pid: tracked.pid,
              sessionId: tracked.happySessionId,
              connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices ?? {},
              ...(tracked.spawnOptions?.environmentVariables
                ? { connectedServiceSelectionsEnv: tracked.spawnOptions.environmentVariables }
                : {}),
            });
          },
          emitSessionEvent: (sessionId, event) => {
            void commitConnectedServiceAccountSwitchSessionEvent({
              credentials,
              sessionId,
              event,
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Failed to commit manual connected-service account switch session event (non-fatal)', error);
            });
            const record = event && typeof event === 'object' ? event as Record<string, unknown> : null;
            if (!record || record.type !== 'connected_service_account_switch') return;
            const serviceIdParsed = ConnectedServiceIdSchema.safeParse(record.serviceId);
            if (!serviceIdParsed.success) return;
            const trackedForNotification = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
            const settingsSnapshot = getActiveAccountSettingsSnapshot();
            void dispatchConnectedServiceAccountSwitchNotificationAsync({
              settings: settingsSnapshot?.settings ?? null,
              settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
              expoPushSender: api.push(),
              runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
              listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
              source: {
                sessionId,
                sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                serviceId: serviceIdParsed.data,
                groupId: String(record.groupId ?? ''),
                fromProfileId: typeof record.fromProfileId === 'string' ? record.fromProfileId : null,
                toProfileId: typeof record.toProfileId === 'string' ? record.toProfileId : null,
                reason: 'manual',
              },
              nowMs: () => Date.now(),
              dedupeWindowMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                60_000,
                { min: 0, max: 24 * 60 * 60_000 },
              ),
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Manual connected-service account switch notification failed (non-fatal)', error);
            });
          },
          request: input,
        });
        const resultWithDiagnostics = attachConnectedServiceAuthSwitchDiagnostics(result, diagnostics);
        logConnectedServiceAuthSwitchResult({
          logger,
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceIds,
          result: resultWithDiagnostics,
          startedAtMs: switchStartedAtMs,
          finishedAtMs: Date.now(),
          previousBindings,
          expectedGroupGenerationByServiceId: input.expectedGroupGenerationByServiceId,
        });
        return resultWithDiagnostics;
      },
      handleConnectedServiceRuntimeAuthFailure: async (input) => {
        const runtimeFailureAtMs = Date.now();
        const switchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
          api,
          runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
          leases: connectedServiceAuthGroupSwitchLeases,
          quotaFreshnessMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
            5 * 60_000,
            { min: 1_000, max: 60 * 60_000 },
          ),
          nowMs: () => Date.now(),
          hydratePersistedQuotaSnapshotsForGroup: async (groupInput) => {
            await connectedServiceQuotasCoordinator?.hydratePersistedQuotaSnapshotsForGroup(groupInput);
          },
          probeQuotaSnapshotsForGroup: async (groupInput) => {
            await connectedServiceQuotasCoordinator?.probeGroupQuotaSnapshots(groupInput);
          },
          restartSession: async (restartInput) => {
            const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
            if (!tracked) return;
            const restartSignalDelayMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            );
            // K5:fsm_switch reactive runtime-auth coordinator restartSession; the coordinator is
            // built WITH applyConnectedServiceAuthGeneration (the FSM), so this gated restart is
            // the coordinator's spawn_next_turn fallback inside the FSM-driven flow.
            await requestConnectedServiceRestartWithDeferral({
              sessionId: input.sessionId,
              tracked,
              source: 'automatic',
              policy: 'defer_until_turn_boundary',
              target: normalizeSwitchTarget({
                serviceId: restartInput.serviceId,
                profileId: restartInput.activeProfileId,
                groupId: restartInput.groupId,
                generation: restartInput.generation,
              }),
              restartSignalDelayMs,
              restartDiagnostic: {
                trigger: 'automatic_group_switch',
                sessionId: input.sessionId,
                agentId: resolveCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget),
                serviceId: restartInput.serviceId,
                profileId: restartInput.activeProfileId,
                groupId: restartInput.groupId,
                generation: restartInput.generation,
                reason: restartInput.reason ?? input.classification?.kind ?? null,
              },
              onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session',
            });
          },
          // K2: reactive runtime-auth failure routes through the shared FSM apply builder
          // (hot-apply-in-place when eligible, else gated restart-resume + mid-turn re-continue).
          applyConnectedServiceAuthGeneration: buildConnectedServiceApplyAuthGeneration({
            failureAtMs: runtimeFailureAtMs,
          }),
          emitEvent: (event) => {
            if (!event.success || event.resultStatus !== 'switched') return;
            const trackedForNotification = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
            const settingsSnapshot = getActiveAccountSettingsSnapshot();
            void dispatchConnectedServiceAccountSwitchNotificationAsync({
              settings: settingsSnapshot?.settings ?? null,
              settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
              expoPushSender: api.push(),
              runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
              listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
              source: {
                sessionId: input.sessionId,
                sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                serviceId: event.serviceId,
                groupId: event.groupId,
                fromProfileId: event.fromProfileId,
                toProfileId: event.toProfileId,
                reason: event.reason,
                limitCategory: event.limitCategory ?? null,
                retryAfterMs: event.retryAfterMs ?? null,
                quotaScope: event.quotaScope ?? null,
                providerLimitId: event.providerLimitId ?? null,
                action: event.action ?? null,
              },
              nowMs: () => Date.now(),
              dedupeWindowMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                60_000,
                { min: 0, max: 24 * 60 * 60_000 },
              ),
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Connected-service account switch notification failed (non-fatal)', error);
            });
          },
        });
        return await handleConnectedServiceRuntimeAuthFailureForSession({
          getChildren: getCurrentChildren,
          switchCoordinator,
          switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
          switchCore: connectedServiceSessionAuthSwitchCore,
          temporaryThrottleRecovery: temporaryThrottleRecoveryScheduler,
          credentialRefreshService: connectedServiceRefreshCoordinator,
          restartSession: async (tracked) => {
            const restartSignalDelayMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_REFRESH_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            );
            // K5:gated_restart D7 pure credential-refresh / reconnect recovery restart (no target
            // generation rebind) — gated through deferral + spawn-time reachability.
            await requestConnectedServiceRestartWithDeferral({
              sessionId: input.sessionId,
              tracked,
              source: 'automatic',
              policy: 'defer_until_turn_boundary',
              target: normalizeSwitchTarget({
                serviceId: input.classification?.serviceId ?? '',
                profileId: input.classification?.profileId ?? '',
                groupId: input.classification?.groupId ?? '',
                generation: null,
              }),
              restartSignalDelayMs,
              restartDiagnostic: {
                trigger: 'runtime_auth_recovery_restart',
                sessionId: input.sessionId,
                agentId: resolveCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget),
                serviceId: input.classification?.serviceId ?? null,
                profileId: input.classification?.profileId ?? null,
                groupId: input.classification?.groupId ?? null,
                reason: input.classification?.kind ?? null,
              },
              onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service runtime-auth-refreshed session',
            });
          },
          emitSessionEvent: (sessionId, event) => {
            void commitConnectedServiceAccountSwitchSessionEvent({
              credentials,
              sessionId,
              event,
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Failed to commit connected-service account switch session event (non-fatal)', error);
            });
          },
          sessionId: input.sessionId,
          switchesThisTurn: input.switchesThisTurn,
          classification: input.classification,
        });
      },
      handleConnectedServiceTurnLifecycle: async (input) => {
        connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
          sessionId: input.sessionId,
          event: input.event,
        });
        return { status: 'recorded' as const };
      },
      handleConnectedServiceQuotaSnapshot: async (input) => await recordConnectedServiceRuntimeQuotaSnapshotForSession({
        getChildren: getCurrentChildren,
        quotaCoordinator: connectedServiceQuotasCoordinator,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        snapshot: input.snapshot,
      }),
      handleCodexChatGptAuthTokensRefresh: async (input) => {
        if (!connectedServiceRefreshCoordinator) {
          throw new Error('connected_service_chatgpt_refresh_handler_unavailable');
        }
        return await connectedServiceRefreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
          selection: input.selection,
          chatgptPlanType: input.chatgptPlanType,
        });
      },
    });
    const directPeerRuntimeConfig = resolveMachineTransferRuntimeConfig();
    const directPeerFeatureEnabled = directPeerRuntimeConfig.directPeer.featureEnabled;
    const directPeerServerEnabled = directPeerRuntimeConfig.directPeer.serverEnabled;
    let directPeerRegistry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    let stopDirectPeerServer: () => Promise<void> = async () => {};
    if (directPeerServerEnabled) {
      const { port: directPeerPort, stop } = await startDirectPeerTransferServer({
        readPublishedTransfer: (input) => directPeerRegistry?.readPublishedTransfer(input) ?? null,
        resolveOnDemandTransfer: async (input) => await directPeerRegistry?.resolveOnDemandTransferOnOpen(input) ?? null,
      });
      stopDirectPeerServer = stop;
      directPeerRegistry = createDirectPeerTransferRegistry({
        advertisedPort: directPeerPort,
      });
    }

    // Persist daemon.state.json after the control server is available so:
    // - `happier daemon status` can reliably detect the running process, and
    // - callers can reach `/ping` even if machine registration is slow/unavailable.
    //
    // Note: the presence of daemon.state.json does NOT imply that machine sync is ready.
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      startedWithCliVersion: packageJson.version,
      startedWithPublicReleaseChannel: getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel,
      runtimeId,
      startupSource,
      serviceLabel,
      machineId,
      daemonLogPath: logger.logFilePath,
      controlToken,
    };
    let didWriteDaemonState = false;
    const writeDaemonStateOnce = () => {
      if (didWriteDaemonState) return;
      didWriteDaemonState = true;
      writeDaemonState(fileState);
      logger.debug('[DAEMON RUN] Daemon state written');
    };
    writeDaemonStateOnce();

        // Prepare initial daemon state
        const initialDaemonState: DaemonState = {
          status: 'offline',
          pid: process.pid,
          httpPort: controlPort,
          startedAt: Date.now()
        };

      const connectedServicesRefreshEnabled = parseBooleanEnv(process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED, true);
      if (connectedServicesRefreshEnabled) {
        const refreshTickMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS,
          30_000,
          { min: 5_000, max: 5 * 60_000 },
        );
        const refreshWindowMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
          10 * 60_000,
          { min: 10_000, max: 60 * 60_000 },
        );
        const refreshLeaseMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_MS,
          2 * 60_000,
          { min: 10_000, max: 30 * 60_000 },
        );
        const refreshLeaseContentionWaitMaxMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_CONTENTION_WAIT_MAX_MS,
          5_000,
          { min: 0, max: 30_000 },
        );

        const restartOnAuthUpdate = parseBooleanEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_ENABLED,
          true,
        );
        const onAuthUpdated =
          restartOnAuthUpdate
            ? createConnectedServicesAuthUpdatedRestartHandler({
              restartRequestedPids: connectedServicesRestartRequestedPids,
              pidToTrackedSession,
              resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
              // K3: route credential-refresh / reconnect restarts through the gated
              // restart primitive (turn-deferral + spawn-time reachability gate)
              // instead of the raw SIGTERM primitive. The handler still owns the
              // eligibility/blocking decision; this adapter only enforces deferral.
              requestRestartSignal: async (signalParams) => {
                // O3: switch-attempt trace at the credential-refresh/reconnect restart decision
                // point. The restart is gated (deferral policy below) and re-verifies resume
                // reachability at respawn; this trace records the trigger + ids + deferral state.
                logger.debug('[DAEMON RUN] Connected-service refresh restart attempt', {
                  trigger: signalParams.restartDiagnostic?.trigger ?? 'refresh_triggered_restart',
                  decision: 'gated_refresh_restart',
                  sessionId: signalParams.sessionId,
                  serviceId: signalParams.target.serviceId,
                  groupId: signalParams.target.groupId,
                  generation: signalParams.target.generation,
                  deferralPolicy: 'defer_until_turn_boundary',
                  routedThroughGatedPrimitive: true,
                });
                // K5:gated_restart refresh/reconnect restart deferred until turn boundary,
                // reachability re-verified at respawn (no raw mid-turn SIGTERM). The handler reserves
                // the pid only when the gated restart actually signalled; a superseded/cancelled
                // deferral returns { signaled: false } so the reservation is not leaked.
                return await requestConnectedServiceRestartWithDeferral({
                  sessionId: signalParams.sessionId ?? signalParams.tracked.happySessionId ?? '',
                  tracked: signalParams.tracked,
                  source: 'automatic',
                  policy: 'defer_until_turn_boundary',
                  target: normalizeSwitchTarget({
                    serviceId: signalParams.target.serviceId,
                    profileId: signalParams.target.profileId,
                    groupId: signalParams.target.groupId,
                    generation: signalParams.target.generation,
                  }),
                  restartSignalDelayMs: signalParams.delayMs,
                  restartDiagnostic: signalParams.restartDiagnostic ?? {
                    trigger: 'refresh_triggered_restart',
                    sessionId: signalParams.sessionId,
                  },
                  onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service credential-refreshed session',
                });
              },
              resolveProcessGroupPid: resolveConnectedServiceRestartProcessGroupPid,
              restartSignalDelayMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
              ),
              recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
              onRestartSignalFailure: (error) => {
                logger.warn('[DAEMON RUN] Failed to restart connected-service credential-refreshed session', error);
              },
              onRestartBlocked: (diagnostic) => {
                logger.debug('[DAEMON RUN] Connected-service credential refresh restart blocked', diagnostic);
              },
            })
            : undefined;

        connectedServiceRefreshCoordinator = new ConnectedServiceRefreshCoordinator({
          api,
          credentials,
          machineIdProvider: () => machineId,
          ownerIdProvider: () => `${machineId}:${runtimeId}`,
          activeServerDir: configuration.activeServerDir,
          baseDir: connectedServicesMaterializationBaseDir,
          refreshWindowMs,
          refreshLeaseMs,
          leaseContentionWaitMaxMs: refreshLeaseContentionWaitMaxMs,
          now: () => Date.now(),
          accountSettingsProvider: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
          processEnv: process.env,
          ...(onAuthUpdated ? { onAuthUpdated } : {}),
          onCredentialHealthNotification: async ({ diagnostic, healthStatus, affectedTargets }) => {
            const settingsSnapshot = getActiveAccountSettingsSnapshot();
            const notificationTargets = affectedTargets.length > 0
              ? affectedTargets.map((target) => ({
                sessionId: target.sessionId,
                tracked: pidToTrackedSession.get(target.pid) ?? null,
              }))
              : [{
                sessionId: `connected-service:${diagnostic.serviceId}:${diagnostic.profileId}`,
                tracked: null,
              }];
            await Promise.all(notificationTargets.map(async (target) => {
              await dispatchConnectedServiceCredentialHealthNotificationAsync({
                settings: settingsSnapshot?.settings ?? null,
                settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                expoPushSender: api.push(),
                listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
                source: {
                  sessionId: target.sessionId,
                  sessionTitle: resolveTrackedSessionNotificationTitle(target.tracked),
                  serviceId: diagnostic.serviceId,
                  profileId: diagnostic.profileId,
                  status: healthStatus,
                  reason: diagnostic.category ?? diagnostic.status,
                  providerStatus: diagnostic.providerStatus ?? null,
                  providerErrorCode: diagnostic.providerErrorCode ?? null,
                },
                nowMs: () => Date.now(),
                dedupeWindowMs: resolvePositiveIntEnv(
                  process.env.HAPPIER_CONNECTED_SERVICES_CREDENTIAL_HEALTH_NOTIFICATION_DEDUPE_MS,
                  60_000,
                  { min: 0, max: 24 * 60 * 60_000 },
                ),
              });
            }));
          },
        });

        connectedServiceRefreshLoopHandle = startConnectedServiceRefreshLoop({
          enabled: true,
          tickMs: refreshTickMs,
          coordinator: connectedServiceRefreshCoordinator,
          onTickError: (error) => {
            logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', error);
          },
        });
      }

      const connectedServicesQuotasEnabled = await resolveConnectedServicesQuotasDaemonEnabled({
        env: process.env,
        serverUrl: configuration.serverUrl,
        timeoutMs: 1500,
      });
      if (connectedServicesQuotasEnabled) {
            const quotasTickMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS,
              60_000,
              { min: 5_000, max: 30 * 60_000 },
            );
            const {
              fetchTimeoutMs,
              discoveryEnabled,
              discoveryIntervalMs,
              failureBackoffMinMs,
              failureBackoffMaxMs,
              failureBackoffJitterPct,
            } = resolveConnectedServiceQuotasDaemonOptions(process.env);
            const quotaCredentialRefreshWindowMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
              10 * 60_000,
              { min: 10_000, max: 60 * 60_000 },
            );
            const quotaFetchLeaseMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_MS,
              30_000,
              { min: 1_000, max: 5 * 60_000 },
            );
            const quotaFetchLeaseContentionWaitMaxMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_CONTENTION_WAIT_MAX_MS,
              5_000,
              { min: 0, max: 60_000 },
            );
            const groupSwitchCheckMinIntervalMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_GROUP_SWITCH_CHECK_MIN_INTERVAL_MS,
              60_000,
              { min: 0, max: 30 * 60_000 },
            );

            connectedServiceQuotasCoordinator = new ConnectedServiceQuotasCoordinator({
              api,
              credentials,
              quotaFetchers: createConnectedServiceQuotaFetchers(process.env),
              fetchTimeoutMs,
              discoveryEnabled,
              discoveryIntervalMs,
              failureBackoffMinMs,
              failureBackoffMaxMs,
              failureBackoffJitterPct,
              runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
              credentialRefreshWindowMs: quotaCredentialRefreshWindowMs,
              machineIdProvider: () => machineId,
              ownerIdProvider: () => `${machineId}:${runtimeId}`,
              quotaFetchLeaseMs,
              quotaFetchLeaseContentionWaitMaxMs,
              quotaPersistenceServerWorkScheduler: daemonServerWorkScheduler,
              quotaPersistenceServerScope: configuration.serverUrl,
              quotaPersistenceMinIntervalMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MIN_INTERVAL_MS,
                5_000,
                { min: 0, max: 60_000 },
              ),
              quotaPersistenceMaxKeys: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_KEYS,
                256,
                { min: 1, max: 10_000 },
              ),
              quotaPersistenceMaxKeyAgeMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_KEY_AGE_MS,
                60 * 60_000,
                { min: 60_000, max: 24 * 60 * 60_000 },
              ),
              quotaPersistenceMaxPendingPayloadAgeMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_PENDING_PAYLOAD_AGE_MS,
                5 * 60_000,
                { min: 1_000, max: 60 * 60_000 },
              ),
              quotaPersistenceMaxConsecutiveFailures: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES,
                5,
                { min: 1, max: 100 },
              ),
              groupSwitchCheckMinIntervalMs,
              authGroupSwitchCoordinator: {
                async switchBeforeTurn(input) {
                  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
                  if (!sessionId) return { status: 'session_not_found' };
                  const tracked = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
                  if (!tracked) return { status: 'session_not_found' };
                  const switchCoordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
                    api,
                    runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                    leases: connectedServiceAuthGroupSwitchLeases,
                    quotaFreshnessMs: resolvePositiveIntEnv(
                      process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                      5 * 60_000,
                      { min: 1_000, max: 60 * 60_000 },
                    ),
                    nowMs: () => Date.now(),
                    quotaCoordinator: connectedServiceQuotasCoordinator,
                    // K2 (cmpn4hhdi fix): route the PROACTIVE quota switch through the FSM
                    // hot-apply/gated apply path (not a bare respawn). With a sessionId present
                    // (always here), the coordinator uses this instead of `restartSession`, so the
                    // appServer usage-limit switch hot-applies in place when eligible (+ X4), and
                    // otherwise gates a deferred restart-resume with the K1 reachability gate. The
                    // mid-turn-limit contract (re-continue the interrupted turn exactly once / chain
                    // to next member / fail-closed) is carried by the shared apply builder.
                    // failureAtMs = now: the proactive switch decision point; the continuation
                    // controller's hasUserMessageAfterFailure guard suppresses re-continuation when
                    // no interrupted turn exists.
                    applyConnectedServiceAuthGeneration: buildConnectedServiceApplyAuthGeneration({
                      failureAtMs: Date.now(),
                    }),
                    restartSession: async (restartInput) => {
                      const current = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
                      if (!current) return;
                      const restartSignalDelayMs = resolvePositiveIntEnv(
                        process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                        250,
                        { min: 0, max: 5_000 },
                      );
                      // K5:fsm_switch quota coordinator is FSM-wired (applyConnectedServiceAuthGeneration
                      // above); this gated restart is only the no-sessionId fallback inside that flow.
                      await requestConnectedServiceRestartWithDeferral({
                        sessionId,
                        tracked: current,
                        source: 'automatic',
                        policy: 'defer_until_idle',
                        target: normalizeSwitchTarget({
                          serviceId: restartInput.serviceId,
                          profileId: restartInput.activeProfileId,
                          groupId: restartInput.groupId,
                          generation: restartInput.generation,
                        }),
                        restartSignalDelayMs,
                        restartDiagnostic: {
                          trigger: 'automatic_group_switch',
                          sessionId,
                          agentId: resolveCatalogAgentIdFromBackendTarget(current.spawnOptions?.backendTarget),
                          serviceId: restartInput.serviceId,
                          profileId: restartInput.activeProfileId,
                          groupId: restartInput.groupId,
                          generation: restartInput.generation,
                          reason: restartInput.reason ?? 'soft_threshold',
                        },
                        onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart quota-driven connected-service auth group session',
                      });
                    },
                    emitEvent: (event) => {
                      if (!event.success || event.resultStatus !== 'switched') return;
                      void commitConnectedServiceAccountSwitchSessionEvent({
                        credentials,
                        sessionId,
                        event,
                      }).catch((error) => {
                        logger.debug('[DAEMON RUN] Failed to commit quota-driven connected-service account switch session event (non-fatal)', error);
                      });
                      const current = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
                      const settingsSnapshot = getActiveAccountSettingsSnapshot();
                      void dispatchConnectedServiceAccountSwitchNotificationAsync({
                        settings: settingsSnapshot?.settings ?? null,
                        settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                        expoPushSender: api.push(),
                        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                        listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
                        source: {
                          sessionId,
                          sessionTitle: resolveTrackedSessionNotificationTitle(current),
                          serviceId: event.serviceId,
                          groupId: event.groupId,
                          fromProfileId: event.fromProfileId,
                          toProfileId: event.toProfileId,
                          reason: event.reason,
                          limitCategory: event.limitCategory ?? null,
                          retryAfterMs: event.retryAfterMs ?? null,
                          quotaScope: event.quotaScope ?? null,
                          providerLimitId: event.providerLimitId ?? null,
                          action: event.action ?? null,
                        },
                        nowMs: () => Date.now(),
                        dedupeWindowMs: resolvePositiveIntEnv(
                          process.env.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                          60_000,
                          { min: 0, max: 24 * 60 * 60_000 },
                        ),
                      }).catch((error) => {
                        logger.debug('[DAEMON RUN] Quota-driven connected-service account switch notification failed (non-fatal)', error);
                      });
                    },
                  });
                  // O3: switch-attempt trace at the proactive-quota decision point (the
                  // cmpn4hhdi seam). Captures trigger, ids, generation, hot-apply-vs-restart
                  // (mode), and the structured result status; deferral state + reachability
                  // result are emitted by the deferral-queue and restart-diagnostic events
                  // respectively when a restart-resume is chosen.
                  const proactiveSwitchResult = await switchCoordinator.switchBeforeTurn(input);
                  logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                    trigger: 'automatic_group_switch',
                    decision: 'proactive_quota_switch_before_turn',
                    sessionId,
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    reason: input.reason,
                    resultStatus: proactiveSwitchResult.status,
                    generation: 'generation' in proactiveSwitchResult ? proactiveSwitchResult.generation : null,
                    mode: 'mode' in proactiveSwitchResult ? proactiveSwitchResult.mode ?? null : null,
                    errorCode: 'errorCode' in proactiveSwitchResult ? proactiveSwitchResult.errorCode : null,
                    routedThroughFsm: true,
                  });
                  return proactiveSwitchResult;
                },
              },
              refreshConnectedServiceCredentialForQuota: async (input) =>
                connectedServiceRefreshCoordinator?.refreshConnectedServiceCredentialForQuota({
                  serviceId: input.serviceId,
                  profileId: input.profileId,
                  force: input.force,
                }) ?? null,
              now: () => Date.now(),
              randomBytes: (length) => randomBytes(length),
            });

        connectedServiceQuotasLoopHandle = startConnectedServiceQuotasLoop({
          enabled: true,
          tickMs: quotasTickMs,
          coordinator: connectedServiceQuotasCoordinator,
          onTickError: (error) => {
            logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', error);
          },
        });
      }

      const machineRegistrationTimeoutMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
        10_000,
        { min: 250, max: 120_000 },
      );
      const machineRegistrationRetryBaseDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS
          ?? process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS,
        10_000,
        { min: 0, max: 5 * 60_000 },
      );
      const machineRegistrationRetryMaxDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS,
        5 * 60_000,
        { min: 0, max: 30 * 60_000 },
      );
      const machineRegistrationRetryJitterMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS,
        1_000,
        { min: 0, max: 60_000 },
      );
      const machineRegistrationRetryEffectiveMaxDelayMs = Math.max(
        machineRegistrationRetryBaseDelayMs,
        machineRegistrationRetryMaxDelayMs,
      );
      const machineRegistrationMaxAttempts = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_MAX_ATTEMPTS,
        0,
        { min: 0, max: 10_000 },
      );

      // Do machine bootstrap in the background so shutdown requests are not blocked by /v1/machines latency.
      void (async () => {
        let attempts = 0;
        while (!shutdownInitiated) {
          try {
            const ensured = preflightMachineRegistration ?? await ensureMachineRegistered({
              api,
              machineId,
              metadata: metadataForRegistration,
              daemonState: initialDaemonState,
              timeoutMs: machineRegistrationTimeoutMs,
              caller: 'startDaemon',
            });
            preflightMachineRegistration = null;
            machineId = ensured.machineId;
            if (fileState.machineId !== machineId) {
              fileState.machineId = machineId;
              writeDaemonState(fileState);
            }
            const machine = ensured.machine;
            logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

            if (shutdownInitiated) {
              return;
            }

            // Create realtime machine session
            const connectedApiMachine = diagnosticSubsystemGates.disableMachineSync
              ? null
              : api.machineSyncClient(machine, {
                  runtimeId,
                  cliVersion: packageJson.version,
                  publicReleaseChannel: getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel,
                  startupSource,
                  serviceManaged: isDaemonStartupSourceServiceManaged(startupSource),
                  ...(serviceLabel ? { serviceLabel } : null),
                });
            apiMachine = connectedApiMachine;
            apiMachineForSessions = connectedApiMachine;

            // Set RPC handlers
            if (diagnosticSubsystemGates.disableAutomationWorker) {
              logger.warn('[DAEMON RUN] Diagnostic gate enabled: automation worker disabled');
            } else {
              automationWorker = startAutomationWorker({
                token: credentials.token,
                machineId,
                encryption: credentials.encryption,
                spawnSession,
              });
            }

            memoryWorker = await (async () => {
              try {
                return await startMemoryWorker({
                  credentials,
                  machineId,
                });
              } catch (error) {
                logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
                return null;
              }
            })();

            if (connectedApiMachine) {
              connectedApiMachine.setRPCHandlers({
                spawnSession,
                resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
                stopSession,
                isSessionActive: isSessionAlreadyRunning,
                loadLocalSessionMetadata: loadLocalSessionMetadataForHandoff,
                requestShutdown: () => {
                  void beforeShutdown().finally(() => requestShutdown('happier-app'));
                },
                ...(memoryWorker ? { memory: memoryWorker } : {}),
                daemonServerWorkScheduler,
                machineTransferChannel: {
                  onEnvelope: (listener) => connectedApiMachine.onMachineTransferEnvelope(listener),
                  sendEnvelope: (payload) => connectedApiMachine.sendMachineTransferEnvelope(payload),
                },
                ...(directPeerRegistry
                  ? {
                      directPeerTransfer: {
                        publishTransfer: ({ transferId, payload: _payload, payloadSource, onDemandScope }) => {
                          if (!payloadSource) {
                            throw new Error('Direct peer handoff publish requires a file-backed payload source');
                          }
                          return directPeerRegistry!.publishTransfer({
                            transferId,
                            payloadSource,
                            ...(onDemandScope ? { onDemandScope } : {}),
                          }).endpointCandidates;
                        },
                        requestPayloadFile: async ({ transferId, endpointCandidates, destinationPath, openBody, timeoutMs }) =>
                          await requestDirectPeerTransferToFile({
                            transferId,
                            endpointCandidates,
                            destinationPath,
                            ...(openBody !== undefined ? { openBody } : {}),
                            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                          }),
                        clearPublishedTransfer: (transferId) => directPeerRegistry!.clearPublishedTransfer(transferId),
                      },
                    }
                  : {}),
              }, {
                resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata }) =>
                  await resumeInactiveSessionWhenUsageLimitReady({
                    spawnSession,
                    fallbackMachineId: machineId,
                    sessionId,
                    rawSession,
                    metadata,
                  }),
                scheduleInactiveSessionUsageLimitRecoveryCheck: ({ sessionId, recovery, runCheckNow }) => {
                  inactiveUsageLimitRecoveryCheckRunners.set(sessionId, runCheckNow);
                  void inactiveUsageLimitRecoveryScheduler.upsert({
                    sessionId,
                    intent: recovery,
                  }).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to schedule inactive usage-limit recovery check', {
                      sessionId,
                      error: serializeAxiosErrorForLog(error),
                    });
                  });
                },
                cancelInactiveSessionUsageLimitRecoveryCheck: ({ sessionId }) => {
                  inactiveUsageLimitRecoveryCheckRunners.delete(sessionId);
                  void inactiveUsageLimitRecoveryScheduler.cancel({ sessionId }).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to cancel inactive usage-limit recovery check', {
                      sessionId,
                      error: serializeAxiosErrorForLog(error),
                    });
                  });
                },
              });

              connectedApiMachine.onUpdate((update) => {
                const refs = readConnectedServiceCredentialUpdateRefsFromAccountUpdate(update);
                if (refs.length === 0 || !connectedServiceRefreshCoordinator) return false;
                for (const ref of refs) {
                  void connectedServiceRefreshCoordinator.handleExternalCredentialUpdate(ref).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to apply connected-service credential update', {
                      serviceId: ref.serviceId,
                      profileId: ref.profileId,
                      error: serializeAxiosErrorForLog(error),
                    });
                  });
                }
                return true;
              });

              connectedApiMachine.onUpdate((update) => {
                if (!automationWorker) return false;
                const t = (update?.body as any)?.t;
                if (t === 'automation-assignment-updated' || t === 'automation-run-updated') {
                  automationWorker.handleServerUpdate(update);
                  return true;
                }
                return false;
              });

              connectedApiMachine.onUpdate((update) => {
                const settingsVersion = readAccountSettingsChangedHintVersion(update);
                if (settingsVersion === null) return false;

                void refreshDaemonAccountSettingsForHint({ credentials, settingsVersion }).catch((error) => {
                  logger.warn('[DAEMON RUN] Failed to refresh account settings from live hint', error);
                });
                return true;
              });

              connectedApiMachine.onAccountSettingsVersionHint(async (hint) => {
                await refreshDaemonAccountSettingsForHint({
                  credentials,
                  settingsVersion: hint.settingsVersion,
                });
              });

              daemonConnectivityCoordinator = createDaemonConnectivityCoordinator({
                resources: [
                  ...(automationWorker
                    ? [{
                      name: 'automationWorker',
                      pause: () => automationWorker!.pause(),
                      resume: () => automationWorker!.resume(),
                    }]
                    : []),
                  ...(connectedServiceQuotasLoopHandle
                    ? [{
                      name: 'connectedServiceQuotasLoop',
                      pause: () => connectedServiceQuotasLoopHandle!.pause(),
                      resume: () => connectedServiceQuotasLoopHandle!.resume(),
                    }]
                    : []),
                  ...(connectedServiceRefreshLoopHandle
                    ? [{
                      name: 'connectedServiceRefreshLoop',
                      pause: () => connectedServiceRefreshLoopHandle!.pause(),
                      resume: () => connectedServiceRefreshLoopHandle!.resume(),
                    }]
                    : []),
                ],
              });

              machineConnectionStateCleanup = connectedApiMachine.onConnectionStateChange((state) => {
                daemonServerWorkOnline = state.phase === 'online';
                if (daemonServerWorkOnline) {
                  connectedServiceQuotasCoordinator?.notifyQuotaPersistenceConnectivityChanged();
                }
                void daemonConnectivityCoordinator!.applyState(state).catch((error) => {
                  logger.warn('[DAEMON RUN] Failed to apply daemon connectivity state', error);
                });
              });

              let didRefreshMachineMetadata = false;
              connectedApiMachine.connect({
                takeover: takeoverRequested,
                onConnect: async () => {
                  if (shutdownInitiated) return;

                  if (automationWorker) {
                    await automationWorker.refreshAssignments().catch((error) => {
                      logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
                    });
                  }

                  if (didRefreshMachineMetadata) return;
                  didRefreshMachineMetadata = true;
                  // Keep machine metadata fresh without clobbering user-provided fields (e.g. displayName) that may exist.
                  await connectedApiMachine.updateMachineMetadata((metadata) => {
                    const base = (metadata ?? (machine.metadata as any) ?? {}) as any;
                    const next: MachineMetadata = {
                      ...base,
                      host: preferredHost,
                      platform: os.platform(),
                      happyCliVersion: packageJson.version,
                      homeDir: os.homedir(),
                      happyHomeDir: configuration.happyHomeDir,
                      happyLibDir: projectPath(),
                    } as MachineMetadata;

                    // If nothing changes, skip emitting an update entirely.
                    const current = base as Partial<MachineMetadata>;
                    const isSame =
                      current.host === next.host &&
                      current.platform === next.platform &&
                      current.happyCliVersion === next.happyCliVersion &&
                      current.homeDir === next.homeDir &&
                      current.happyHomeDir === next.happyHomeDir &&
                      current.happyLibDir === next.happyLibDir;

                    if (isSame) {
                      return base as MachineMetadata;
                    }

                    return next;
                  }).catch((error) => {
                    didRefreshMachineMetadata = false;
                    logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
                  });
                },
                onOwnershipConflict: () => {
                  logger.warn('[DAEMON RUN] Machine server ownership conflict detected; shutting down');
                  requestShutdown('happier-app');
                },
              });

              publishOrphanedStartupSessionEnds({
                apiMachine: connectedApiMachine,
                orphanedDeadDaemonSessions,
              });
            } else {
              logger.warn('[DAEMON RUN] Diagnostic gate enabled: machine sync disabled');
            }

            return;
          } catch (error) {
            if (!shouldRetryMachineRegistrationError(error)) {
              logger.warn('[DAEMON RUN] Machine registration rejected (non-retryable); giving up', {
                ...(isMachineContentPublicKeyMismatchError(error) ? { reason: error.reason } : {}),
                ...(serializeAxiosErrorForLog(error) as any),
              });
              return;
            }

            attempts += 1;
            if (machineRegistrationMaxAttempts > 0 && attempts >= machineRegistrationMaxAttempts) {
              logger.warn('[DAEMON RUN] Machine registration failed too many times; giving up', {
                attempt: attempts,
              });
              return;
            }

            const retryDelayMs = Math.min(
              machineRegistrationRetryEffectiveMaxDelayMs,
              computeRestartDelayMs({
                attempt: attempts,
                baseDelayMs: machineRegistrationRetryBaseDelayMs,
                maxDelayMs: machineRegistrationRetryEffectiveMaxDelayMs,
                jitterMs: machineRegistrationRetryJitterMs,
                random: () => Math.random(),
              }),
            );

            // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
            logger.warn(
              '[DAEMON RUN] Machine registration unavailable; retrying',
              {
                attempt: attempts,
                retryDelayMs,
                error: serializeAxiosErrorForLog(error),
              },
            );

            if (shutdownInitiated) {
              return;
            }

            const sleepResult = await sleepMsOrShutdown(retryDelayMs, resolvesWhenShutdownRequested);
            if (sleepResult === 'shutdown') {
              return;
            }
          }
        }
      })();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      onChildExited,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
      isShuttingDown: () => shutdownInitiated,
    });

            // Setup signal handlers
                const cleanupAndShutdown = async (source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
          shutdownInitiated = true;
          connectedServiceTurnDeferralQueue.cancelAll('daemon_shutdown');
          const exitCode = getDaemonShutdownExitCode(source);
          const shutdownWatchdog = setTimeout(async () => {
            logger.debug(`[DAEMON RUN] Shutdown timed out, forcing exit with code ${exitCode}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            process.exit(exitCode);
          }, getDaemonShutdownWatchdogTimeoutMs());
          shutdownWatchdog.unref?.();

          logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

          // Clear health check interval
          if (restartOnStaleVersionAndHeartbeat) {
            clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Clear daemon.state.json early in shutdown so callers observing "stop" don't race a later
      // heartbeat tick or long tail cleanup work (and to satisfy daemon stop integration tests).
      try {
        await clearDaemonState();
        logger.debug('[DAEMON RUN] Daemon state file removed');
      } catch (error) {
        logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
      }
      try {
        await beforeShutdown();
      } catch (error) {
        logger.warn('[DAEMON RUN] Before-shutdown work failed during cleanup', serializeAxiosErrorForLog(error));
      }
      if (connectedServiceRefreshLoopHandle) {
        connectedServiceRefreshLoopHandle.stop();
        connectedServiceRefreshLoopHandle = null;
      }
      if (connectedServiceQuotasLoopHandle) {
        connectedServiceQuotasLoopHandle.stop();
        connectedServiceQuotasLoopHandle = null;
      }
      connectedServiceQuotasCoordinator?.dispose();
      connectedServiceQuotasCoordinator = null;

      if (apiMachine) {
        machineConnectionStateCleanup?.();
        machineConnectionStateCleanup = null;
          const daemonStateUpdateTimeoutMs = resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_SHUTDOWN_STATE_UPDATE_TIMEOUT_MS,
            250,
            { min: 50, max: 30_000 },
          );

          await publishShutdownStateBestEffort({
            apiMachine,
            source,
            timeoutMs: daemonStateUpdateTimeoutMs,
            warn: (message, error) => {
              if (error !== undefined) {
                logger.warn(message, error);
                return;
              }
              logger.warn(message);
            },
          });
      }
      if (automationWorker) {
        automationWorker.stop();
      }
      if (memoryWorker) {
        memoryWorker.stop();
      }

      // Best-effort cleanup for provider-managed background processes (e.g. shared OpenCode server).
      // Important: do not tear down shared provider background processes while session runners are still
      // tracked by this daemon. Some harnesses stop the daemon while externally-started sessions are
      // still live (e.g. in-flight provider tests). Killing the shared OpenCode server in that state
      // can wedge or abort those sessions mid-turn.
      if (pidToTrackedSession.size === 0) {
        try {
          const { stopSharedManagedOpenCodeServerFromEnvBestEffort } = await import('@/backends/opencode/server/sharedManagedServer');
          await stopSharedManagedOpenCodeServerFromEnvBestEffort();
        } catch {
          // best-effort only
        }
      }

      await stopDirectPeerServer();
      await stopControlServer();
          await stopCaffeinate();
          if (daemonLockHandle) {
            await releaseDaemonLock(daemonLockHandle);
          }

          logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
          clearTimeout(shutdownWatchdog);
          process.exit(exitCode);
        };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    try {
      if (daemonLockHandle) {
        await releaseDaemonLock(daemonLockHandle);
      }
    } catch {
      // ignore
    }
    if (error instanceof DaemonOwnershipConflictError) {
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource, error.owner));
    }
    if (error instanceof DaemonStartupConflictError) {
      process.exit(1);
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    process.exit(1);
  }
}
