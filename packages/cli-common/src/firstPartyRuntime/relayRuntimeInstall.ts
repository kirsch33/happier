import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 as win32Path } from 'node:path';

import {
    applyServicePlan,
    buildServiceDefinition,
    planServiceAction,
    resolveServiceBackend,
    type ServiceBackend,
    type ServiceSpec,
} from '../service/index.js';

import { checkRelayRuntimeHealth, resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { removeRuntimePayloadPath } from './copyRuntimePayloadTree.js';
import { resolveNonCollidingRelayPort } from './resolveNonCollidingRelayPort.js';
import { computeUiDeploymentDigest, resolveUiDeploymentIdentity } from './uiDeploymentIdentity.js';
import {
    mergeSelfHostServerEnvText,
    parseEnvText,
    renderSelfHostServerEnvText,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';

const RELAY_RUNTIME_PERSISTENT_ROOT_ENTRIES = new Set([
    'config',
    'data',
    'full-server',
    'logs',
    'self-host-state.json',
]);
const DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 120_000;
const MAX_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 600_000;
const RELAY_RUNTIME_STARTUP_RECEIPT_WAIT_MS = 10_000;
const RELAY_RUNTIME_STARTUP_RECEIPT_POLL_MS = 100;
const SERVER_STARTUP_RECEIPT_PATH_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_PATH';
const SERVER_STARTUP_RECEIPT_NONCE_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE';

type LegacyRelayRuntimeInstallRootMigration = Readonly<{
    platform: NodeJS.Platform;
    backend: ServiceBackend;
    homeDir: string;
    migratedInstallRoot: string;
    originalInstallRoot: string;
    runServiceCommands: boolean;
    serverBinaryName: string;
    serviceName: string;
    shimPath: string;
    stdoutPath: string;
    stderrPath: string;
    previousServiceDefinitionPath: string;
    previousServiceDefinitionContents: string;
    previousServiceBaseUrl: string;
}>;

export type LegacyRelayRuntimePriorServiceState = Readonly<{
    serviceName: string;
    definitionPath: string;
    registered: boolean;
    active: boolean;
    baseUrl: string;
}>;

function tryParseJsonObject(text: string): Record<string, unknown> | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function relayRuntimeStateMatchesRequestedLane(params: Readonly<{
    state: Record<string, unknown>;
    channel: 'preview' | 'publicdev';
    mode: 'user' | 'system';
}>): boolean {
    const stateChannel = String(params.state.channel ?? '').trim();
    const stateMode = String(params.state.mode ?? '').trim();
    const channelMatches = stateChannel === params.channel
        || (params.channel === 'publicdev' && stateChannel === 'dev');
    const modeMatches = !stateMode || stateMode === params.mode;
    return channelMatches && modeMatches;
}

export async function shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    legacyInstallRoot?: string;
}>): Promise<boolean> {
    if (params.mode !== 'user') return false;
    if (params.channel === 'stable') return false;

    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    if (existsSync(defaults.installRoot)) return false;

    const legacyDefaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: 'stable',
        homeDir: params.homeDir,
    });
    const legacyInstallRoot = String(params.legacyInstallRoot ?? '').trim() || legacyDefaults.installRoot;
    if (legacyInstallRoot === defaults.installRoot) return false;
    if (!existsSync(legacyInstallRoot)) return false;

    const legacyStatePath = join(legacyInstallRoot, 'self-host-state.json');
    if (!existsSync(legacyStatePath)) return true;

    const legacyStateText = await readFile(legacyStatePath, 'utf8').catch(() => '');
    const legacyState = tryParseJsonObject(legacyStateText);
    return Boolean(legacyState && relayRuntimeStateMatchesRequestedLane({
        state: legacyState,
        channel: params.channel,
        mode: params.mode,
    }));
}

async function migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    runServiceCommands: boolean;
    legacyInstallRoot?: string;
    legacyServicePriorState?: LegacyRelayRuntimePriorServiceState;
}>): Promise<LegacyRelayRuntimeInstallRootMigration | null> {
    const shouldMigrate = await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot(params);
    if (!shouldMigrate) return null;
    const priorServiceState = params.legacyServicePriorState;
    if (!priorServiceState?.registered || !priorServiceState.active || !priorServiceState.definitionPath.trim()) {
        throw new Error('[relay-runtime] legacy relay migration requires a registered and active legacy service; no files were changed');
    }
    if (!priorServiceState.serviceName.trim() || !params.runServiceCommands) {
        throw new Error('[relay-runtime] legacy relay migration requires service commands and an active legacy service; no files were changed');
    }
    const previousServiceDefinitionContents = await readFile(priorServiceState.definitionPath, 'utf8').catch(() => '');
    if (!previousServiceDefinitionContents) {
        throw new Error('[relay-runtime] legacy relay migration could not snapshot its service definition; no files were changed');
    }

    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    const legacyDefaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: 'stable',
        homeDir: params.homeDir,
    });
    const legacyInstallRoot = String(params.legacyInstallRoot ?? '').trim() || legacyDefaults.installRoot;

    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyInstallRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const stdoutPath = join(legacyInstallRoot, 'logs', 'server.out.log');
        const stderrPath = join(legacyInstallRoot, 'logs', 'server.err.log');

        const serviceNamesToStop = new Set([priorServiceState.serviceName, defaults.serviceName]);
        for (const serviceName of serviceNamesToStop) {
            const spec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: legacyInstallRoot,
                serverBinaryPath,
                env: {},
                stdoutPath,
                stderrPath,
            });
            const definition = buildServiceDefinition({
                backend,
                homeDir: params.homeDir,
                spec,
            });
            const stopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: spec.label,
                definitionPath: definition.path,
                persistent: true,
            });
            await applyServicePlan(stopPlan, { runCommands: true }).catch(() => undefined);
        }
    }

    await mkdir(dirname(defaults.installRoot), { recursive: true });
    await rename(legacyInstallRoot, defaults.installRoot);
    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyInstallRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const legacyServiceSpec = buildRelayRuntimeServiceSpec({
            serviceName: priorServiceState.serviceName,
            installRoot: legacyInstallRoot,
            serverBinaryPath,
            env: {},
            stdoutPath: join(legacyInstallRoot, 'logs', 'server.out.log'),
            stderrPath: join(legacyInstallRoot, 'logs', 'server.err.log'),
        });
        const legacyServiceDefinition = buildServiceDefinition({
            backend,
            homeDir: params.homeDir,
            spec: legacyServiceSpec,
        });
        const uninstallLegacyPlan = planServiceAction({
            backend,
            action: 'uninstall',
            label: legacyServiceSpec.label,
            definitionPath: legacyServiceDefinition.path,
            persistent: true,
        });
        await applyServicePlan(uninstallLegacyPlan, { runCommands: true }).catch(() => undefined);
        await rm(priorServiceState.definitionPath, { force: true }).catch(() => undefined);
    }
    const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    return {
        platform: params.platform,
        migratedInstallRoot: defaults.installRoot,
        backend: resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        }),
        homeDir: params.homeDir,
        originalInstallRoot: legacyInstallRoot,
        runServiceCommands: true,
        serverBinaryName,
        serviceName: priorServiceState.serviceName,
        shimPath: join(defaults.binDir, serverBinaryName),
        stdoutPath: join(legacyInstallRoot, 'logs', 'server.out.log'),
        stderrPath: join(legacyInstallRoot, 'logs', 'server.err.log'),
        previousServiceDefinitionPath: priorServiceState.definitionPath,
        previousServiceDefinitionContents,
        previousServiceBaseUrl: priorServiceState.baseUrl,
    };
}

