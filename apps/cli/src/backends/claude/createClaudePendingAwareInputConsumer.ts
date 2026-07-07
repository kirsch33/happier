import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type {
    PendingMaterializationActiveTurnPolicy,
    SessionProviderInputConsumer,
} from '@/agent/runtime/sessionInput/types';
import { resolveSessionPendingQueueMaxPopPerWake } from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';

import type { EnhancedMode } from './loop';
import type { Session } from './session';

function resolveClaudePendingActiveTurnDeliveryPolicy(
    accountSettings: Session['accountSettings'],
): PendingMaterializationActiveTurnPolicy | undefined {
    return accountSettings?.sessionBusySteerSendPolicy === 'server_pending'
        ? undefined
        : 'allow_live_delivery';
}

/**
 * Canonical Claude session input consumer: local agent queue + daemon-owned
 * server pending-queue materialization.
 *
 * Every Claude launcher that pulls batches for a live session MUST consume
 * through this (not `session.queue` directly): a raw queue wait only ever sees
 * messages the UI managed to deliver over RPC, so server-side pending rows
 * queued mid-turn silently starve until a manual "Send now" once the UI direct
 * path misses (QA C-F2/A-F3 stuck/one-behind family — live repro
 * cmqb329qm044z: turn-end drain trigger fired, but the unified launcher waited
 * on the raw queue and no materialization could ever run).
 */
export function createClaudePendingAwareInputConsumer(
    session: Session,
    opts?: Readonly<{
        onMetadataUpdate?: (() => void | Promise<void>) | undefined;
    }>,
): SessionProviderInputConsumer<EnhancedMode, string> {
    const materializeNextPendingMessageSafely =
        typeof session.client.materializeNextPendingMessageSafely === 'function'
            ? session.client.materializeNextPendingMessageSafely.bind(session.client)
            : null;

    return createSessionProviderInputConsumer<EnhancedMode, string>({
        messageQueue: session.queue,
        session: {
            ...(materializeNextPendingMessageSafely
                ? {
                    materializeNextPendingMessageSafely: async (materializeOpts) => {
                        // Committed transcript messages queued locally must be processed
                        // before materializing additional server pending rows.
                        if (session.queue.size() > 0) return { type: 'no_pending' as const };
                        return await materializeNextPendingMessageSafely(materializeOpts);
                    },
                }
                : {}),
            popPendingMessage: async () => {
                if (session.queue.size() > 0) return false;
                if (!materializeNextPendingMessageSafely) {
                    return await session.client.popPendingMessage();
                }
                return (await materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).type === 'materialized';
            },
            shouldAttemptPendingMaterialization: (attemptOpts) =>
                session.queue.size() <= 0
                && (session.client.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true),
            reconcilePendingQueueState: async (reconcileOpts) => {
                await session.client.reconcilePendingQueueState?.(reconcileOpts);
            },
            waitForMetadataUpdate: (signal) => session.client.waitForMetadataUpdate(signal),
        },
        pendingDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(session.accountSettings ?? null),
        resolveActiveTurnDeliveryPolicy: () => resolveClaudePendingActiveTurnDeliveryPolicy(session.accountSettings),
        onInputAvailable: (listener) => session.queue.addOnMessageListener(() => listener()),
        ...(opts?.onMetadataUpdate ? { onMetadataUpdate: opts.onMetadataUpdate } : {}),
    });
}
