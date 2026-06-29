import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/spawnHappyCLI', () => {
  return {
    buildHappyCliSubprocessLaunchSpec: vi.fn((args: string[]) => {
      const runtime = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME === 'bun' ? 'bun' : 'node';
      if (runtime === 'bun') {
        return {
          runtime,
          filePath: 'bun',
          args: ['/virtual/dist/index.mjs', ...args],
        };
      }
      return {
        runtime,
        filePath: 'node',
        args: ['--no-warnings', '--no-deprecation', '/virtual/dist/index.mjs', ...args],
      };
    }),
  };
});

import { buildTmuxSpawnConfig } from './platform/tmux/spawnConfig';

describe('daemon tmux spawn config', () => {
  const originalRuntimeOverride = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalRuntimeOverride === undefined) {
      delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
    } else {
      process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    vi.clearAllMocks();
  });

  it('uses merged env and bun runtime when configured', () => {
    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'bun';
    process.env.PATH = '/bin';

    const cfg = buildTmuxSpawnConfig({
      agent: 'claude',
      directory: '/tmp',
      extraEnv: {
        FOO: 'bar',
      },
      tmuxCommandEnv: {
        TMUX_TMPDIR: '/custom/tmux',
      },
      extraArgs: ['--happy-terminal-mode', 'tmux'],
    });

    expect(cfg.commandTokens[0]).toBe('bun');
    expect(cfg.tmuxEnv.PATH).toBe('/bin');
    expect(cfg.tmuxEnv.FOO).toBe('bar');
    expect(cfg.tmuxCommandEnv.TMUX_TMPDIR).toBe('/custom/tmux');
    expect(cfg.commandTokens).toEqual(expect.arrayContaining(['--happy-terminal-mode', 'tmux']));
  });

  it('overlays authoritative server context and clears stale split urls', () => {
    process.env.PATH = '/bin';

    const cfg = buildTmuxSpawnConfig({
      agent: 'claude',
      directory: '/tmp',
      extraEnv: {
        HAPPIER_SERVER_URL: 'https://stale.example',
        HAPPIER_PUBLIC_SERVER_URL: 'https://stale.example',
        HAPPIER_LOCAL_SERVER_URL: 'http://stale.local',
      },
      homeDir: '/home/akirsch/.happier',
      serverSelectionEnv: {
        activeServerId: 'greatwhitelab',
        canonicalServerUrl: 'http://127.0.0.1:3005',
        apiServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'https://happier-web.greatwhitelab.net',
      },
    });

    expect(cfg.tmuxEnv.HAPPIER_HOME_DIR).toBe('/home/akirsch/.happier');
    expect(cfg.tmuxEnv.HAPPIER_ACTIVE_SERVER_ID).toBe('greatwhitelab');
    expect(cfg.tmuxEnv.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:3005');
    expect(cfg.tmuxEnv.HAPPIER_PUBLIC_SERVER_URL).toBe('');
    expect(cfg.tmuxEnv.HAPPIER_LOCAL_SERVER_URL).toBe('');
    expect(cfg.tmuxEnv.HAPPIER_WEBAPP_URL).toBe('https://happier-web.greatwhitelab.net');
  });

});
