import { describe, expect, it } from 'vitest';

import { applySpawnConnectedServicesDefaultsForDaemon } from './applySpawnConnectedServicesDefaultsForDaemon';

describe('applySpawnConnectedServicesDefaultsForDaemon', () => {
  const accountSettings = {
    connectedServicesDefaultAuthByAgentIdV1: {
      v: 1,
      bindingsByAgentId: {
        claude: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile-claude',
            },
          },
        },
      },
    },
  };

  it('applies account connected-service defaults when daemon resume options have no binding', () => {
    expect(applySpawnConnectedServicesDefaultsForDaemon({
      options: {
        directory: '/repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
      agentId: 'claude',
      accountSettings,
      nowMs: 1234,
    })).toMatchObject({
      connectedServicesUpdatedAt: 1234,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile-claude',
          },
        },
      },
    });
  });

  it('preserves explicit native selections instead of forcing account defaults', () => {
    const options = {
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
      connectedServices: {
        v: 1 as const,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'native' as const,
          },
        },
      },
    };

    expect(applySpawnConnectedServicesDefaultsForDaemon({
      options,
      agentId: 'claude',
      accountSettings,
      nowMs: 1234,
    })).toBe(options);
  });
});