async function rollbackLegacyUnsuffixedRelayRuntimeInstallRootMigration(
    migration: LegacyRelayRuntimeInstallRootMigration,
): Promise<void> {
    if (existsSync(migration.migratedInstallRoot) && !existsSync(migration.originalInstallRoot)) {
        await mkdir(dirname(migration.originalInstallRoot), { recursive: true });
        await rename(migration.migratedInstallRoot, migration.originalInstallRoot);
    }
    if (!existsSync(migration.originalInstallRoot)) return;

    const restoredServerBinaryPath = join(migration.originalInstallRoot, 'bin', migration.serverBinaryName);
    if (existsSync(restoredServerBinaryPath)) {
        await installBinaryShim({
            platform: migration.platform,
            sourcePath: restoredServerBinaryPath,
            destPath: migration.shimPath,
        });
    }

    if (migration.runServiceCommands) {
        const restoreServiceSpec = buildRelayRuntimeServiceSpec({
            serviceName: migration.serviceName,
            installRoot: migration.originalInstallRoot,
            serverBinaryPath: restoredServerBinaryPath,
            env: {},
            stdoutPath: migration.stdoutPath,
            stderrPath: migration.stderrPath,
        });
        await mkdir(dirname(migration.previousServiceDefinitionPath), { recursive: true });
        await writeFile(migration.previousServiceDefinitionPath, migration.previousServiceDefinitionContents, 'utf8');
        const restoreServicePlan = planServiceAction({
            backend: migration.backend,
            action: 'install',
            label: restoreServiceSpec.label,
            definitionPath: migration.previousServiceDefinitionPath,
            definitionContents: migration.previousServiceDefinitionContents,
            persistent: true,
        });
        await applyServicePlan(restoreServicePlan, { runCommands: true }).catch(() => undefined);
    }
}

async function copyDirectoryContents(params: Readonly<{
    sourceDir: string;
    destDir: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    const entries = await readdir(params.sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.name || entry.name === '.' || entry.name === '..') continue;
        if (entry.name.startsWith('._')) continue;
        const sourcePath = join(params.sourceDir, entry.name);
        const destPath = join(params.destDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirectoryContents({ sourceDir: sourcePath, destDir: destPath });
            continue;
        }
        if (entry.isFile()) {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(sourcePath, destPath);
            continue;
        }
        try {
            const info = await stat(sourcePath);
            if (info.isDirectory()) {
                await copyDirectoryContents({ sourceDir: sourcePath, destDir: destPath });
            } else if (info.isFile()) {
                await mkdir(dirname(destPath), { recursive: true });
                await copyFile(sourcePath, destPath);
            }
        } catch {
            continue;
        }
    }
}

function assertRootIfRequired(params: Readonly<{ platform: NodeJS.Platform; mode: 'user' | 'system' }>): void {
    if (params.mode !== 'system') return;
    if (params.platform === 'win32') return;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== 0) {
        throw new Error('[relay-runtime] system install requires root privileges');
    }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'EPERM');
    }
}

async function waitForRelayRuntimeStartupReceipt(params: Readonly<{
    path: string;
    nonce: string;
}>): Promise<Readonly<{ nonce: string; pid: number }>> {
    const deadline = Date.now() + RELAY_RUNTIME_STARTUP_RECEIPT_WAIT_MS;
    while (Date.now() <= deadline) {
        const receipt = await readFile(params.path, 'utf8')
            .then(tryParseJsonObject)
            .catch(() => null);
        const nonce = typeof receipt?.nonce === 'string' ? receipt.nonce : '';
        const pid = typeof receipt?.pid === 'number' && Number.isSafeInteger(receipt.pid)
            ? receipt.pid
            : 0;
        if (nonce === params.nonce && pid > 0 && isProcessAlive(pid)) {
            return { nonce, pid };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RELAY_RUNTIME_STARTUP_RECEIPT_POLL_MS));
    }
    throw new Error('[relay-runtime] relay runtime startup attestation did not arrive');
}

