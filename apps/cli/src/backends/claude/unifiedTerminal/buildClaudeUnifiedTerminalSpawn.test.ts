import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import {
  buildClaudeUnifiedTerminalSpawn,
  ClaudeUnifiedTerminalRootBypassRequiresSandboxError,
  type ClaudeUnifiedTerminalSpawn,
} from './buildClaudeUnifiedTerminalSpawn';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalIsSandbox = process.env.IS_SANDBOX;

type TerminalLaunchSpecFixture = Readonly<{
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envPassthroughKeys?: string[];
}>;

async function withPatchedEnv<T>(
  patch: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function patchProcessPlatform(platform: NodeJS.Platform): void {
  if (!originalPlatformDescriptor) {
    throw new Error('process.platform descriptor unavailable');
  }
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
}

async function readLaunchSpecFromSpawn(spawn: ClaudeUnifiedTerminalSpawn): Promise<TerminalLaunchSpecFixture> {
  const specPath = spawn.spawnArgv[spawn.spawnArgv.length - 1];
  expect(typeof specPath).toBe('string');
  try {
    return JSON.parse(await readFile(specPath!, 'utf8')) as TerminalLaunchSpecFixture;
  } finally {
    await rm(dirname(specPath!), { recursive: true, force: true });
  }
}

describe('buildClaudeUnifiedTerminalSpawn', () => {
  beforeEach(() => {
    process.env.IS_SANDBOX = '1';
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (originalIsSandbox === undefined) {
      delete process.env.IS_SANDBOX;
    } else {
      process.env.IS_SANDBOX = originalIsSandbox;
    }
  });

  it('resolves the Claude CLI after applying the session child env overlay', async () => {
    const resolveClaudeCliPath = vi.fn((env?: NodeJS.ProcessEnv) => {
      expect(env).toMatchObject({
        CLAUDE_CONFIG_DIR: '/tmp/profile-claude-config',
        HAPPIER_CLAUDE_PATH: '/profile/claude',
      });
      return '/profile/claude';
    });

    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      envOverlay: {
        CLAUDE_CONFIG_DIR: '/tmp/profile-claude-config',
        HAPPIER_CLAUDE_PATH: '/profile/claude',
      },
      deps: {
        resolveClaudeCliPath,
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    expect(resolveClaudeCliPath).toHaveBeenCalledTimes(1);
    expect(launchSpec.command).toBe('/profile/claude');
    expect(launchSpec.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/profile-claude-config');
  });

  it('always allows later dangerous permission bypass without starting default sessions in bypass mode', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    expect(launchArgs.filter((arg) => arg === '--allow-dangerously-skip-permissions')).toHaveLength(1);
    expect(launchArgs).not.toContain('--dangerously-skip-permissions');
    expect(launchArgs).not.toContain('bypassPermissions');
  });

  it('keeps the managed allow flag for non-root sessions even when IS_SANDBOX is absent', async () => {
    await withPatchedEnv({ IS_SANDBOX: undefined }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
          isRootUser: () => false,
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(launchSpec.args?.filter((arg) => arg === '--allow-dangerously-skip-permissions')).toHaveLength(1);
    });
  });

  it('omits the managed allow flag for root default sessions when IS_SANDBOX is absent', async () => {
    await withPatchedEnv({ IS_SANDBOX: undefined }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
          isRootUser: () => true,
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(launchSpec.args).not.toContain('--allow-dangerously-skip-permissions');
      expect(launchSpec.args).not.toContain('--permission-mode');
    });
  });

  it('fails before launching root bypass sessions when IS_SANDBOX is absent', async () => {
    await withPatchedEnv({ IS_SANDBOX: undefined }, async () => {
      await expect(buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'yolo',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
          isRootUser: () => true,
        },
      })).rejects.toBeInstanceOf(ClaudeUnifiedTerminalRootBypassRequiresSandboxError);
    });
  });

  it('starts yolo sessions in bypass mode while still deduping the managed allow flag', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'yolo',
        },
      },
      claudeArgs: ['--allow-dangerously-skip-permissions'],
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    expect(launchSpec.env?.IS_SANDBOX).toBe('1');
    expect(launchArgs.filter((arg) => arg === '--allow-dangerously-skip-permissions')).toHaveLength(1);
    expect(launchArgs.slice(launchArgs.indexOf('--permission-mode'), launchArgs.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('uses the managed JavaScript runtime wrapper when the resolved Claude CLI is a JavaScript file', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'read-only',
        },
      },
      claudeArgs: ['--model', 'sonnet', '--permission-mode', 'bypassPermissions'],
      hookPluginDir: '/tmp/plugin',
      hookSettingsPath: '/tmp/settings.json',
      happierMcpConfigJson: '{"mcpServers":{}}',
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    expect(spawn.spawnArgv[0]).toBe('/managed/node');
    expect(spawn.spawnArgv[1]).toBe('/happier/scripts/terminal_launch_spec_runner.cjs');
    expect(spawn.spawnArgv).not.toContain('/happier/scripts/claude_local_launcher.cjs');
    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    expect(launchSpec.command).toBe('/managed/node');
    expect(launchSpec.args?.[0]).toBe('/happier/scripts/claude_local_launcher.cjs');
    expect(launchSpec.args).toContain('/tmp/plugin');
    expect(launchSpec.args).toContain('/tmp/settings.json');
    expect(launchSpec.args).toContain('{"mcpServers":{}}');
    expect(launchSpec.args).toContain('--permission-mode');
    expect(launchSpec.args).toContain('dontAsk');
    expect(launchSpec.args).not.toContain('bypassPermissions');
    expect(launchSpec.env?.HAPPIER_CLAUDE_PATH).toBe('/opt/claude/cli.js');
    expect(launchSpec.env?.DISABLE_AUTOUPDATER).toBe('1');
  });


