import { AGENTS_CORE } from '@happier-dev/agents';
import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import { checklists } from './cli/checklists';
import { supportsCodexVendorResume } from './resume/vendorResumeSupport';
import { codexConnectedServiceStateSharingDescriptor } from '@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor';
import { createCodexConnectedServiceRuntimeAuthAdapter } from '@/backends/codex/connectedServices/createCodexConnectedServiceRuntimeAuthAdapter';
import { createCodexConnectedServicesMaterializer } from '@/backends/codex/connectedServices/createCodexConnectedServicesMaterializer';
import { materializeCodexConnectedServiceRuntimeAuthSelection } from '@/backends/codex/connectedServices/materializeCodexConnectedServiceRuntimeAuthSelection';
import { resolveCodexConnectedServiceSwitchContinuity } from '@/backends/codex/connectedServices/resolveCodexConnectedServiceSwitchContinuity';
import { codexDaemonSpawnHooks } from '@/backends/codex/daemon/spawnHooks';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';
import { codexAppServerCatalogControlAdapter } from '@/backends/codex/appServer/catalogControl/codexAppServerCatalogControlAdapter';
import { codexAppServerGoalControlAdapter } from '@/backends/codex/appServer/goalControl/codexAppServerGoalControlAdapter';
import { codexAppServerUsageLimitRecoveryControlAdapter } from '@/backends/codex/appServer/usageLimitRecoveryControl/codexAppServerUsageLimitRecoveryControlAdapter';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const codexConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'codex',
  serviceIds: AGENTS_CORE.codex.connectedServices.supportedServiceIds,
  refreshTokenRuntimeHandling: 'daemon_only',
  refreshedCredentialApplication: { mode: 'restart_required' },
  runtimeAuthFailureClassifier: { available: true },
};

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/codex/cli/command')).handleCodexCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/codex/cli/capability')).cliCapability,
  getCapabilities: async () => (await import('@/backends/codex/cli/extraCapabilities')).capabilities,
  getCliDetect: async () => (await import('@/backends/codex/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/codex/cli/auth/codexCliAuthSpec')).codexCliAuthSpec,
  getCloudConnectTarget: async () => (await import('@/backends/codex/cloud/connect')).codexCloudConnect,
  getDaemonSpawnHooks: async () => codexDaemonSpawnHooks,
  getConnectedServiceMaterializer: async () => createCodexConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => codexConnectedServiceStateSharingDescriptor,
  getConnectedServiceRuntimeAuthAdapter: async () => createCodexConnectedServiceRuntimeAuthAdapter(),
  materializeConnectedServiceRuntimeAuthSelection: materializeCodexConnectedServiceRuntimeAuthSelection,
  getConnectedServiceCredentialLifecycleDescriptor: async () => codexConnectedServiceCredentialLifecycleDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolveCodexConnectedServiceSwitchContinuity(params),
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/codex/connectedServices/verifyResumeReachableCodex')).verifyResumeReachableCodex(input),
  getDirectSessionProviderOps: async () => (await import('@/backends/codex/directSessions/providerOps')).codexDirectSessionProviderOps,
  getSessionGoalControlAdapter: async () => codexAppServerGoalControlAdapter,
  getSessionCatalogControlAdapter: async () => codexAppServerCatalogControlAdapter,
  getSessionUsageLimitRecoveryControlAdapter: async () => codexAppServerUsageLimitRecoveryControlAdapter,
  sessionGoalRuntimeKind: ({ codexBackendMode }) => codexBackendMode === 'appServer' ? 'native' : 'none',
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
  getVendorResumeSupport: async () => supportsCodexVendorResume,
  getAcpBackendFactory: async () => {
    const { createCodexAcpBackend } = await import('@/backends/codex/acp/backend');
    return (opts) => createCodexAcpBackend(opts as any);
  },
  getAcpForkContinuationHandler: async () => (await import('@/backends/codex/acp/forkContinuationHandler')).codexAcpForkContinuationHandler,
  getProviderNativeForkHandler: async () => (await import('@/backends/codex/appServer/providerNativeForkHandler')).codexAppServerProviderNativeForkHandler,
  needsAccountSettingsForProbes: true,
  resolveModelsProbeVariant: ({ accountSettings }) => {
    // Keep dynamic model probes cache-partitioned by runtime flavor (appServer vs ACP vs MCP).
    const backendMode =
      resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'appServer';
    // Speed eligibility is auth-dependent; include auth method to avoid stale modelOptions.
    const authMethod = readCodexEnvironmentAuthState().method ?? 'unknown';
    return `codex:${backendMode}:${authMethod}`;
  },
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/codex/preflight/codexPreflightSessionControlsProbeAdapter')).codexPreflightSessionControlsProbeAdapter,
  checklists,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.CODEX_ACP],
} satisfies AgentCatalogEntry;
