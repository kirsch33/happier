import { AGENTS_CORE } from '@happier-dev/agents';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from '@/backends/claude/connectedServices/createClaudeConnectedServiceRuntimeAuthAdapter';
import { createClaudeConnectedServicesMaterializer } from '@/backends/claude/connectedServices/createClaudeConnectedServicesMaterializer';
import { claudeUsageLimitRecoveryControlAdapter } from '@/backends/claude/connectedServices/claudeUsageLimitRecoveryControlAdapter';
import { claudeConnectedServiceStateSharingDescriptor } from '@/backends/claude/connectedServices/claudeConnectedServiceStateSharingDescriptor';
import { resolveClaudeConnectedServiceSwitchContinuity } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceSwitchContinuity';
import { claudeDaemonSpawnHooks } from '@/backends/claude/daemon/spawnHooks';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const claudeConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'claude',
  serviceIds: AGENTS_CORE.claude.connectedServices.supportedServiceIds,
  refreshTokenRuntimeHandling: 'daemon_only',
  refreshedCredentialApplication: { mode: 'restart_required' },
  runtimeAuthFailureClassifier: { available: true },
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
  getConnectedServiceCredentialLifecycleDescriptor: async () => claudeConnectedServiceCredentialLifecycleDescriptor,
  getConnectedServiceStateSharingDescriptor: async () => claudeConnectedServiceStateSharingDescriptor,
  getSessionUsageLimitRecoveryControlAdapter: async () => claudeUsageLimitRecoveryControlAdapter,
  sessionGoalRuntimeKind: 'happier-prompt-autonomy',
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveClaudeConnectedServiceSwitchContinuity(params),
  // Claude's underlying probe takes a `{ vendorResumeId, processEnv }` shape rather than the
  // normalized `VerifyResumeReachableInput`. Adapt here (behavior-preserving: same mapping the
  // former central dispatcher applied — the materialized target env is the process env Claude reads).
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/claude/connectedServices/verifyResumeReachableClaude')).verifyResumeReachableClaude({
      vendorResumeId: input.vendorResumeId,
      processEnv: input.targetMaterializedEnv as NodeJS.ProcessEnv,
    }),
  getDirectSessionProviderOps: async () => (await import('@/backends/claude/directSessions/providerOps')).claudeDirectSessionProviderOps,
  vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () => (await import('@/backends/claude/preflight/claudePreflightModelsProbeAdapter')).claudePreflightModelsProbeAdapter,
  getHeadlessTmuxArgvTransform: async () => (await import('@/terminal/tmux/headlessTmuxArgs')).ensureRemoteStartingModeArgs,
} satisfies AgentCatalogEntry;
