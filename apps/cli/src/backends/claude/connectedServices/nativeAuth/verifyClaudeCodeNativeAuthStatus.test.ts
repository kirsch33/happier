import { describe, expect, it, vi } from 'vitest';

import { verifyClaudeCodeNativeAuthStatus } from './verifyClaudeCodeNativeAuthStatus';

describe('verifyClaudeCodeNativeAuthStatus', () => {
  it('accepts structurally valid native credentials when Claude auth status is logged in', async () => {
    const result = await verifyClaudeCodeNativeAuthStatus({
      claudeConfigDir: '/tmp/claude-config',
      deps: {
        verifyStructuralAuth: vi.fn(async () => ({
          status: 'ok' as const,
          missingScopes: [],
          credentialPath: '/tmp/claude-config/.credentials.json',
        })),
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        execFile: vi.fn(async () => ({
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty' }),
          stderr: '',
        })),
      },
    });

    expect(result).toMatchObject({
      status: 'ok',
      credentialPath: '/tmp/claude-config/.credentials.json',
    });
  });

  it('fails structurally valid native credentials when Claude auth status is logged out', async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
      stderr: '',
    }));

    const result = await verifyClaudeCodeNativeAuthStatus({
      claudeConfigDir: '/tmp/claude-config',
      deps: {
        verifyStructuralAuth: vi.fn(async () => ({
          status: 'ok' as const,
          missingScopes: [],
          credentialPath: '/tmp/claude-config/.credentials.json',
        })),
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        execFile,
      },
    });

    expect(execFile).toHaveBeenCalledWith('/usr/local/bin/claude', ['auth', 'status'], expect.objectContaining({
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' }),
    }));
    expect(result).toMatchObject({
      status: 'native_cli_logged_out',
      credentialPath: '/tmp/claude-config/.credentials.json',
    });
  });

  it('fails closed when Claude CLI auth status cannot be resolved', async () => {
    const result = await verifyClaudeCodeNativeAuthStatus({
      claudeConfigDir: '/tmp/claude-config',
      deps: {
        verifyStructuralAuth: vi.fn(async () => ({
          status: 'ok' as const,
          missingScopes: [],
          credentialPath: '/tmp/claude-config/.credentials.json',
        })),
        resolveClaudeCliPath: () => {
          throw new ReferenceError('Claude CLI not found');
        },
        execFile: vi.fn(async () => ({
          stdout: '',
          stderr: '',
        })),
      },
    });

    expect(result).toMatchObject({
      status: 'native_cli_status_unavailable',
      credentialPath: '/tmp/claude-config/.credentials.json',
      stderrPreview: 'Claude CLI not found',
    });
  });
});
