import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

const enqueueSessionTurnMock = vi.fn(async (_mutation: unknown) => {});
const enqueueSessionEndMock = vi.fn(async (_mutation: unknown) => {});
const enqueueTranscriptMessageMock = vi.fn(async (_mutation: unknown) => ({ persisted: true, delivered: true }));
const flushOutboxMock = vi.fn(async (_reason: unknown) => {});
const closeOutboxMock = vi.fn(async () => {});
let terminalTurnWriteGate: ReturnType<typeof createDeferred<void>> | null = null;

vi.mock('./mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: () => ({
    enqueueSessionTurn: (mutation: { action?: unknown }) => {
      enqueueSessionTurnMock(mutation);
      if (
        terminalTurnWriteGate
        && (
          mutation.action === 'complete'
          || mutation.action === 'fail'
          || mutation.action === 'cancel'
        )
      ) {
        return terminalTurnWriteGate.promise;
      }
      return Promise.resolve();
    },
    enqueueSessionEnd: (mutation: unknown) => enqueueSessionEndMock(mutation),
    enqueueTranscriptMessage: (mutation: unknown) => enqueueTranscriptMessageMock(mutation),
    flush: (reason: unknown) => flushOutboxMock(reason),
    close: () => closeOutboxMock(),
  }),
}));

let supervisorPhase = 'online';

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    getState: () => ({ phase: supervisorPhase }),
  }),
}));

const catchUpMock = vi.fn(async (_opts?: unknown) => {});

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: (opts: unknown) => catchUpMock(opts),
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();
let sessionClientModulePromise: Promise<typeof import('./sessionClient')> | null = null;

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: (...args: unknown[]) => fetchSnapshotMock(...args),
  };
});

async function createClient(sessionOverrides: Record<string, unknown>) {
  sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('./sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const client = new ApiSessionClient('tok', {
    ...createPlainSessionFixture({ id: 's1' }),
    ...sessionOverrides,
  } as any);
  return client;
}

