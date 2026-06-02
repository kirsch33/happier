import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { assertClaudeStackScopedRuntimeAuth } from './assertClaudeStackScopedRuntimeAuth';

const tempDirs = new Set<string>();

async function createTempClaudeConfigDir(): Promise<string> {
  const root = await createTempDir('happier-claude-stack-auth-');
  tempDirs.add(root);
  const claudeConfigDir = join(root, '.claude');
  await mkdir(claudeConfigDir, { recursive: true });
  return claudeConfigDir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('assertClaudeStackScopedRuntimeAuth', () => {
  it('fails closed when ambient live auth is the only auth for a stack-scoped Claude config', async () => {
    const claudeConfigDir = await createTempClaudeConfigDir();

    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          ANTHROPIC_API_KEY: 'ambient-live-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-live-token',
        },
        childEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          ANTHROPIC_API_KEY: 'ambient-live-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-live-token',
        },
      }),
    ).toThrow(/stack-scoped Claude auth/i);
  });

  it('fails closed when a stack-scoped launch would otherwise fall back to the live Claude home', () => {
    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
        },
        childEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
        },
      }),
    ).toThrow(/CLAUDE_CONFIG_DIR/i);
  });

  it('allows a valid credentials file inside the stack-scoped Claude config', async () => {
    const claudeConfigDir = await createTempClaudeConfigDir();
    await writeFile(
      join(claudeConfigDir, '.claude.json'),
      JSON.stringify({ accessToken: 'scoped-token', expiresAt: '2999-01-01T00:00:00.000Z' }),
      'utf8',
    );

    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
        },
        childEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          CLAUDE_CONFIG_DIR: claudeConfigDir,
        },
      }),
    ).not.toThrow();
  });

  it('allows Claude Code OAuth credentials copied into the stack-scoped config', async () => {
    const claudeConfigDir = await createTempClaudeConfigDir();
    await writeFile(
      join(claudeConfigDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'scoped-token',
          refreshToken: 'scoped-refresh',
          expiresAt: Date.now() + 60_000,
        },
      }),
      'utf8',
    );

    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
        },
        childEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          CLAUDE_CONFIG_DIR: claudeConfigDir,
        },
      }),
    ).not.toThrow();
  });

  it('allows connected-service materialized Claude auth for a stack-scoped launch', async () => {
    const claudeConfigDir = await createTempClaudeConfigDir();
    const connectedSelection = JSON.stringify([
      { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
    ]);
    const materializedKeys = JSON.stringify(['CLAUDE_CODE_OAUTH_TOKEN']);

    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedSelection,
          [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: materializedKeys,
        },
        childEnv: {
          HAPPIER_STACK_STACK: 'throwaway-auth-proof',
          HAPPIER_STACK_ENV_FILE: '/tmp/stacks/throwaway-auth-proof/env',
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedSelection,
          [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: materializedKeys,
          CLAUDE_CODE_OAUTH_TOKEN: 'materialized-token',
        },
      }),
    ).not.toThrow();
  });

  it('does not require scoped auth for non-stack Claude launches', async () => {
    const claudeConfigDir = await createTempClaudeConfigDir();

    expect(() =>
      assertClaudeStackScopedRuntimeAuth({
        runnerEnv: {},
        childEnv: {
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          ANTHROPIC_API_KEY: 'native-key',
        },
      }),
    ).not.toThrow();
  });
});
