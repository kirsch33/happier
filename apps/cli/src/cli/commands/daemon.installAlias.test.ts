import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { handleDaemonCliCommand } from './daemon';

describe('happier daemon install/uninstall', () => {
  it('aliases daemon install to daemon service install (supports prepare-only dry-run JSON)', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_NODE_PATH',
      'HOME',
      'PATH',
    ]);

    await withTempDir('happier-daemon-install-alias-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/managed/happier',
        HOME: tmp,
        PATH: join(tmp, 'bin'),
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        prepareOnly: boolean;
        wouldStart: boolean;
        plan?: { files?: Array<{ path: string }>; commands?: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'install', '--prepare-only', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.prepareOnly).toBe(true);
        expect(parsed.wouldStart).toBe(false);
        expect(parsed.plan?.files?.[0]?.path).toContain('happier-daemon.default.service');
        expect(parsed.plan?.commands?.some((command) => command.args.includes('restart') || command.args.includes('start'))).toBe(false);
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });

  it('propagates a prepare-only refusal through the daemon install alias as a process failure', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_NODE_PATH',
      'HOME',
      'PATH',
    ]);

    await withTempDir('happier-daemon-install-alias-refusal-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/managed/happier',
        HOME: tmp,
        PATH: join(tmp, 'bin'),
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; error: string }>();
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'install', '--prepare-only', '--yes', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        expect(output.json()).toEqual(expect.objectContaining({ ok: false, error: 'service_not_stopped' }));
        expect(process.exitCode).toBe(1);
      } finally {
        output.restore();
        process.exitCode = previousExitCode;
        envScope.restore();
      }
    });
  });

  it('aliases daemon uninstall to daemon service uninstall (supports --dry-run --json)', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HOME',
      'PATH',
    ]);

    await withTempDir('happier-daemon-uninstall-alias-', async (tmp) => {
      envScope.patch({
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmp,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(tmp, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HOME: tmp,
        PATH: join(tmp, 'bin'),
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; plan?: { filesToRemove?: string[] } }>();
      try {
        await handleDaemonCliCommand({
          args: ['daemon', 'uninstall', '--dry-run', '--json'],
          rawArgv: [],
          terminalRuntime: null,
        });

        const parsed = output.json();
        expect(parsed.ok).toBe(true);
        expect(parsed.plan?.filesToRemove?.some((p) => p.includes('happier-daemon.default.service'))).toBe(true);
      } finally {
        output.restore();
        envScope.restore();
      }
    });
  });
});
