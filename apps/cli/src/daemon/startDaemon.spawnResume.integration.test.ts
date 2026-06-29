import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from './platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { resolveConnectedServiceSwitchContinuity } from '@/backends/catalog';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
  parseSessionConnectedServicesBindingsJson,
} from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';
import { isSessionRunnerActive } from './sessions/isSessionRunnerActive';
import type { ConnectedServicesMaterializationDiagnostic } from './connectedServices/materialize/providerMaterializerTypes';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

function createRegisteredMachine(machineId: string) {
  return {
    id: machineId,
    encryptionKey: new Uint8Array([1, 2, 3, 4]),
    encryptionVariant: 'legacy' as const,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const { spawnChildProcess } = vi.hoisted(() => ({
  spawnChildProcess: vi.fn(() => ({
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

const spawnHappyCliCapture = vi.hoisted(() => ({
  children: [] as Array<{
    pid: number;
    stdout: null;
    stderr: null;
    on: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  }>,
}));
const resolveConnectedServiceAuthForSpawnMock = vi.hoisted(() => vi.fn(async (): Promise<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  connectedServicesBindings?: {
    v: 1;
    bindingsByServiceId: Record<string, unknown>;
  };
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}> => ({
  env: { CLAUDE_CONFIG_DIR: '/tmp/claude-connected' },
  cleanupOnFailure: null,
  cleanupOnExit: null,
})));
const updateSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn(async (params: {
  rawSession: { metadataVersion?: number };
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
}) => ({
  version: (params.rawSession.metadataVersion ?? 0) + 1,
  metadata: params.updater({}),
})));
const pendingMaterializationRpcMocks = vi.hoisted(() => {
  const ctx = { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' as const };
  return {
    ctx,
    callSessionRpc: vi.fn(async () => ({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    })),
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true,
      sessionId: 'sess_plain',
      rawSession: {
        id: 'sess_plain',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain' as const,
      ctx,
    })),
  };
});
const stopSessionMocks = vi.hoisted(() => {
  const stopSession = vi.fn(async () => true);
  return {
    stopSession,
    createStopSession: vi.fn(() => stopSession),
  };
});
const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let spawnSessionRef: ((options: any) => Promise<any>) | null = null;
  let stopSessionRef: ((sessionId: string) => Promise<boolean>) | null = null;
  let prepareStopSessionRef: ((child: any) => Promise<void> | void) | null = null;
  let beforeShutdownRef: (() => Promise<void>) | null = null;
  let isShuttingDownRef: (() => boolean) | null = null;
  let turnLifecycleHandlerRef: ((input: {
    sessionId: string;
    event: string;
    terminalStatus?: string;
  }) => Promise<unknown>) | null = null;

  const createDaemonShutdownController = vi.fn(() => {
    const resolvesWhenShutdownRequested = new Promise<{ source: ShutdownSource; errorMessage?: string }>((resolve) => {
      resolveShutdown = resolve;
    });
    const requestShutdown = (source: ShutdownSource, errorMessage?: string) => {
      resolveShutdown?.({ source, errorMessage });
    };
    requestShutdownRef = requestShutdown;
    return {
      requestShutdown,
      resolvesWhenShutdownRequested,
    };
  });

  const apiMachine = {
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionStateChange: vi.fn(() => () => {}),
    connect: vi.fn(),
    updateMachineMetadata: vi.fn(async () => {}),
    updateDaemonState: vi.fn(async () => {}),
    awaitPendingRpcRequests: vi.fn(async () => {}),
    shutdown: vi.fn(),
  };

  return {
    apiMachine,
    createDaemonShutdownController,
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    setSpawnSession: (fn: (options: any) => Promise<any>) => {
      spawnSessionRef = fn;
    },
    getSpawnSession: () => spawnSessionRef,
    setStopSession: (fn: (sessionId: string) => Promise<boolean>) => {
      stopSessionRef = fn;
    },
    getStopSession: () => stopSessionRef,
    setPrepareStopSession: (fn: (child: any) => Promise<void> | void) => {
      prepareStopSessionRef = fn;
    },
    getPrepareStopSession: () => prepareStopSessionRef,
    setBeforeShutdown: (fn: () => Promise<void>) => {
      beforeShutdownRef = fn;
    },
    getBeforeShutdown: () => beforeShutdownRef,
    setIsShuttingDown: (fn: () => boolean) => {
      isShuttingDownRef = fn;
    },
    getIsShuttingDown: () => isShuttingDownRef,
    setTurnLifecycleHandler: (fn: (input: {
      sessionId: string;
      event: string;
      terminalStatus?: string;
    }) => Promise<unknown>) => {
      turnLifecycleHandlerRef = fn;
    },
    getTurnLifecycleHandler: () => turnLifecycleHandlerRef,
    resetControlRefs: () => {
      spawnSessionRef = null;
      stopSessionRef = null;
      prepareStopSessionRef = null;
      beforeShutdownRef = null;
      isShuttingDownRef = null;
      turnLifecycleHandlerRef = null;
    },
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      machineSyncClient: () => harness.apiMachine,
    })),
  },
  isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnChildProcess,
  };
});

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-daemon.log',
  },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({
    credentials: {
      token: 'token-daemon',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    },
    machineId: 'machine-1',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/happy-home',
    activeServerDir: '/tmp/happy-home/servers/active',
    currentCliVersion: '0.0.0-test',
    serverUrl: 'http://localhost:9999',
    daemonSpawnExistingSessionWaitForExitMs: 5_000,
    daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
    daemonReattachCatchUpConcurrency: 4,
    daemonStopSessionWaitForExitMs: 15_000,
    daemonStopSessionWaitForExitPollIntervalMs: 100,
  },
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

const spawnHappyCLI = vi.fn((argv: string[], _opts?: unknown) => {
  const child = {
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    unref: vi.fn(),
  };
  spawnHappyCliCapture.children.push(child);
  return child;
});

const cgroupMigrationCapture = vi.hoisted(() => {
  const capture = {
    lastParams: null as null | { trackedSessions: Iterable<{ pid: number }> },
    migrateTrackedSessionProcessesOutOfDaemonServiceCgroup: vi.fn(async (params: { trackedSessions: Iterable<{ pid: number }> }) => {
      capture.lastParams = params;
      return [];
    }),
  };
  return capture;
});

const sessionRespawnManagerCapture = vi.hoisted(() => {
  const capture = {
    instances: [] as Array<{
      markStopRequested: ReturnType<typeof vi.fn>;
      clearStopRequested: ReturnType<typeof vi.fn>;
      handleUnexpectedExit: ReturnType<typeof vi.fn>;
      __params: { enabled: boolean };
    }>,
    createSessionRunnerRespawnManager: vi.fn((params: { enabled: boolean }) => {
      const manager = {
        markStopRequested: vi.fn(),
        clearStopRequested: vi.fn(),
        handleUnexpectedExit: vi.fn(),
        __params: params,
      };
      capture.instances.push(manager);
      return manager;
    }),
  };
  return capture;
});
const providerActivityRecorderCapture = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  createConnectedServiceProviderActivityProofRecorder: vi.fn(() => providerActivityRecorderCapture.record),
}));

