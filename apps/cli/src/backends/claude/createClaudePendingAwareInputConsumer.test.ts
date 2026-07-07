import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { createClaudePendingAwareInputConsumer } from './createClaudePendingAwareInputConsumer';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

function createSessionHarness(accountSettings: Record<string, unknown> | null) {
  const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
  const session = {
    queue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    accountSettings,
    client: {
      materializeNextPendingMessageSafely,
      popPendingMessage: vi.fn(async () => false),
      shouldAttemptPendingMaterialization: vi.fn(() => true),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(async () => false),
    },
  } as unknown as Session;

  return { session, materializeNextPendingMessageSafely };
}

describe('createClaudePendingAwareInputConsumer', () => {
  it('allows active-turn materialization for Claude live steering by default', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness(null);

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-live-steer-default' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('allows active-turn materialization when busy steering is configured for immediate delivery', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness({
      sessionBusySteerSendPolicy: 'steer_immediately',
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-live-steer-immediate' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('keeps the active-turn block when busy steering is configured as server pending', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness({
      sessionBusySteerSendPolicy: 'server_pending',
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-server-pending' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
    });
  });

  it('notifies input-available listeners when the session queue receives a message', () => {
    const { session } = createSessionHarness(null);
    const consumer = createClaudePendingAwareInputConsumer(session);
    const listener = vi.fn();

    const unsubscribe = consumer.onInputAvailable?.(listener);
    expect(unsubscribe).toBeTypeOf('function');

    session.queue.push('wake me', { claudeUnifiedTerminalEnabled: true } as EnhancedMode);

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe?.();
    session.queue.push('do not wake me', { claudeUnifiedTerminalEnabled: true } as EnhancedMode);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
