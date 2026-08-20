import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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

const events = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
            events.push(`rename:${String(args[0])}->${String(args[1])}`);
            return await actual.rename(...args);
        }),
        rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
            if (String(args[0] ?? '').endsWith('.service')) {
                events.push('rm-service-definition');
            }
            return await actual.rm(...args);
        }),
    };
});

vi.mock('../service/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../service/index.js')>();

    return {
        ...actual,
        resolveServiceBackend: vi.fn(() => 'systemd-user'),
        buildServiceDefinition: vi.fn(() => ({
            path: '/tmp/happier-relay-runtime.service',
            contents: '[Service]\n',
        })),
        planServiceAction: vi.fn((params: { action: string; label?: string }) => ({
            __action: params.action,
            __label: String(params.label ?? ''),
            writes: [],
            commands: [],
        })),
        applyServicePlan: vi.fn(async (plan: { __action?: string; __label?: string }) => {
            events.push(`${String(plan.__action ?? 'unknown')}:${String(plan.__label ?? '')}`);
        }),
    };
});

describe('installOrUpdateRelayRuntimeLocal legacy root migration', () => {
    it('fails before migrating the legacy install root when the new server binary is missing', async () => {
        events.length = 0;

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-runtime-missing-binary-'));
        try {
            const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');

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

            await mkdir(stableDefaults.installRoot, { recursive: true });
            await writeFile(join(stableDefaults.installRoot, 'legacy.txt'), 'legacy-root\n', 'utf8');
            expect(existsSync(previewDefaults.installRoot)).toBe(false);

            const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
            await expect(installOrUpdateRelayRuntimeLocal({
                serverBinaryPath: join(homeDir, 'missing', 'happier-server'),
                channel: 'preview',
                mode: 'user',
                platform: 'linux',
                arch: 'arm64',
                homeDir,
                runServiceCommands: true,
                skipHealthCheck: true,
            })).rejects.toThrow(/server binary not found/);

            expect(events).not.toContain(`rename:${stableDefaults.installRoot}->${previewDefaults.installRoot}`);
            expect(existsSync(join(stableDefaults.installRoot, 'legacy.txt'))).toBe(true);
            expect(existsSync(previewDefaults.installRoot)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 60_000);

    it('attempts to stop both legacy and canonical service names before renaming the legacy install root', async () => {
        events.length = 0;

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-runtime-legacy-root-migration-'));
        try {
            const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');

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

            await mkdir(stableDefaults.installRoot, { recursive: true });
            await writeFile(join(stableDefaults.installRoot, 'legacy.txt'), 'legacy-root\n', 'utf8');
            expect(existsSync(join(stableDefaults.installRoot, 'self-host-state.json'))).toBe(false);
            expect(existsSync(previewDefaults.installRoot)).toBe(false);

            const payloadRoot = join(homeDir, 'payload');
            const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
            await mkdir(migrationsSourceDir, { recursive: true });
            await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
            const serverBinaryPath = join(payloadRoot, 'happier-server');
            await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
            await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });
            const legacyDefinitionPath = join(homeDir, 'legacy.service');
            await writeFile(legacyDefinitionPath, '[Service]\nExecStart=/legacy\n', 'utf8');

            const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
            await installOrUpdateRelayRuntimeLocal({
                serverBinaryPath,
                channel: 'preview',
                mode: 'user',
                platform: 'linux',
                arch: 'arm64',
                homeDir,
                runServiceCommands: true,
                skipHealthCheck: true,
                legacyServicePriorState: { serviceName: 'happier-server', definitionPath: legacyDefinitionPath, registered: true, active: true, baseUrl: 'http://127.0.0.1:3005' },
            });

            const renameIndex = events.indexOf(`rename:${stableDefaults.installRoot}->${previewDefaults.installRoot}`);
            expect(renameIndex).toBeGreaterThanOrEqual(0);
            const preRenameEvents = events.slice(0, renameIndex);
            expect(preRenameEvents).toContain('stop:happier-server');
            expect(preRenameEvents).toContain('stop:happier-server-preview');
            expect(events.slice(renameIndex + 1)).toContain('uninstall:happier-server');
            expect(events.slice(renameIndex + 1)).toContain('rm-service-definition');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 60_000);

    it('migrates a custom legacy install root into the canonical preview install root', async () => {
        events.length = 0;

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-runtime-custom-legacy-root-'));
        try {
            const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');

            const previewDefaults = resolveRelayRuntimeDefaults({
                platform: 'linux',
                mode: 'user',
                channel: 'preview',
                homeDir,
            });

            const legacyInstallRoot = join(homeDir, '.happier', 'l1');
            await mkdir(legacyInstallRoot, { recursive: true });
            await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
            await writeFile(join(legacyInstallRoot, 'data', 'session-marker.txt'), 'legacy-session\n', 'utf8');
            await writeFile(
                join(legacyInstallRoot, 'self-host-state.json'),
                JSON.stringify({ channel: 'preview', mode: 'user', version: '0.1.2' }) + '\n',
                'utf8',
            );

            const payloadRoot = join(homeDir, 'payload');
            const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
            await mkdir(migrationsSourceDir, { recursive: true });
            await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
            const serverBinaryPath = join(payloadRoot, 'happier-server');
            await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
            await makeRunnableRelayPayload({ payloadRoot, serverBinaryPath });
            const legacyDefinitionPath = join(homeDir, 'legacy.service');
            await writeFile(legacyDefinitionPath, '[Service]\nExecStart=/legacy\n', 'utf8');

            const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
            await installOrUpdateRelayRuntimeLocal({
                serverBinaryPath,
                channel: 'preview',
                mode: 'user',
                platform: 'linux',
                arch: 'arm64',
                homeDir,
                legacyInstallRoot,
                runServiceCommands: true,
                skipHealthCheck: true,
                legacyServicePriorState: { serviceName: 'happier-server', definitionPath: legacyDefinitionPath, registered: true, active: true, baseUrl: 'http://127.0.0.1:3005' },
            });

            const renameIndex = events.indexOf(`rename:${legacyInstallRoot}->${previewDefaults.installRoot}`);
            expect(renameIndex).toBeGreaterThanOrEqual(0);
            expect(events.slice(0, renameIndex)).toContain('stop:happier-server');
            expect(events.slice(0, renameIndex)).toContain('stop:happier-server-preview');
            expect(events.slice(renameIndex + 1)).toContain('uninstall:happier-server');
            expect(events.slice(renameIndex + 1)).toContain('rm-service-definition');
            expect(existsSync(join(previewDefaults.installRoot, 'data', 'session-marker.txt'))).toBe(true);
            expect(existsSync(join(legacyInstallRoot, 'data', 'session-marker.txt'))).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 60_000);
});