const buildCgroupSelfMigratingHappyCliLaunchSpec = vi.hoisted(() => vi.fn(async () => ({
  filePath: '/bin/sh',
  args: [
    '-lc',
    'target_dir="$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/happier-session-$$.scope" && mkdir -p "$target_dir" && printf "%s\\n" "$$" > "$target_dir/cgroup.procs" && exec "$@"',
    'sh',
    '/tmp/happier-runtime',
    'codex',
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
  ],
  env: {
    HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR: '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/app.slice',
  },
})));

const applySpawnedChildOomScoreAdjustmentMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  spawnHappyCLI,
}));

vi.mock('./platform/linux/applySpawnedChildOomScoreAdjustment', () => ({
  applySpawnedChildOomScoreAdjustment: applySpawnedChildOomScoreAdjustmentMock,
}));

vi.mock('./platform/linux/migrateTrackedSessionProcessesOutOfDaemonServiceCgroup', () => ({
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup: cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
}));

vi.mock('./platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec', () => ({
  buildCgroupSelfMigratingHappyCliLaunchSpec,
}));

vi.mock('./processSupervision/sessionRunnerRespawn', () => ({
  createSessionRunnerRespawnManager: sessionRespawnManagerCapture.createSessionRunnerRespawnManager,
}));

vi.mock('./connectedServices/recovery/providerActivityProofRecorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connectedServices/recovery/providerActivityProofRecorder')>();
  return {
    ...actual,
    createConnectedServiceProviderActivityProofRecorder:
      providerActivityRecorderCapture.createConnectedServiceProviderActivityProofRecorder,
  };
});

vi.mock('./platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: vi.fn(() => 'hidden'),
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(async () => ({ ok: true, pid: 7777 })),
}));

vi.mock('./platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: vi.fn(async () => ({ ok: true, pid: 8888 })),
}));

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    AGENTS: {
      ...actual.AGENTS,
      codex: {
        ...actual.AGENTS.codex,
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'supported',
      },
      claude: {
        ...actual.AGENTS.claude,
        id: 'claude',
        cliSubcommand: 'claude',
        vendorResumeSupport: 'supported',
      },
    },
    requireCatalogEntry: vi.fn((agentId: string = 'codex') => ({
      id: agentId === 'claude' ? 'claude' : 'codex',
      cliSubcommand: agentId === 'claude' ? 'claude' : 'codex',
      vendorResumeSupport: 'supported',
    })),
    getVendorResumeSupport: vi.fn(async () => () => true),
    resolveConnectedServiceSwitchContinuity: vi.fn(async (_agentId: string, { serviceId }: { serviceId: string }) => (
      serviceId === 'anthropic' || serviceId === 'claude-subscription'
        ? { mode: 'restart_same_home' }
        : { mode: 'unsupported', reason: 'unsupported_service' }
    )),
    resolveAgentCliSubcommand: vi.fn((agentId: string = 'codex') => (agentId === 'claude' ? 'claude' : 'codex')),
    resolveCatalogAgentId: vi.fn((agentId: string = 'codex') => (agentId === 'claude' ? 'claude' : 'codex')),
    resolveCatalogAgentIdForCliSubcommand: vi.fn((subcommand: string) => {
      const normalized = subcommand.trim();
      return normalized === 'opencode' ? 'opencode' : normalized === 'claude' ? 'claude' : 'codex';
    }),
  };
});

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('./connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connectedServices/resolveConnectedServiceAuthForSpawn')>();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: resolveConnectedServiceAuthForSpawnMock,
  };
});

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  stopDaemon: vi.fn(async () => {}),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async ({
    spawnSession,
    stopSession,
    prepareStopSession,
    beforeShutdown,
    isShuttingDown,
    handleConnectedServiceTurnLifecycle,
  }: {
    spawnSession: (options: any) => Promise<any>;
    stopSession: (sessionId: string) => Promise<boolean>;
    prepareStopSession?: (child: any) => Promise<void> | void;
    beforeShutdown?: () => Promise<void>;
    isShuttingDown?: () => boolean;
    handleConnectedServiceTurnLifecycle?: (input: {
      sessionId: string;
      event: string;
      terminalStatus?: string;
    }) => Promise<unknown>;
  }) => {
    harness.setSpawnSession(spawnSession);
    harness.setStopSession(stopSession);
    if (prepareStopSession) {
      harness.setPrepareStopSession(prepareStopSession);
    }
    if (beforeShutdown) {
      harness.setBeforeShutdown(beforeShutdown);
    }
    if (isShuttingDown) {
      harness.setIsShuttingDown(isShuttingDown);
    }
    if (handleConnectedServiceTurnLifecycle) {
      harness.setTurnLifecycleHandler(handleConnectedServiceTurnLifecycle);
    }
    return {
      port: 43210,
      stop: vi.fn(async () => {}),
    };
  }),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
  reattachTrackedSessionsFromMarkers: vi.fn(async () => ({
    orphanedDeadDaemonSessions: [],
    connectedServiceRestartIntents: [],
  })),
  shouldRestartTerminalPromptInjectionRuntime: vi.fn((spawnOptions: any, vendorResumeId?: string | null) => {
    const agentId = spawnOptions?.backendTarget?.kind === 'builtInAgent'
      ? spawnOptions.backendTarget.agentId
      : null;
    const resume = typeof spawnOptions?.resume === 'string' && spawnOptions.resume.trim()
      ? spawnOptions.resume.trim()
      : typeof vendorResumeId === 'string'
        ? vendorResumeId.trim()
        : '';
    return agentId === 'claude' && !!resume;
  }),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/isSessionRunnerActive', () => ({
  isSessionRunnerActive: vi.fn(async () => false),
}));

vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  materializeNextPendingQueueV2MessageViaHttp: vi.fn(async () => ({
    didMaterialize: false,
    localId: null,
    didWrite: false,
  })),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: pendingMaterializationRpcMocks.callSessionRpc,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: pendingMaterializationRpcMocks.resolveSessionTransportContext,
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_visible_console' })),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: stopSessionMocks.createStopSession,
}));

