import type {
  AccountSettings,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialHealthStatusV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { verifyClaudeCodeNativeAuthStatus } from '@/backends/claude/connectedServices/nativeAuth/verifyClaudeCodeNativeAuthStatus';
import {
  buildClaudeConnectedServiceHomeProvenance,
  matchesClaudeConnectedServiceHomeProvenance,
  readClaudeConnectedServiceHomeProvenance,
} from '@/backends/claude/connectedServices/claudeConnectedServiceHomeProvenance';
import { buildClaudeSubscriptionNativeAuthSelectionDescriptor } from '@/backends/claude/connectedServices/materializeClaudeConnectedServiceSelection';
import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
  type ConnectedServicesBindingsV1,
} from './parseConnectedServicesBindings';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import {
  materializeConnectedServicesForSpawn,
  type ConnectedServiceResolvedSelection,
} from './materialize/materializeConnectedServicesForSpawn';
import {
  collectBlockingConnectedServicesMaterializationDiagnostics,
  type ConnectedServicesMaterializationDiagnostic,
  type ConnectedServicesMaterializeResult,
} from './materialize/providerMaterializerTypes';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';
import type { ConnectedServiceCredentialRefreshResult } from './refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import type { RuntimeAccountIdentitySelectionInput } from './quotas/identity/runtimeAccountIdentityTypes';
import { selectConnectedServiceAuthGroupCandidate } from './accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './accountGroups/selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { buildConnectedServiceAuthGroupSwitchState } from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import { evaluatePredictiveSoftSwitchPolicy } from './accountGroups/switching/predictiveSoftSwitchPolicy';
import type { ConnectedServiceRefreshFailureCategory } from './credentials/lifecycleTypes';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';
import type {
  ConnectedServiceRecoverySoftSwitchGuardInput,
  ConnectedServiceRecoverySoftSwitchGuardResult,
} from './recovery/connectedServiceRecoverySwitchGuard';
import { adoptFresherClaudeSubscriptionNativeCredentialForSpawn } from './claudeSubscriptionNativeCredentialRelaySync';

type ConnectedServiceAuthGroupResponse = Readonly<{
  v?: number;
  serviceId?: string;
  groupId: string;
  activeProfileId?: string | null;
  generation?: number | null;
  policy?: unknown;
  members?: unknown;
}>;