function triggerCommittedUserMessage(params: Readonly<{
  seq: number;
  localId: string;
  text?: string;
}>): void {
  if (!userSocketStub) throw new Error('Missing user socket stub');
  userSocketStub.trigger('update', {
    id: `update-${params.seq}`,
    createdAt: Date.now(),
    body: {
      t: 'new-message',
      sid: 's1',
      message: {
        id: `m${params.seq}`,
        seq: params.seq,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: params.text ?? `prompt ${params.seq}` },
            localId: params.localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        localId: params.localId,
        messageRole: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
}

describe('ApiSessionClient pending-queue turn-end drain', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('./sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    catchUpMock.mockReset();
    catchUpMock.mockResolvedValue(undefined);
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
    enqueueSessionTurnMock.mockClear();
    enqueueSessionEndMock.mockClear();
    enqueueTranscriptMessageMock.mockClear();
    flushOutboxMock.mockClear();
    closeOutboxMock.mockClear();
    terminalTurnWriteGate = null;
  });

  afterEach(() => {
    terminalTurnWriteGate = null;
    vi.restoreAllMocks();
  });

  it('blocks pending materialization while the snapshot reports an in-progress turn', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('publishes browser presence immediately when canonical provider turns start and finish', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 0,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    expect(sessionSocketStub?.emit).toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({
        sid: 's1',
        thinking: true,
        mode: 'remote',
      }),
    );

    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });

    expect(sessionSocketStub?.volatile.emit).toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({
        sid: 's1',
        thinking: false,
        mode: 'remote',
      }),
    );
  });

  it('allows live-delivery materialization while a canonical turn is active when the caller owns in-flight steer', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'live-steer-local',
      didWrite: true,
      message: {
        id: 'm-live-steer',
        seq: 42,
        localId: 'live-steer-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });

    expect(materializeNextMock).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'materialized',
      localId: 'live-steer-local',
      seq: 42,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it.each([
    {
      name: 'canonical active turn',
      sessionOverrides: {
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      },
      prepare: async (client: Awaited<ReturnType<typeof createClient>>) => {
        await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
      },
    },
    {
      name: 'durable active latest turn',
      sessionOverrides: {
        latestTurnStatus: 'in_progress',
        pendingCount: 1,
        pendingVersion: 1,
      },
      prepare: async () => {},
    },
    {
      name: 'continuation recovery',
      sessionOverrides: {
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: {
          sessionContinuationRecoveryV1: {
            v: 1,
            attemptsById: {
              'generation-1:restart-1': {
                v: 1,
                attemptId: 'generation-1:restart-1',
                status: 'pending_provider_context',
                failureAtMs: 100,
                updatedAtMs: 110,
                resumePromptMode: 'standard',
              },
            },
          },
        },
      },
      prepare: async () => {},
    },
  ])('pending materialization RPC respects the $name drain guard', async ({ sessionOverrides, prepare }) => {
    const client = await createClient(sessionOverrides);
    await prepare(client);

    const result = await client.rpcHandlerManager.invokeLocal('session.pendingQueue.materializeNext', {
      reconcileWhenEmpty: 'force',
    });

    expect(result).toEqual({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('canonical turn completion clears a stale in-progress snapshot status and unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('canonical turn cancellation also unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.cancelTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('wakes pending consumers on turn completion (metadata-updated)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    let woke = 0;
    client.on('metadata-updated', () => {
      woke += 1;
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a stale-empty pending count on turn completion (lost-nudge recovery)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    fetchSnapshotMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSnapshotMock).toHaveBeenCalled();
  });

  it('replays owed user transcript rows at turn end (missed-broadcast recovery)', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 0 }));
  });

  it('does not replay a same-process provider-accepted user row when durable metadata is stale', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    triggerCommittedUserMessage({ seq: 739, localId: 'prompt-739' });
    client.confirmUserMessageDeliveredToProvider(739, { localIds: ['prompt-739'] });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 739 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['prompt-739'] })).toBe(true);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 739 }));
  });

  it('does not persist a volatile handoff-only seq when a lower provider-accepted seq is confirmed', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });
    const received: unknown[] = [];
    client.onUserMessage((message) => {
      received.push(message);
    });

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-handoff-only-740' });
    expect(received).toHaveLength(1);
    expect(updateMetadata).not.toHaveBeenCalled();
    client.confirmUserMessageDeliveredToProvider(739);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata).toEqual(expect.objectContaining({
      deliveredUserMessageSeqV1: 739,
    }));
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 739 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(false);
  });

  it('recognizes provider acceptance joined by local id before the committed seq exists', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
      metadata: { deliveredUserMessageSeqV1: 737 },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['prompt-late-seq'] });

    expect(client.hasUserMessageProviderAcceptance({ localIds: ['prompt-late-seq'] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(false);

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-late-seq' });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [740] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [740, 741] })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({
      userMessageSeqs: [740, 741],
      localIds: ['prompt-late-seq'],
    })).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 740 }));
  });

  it('waits for terminal turn writes to settle before turn-end owed catch-up', async () => {
    const terminalWrite = createDeferred<void>();
    terminalTurnWriteGate = terminalWrite;
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();

    const completion = client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueueSessionTurnMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'complete' }));
    expect(catchUpMock).not.toHaveBeenCalled();

    terminalWrite.resolve();
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 0 }));
  });

  it('still materializes while the session socket supervisor is reconnecting (HTTP fallback transport)', async () => {
    supervisorPhase = 'connecting';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      materializeNextMock.mockResolvedValue({ didMaterialize: false });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result.type).not.toBe('deferred');
      expect(materializeNextMock).toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('defers materialization while the supervisor is auth_failed', async () => {
    supervisorPhase = 'auth_failed';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result).toEqual({ type: 'deferred', reason: 'supervisor_auth_failed' });
      expect(materializeNextMock).not.toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('self-heals a stale in-progress snapshot status with no canonical active turn during materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    // No canonical turn ever began locally (e.g. respawned runner); the server has
    // since completed the turn, so a refresh must clear the stale block and let the
    // materialize attempt reach the server within the same wake.
    fetchSnapshotMock.mockResolvedValue({ latestTurnStatus: 'completed' });
    materializeNextMock.mockResolvedValue({ didMaterialize: false });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await client.materializeNextPendingMessageSafely();
    expect(fetchSnapshotMock).toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalled();
  });
});