vi.mock('./sessions/resolveSpawnWebhookResult', () => ({
  resolveSpawnWebhookResult: vi.fn(({ result }: { result: any }) => result),
}));

vi.mock('./lifecycle/heartbeat', () => ({
  startDaemonHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('@/projectPath', () => ({
  projectPath: vi.fn(() => '/tmp/project'),
}));

vi.mock('@/integrations/tmux', () => ({
  selectPreferredTmuxSessionName: vi.fn(),
  TmuxUtilities: {},
  isTmuxAvailable: vi.fn(async () => false),
}));

vi.mock('./lifecycle/shutdown', () => ({
  createDaemonShutdownController: harness.createDaemonShutdownController,
}));

vi.mock('./startup/waitForAuthConfig', () => ({
  resolveWaitForAuthConfig: vi.fn(() => ({
    waitForAuthEnabled: false,
    waitForAuthTimeoutMs: 0,
  })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
  waitForInitialCredentials: vi.fn(async () => ({
    action: 'continue',
    daemonLockHandle: { release: vi.fn(async () => {}) },
  })),
}));

vi.mock('./startup/ensureSessionDirectory', () => ({
  ensureSessionDirectory: vi.fn(async () => ({ ok: true, directoryCreated: false })),
}));

vi.mock('./spawn/waitForSessionWebhook', () => ({
  waitForSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_plain' })),
}));

vi.mock('./automation/automationWorker', () => ({
  startAutomationWorker: vi.fn(() => ({
    stop: vi.fn(),
    refreshAssignments: vi.fn(async () => {}),
    handleServerUpdate: vi.fn(),
  })),
}));

vi.mock('./memory/memoryWorker', () => ({
  startMemoryWorker: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(async () =>
    createSessionRecordFixture({
      id: 'sess_plain',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'vendor-plain-1', path: '/tmp' }),
      dataEncryptionKey: null,
    }),
  ),
}));

vi.mock('./sessionAttachFile', () => ({
  createSessionAttachFile: vi.fn(async () => ({
    filePath: '/tmp/attach.json',
    cleanup: vi.fn(async () => {}),
  })),
}));

vi.mock('./machine/metadata', () => ({
  getPreferredHostName: vi.fn(async () => 'host.local'),
  initialMachineMetadata: {},
}));

vi.mock('./connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => false),
}));