type ConnectedServiceAuthGroupApi = Readonly<{
  getConnectedServiceAuthGroup?: (params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<ConnectedServiceAuthGroupResponse | null>;
}>;

type ConnectedServiceProfilesHealthApi = Readonly<{
  listConnectedServiceProfiles?: (params: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
}>;

type ConnectedServiceCredentialHealthUpdateApi = Readonly<{
  updateConnectedServiceCredentialHealth?: (params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
  }>) => Promise<void>;
}>;

type ConnectedServiceAuthGroupPreTurnSwitchCoordinator = Readonly<{
  switchBeforeTurn(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
  }>>;
  switchAfterClassifiedFailure?(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
    retryAtMs?: number | null;
    excluded?: ReadonlyArray<Readonly<{
      profileId: string;
      reason: string;
      retryAtMs?: number | null;
    }>>;
  }>>;
}>;

type ConnectedServiceSpawnCredentialRefreshErrorKind =
  | 'reconnect_required'
  | 'transient_refresh_failed';

type ConnectedServiceSpawnCredentialRefreshService = Readonly<{
  refreshConnectedServiceCredentialForSpawnPreflight(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    force?: boolean;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type ConnectedServiceRecoverySoftSwitchGuard = (
  input: ConnectedServiceRecoverySoftSwitchGuardInput,
) => Promise<ConnectedServiceRecoverySoftSwitchGuardResult>;

export class ConnectedServiceSpawnCredentialRefreshError extends Error {
  readonly kind: ConnectedServiceSpawnCredentialRefreshErrorKind;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;
  readonly diagnostic: ConnectedServiceCredentialRefreshResult['diagnostic'];

  constructor(params: Readonly<{
    kind: ConnectedServiceSpawnCredentialRefreshErrorKind;
    diagnostic: ConnectedServiceCredentialRefreshResult['diagnostic'];
  }>) {
    super(
      params.kind === 'reconnect_required'
        ? `Connected service credential needs reconnect (${params.diagnostic.serviceId}/${params.diagnostic.profileId})`
        : `Connected service credential refresh failed transiently (${params.diagnostic.serviceId}/${params.diagnostic.profileId})`,
    );
    this.name = 'ConnectedServiceSpawnCredentialRefreshError';
    this.kind = params.kind;
    this.serviceId = params.diagnostic.serviceId;
    this.profileId = params.diagnostic.profileId;
    this.diagnostic = params.diagnostic;
  }
}

export class ConnectedServiceSpawnGroupSwitchUnavailableError extends Error {
  readonly serviceId: ConnectedServiceId;
  readonly groupId: string;
  readonly activeProfileId: string;
  readonly status: string;
  readonly generation: number | null;
  readonly retryAtMs: number | null;
  readonly excluded: ReadonlyArray<Readonly<{
    profileId: string;
    reason: string;
    retryAtMs?: number | null;
  }>>;
  readonly cause: ConnectedServiceSpawnCredentialRefreshError;

  constructor(params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    status: string;
    generation?: number | null;
    retryAtMs?: number | null;
    excluded?: ReadonlyArray<Readonly<{
      profileId: string;
      reason: string;
      retryAtMs?: number | null;
    }>>;
    cause: ConnectedServiceSpawnCredentialRefreshError;
  }>) {
    super(
      `Connected service auth group fallback unavailable (${params.serviceId}/${params.groupId}, active ${params.activeProfileId}, status ${params.status})`,
    );
    this.name = 'ConnectedServiceSpawnGroupSwitchUnavailableError';
    this.serviceId = params.serviceId;
    this.groupId = params.groupId;
    this.activeProfileId = params.activeProfileId;
    this.status = params.status;
    this.generation = typeof params.generation === 'number' && Number.isFinite(params.generation)
      ? params.generation
      : null;
    this.retryAtMs = typeof params.retryAtMs === 'number' && Number.isFinite(params.retryAtMs)
      ? params.retryAtMs
      : null;
    this.excluded = params.excluded ?? [];
    this.cause = params.cause;
  }
}

/**
 * Thrown by the spawn-path post-materialization resume reachability RE-VERIFY gate (K1 §2) when the
 * resumed session is genuinely unreachable in the REAL materialized target the vendor will read.
 *
 * This is the load-bearing fail-closed: rather than returning a materialized env the vendor would
 * crash resuming ("Pi process exited" by a different door, after the daemon already respawned), the
 * spawn fails BEFORE the vendor launches with a concrete structured reason. `errorCode` reuses the
 * shared continuity vocabulary (`provider_session_state_unavailable_for_resume`) and `failurePhase`
 * is `continuity`, matching the switch-FSM taxonomy so callers/observability can treat both doors
 * identically. No provider knowledge lives here — `agentId` is a typed value.
 */
export class ConnectedServiceSpawnResumeUnreachableError extends Error {
  readonly errorCode = 'provider_session_state_unavailable_for_resume' as const;
  readonly failurePhase = 'continuity' as const;
  readonly agentId: CatalogAgentId;
  readonly vendorResumeId: string;
  readonly cwd: string;
  readonly targetMaterializedRoot: string | null;
  readonly reason: string;

  constructor(params: Readonly<{
    agentId: CatalogAgentId;
    vendorResumeId: string;
    cwd: string;
    targetMaterializedRoot: string | null;
    reason: string;
  }>) {
    super(
      `Connected service resume state unreachable for ${params.agentId} resume '${params.vendorResumeId}' (reason ${params.reason})`,
    );
    this.name = 'ConnectedServiceSpawnResumeUnreachableError';
    this.agentId = params.agentId;
    this.vendorResumeId = params.vendorResumeId;
    this.cwd = params.cwd;
    this.targetMaterializedRoot = params.targetMaterializedRoot;
    this.reason = params.reason;
  }
}

export class ConnectedServiceSpawnMaterializationError extends Error {
  readonly agentId: CatalogAgentId;
  readonly diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];

  constructor(params: Readonly<{
    agentId: CatalogAgentId;
    diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  }>) {
    const primary = params.diagnostics[0];
    super(
      primary
        ? `Connected service materialization failed for ${params.agentId} (${primary.code})`
        : `Connected service materialization failed for ${params.agentId}`,
    );
    this.name = 'ConnectedServiceSpawnMaterializationError';
    this.agentId = params.agentId;
    this.diagnostics = params.diagnostics;
  }
}

function readProfileId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isReconnectRequiredRefreshCategory(category: ConnectedServiceRefreshFailureCategory | undefined): boolean {
  return category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function shouldPreflightRefreshCredential(record: ConnectedServiceCredentialRecordV1): boolean {
  return record.kind === 'oauth'
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt);
}

function assertNoBlockingMaterializationDiagnostics(params: Readonly<{
  agentId: CatalogAgentId;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>): void {
  const blocking = collectBlockingConnectedServicesMaterializationDiagnostics(params.diagnostics);
  if (blocking.length === 0) return;
  throw new ConnectedServiceSpawnMaterializationError({
    agentId: params.agentId,
    diagnostics: blocking,
  });
}

async function applySpawnPreflightRefresh(params: Readonly<{
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<void> {
  for (const binding of params.credentialBindings) {
    const record = params.recordsByServiceId.get(binding.serviceId);
    if (!record || !shouldPreflightRefreshCredential(record)) continue;
    if (!params.refreshService) {
      if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && record.expiresAt <= params.nowMs) {
        throw new ConnectedServiceSpawnCredentialRefreshError({
          kind: 'reconnect_required',
          diagnostic: {
            serviceId: binding.serviceId,
            profileId: binding.profileId,
            reason: 'spawn_preflight',
            status: 'refresh_failed',
            category: 'provider_401',
            expiresAt: record.expiresAt,
            expiryAgeMs: params.nowMs - record.expiresAt,
            refreshWindowMs: 0,
          },
        });
      }
      continue;
    }

    const result = await params.refreshService.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: binding.serviceId,
      profileId: binding.profileId,
      ...(params.forceOauthRefresh ? { force: true } : {}),
    });
    if (result.status === 'refreshed' && result.credential) {
      params.recordsByServiceId.set(binding.serviceId, result.credential);
      continue;
    }
    if (result.status === 'refresh_failed') {
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: isReconnectRequiredRefreshCategory(result.diagnostic.category)
          ? 'reconnect_required'
          : 'transient_refresh_failed',
        diagnostic: result.diagnostic,
      });
    }
    if (result.status === 'credential_missing' || result.status === 'lease_not_acquired') {
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: result.status === 'credential_missing' ? 'reconnect_required' : 'transient_refresh_failed',
        diagnostic: result.diagnostic,
      });
    }
  }
}