async function probePortOpen(params: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
    return await new Promise((resolve) => {
        const socket = createConnection({
            host: params.host,
            port: params.port,
        });
        const finish = (value: boolean): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(params.timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function fetchJson(params: Readonly<{ url: string; timeoutMs: number }>): Promise<{
    ok: boolean;
    status: number;
    body: unknown;
}> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
        const response = await fetch(params.url, {
            signal: controller.signal,
            headers: {
                accept: 'application/json',
            },
        });
        return {
            ok: response.ok,
            status: response.status,
            body: await response.json().catch(() => ({})),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function resolveRelayRuntimeInstallHealthcheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = String(
        env.HAPPIER_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS
        ?? env.HAPPIER_RELAY_HOST_LOCAL_HEALTHCHECK_TIMEOUT_MS
        ?? '',
    ).trim();
    if (!raw) return DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS;
    }
    return Math.min(MAX_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS, Math.floor(parsed));
}

async function installBinaryShim(params: Readonly<{
    platform: NodeJS.Platform;
    sourcePath: string;
    destPath: string;
}>): Promise<void> {
    await mkdir(dirname(params.destPath), { recursive: true });
    await rm(params.destPath, { force: true });
    if (params.platform !== 'win32') {
        await symlink(params.sourcePath, params.destPath).catch(async () => {
            await copyFile(params.sourcePath, params.destPath);
            await chmod(params.destPath, 0o755).catch(() => undefined);
        });
        return;
    }
    await copyFile(params.sourcePath, params.destPath);
}

async function listRelayRuntimeManagedRootEntries(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    return entries
        .map((entry) => entry.name)
        .filter((name) => name && name !== '.' && name !== '..')
        .filter((name) => !name.startsWith('.relay-runtime-backup-'))
        .filter((name) => !RELAY_RUNTIME_PERSISTENT_ROOT_ENTRIES.has(name));
}

function mergeUniqueEntryNames(...lists: ReadonlyArray<readonly string[]>): string[] {
    const merged = new Set<string>();
    for (const list of lists) {
        for (const entryName of list) {
            if (entryName) {
                merged.add(entryName);
            }
        }
    }
    return [...merged];
}

async function copyNamedRootEntries(params: Readonly<{
    sourceDir: string;
    destDir: string;
    entryNames: readonly string[];
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    for (const entryName of params.entryNames) {
        const sourcePath = join(params.sourceDir, entryName);
        const destPath = join(params.destDir, entryName);
        await removeRuntimePayloadPath(destPath);

        const info = await stat(sourcePath).catch(() => null);
        if (!info) continue;

        if (info.isDirectory()) {
            await copyDirectoryContents({
                sourceDir: sourcePath,
                destDir: destPath,
            });
            continue;
        }

        if (info.isFile()) {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(sourcePath, destPath);
        }
    }
}

async function clearNamedRootEntries(params: Readonly<{
    rootDir: string;
    entryNames: readonly string[];
}>): Promise<void> {
    for (const entryName of params.entryNames) {
        await removeRuntimePayloadPath(join(params.rootDir, entryName));
    }
}

async function installPersistentPayload(params: Readonly<{
    sourceDir: string;
    destDir: string;
    executablePath: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    const desiredEntryNames = await listRelayRuntimeManagedRootEntries(params.sourceDir);
    const existingEntryNames = await listRelayRuntimeManagedRootEntries(params.destDir);
    const entryNamesToReplace = mergeUniqueEntryNames(desiredEntryNames, existingEntryNames);
    await clearNamedRootEntries({
        rootDir: params.destDir,
        entryNames: entryNamesToReplace,
    });
    await copyNamedRootEntries({
        sourceDir: params.sourceDir,
        destDir: params.destDir,
        entryNames: desiredEntryNames,
    });
    if (!existsSync(params.executablePath)) {
        throw new Error(`[relay-runtime] failed to install server binary (${params.executablePath})`);
    }
    await chmod(params.executablePath, 0o755).catch(() => undefined);
}

function resolveRelayRuntimePayloadRootFromServerBinaryPath(serverBinaryPath: string): string {
    const binaryPath = String(serverBinaryPath ?? '').trim();
    const binaryDir = dirname(binaryPath);
    return basename(binaryDir) === 'bin'
        ? dirname(binaryDir)
        : binaryDir;
}

async function prepareRelayRuntimePayloadForInstall(params: Readonly<{
    serverBinaryPath: string;
    serverBinaryName: string;
    profile?: 'light' | 'full';
}>): Promise<Readonly<{
    payloadRoot: string;
    cleanupPath: string | null;
}>> {
    const payloadRoot = resolveRelayRuntimePayloadRootFromServerBinaryPath(params.serverBinaryPath);
    const serverBinaryIsNestedUnderBin = basename(dirname(params.serverBinaryPath)) === 'bin';
    if (serverBinaryIsNestedUnderBin) {
        return {
            payloadRoot,
            cleanupPath: null,
        };
    }

    if (params.profile === 'full') {
        return {
            payloadRoot,
            cleanupPath: null,
        };
    }

    const stagingRoot = await mkdtemp(join(tmpdir(), '.relay-runtime-payload-'));
    try {
        await copyDirectoryContents({
            sourceDir: payloadRoot,
            destDir: stagingRoot,
        });

        const stagedServerBinaryPath = join(stagingRoot, params.serverBinaryName);
        if (!existsSync(stagedServerBinaryPath)) {
            throw new Error(`[relay-runtime] staged server binary missing (${stagedServerBinaryPath})`);
        }

        const stagedBinDir = join(stagingRoot, 'bin');
        await mkdir(stagedBinDir, { recursive: true });
        await rename(stagedServerBinaryPath, join(stagedBinDir, params.serverBinaryName));

        for (const runtimeSidecarName of ['generated', 'node_modules']) {
            const stagedSidecarPath = join(stagingRoot, runtimeSidecarName);
            if (!existsSync(stagedSidecarPath)) continue;
            await rename(stagedSidecarPath, join(stagedBinDir, runtimeSidecarName));
        }
    } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    return {
        payloadRoot: stagingRoot,
        cleanupPath: stagingRoot,
    };
}

async function isRegularFile(path: string): Promise<boolean> {
    return await stat(path).then((info) => info.isFile()).catch(() => false);
}

function resolveFullRuntimeQueryEngineFileName(params: Readonly<{
    platform: NodeJS.Platform;
    arch: string;
}>): string {
    switch (`${params.platform}-${params.arch}`) {
        case 'linux-x64': return 'libquery_engine-debian-openssl-3.0.x.so.node';
        case 'linux-arm64': return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
        case 'darwin-x64': return 'libquery_engine-darwin.dylib.node';
        case 'darwin-arm64': return 'libquery_engine-darwin-arm64.dylib.node';
        case 'win32-x64': return 'query_engine-windows.dll.node';
        default: throw new Error(`[relay-runtime] unsupported full runtime target: ${params.platform}-${params.arch}`);
    }
}

async function validatePreparedRelayRuntimePayload(params: Readonly<{
    payloadRoot: string;
    platform: NodeJS.Platform;
    serverBinaryName: string;
    arch?: string;
    profile?: 'light' | 'full';
}>): Promise<void> {
    const profile = params.profile === 'full' ? 'full' : 'light';
    const binDir = join(params.payloadRoot, 'bin');
    const serverBinaryPath = profile === 'full'
        ? join(params.payloadRoot, params.serverBinaryName)
        : join(binDir, params.serverBinaryName);
    const missing: string[] = [];
    const serverBinary = await stat(serverBinaryPath).catch(() => null);
    if (!serverBinary?.isFile() || (params.platform !== 'win32' && (serverBinary.mode & 0o111) === 0)) {
        missing.push(`executable ${profile === 'full' ? '' : 'bin/'}${params.serverBinaryName}`);
    }

    if (profile === 'full') {
        const executableSuffix = params.platform === 'win32' ? '.exe' : '';
        const engineFileName = resolveFullRuntimeQueryEngineFileName({
            platform: params.platform,
            arch: String(params.arch ?? '').trim() || process.arch,
        });
        const requiredFiles = [
            `happier-server-migrate${executableSuffix}`,
            'prisma/schema.prisma',
            'prisma/migrations/migration_lock.toml',
            'prisma/mysql/schema.prisma',
            'prisma/mysql/migrations/migration_lock.toml',
            `runtime/prisma-migrate${executableSuffix}`,
            `runtime/schema-engine${executableSuffix}`,
            'runtime/prisma_schema_build_bg.wasm',
            'node_modules/.prisma/client/index.js',
            `node_modules/.prisma/client/${engineFileName}`,
            'generated/mysql-client/index.js',
            `generated/mysql-client/${engineFileName}`,
            'ui-web/current/index.html',
        ];
        for (const relativePath of requiredFiles) {
            if (!await isRegularFile(join(params.payloadRoot, relativePath))) missing.push(relativePath);
        }
        for (const migrationsDir of ['prisma/migrations', 'prisma/mysql/migrations']) {
            const entries = await readdir(join(params.payloadRoot, migrationsDir), { withFileTypes: true }).catch(() => []);
            if (!entries.some((entry) => entry.isDirectory())) missing.push(migrationsDir);
        }
        const migrationExecutable = await stat(join(params.payloadRoot, `happier-server-migrate${executableSuffix}`)).catch(() => null);
        if (!migrationExecutable?.isFile() || (params.platform !== 'win32' && (migrationExecutable.mode & 0o111) === 0)) {
            missing.push(`executable happier-server-migrate${executableSuffix}`);
        }
        const prismaPackagePath = join(params.payloadRoot, 'node_modules', '@prisma', 'client');
        const prismaPackage = tryParseJsonObject(await readFile(join(prismaPackagePath, 'package.json'), 'utf8').catch(() => ''));
        const prismaEntrypoint = typeof prismaPackage?.main === 'string' && prismaPackage.main.trim()
            ? prismaPackage.main.trim()
            : 'index.js';
        if (prismaEntrypoint.includes('/') || prismaEntrypoint.includes('\\') || !await isRegularFile(join(prismaPackagePath, prismaEntrypoint))) {
            missing.push('node_modules/@prisma/client usable entrypoint');
        }
        if (missing.length > 0) {
            throw new Error(`[relay-runtime] incomplete full relay runtime payload: missing ${missing.join(', ')}`);
        }
        return;
    }

    const requiredFiles = [
        'node_modules/.prisma/client/index.js',
        'generated/sqlite-client/index.js',
        'generated/mysql-client/index.js',
        'ui-web/current/index.html',
    ];
    for (const relativePath of requiredFiles) {
        if (!await isRegularFile(join(binDir, relativePath)) && relativePath !== 'ui-web/current/index.html') {
            missing.push(`bin/${relativePath}`);
        }
        if (relativePath === 'ui-web/current/index.html' && !await isRegularFile(join(params.payloadRoot, relativePath))) {
            missing.push(relativePath);
        }
    }

    const prismaPackagePath = join(binDir, 'node_modules', '@prisma', 'client');
    const prismaPackageText = await readFile(join(prismaPackagePath, 'package.json'), 'utf8').catch(() => '');
    const prismaPackage = tryParseJsonObject(prismaPackageText);
    const prismaEntrypoint = typeof prismaPackage?.main === 'string' && prismaPackage.main.trim()
        ? prismaPackage.main.trim()
        : 'index.js';
    if (
        prismaEntrypoint.includes('/')
        || prismaEntrypoint.includes('\\')
        || !await isRegularFile(join(prismaPackagePath, prismaEntrypoint))
    ) {
        missing.push('bin/node_modules/@prisma/client usable entrypoint');
    }

    const migrationsDir = join(params.payloadRoot, 'prisma', 'sqlite', 'migrations');
    const migrationEntries = await readdir(migrationsDir, { withFileTypes: true }).catch(() => []);
    const hasMigration = migrationEntries.some((entry) => entry.isDirectory());
    if (!hasMigration) {
        missing.push('prisma/sqlite/migrations');
    }

    if (missing.length > 0) {
        throw new Error(`[relay-runtime] incomplete relay runtime payload: missing ${missing.join(', ')}`);
    }
}

export async function assertRelayRuntimePayloadReadyForInstall(params: Readonly<{
    serverBinaryPath: string;
    platform?: NodeJS.Platform;
    arch?: string;
    profile?: 'light' | 'full';
}>): Promise<void> {
    const platform = (String(params.platform ?? '').trim() || process.platform) as NodeJS.Platform;
    const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const preparedPayload = await prepareRelayRuntimePayloadForInstall({
        serverBinaryPath: params.serverBinaryPath,
        serverBinaryName,
        profile: params.profile,
    });
    try {
        await validatePreparedRelayRuntimePayload({
            payloadRoot: preparedPayload.payloadRoot,
            platform,
            serverBinaryName,
            arch: params.arch,
            profile: params.profile,
        });
    } finally {
        if (preparedPayload.cleanupPath) {
            await rm(preparedPayload.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

async function backupRelayRuntimeInstallState(params: Readonly<{
    installRoot: string;
    payloadDir: string;
    payloadEntryNames: readonly string[];
    serverBinaryName: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
}>): Promise<Readonly<{
    backupRoot: string;
    payloadBackupDir: string | null;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
}>> {
    const backupRoot = await mkdtemp(join(dirname(params.installRoot), '.relay-runtime-backup-'));
    const payloadBackupDir = join(backupRoot, 'payload');
    const migrationsBackupDir = join(backupRoot, 'migrations');
    const existingPayloadEntryNames = params.payloadEntryNames.filter((entryName) => existsSync(join(params.payloadDir, entryName)));
    const hasPayload = existingPayloadEntryNames.length > 0;
    const hasMigrations = existsSync(params.migrationsDir);
    if (hasPayload) {
        await copyNamedRootEntries({
            sourceDir: params.payloadDir,
            destDir: payloadBackupDir,
            entryNames: existingPayloadEntryNames,
        });
    }
    if (hasMigrations) {
        await copyDirectoryContents({
            sourceDir: params.migrationsDir,
            destDir: migrationsBackupDir,
        });
    }
    return {
        backupRoot,
        payloadBackupDir: hasPayload ? payloadBackupDir : null,
        migrationsBackupDir: hasMigrations ? migrationsBackupDir : null,
        previousEnvText: existsSync(params.envPath)
            ? await readFile(params.envPath, 'utf8').catch(() => null)
            : null,
        previousStateText: existsSync(params.statePath)
            ? await readFile(params.statePath, 'utf8').catch(() => null)
            : null,
    };
}

async function restoreRelayRuntimeInstallState(params: Readonly<{
    platform: NodeJS.Platform;
    payloadDir: string;
    payloadEntryNames: readonly string[];
    shimPath: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
    payloadBackupDir: string | null;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
    restoreEnv?: boolean;
}>): Promise<void> {
    await clearNamedRootEntries({
        rootDir: params.payloadDir,
        entryNames: params.payloadEntryNames,
    });
    if (params.payloadBackupDir) {
        const backupEntryNames = await listRelayRuntimeManagedRootEntries(params.payloadBackupDir);
        await copyNamedRootEntries({
            sourceDir: params.payloadBackupDir,
            destDir: params.payloadDir,
            entryNames: backupEntryNames,
        });
    }
    await rm(params.shimPath, { force: true });
    if (params.payloadBackupDir) {
        const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
        const sourcePath = join(params.payloadDir, 'bin', serverBinaryName);
        if (existsSync(sourcePath)) {
            await installBinaryShim({
                platform: params.platform,
                sourcePath,
                destPath: params.shimPath,
            });
        }
    }
    await rm(params.migrationsDir, { recursive: true, force: true });
    if (params.migrationsBackupDir) {
        await copyDirectoryContents({
            sourceDir: params.migrationsBackupDir,
            destDir: params.migrationsDir,
        });
    }
    if (params.restoreEnv !== false) {
        if (typeof params.previousEnvText === 'string') {
            await mkdir(dirname(params.envPath), { recursive: true });
            await writeFile(params.envPath, params.previousEnvText, 'utf8');
        } else {
            await rm(params.envPath, { force: true });
        }
    }
    if (typeof params.previousStateText === 'string') {
        await mkdir(dirname(params.statePath), { recursive: true });
        await writeFile(params.statePath, params.previousStateText, 'utf8');
        return;
    }
    await rm(params.statePath, { force: true });
}

function buildRelayRuntimeServiceSpec(params: Readonly<{
    serviceName: string;
    installRoot: string;
    serverBinaryPath: string;
    env: Record<string, string>;
    environmentFiles?: readonly string[];
    execStartPre?: readonly string[];
    stdoutPath: string;
    stderrPath: string;
}>): ServiceSpec {
    return {
        label: params.serviceName,
        description: `Happier Relay Runtime (${params.serviceName})`,
        programArgs: [params.serverBinaryPath],
        workingDirectory: params.installRoot,
        env: params.env,
        environmentFiles: params.environmentFiles,
        execStartPre: params.execStartPre,
        stdoutPath: params.stdoutPath,
        stderrPath: params.stderrPath,
    };
}

function normalizeRelayRuntimeProfile(profile: 'light' | 'full' | undefined): 'light' | 'full' {
    return profile === 'full' ? 'full' : 'light';
}

function isFullRelayServerEnv(text: string): boolean {
    return /^\s*(HAPPIER_DB_PROVIDER|HAPPY_DB_PROVIDER)\s*=\s*(?:postgres|postgresql|mysql)\s*$/mu.test(text)
        && /^\s*DATABASE_URL\s*=/mu.test(text);
}

async function readRequiredFullRelayServerEnv(path: string): Promise<string> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || (info.mode & 0o777) !== 0o600) {
        throw new Error('[relay-runtime] full relay profile requires an existing owner-readable mode 0600 config/server.env; no files were changed');
    }
    return await readFile(path, 'utf8');
}

async function writeMode0600Atomically(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, text, { encoding: 'utf8', mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export type RelayRuntimeSystemdShowResult = Readonly<{ status: number; stdout: string; stderr: string }>;

export type RelayRuntimeEffectiveDropInReader = (params: Readonly<{
    unitName: string;
    mode: 'system';
}>) => RelayRuntimeSystemdShowResult;

function parseEffectiveSystemdDropInPaths(stdout: string): readonly string[] {
    return String(stdout ?? '')
        .split(/\s+/u)
        .map((value) => value.trim())
        .filter((value) => isAbsolute(value) && value.endsWith('.conf'));
}

export async function preflightFullRelayRuntimeInstall(params: Readonly<{
    platform: NodeJS.Platform;
    backend: ServiceBackend;
    configEnvPath: string;
    serviceName: string;
    env?: Readonly<Record<string, string>>;
    showEffectiveDropIns: RelayRuntimeEffectiveDropInReader;
}>): Promise<void> {
    if (params.platform !== 'linux' || params.backend !== 'systemd-system') {
        throw new Error('[relay-runtime] full relay profile requires Linux systemd system mode; no files were changed');
    }
    if (Object.keys(params.env ?? {}).length > 0) {
        throw new Error('[relay-runtime] full relay profile does not accept environment overrides; no files were changed');
    }
    const fullServerEnv = await readRequiredFullRelayServerEnv(params.configEnvPath);
    if (!isFullRelayServerEnv(fullServerEnv)) {
        throw new Error('[relay-runtime] full relay profile requires a configured Postgres or MySQL server.env; no files were changed');
    }
    const showResult = params.showEffectiveDropIns({ unitName: params.serviceName, mode: 'system' });
    if (showResult.status !== 0) {
        throw new Error('[relay-runtime] unable to inspect effective systemd drop-ins for full relay profile; no files were changed');
    }
    for (const path of parseEffectiveSystemdDropInPaths(showResult.stdout)) {
        const text = await readFile(path, 'utf8').catch(() => null);
        if (text === null) {
            throw new Error('[relay-runtime] unable to inspect effective systemd drop-ins for full relay profile; no files were changed');
        }
        let inService = false;
        for (const line of text.split(/\r?\n/u)) {
            const section = line.match(/^\s*\[([A-Za-z]+)\]\s*$/u);
            if (section) {
                inService = section[1]?.trim() === 'Service';
                continue;
            }
            if (inService && /^\s*(ExecStart|ExecStartPre|WorkingDirectory|EnvironmentFile)\s*=/u.test(line)) {
                throw new Error(`[relay-runtime] full relay profile refuses conflicting systemd drop-in ${basename(path)}; no files were changed`);
            }
        }
    }
}

export async function installOrUpdateRelayRuntimeLocal(params: Readonly<{
    serverBinaryPath: string;
    channel: 'stable' | 'preview' | 'publicdev';
    mode: 'user' | 'system';
    profile?: 'light' | 'full';
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    homeDir?: string;
    arch?: string;
    version?: string | null;
    serviceNameOverride?: string;
    legacyInstallRoot?: string;
    legacyServicePriorState?: LegacyRelayRuntimePriorServiceState;
    runServiceCommands?: boolean;
    skipHealthCheck?: boolean;
    showEffectiveDropIns?: RelayRuntimeEffectiveDropInReader;
}>): Promise<Readonly<{ baseUrl: string; version: string | null }>> {
    const platform = (String(params.platform ?? '').trim() || process.platform) as NodeJS.Platform;
    const homeDir = String(params.homeDir ?? '').trim() || homedir();
    const arch = String(params.arch ?? '').trim() || process.arch;
    const mode = params.mode === 'system' ? 'system' : 'user';
    const profile = normalizeRelayRuntimeProfile(params.profile);

    assertRootIfRequired({ platform, mode });

    const defaults = resolveRelayRuntimeDefaults({
        platform,
        mode,
        channel: params.channel,
        homeDir,
    });
    const serviceName = String(params.serviceNameOverride ?? '').trim() || defaults.serviceName;
    const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const installServerBinaryPath = join(
        defaults.installRoot,
        ...(profile === 'full' ? [serverBinaryName] : ['bin', serverBinaryName]),
    );
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const configEnvPath = join(defaults.configDir, 'server.env');
    const runtimeEnvPath = join(defaults.configDir, 'runtime.env');
    const filesDir = join(defaults.dataDir, 'files');
    const dbDir = join(defaults.dataDir, 'pglite');
    const migrationsDir = join(defaults.dataDir, 'migrations', 'sqlite');
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');
    const startupReceiptPath = join(defaults.dataDir, 'startup-receipt.json');
    const startupReceiptNonce = randomUUID();
    const backend: ServiceBackend = resolveServiceBackend({
        platform,
        mode,
    });
    if (profile === 'full') {
        if (!params.showEffectiveDropIns) {
            throw new Error('[relay-runtime] unable to inspect effective systemd drop-ins for full relay profile; no files were changed');
        }
        await preflightFullRelayRuntimeInstall({
            platform,
            backend,
            configEnvPath,
            serviceName,
            env: params.env,
            showEffectiveDropIns: params.showEffectiveDropIns,
        });
    } else if (existsSync(configEnvPath)) {
        const existingConfig = await readFile(configEnvPath, 'utf8').catch(() => '');
        if (isFullRelayServerEnv(existingConfig)) {
            throw new Error('[relay-runtime] existing full relay configuration detected; rerun with --profile full. No files were changed.');
        }
    }
    const previousServiceSpec = buildRelayRuntimeServiceSpec({
        serviceName,
        installRoot: defaults.installRoot,
        serverBinaryPath: installServerBinaryPath,
        env: {},
        stdoutPath,
        stderrPath,
    });
    const previousServiceDefinition = buildServiceDefinition({
        backend,
        homeDir,
        spec: previousServiceSpec,
    });
    const previousServiceDefinitionExisted = existsSync(previousServiceDefinition.path);

    if (!existsSync(params.serverBinaryPath)) {
        throw new Error('[relay-runtime] server binary not found');
    }

    const preparedPayload = await prepareRelayRuntimePayloadForInstall({
        serverBinaryPath: params.serverBinaryPath,
        serverBinaryName,
        profile,
    });
    const previousServiceDefinitionContents = previousServiceDefinitionExisted
        ? await readFile(previousServiceDefinition.path, 'utf8')
        : null;
    try {
        await validatePreparedRelayRuntimePayload({
            payloadRoot: preparedPayload.payloadRoot,
            platform,
            serverBinaryName,
            arch,
            profile,
        });
    } catch (error) {
        if (preparedPayload.cleanupPath) {
            await rm(preparedPayload.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
    }
    const desiredPayloadEntryNames = await listRelayRuntimeManagedRootEntries(preparedPayload.payloadRoot);
    let payloadEntryNames = desiredPayloadEntryNames;
    let legacyRootMigration: LegacyRelayRuntimeInstallRootMigration | null = null;
    let previousInstallState: Awaited<ReturnType<typeof backupRelayRuntimeInstallState>> | null = null;
    let candidateServiceActivationAttempted = false;
    let candidateServiceDefinitionPath: string | null = null;
    let previousRuntimeEnvText: string | null = null;
    let previousRuntimeEnvMode: number | null = null;
    let runtimeEnvWritten = false;

    try {
        legacyRootMigration = await migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded({
            platform,
            mode,
            channel: params.channel,
            homeDir,
            runServiceCommands: params.runServiceCommands !== false,
            legacyInstallRoot: params.legacyInstallRoot,
            legacyServicePriorState: params.legacyServicePriorState,
        });

        await mkdir(defaults.installRoot, { recursive: true });
        await mkdir(defaults.configDir, { recursive: true });
        await mkdir(defaults.dataDir, { recursive: true });
        if (profile === 'light') {
            await mkdir(filesDir, { recursive: true });
            await mkdir(dbDir, { recursive: true });
        }
        await mkdir(defaults.logDir, { recursive: true });

        const existingPayloadEntryNames = await listRelayRuntimeManagedRootEntries(defaults.installRoot);
        payloadEntryNames = mergeUniqueEntryNames(desiredPayloadEntryNames, existingPayloadEntryNames);
        previousInstallState = await backupRelayRuntimeInstallState({
            installRoot: defaults.installRoot,
            payloadDir: defaults.installRoot,
            payloadEntryNames,
            serverBinaryName,
            migrationsDir,
            envPath: configEnvPath,
            statePath,
        });

        if (params.runServiceCommands !== false) {
            const stopServiceSpec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: defaults.installRoot,
                serverBinaryPath: installServerBinaryPath,
                env: {},
                stdoutPath,
                stderrPath,
            });
            const stopDefinition = buildServiceDefinition({
                backend,
                homeDir,
                spec: stopServiceSpec,
            });
            const stopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: stopServiceSpec.label,
                definitionPath: stopDefinition.path,
                persistent: true,
            });
            await applyServicePlan(stopPlan, {
                runCommands: true,
            });
        }

        const payloadRoot = preparedPayload.payloadRoot;
        const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations');
        if (profile === 'light' && existsSync(migrationsSourceDir)) {
            await mkdir(migrationsDir, { recursive: true });
            await copyDirectoryContents({
                sourceDir: migrationsSourceDir,
                destDir: migrationsDir,
            });
        }

        await installPersistentPayload({
            sourceDir: payloadRoot,
            destDir: defaults.installRoot,
            executablePath: installServerBinaryPath,
        });
        await installBinaryShim({
            platform,
            sourcePath: installServerBinaryPath,
            destPath: join(defaults.binDir, serverBinaryName),
        });

        const uiDir = platform === 'win32'
            ? win32Path.join(defaults.installRoot, 'ui-web', 'current')
            : join(defaults.installRoot, 'ui-web', 'current');
        const uiIndexPath = join(uiDir, 'index.html');
        const uiDeployment = existsSync(uiIndexPath)
            ? resolveUiDeploymentIdentity({
                digest: await computeUiDeploymentDigest(uiDir),
                previousStateText: previousInstallState.previousStateText,
                generateId: randomUUID,
            })
            : null;

        // Upstream callers (relayHostEngine.installLocal) inject the resolved
        // PORT into params.env when they pick a non-default port to avoid
        // sibling-channel collisions. Fall back here to an independent
        // collision-avoidance pass for callers that invoke this function
        // directly (tests, SSH installers, tooling) — the helper is cheap and
        // idempotent when params.env.PORT is already set.
        const existingEnvText = existsSync(configEnvPath) ? await readFile(configEnvPath, 'utf8').catch(() => '') : '';
        const envText = await (async () => {
            if (profile === 'full') return existingEnvText;
            const existingPortRaw = existingEnvText ? String((parseEnvText(existingEnvText).PORT ?? '')).trim() : '';
            const overridePortRaw = String((params.env ?? {}).PORT ?? '').trim();
            const configuredPortRaw = overridePortRaw || existingPortRaw;
            const configuredPort = configuredPortRaw
              ? (Number.isInteger(Number.parseInt(configuredPortRaw, 10)) ? Number.parseInt(configuredPortRaw, 10) : null)
              : null;
            const resolvedPort = await resolveNonCollidingRelayPort({
              platform,
              mode,
              channel: params.channel,
              homeDir,
              defaultPort: defaults.serverPort,
              configuredPort,
            });
            const baseEnvText = renderSelfHostServerEnvText({
                port: resolvedPort,
                host: defaults.serverHost,
                dataDir: defaults.dataDir,
                filesDir,
                dbDir,
                uiDir,
                uiDeploymentId: uiDeployment?.deploymentId,
                serverBinDir: dirname(installServerBinaryPath),
                arch,
                platform,
            });
            const nextEnvText = mergeSelfHostServerEnvText({
                baseEnvText,
                existingEnvText,
                overrides: params.env,
            });
            await writeFile(configEnvPath, nextEnvText, 'utf8');
            return nextEnvText;
        })();
        const env = parseEnvText(envText);

        await rm(startupReceiptPath, { force: true });
        if (profile === 'full') {
            const priorRuntimeInfo = await stat(runtimeEnvPath).catch(() => null);
            previousRuntimeEnvText = priorRuntimeInfo?.isFile()
                ? await readFile(runtimeEnvPath, 'utf8').catch(() => null)
                : null;
            previousRuntimeEnvMode = priorRuntimeInfo?.isFile() ? priorRuntimeInfo.mode & 0o777 : null;
            const runtimeVersion = typeof params.version === 'string' && params.version.trim()
                ? params.version.trim().replace(/[\r\n]/gu, '')
                : 'unknown';
            const runtimeEnvText = [
                `HAPPIER_RELAY_RUNTIME_VERSION=${runtimeVersion}`,
                `HAPPIER_RELAY_RUNTIME_PATH=${defaults.installRoot}`,
                `${SERVER_STARTUP_RECEIPT_PATH_ENV}=${startupReceiptPath}`,
                `${SERVER_STARTUP_RECEIPT_NONCE_ENV}=${startupReceiptNonce}`,
                '',
            ].join('\n');
            await writeMode0600Atomically(runtimeEnvPath, runtimeEnvText);
            runtimeEnvWritten = true;
        }
        const serviceSpec = buildRelayRuntimeServiceSpec({
            serviceName,
            installRoot: defaults.installRoot,
            serverBinaryPath: installServerBinaryPath,
            env: profile === 'full' ? {} : {
                ...env,
                [SERVER_STARTUP_RECEIPT_PATH_ENV]: startupReceiptPath,
                [SERVER_STARTUP_RECEIPT_NONCE_ENV]: startupReceiptNonce,
            },
            ...(profile === 'full' ? {
                environmentFiles: [configEnvPath, runtimeEnvPath],
                execStartPre: [join(defaults.installRoot, platform === 'win32' ? 'happier-server-migrate.exe' : 'happier-server-migrate')],
            } : {}),
            stdoutPath,
            stderrPath,
        });
        const definition = buildServiceDefinition({
            backend,
            homeDir,
            spec: serviceSpec,
        });
        const plan = planServiceAction({
            backend,
            action: 'install',
            label: serviceSpec.label,
            definitionPath: definition.path,
            definitionContents: definition.contents,
            persistent: true,
        });
        candidateServiceActivationAttempted = params.runServiceCommands !== false;
        candidateServiceDefinitionPath = definition.path;
        await applyServicePlan(plan, {
            runCommands: params.runServiceCommands !== false,
        });

        const state = {
            channel: params.channel,
            mode,
            version: typeof params.version === 'string' && params.version.trim() ? params.version.trim() : null,
            updatedAt: new Date().toISOString(),
            ...(uiDeployment ? {
                uiDeploymentDigest: uiDeployment.digest,
                uiDeploymentId: uiDeployment.deploymentId,
            } : {}),
        };
        const baseUrl = resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
            envText,
        });
        if (params.skipHealthCheck !== true && params.runServiceCommands !== false) {
            const baseUrlObject = new URL(baseUrl);
            const result = await checkRelayRuntimeHealth({
                host: baseUrlObject.hostname,
                port: Number.parseInt(baseUrlObject.port, 10),
                timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
                fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
            });
            if (!result.reachable) {
                throw new Error(`[relay-runtime] relay runtime did not become healthy (${result.url})`);
            }
            await waitForRelayRuntimeStartupReceipt({
                path: startupReceiptPath,
                nonce: startupReceiptNonce,
            });
        }

        await writeJsonFile(statePath, state);

        return {
            baseUrl,
            version: state.version,
        };
    } catch (error) {
        await rm(startupReceiptPath, { force: true }).catch(() => undefined);
        if (runtimeEnvWritten) {
            if (typeof previousRuntimeEnvText === 'string') {
                await writeMode0600Atomically(runtimeEnvPath, previousRuntimeEnvText);
                if (previousRuntimeEnvMode !== null) {
                    await chmod(runtimeEnvPath, previousRuntimeEnvMode);
                }
            } else {
                await rm(runtimeEnvPath, { force: true }).catch(() => undefined);
            }
        }
        if (candidateServiceActivationAttempted) {
            const candidateStopSpec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: defaults.installRoot,
                serverBinaryPath: installServerBinaryPath,
                env: {},
                stdoutPath,
                stderrPath,
            });
            const candidateStopDefinition = buildServiceDefinition({
                backend,
                homeDir,
                spec: candidateStopSpec,
            });
            const candidateStopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: candidateStopSpec.label,
                definitionPath: candidateStopDefinition.path,
                persistent: true,
            });
            await applyServicePlan(candidateStopPlan, { runCommands: true });
        }
        if (previousInstallState) {
            await restoreRelayRuntimeInstallState({
                platform,
                payloadDir: defaults.installRoot,
                payloadEntryNames,
                shimPath: join(defaults.binDir, serverBinaryName),
                migrationsDir,
                envPath: configEnvPath,
                statePath,
                payloadBackupDir: previousInstallState.payloadBackupDir,
                migrationsBackupDir: previousInstallState.migrationsBackupDir,
                previousEnvText: previousInstallState.previousEnvText,
                previousStateText: previousInstallState.previousStateText,
                restoreEnv: profile !== 'full',
            });

            const hasPreviousServerPayload = previousInstallState.payloadBackupDir !== null
                && (
                    existsSync(join(previousInstallState.payloadBackupDir, 'bin', serverBinaryName))
                    || existsSync(join(previousInstallState.payloadBackupDir, serverBinaryName))
                );
            const legacyDefinitionIsNormalTarget = legacyRootMigration?.previousServiceDefinitionPath === previousServiceDefinition.path;
            if (!legacyDefinitionIsNormalTarget && previousServiceDefinitionContents !== null && hasPreviousServerPayload) {
                const restorePlan = planServiceAction({
                    backend,
                    action: 'install',
                    label: serviceName,
                    definitionPath: previousServiceDefinition.path,
                    definitionContents: previousServiceDefinitionContents,
                    persistent: true,
                });
                await applyServicePlan(restorePlan, {
                    runCommands: params.runServiceCommands !== false,
                });
                if (params.runServiceCommands !== false && params.skipHealthCheck !== true) {
                    const rollbackBaseUrl = resolveConfiguredSelfHostBaseUrl({
                        fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
                        envText: previousInstallState.previousEnvText ?? '',
                    });
                    const rollbackBaseUrlObject = new URL(rollbackBaseUrl);
                    const rollbackHealth = await checkRelayRuntimeHealth({
                        host: rollbackBaseUrlObject.hostname,
                        port: Number.parseInt(rollbackBaseUrlObject.port, 10),
                        timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                        probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
                        fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
                    });
                    if (!rollbackHealth.reachable) {
                        throw new Error(`[relay-runtime] previous relay runtime did not become healthy after rollback (${rollbackHealth.url})`, {
                            cause: error,
                        });
                    }
                }
            } else if (!legacyDefinitionIsNormalTarget && params.runServiceCommands !== false) {
                const rollbackSpec = buildRelayRuntimeServiceSpec({
                    serviceName,
                    installRoot: defaults.installRoot,
                    serverBinaryPath: installServerBinaryPath,
                    env: {},
                    stdoutPath,
                    stderrPath,
                });
                const rollbackDefinition = buildServiceDefinition({
                    backend,
                    homeDir,
                    spec: rollbackSpec,
                });
                const rollbackPlan = planServiceAction({
                    backend,
                    action: 'uninstall',
                    label: rollbackSpec.label,
                    definitionPath: rollbackDefinition.path,
                    persistent: true,
                });
                await applyServicePlan(rollbackPlan, {
                    runCommands: true,
                });
                if (!previousServiceDefinitionExisted) {
                    await rm(rollbackDefinition.path, { force: true }).catch(() => undefined);
                }
            }
        }
        // A definition write is independent from command activation: applyServicePlan
        // still materializes it when callers deliberately suppress service commands.
        if (!previousServiceDefinitionExisted && candidateServiceDefinitionPath) {
            await rm(candidateServiceDefinitionPath, { force: true }).catch(() => undefined);
        }
        if (legacyRootMigration) {
            if (previousInstallState) {
                await rm(previousInstallState.backupRoot, { recursive: true, force: true }).catch(() => undefined);
            }
            await rollbackLegacyUnsuffixedRelayRuntimeInstallRootMigration(legacyRootMigration);
            if (legacyRootMigration.runServiceCommands) {
                const rollbackBaseUrlObject = new URL(legacyRootMigration.previousServiceBaseUrl);
                const rollbackHealth = await checkRelayRuntimeHealth({
                    host: rollbackBaseUrlObject.hostname,
                    port: Number.parseInt(rollbackBaseUrlObject.port, 10),
                    timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                    probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
                    fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
                });
                if (!rollbackHealth.reachable) {
                    throw new Error(`[relay-runtime] previous legacy relay runtime did not become healthy after rollback (${rollbackHealth.url})`, {
                        cause: error,
                    });
                }
            }
        }
        throw error;
    } finally {
        if (preparedPayload.cleanupPath) {
            await rm(preparedPayload.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
        }
        if (previousInstallState) {
            await rm(previousInstallState.backupRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
