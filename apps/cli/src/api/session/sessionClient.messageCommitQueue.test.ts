import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

type Ack = { ok: true; id: string; seq: number; localId: string };

type CommittedUserMessageSeqApi = {
  getCommittedUserMessageSeq: (localId: string) => number | null;
  waitForCommittedUserMessageSeq: (
    localId: string,
    opts?: { timeoutMs?: number; pollMs?: number },
  ) => Promise<number | null>;
};

type DelayedSocketStub = ApiSessionSocketStub & {
  state: {
    maxInFlight: number;
    inFlight: number;
    pendingResolvers: Array<(ack: Ack) => void>;
  };
  resolveNext: (ack: Ack) => void;
};

function createDelayedSocketStub(): DelayedSocketStub {
  const state = {
    maxInFlight: 0,
    inFlight: 0,
    pendingResolvers: [] as Array<(ack: Ack) => void>,
  };

  return Object.assign(
    createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        if (event !== 'message') {
          return { ok: true };
        }

        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);

        return new Promise((resolve) => {
          state.pendingResolvers.push((ack) => {
            state.inFlight -= 1;
            resolve(ack);
          });
        });
      },
    }),
    {
      state,
      resolveNext: (ack: Ack) => {
        const next = state.pendingResolvers.shift();
        if (!next) {
          throw new Error('No pending socket ack resolver');
        }
        next(ack);
      },
    },
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

function expectCommittedUserMessageSeqApi(client: unknown): asserts client is CommittedUserMessageSeqApi {
  expect(typeof (client as Partial<CommittedUserMessageSeqApi>).getCommittedUserMessageSeq).toBe('function');
  expect(typeof (client as Partial<CommittedUserMessageSeqApi>).waitForCommittedUserMessageSeq).toBe('function');
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let supervisorStartCount = 0;
let materializeNextPendingQueueV2MessageStub: null | (() => Promise<unknown>) = null;
let fetchSessionSnapshotUpdateFromServerStub: null | (() => Promise<unknown>) = null;

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

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      supervisorStartCount += 1;
      params.createTransport();
      await params.onConnected?.();
    },
    getState: () => ({ phase: 'online' }),
    stop: async () => {},
  }),
}));

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: async (...args: Parameters<typeof actual.materializeNextPendingQueueV2Message>) => {
      if (materializeNextPendingQueueV2MessageStub) {
        return await materializeNextPendingQueueV2MessageStub();
      }
      return await actual.materializeNextPendingQueueV2Message(...args);
    },
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: async (...args: Parameters<typeof actual.fetchSessionSnapshotUpdateFromServer>) => {
      if (fetchSessionSnapshotUpdateFromServerStub) {
        return await fetchSessionSnapshotUpdateFromServerStub();
      }
      return await actual.fetchSessionSnapshotUpdateFromServer(...args);
    },
  };
});

