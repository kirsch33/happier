import { describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveProfileEnvironmentVariablesForSpawn } from './resolveProfileEnvironmentVariablesForSpawn';

function makeCredentials(): Credentials {
  return {
    token: 'token-test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

describe('resolveProfileEnvironmentVariablesForSpawn', () => {
  it('rehydrates profile env from account settings while preserving caller overrides', async () => {
    const profile = AIBackendProfileSchema.parse({
      id: 'greatwhiteclaude',
      name: 'Great White Claude',
      envVarRequirements: [],
      environmentVariables: [
        { name: 'IS_SANDBOX', value: '1' },
        { name: 'CUSTOM_TIMEOUT_MS', value: '300000' },
      ],
      compatibilityByTargetKey: { 'agent:claude': true },
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });
    const logDebug = vi.fn();

    const resolved = await resolveProfileEnvironmentVariablesForSpawn({
      options: {
        directory: '/tmp/repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        profileId: ' greatwhiteclaude ',
      },
      providedEnvironmentVariables: {
        CUSTOM_TIMEOUT_MS: '600000',
      },
      credentials: makeCredentials(),
      processEnv: {},
      accountSettings: {
        profiles: [profile],
      },
      logDebug,
    });

    expect(resolved).toEqual({
      IS_SANDBOX: '1',
      CUSTOM_TIMEOUT_MS: '600000',
    });
    expect(logDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Rehydrated profile environment for greatwhiteclaude (1 added keys)',
    );
  });
});