async function assertCredentialHealthAllowsSpawn(params: Readonly<{
  api: ApiClient;
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<void> {
  const profilesApi = params.api as ConnectedServiceProfilesHealthApi;
  if (typeof profilesApi.listConnectedServiceProfiles !== 'function') return;

  const bindingsByServiceId = new Map<ConnectedServiceId, Set<string>>();
  for (const binding of params.credentialBindings) {
    const profileId = String(binding.profileId ?? '').trim();
    if (!profileId) continue;
    const existing = bindingsByServiceId.get(binding.serviceId);
    if (existing) {
      existing.add(profileId);
    } else {
      bindingsByServiceId.set(binding.serviceId, new Set([profileId]));
    }
  }

  for (const [serviceId, profileIds] of bindingsByServiceId.entries()) {
    const result = await profilesApi.listConnectedServiceProfiles({ serviceId });
    const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
    for (const profile of profiles) {
      if (!profileIds.has(profile.profileId)) continue;
      if (profile.status !== 'needs_reauth') continue;
      throw new ConnectedServiceSpawnCredentialRefreshError({
        kind: 'reconnect_required',
        diagnostic: {
          serviceId,
          profileId: profile.profileId,
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'invalid_grant',
          expiresAt: null,
          expiryAgeMs: null,
          refreshWindowMs: 0,
        },
      });
    }
  }
}

function isFullAuthGroup(value: ConnectedServiceAuthGroupResponse): value is ConnectedServiceAuthGroupV1 {
  return value.v === 1
    && typeof value.serviceId === 'string'
    && Array.isArray((value as { members?: unknown }).members)
    && typeof value.generation === 'number'
    && Number.isFinite(value.generation)
    && typeof value.policy === 'object'
    && value.policy !== null;
}

function isActiveGroupProfileUsageExhausted(
  state: ReturnType<typeof buildConnectedServiceAuthGroupSwitchState>,
  nowMs: number,
): boolean {
  const activeState = state.activeProfileId
    ? state.memberStatesByProfileId.get(state.activeProfileId) ?? null
    : null;
  const activeRemaining = activeState?.quotaSnapshot?.effectiveRemainingPercent;
  return activeState?.quotaSnapshot?.exhausted === true
    || (typeof activeRemaining === 'number' && Number.isFinite(activeRemaining) && activeRemaining <= 0)
    || (typeof activeState?.quotaExhaustedUntilMs === 'number' && activeState.quotaExhaustedUntilMs > nowMs)
    || (typeof activeState?.rateLimitedUntilMs === 'number' && activeState.rateLimitedUntilMs > nowMs);
}

async function maybeSelectGroupActiveProfileForSpawn(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  serviceId: ConnectedServiceId;
  groupId: string;
  api: ConnectedServiceAuthGroupApi;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
  predictiveSoftSwitchMode: 'supported' | 'unsupported';
}>): Promise<ConnectedServiceAuthGroupResponse> {
  if (!params.runtimeQuotaSnapshots || !isFullAuthGroup(params.group)) return params.group;
  // Pre-spawn switches only happen through the injected switch coordinator FSM. There is no
  // direct active-profile API fallback: a raw write would be a lease-less, event-less parallel
  // switching mechanism invisible to switch telemetry and locking (RD-SW-4).
  if (!params.authGroupSwitchCoordinator) return params.group;

  const state = buildConnectedServiceAuthGroupSwitchState({
    group: params.group,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    nowMs: params.nowMs,
  });
  if (!state.policy.autoSwitch) return params.group;
  const activeUsageExhausted = isActiveGroupProfileUsageExhausted(state, params.nowMs);
  const switchReason = activeUsageExhausted ? 'usage_limit' : 'soft_threshold';
  const currentActiveProfileId = readProfileId(state.activeProfileId);

  if (params.sessionId && params.softSwitchRecoveryGuard && currentActiveProfileId) {
    const guardResult = await params.softSwitchRecoveryGuard({
      sessionId: params.sessionId,
      serviceId: params.serviceId,
      groupId: params.groupId,
      activeProfileId: currentActiveProfileId,
      reason: switchReason,
    });
    if (guardResult.status === 'suppress') return params.group;
  }

  const predictivePolicy = evaluatePredictiveSoftSwitchPolicy({
    context: 'pre_spawn',
    reason: switchReason,
    predictiveSoftSwitchMode: params.predictiveSoftSwitchMode,
  });
  if (predictivePolicy.status === 'suppress') return params.group;

  if (
    params.authGroupSwitchCoordinator
    && resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: state.activeProfileId,
      members: state.members,
      memberStatesByProfileId: state.memberStatesByProfileId,
      policy: state.policy,
      nowMs: params.nowMs,
      quotaFreshnessMs: params.quotaFreshnessMs,
      allowCurrentProfileRetry: true,
    }).length > 0
  ) {
    const switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      serviceId: params.serviceId,
      groupId: params.groupId,
      reason: switchReason,
    });
    const activeProfileId = readProfileId(switched.activeProfileId);
    if (activeProfileId) {
      return {
        ...params.group,
        activeProfileId,
        generation: typeof switched.generation === 'number' && Number.isFinite(switched.generation)
          ? switched.generation
          : params.group.generation,
      };
    }
  }

  const selected = selectConnectedServiceAuthGroupCandidate({
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    activeProfileId: state.activeProfileId,
    policy: state.policy,
    members: state.members,
    memberStatesByProfileId: state.memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });
  const selectedProfileId = selected.selected?.profileId ?? null;
  if (!selectedProfileId || selectedProfileId === readProfileId(state.activeProfileId)) return params.group;

  const switched = await params.authGroupSwitchCoordinator.switchBeforeTurn({
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    serviceId: params.serviceId,
    groupId: params.groupId,
    reason: switchReason,
  });
  const activeProfileId = readProfileId(switched.activeProfileId);
  if (activeProfileId) {
    return {
      ...params.group,
      activeProfileId,
      generation: typeof switched.generation === 'number' && Number.isFinite(switched.generation)
        ? switched.generation
        : params.group.generation,
    };
  }
  return params.group;
}

