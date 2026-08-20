import { createServer, type Server } from 'node:http';
import { createServer as createPortReservationServer } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

async function withTemporaryHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'relay-host-engine-local-health-'));
  await run(homeDir);
}

async function makeRunnableRelayPayload(params: Readonly<{
  payloadRoot: string;
  serverBinaryPath: string;
}>): Promise<void> {
  await chmod(params.serverBinaryPath, 0o755);
  await mkdir(join(params.payloadRoot, 'node_modules', '.prisma', 'client'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'node_modules', '@prisma', 'client'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'generated', 'sqlite-client'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'generated', 'mysql-client'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'ui-web', 'current'), { recursive: true });
  await writeFile(join(params.payloadRoot, 'node_modules', '.prisma', 'client', 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'node_modules', '@prisma', 'client', 'package.json'), '{"main":"index.js"}\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'node_modules', '@prisma', 'client', 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'generated', 'sqlite-client', 'index.js'), 'export {};\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'generated', 'mysql-client', 'index.js'), 'export {};\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'ui-web', 'current', 'index.html'), '<html></html>\n', 'utf8');
}

async function startRelayHealthServer(params: Readonly<{ port: number; healthPath: string }>): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === params.healthPath) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.2' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(params.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createPortReservationServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve relay test port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