describe('ApiSessionClient message commit queue', () => {
  it('persists turn_failed as failed session turn runtime state', async () => {
    vi.resetModules();
    const runtimeStateUpdates: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'session-turn-mutation') {
          runtimeStateUpdates.push(payload);
          return { ok: true };
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode' as any, { type: 'task_started', id: 'turn-1' } as any);
    client.sendAgentMessage('opencode' as any, {
      type: 'turn_failed',
      id: 'turn-1',
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'opencode_idle_without_terminal_assistant',
        source: 'stream_error',
        occurredAt: 123,
        provider: 'opencode',
        providerTurnId: 'turn-1',
        sanitizedPreview: 'OpenCode became idle without producing a completed assistant message.',
      },
    } as any);

    await expect.poll(() => runtimeStateUpdates).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        providerTurnId: 'turn-1',
        action: 'begin',
        turnId: expect.any(String),
      }),
      expect.objectContaining({
        provider: 'opencode',
        providerTurnId: 'turn-1',
        action: 'fail',
        turnId: expect.any(String),
        issue: expect.objectContaining({
          status: 'failed',
          code: 'opencode_idle_without_terminal_assistant',
          providerTurnId: 'turn-1',
        }),
      }),
    ]);
    expect((runtimeStateUpdates[0] as { turnId?: unknown }).turnId).not.toBe('turn-1');
    expect((runtimeStateUpdates[1] as { turnId?: unknown }).turnId).toBe((runtimeStateUpdates[0] as { turnId?: unknown }).turnId);
    await client.close();
  });

  it('requests reconnect when message commits queue while disconnected', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await expect.poll(() => supervisorStartCount).toBe(1);

    client.sendAgentMessage('claude' as any, { type: 'message', message: 'FAKE_CLAUDE_OK_2' } as any);

    await expect.poll(() => supervisorStartCount).toBeGreaterThan(1);
  });

  it('redacts socket commit errors before logging', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => {
        throw new Error(
          'ack failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/messages?token=secret Authorization: Bearer SOCKET_SECRET',
        );
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { logger: runtimeLogger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(runtimeLogger, 'debug').mockImplementation(() => {});

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendAgentMessage('claude' as any, { type: 'message', message: 'hello' } as any, { localId: 'log-redaction-1' });

      await expect.poll(() => debugSpy.mock.calls.some(([message]) =>
        message === '[SOCKET] Persisted transcript commit ack failed'
      )).toBe(true);
      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[SOCKET] Persisted transcript commit ack failed'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        error: expect.objectContaining({
          name: 'Error',
          message: 'ack failed for https://api.example.test/v1/messages Authorization: <redacted>',
        }),
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('SOCKET_SECRET');
      expect(JSON.stringify(logged)).not.toContain('stack');
      await client.close();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('redacts usage report errors before logging', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string) => {
        if (event === 'usage-report') {
          throw new Error(
            'usage failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/usage?token=secret Authorization: Bearer USAGE_SECRET',
          );
        }
      },
      emitWithAck: async (_event: string, payload: any) => {
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { logger: runtimeLogger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(runtimeLogger, 'debug').mockImplementation(() => {});

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendAgentMessage('opencode' as any, { type: 'token_count', tokens: { total: 1 } } as any, { localId: 'usage-redaction-1' });

      await expect.poll(() => debugSpy.mock.calls.some(([message]) =>
        message === '[SOCKET] Failed to send token_count usage report (non-fatal)'
      )).toBe(true);
      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[SOCKET] Failed to send token_count usage report (non-fatal)'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        name: 'Error',
        message: 'usage failed for https://api.example.test/v1/usage Authorization: <redacted>',
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('USAGE_SECRET');
      expect(JSON.stringify(logged)).not.toContain('stack');
      await client.close();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('preserves computed event roles for queued reconnect commits', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (_event: string, payload: any) => {
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessage('opencode' as any, { type: 'turn_failed', id: 'turn-1' } as any, { localId: 'queued-event-1' });

    await expect.poll(() => (client as any).queuedDisconnectedSessionMessages.get('queued-event-1')?.messageRole).toBe('event');

    sessionSocketStub.connected = true;
    await (client as any).flushQueuedSessionMessagesOnReconnect();
    await client.flush();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        localId: 'queued-event-1',
        messageRole: 'event',
      }),
    );
    await client.close();
  });

  it('serializes best-effort message commits to avoid concurrent socket acks', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    const delayedSessionSocket = createDelayedSocketStub();
    sessionSocketStub = delayedSessionSocket;
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'a' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'b' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'c' } as any);

    const waitForPending = async (count: number) => {
      const start = Date.now();
    while (delayedSessionSocket.state.pendingResolvers.length < count) {
        if (Date.now() - start > 1_000) {
          throw new Error('Timed out waiting for socket ack resolvers');
        }
        await Promise.resolve();
      }
    };

    await waitForPending(1);

    expect(delayedSessionSocket.state.maxInFlight).toBe(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm1', seq: 1, localId: 'l1' });
    await waitForPending(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm2', seq: 2, localId: 'l2' });
    await waitForPending(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm3', seq: 3, localId: 'l3' });
  });

  it('records committed user message seqs from commit acks', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 42, localId: 'prompt-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expectCommittedUserMessageSeqApi(client);

    const waiter = client.waitForCommittedUserMessageSeq('prompt-1', { timeoutMs: 1_000, pollMs: 5 });
    await client.sendUserTextMessageCommitted('hello', { localId: 'prompt-1' });

    await expect(waiter).resolves.toBe(42);
    expect(client.getCommittedUserMessageSeq('prompt-1')).toBe(42);
  });

  it('queues a retry and throws an explicit unsupported confirmation error when persisted ACK-timeout recovery hits an older server', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://adapter.test');
    vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '5');

    const app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => (
      reply.code(404).send({
        error: 'Not found',
        path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}`,
      })
    ));
    await app.ready();
    const restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    let messageAttempts = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') {
          return { ok: true };
        }
        messageAttempts += 1;
        if (messageAttempts === 1) {
          throw Object.assign(new Error('message ack timed out after 5ms'), {
            code: 'socket_ack_timeout',
            event,
            retryable: true,
            timeoutMs: 5,
          });
        }
        return {
          ok: true,
          id: `m-${messageAttempts}`,
          seq: messageAttempts,
          localId: (payload as { localId?: string }).localId ?? 'l1',
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      const commitPromise = client.sendUserTextMessageCommitted('hello', { localId: 'persisted-unsupported-1' });

      await expect(commitPromise).rejects.toThrow(
        'Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)',
      );

      expect((client as any).pendingMaterializedLocalIds.has('persisted-unsupported-1')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect.poll(() => messageAttempts).toBe(2);
      expect((client as any).committedLocalIdsAwaitingEcho.has('persisted-unsupported-1')).toBe(true);
      await client.close();
    } finally {
      restoreAdapter();
      await app.close().catch(() => {});
    }
  });

  it('does not retry a persisted best-effort commit while transcript recovery is in flight', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://adapter.test');
    vi.stubEnv('HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS', '0');

    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    const app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any) => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return {
        message: {
          id: 'persisted-message-1',
          seq: 7,
          localId: req.params.localId,
          sidechainId: null,
          createdAt: 111,
          updatedAt: 111,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'persisted' } } },
        },
      };
    });
    await app.ready();
    const restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    let messageAttempts = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') return { ok: true };
        messageAttempts += 1;
        if (messageAttempts === 1) {
          throw Object.assign(new Error('message ack timed out'), {
            code: 'socket_ack_timeout',
            event,
            retryable: true,
          });
        }
        return {
          ok: true,
          id: `m-${messageAttempts}`,
          seq: messageAttempts,
          localId: (payload as { localId?: string }).localId ?? 'l1',
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendAgentMessage(
        'opencode' as any,
        { type: 'message', message: 'persist once' } as any,
        { localId: 'recover-before-retry-1' },
      );
      await flushMicrotasks(20);
      expect(messageAttempts).toBe(1);

      await lookupStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(messageAttempts).toBe(1);

      releaseLookup.resolve();
      await flushMicrotasks(20);
      expect(messageAttempts).toBe(1);
      await client.close();
    } finally {
      releaseLookup.resolve();
      restoreAdapter();
      await app.close().catch(() => {});
      vi.unstubAllEnvs();
    }
  });

  it('records committed user message seqs from user transcript echoes', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expectCommittedUserMessageSeqApi(client);

    const waiter = client.waitForCommittedUserMessageSeq('steer-1', { timeoutMs: 1_000, pollMs: 5 });
    userSocketStub.trigger('update', {
      id: 'u1',
      seq: 7,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm7',
          seq: 7,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'steer' },
              localId: 'steer-1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: 'steer-1',
          messageRole: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    await expect(waiter).resolves.toBe(7);
    expect(client.getCommittedUserMessageSeq('steer-1')).toBe(7);
  });

  it('records committed user message seqs from pending queue materialization acks', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    materializeNextPendingQueueV2MessageStub = async () => ({
      didMaterialize: true,
      localId: 'pending-user-1',
      didWrite: true,
      message: {
        seq: 55,
        localId: 'pending-user-1',
        messageRole: 'user',
      },
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        pendingCount: 1,
        pendingVersion: 1,
      }));
      expectCommittedUserMessageSeqApi(client);

      await expect(client.popPendingMessage()).resolves.toBe(true);
      expect(client.getCommittedUserMessageSeq('pending-user-1')).toBe(55);
    } finally {
      materializeNextPendingQueueV2MessageStub = null;
    }
  });

  it('reconciles authoritative pending state before treating known-zero pending count as empty', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    fetchSessionSnapshotUpdateFromServerStub = async () => ({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingVersion: 6,
      },
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        pendingCount: 0,
        pendingVersion: 5,
      }));

      await expect(client.peekPendingMessageQueueV2Count()).resolves.toBe(1);
      expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    } finally {
      fetchSessionSnapshotUpdateFromServerStub = null;
    }
  });

  it('blocks pending queue materialization while continuation recovery is unresolved', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 1,
      pendingVersion: 5,
      metadata: createTestMetadata({
        sessionContinuationRecoveryV1: {
          v: 1,
          attemptsById: {
            'generation-1:restart-1': {
              v: 1,
              attemptId: 'generation-1:restart-1',
              status: 'pending_provider_context',
              failureAtMs: 1_000,
              updatedAtMs: 1_100,
              resumePromptMode: 'standard',
            },
          },
        },
      }),
    }));

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await client.close();
  });

  it('returns null when a committed user message seq is not observed before timeout', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      expectCommittedUserMessageSeqApi(client);

      const waiter = client.waitForCommittedUserMessageSeq('missing-1', { timeoutMs: 25, pollMs: 5 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(waiter).resolves.toBeNull();
      expect(client.getCommittedUserMessageSeq('missing-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush waits for queued best-effort transcript commits', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    supervisorStartCount = 0;

    const messageAck = createDeferred<Ack>();
    let messageCommitStarted = false;
    let messagePayload: any = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'message') {
          messageCommitStarted = true;
          messagePayload = payload;
          return await messageAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendSessionEvent({ type: 'ready' });

      for (let i = 0; i < 20 && !messageCommitStarted; i += 1) {
        await Promise.resolve();
      }
      expect(messageCommitStarted).toBe(true);
      expect(messagePayload).toEqual(expect.objectContaining({
        messageRole: 'event',
        sessionEventType: 'ready',
      }));

      let didFlush = false;
      const flushPromise = client.flush().then(() => {
        didFlush = true;
      });

      await flushMicrotasks();
      expect(didFlush).toBe(false);

      messageAck.resolve({ ok: true, id: 'm1', seq: 1, localId: 'ready-1' });
      await flushPromise;
      expect(didFlush).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush waits for queued session turn runtime state updates', async () => {
    vi.resetModules();
    supervisorStartCount = 0;

    const projectionAck = createDeferred<{ ok: true }>();
    let runtimeStatePayload: unknown = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'session-turn-mutation') {
          runtimeStatePayload = payload;
          return await projectionAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex' as any, { type: 'task_started', id: 'turn-1' } as any);
    client.sendAgentMessage('codex' as any, { type: 'task_complete', id: 'turn-1' } as any);

    await expect.poll(() => runtimeStatePayload).toEqual(expect.objectContaining({
      provider: 'codex',
      providerTurnId: 'turn-1',
      action: 'begin',
      turnId: expect.any(String),
    }));

    let didFlush = false;
    const flushPromise = client.flush().then(() => {
      didFlush = true;
    });

    await flushMicrotasks();
    expect(didFlush).toBe(false);

    projectionAck.resolve({ ok: true });
    await flushPromise;
    expect(didFlush).toBe(true);
    await client.close();
  });
});