async function resolveCredentialBindings(params: Readonly<{
  api: ApiClient;
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
  predictiveSoftSwitchMode: 'supported' | 'unsupported';
}>): Promise<Readonly<{
  credentialBindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>> {
  const credentialBindings: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
  const groupSelections = new Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>();

  for (const selection of params.selections) {
    if (selection.kind === 'profile') {
      credentialBindings.push({ serviceId: selection.serviceId, profileId: selection.profileId });
      continue;
    }

    const groupApi = params.api as ConnectedServiceAuthGroupApi;
    if (typeof groupApi.getConnectedServiceAuthGroup !== 'function') {
      throw new Error(`Connected service group resolution unavailable (${selection.serviceId}/${selection.groupId})`);
    }

    const group = await groupApi.getConnectedServiceAuthGroup({
      serviceId: selection.serviceId,
      groupId: selection.groupId,
    });
    if (!group) {
      throw new Error(`Missing connected service auth group (${selection.serviceId}/${selection.groupId})`);
    }
    const selectedGroup = await maybeSelectGroupActiveProfileForSpawn({
      group,
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      api: groupApi,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
      quotaFreshnessMs: params.quotaFreshnessMs,
      nowMs: params.nowMs,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      softSwitchRecoveryGuard: params.softSwitchRecoveryGuard ?? null,
      predictiveSoftSwitchMode: params.predictiveSoftSwitchMode,
    });
    const activeProfileId = readProfileId(selectedGroup.activeProfileId);
    if (!activeProfileId) {
      throw new Error(`Connected service auth group has no active profile (${selection.serviceId}/${selection.groupId})`);
    }
    credentialBindings.push({ serviceId: selection.serviceId, profileId: activeProfileId });
    groupSelections.set(selection.serviceId, {
      groupId: selection.groupId,
      activeProfileId,
      fallbackProfileId: selection.fallbackProfileId ?? activeProfileId,
      generation: typeof selectedGroup.generation === 'number' && Number.isFinite(selectedGroup.generation) ? selectedGroup.generation : 0,
      policy: selectedGroup.policy ?? null,
      memberCount: Array.isArray(selectedGroup.members)
        ? selectedGroup.members.filter((member) => member.enabled !== false).length
        : 1,
    });
  }

  return { credentialBindings, groupSelections };
}

type ConnectedServiceResolvedGroupSelection = Readonly<{
  groupId: string;
  activeProfileId: string;
  fallbackProfileId: string;
  generation: number;
  policy: unknown;
  memberCount: number;
}>;

function resolveConnectedServiceAuthGroupMemberCount(group: ConnectedServiceAuthGroupResponse): number {
  return Array.isArray(group.members)
    ? group.members.filter((member) => (
      Boolean(member)
        && typeof member === 'object'
        && (member as { enabled?: unknown }).enabled !== false
    )).length
    : 1;
}

function isAuthoritativeGroupActiveProfileEligible(params: Readonly<{
  group: ConnectedServiceAuthGroupResponse;
  activeProfileId: string;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  nowMs: number;
}>): boolean {
  if (!params.runtimeQuotaSnapshots || !isFullAuthGroup(params.group)) return false;
  const state = buildConnectedServiceAuthGroupSwitchState({
    group: params.group,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    nowMs: params.nowMs,
  });
  const activeMembers = state.members.filter((member) => member.profileId === params.activeProfileId);
  if (activeMembers.length === 0) return false;
  const selected = selectConnectedServiceAuthGroupCandidate({
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    activeProfileId: params.activeProfileId,
    policy: state.policy,
    members: activeMembers,
    memberStatesByProfileId: state.memberStatesByProfileId,
    allowCurrentProfileRetry: true,
  });
  return selected.selected?.profileId === params.activeProfileId;
}

async function applyGroupActiveProfileForSpawn(params: Readonly<{
  serviceId: ConnectedServiceId;
  activeProfileId: string;
  generation?: number | null;
  policy?: unknown;
  memberCount?: number;
  group: ConnectedServiceResolvedGroupSelection;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentials: Credentials;
  api: ApiClient;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<boolean> {
  const switchedRecords = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.serviceId, profileId: params.activeProfileId }],
  });
  const switchedRecord = switchedRecords.get(params.serviceId);
  if (!switchedRecord) return false;

  params.recordsByServiceId.set(params.serviceId, switchedRecord);
  params.groupSelections.set(params.serviceId, {
    ...params.group,
    activeProfileId: params.activeProfileId,
    generation: typeof params.generation === 'number' && Number.isFinite(params.generation)
      ? params.generation
      : params.group.generation,
    policy: params.policy ?? params.group.policy,
    memberCount: params.memberCount ?? params.group.memberCount,
  });

  await applySpawnPreflightRefresh({
    recordsByServiceId: params.recordsByServiceId,
    credentialBindings: [{ serviceId: params.serviceId, profileId: params.activeProfileId }],
    refreshService: params.refreshService,
    nowMs: params.nowMs,
    forceOauthRefresh: params.forceOauthRefresh,
  });
  return true;
}