describe('RelayHostEngine (local health)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('marks a local relay unhealthy when the service is active but the health endpoint is unreachable', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.installRoot, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');
      await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
      });

      expect(status.service).toEqual({ enabled: true, active: true });
      expect(status.healthy).toBe(false);
    });
  });

  it('reports a warning when older legacy relay state with a different data secret remains beside the canonical preview root', async () => {
    await withTemporaryHome(async (homeDir) => {
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const legacyInstallRoot = join(homeDir, '.happier', 'l1', 'self-host');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(join(defaults.installRoot, 'data'), { recursive: true });
      await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.2.4' }), 'utf8');
      await writeFile(join(defaults.installRoot, 'data', 'handy-master-secret.txt'), 'preview-secret\n', 'utf8');
      await writeFile(join(legacyInstallRoot, 'data', 'handy-master-secret.txt'), 'legacy-secret\n', 'utf8');
      await writeFile(join(defaults.installRoot, 'data', 'happier-server-light.sqlite'), 'preview-db\n', 'utf8');
      await writeFile(join(legacyInstallRoot, 'data', 'happier-server-light.sqlite'), 'legacy-db\n', 'utf8');
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime (happier-server-preview)',
          '[Service]',
          `WorkingDirectory=${defaults.installRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${defaults.installRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => String(value).endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
              }
              if (unit === 'happier-server.service') {
                return { status: 0, stdout: 'ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nLoadState=loaded\n', stderr: '' };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
      });

      const warnings = (status as Readonly<{ warnings?: readonly string[] }>).warnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(legacyInstallRoot);
      expect(warnings[0]).toMatch(/different data secret/i);
    });
  });

  it('waits for local start to become healthy before returning', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.logDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');

      let server: Server | null = null;
      let healthServerStarted = false;
      const delayedStart = setTimeout(async () => {
        server = await startRelayHealthServer({ port, healthPath: defaults.healthPath });
        healthServerStarted = true;
      }, 250);

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args[1] === 'start') {
              return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      try {
        const { createRelayHostEngine } = await import('./relayHostEngine.js');
        const engine = createRelayHostEngine({
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => {},
          installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
        });

        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'start',
        });

        expect(healthServerStarted).toBe(true);
      } finally {
        clearTimeout(delayedStart);
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    });
  });

  it('waits for local restart to become healthy before returning', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.logDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');

      let server: Server | null = null;
      let healthServerStarted = false;
      const delayedStart = setTimeout(async () => {
        server = await startRelayHealthServer({ port, healthPath: defaults.healthPath });
        healthServerStarted = true;
      }, 250);

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args[1] === 'restart') {
              return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      try {
        const { createRelayHostEngine } = await import('./relayHostEngine.js');
        const engine = createRelayHostEngine({
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => {},
          installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
        });

        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'restart',
        });

        expect(healthServerStarted).toBe(true);
      } finally {
        clearTimeout(delayedStart);
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    });
  });

  it('fails closed when another relay lane is explicitly pinned to the same URL via env override', async () => {
    // New contract: installing a second channel's relay WITHOUT an explicit
    // PORT override auto-assigns a free port (see separate test). This test
    // covers the remaining conflict case: user explicitly pins the preview
    // relay to stable's port via `--env PORT=3005`. In that case we should
    // still error, because the user is asking for a collision.
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const previewBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        env: { PORT: '3005' },
        selfHostRelayBinaryOverride: previewBinaryPath,
      })).rejects.toThrow(/stable/i);
    });
  });

  it('auto-assigns a free port when another relay lane is already on the default port', async () => {
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const previewBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath: previewBinaryPath });
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const result = await engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
      });

      expect(result.relayUrl).not.toMatch(/:3005(\/|$)/);
      expect(result.relayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    });
  });

  it('fails closed before moving an active legacy root when service commands are disabled', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const legacyInstallRoot = join(homeDir, '.happier', 'l1', 'self-host');
      const payloadRoot = join(homeDir, 'payload');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
      await writeFile(join(legacyInstallRoot, 'data', 'session-marker.txt'), 'legacy-session\n', 'utf8');
      await mkdir(payloadRoot, { recursive: true });
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const previewBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath: previewBinaryPath });
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Self-Host (happier-server)',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          `Environment=PORT=${port}`,
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unitArg = args.find((entry) => typeof entry === 'string' && entry.endsWith('.service')) ?? '';
              if (unitArg === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n',
                  stderr: '',
                };
              }
              return { status: 1, stdout: 'LoadState=not-found\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
        env: { PORT: String(port), HAPPIER_SERVER_HOST: '127.0.0.1' },
      })).rejects.toThrow(/requires service commands/i);

      expect(existsSync(join(previewDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(false);
      expect(existsSync(join(legacyInstallRoot, 'data', 'session-marker.txt'))).toBe(true);
    });
  });

  it('fails closed without mutating a legacy root when its live service cannot be proven for the requested preview lane', async () => {
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(stableDefaults.configDir, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await mkdir(unitDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await mkdir(join(stableDefaults.installRoot, 'data'), { recursive: true });
      await writeFile(join(stableDefaults.installRoot, 'data', 'session-marker.txt'), 'legacy\n', 'utf8');
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Self-Host (happier-server)',
          '[Service]',
          `WorkingDirectory=${stableDefaults.installRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${stableDefaults.installRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      const payloadDir = join(homeDir, 'payload-preview');
      await mkdir(payloadDir, { recursive: true });
      const previewBinaryPath = join(payloadDir, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot: payloadDir, serverBinaryPath: previewBinaryPath });

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unitArg = args.find((entry) => typeof entry === 'string' && entry.endsWith('.service')) ?? '';
              if (unitArg === 'happier-server.service') {
                return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
              }
              return { status: 1, stdout: 'LoadState=not-found\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
      })).rejects.toThrow(/registered and active legacy service/i);

      expect(existsSync(join(previewDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(false);
      expect(existsSync(join(stableDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(true);
    });
  });

  it('fails closed without mutating a legacy root when prior state cannot prove its live service', async () => {
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(stableDefaults.configDir, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await mkdir(unitDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await mkdir(join(stableDefaults.installRoot, 'data'), { recursive: true });
      await writeFile(join(stableDefaults.installRoot, 'data', 'session-marker.txt'), 'legacy\n', 'utf8');
      await writeFile(
        join(stableDefaults.installRoot, 'self-host-state.json'),
        JSON.stringify({ channel: 'preview', mode: 'user', version: '0.1.0-preview.legacy' }),
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Self-Host (happier-server)',
          '[Service]',
          `WorkingDirectory=${stableDefaults.installRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${stableDefaults.installRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      const payloadDir = join(homeDir, 'payload-preview');
      await mkdir(payloadDir, { recursive: true });
      const previewBinaryPath = join(payloadDir, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot: payloadDir, serverBinaryPath: previewBinaryPath });

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unitArg = args.find((entry) => typeof entry === 'string' && entry.endsWith('.service')) ?? '';
              if (unitArg === 'happier-server.service') {
                return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
              }
              return { status: 1, stdout: 'LoadState=not-found\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
      })).rejects.toThrow(/registered and active legacy service/i);

      expect(existsSync(join(previewDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(false);
      expect(existsSync(join(stableDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(true);
    });
  });

  it('runs full-profile config preflight before any legacy or service mutation', async () => {
    await withTemporaryHome(async (homeDir) => {
      const defaults = {
        channel: 'stable' as const,
        mode: 'system' as const,
        installRoot: join(homeDir, 'runtime'),
        binDir: join(homeDir, 'bin'),
        configDir: join(homeDir, 'config'),
        dataDir: join(homeDir, 'data'),
        logDir: join(homeDir, 'logs'),
        serviceName: 'happier-server',
        serverHost: '127.0.0.1',
        serverPort: 3005,
        healthPath: '/v1/version',
      };
      const legacyDefinitionPath = join(homeDir, 'legacy.service');
      const payloadStatePath = join(defaults.installRoot, 'payload-marker');
      const envStatePath = join(defaults.configDir, 'env-marker');
      const statePath = join(defaults.dataDir, 'state-marker');
      await mkdir(defaults.installRoot, { recursive: true });
      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.dataDir, { recursive: true });
      await writeFile(legacyDefinitionPath, '[Service]\nExecStart=/legacy\n', 'utf8');
      await writeFile(payloadStatePath, 'payload-before\n', 'utf8');
      await writeFile(envStatePath, 'env-before\n', 'utf8');
      await writeFile(statePath, 'state-before\n', 'utf8');

      const commands: string[][] = [];
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('../firstPartyRuntime/relayRuntime.js', async () => {
        const actual = await vi.importActual<typeof import('../firstPartyRuntime/relayRuntime.js')>('../firstPartyRuntime/relayRuntime.js');
        return { ...actual, resolveRelayRuntimeDefaults: () => defaults };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            commands.push([cmd, ...(args ?? [])]);
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'system',
        profile: 'full',
        selfHostRelayBinaryOverride: join(homeDir, 'payload', 'happier-server'),
      })).rejects.toThrow(/mode 0600 config\/server\.env/i);

      expect(commands).toEqual([]);
      await expect(readFile(legacyDefinitionPath, 'utf8')).resolves.toBe('[Service]\nExecStart=/legacy\n');
      await expect(readFile(payloadStatePath, 'utf8')).resolves.toBe('payload-before\n');
      await expect(readFile(envStatePath, 'utf8')).resolves.toBe('env-before\n');
      await expect(readFile(statePath, 'utf8')).resolves.toBe('state-before\n');
    });
  });

  it('runs full-profile effective drop-in preflight before legacy service commands', async () => {
    await withTemporaryHome(async (homeDir) => {
      const defaults = {
        channel: 'stable' as const,
        mode: 'system' as const,
        installRoot: join(homeDir, 'runtime'),
        binDir: join(homeDir, 'bin'),
        configDir: join(homeDir, 'config'),
        dataDir: join(homeDir, 'data'),
        logDir: join(homeDir, 'logs'),
        serviceName: 'happier-server',
        serverHost: '127.0.0.1',
        serverPort: 3005,
        healthPath: '/v1/version',
      };
      const dropInPath = join(homeDir, 'lib', 'systemd', 'system', 'happier-server-.service.d', '50-vendor.conf');
      const payloadStatePath = join(defaults.installRoot, 'payload-marker');
      const envStatePath = join(defaults.configDir, 'env-marker');
      const statePath = join(defaults.dataDir, 'state-marker');
      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.installRoot, { recursive: true });
      await mkdir(defaults.dataDir, { recursive: true });
      await mkdir(dirname(dropInPath), { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), 'HAPPIER_DB_PROVIDER=postgres\nDATABASE_URL=postgres://example\n', { mode: 0o600 });
      await writeFile(dropInPath, '[Service]\nExecStartPre=/vendor-migrate\n', 'utf8');
      await writeFile(payloadStatePath, 'payload-before\n', 'utf8');
      await writeFile(envStatePath, 'env-before\n', 'utf8');
      await writeFile(statePath, 'state-before\n', 'utf8');

      const commands: string[][] = [];
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('../firstPartyRuntime/relayRuntime.js', async () => {
        const actual = await vi.importActual<typeof import('../firstPartyRuntime/relayRuntime.js')>('../firstPartyRuntime/relayRuntime.js');
        return { ...actual, resolveRelayRuntimeDefaults: () => defaults };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            commands.push([cmd, ...(args ?? [])]);
            return { status: 0, stdout: `${dropInPath}\n`, stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'system',
        profile: 'full',
        selfHostRelayBinaryOverride: join(homeDir, 'payload', 'happier-server'),
      })).rejects.toThrow(/conflicting systemd drop-in/i);

      expect(commands).toEqual([[
        'systemctl',
        'show',
        'happier-server.service',
        '--property=DropInPaths',
        '--value',
      ]]);
      await expect(readFile(payloadStatePath, 'utf8')).resolves.toBe('payload-before\n');
      await expect(readFile(envStatePath, 'utf8')).resolves.toBe('env-before\n');
      await expect(readFile(statePath, 'utf8')).resolves.toBe('state-before\n');
    });
  });
});
