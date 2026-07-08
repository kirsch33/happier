import { AGENTS_CORE } from '@happier-dev/agents';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from '@/backends/claude/connectedServices/createClaudeConnectedServiceRuntimeAuthAdapter';
import { createClaudeConnectedServicesMaterializer } from '@/backends/claude/connectedServices/createClaudeConnectedServicesMaterializer';
import { claudeUsageLimitRecoveryControlAdapter } from '@/backends/claude/connectedServices/claudeUsageLimitRecoveryControlAdapter';
import { claudeConnectedServiceStateSharingDescriptor } from '@/backends/claude/connectedServices/claudeConnectedServiceStateSharingDescriptor';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from '@/backends/claude/connectedServices/materializeClaudeConnectedServiceRuntimeAuthSelection';
import { resolveClaudeConnectedServiceSwitchContinuity } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceSwitchContinuity';
import { resolveClaudeConnectedServiceCandidatePersistedSessionFile } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceCandidatePersistedSessionFile';
import { claudeDaemonSpawnHooks } from '@/backends/claude/daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const claudeConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'claude',
  serviceIds: AGENTS_CORE.claude.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'force' },
  refreshedCredentialApplication: { mode: 'no_restart_required' },
  predictiveSoftSwitch: { mode: 'unsupported', liveSessionRequirement: { kind: 'none' } },
  sameAccountFanoutStrategy: 'shared_group_auth_surface',
  runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
};

export const agent = {
  id: AGENTS_CORE.claude.id,
  cliSubcommand: AGENTS_CORE.claude.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/claude/cli/command')).handleClaudeCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/claude/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/claude/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/claude/cli/auth/claudeCliAuthSpec')).claudeCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/claude/cloud/connect')).claudeCloudConnect,
  getDaemonSpawnHooks: async () => claudeDaemonSpawnHooks,
  getConnectedServiceMaterializer: async () => createClaudeConnectedServicesMaterializer(),
  getConnectedServiceRuntimeAuthAdapter: async () => createClaudeConnectedServiceRuntimeAuthAdapter(),
  materializeConnectedServiceRuntimeAuthSelection: materializeClaudeConnectedServiceRuntimeAuthSelection,
  getConnectedServiceCredentialLifecycleDescriptor: async () => claudeConnectedServiceCredentialLifecycleDescriptor,
  getConnectedServiceStateSharingDescriptor: async () => claudeConnectedServiceStateSharingDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => claudeUsageLimitRecoveryControlAdapter,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveClaudeConnectedServiceSwitchContinuity(params),
  resolveConnectedServiceCandidatePersistedSessionFile: (input) =>
    resolveClaudeConnectedServiceCandidatePersistedSessionFile(input),
  // Claude's underlying probe takes a `{ vendorResumeId, processEnv, ... }` shape rather than the
  // normalized `VerifyResumeReachableInput`. Adapt here — the materialized target env is the
  // process env Claude reads; the persisted candidate hint and the §2 strict flag pass through
  // (RD-MAT-5: the probe consults the candidate file the switch WILL import, except target-strict).
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/claude/connectedServices/verifyResumeReachableClaude')).verifyResumeReachableClaude({
      vendorResumeId: input.vendorResumeId,
      processEnv: input.targetMaterializedEnv as NodeJS.ProcessEnv,
      candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
      targetStrict: input.targetStrict === true,
    }),
  getDirectSessionProviderOps: async () => (await import('@/backends/claude/directSessions/providerOps')).claudeDirectSessionProviderOps,
  vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () => (await import('@/backends/claude/preflight/claudePreflightModelsProbeAdapter')).claudePreflightModelsProbeAdapter,
  getHeadlessTmuxArgvTransform: async () => (await import('@/backends/claude/startup/headlessTmuxArgs')).ensureClaudeHeadlessTmuxStartingModeArgs,
} satisfies AgentCatalogEntry;
