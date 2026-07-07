import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { encrypt } from '../encryption';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('handleSessionNewMessageUpdate', () => {
  it('logs invalid content envelope shapes without leaking string contents', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const debug = vi.fn();

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { foo: 'bar', secret: 'SUPER_SECRET_VALUE' },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug,
      debugLargeJson: () => void 0,
    });

    expect(debug).toHaveBeenCalled();
    const calls = JSON.stringify(debug.mock.calls);
    expect(calls).toContain('secret');
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(false);
  });

  it('explicit owed catch-up replays a user row whose id was already observed but never delivered', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const receivedMessageIds = new Set<string>(['m6']);
    const update = {
      id: 'catchup-m6',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm6',
          seq: 6,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '/context' } } },
          localId: 'local-6',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds,
      allowReprocessReceivedMessageIds: true,
      lastObservedMessageSeq: 6,
      lastObservedUserMessageSeq: 5,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
  });

  it('without reprocess authorization an already-observed id stays deduped', () => {
    const pendingMessages: any[] = [];
    const update = {
      id: 'u-dup',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm6',
          seq: 6,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'dup' } } },
          localId: 'local-6',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(['m6']),
      lastObservedMessageSeq: 6,
      lastObservedUserMessageSeq: 5,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
  });

  it('treats self-echo-suppressed CLI user rows as delivered without replaying them to the agent queue', () => {
    const pendingMessages: any[] = [];
    const provenSeqs: number[] = [];
    const update = {
      id: 'update-typed-in-provider',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-typed-in-provider',
          seq: 42,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'typed directly in the provider TUI' },
              localId: 'provider-jsonl:user:typed-1',
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId: 'provider-jsonl:user:typed-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: (localId) => localId === 'provider-jsonl:user:typed-1',
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
    expect(provenSeqs).toEqual([42]);
  });

  it('treats legacy self-echo-suppressed CLI user rows as delivered without coercing them back into the agent queue', () => {
    const pendingMessages: any[] = [];
    const provenSeqs: number[] = [];
    const update = {
      id: 'update-legacy-typed-in-provider',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-legacy-typed-in-provider',
          seq: 43,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: 'legacy typed directly in the provider TUI',
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId: 'provider-jsonl:user:typed-legacy-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: (localId) => localId === 'provider-jsonl:user:typed-legacy-1',
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
    expect(provenSeqs).toEqual([43]);
  });

  it('suppresses provider-owned CLI user catch-up rows without proving agent-queue delivery', () => {
    const pendingMessages: any[] = [];
    const provenSeqs: number[] = [];
    const emitted: any[] = [];
    const localId = 'claude-jsonl:main:user:tui-direct-1';
    const update = {
      id: 'catchup-provider-owned-user',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-provider-owned-user',
          seq: 56,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'message typed directly in Claude TUI' },
              localId,
              meta: { source: 'cli', sentFrom: 'cli' },
            },
          },
          localId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(['m-provider-owned-user']),
      allowReprocessReceivedMessageIds: true,
      lastObservedMessageSeq: 56,
      lastObservedUserMessageSeq: 55,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      isProviderOwnedUserMessageEcho: (message) => message.localId === localId,
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
    expect(provenSeqs).toEqual([]);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers legacy string user prompts to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'hello legacy' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello legacy');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('applies the agent-queue delivery gate to legacy string user prompts', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const shouldDeliverUserMessageToAgentQueue = vi.fn(() => false);

    const update = {
      id: 'catchup-1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'stale legacy prompt' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      shouldDeliverUserMessageToAgentQueue,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(shouldDeliverUserMessageToAgentQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: { type: 'text', text: 'stale legacy prompt' },
      }),
      update,
    );
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers legacy ciphertext string content envelopes to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);

    const rawBody = {
      role: 'user',
      content: { type: 'text', text: 'hello encrypted' },
    };
    const ciphertextBytes = encrypt(encryptionKey, 'legacy', rawBody);
    const ciphertext = Buffer.from(ciphertextBytes).toString('base64');

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          // Legacy server/client shape: `content` was just ciphertext.
          content: ciphertext,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey,
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello encrypted');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not drop user prompts when agent-queue echo suppression is set but no callback is attached', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
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
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not use agent-queue echo suppression as a pre-delivery gate when a live callback is attached', () => {
    const delivered: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello live runner' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: (message, info) => delivered.push({ message, info }),
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message?.content?.text).toBe('hello live runner');
    expect(delivered[0]?.info).toEqual({ seq: 1 });
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers iOS UI prompts even when old local echo-suppression markers are present', () => {
    const delivered: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u-ios-resume',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-ios-resume',
          seq: 7,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'resume and answer the operator' },
              localId: 'ios-local-1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'ios-local-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: (message, info) => delivered.push({ message, info }),
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message?.content?.text).toBe('resume and answer the operator');
    expect(delivered[0]?.info).toEqual({ seq: 7 });
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('suppresses passive committed transcript writes with non-cli metadata even when a live callback is attached', () => {
    const delivered: any[] = [];
    const provenSeqs: number[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u-passive-write',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-passive-write',
          seq: 12,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'imported transcript row' },
              localId: 'passive-write-1',
              meta: { source: 'import', sentFrom: 'history' },
            },
          },
          localId: 'passive-write-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      hasPassiveCommittedUserMessageLocalId: (localId: string) => localId === 'passive-write-1',
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: (message, info) => delivered.push({ message, info }),
      pendingMessages: [],
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(delivered).toEqual([]);
    expect(provenSeqs).toEqual([]);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('suppresses in-flight local prompt echoes without treating them as provider-delivered proof', () => {
    const delivered: any[] = [];
    const provenSeqs: number[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u-in-flight',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-in-flight',
          seq: 19,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'selected option' },
              localId: 'in-flight-1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'in-flight-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      hasAgentQueueInFlightLocalId: (localId: string) => localId === 'in-flight-1',
      hasAgentQueueDeliveredLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: (message, info) => delivered.push({ message, info }),
      pendingMessages: [],
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(delivered).toEqual([]);
    expect(provenSeqs).toEqual([]);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('allows explicit owed catch-up to retry an undelivered in-flight local prompt', () => {
    const delivered: any[] = [];
    const provenSeqs: number[] = [];
    const emitted: any[] = [];
    const receivedMessageIds = new Set<string>(['m-in-flight']);

    const update = {
      id: 'catchup-m-in-flight',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-in-flight',
          seq: 19,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'selected option' },
              localId: 'in-flight-1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'in-flight-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds,
      allowReprocessReceivedMessageIds: true,
      allowRetryUndeliveredAgentQueueInFlightLocalIds: true,
      lastObservedMessageSeq: 18,
      lastObservedUserMessageSeq: 18,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      hasAgentQueueInFlightLocalId: (localId: string) => localId === 'in-flight-1',
      hasAgentQueueDeliveredLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      markAgentQueueInFlightLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: (message, info) => delivered.push({ message, info }),
      pendingMessages: [],
      onUserMessageDeliveryProvenByLocalEcho: (seq) => provenSeqs.push(seq),
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message?.localId).toBe('in-flight-1');
    expect(delivered[0]?.info).toEqual({ seq: 19 });
    expect(provenSeqs).toEqual([]);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not redeliver deterministic daemon-initial-prompt user messages already sent by this agent process', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const pendingMessageCallback = (msg: any) => pendingMessages.push(msg);
    const localId = 'daemon-initial-prompt:sess_1';

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'daemon initial prompt' },
              localId,
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          localId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  function buildUserMessageUpdate(content: unknown, seq: number | null = 5): Update {
    return {
      id: 'u-delivered',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: `m-delivered-${String(seq)}`,
          seq,
          content: { t: 'plain', v: content },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;
  }

  function runWithDeliveredHook(update: Update, overrides: Partial<Parameters<typeof handleSessionNewMessageUpdate>[0]> = {}) {
    const delivered: number[] = [];
    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: () => void 0,
      pendingMessages: [],
      onUserMessageDeliveredToAgentQueue: (seq) => delivered.push(seq),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
      ...overrides,
    });
    return delivered;
  }

  describe('onUserMessageDeliveredToAgentQueue (owed-delivery watermark, A-F2/D15b)', () => {
    it('reports the seq when a structured user message is delivered to the agent queue', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, 7),
      );
      expect(delivered).toEqual([7]);
    });

    it('reports the seq when a coerced legacy user prompt is delivered to the agent queue', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: 'hello legacy' }, 9),
      );
      expect(delivered).toEqual([9]);
    });

    it('does not report when delivery to the agent queue is suppressed', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, 7),
        { shouldDeliverUserMessageToAgentQueue: () => false },
      );
      expect(delivered).toEqual([]);
    });

    it('does not report when the message has no usable seq', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, null),
      );
      expect(delivered).toEqual([]);
    });

    it('does not report when the row is only buffered because no runner callback is attached', () => {
      const pendingMessages: any[] = [];
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'wait for runner' }, localId: 'local-buffered' }, 13),
        {
          pendingMessageCallback: null,
          pendingMessages,
        },
      );

      expect(pendingMessages).toHaveLength(1);
      expect(pendingMessages[0]?.content?.text).toBe('wait for runner');
      expect(delivered).toEqual([]);
    });

    it('does not treat a pending-buffer duplicate as local echo delivery proof by itself', () => {
      const update = {
        id: 'u-pending-duplicate',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-pending-duplicate',
            seq: 14,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'wait for runner' },
                localId: 'local-buffered',
              },
            },
            localId: 'local-buffered',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const echoProven: number[] = [];
      const delivered = runWithDeliveredHook(update, {
        pendingMessages: [{
          role: 'user',
          content: { type: 'text', text: 'wait for runner' },
          localId: 'local-buffered',
          meta: {},
        } as any],
        onUserMessageDeliveryProvenByLocalEcho: (seq: number) => echoProven.push(seq),
      });

      expect(delivered).toEqual([]);
      expect(echoProven).toEqual([]);
    });

    it('routes an agent-queue echo of a locally delivered prompt to the echo-proof hook, NOT the queue-handoff hook', () => {
      // A3-HIGH-1: the queue-handoff hook means "row entered volatile memory"; an echo of a
      // locally handed prompt is a different custody chain (the loop already has it) and must
      // use its own hook so the watermark policies can diverge.
      const update = {
        id: 'u-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-echo-1',
            seq: 11,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' }, localId: 'local-1' } },
            localId: 'local-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const echoProven: number[] = [];
      const delivered = runWithDeliveredHook(update, {
        hasAgentQueueEchoSuppressedLocalId: () => true,
        pendingMessages: [{
          role: 'user',
          content: { type: 'text', text: 'hi' },
          localId: 'local-1',
          meta: {},
        } as any],
        onUserMessageDeliveryProvenByLocalEcho: (seq: number) => echoProven.push(seq),
      });
      expect(delivered).toEqual([]);
      expect(echoProven).toEqual([11]);
    });

    it('routes a post-handoff structured local prompt echo to the echo-proof hook after it has left pending memory', () => {
      const echoProven: number[] = [];
      const update = {
        id: 'u-structured-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-structured-echo',
            seq: 13,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'already handed off' },
                localId: 'local-handed-off-1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'local-handed-off-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const delivered = runWithDeliveredHook(update, {
        hasAgentQueueDeliveredLocalId: (localId: string) => localId === 'local-handed-off-1',
        onUserMessageDeliveryProvenByLocalEcho: (seq: number) => echoProven.push(seq),
      });
      expect(delivered).toEqual([]);
      expect(echoProven).toEqual([13]);
    });

    it('routes a post-handoff coerced local prompt echo to the echo-proof hook after it has left pending memory', () => {
      const echoProven: number[] = [];
      const update = {
        id: 'u-coerced-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-coerced-echo',
            seq: 14,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: 'already handed off legacy',
                localId: 'local-handed-off-legacy-1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'local-handed-off-legacy-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;

      const delivered = runWithDeliveredHook(update, {
        hasAgentQueueDeliveredLocalId: (localId: string) => localId === 'local-handed-off-legacy-1',
        onUserMessageDeliveryProvenByLocalEcho: (seq: number) => echoProven.push(seq),
      });
      expect(delivered).toEqual([]);
      expect(echoProven).toEqual([14]);
    });

    it('passes the row seq to the pending message callback so it can travel with the queued message', () => {
      const seqs: Array<number | null> = [];
      runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, 7),
        { pendingMessageCallback: (_message, info) => seqs.push(info?.seq ?? null) },
      );
      runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: 'hello legacy coerced' }, 9),
        { pendingMessageCallback: (_message, info) => seqs.push(info?.seq ?? null) },
      );
      runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'no seq' } }, null),
        { pendingMessageCallback: (_message, info) => seqs.push(info?.seq ?? null) },
      );
      expect(seqs).toEqual([7, 9, null]);
    });

    it('routes a self-echo CLI transcript write to the echo-proof hook, NOT the queue-handoff hook', () => {
      const update = {
        id: 'u-cli-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-cli-1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' }, localId: 'cli-1', meta: { source: 'cli' } } },
            localId: 'cli-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const echoProven: number[] = [];
      const delivered = runWithDeliveredHook(update, {
        hasSelfEchoSuppressedLocalId: () => true,
        onUserMessageDeliveryProvenByLocalEcho: (seq: number) => echoProven.push(seq),
      });
      expect(delivered).toEqual([]);
      expect(echoProven).toEqual([12]);
    });
  });
});
