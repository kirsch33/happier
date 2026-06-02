import { describe, expect, it } from 'vitest';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';

describe('buildSpawnChildProcessEnv', () => {
  it('merges process env with extra env and strips nested daemon/session bootstrap variables', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'parent',
        HAPPIER_SESSION_AUTOSTART_DAEMON: '1',
      },
      extraEnv: { CUSTOM: 'x' },
    });

    expect(env.PATH).toBe('/bin');
    expect(env.CUSTOM).toBe('x');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
  });

  it('preserves inherited provider auth/config env and still lets explicit session env override it', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        CLAUDE_CONFIG_DIR: '/Users/test/.claude',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-claude-token',
        CLAUDE_CODE_SETUP_TOKEN: 'stale-claude-setup-token',
        CODEX_HOME: '/Users/test/.codex',
        OPENAI_API_KEY: 'stale-openai-key',
        OPENCODE_CONFIG_CONTENT: '{"model":"stale-host-model"}',
      },
      extraEnv: {
        CLAUDE_CONFIG_DIR: '/tmp/explicit-claude-config',
        OPENAI_API_KEY: 'explicit-openai-key',
        OPENCODE_CONFIG_CONTENT: '{"model":"explicit-session-model"}',
      },
    });

    expect(env.PATH).toBe('/bin');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/explicit-claude-config');
    expect(env.OPENAI_API_KEY).toBe('explicit-openai-key');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"explicit-session-model"}');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stale-claude-token');
    expect(env.CLAUDE_CODE_SETUP_TOKEN).toBe('stale-claude-setup-token');
    expect(env.CODEX_HOME).toBe('/Users/test/.codex');
  });

  it('injects the daemon active server selection for spawned child runners', () => {
    const params = {
      processEnv: {
        PATH: '/bin',
        HAPPIER_HOME_DIR: '/stale/home',
        HAPPIER_ACTIVE_SERVER_ID: 'stale-server',
        HAPPIER_SERVER_URL: 'https://stale.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:4999',
        HAPPIER_PUBLIC_SERVER_URL: 'https://stale-public.example.test',
        HAPPIER_WEBAPP_URL: 'https://stale-app.example.test',
      },
      extraEnv: {},
      happyHomeDir: '/stack/home/.happier',
      serverSelectionEnv: {
        activeServerId: 'stack-a',
        canonicalServerUrl: 'http://127.0.0.1:13155',
        apiServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://127.0.0.1:13155',
      },
    };
    const env = buildSpawnChildProcessEnv(params);

    expect(env.PATH).toBe('/bin');
    expect(env.HAPPIER_HOME_DIR).toBe('/stack/home/.happier');
    expect(env.HAPPIER_ACTIVE_SERVER_ID).toBe('stack-a');
    expect(env.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:3005');
    expect(env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:3005');
    expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe('http://127.0.0.1:13155');
    expect(env.HAPPIER_WEBAPP_URL).toBe('http://127.0.0.1:13155');
  });

  it('enables self-migration for child runners spawned by a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      },
      extraEnv: {},
    });

    expect(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBe('1');
  });

  it('does not enable self-migration for child runners spawned outside a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      },
      extraEnv: {},
    });

    expect(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBeUndefined();
  });

});
