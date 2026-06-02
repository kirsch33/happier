import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { resolveRespawnSessionRuntimeSnapshot } from './resolveRespawnSessionRuntimeSnapshot';

const persistedConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'profile',
      profileId: 'persisted-codex-profile',
    },
  },
} as const;

const persistedMaterializationIdentity = {
  v: 1,
  id: 'csm_respawn_snapshot_1',
  createdAtMs: 123,
} as const;

function defaultRespawnOptions(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    directory: '/tmp/repo',
    existingSessionId: 'session-1',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    approvedNewDirectoryCreation: true,
    ...overrides,
  };
}

function credentials(token: string): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

describe('resolveRespawnSessionRuntimeSnapshot', () => {
  it('applies the persisted runtime snapshot before respawning a tracked session', async () => {
    const readCredentials = vi.fn(async () => credentials('fresh-token'));
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: { v: 2 as const, encryptionMode: 'plain' as const },
      vendorResumeId: 'persisted-vendor-resume',
      sessionPath: '/tmp/repo',
      metadata: {
        connectedServices: persistedConnectedServices,
        connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
        connectedServicesUpdatedAt: 700,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 710,
        sessionModeOverrideV1: { v: 1, modeId: 'build', updatedAt: 720 },
        modelOverrideV1: { v: 1, modelId: 'gpt-5.3-codex', updatedAt: 730 },
      },
    }));

    const trackedSpawnOptions = defaultRespawnOptions({
      permissionMode: 'default',
      permissionModeUpdatedAt: 100,
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 100,
      resume: 'stale-vendor-resume',
    });

    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: trackedSpawnOptions,
      vendorResumeId: 'tracked-vendor-resume',
      defaultOptions: defaultRespawnOptions({
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 100,
        resume: 'stale-vendor-resume',
      }),
      credentials: credentials('stale-token'),
      readCredentials,
      resolveAttachContext,
    });

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(resolveAttachContext).toHaveBeenCalledWith(expect.objectContaining({
      token: 'fresh-token',
      sessionId: 'session-1',
      agent: 'codex',
    }));
    expect(result).toMatchObject({
      connectedServices: persistedConnectedServices,
      connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
      connectedServicesUpdatedAt: 700,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 710,
      agentModeId: 'build',
      agentModeUpdatedAt: 720,
      modelId: 'gpt-5.3-codex',
      modelUpdatedAt: 730,
      resume: 'stale-vendor-resume',
    });
  });

  it('derives respawn initialGoal from fresh persisted active Codex app-server work state', async () => {
    const readCredentials = vi.fn(async () => credentials('fresh-token'));
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: { v: 2 as const, encryptionMode: 'plain' as const },
      vendorResumeId: 'thread-active-goal',
      sessionPath: '/tmp/repo',
      metadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'codex',
          updatedAt: 800,
          primaryItemId: 'goal:thread-active-goal',
          items: [
            {
              id: 'goal:thread-active-goal',
              kind: 'goal',
              origin: 'vendor',
              status: 'active',
              title: 'Continue after runtime restart',
              tokenBudget: 5000,
              updatedAt: 800,
            },
          ],
        },
      },
    }));

    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: defaultRespawnOptions({
        codexBackendMode: 'appServer',
        resume: 'thread-active-goal',
      }),
      vendorResumeId: 'thread-active-goal',
      defaultOptions: defaultRespawnOptions({
        codexBackendMode: 'appServer',
        resume: 'thread-active-goal',
      }),
      credentials: credentials('stale-token'),
      readCredentials,
      resolveAttachContext,
    });

    expect(result).toMatchObject({
      initialGoal: {
        objective: 'Continue after runtime restart',
        status: 'active',
        tokenBudget: 5000,
      },
      resume: 'thread-active-goal',
    });
  });

  it('derives respawn initialGoal from fresh persisted active Claude prompt-autonomy work state', async () => {
    const readCredentials = vi.fn(async () => credentials('fresh-token'));
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: { v: 2 as const, encryptionMode: 'plain' as const },
      vendorResumeId: 'claude-vendor-session',
      sessionPath: '/tmp/repo',
      metadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'claude',
          agentId: 'claude',
          updatedAt: 800,
          primaryItemId: 'goal:claude-vendor-session',
          items: [
            {
              id: 'goal:claude-vendor-session',
              kind: 'goal',
              origin: 'happier',
              status: 'active',
              title: 'Continue Claude Overwatch after runtime restart',
              tokenBudget: 5000,
              updatedAt: 800,
            },
          ],
        },
      },
    }));

    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: defaultRespawnOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-vendor-session',
      }),
      vendorResumeId: 'claude-vendor-session',
      defaultOptions: defaultRespawnOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-vendor-session',
      }),
      credentials: credentials('stale-token'),
      readCredentials,
      resolveAttachContext,
    });

    expect(result).toMatchObject({
      initialGoal: {
        objective: 'Continue Claude Overwatch after runtime restart',
        status: 'active',
        tokenBudget: 5000,
      },
      resume: 'claude-vendor-session',
    });
  });

  it('falls back to default respawn options when persisted metadata cannot be loaded', async () => {
    const defaultOptions = defaultRespawnOptions({ resume: 'vendor-resume' });
    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: defaultOptions,
      vendorResumeId: 'vendor-resume',
      defaultOptions,
      credentials: credentials('token'),
      readCredentials: async () => null,
      resolveAttachContext: async () => ({ ok: false as const, reason: 'missingToken' }),
    });

    expect(result).toBe(defaultOptions);
  });
});