async function maybeApplyAuthoritativeGroupActiveProfileAfterUnavailableSwitch(params: Readonly<{
  serviceId: ConnectedServiceId;
  group: ConnectedServiceResolvedGroupSelection;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentials: Credentials;
  api: ApiClient;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<boolean> {
  const groupApi = params.api as ConnectedServiceAuthGroupApi;
  if (typeof groupApi.getConnectedServiceAuthGroup !== 'function') return false;
  const currentGroup = await groupApi.getConnectedServiceAuthGroup({
    serviceId: params.serviceId,
    groupId: params.group.groupId,
  });
  if (!currentGroup) return false;
  const activeProfileId = readProfileId(currentGroup.activeProfileId);
  if (!activeProfileId || activeProfileId === params.group.activeProfileId) return false;
  if (!isAuthoritativeGroupActiveProfileEligible({
    group: currentGroup,
    activeProfileId,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
    quotaFreshnessMs: params.quotaFreshnessMs,
    nowMs: params.nowMs,
  })) {
    return false;
  }

  return await applyGroupActiveProfileForSpawn({
    serviceId: params.serviceId,
    activeProfileId,
    generation: currentGroup.generation,
    policy: currentGroup.policy,
    memberCount: resolveConnectedServiceAuthGroupMemberCount(currentGroup),
    group: params.group,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentials: params.credentials,
    api: params.api,
    refreshService: params.refreshService,
    nowMs: params.nowMs,
    forceOauthRefresh: params.forceOauthRefresh,
  });
}

async function maybeSwitchGroupAfterSpawnPreflightRefreshFailure(params: Readonly<{
  error: ConnectedServiceSpawnCredentialRefreshError;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentials: Credentials;
  api: ApiClient;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs: number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<boolean> {
  if (params.error.kind !== 'reconnect_required') return false;
  const group = params.groupSelections.get(params.error.serviceId);
  if (!group || group.activeProfileId !== params.error.profileId) return false;

  if (typeof params.authGroupSwitchCoordinator?.switchAfterClassifiedFailure !== 'function') return false;

  const switched = await params.authGroupSwitchCoordinator.switchAfterClassifiedFailure({
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    serviceId: params.error.serviceId,
    groupId: group.groupId,
    reason: 'refresh_failed',
    observedProfileId: params.error.profileId,
  });
  const activeProfileId = readProfileId(switched.activeProfileId);
  if (!activeProfileId || activeProfileId === group.activeProfileId) {
    if (switched.status === 'no_eligible_member') {
      const applied = await maybeApplyAuthoritativeGroupActiveProfileAfterUnavailableSwitch({
        serviceId: params.error.serviceId,
        group,
        groupSelections: params.groupSelections,
        recordsByServiceId: params.recordsByServiceId,
        credentials: params.credentials,
        api: params.api,
        runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
        quotaFreshnessMs: params.quotaFreshnessMs,
        refreshService: params.refreshService,
        nowMs: params.nowMs,
        forceOauthRefresh: params.forceOauthRefresh,
      });
      if (applied) return true;
    }
    throw new ConnectedServiceSpawnGroupSwitchUnavailableError({
      serviceId: params.error.serviceId,
      groupId: group.groupId,
      activeProfileId: group.activeProfileId,
      status: switched.status,
      generation: switched.generation,
      retryAtMs: switched.retryAtMs,
      excluded: switched.excluded,
      cause: params.error,
    });
  }

  return await applyGroupActiveProfileForSpawn({
    serviceId: params.error.serviceId,
    activeProfileId,
    generation: switched.generation,
    group,
    groupSelections: params.groupSelections,
    recordsByServiceId: params.recordsByServiceId,
    credentials: params.credentials,
    api: params.api,
    refreshService: params.refreshService,
    nowMs: params.nowMs,
    forceOauthRefresh: params.forceOauthRefresh,
  });
}

async function maybeSwitchGroupAfterSpawnMaterializationFailure(params: Readonly<{
  error: ConnectedServiceSpawnMaterializationError;
  groupSelections: Map<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  credentials: Credentials;
  api: ApiClient;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  refreshService: ConnectedServiceSpawnCredentialRefreshService | null;
  nowMs: number;
  forceOauthRefresh: boolean;
}>): Promise<boolean> {
  const diagnostic = params.error.diagnostics.find((candidate) => {
    if (!candidate.serviceId) return false;
    return params.groupSelections.has(candidate.serviceId);
  });
  const serviceId = diagnostic?.serviceId;
  if (!serviceId) return false;

  const group = params.groupSelections.get(serviceId);
  if (!group) return false;
  if (typeof params.authGroupSwitchCoordinator?.switchAfterClassifiedFailure !== 'function') return false;

  await persistMaterializationFailureCredentialHealthForSpawn({
    api: params.api,
    serviceId,
    profileId: group.activeProfileId,
    diagnostic,
  });

  const switched = await params.authGroupSwitchCoordinator.switchAfterClassifiedFailure({
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    serviceId,
    groupId: group.groupId,
    reason: 'refresh_failed',
    observedProfileId: group.activeProfileId,
  });
  const activeProfileId = readProfileId(switched.activeProfileId);
  if (!activeProfileId || activeProfileId === group.activeProfileId) return false;

  const switchedRecords = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId, profileId: activeProfileId }],
  });
  const switchedRecord = switchedRecords.get(serviceId);
  if (!switchedRecord) return false;

  params.recordsByServiceId.set(serviceId, switchedRecord);
  params.groupSelections.set(serviceId, {
    ...group,
    activeProfileId,
    generation: typeof switched.generation === 'number' && Number.isFinite(switched.generation)
      ? switched.generation
      : group.generation,
  });

  await applySpawnPreflightRefresh({
    recordsByServiceId: params.recordsByServiceId,
    credentialBindings: [{ serviceId, profileId: activeProfileId }],
    refreshService: params.refreshService,
    nowMs: params.nowMs,
    forceOauthRefresh: params.forceOauthRefresh,
  });
  return true;
}