async function readOverlayFromArgs(args: readonly string[], hookSettingsPath: string): Promise<Record<string, unknown>> {
  const { readFile, stat } = await import('node:fs/promises');
  const settingsFlagIndexes = args
    .map((arg, index) => (arg === '--settings' ? index : -1))
    .filter((index) => index >= 0);
  // A single --settings overlay (Claude Code keeps only the first one).
  expect(settingsFlagIndexes).toHaveLength(1);
  const overlayArg = args[settingsFlagIndexes[0]! + 1]!;
  // Merged overlays ride a 0600 sibling FILE so the hook secret never lands in argv.
  expect(overlayArg).toBe(hookSettingsPath.replace(/\.json$/, '.overlay.json'));
  const overlayStat = await stat(overlayArg);
  expect(overlayStat.mode & 0o777).toBe(0o600);
  return JSON.parse(await readFile(overlayArg, 'utf8')) as Record<string, unknown>;
}

  it('merges ultracode into the single --settings overlay when the mode enables it', async () => {
    const { mkdtemp, readFile, stat, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-ultracode-settings-'));
    const hookSettingsPath = join(settingsDir, 'settings.json');
    await writeFile(hookSettingsPath, JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } }));

    try {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            model: 'claude-fable-5',
            ultracode: true,
          },
        },
        hookSettingsPath,
        deps: {
          resolveClaudeCliPath: () => '/opt/claude/cli.js',
          isClaudeCliJavaScriptFile: () => true,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      const args = launchSpec.args ?? [];
      const overlay = await readOverlayFromArgs(args, hookSettingsPath);
      expect(overlay.ultracode).toBe(true);
      // The hook settings content survives the merge.
      expect(overlay.permissions).toEqual({ allow: ['mcp__happier__change_title'] });
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

  it('repairs permissions when rewriting an existing settings overlay', async () => {
    const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-ultracode-existing-overlay-'));
    const hookSettingsPath = join(settingsDir, 'settings.json');
    await writeFile(hookSettingsPath, JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } }));
    const overlayPath = hookSettingsPath.replace(/\.json$/, '.overlay.json');
    await writeFile(overlayPath, JSON.stringify({ stale: true }), { mode: 0o644 });
    await chmod(overlayPath, 0o644);

    try {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            model: 'claude-fable-5',
            ultracode: true,
          },
        },
        hookSettingsPath,
        deps: {
          resolveClaudeCliPath: () => '/opt/claude/cli.js',
          isClaudeCliJavaScriptFile: () => true,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      const overlay = await readOverlayFromArgs(launchSpec.args ?? [], hookSettingsPath);
      expect(overlay.ultracode).toBe(true);
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

  it('installs the statusline forwarder in the single --settings overlay, preserving the user statusline', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-statusline-spawn-'));
    const hookSettingsPath = join(settingsDir, 'hook-settings.json');
    await writeFile(hookSettingsPath, JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } }));
    const configRoot = join(settingsDir, 'claude-config');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: '~/.claude/my-statusline.sh', padding: 0 },
    }));

    try {
      await withPatchedEnv({ CLAUDE_CONFIG_DIR: configRoot }, async () => {
        const spawn = await buildClaudeUnifiedTerminalSpawn({
          path: '/workspace/project',
          first: {
            message: 'hello',
            mode: {
              permissionMode: 'default',
            },
          },
          hookSettingsPath,
          statuslineForwarder: { port: 51234, secret: 'secret-xyz' },
          deps: {
            resolveClaudeCliPath: () => '/opt/claude/cli.js',
            isClaudeCliJavaScriptFile: () => true,
            ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
            claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
            terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
            resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
            statuslineForwarderScriptPath: '/happier/scripts/statusline_forwarder.cjs',
            resolveStatuslineNodeExecutable: () => '/managed/node',
          },
        });

        const launchSpec = await readLaunchSpecFromSpawn(spawn);
        const args = launchSpec.args ?? [];
        // The hook secret must never appear in Claude's argv (process listings are world-readable).
        expect(args.join(' ')).not.toContain('secret-xyz');
        const overlay = await readOverlayFromArgs(args, hookSettingsPath);
        // The hook settings content survives the merge.
        expect(overlay.permissions).toEqual({ allow: ['mcp__happier__change_title'] });
        const statusLine = overlay.statusLine as Record<string, unknown>;
        expect(statusLine.type).toBe('command');
        expect(statusLine.padding).toBe(0);
        const command = statusLine.command as string;
        expect(command).toContain('statusline_forwarder.cjs');
        expect(command).toContain('51234');
        expect(command).toContain('--secret-file');
        expect(command).not.toContain('secret-xyz');
        const secretPath = command.match(/--secret-file\s+"([^"]+)"/)?.[1];
        expect(secretPath).toBeTruthy();
        expect(await readFile(secretPath!, 'utf8')).toBe('secret-xyz');
        expect((await stat(secretPath!)).mode & 0o777).toBe(0o600);
        // The user's original statusline command rides along base64-encoded.
        const b64 = command.split(' ').at(-1)!;
        expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('~/.claude/my-statusline.sh');
      });
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

  it('installs the statusline forwarder without an original when none is configured, alongside ultracode', async () => {
    const { mkdtemp, readFile, stat, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const settingsDir = await mkdtemp(join(tmpdir(), 'happier-statusline-noorig-'));
    const hookSettingsPath = join(settingsDir, 'hook-settings.json');
    await writeFile(hookSettingsPath, JSON.stringify({ permissions: { allow: ['mcp__happier__change_title'] } }));
    const configRoot = join(settingsDir, 'claude-config');
    await mkdir(configRoot, { recursive: true });

    try {
      await withPatchedEnv({ CLAUDE_CONFIG_DIR: configRoot }, async () => {
        const spawn = await buildClaudeUnifiedTerminalSpawn({
          path: '/workspace/project',
          first: {
            message: 'hello',
            mode: {
              permissionMode: 'default',
              model: 'claude-fable-5',
              ultracode: true,
            },
          },
          hookSettingsPath,
          statuslineForwarder: { port: 51234, secret: 'secret-xyz' },
          deps: {
            resolveClaudeCliPath: () => '/opt/claude/cli.js',
            isClaudeCliJavaScriptFile: () => true,
            ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
            claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
            terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
            resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
            statuslineForwarderScriptPath: '/happier/scripts/statusline_forwarder.cjs',
            resolveStatuslineNodeExecutable: () => '/managed/node',
          },
        });

        const launchSpec = await readLaunchSpecFromSpawn(spawn);
        const args = launchSpec.args ?? [];
        const overlay = await readOverlayFromArgs(args, hookSettingsPath);
        // Ultracode and statusline ride the SAME single overlay.
        expect(overlay.ultracode).toBe(true);
        expect(overlay.permissions).toEqual({ allow: ['mcp__happier__change_title'] });
        const statusLine = overlay.statusLine as Record<string, unknown>;
        expect(statusLine.type).toBe('command');
        const command = statusLine.command as string;
        // No original configured → exactly node + script + port + secret-file args (no b64 tail).
        const secretPath = command.match(/--secret-file\s+"([^"]+)"/)?.[1];
        expect(secretPath).toBeTruthy();
        expect(command).toBe(`"/managed/node" "/happier/scripts/statusline_forwarder.cjs" 51234 --secret-file "${secretPath}"`);
        expect(command).not.toContain('secret-xyz');
        expect(await readFile(secretPath!, 'utf8')).toBe('secret-xyz');
        expect((await stat(secretPath!)).mode & 0o777).toBe(0o600);
      });
    } finally {
      await rm(settingsDir, { recursive: true, force: true });
    }
  });

  it('keeps the hook settings file path untouched when statusline forwarding is not requested', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      hookSettingsPath: '/tmp/settings.json',
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const args = launchSpec.args ?? [];
    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(args[settingsIndex + 1]).toBe('/tmp/settings.json');
  });

  it('rejects user --settings path args so they cannot shadow the managed overlay', async () => {
    await expect(buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      claudeArgs: ['--settings', '/tmp/user-settings.json'],
      hookSettingsPath: '/tmp/managed-settings.json',
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    })).rejects.toMatchObject({
      code: 'claude_unified_terminal_managed_settings_option',
      diagnostics: [
        expect.objectContaining({ code: 'managed_settings_option', option: '--settings' }),
      ],
    });
  });

  it('rejects user --settings inline args so they cannot disable managed hooks', async () => {
    await expect(buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      claudeArgs: ['--settings={"permissions":{"allow":[]}}'],
      hookSettingsPath: '/tmp/managed-settings.json',
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    })).rejects.toMatchObject({
      code: 'claude_unified_terminal_managed_settings_option',
      diagnostics: [
        expect.objectContaining({ code: 'managed_settings_option', option: '--settings' }),
      ],
    });
  });

  it('fails open to no statusline forwarder when no node runtime can be resolved for the wrapper', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      hookSettingsPath: '/tmp/settings.json',
      statuslineForwarder: { port: 51234, secret: 'secret-xyz' },
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        statuslineForwarderScriptPath: '/happier/scripts/statusline_forwarder.cjs',
        resolveStatuslineNodeExecutable: () => null,
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const args = launchSpec.args ?? [];
    const settingsIndex = args.indexOf('--settings');
    // No wrapper runtime → the user's own statusline stays in charge (file path passthrough).
    expect(args[settingsIndex + 1]).toBe('/tmp/settings.json');
  });

  it('keeps the hook settings file path untouched when ultracode is off or unsupported', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
          model: 'claude-sonnet-4-6',
          ultracode: true,
        },
      },
      hookSettingsPath: '/tmp/settings.json',
      deps: {
        resolveClaudeCliPath: () => '/opt/claude/cli.js',
        isClaudeCliJavaScriptFile: () => true,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const args = launchSpec.args ?? [];
    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(args[settingsIndex + 1]).toBe('/tmp/settings.json');
  });

  it('uses the resolved native Claude executable directly when it is not a JavaScript file', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    expect(spawn.spawnArgv).toEqual(expect.arrayContaining(['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs']));
    expect(spawn.spawnArgv).not.toContain('/usr/local/bin/claude');
    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    expect(launchSpec.command).toBe('/usr/local/bin/claude');
    expect(launchSpec.env?.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('launches safe-yolo startup mode as Claude auto mode', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'safe-yolo',
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    expect(launchArgs.slice(launchArgs.indexOf('--permission-mode'), launchArgs.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'auto',
    ]);
  });

  it('launches agentModeId=plan startup mode as Claude plan mode even when the permission mode is safe-yolo (incident cmq9hemcs)', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'safe-yolo',
          agentModeId: 'plan',
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    expect(launchArgs.slice(launchArgs.indexOf('--permission-mode'), launchArgs.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'plan',
    ]);
  });

  it('skips Claude Code onboarding so terminal-injected prompts reach the chat input on fresh hosts', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    expect(launchSpec.env?.IS_DEMO).toBe('1');
  });

  it('keeps unified terminal spawn env compact while preserving Claude auth and explicit child env keys', async () => {
    await withPatchedEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      HAPPIER_DAEMON_INITIAL_PROMPT: 'x'.repeat(200_000),
      HUGE_UNRELATED_ENV: 'y'.repeat(200_000),
      MY_EXPLICIT_CHILD_ENV: 'kept',
      [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify(['MY_EXPLICIT_CHILD_ENV']),
    }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        envOverlay: {
          OVERLAY_ONLY: 'overlay-kept',
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(launchSpec.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(launchSpec.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
      expect(launchSpec.env?.MY_EXPLICIT_CHILD_ENV).toBe('kept');
      expect(launchSpec.env?.OVERLAY_ONLY).toBe('overlay-kept');
      expect(launchSpec.env?.DISABLE_AUTOUPDATER).toBe('1');
      expect(launchSpec.envPassthroughKeys).toContain('ANTHROPIC_API_KEY');
      expect(spawn.spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(spawn.spawnEnv.HAPPIER_DAEMON_INITIAL_PROMPT).toBeUndefined();
      expect(spawn.spawnEnv.HUGE_UNRELATED_ENV).toBeUndefined();
      expect(spawn.spawnEnv[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]).toBeUndefined();
      expect(launchSpec.env?.HAPPIER_DAEMON_INITIAL_PROMPT).toBeUndefined();
      expect(launchSpec.env?.HUGE_UNRELATED_ENV).toBeUndefined();
      expect(launchSpec.env?.[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]).toBeUndefined();
    });
  });

  it('does not convert connected-service setup-token credentials into Claude Code OAuth env', async () => {
    await withPatchedEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
      CLAUDE_CODE_SETUP_TOKEN: 'selected-setup-token',
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'profile', serviceId: 'claude-subscription', profileId: 'setup-profile' },
      ]),
      [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: JSON.stringify([
        'CLAUDE_CODE_SETUP_TOKEN',
      ]),
    }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(launchSpec.envPassthroughKeys ?? []).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(launchSpec.envPassthroughKeys ?? []).not.toContain('CLAUDE_CODE_SETUP_TOKEN');
      expect(spawn.spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(spawn.spawnEnv.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
      expect(spawn.spawnEnv[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBeUndefined();
      expect(spawn.spawnEnv[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]).toBeUndefined();
    });
  });

  it('uses connected-service native Claude config without OAuth token passthrough', async () => {
    await withPatchedEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
      CLAUDE_CONFIG_DIR: '/tmp/connected-claude-config',
      CLAUDE_CODE_SETUP_TOKEN: undefined,
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'group', serviceId: 'claude-subscription', groupId: 'claude', activeProfileId: 'oauth-profile', fallbackProfileId: 'oauth-profile', generation: 1 },
      ]),
      [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: JSON.stringify([
        'CLAUDE_CONFIG_DIR',
      ]),
    }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(launchSpec.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/connected-claude-config');
      expect(launchSpec.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(launchSpec.envPassthroughKeys ?? []).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(launchSpec.envPassthroughKeys ?? []).not.toContain('CLAUDE_CODE_SETUP_TOKEN');
      expect(spawn.spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(spawn.spawnEnv.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
      expect(spawn.spawnEnv[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBeUndefined();
      expect(spawn.spawnEnv[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]).toBeUndefined();
    });
  });

  it('preserves Windows Path casing in both terminal launcher and Claude launch spec env', async () => {
    patchProcessPlatform('win32');
    await withPatchedEnv({
      PATH: undefined,
      Path: 'C:\\Windows\\System32;C:\\Tools',
    }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: 'C:\\workspace\\project',
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => 'C:\\Tools\\claude.cmd',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => 'C:\\Managed\\node.exe',
          claudeLocalLauncherPath: 'C:\\happier\\scripts\\claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: 'C:\\happier\\scripts\\terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const launchSpec = await readLaunchSpecFromSpawn(spawn);
      expect(spawn.spawnEnv.Path).toBe('C:\\Windows\\System32;C:\\Tools');
      expect(spawn.spawnEnv.PATH).toBeUndefined();
      expect(launchSpec.env?.Path).toBe('C:\\Windows\\System32;C:\\Tools');
      expect(launchSpec.env?.PATH).toBeUndefined();
    });
  });

  it('keeps long Claude startup payloads out of the terminal host creation command', async () => {
    const longSystemPrompt = `system-${'s'.repeat(80_000)}`;
    const longMcpConfigJson = JSON.stringify({
      mcpServers: {
        huge: {
          command: '/usr/bin/env',
          args: ['mcp', 'x'.repeat(80_000)],
        },
      },
    });

    await withPatchedEnv({
      HUGE_UNRELATED_ENV: 'y'.repeat(80_000),
    }, async () => {
      const spawn = await buildClaudeUnifiedTerminalSpawn({
        path: '/workspace/project',
        systemPromptText: longSystemPrompt,
        happierMcpConfigJson: longMcpConfigJson,
        first: {
          message: 'hello',
          mode: {
            permissionMode: 'default',
          },
        },
        deps: {
          resolveClaudeCliPath: () => '/usr/local/bin/claude',
          isClaudeCliJavaScriptFile: () => false,
          ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
          claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
          terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
          resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
        },
      });

      const terminalCommand = spawn.spawnArgv.join('\n');
      expect(terminalCommand).not.toContain(longSystemPrompt);
      expect(terminalCommand).not.toContain(longMcpConfigJson);
      expect(JSON.stringify(spawn.spawnEnv)).not.toContain(longSystemPrompt);
      expect(JSON.stringify(spawn.spawnEnv)).not.toContain(longMcpConfigJson);
      expect(JSON.stringify(spawn.spawnEnv)).not.toContain('y'.repeat(1_000));

      const specPath = spawn.spawnArgv[spawn.spawnArgv.length - 1];
      expect(typeof specPath).toBe('string');
      const launchSpec = JSON.parse(await readFile(specPath!, 'utf8')) as TerminalLaunchSpecFixture;
      const specMode = (await stat(specPath!)).mode & 0o777;
      if (process.platform !== 'win32') {
        expect(specMode).toBe(0o600);
      }
      expect(launchSpec.command).toBe('/usr/local/bin/claude');
      expect(launchSpec.args).toContain('--append-system-prompt');
      expect(launchSpec.args).toContain(longMcpConfigJson);
      expect(launchSpec.cwd).toBe('/workspace/project');
      expect(launchSpec.env?.DISABLE_AUTOUPDATER).toBe('1');

      await rm(dirname(specPath!), { recursive: true, force: true });
    });
  });

  it('applies unified terminal option parity while keeping prompt input out of Claude print mode', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'queued through TerminalInputInjectionV1',
        mode: {
          permissionMode: 'default',
          claudeRemoteSettingSourcesV2: ['project'],
          claudeRemoteStrictMcpServerConfig: true,
          claudeRemoteDisableTodos: true,
        },
      },
      claudeArgs: ['--print', 'must not launch as print prompt', '--model', 'sonnet'],
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    const appendSystemPromptIndex = launchArgs.indexOf('--append-system-prompt');
    expect(launchArgs[appendSystemPromptIndex + 1]).toContain('Do not create TODO');
    expect(launchArgs).toContain('--setting-sources');
    expect(launchArgs).toContain('project');
    expect(launchArgs).toContain('--strict-mcp-config');
    expect(launchArgs).toContain('--model');
    expect(launchArgs).toContain('sonnet');
    expect(launchArgs).not.toContain('--print');
    expect(launchArgs).not.toContain('must not launch as print prompt');
  });

  it('preserves Claude --name value before injected hook plugin args', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'queued through TerminalInputInjectionV1',
        mode: {
          permissionMode: 'default',
        },
      },
      claudeArgs: ['--name', 'D8 CLI startup fix'],
      hookPluginDir: '/tmp/hook-plugin',
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    const nameIndex = launchArgs.indexOf('--name');
    const pluginIndex = launchArgs.indexOf('--plugin-dir');
    expect(nameIndex).toBeGreaterThan(-1);
    expect(launchArgs[nameIndex + 1]).toBe('D8 CLI startup fix');
    expect(pluginIndex).toBeGreaterThan(-1);
    expect(launchArgs[pluginIndex + 1]).toBe('/tmp/hook-plugin');
  });

  it('honors mode model and prompt options while letting raw Claude args take precedence once', async () => {
    const spawn = await buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      systemPromptText: 'base system',
      first: {
        message: 'queued through TerminalInputInjectionV1',
        mode: {
          permissionMode: 'default',
          model: 'mode-sonnet',
          fallbackModel: 'mode-haiku',
          customSystemPrompt: 'mode custom system',
          appendSystemPrompt: 'mode append system',
          claudeRemoteDisableTodos: true,
        },
      },
      claudeArgs: [
        '--model=raw-opus',
        '--fallback-model=raw-haiku',
        '--system-prompt=raw custom system',
        '--append-system-prompt=raw append system',
      ],
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => '/managed/node',
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        terminalLaunchSpecRunnerPath: '/happier/scripts/terminal_launch_spec_runner.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    });

    const launchSpec = await readLaunchSpecFromSpawn(spawn);
    const launchArgs = launchSpec.args ?? [];
    expect(launchArgs.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(launchArgs.slice(launchArgs.indexOf('--model'), launchArgs.indexOf('--model') + 2)).toEqual([
      '--model',
      'raw-opus',
    ]);
    expect(launchArgs.filter((arg) => arg === '--fallback-model')).toHaveLength(1);
    expect(launchArgs.slice(launchArgs.indexOf('--fallback-model'), launchArgs.indexOf('--fallback-model') + 2)).toEqual([
      '--fallback-model',
      'raw-haiku',
    ]);
    expect(launchArgs.filter((arg) => arg === '--system-prompt')).toHaveLength(1);
    expect(launchArgs.slice(launchArgs.indexOf('--system-prompt'), launchArgs.indexOf('--system-prompt') + 2)).toEqual([
      '--system-prompt',
      'raw custom system',
    ]);
    const appendSystemPromptIndex = launchArgs.indexOf('--append-system-prompt');
    expect(launchArgs.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
    expect(launchArgs[appendSystemPromptIndex + 1]).toContain('base system');
    expect(launchArgs[appendSystemPromptIndex + 1]).toContain('raw append system');
    expect(launchArgs[appendSystemPromptIndex + 1]).toContain('Do not create TODO');
    expect(launchArgs[appendSystemPromptIndex + 1]).not.toContain('mode append system');
  });

  it('fails closed when unified terminal options cannot be mapped safely', async () => {
    await expect(buildClaudeUnifiedTerminalSpawn({
      path: '/workspace/project',
      first: {
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeRemoteMaxThinkingTokens: 4096,
        },
      },
      deps: {
        resolveClaudeCliPath: () => '/usr/local/bin/claude',
        isClaudeCliJavaScriptFile: () => false,
        ensureClaudeJsRuntimeExecutable: async () => {
          throw new Error('should not require node');
        },
        claudeLocalLauncherPath: '/happier/scripts/claude_local_launcher.cjs',
        resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
      },
    })).rejects.toMatchObject({
      code: 'claude_unified_terminal_unsupported_option',
      diagnostics: [
        expect.objectContaining({ code: 'unsupported_max_thinking_tokens' }),
      ],
    });
  });
});