describe('startDaemon spawn resume wiring (integration)', () => {
  async function waitForSpawnSessionRegistration() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const spawnSession = harness.getSpawnSession();
      if (spawnSession) {
        return spawnSession;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected spawnSession to be registered');
  }

  afterEach(() => {
    vi.restoreAllMocks();
    harness.resetControlRefs();
    spawnHappyCLI.mockClear();
    spawnHappyCliCapture.children.length = 0;
    spawnChildProcess.mockClear();
    buildCgroupSelfMigratingHappyCliLaunchSpec.mockClear();
    applySpawnedChildOomScoreAdjustmentMock.mockClear();
    cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup.mockClear();
    cgroupMigrationCapture.lastParams = null;
    sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mockClear();
    sessionRespawnManagerCapture.instances.length = 0;
    providerActivityRecorderCapture.createConnectedServiceProviderActivityProofRecorder.mockClear();
    providerActivityRecorderCapture.record.mockClear();
    vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
    vi.mocked(callSessionRpc).mockClear();
    vi.mocked(resolveSessionTransportContext).mockClear();
    stopSessionMocks.createStopSession.mockClear();
    stopSessionMocks.stopSession.mockClear();
    stopSessionMocks.stopSession.mockResolvedValue(true);
    pendingMaterializationRpcMocks.callSessionRpc.mockResolvedValue({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    });
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_plain',
      rawSession: {
        id: 'sess_plain',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER;
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_MS;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_POLL_INTERVAL_MS;
  });

  it('leaves daemon session runner respawn disabled unless explicitly enabled', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(sessionRespawnManagerCapture.createSessionRunnerRespawnManager).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('uses webhook metadata bindings for provider activity recovery identities when spawn options no longer carry them', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
    const trackedSessionCapture: {
      current: Map<number, {
        pid: number;
        startedBy: string;
        happySessionId?: string;
        happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
        spawnOptions?: Record<string, unknown>;
      }> | null;
    } = { current: null };
    vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
      trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
      return vi.fn();
    });

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (harness.getTurnLifecycleHandler() && trackedSessionCapture.current) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const turnLifecycleHandler = harness.getTurnLifecycleHandler();
      if (!turnLifecycleHandler) {
        throw new Error('Expected connected-service turn lifecycle handler to be registered');
      }
      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }

      trackedSessions.set(7301, {
        pid: 7301,
        startedBy: 'daemon',
        happySessionId: 'sess_metadata_bindings',
        spawnOptions: {
          directory: '/tmp/workspace',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
        happySessionMetadataFromLocalWebhook: {
          id: 'sess_metadata_bindings',
          flavor: 'claude',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'group',
                groupId: 'claude',
                profileId: 'leeroy_bat',
              },
            },
          },
        },
      });

      await turnLifecycleHandler({
        sessionId: 'sess_metadata_bindings',
        event: 'task_started',
      });

      expect(providerActivityRecorderCapture.record).toHaveBeenCalledWith({
        sessionId: 'sess_metadata_bindings',
        recoveryIdentities: [
          {
            serviceId: 'claude-subscription',
            selectionKind: 'group',
            groupId: 'claude',
            profileId: 'leeroy_bat',
          },
        ],
      });

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores dead connected-service restart intents during startup without respawning', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [
          {
            kind: 'dead',
            sessionId: 'sess-durable-restart',
            pid: 7301,
            requestedAtMs: 1_000,
            spawnOptions: {
              directory: '/tmp/workspace-durable',
              backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
              resume: 'claude-durable-thread',
              approvedNewDirectoryCreation: true,
            },
            vendorResumeId: 'claude-durable-thread',
          },
        ] as any,
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores dead connected-service restart intents during startup when only the happy session id is resumable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [
          {
            kind: 'dead',
            sessionId: 'sess-existing-session-restart',
            pid: 7303,
            requestedAtMs: 1_250,
            spawnOptions: {
              directory: '/tmp/workspace-existing-session',
              backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
              existingSessionId: 'sess-existing-session-restart',
              approvedNewDirectoryCreation: true,
            },
            vendorResumeId: null,
          },
        ] as any,
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores dead startup session restart intents without respawning', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
        sessionRestartIntents: [
          {
            kind: 'dead',
            reason: 'terminal_prompt_injection_rehydrate',
            sessionId: 'sess-durable-terminal-restart',
            pid: 7302,
            spawnOptions: {
              directory: '/tmp/workspace-terminal',
              backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
              resume: 'claude-terminal-thread',
              approvedNewDirectoryCreation: true,
            },
            vendorResumeId: 'claude-terminal-thread',
          },
        ],
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('tracks respawn environment variables from the effective launched Claude child env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const claudeConfigDirOriginal = process.env.CLAUDE_CONFIG_DIR;
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;

    try {
      const backendsCatalog = await import('@/backends/catalog');
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const { claudeDaemonSpawnHooks } = await import('@/backends/claude/daemon/spawnHooks');

      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            environmentVariables?: Record<string, string>;
          };
        }> | null;
      } = { current: null };

      vi.mocked(backendsCatalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'claude',
        cliSubcommand: 'claude',
        vendorResumeSupport: 'supported',
        getDaemonSpawnHooks: async () => ({
          ...claudeDaemonSpawnHooks,
          validateSpawn: async () => ({ ok: true as const }),
        }),
      }));
      vi.mocked(backendsCatalog.resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(backendsCatalog.resolveAgentCliSubcommand).mockReturnValue('claude');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');

      const directLaunchCall = spawnHappyCLI.mock.calls[0];
      const wrappedLaunchCall = spawnChildProcess.mock.calls[0] as unknown;
      const wrappedLaunchOptions =
        Array.isArray(wrappedLaunchCall) && wrappedLaunchCall.length >= 3
          ? (wrappedLaunchCall[2] as { env?: Record<string, string> } | undefined)
          : undefined;
      const launchedEnv = directLaunchCall
        ? (directLaunchCall[1] as { env?: Record<string, string> } | undefined)?.env
        : wrappedLaunchOptions?.env;

      if (!launchedEnv) {
        throw new Error('Expected daemon session spawn to capture the launched child environment');
      }

      expect(launchedEnv?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');

      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }

      expect(trackedSessions.get(12345)?.spawnOptions?.environmentVariables?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const backendsCatalog = await import('@/backends/catalog');
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(backendsCatalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'supported',
      }));
      vi.mocked(backendsCatalog.resolveCatalogAgentId).mockReturnValue('codex');
      vi.mocked(backendsCatalog.resolveAgentCliSubcommand).mockReturnValue('codex');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (claudeConfigDirOriginal === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDirOriginal;
      }
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('propagates canonicalized connected-service group bindings into the launched child env and tracked spawn options', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            connectedServices?: unknown;
          };
        }> | null;
      } = { current: null };

      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      resolveConnectedServiceAuthForSpawnMock.mockResolvedValueOnce({
        env: { CODEX_HOME: '/tmp/codex-connected' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      });

      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'we-are',
            },
          },
        },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');

      const directLaunchCall = spawnHappyCLI.mock.calls.at(-1);
      const wrappedLaunchCall = spawnChildProcess.mock.calls.at(-1) as unknown;
      const wrappedLaunchOptions =
        Array.isArray(wrappedLaunchCall) && wrappedLaunchCall.length >= 3
          ? (wrappedLaunchCall[2] as { env?: Record<string, string> } | undefined)
          : undefined;
      const launchedEnv = directLaunchCall
        ? (directLaunchCall[1] as { env?: Record<string, string> } | undefined)?.env
        : wrappedLaunchOptions?.env;

      if (!launchedEnv) {
        throw new Error('Expected daemon session spawn to capture the launched child environment');
      }

      expect(parseSessionConnectedServicesBindingsJson(
        launchedEnv[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] ?? null,
      )).toEqual({
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      });

      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      expect(trackedSessions.get(12345)?.spawnOptions?.connectedServices).toEqual({
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('tracks connected-service materialization diagnostics on spawn options for downstream switch surfaces', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;

    let run: Promise<void> | null = null;
    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
          };
        }> | null;
      } = { current: null };

      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      resolveConnectedServiceAuthForSpawnMock.mockResolvedValueOnce({
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-connected' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        diagnostics,
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile-1',
            },
          },
        },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');
      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      expect(trackedSessions.get(12345)?.spawnOptions?.materializationDiagnostics).toEqual(diagnostics);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('launches daemon-managed session runners as detached ignored-stdio children and unreferences them', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }

      expect(firstCall[1]).toEqual(expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }));
      const launchOptions = firstCall as unknown as [unknown, unknown, unknown?];
      expect(launchOptions[2]).toEqual({ preferWindowsPackagedBinary: true });

      const launchedChild = spawnHappyCliCapture.children[0];
      if (!launchedChild) {
        throw new Error('Expected spawned child to be captured');
      }
      expect(launchedChild.unref).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('derives vendor resume id from existing session metadata and passes --resume to the spawned runner', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_plain']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'vendor-plain-1']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('resolves persisted runtime state before spawning an existing session with stale incoming controls', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_yolo_restore',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'claude',
          claudeSessionId: 'vendor-claude-restore',
          path: '/tmp',
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 200,
        }),
        dataEncryptionKey: null,
      }),
    );
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_claude_repair',
    });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_yolo_restore',
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_yolo_restore']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'vendor-claude-restore']));
      expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
      expect(argv).toEqual(expect.arrayContaining(['--permission-mode-updated-at', '200']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('tags daemon-spawned session runners as stack process kind=session (does not inherit infra)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const stackEnvFileOriginal = process.env.HAPPIER_STACK_ENV_FILE;
    const stackProcessKindOriginal = process.env.HAPPIER_STACK_PROCESS_KIND;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_STACK_ENV_FILE = '/tmp/stack.env';
    process.env.HAPPIER_STACK_PROCESS_KIND = 'infra';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env?.HAPPIER_STACK_PROCESS_KIND).toBe('session');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (stackEnvFileOriginal === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = stackEnvFileOriginal;
      }
      if (stackProcessKindOriginal === undefined) {
        delete process.env.HAPPIER_STACK_PROCESS_KIND;
      } else {
        process.env.HAPPIER_STACK_PROCESS_KIND = stackProcessKindOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('spawns regular linux background-service runners through a pre-exec cgroup self-migration wrapper before provider children start', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(buildCgroupSelfMigratingHappyCliLaunchSpec).toHaveBeenCalledTimes(1);
      expect(spawnChildProcess).toHaveBeenCalledTimes(1);
      const spawnCall = spawnChildProcess.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv } | undefined] | undefined;
      const spawnFilePath = spawnCall?.[0];
      const spawnArgs = spawnCall?.[1];
      const spawnOptions = spawnCall?.[2];
      expect(spawnFilePath).toBe('/bin/sh');
      expect(spawnArgs).toEqual(expect.arrayContaining(['-lc']));
      expect(spawnArgs?.join(' ')).toContain('happier-session-$$.scope');
      expect(spawnArgs?.join(' ')).toContain('exec "$@"');
      expect(spawnOptions?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toContain('/sys/fs/cgroup/');
      expect(spawnOptions?.env?.[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBe('1');
      expect(applySpawnedChildOomScoreAdjustmentMock).toHaveBeenCalledWith(expect.objectContaining({
        pid: 12345,
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('applies linux spawned-child OOM score adjustment for manual daemon session spawns', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'manual';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(applySpawnedChildOomScoreAdjustmentMock).toHaveBeenCalledWith(expect.objectContaining({
        pid: 12345,
        startupSource: 'manual',
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('migrates reattached linux background-service session runners out of the daemon service cgroup during startup', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-6480',
          reattachedFromDiskMarker: true,
        });
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup).toHaveBeenCalledTimes(1);
      const migrationParams = cgroupMigrationCapture.lastParams;
      if (!migrationParams) {
        throw new Error('Expected cgroup migration helper to be called');
      }
      const trackedSessionsArg = Array.from(migrationParams.trackedSessions as Iterable<{ pid: number }>);
      expect(trackedSessionsArg).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pid: 6480,
          }),
        ]),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('keeps live reattached daemon sessions running under their original CLI runtime during startup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-stale-6480',
          reattachedFromDiskMarker: true,
          processCommand:
            'bun C:/hq/windetachedfix-007/happier-v0.2.4-windows-x64/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon --existing-session sess-stale-6480',
          spawnOptions: {
            directory: '/tmp/workspace-stale',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          },
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const stopSessionModule = await import('./sessions/stopSession');
      const stopSessionSpy = vi.fn(async () => true);
      vi.mocked(stopSessionModule.createStopSession).mockReturnValue(stopSessionSpy as any);

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getSpawnSession()) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(stopSessionSpy).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores live connected-service restart intents during startup without signalling the runner', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        throw Object.assign(new Error(`process ${pid} is not alive`), { code: 'ESRCH' });
      }
      return true;
    }) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-live-restart-intent',
          childProcess: { pid: process.pid } as any,
          reattachedFromDiskMarker: true,
          spawnOptions: {
            directory: '/tmp/workspace-live-restart',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'claude-live-thread',
            approvedNewDirectoryCreation: true,
          },
          vendorResumeId: 'claude-live-thread',
        } as any);
        return {
          orphanedDeadDaemonSessions: [],
          connectedServiceRestartIntents: [
            {
              kind: 'live',
              sessionId: 'sess-live-restart-intent',
              pid: 6480,
              requestedAtMs: 1_000,
            },
          ] as any,
        };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(killSpy.mock.calls).not.toContainEqual([-6480, 'SIGTERM']);
      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('ignores live startup session restart intents without signalling the old runner', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      return true;
    }) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6481, {
          pid: 6481,
          startedBy: 'daemon',
          happySessionId: 'sess-live-terminal-restart',
          childProcess: { pid: process.pid } as any,
          reattachedFromDiskMarker: true,
          spawnOptions: {
            directory: '/tmp/workspace-live-terminal',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'claude-live-terminal-thread',
            approvedNewDirectoryCreation: true,
          },
          vendorResumeId: 'claude-live-terminal-thread',
        } as any);
        return {
          orphanedDeadDaemonSessions: [],
          connectedServiceRestartIntents: [],
          sessionRestartIntents: [
            {
              kind: 'live',
              reason: 'terminal_prompt_injection_rehydrate',
              sessionId: 'sess-live-terminal-restart',
              pid: 6481,
            },
          ],
        };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(killSpy.mock.calls).not.toContainEqual([-6481, 'SIGTERM']);
      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('waits for a stop-requested tracked runner to be observed exited before stop returns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      vi.resetModules();
      harness.resetControlRefs();
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-6480',
          reattachedFromDiskMarker: true,
          stopRequestedAtMs: 123,
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const onChildExitedModule = await import('./sessions/onChildExited');
      const onChildExitedSpy = vi.fn();
      vi.mocked(onChildExitedModule.createOnChildExited).mockReturnValue(onChildExitedSpy);

      const waitForExitModule = await import('./sessions/waitForExistingSessionExitIfStopRequested');
      const waitForExitSpy = vi.spyOn(waitForExitModule, 'waitForExistingSessionExitIfStopRequested')
        .mockImplementation(async (params: any) => {
          params.onExitObserved?.(6480, { reason: 'process-missing', code: null, signal: null });
        });

      const stopSessionModule = await import('./sessions/stopSession');
      vi.mocked(stopSessionModule.createStopSession).mockImplementation(({ pidToTrackedSession }) => {
        return vi.fn(async (sessionId: string) => {
          for (const trackedSession of pidToTrackedSession.values()) {
            if (trackedSession.happySessionId === sessionId) {
              trackedSession.stopRequestedAtMs = Date.now();
            }
          }
          return true;
        }) as any;
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getStopSession()) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const stopSession = harness.getStopSession();
      if (!stopSession) {
        throw new Error('Expected stopSession to be registered');
      }

      await expect(stopSession('sess-stop-6480')).resolves.toBe(true);

      expect(waitForExitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-stop-6480',
      }));
      expect(onChildExitedSpy).toHaveBeenCalledWith(6480, {
        reason: 'process-missing',
        code: null,
        signal: null,
      });
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('preserves daemon-stopped resumable terminal prompt session markers for startup rehydrate', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      vi.resetModules();
      harness.resetControlRefs();

      const onChildExitedModule = await import('./sessions/onChildExited');
      const captured = {
        shouldPreserveSessionMarkerOnExit: null as null | ((input: Readonly<{
          pid: number;
          trackedSession: unknown;
          exit: { reason: string; code: number | null; signal: string | null };
        }>) => boolean),
      };
      vi.mocked(onChildExitedModule.createOnChildExited).mockImplementation((params: any) => {
        captured.shouldPreserveSessionMarkerOnExit = params.shouldPreserveSessionMarkerOnExit ?? null;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getPrepareStopSession() && captured.shouldPreserveSessionMarkerOnExit) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const prepareStopSession = harness.getPrepareStopSession();
      const shouldPreserveSessionMarkerOnExit = captured.shouldPreserveSessionMarkerOnExit;
      if (!prepareStopSession || !shouldPreserveSessionMarkerOnExit) {
        throw new Error('Expected daemon stop preparation and child-exit handler to be registered');
      }

      const eligible = {
        startedBy: 'daemon',
        pid: 7511,
        happySessionId: 'sess-claude-resume',
        vendorResumeId: 'claude-resume-7511',
        spawnOptions: {
          directory: '/tmp/workspace-claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resume: 'claude-resume-7511',
        },
      } as const;
      const terminalOwned = {
        ...eligible,
        startedBy: 'terminal',
        pid: 7512,
        happySessionId: 'sess-terminal-owned',
      } as const;
      const missingResume = {
        ...eligible,
        pid: 7513,
        happySessionId: 'sess-no-resume',
        vendorResumeId: null,
        spawnOptions: {
          directory: '/tmp/workspace-claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as const;

      await prepareStopSession(eligible);
      await prepareStopSession(terminalOwned);
      await prepareStopSession(missingResume);

      const exit = { reason: 'signal', code: null, signal: 'SIGTERM' };
      expect(shouldPreserveSessionMarkerOnExit({
        pid: eligible.pid,
        trackedSession: eligible as any,
        exit,
      })).toBe(true);
      expect(shouldPreserveSessionMarkerOnExit({
        pid: terminalOwned.pid,
        trackedSession: terminalOwned as any,
        exit,
      })).toBe(false);
      expect(shouldPreserveSessionMarkerOnExit({
        pid: missingResume.pid,
        trackedSession: missingResume as any,
        exit,
      })).toBe(false);
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('spawns an existing session without re-fetching it when a pre-resolved attach payload is supplied', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-pre-resolved-1',
    });
    vi.mocked(fetchSessionByIdCompat).mockRejectedValue(new Error('fetch should not be needed when the attach payload is pre-resolved'));

    let run: Promise<void> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await expect(
        spawnSession({
          directory: '/tmp/workspace-pre-resolved',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess-pre-resolved-1',
          existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' } as any,
        }),
      ).resolves.toEqual({ type: 'success', sessionId: 'sess-pre-resolved-1' });

      expect(fetchSessionByIdCompat).not.toHaveBeenCalled();
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(spawnHappyCLI.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          'codex',
          '--happy-starting-mode',
          'remote',
          '--started-by',
          'daemon',
          '--existing-session',
          'sess-pre-resolved-1',
        ]),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('applies persisted runtime state when a resume request targets an already running session', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(isSessionRunnerActive).mockResolvedValue(true);
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_already_running',
      rawSession: {
        id: 'sess_already_running',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_already_running',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'codex',
          codexSessionId: 'vendor-codex-fresh',
          path: '/tmp',
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 200,
          agentModeId: 'plan',
          agentModeUpdatedAt: 201,
          modelId: 'gpt-5.1',
          modelUpdatedAt: 202,
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                profileId: 'fresh-profile',
                groupId: 'main',
                activeProfileId: 'fresh-profile',
              },
            },
          },
          connectedServicesUpdatedAt: 203,
        }),
        dataEncryptionKey: null,
      }),
    );

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          happySessionId?: string;
          spawnOptions?: Record<string, unknown>;
          vendorResumeId?: string;
        }> | null;
      } = { current: null };
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();
      if (!trackedSessionCapture.current) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      trackedSessionCapture.current.set(12345, {
        happySessionId: 'sess_already_running',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess_already_running',
          resume: 'vendor-codex-stale',
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
          agentModeId: 'chat',
          agentModeUpdatedAt: 101,
          modelId: 'gpt-4.1',
          modelUpdatedAt: 102,
          connectedServices: { v: 1, bindingsByServiceId: {} },
          connectedServicesUpdatedAt: 103,
        },
        vendorResumeId: 'vendor-codex-stale',
      });

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_already_running',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        agentModeId: 'chat',
        agentModeUpdatedAt: 101,
        modelId: 'gpt-4.1',
        modelUpdatedAt: 102,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 103,
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_already_running' });
      expect(fetchSessionByIdCompat).toHaveBeenCalledWith(expect.objectContaining({
        token: 'token-daemon',
        sessionId: 'sess_already_running',
        reason: 'manual-recovery',
      }));
      expect(trackedSessionCapture.current.get(12345)?.spawnOptions).toMatchObject({
        existingSessionId: 'sess_already_running',
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        agentModeId: 'plan',
        agentModeUpdatedAt: 201,
        modelId: 'gpt-5.1',
        modelUpdatedAt: 202,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              profileId: 'fresh-profile',
              groupId: 'main',
              activeProfileId: 'fresh-profile',
            },
          },
        },
        connectedServicesUpdatedAt: 203,
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(callSessionRpc).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_already_running',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_already_running:session.pendingQueue.materializeNext',
        request: { reconcileWhenEmpty: 'force' },
      });
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('retires and replaces an already running resume target when its pending queue RPC is unavailable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(isSessionRunnerActive)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(callSessionRpc).mockRejectedValue({
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      message: 'RPC method not available: sess_stale_runner:session.pendingQueue.materializeNext',
    });
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_stale_runner',
    });
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_stale_runner',
      rawSession: {
        id: 'sess_stale_runner',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          happySessionId?: string;
          startedBy?: string;
          spawnOptions?: Record<string, unknown>;
          vendorResumeId?: string;
          stopRequestedAtMs?: number;
        }> | null;
      } = { current: null };
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();
      if (!trackedSessionCapture.current) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      trackedSessionCapture.current.set(12345, {
        happySessionId: 'sess_stale_runner',
        startedBy: 'daemon',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess_stale_runner',
        },
      });

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_stale_runner',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_stale_runner' });
      expect(callSessionRpc).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_stale_runner',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_stale_runner:session.pendingQueue.materializeNext',
        request: { reconcileWhenEmpty: 'force' },
      });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledWith('sess_stale_runner');
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      vi.mocked(callSessionRpc).mockReset();
      vi.mocked(callSessionRpc).mockResolvedValue({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('repairs a missing materialization identity before resuming an existing Claude connected-service session', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const storedSession = createSessionRecordFixture({
      id: 'sess_claude_repair',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        claudeSessionId: 'vendor-claude-repair',
        path: '/tmp',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile-claude-repair',
            },
          },
        },
        connectedServicesUpdatedAt: 300,
      }),
      dataEncryptionKey: null,
    });
    vi.mocked(fetchSessionByIdCompat).mockImplementation(async ({ sessionId }) => (
      sessionId === 'sess_claude_repair'
        ? storedSession
        : createSessionRecordFixture({
            id: 'sess_plain',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'vendor-plain-1', path: '/tmp' }),
            dataEncryptionKey: null,
          })
    ));
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_claude_repair',
    });

    let run: Promise<unknown> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_claude_repair',
        token: 'token-from-spawn-options',
      });

      expect(resolveConnectedServiceSwitchContinuity).toHaveBeenCalledWith('claude', expect.objectContaining({
        sessionId: 'sess_claude_repair',
        serviceId: 'anthropic',
        vendorResumeId: 'vendor-claude-repair',
      }));
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_repair',
      }));
      expect(resolveConnectedServiceAuthForSpawnMock).toHaveBeenCalled();
      expect(result).toEqual({ type: 'success', sessionId: 'sess_claude_repair' });
      expect(resolveConnectedServiceAuthForSpawnMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_repair',
        connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
      }));
      const authCall = (resolveConnectedServiceAuthForSpawnMock.mock.calls as unknown as ReadonlyArray<readonly [unknown]>).at(0);
      const authInput = authCall?.[0] as {
        materializationKey?: unknown;
        connectedServiceMaterializationIdentityV1?: { id?: string };
      } | undefined;
      expect(authInput?.materializationKey).toBe(authInput?.connectedServiceMaterializationIdentityV1?.id);
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      shutdownRequested = true;
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (!shutdownRequested) {
        harness.requestShutdown('happier-cli');
        await run?.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('fails closed when resuming an existing connected-service session without identity or provider resume state', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(isSessionRunnerActive).mockResolvedValue(false);

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_missing_identity_no_resume',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'codex',
          path: '/tmp',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'happier',
                profileId: 'codex1',
              },
            },
          },
          connectedServicesUpdatedAt: 300,
        }),
        dataEncryptionKey: null,
      }),
    );

    let run: Promise<unknown> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 10 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_missing_identity_no_resume',
        token: 'token-from-spawn-options',
      });

      expect(result).toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_materialization_identity_missing',
      });
      expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
      if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
        throw new Error('expected connected-service diagnostic spawn detail');
      }
      expect(result.errorDetail.uxDiagnostic.code).toBe('connected_service_materialization_identity_missing');
      expect(result.errorDetail.uxDiagnostic.failurePhase).toBe('materialization');
      expect(resolveConnectedServiceSwitchContinuity).not.toHaveBeenCalled();
      expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_missing_identity_no_resume',
      }));
      expect(resolveConnectedServiceAuthForSpawnMock).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      shutdownRequested = true;
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      if (!shutdownRequested) {
        harness.requestShutdown('happier-cli');
        await run?.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('retries pending queue materialization through the guarded live session RPC after fresh attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const retryAttemptsOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = '3';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = '1';
    vi.mocked(isSessionRunnerActive).mockResolvedValue(false);

    const guardedRpcMock = vi.mocked(callSessionRpc);
    guardedRpcMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      })
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        result: {
          type: 'materialized',
          localId: 'late-cutover-message',
          seq: 42,
          content: null,
        },
      });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (guardedRpcMock.mock.calls.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(guardedRpcMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(guardedRpcMock.mock.calls[0]?.[0]).toEqual({
        token: 'token-daemon',
        sessionId: 'sess_plain',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_plain:session.pendingQueue.materializeNext',
        request: { reconcileWhenEmpty: 'force' },
      });
      expect(guardedRpcMock.mock.calls[1]?.[0]).toEqual({
        token: 'token-daemon',
        sessionId: 'sess_plain',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_plain:session.pendingQueue.materializeNext',
        request: { reconcileWhenEmpty: 'force' },
      });
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      guardedRpcMock.mockReset();
      guardedRpcMock.mockResolvedValue({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      if (retryAttemptsOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = retryAttemptsOriginal;
      }
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = retryDelayOriginal;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('does not retire a freshly attached existing session while its pending queue RPC is still warming up', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const retryAttemptsOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = '3';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = '1';
    vi.mocked(isSessionRunnerActive).mockResolvedValue(false);

    const guardedRpcMock = vi.mocked(callSessionRpc);
    guardedRpcMock.mockRejectedValue({
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      message: 'RPC method not available: sess_plain:session.pendingQueue.materializeNext',
    });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (guardedRpcMock.mock.calls.length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(stopSessionMocks.stopSession).not.toHaveBeenCalledWith('sess_plain');
      expect(guardedRpcMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(guardedRpcMock).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_plain',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_plain:session.pendingQueue.materializeNext',
        request: { reconcileWhenEmpty: 'force' },
      });
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      vi.mocked(callSessionRpc).mockReset();
      vi.mocked(callSessionRpc).mockResolvedValue({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      if (retryAttemptsOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = retryAttemptsOriginal;
      }
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = retryDelayOriginal;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('cancels pending queue background nudge retry sleep when daemon shutdown starts', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const retryAttemptsOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = '3';
    process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = '60000';
    vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
    vi.mocked(callSessionRpc).mockResolvedValue({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await vi.advanceTimersByTimeAsync(0);

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const resultPromise = spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(resultPromise).resolves.toEqual({ type: 'success', sessionId: 'sess_plain' });

      await vi.waitFor(() => expect(callSessionRpc).toHaveBeenCalledTimes(1));
      const retryTimer = setTimeoutSpy.mock.results
        .map((resultItem) => resultItem.value)
        .find((value): value is NodeJS.Timeout => Boolean(value) && typeof (value as NodeJS.Timeout).unref === 'function');
      expect(retryTimer?.unref).toEqual(expect.any(Function));

      harness.requestShutdown('happier-cli');
      await vi.advanceTimersByTimeAsync(0);
      await run;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(callSessionRpc).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      setTimeoutSpy.mockRestore();
      vi.mocked(isSessionRunnerActive).mockResolvedValue(false);
      if (retryAttemptsOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS = retryAttemptsOriginal;
      }
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS = retryDelayOriginal;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('normalizes ~/ session directories before spawning the child runner and seeding requested-directory env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HOME = '/Users/tester';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '~/Documents',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.cwd).toBe('/Users/tester/Documents');
      expect(opts?.env?.HAPPIER_SESSION_REQUESTED_DIRECTORY).toBe('/Users/tester/Documents');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('allows macOS background-service spawns targeting Documents', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';
    process.env.HOME = '/Users/tester';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '~/Documents/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { cwd?: string } | undefined;
      expect(opts?.cwd).toBe('/Users/tester/Documents/project');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('passes the canonical existing session id hint through to the webhook waiter for attach spawns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockImplementationOnce(async () => ({
      type: 'success',
      sessionId: 'sess_plain',
    }));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(1);
      const firstCall = waitForSessionWebhookMock.mock.calls[0]?.[0];
      expect(typeof firstCall?.resolveExistingSessionId).toBe('function');
      expect(firstCall?.resolveExistingSessionId?.()).toBe('sess_plain');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('routes configured ACP backend attach spawns through the acp-catalog command with preset args', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        existingSessionId: 'sess_plain',
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv[0]).toBe('acp-catalog');
      expect(argv).toEqual(expect.arrayContaining(['--backend', 'custom-kiro']));
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_plain']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns INVALID_REQUEST when the existing session cannot be fetched for resume', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(null);

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_missing',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session not found or access denied for resume.',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns UNEXPECTED when fetching the existing session fails before resume attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(new Error('fetch exploded'));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_fetch_error',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to fetch existing session for resume.',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns not_authenticated when fetching the existing session fails with stale auth before resume attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(
      createHttpStatusError(401, 'Unauthorized (401)', 'not_authenticated'),
    );

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_stale_auth',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'not_authenticated',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('marks control routes as shutting down once beforeShutdown quiesces quota producers', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_WAIT_FOR_AUTH;

    try {
      vi.resetModules();
      const persistence = await import('@/persistence');
      vi.mocked(persistence.readCredentials).mockResolvedValue({
        token: 'token_1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      });
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; !harness.getBeforeShutdown() && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const beforeShutdown = harness.getBeforeShutdown();
      const isShuttingDown = harness.getIsShuttingDown();
      if (!beforeShutdown || !isShuttingDown) {
        throw new Error('Expected control server shutdown hooks to be registered');
      }

      expect(isShuttingDown()).toBe(false);
      await beforeShutdown();
      expect(isShuttingDown()).toBe(true);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('defers shutdown completion until pending machine RPC requests settle', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER = 'false';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_WAIT_FOR_AUTH;

    harness.apiMachine.setRPCHandlers.mockClear();
    harness.apiMachine.awaitPendingRpcRequests.mockClear();

    let resolvePendingRpc!: () => void;
    harness.apiMachine.awaitPendingRpcRequests.mockImplementationOnce(
      async () => await new Promise<void>((resolve) => {
        resolvePendingRpc = resolve;
      }),
    );

    try {
	      vi.resetModules();
	      const persistence = await import('@/persistence');
	      vi.mocked(persistence.readCredentials).mockResolvedValue({
	        token: 'token_1',
	        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
	      });
	      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; harness.apiMachine.setRPCHandlers.mock.calls.length === 0 && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const hasMachineSync = harness.apiMachine.setRPCHandlers.mock.calls.length > 0;

      for (let attempt = 0; !harness.getBeforeShutdown() && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const resolvedBeforeShutdown = harness.getBeforeShutdown();
      if (!resolvedBeforeShutdown) throw new Error('Expected beforeShutdown to be registered');

      if (!hasMachineSync) {
        await resolvedBeforeShutdown();
        expect(harness.apiMachine.awaitPendingRpcRequests).toHaveBeenCalledTimes(0);
        harness.requestShutdown('happier-cli');
        await run;
        return;
      }

      let settled = false;
      const waitForBeforeShutdown = resolvedBeforeShutdown().then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.apiMachine.awaitPendingRpcRequests).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolvePendingRpc();
      await waitForBeforeShutdown;

      expect(settled).toBe(true);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const persistence = await import('@/persistence');
      vi.mocked(persistence.readCredentials).mockResolvedValue(null);
      harness.apiMachine.awaitPendingRpcRequests.mockReset();
      harness.apiMachine.awaitPendingRpcRequests.mockImplementation(async () => {});
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('flushes daemon server work again after pending machine RPC requests settle', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER = 'false';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_WAIT_FOR_AUTH;

    harness.apiMachine.setRPCHandlers.mockClear();
    harness.apiMachine.awaitPendingRpcRequests.mockClear();

    let resolvePendingRpc!: () => void;
    harness.apiMachine.awaitPendingRpcRequests.mockImplementationOnce(
      async () => await new Promise<void>((resolve) => {
        resolvePendingRpc = resolve;
      }),
    );

    const serverWorkScheduler = {
      enqueue: vi.fn(async () => ({ status: 'written' as const })),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    };

    try {
      vi.resetModules();
      vi.doMock('./serverWork', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./serverWork')>();
        return {
          ...actual,
          createDaemonServerWorkScheduler: vi.fn(() => serverWorkScheduler),
        };
      });
      const persistence = await import('@/persistence');
      vi.mocked(persistence.readCredentials).mockResolvedValue({
        token: 'token_1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      });
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; harness.apiMachine.setRPCHandlers.mock.calls.length === 0 && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const hasMachineSync = harness.apiMachine.setRPCHandlers.mock.calls.length > 0;

      for (let attempt = 0; !harness.getBeforeShutdown() && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const resolvedBeforeShutdown = harness.getBeforeShutdown();
      if (!resolvedBeforeShutdown) throw new Error('Expected beforeShutdown to be registered');

      if (!hasMachineSync) {
        await resolvedBeforeShutdown();
        expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(1);
        harness.requestShutdown('happier-cli');
        await run;
        return;
      }

      let settled = false;
      const waitForBeforeShutdown = resolvedBeforeShutdown().then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.apiMachine.awaitPendingRpcRequests).toHaveBeenCalledTimes(1);
      expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolvePendingRpc();
      await waitForBeforeShutdown;

      expect(settled).toBe(true);
      expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(2);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      vi.doUnmock('./serverWork');
      const persistence = await import('@/persistence');
      vi.mocked(persistence.readCredentials).mockResolvedValue(null);
      harness.apiMachine.awaitPendingRpcRequests.mockReset();
      harness.apiMachine.awaitPendingRpcRequests.mockImplementation(async () => {});
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('uses the visible Windows console spawner when the resolved launch mode is console', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      const { resolveWindowsRemoteSessionConsoleMode } = await import('./platform/windows/windowsSessionConsoleMode');
      const { startHappySessionInVisibleWindowsConsole } = await import('./platform/windows/spawnHappyCliVisibleConsole');
      const { startDaemon } = await import('./startDaemon');

      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockReturnValue({
        runtime: 'node',
        filePath: '/tmp/happier',
        args: ['codex', '--happy-starting-mode', 'remote'],
        env: { EXTRA: '1' },
      });
      vi.mocked(resolveWindowsRemoteSessionConsoleMode).mockReturnValue('console');

      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
        windowsRemoteSessionConsole: 'visible',
      });

      expect(startHappySessionInVisibleWindowsConsole).toHaveBeenCalledWith(expect.objectContaining({
        filePath: '/tmp/happier',
        args: expect.arrayContaining(['codex', '--happy-starting-mode', 'remote']),
        workingDirectory: '/tmp',
      }));
      expect(buildHappyCliSubprocessLaunchSpec).toHaveBeenCalledWith(
        expect.any(Array),
        { preferWindowsPackagedBinary: true },
      );
      expect(spawnHappyCLI).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

});
