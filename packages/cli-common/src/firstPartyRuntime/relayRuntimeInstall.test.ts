import { access, chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';

async function makeRunnableRelayPayload(params: Readonly<{
  payloadRoot: string;
  serverBinaryPath: string;
}>): Promise<void> {
  const runtimeRoot = dirname(params.serverBinaryPath) === params.payloadRoot
    ? params.payloadRoot
    : dirname(params.serverBinaryPath);
  await chmod(params.serverBinaryPath, 0o755);
  await mkdir(join(runtimeRoot, 'node_modules', '.prisma', 'client'), { recursive: true });
  await mkdir(join(runtimeRoot, 'node_modules', '@prisma', 'client'), { recursive: true });
  await mkdir(join(runtimeRoot, 'generated', 'sqlite-client'), { recursive: true });
  await mkdir(join(runtimeRoot, 'generated', 'mysql-client'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
  await mkdir(join(params.payloadRoot, 'ui-web', 'current'), { recursive: true });
  await writeFile(join(runtimeRoot, 'node_modules', '.prisma', 'client', 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(runtimeRoot, 'node_modules', '@prisma', 'client', 'package.json'), '{"main":"index.js"}\n', 'utf8');
  await writeFile(join(runtimeRoot, 'node_modules', '@prisma', 'client', 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(runtimeRoot, 'generated', 'sqlite-client', 'index.js'), 'export {};\n', 'utf8');
  await writeFile(join(runtimeRoot, 'generated', 'mysql-client', 'index.js'), 'export {};\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
  await writeFile(join(params.payloadRoot, 'ui-web', 'current', 'index.html'), '<html></html>\n', { encoding: 'utf8', flag: 'a' });
}

describe('installOrUpdateRelayRuntimeLocal', () => {
  it('returns the env-overridden baseUrl instead of the default relay port', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: {
          PORT: '4010',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:4010',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves the existing configured PORT when reinstalling without an explicit override', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: {
          PORT: '4010',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:4010',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves existing persistent relay state when reinstalling into the canonical preview root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(join(defaults.installRoot, 'bin'), { recursive: true });
      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.dataDir, { recursive: true });
      await mkdir(defaults.logDir, { recursive: true });
      await writeFile(join(defaults.installRoot, 'bin', 'happier-server'), '#!/bin/sh\necho old\n', 'utf8');
      await writeFile(join(defaults.dataDir, 'handy-master-secret.txt'), 'secret-before-update\n', 'utf8');
      await writeFile(join(defaults.dataDir, 'session-marker.txt'), 'session-before-update\n', 'utf8');
      await writeFile(join(defaults.logDir, 'server.out.log'), 'existing-log\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      await expect(readFileText(join(defaults.dataDir, 'handy-master-secret.txt'))).resolves.toBe('secret-before-update\n');
      await expect(readFileText(join(defaults.dataDir, 'session-marker.txt'))).resolves.toBe('session-before-update\n');
      await expect(readFileText(join(defaults.logDir, 'server.out.log'))).resolves.toBe('existing-log\n');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not enumerate persistent full-server data when updating the relay runtime', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const defaults = resolveRelayRuntimeDefaults({
      platform: 'linux',
      mode: 'user',
      channel: 'preview',
      homeDir,
    });
    const unreadablePgDataDir = join(defaults.installRoot, 'full-server', 'infra', 'pgdata');
    const markerPath = join(unreadablePgDataDir, 'postgres.marker');
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });
      await mkdir(unreadablePgDataDir, { recursive: true });
      await writeFile(markerPath, 'postgres-before-update\n', 'utf8');
      await chmod(unreadablePgDataDir, 0o000);

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:3005',
      });

      await chmod(unreadablePgDataDir, 0o700);
      await expect(readFileText(markerPath)).resolves.toBe('postgres-before-update\n');
    } finally {
      await chmod(unreadablePgDataDir, 0o700).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('creates and populates the sqlite migrations directory from the server payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const migrationsDestDir = join(defaults.dataDir, 'migrations', 'sqlite');
      const installedMigrationPath = join(migrationsDestDir, '20200101000000_init', 'migration.sql');

      await expect(readFileText(installedMigrationPath)).resolves.toContain('-- init');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('writes HAPPIER_SERVER_UI_DIR pointing at the installRoot ui-web/current', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const envPath = join(defaults.configDir, 'server.env');
      const envText = await readFileText(envPath);

      expect(envText).toContain(`HAPPIER_SERVER_UI_DIR=${join(defaults.installRoot, 'ui-web', 'current')}`);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects HAPPIER_SERVER_UI_DIR overrides instead of persisting a volatile UI source path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: {
          HAPPIER_SERVER_UI_DIR: join(tmpdir(), 'happier-ui-web-volatile'),
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow(/owned by the relay runtime installer/i);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('replaces managed UI assets from the validated runtime payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(join(defaults.installRoot, 'bin'), { recursive: true });
      await mkdir(join(defaults.installRoot, 'ui-web', 'current'), { recursive: true });
      await writeFile(join(defaults.installRoot, 'bin', 'happier-server'), '#!/bin/sh\necho old\n', 'utf8');
      await writeFile(join(defaults.installRoot, 'ui-web', 'current', 'index.html'), '<html>old</html>\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      await expect(readFileText(join(defaults.installRoot, 'ui-web', 'current', 'index.html'))).resolves.not.toContain('<html>old</html>');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('installs sibling ui-web assets when the provided Windows server binary lives under bin/', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const binDir = join(payloadRoot, 'bin');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const uiSourceDir = join(payloadRoot, 'ui-web', 'current');
      await mkdir(binDir, { recursive: true });
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(uiSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(join(uiSourceDir, 'index.html'), '<html>preview</html>\n', 'utf8');

      const serverBinaryPath = join(binDir, 'happier-server.exe');
      await writeFile(serverBinaryPath, 'stub exe\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'win32',
        arch: 'x64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'win32',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedUiPath = join(defaults.installRoot, 'ui-web', 'current', 'index.html');

      await expect(readFileText(installedUiPath)).resolves.toContain('preview');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('normalizes root-level Windows server payloads into the installRoot bin layout without dropping sidecars', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const uiSourceDir = join(payloadRoot, 'ui-web', 'current');
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(uiSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(join(uiSourceDir, 'index.html'), '<html>preview</html>\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server.exe');
      await writeFile(serverBinaryPath, 'stub exe\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'win32',
        arch: 'x64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'win32',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedBinaryPath = join(defaults.installRoot, 'bin', 'happier-server.exe');
      const installedUiPath = join(defaults.installRoot, 'ui-web', 'current', 'index.html');
      const installedMigrationPath = join(
        defaults.installRoot,
        'prisma',
        'sqlite',
        'migrations',
        '20200101000000_init',
        'migration.sql',
      );

      await expect(readFileText(installedBinaryPath)).resolves.toContain('stub exe');
      await expect(readFileText(installedUiPath)).resolves.toContain('preview');
      await expect(readFileText(installedMigrationPath)).resolves.toContain('-- init');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('supports overriding the systemd unit name to avoid creating a duplicate legacy install', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        serviceNameOverride: 'happier-server',
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const expectedUnitPath = join(homeDir, '.config', 'systemd', 'user', 'happier-server.service');
      await expect(access(expectedUnitPath)).resolves.toBeUndefined();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'linux', arch: 'arm64' },
  ] as const)('copies the installed server binary into the persistent install root so %s user installs do not depend on the temp payload path', async ({ platform, arch }) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const payloadRoot = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-payload-'));
    try {
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const prismaClientDir = join(payloadRoot, 'node_modules', '.prisma', 'client');
      const generatedSqliteClientDir = join(payloadRoot, 'generated', 'sqlite-client');
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(prismaClientDir, { recursive: true });
      await mkdir(generatedSqliteClientDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      const prismaEngineName = platform === 'darwin'
        ? 'libquery_engine-darwin-arm64.dylib.node'
        : 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
      await writeFile(join(prismaClientDir, prismaEngineName), 'engine\n', 'utf8');
      await writeFile(join(generatedSqliteClientDir, prismaEngineName), 'generated-engine\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform,
        arch,
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform,
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const envPath = join(defaults.configDir, 'server.env');
      const installedPrismaEnginePath = join(defaults.installRoot, 'bin', 'node_modules', '.prisma', 'client', prismaEngineName);
      const installedGeneratedEnginePath = join(defaults.installRoot, 'bin', 'generated', 'sqlite-client', prismaEngineName);

      await rm(payloadRoot, { recursive: true, force: true });

      await expect(access(installedBinaryPath, constants.X_OK)).resolves.toBeUndefined();
      await expect(readFileText(installedPrismaEnginePath)).resolves.toBe('engine\n');
      await expect(readFileText(installedGeneratedEnginePath)).resolves.toBe('generated-engine\n');
      await expect(lstat(installedBinaryPath)).resolves.toSatisfy((stats) => stats.isSymbolicLink() === false);
      const envText = await readFileText(envPath);
      expect(envText).toContain('HAPPIER_SQLITE_AUTO_MIGRATE=1');
      expect(envText).toContain(`NODE_PATH=${join(defaults.installRoot, 'bin', 'node_modules')}`);
      expect(envText).toContain(`PRISMA_QUERY_ENGINE_LIBRARY=${installedPrismaEnginePath}`);
    } finally {
      await rm(payloadRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}
