import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { ConnectedServiceBindingsV1Schema, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function hasExplicitConnectedServicesSelection(raw: unknown): boolean {
  return ConnectedServiceBindingsV1Schema.safeParse(raw).success;
}

export function applySpawnConnectedServicesDefaultsForDaemon(params: Readonly<{
  options: SpawnSessionOptions;
  agentId: string;
  accountSettings: unknown;
  nowMs?: number;
}>): SpawnSessionOptions {
  if (hasExplicitConnectedServicesSelection(params.options.connectedServices)) {
    return params.options;
  }
  if (!isAgentId(params.agentId)) {
    return params.options;
  }

  const connectedServices = resolveSpawnConnectedServicesDefaults({
    accountSettings: params.accountSettings,
    agentId: params.agentId,
  });
  if (!connectedServices) {
    return params.options;
  }

  return {
    ...params.options,
    connectedServices: connectedServices as ConnectedServiceBindingsV1,
    connectedServicesUpdatedAt: params.nowMs ?? Date.now(),
  };
}
