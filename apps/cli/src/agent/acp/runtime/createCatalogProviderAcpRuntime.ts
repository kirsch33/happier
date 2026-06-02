import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { createSessionMediaAccessPolicy } from '@/session/sessionMedia/createSessionMediaAccessPolicy';
import { getProviderCliRuntimeSpec, isAgentMediaCapabilitySupported } from '@happier-dev/agents';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { resolveHappierRuntimeContextEnvFromConfiguration } from '@/utils/env/resolveHappierRuntimeContextEnvFromConfiguration';

type CatalogAcpProviderRuntimeParams<TBackendOptions extends object> = {
  provider: Parameters<typeof createCatalogAcpBackend>[0];
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  backendOptions?: Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode' | 'happierSessionId'>;
  getPermissionMode?: () => PermissionMode | null | undefined;
  resolvePermissionMode?: (args: {
    getPermissionMode?: () => PermissionMode | null | undefined;
    session: ApiSessionClient;
  }) => PermissionMode | null | undefined;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
  resolveSessionModelConfigUpdate?: Parameters<typeof createAcpRuntime>[0]['resolveSessionModelConfigUpdate'];
  deriveSessionModelsFromConfigOptions?: Parameters<typeof createAcpRuntime>[0]['deriveSessionModelsFromConfigOptions'];
  resolveSessionConfigOptionUpdate?: Parameters<typeof createAcpRuntime>[0]['resolveSessionConfigOptionUpdate'];
  startupOverrides?: Parameters<typeof createAcpRuntime>[0]['startupOverrides'];
};

export function createCatalogProviderAcpRuntime<TBackendOptions extends object = Record<string, never>>(
  params: CatalogAcpProviderRuntimeParams<TBackendOptions>,
) {
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        sessionTitle: getSessionNotificationTitle(params.session.getMetadataSnapshot?.bind(params.session)) ?? params.session.sessionId,
        agentDisplayName: getProviderCliRuntimeSpec(params.provider).title,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
        permissionMode: params.getPermissionMode?.(),
      });
    } catch {
      // best-effort
    }
  };
  const hooks = params.hooks
    ? {
        ...params.hooks,
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          try {
            params.hooks?.onPermissionRequest?.(evt);
          } catch {
            // ignore
          }
          sendPermissionPush(evt);
        },
      }
    : {
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          sendPermissionPush(evt);
        },
      };
  const shouldPersistSessionMedia =
    process.env.HAPPIER_TRANSCRIPT_STORAGE !== 'direct' &&
    isAgentMediaCapabilitySupported(params.provider, 'emitsSessionMedia');

  return createAcpRuntime({
    provider: params.provider,
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    hooks,
    inFlightSteer: params.inFlightSteer,
    memoryRecallGuidance: params.memoryRecallGuidance,
    resolveSessionModelConfigUpdate: params.resolveSessionModelConfigUpdate,
    deriveSessionModelsFromConfigOptions: params.deriveSessionModelsFromConfigOptions,
    resolveSessionConfigOptionUpdate: params.resolveSessionConfigOptionUpdate,
    startupOverrides: params.startupOverrides,
    pendingQueue: {
      drainAfterStartOrLoad: true,
      waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
      inputConsumer: createSessionProviderPendingDrainAdapter(params.session),
    },
    ...(shouldPersistSessionMedia
      ? {
          sessionMedia: createAgentSessionMediaPersister({
            workingDirectory: params.directory,
            sessionId: params.session.sessionId,
            accessPolicy: createSessionMediaAccessPolicy({
              workingDirectory: params.directory,
            }),
          }),
        }
      : {}),
    ensureBackend: async () => {
      const permissionModeRaw = params.resolvePermissionMode
        ? params.resolvePermissionMode({
            getPermissionMode: params.getPermissionMode,
            session: params.session,
          })
        : params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;
      const backendOptions = (params.backendOptions ?? {}) as Omit<
        TBackendOptions,
        'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode' | 'happierSessionId'
      > & { env?: NodeJS.ProcessEnv };
      const backendEnv = {
        ...(backendOptions.env ?? {}),
        ...resolveHappierRuntimeContextEnvFromConfiguration(),
      };

      const created = await createCatalogAcpBackend<TBackendOptions>(params.provider, {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        ...backendOptions,
        env: backendEnv,
        permissionHandler: params.permissionHandler,
        permissionMode,
        happierSessionId: params.session.sessionId,
      } as unknown as TBackendOptions);

      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created.backend as unknown as AgentBackend;
    },
    onSessionIdChange: params.onSessionIdChange,
  });
}
