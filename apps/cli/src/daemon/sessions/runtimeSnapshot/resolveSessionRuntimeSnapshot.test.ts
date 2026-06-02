import { describe, expect, it } from 'vitest';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const persistedConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'persisted-profile',
    },
  },
} as const;

const incomingConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'incoming-profile',
    },
  },
} as const;

const materializationIdentity = {
  v: 1,
  id: 'csm_persisted_1',
  createdAtMs: 10,
} as const;

function baseIncomingOptions(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    directory: '/tmp/repo',
    existingSessionId: 'session-1',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    ...overrides,
  };
}

describe('resolveSessionRuntimeSnapshot', () => {
  it('restores persisted session runtime controls when incoming resume options omit them', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 220 },
      },
      persistedVendorResumeId: 'vendor-persisted',
    });

    expect(result.snapshot).toEqual({
      sessionId: 'session-1',
      connectedServices: persistedConnectedServices,
      connectedServicesUpdatedAt: null,
      connectedServiceMaterializationIdentityV1: null,
      permissionMode: { value: 'yolo', updatedAt: 200 },
      agentModeId: { value: 'plan', updatedAt: 210 },
      modelId: { value: 'claude-opus-4-7', updatedAt: 220 },
      initialGoal: null,
      vendorResumeId: { value: 'vendor-persisted', updatedAt: null },
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 200,
      agentModeId: 'plan',
      agentModeUpdatedAt: 210,
      modelId: 'claude-opus-4-7',
      modelUpdatedAt: 220,
      resume: 'vendor-persisted',
    });
  });

  it('keeps newer persisted metadata over stale incoming defaults', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: { v: 1, bindingsByServiceId: {} },
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        agentModeId: 'default',
        agentModeUpdatedAt: 100,
        modelId: 'old-model',
        modelUpdatedAt: 100,
        resume: 'incoming-resume',
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'build', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'new-model', updatedAt: 220 },
      },
      persistedVendorResumeId: 'persisted-resume',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 200,
      agentModeId: 'build',
      agentModeUpdatedAt: 210,
      modelId: 'new-model',
      modelUpdatedAt: 220,
      resume: 'incoming-resume',
    });
  });

  it('keeps explicit newer incoming runtime controls over persisted metadata', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: incomingConnectedServices,
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 300,
        agentModeId: 'review',
        agentModeUpdatedAt: 310,
        modelId: 'incoming-model',
        modelUpdatedAt: 320,
        resume: 'incoming-resume',
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'persisted-model', updatedAt: 220 },
      },
      persistedVendorResumeId: 'persisted-resume',
    });

    expect(result.snapshot).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: { value: 'read-only', updatedAt: 300 },
      agentModeId: { value: 'review', updatedAt: 310 },
      modelId: { value: 'incoming-model', updatedAt: 320 },
      vendorResumeId: { value: 'incoming-resume', updatedAt: null },
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 300,
      agentModeId: 'review',
      agentModeUpdatedAt: 310,
      modelId: 'incoming-model',
      modelUpdatedAt: 320,
      resume: 'incoming-resume',
    });
  });

  it('lets a newer explicit incoming native connected-service selection clear an older persisted binding', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 500,
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 100,
      },
    });

    expect(result.snapshot.connectedServices).toEqual({ v: 1, bindingsByServiceId: {} });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 500,
    });
  });

  it('keeps newer persisted connected-service bindings over stale tracked bindings', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 500,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        connectedServicesUpdatedAt: 100,
      },
    });

    expect(result.snapshot.connectedServices).toEqual(persistedConnectedServices);
    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      connectedServicesUpdatedAt: 500,
    });
  });

  it('uses tracked spawn controls when they are newer than persisted metadata and incoming options omit them', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 100 },
        modelOverrideV1: { v: 1, modelId: 'persisted-model', updatedAt: 100 },
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 400,
        agentModeId: 'tracked-mode',
        agentModeUpdatedAt: 410,
        modelId: 'tracked-model',
        modelUpdatedAt: 420,
      },
      trackedVendorResumeId: 'tracked-resume',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 400,
      agentModeId: 'tracked-mode',
      agentModeUpdatedAt: 410,
      modelId: 'tracked-model',
      modelUpdatedAt: 420,
      resume: 'tracked-resume',
    });
  });

  it('preserves incoming controls without timestamps when no persisted or tracked snapshot exists', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        existingSessionId: undefined,
        permissionMode: 'default',
        agentModeId: 'plan',
        modelId: 'new-session-model',
        connectedServices: incomingConnectedServices,
      }),
    });

    expect(result.snapshot).toMatchObject({
      sessionId: null,
      connectedServices: incomingConnectedServices,
      connectedServicesUpdatedAt: null,
      permissionMode: null,
      agentModeId: null,
      modelId: null,
      vendorResumeId: null,
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'default',
      agentModeId: 'plan',
      modelId: 'new-session-model',
    });
  });

  it('carries stable connected-service materialization identity from persisted metadata into resume spawn options', () => {
    const trackedIdentity = {
      v: 1,
      id: 'csm_tracked_1',
      createdAtMs: 9,
    } as const;
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        connectedServiceMaterializationIdentityV1: trackedIdentity,
      } as SpawnSessionOptions & {
        connectedServiceMaterializationIdentityV1: typeof trackedIdentity;
      },
    });

    expect((result.snapshot as { connectedServiceMaterializationIdentityV1?: unknown }).connectedServiceMaterializationIdentityV1)
      .toEqual(materializationIdentity);
    expect((result.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown }).connectedServiceMaterializationIdentityV1)
      .toEqual(materializationIdentity);
  });

  it('rebuilds the active persisted Codex app-server goal as an initial resume goal', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        resume: 'thread-1',
      }),
      persistedMetadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'codex',
          agentId: 'codex',
          updatedAt: 500,
          primaryItemId: 'goal:thread-1',
          items: [
            {
              id: 'goal:thread-1',
              kind: 'goal',
              origin: 'vendor',
              backendId: 'codex',
              vendorRef: 'thread-1',
              status: 'active',
              title: 'Keep working after daemon restart',
              tokenBudget: 1200,
              updatedAt: 500,
            },
          ],
        },
      },
    });

    expect(result.spawnOptions.initialGoal).toEqual({
      objective: 'Keep working after daemon restart',
      status: 'active',
      tokenBudget: 1200,
    });
  });

  it('rebuilds the active persisted Claude goal as an initial resume goal for prompt autonomy', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-session-1',
      }),
      persistedMetadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'claude',
          agentId: 'claude',
          updatedAt: 500,
          primaryItemId: 'goal:claude-session-1',
          items: [
            {
              id: 'goal:claude-session-1',
              kind: 'goal',
              origin: 'happier',
              backendId: 'claude',
              vendorRef: 'claude-session-1',
              status: 'active',
              title: 'Keep Overwatch driving after restart',
              tokenBudget: 2400,
              updatedAt: 500,
            },
          ],
        },
      },
    });

    expect(result.spawnOptions.initialGoal).toEqual({
      objective: 'Keep Overwatch driving after restart',
      status: 'active',
      tokenBudget: 2400,
    });
  });

  it('does not rebuild paused persisted Codex app-server goals as initial resume goals', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        resume: 'thread-1',
      }),
      persistedMetadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'codex',
          updatedAt: 500,
          items: [
            {
              id: 'goal:thread-1',
              kind: 'goal',
              origin: 'vendor',
              status: 'paused',
              title: 'Paused goal',
              updatedAt: 500,
            },
          ],
        },
      },
    });

    expect(result.spawnOptions.initialGoal).toBeUndefined();
    expect(result.snapshot.initialGoal).toBeNull();
  });

  it.each(['paused', 'complete', 'blocked', 'cancelled'] as const)(
    'does not rebuild %s persisted Claude prompt-autonomy goals as initial resume goals',
    (status) => {
      const result = resolveSessionRuntimeSnapshot({
        incomingOptions: baseIncomingOptions({
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resume: 'claude-session-1',
        }),
        persistedMetadata: {
          sessionWorkStateV1: {
            v: 1,
            backendId: 'claude',
            updatedAt: 500,
            items: [
              {
                id: 'goal:claude-session-1',
                kind: 'goal',
                origin: 'happier',
                status,
                title: 'Nonactive goal',
                updatedAt: 500,
              },
            ],
          },
        },
      });

      expect(result.spawnOptions.initialGoal).toBeUndefined();
      expect(result.snapshot.initialGoal).toBeNull();
    },
  );

  it('keeps incoming one-shot initial goals over persisted active goals', () => {
    const incomingInitialGoal = {
      objective: 'Use the direct spawn goal',
      status: 'active' as const,
      tokenBudget: 42,
    };
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-session-1',
        initialGoal: incomingInitialGoal,
      }),
      persistedMetadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'claude',
          updatedAt: 500,
          items: [
            {
              id: 'goal:claude-session-1',
              kind: 'goal',
              origin: 'happier',
              status: 'active',
              title: 'Persisted goal should not win',
              updatedAt: 500,
            },
          ],
        },
      },
    });

    expect(result.spawnOptions.initialGoal).toEqual(incomingInitialGoal);
    expect(result.snapshot.initialGoal).toEqual(incomingInitialGoal);
  });
});