async function persistMaterializationFailureCredentialHealthForSpawn(params: Readonly<{
  api: ApiClient;
  serviceId: ConnectedServiceId;
  profileId: string;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
}>): Promise<void> {
  const updateHealth = (params.api as ConnectedServiceCredentialHealthUpdateApi).updateConnectedServiceCredentialHealth;
  if (typeof updateHealth !== 'function') return;
  const now = Date.now();
  const providerErrorCode = typeof params.diagnostic.code === 'string' && params.diagnostic.code.trim().length > 0
    ? params.diagnostic.code.trim().slice(0, 128)
    : undefined;
  await updateHealth.call(params.api, {
    serviceId: params.serviceId,
    profileId: params.profileId,
    health: {
      v: 1,
      status: 'needs_reauth',
      reconnectRequired: true,
      lastRefreshAttemptAt: now,
      lastRefreshFailureAt: now,
      lastRefreshFailureKind: 'provider_403',
      providerHttpStatus: 403,
      ...(providerErrorCode ? { providerErrorCode } : {}),
    },
  });
}

function buildSelectionsByServiceIdForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>): ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> {
  const selectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>();

  for (const selection of params.selections) {
    const record = params.recordsByServiceId.get(selection.serviceId);
    if (!record) continue;
    if (selection.kind === 'profile') {
      selectionsByServiceId.set(selection.serviceId, {
        kind: 'profile',
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        record,
      });
      continue;
    }
    const group = params.groupSelections.get(selection.serviceId);
    if (!group) continue;
    selectionsByServiceId.set(selection.serviceId, {
      kind: 'group',
      serviceId: selection.serviceId,
      groupId: group.groupId,
      activeProfileId: group.activeProfileId,
      fallbackProfileId: group.fallbackProfileId,
      generation: group.generation,
      record,
      policy: group.policy,
    });
  }

  return selectionsByServiceId;
}

function buildCanonicalConnectedServicesBindingsForSpawn(params: Readonly<{
  selections: ReadonlyArray<ConnectedServiceBindingSelection>;
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>;
}>): ConnectedServicesBindingsV1 {
  const bindingsByServiceId: ConnectedServicesBindingsV1['bindingsByServiceId'] = {};

  for (const selection of params.selections) {
    if (selection.kind === 'profile') {
      bindingsByServiceId[selection.serviceId] = {
        source: 'connected',
        selection: 'profile',
        profileId: selection.profileId,
      };
      continue;
    }
    const group = params.groupSelections.get(selection.serviceId);
    if (!group) continue;
    bindingsByServiceId[selection.serviceId] = {
      source: 'connected',
      selection: 'group',
      groupId: group.groupId,
      profileId: group.activeProfileId,
    };
  }

  return {
    v: 1,
    bindingsByServiceId,
  };
}

function buildRuntimeAccountIdentitySelectionsForSpawn(
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>,
): RuntimeAccountIdentitySelectionInput[] {
  return Array.from(selectionsByServiceId.values()).map((selection) => {
    if (selection.kind === 'group') {
      return {
        serviceId: selection.serviceId,
        profileId: selection.activeProfileId,
        groupId: selection.groupId,
        groupGeneration: selection.generation,
        record: selection.record,
        source: 'spawn_selection',
      };
    }
    return {
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      groupId: null,
      groupGeneration: null,
      record: selection.record,
      source: 'spawn_selection',
    };
  });
}

function resolveMaxSpawnMaterializationAttempts(
  groupSelections: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedGroupSelection>,
): number {
  const groupMemberCounts = Array.from(groupSelections.values())
    .map((group) => group.memberCount)
    .filter((count) => Number.isInteger(count) && count > 0);
  return Math.max(1, ...groupMemberCounts);
}

async function materializeAndVerifyConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv: NodeJS.ProcessEnv;
  vendorResumeId: string | null;
  resumeReachabilityRequired: boolean;
  candidatePersistedSessionFile: string | null;
  nowMs: number;
}>): Promise<ConnectedServicesMaterializeResult | null> {
  const materialized = await materializeConnectedServicesForSpawn({
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    connectedServiceMaterializationIdentityV1: params.connectedServiceMaterializationIdentityV1,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    sessionDirectory: params.sessionDirectory,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    accountSettings: params.accountSettings,
    processEnv: params.processEnv,
    vendorResumeId: params.vendorResumeId,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
  });

  if (!materialized) return null;

  assertNoBlockingMaterializationDiagnostics({
    agentId: params.agentId,
    diagnostics: materialized.diagnostics,
  });
  await assertClaudeNativeAuthMaterializedForSpawn({
    agentId: params.agentId,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    materializedEnv: materialized.env,
    nowMs: params.nowMs,
  });
  await assertSpawnResumeReachable({
    agentId: params.agentId,
    materializedEnv: materialized.env,
    vendorResumeId: params.vendorResumeId,
    cwd: params.sessionDirectory,
    resumeReachabilityRequired: params.resumeReachabilityRequired,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
  });
  return materialized;
}

async function assertClaudeNativeAuthMaterializedForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  materializedEnv: Readonly<Record<string, string>>;
  nowMs: number;
}>): Promise<void> {
  if (params.agentId !== 'claude' || !params.recordsByServiceId.has('claude-subscription')) return;
  const record = params.recordsByServiceId.get('claude-subscription');
  const selection = params.selectionsByServiceId.get('claude-subscription');
  if (!record || !selection) return;
  const claudeConfigDir = params.materializedEnv.CLAUDE_CONFIG_DIR?.trim();
  if (!claudeConfigDir) {
    throw new ConnectedServiceSpawnMaterializationError({
      agentId: params.agentId,
      diagnostics: [{
        code: 'claude_native_auth_config_dir_missing',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'missing_materialized_claude_config_dir',
      }],
    });
  }

  const verified = await verifyClaudeCodeNativeAuthStatus({
    claudeConfigDir,
    now: params.nowMs,
    env: { ...process.env, ...params.materializedEnv },
  });
  if (verified.status === 'ok') {
    const expectedProvenance = buildClaudeConnectedServiceHomeProvenance({
      record,
      selectionDescriptor: buildClaudeSubscriptionNativeAuthSelectionDescriptor({
        fallbackProfileId: selection.kind === 'group' ? selection.fallbackProfileId : selection.profileId,
        selection,
      }),
    });
    const actualProvenance = await readClaudeConnectedServiceHomeProvenance(claudeConfigDir);
    if (matchesClaudeConnectedServiceHomeProvenance(expectedProvenance, actualProvenance)) return;

    throw new ConnectedServiceSpawnMaterializationError({
      agentId: params.agentId,
      diagnostics: [{
        code: 'claude_native_auth_stale_materialized_home',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'stale_materialized_home',
      }],
    });
  }

  throw new ConnectedServiceSpawnMaterializationError({
    agentId: params.agentId,
    diagnostics: [{
      code: `claude_native_auth_${verified.status}`,
      providerId: 'claude',
      serviceId: 'claude-subscription',
      severity: 'blocking',
      reason: verified.status,
    }],
  });
}

export async function resolveConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  sessionDirectory?: string | null;
  connectedServicesBindingsRaw: unknown;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  credentials: Credentials;
  api: ApiClient;
  runtimeQuotaSnapshots?: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore | null;
  quotaFreshnessMs?: number;
  nowMs?: () => number;
  sessionId?: string;
  authGroupSwitchCoordinator?: ConnectedServiceAuthGroupPreTurnSwitchCoordinator | null;
  softSwitchRecoveryGuard?: ConnectedServiceRecoverySoftSwitchGuard | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  credentialRefreshService?: ConnectedServiceSpawnCredentialRefreshService | null;
  /**
   * The vendor `--resume` reference the spawned process will resume from. Required for the §2
   * post-materialization reachability re-verify; null/absent means this is a fresh (non-resume)
   * spawn and the gate is skipped.
   */
  vendorResumeId?: string | null;
  /**
   * Whether shared-state continuity was requested for this spawn. When true (and a `vendorResumeId`
   * is present), the reachability gate runs against the REAL materialized target before the vendor
   * launches; when false the spawn is not continuity-gated (e.g. isolated state).
   */
  resumeReachabilityRequired?: boolean;
  /**
   * A persisted absolute vendor session-file hint, when known. Per D8 this is a fast-path hint only:
   * a stale/cross-machine path that fails to stat must degrade to the id+cwd native search, never
   * hard-fail.
   */
  candidatePersistedSessionFile?: string | null;
}>): Promise<Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  connectedServicesBindings: ConnectedServicesBindingsV1;
  runtimeAccountIdentitySelections: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}> | null> {
  const selections = parseConnectedServiceBindingSelections(params.connectedServicesBindingsRaw);
  if (selections.length === 0) return null;
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const credentialLifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(params.agentId);
  const forceSpawnPreflightOauthRefresh =
    credentialLifecycleDescriptor.spawnPreflightOauthRefresh.mode === 'force';

  const resolvedBindings = await resolveCredentialBindings({
    api: params.api,
    selections,
    runtimeQuotaSnapshots: params.runtimeQuotaSnapshots ?? null,
    quotaFreshnessMs: params.quotaFreshnessMs ?? 5 * 60_000,
    nowMs,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
    softSwitchRecoveryGuard: params.softSwitchRecoveryGuard ?? null,
    predictiveSoftSwitchMode: credentialLifecycleDescriptor.predictiveSoftSwitch.mode,
  });

  const recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1> =
    await resolveConnectedServiceCredentials({
      credentials: params.credentials,
      api: params.api,
      bindings: resolvedBindings.credentialBindings,
    });
  const groupSelections = new Map(resolvedBindings.groupSelections);
  try {
    await assertCredentialHealthAllowsSpawn({
      api: params.api,
      credentialBindings: resolvedBindings.credentialBindings,
    });
    await applySpawnPreflightRefresh({
      recordsByServiceId,
      credentialBindings: resolvedBindings.credentialBindings,
      refreshService: params.credentialRefreshService ?? null,
      nowMs,
      forceOauthRefresh: forceSpawnPreflightOauthRefresh,
    });
  } catch (error) {
    if (!(error instanceof ConnectedServiceSpawnCredentialRefreshError)) throw error;
    const switched = await maybeSwitchGroupAfterSpawnPreflightRefreshFailure({
      error,
      groupSelections,
      recordsByServiceId,
      credentials: params.credentials,
      api: params.api,
      runtimeQuotaSnapshots: params.runtimeQuotaSnapshots ?? null,
      quotaFreshnessMs: params.quotaFreshnessMs ?? 5 * 60_000,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      refreshService: params.credentialRefreshService ?? null,
      nowMs,
      forceOauthRefresh: forceSpawnPreflightOauthRefresh,
    });
    if (!switched) throw error;
  }
  const maxMaterializationAttempts = resolveMaxSpawnMaterializationAttempts(groupSelections);
  for (let attempt = 0; attempt < maxMaterializationAttempts; attempt += 1) {
    let selectionsByServiceId = buildSelectionsByServiceIdForSpawn({
      selections,
      recordsByServiceId,
      groupSelections,
    });
    const adoptedClaudeNativeCredential = await adoptFresherClaudeSubscriptionNativeCredentialForSpawn({
      activeServerDir: params.activeServerDir,
      credentials: params.credentials,
      api: params.api,
      nowMs,
      selectionsByServiceId,
      recordsByServiceId,
    });
    if (adoptedClaudeNativeCredential) {
      selectionsByServiceId = buildSelectionsByServiceIdForSpawn({
        selections,
        recordsByServiceId,
        groupSelections,
      });
    }
    const connectedServicesBindings = buildCanonicalConnectedServicesBindingsForSpawn({
      selections,
      groupSelections,
    });

    try {
      const materialized = await materializeAndVerifyConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        materializationKey: params.materializationKey,
        connectedServiceMaterializationIdentityV1: params.connectedServiceMaterializationIdentityV1 ?? null,
        activeServerDir: params.activeServerDir,
        baseDir: params.baseDir,
        sessionDirectory: params.sessionDirectory ?? null,
        recordsByServiceId,
        selectionsByServiceId,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
        vendorResumeId: params.vendorResumeId ?? null,
        resumeReachabilityRequired: params.resumeReachabilityRequired ?? false,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        nowMs,
      });
      if (materialized === null) return null;
      return {
        ...materialized,
        connectedServicesBindings,
        runtimeAccountIdentitySelections: buildRuntimeAccountIdentitySelectionsForSpawn(selectionsByServiceId),
      };
    } catch (error) {
      if (!(error instanceof ConnectedServiceSpawnMaterializationError)) throw error;
      if (attempt >= maxMaterializationAttempts - 1) throw error;
      const switched = await maybeSwitchGroupAfterSpawnMaterializationFailure({
        error,
        groupSelections,
        recordsByServiceId,
        credentials: params.credentials,
        api: params.api,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
      refreshService: params.credentialRefreshService ?? null,
      nowMs,
      forceOauthRefresh: forceSpawnPreflightOauthRefresh,
    });
      if (!switched) throw error;
    }
  }

  return null;
}

