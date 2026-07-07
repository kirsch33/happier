import { describe, expect, it, vi } from 'vitest';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, flushApiSessionClientMessageCommitQueue, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

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

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

import { ApiSessionClient } from './sessionClient';

describe('ApiSessionClient session.userMessage.send delivery', () => {
  it('holds explicit server-pending materialized rows during active turns until authorized catch-up', () => {
    const client = Object.create(ApiSessionClient.prototype) as any;
    client.sessionId = 's1';
    client.latestTurnStatus = 'in_progress';
    client.userMessageCallbackAttachedAtMs = null;

    const message = {
      role: 'user',
      content: { type: 'text', text: 'queue after turn' },
      localId: 'pending-local',
      meta: {
        source: 'ui',
        [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'explicit_pending',
      },
      createdAt: Date.now(),
    };
    const update = {
      id: 'u-explicit-pending',
      body: {
        t: 'new-message',
        message: { seq: 11 },
      },
    };

    expect(client.shouldDeliverUserMessageToAgentQueueFromUpdate(message, update, {})).toBe(false);
    expect(client.shouldDeliverUserMessageToAgentQueueFromUpdate(message, {
      ...update,
      id: 'catchup-explicit-pending',
    }, {
      catchUpAfterSeq: 10,
      catchUpAfterSeqIsExplicit: true,
    })).toBe(true);
  });

  it('delivers explicit pending catch-up rows after a replacement runner starts idle', () => {
    const client = Object.create(ApiSessionClient.prototype) as any;
    client.sessionId = 's1';
    client.latestTurnStatus = 'completed';
    client.userMessageCallbackAttachedAtMs = Date.now();

    const message = {
      role: 'user',
      content: { type: 'text', text: 'recover after respawn' },
      localId: 'pending-local',
      meta: {
        source: 'ui',
        sentFrom: 'cli',
        [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'explicit_pending',
      },
      createdAt: Date.now() - 5_000,
    };
    const update = {
      id: 'catchup-pending-local',
      body: {
        t: 'new-message',
        message: { seq: 42 },
      },
    };

    expect(client.shouldDeliverUserMessageToAgentQueueFromUpdate(message, update, {
      catchUpAfterSeq: 0,
      catchUpAfterSeqIsExplicit: false,
    })).toBe(true);
  });

  it('delivers the prompt to the agent queue eagerly and suppresses later transcript echo updates', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    // Simulate the daemon/UI invoking the session-scoped RPC handler, which calls the internal enqueue.
    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.type).toBe('text');
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
  });

  it('suppresses a transcript echo that arrives reentrantly during eager RPC prompt delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let triggeredEcho = false;
    client.onUserMessage((msg) => {
      received.push(msg);
      if (triggeredEcho) return;
      triggeredEcho = true;
      sessionSocketStub?.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('refreshes echo suppression when the local user-message commit is acknowledged before a delayed transcript echo', async () => {
    vi.useFakeTimers();
    try {
      let resolveMessageAck: (() => void) | null = null;
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event) => {
          if (event !== 'message') {
            return { ok: true };
          }
          await new Promise<void>((resolve) => {
            resolveMessageAck = resolve;
          });
          return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      const received: any[] = [];
      client.onUserMessage((msg) => received.push(msg));

      await (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });
      expect(received).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(8_000);
      const releaseAck = ((release: (() => void) | null): (() => void) => {
        if (typeof release !== 'function') {
          throw new Error('expected delayed message ack to be pending');
        }
        return release;
      })(resolveMessageAck);
      releaseAck();
      await flushApiSessionClientMessageCommitQueue(client as any);

      sessionSocketStub.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not advance the delivered watermark from a transcript echo while provider acceptance owns delivery proof', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(1);

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('keeps RPC prompts in-flight until provider acceptance when provider proof is deferred', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'selected option',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['l1'] })).toBe(false);

    (client as any).enqueueSessionUserMessage({
      text: 'selected option',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'selected option' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });

    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(false);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['l1'] })).toBe(true);
  });

  it('explicit catch-up retries undelivered in-flight RPC prompts', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'selected option',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'selected option' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    };

    (client as any).handleUpdate(update, { source: 'session-scoped' });
    expect(received).toHaveLength(1);
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(false);

    (client as any).handleUpdate({
      ...update,
      id: 'catchup-m1',
    }, {
      source: 'session-scoped',
      catchUpAfterSeq: 0,
      catchUpAfterSeqIsExplicit: true,
    });

    expect(received).toHaveLength(2);
    expect(received[1]?.localId).toBe('l1');
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(false);
  });

  it('releases provider-unaccepted in-flight RPC prompts for transcript retry', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'selected option',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'selected option' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    };

    (client as any).handleUpdate(update, { source: 'session-scoped' });
    expect(received).toHaveLength(1);
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    (client as any).releaseUserMessagesAwaitingProviderAcceptanceForRetry({
      userMessageSeq: 1,
      localIds: ['l1'],
      reason: 'provider_acceptance_timeout',
    });
    (client as any).handleUpdate({
      ...update,
      id: 'catchup-m1',
    }, {
      source: 'session-scoped',
      catchUpAfterSeq: 0,
      catchUpAfterSeqIsExplicit: true,
    });

    expect(received).toHaveLength(2);
    expect(received[1]?.localId).toBe('l1');
    expect((client as any).hasAgentQueueInFlightLocalId('l1')).toBe(true);
    expect((client as any).hasAgentQueueDeliveredLocalId('l1')).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);
  });

  it('persists a deferred delivered watermark when provider acceptance resolves a prior echo seq by localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['l1'] })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('persists a deferred delivered watermark when a committed echo arrives after provider acceptance by localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });

    expect((client as any).highestDeliveredUserMessageSeq).toBeNull();

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);
  });

  it('persists a deferred delivered watermark when a commit ack arrives after provider acceptance by localId', async () => {
    const commitAck = { resolve: null as ((value: unknown) => void) | null };
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') {
          return { ok: true };
        }
        return new Promise((resolve) => {
          commitAck.resolve = resolve;
        }).then(() => ({
          ok: true,
          id: 'm1',
          seq: 1,
          localId: (payload as { localId?: string } | null)?.localId ?? 'l1',
        }));
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    client.confirmUserMessageDeliveredToProvider(null, { localIds: ['l1'] });
    expect((client as any).highestDeliveredUserMessageSeq).toBeNull();

    await vi.waitFor(() => {
      expect(commitAck.resolve).toBeTypeOf('function');
    });
    const releaseCommitAck = commitAck.resolve;
    if (typeof releaseCommitAck !== 'function') {
      throw new Error('expected message commit to be waiting for ack');
    }
    releaseCommitAck(undefined);
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);
  });

  it('keeps waiting for uncommitted local ids when a mixed provider-accepted batch has a partial seq watermark', async () => {
    const commitAck = { resolve: null as ((value: unknown) => void) | null };
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'message') {
          return { ok: true };
        }
        return new Promise((resolve) => {
          commitAck.resolve = resolve;
        }).then(() => ({
          ok: true,
          id: 'm2',
          seq: 2,
          localId: (payload as { localId?: string } | null)?.localId ?? 'l2',
        }));
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    (client as any).enqueueSessionUserMessage({
      text: 'second',
      localId: 'l2',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    await vi.waitFor(() => {
      expect(commitAck.resolve).toBeTypeOf('function');
    });

    client.confirmUserMessageDeliveredToProvider(1, { localIds: ['l1', 'l2'] });
    expect((client as any).highestDeliveredUserMessageSeq).toBe(1);

    const releaseCommitAck = commitAck.resolve;
    if (typeof releaseCommitAck !== 'function') {
      throw new Error('expected message commit to be waiting for ack');
    }
    releaseCommitAck(undefined);
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect((client as any).highestDeliveredUserMessageSeq).toBe(2);
  });

  it('does not advance the delivered watermark from a self echo while provider acceptance owns delivery proof', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'cli-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    (client as any).markCommittedLocalIdAwaitingEcho('cli-1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'typed from cli' },
              localId: 'cli-1',
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId: 'cli-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(client.getMetadataSnapshot()?.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider(1);

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(true);
  });

  it('does not wait for daemon lifecycle notification before delivering the prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const received: any[] = [];
    const slowLifecycleNotify = vi.fn(() => new Promise<void>(() => {}));

    (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
    client.onUserMessage((msg) => received.push(msg));

    void (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(slowLifecycleNotify).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });

  it('does not wait for daemon lifecycle notification before delivering the prompt when the session was started by the daemon', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      const received: any[] = [];
      let releaseLifecycleNotify: (() => void) | null = null;
      const slowLifecycleNotify = vi.fn(() => new Promise<void>((resolve) => {
        releaseLifecycleNotify = resolve;
      }));

      (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
      client.onUserMessage((msg) => received.push(msg));

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });

      expect(slowLifecycleNotify).toHaveBeenCalledWith('prompt_or_steer');
      await enqueuePromise;

      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('hello');
      expect(releaseLifecycleNotify).toBeTypeOf('function');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('does not deliver a retried same-localId prompt to the agent queue twice', async () => {
    const committedPayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true, id: 'm1', seq: committedPayloads.length, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(committedPayloads).toHaveLength(2);
    expect(committedPayloads.map((payload) => payload?.localId)).toEqual(['l1', 'l1']);
  });

  it('does not deliver a buffered transcript echo and buffered RPC prompt with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('does not deliver a buffered RPC prompt and buffered transcript echo with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('continues delivering prompts without localId or with distinct localIds', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'first',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'second',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'third',
      localId: 'l3',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'fourth',
      localId: 'l4',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received.map((message) => message?.content?.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(new Set(received.map((message) => message?.localId)).size).toBe(4);
  });

  it('defaults session.userMessage.send meta source/sentFrom to ui when missing', async () => {
    let lastMessagePayload: any = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          lastMessagePayload = payload;
        }
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { permissionMode: 'yolo' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(lastMessagePayload?.sid).toBe('s1');
    expect(lastMessagePayload?.localId).toBe('l1');
    expect(lastMessagePayload?.message?.t).toBe('plain');
    expect(lastMessagePayload?.message?.v?.meta?.source).toBe('ui');
    expect(lastMessagePayload?.message?.v?.meta?.sentFrom).toBe('ui');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: lastMessagePayload.message,
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });
});