/**
 * The §2 hard post-materialization re-verify gate. Runs ONLY for a resume-continuity spawn — i.e.
 * shared-state continuity was requested AND a vendor resume reference is present. Proves the target
 * the vendor will actually read (from the REAL materialized env) via the central reachability
 * dispatcher; on a genuine miss it fails closed with a concrete structured reason BEFORE the vendor
 * launches, instead of letting the spawned process crash resuming a missing file.
 *
 * A fresh (no-resume) spawn and an isolated (no continuity) spawn are not gated. Per D8 the
 * cross-machine fallback is preserved by the provider probe itself (a stale absolute hint degrades to
 * the id+cwd native search), so this gate only fires when state is genuinely unreachable.
 *
 * When reachability IS required and a resume reference is present but a required gate input (`cwd`) is
 * missing, the gate FAILS CLOSED with `resume_reachability_inputs_missing` rather than silently
 * skipping — a plumbing fault must not be able to disable the hard gate for a continuity resume.
 */
async function assertSpawnResumeReachable(params: Readonly<{
  agentId: CatalogAgentId;
  materializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string | null;
  resumeReachabilityRequired: boolean;
  candidatePersistedSessionFile: string | null;
}>): Promise<void> {
  if (!params.resumeReachabilityRequired) return;
  const vendorResumeId = typeof params.vendorResumeId === 'string' ? params.vendorResumeId.trim() : '';
  // No vendor resume reference => this is a fresh (non-resume) spawn; the continuity gate does not
  // apply (see the `vendorResumeId` param contract). A fresh spawn is never gated.
  if (!vendorResumeId) return;

  // A RESUME is requested and reachability is REQUIRED, but a gate input (cwd) is missing. This is a
  // plumbing fault, not a fresh spawn: returning here would SILENTLY disable the hard gate and let the
  // vendor launch resuming a path we never proved. Fail closed with the structured continuity reason
  // (same taxonomy as a genuine miss) instead of passing.
  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
  if (!cwd) {
    throw new ConnectedServiceSpawnResumeUnreachableError({
      agentId: params.agentId,
      vendorResumeId,
      cwd: '',
      targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
        agentId: params.agentId,
        targetMaterializedEnv: params.materializedEnv,
      }),
      reason: 'resume_reachability_inputs_missing',
    });
  }

  const reachability = await verifySpawnResumeReachability({
    agentId: params.agentId,
    vendorResumeId,
    cwd,
    materializedEnv: params.materializedEnv,
    candidatePersistedSessionFile: params.candidatePersistedSessionFile,
  });
  if (reachability.ok) return;

  throw new ConnectedServiceSpawnResumeUnreachableError({
    agentId: params.agentId,
    vendorResumeId,
    cwd,
    targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
      agentId: params.agentId,
      targetMaterializedEnv: params.materializedEnv,
    }),
    reason: reachability.reason,
  });
}
