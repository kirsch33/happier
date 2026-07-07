import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import type { ProviderOwnedUserMessageEchoClassifier } from './providerOwnedUserMessageEcho';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';
import { coerceSessionUserPromptV1 } from '@happier-dev/protocol';
import { summarizeValueShapeForLog } from '@/diagnostics/eventShapeForLog';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasPendingMessageLocalId(messages: readonly UserMessage[], localId: string | null): boolean {
    if (!localId) return false;
    return messages.some((message) => message.localId === localId);
}

function isDeterministicDaemonInitialPromptLocalId(localId: string | null, sessionId: string): boolean {
    return localId === `daemon-initial-prompt:${sessionId}`;
}

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    receivedMessageIds: Set<string>;
    /**
     * Owed-delivery replay authorization: an explicit catch-up may re-process a message id that
     * was already observed (its live broadcast was received but the row was never handed to the
     * agent queue, e.g. mid-turn). Downstream echo suppression / pending dedup still prevent
     * double delivery; without this flag an observed-but-undelivered row can never be recovered.
     */
    allowReprocessReceivedMessageIds?: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    hasPassiveCommittedUserMessageLocalId?: (localId: string) => boolean;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    hasAgentQueueInFlightLocalId?: (localId: string) => boolean;
    markAgentQueueInFlightLocalId?: (localId: string) => void;
    hasAgentQueueDeliveredLocalId?: (localId: string) => boolean;
    markAgentQueueDeliveredLocalId?: (localId: string) => void;
    /**
     * Explicit owed-delivery catch-up may see a local id that is still marked in-flight from a
     * prior volatile queue handoff even though the provider never accepted it. Live echoes must
     * still suppress in-flight rows to prevent duplicate prompts; only catch-up should opt in.
     */
    allowRetryUndeliveredAgentQueueInFlightLocalIds?: boolean;
    deferAgentQueueDeliveryProofToProviderAcceptance?: boolean;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    pendingMessageCallback: ((message: UserMessage, info?: Readonly<{ seq: number | null }>) => void) | null;
    pendingMessages: UserMessage[];
    shouldDeliverUserMessageToAgentQueue?: (message: UserMessage, update: Update) => boolean;
    /**
     * Identifies user transcript rows that are owned by the provider/native terminal and should
     * prove custody instead of being replayed into the agent queue. This is intentionally supplied
     * by the session/provider owner so generic socket handling does not learn provider-specific
     * local-id formats.
     */
    isProviderOwnedUserMessageEcho?: ProviderOwnedUserMessageEchoClassifier;
    /**
     * Owed-delivery watermark hook (A-F2/D15b, narrowed by A3-HIGH-1): fired with the message seq
     * when a user message is handed to the runner's agent QUEUE (volatile memory). Whether this
     * advances the persisted watermark is the owner's policy — launchers wired for
     * provider-acceptance confirmation defer persistence until the provider actually accepted
     * the batch (the seq travels with the queued message via `pendingMessageCallback`'s info).
     */
    onUserMessageDeliveredToAgentQueue?: (seq: number) => void;
    /**
     * Fired when a local echo proves a user row is no longer owed to the runner without handing
     * it through the queue in this update. Examples: an already queued prompt echo, an already
     * pending prompt, or a deterministic daemon initial prompt echo. Provider-native terminal
     * transcript rows are suppressed by their provider owner and do not prove this local queue
     * watermark.
     */
    onUserMessageDeliveryProvenByLocalEcho?: (seq: number) => void;
    onObservedMessage?: (message: {
        body: unknown;
        seq: number | null;
        localId: string | null;
        sidechainId: string | null;
        createdAt: number | null;
    }) => void;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
}): {
    handled: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
} {
    if (params.update.body?.t !== 'new-message') {
        return {
            handled: false,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }
    if (params.update.body.sid !== params.sessionId) {
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const parsedContent = SessionMessageContentSchema.safeParse((params.update.body as any).message?.content);
    if (!parsedContent.success) {
        const rawContent = (params.update.body as any).message?.content;
        params.debug('[SOCKET] [UPDATE] Ignoring new-message with invalid content envelope', {
            issues: parsedContent.error.issues.map((i) => ({
                code: i.code,
                path: i.path,
                expected: 'expected' in i ? (i as any).expected : undefined,
                received: 'received' in i ? (i as any).received : undefined,
            })),
            contentShape: summarizeValueShapeForLog(rawContent),
        });
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const messageId = params.update.body.message.id;
    if (typeof messageId === 'string' && messageId.length > 0) {
        if (params.receivedMessageIds.has(messageId) && params.allowReprocessReceivedMessageIds !== true) {
            return {
                handled: true,
                lastObservedMessageSeq: params.lastObservedMessageSeq,
                lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
            };
        }
        params.receivedMessageIds.add(messageId);
    }

    let nextLastObservedMessageSeq = params.lastObservedMessageSeq;
    let nextLastObservedUserMessageSeq = params.lastObservedUserMessageSeq;
    const msgSeq = params.update.body.message.seq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = readNonEmptyString(params.update.body.message.localId);
    const isSelfEchoSuppressedLocalId = Boolean(localId && params.hasSelfEchoSuppressedLocalId(localId));
    const isAgentQueueEchoSuppressedLocalId = Boolean(localId && params.hasAgentQueueEchoSuppressedLocalId(localId));
    const isPendingQueueMaterializedLocalId = Boolean(localId && params.hasPendingQueueMaterializedLocalId(localId));
    if (localId && (isSelfEchoSuppressedLocalId || isPendingQueueMaterializedLocalId)) {
        // We observed the broadcast for a message we materialized; cancel any recovery path.
        params.deleteMaterializedLocalId(localId);
    }

    let body: unknown;
    if (parsedContent.data.t === 'plain') {
        body = parsedContent.data.v;
    } else {
        try {
            body = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(parsedContent.data.c));
        } catch (error) {
            params.debug('[SOCKET] [UPDATE] Failed to decrypt new-message payload', {
                error,
                messageId: typeof messageId === 'string' ? messageId : null,
                localId,
                msgSeq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
            });
            return {
                handled: true,
                lastObservedMessageSeq: nextLastObservedMessageSeq,
                lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
            };
        }
    }
    const bodyWithLocalId =
        params.update.body.message.localId === undefined
            ? body
            : {
                ...(body as any),
                localId: params.update.body.message.localId,
            };
    const transportCreatedAt =
        typeof params.update.createdAt === 'number' && Number.isFinite(params.update.createdAt)
            ? params.update.createdAt
            : undefined;
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        ...(transportCreatedAt === undefined ? {} : { createdAt: transportCreatedAt }),
    };

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);
    params.onObservedMessage?.({
        body: bodyWithTransportFields,
        seq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
        localId,
        sidechainId: typeof params.update.body.message.sidechainId === 'string' ? params.update.body.message.sidechainId : null,
        createdAt: transportCreatedAt ?? null,
    });

    // Try to parse as user message first.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        const sentFrom = userResult.data.meta?.sentFrom;
        const source = userResult.data.meta?.source;
        const agentQueueLocalId = localId ?? readNonEmptyString(userResult.data.localId);
        const isAgentQueueEchoSuppressedForDelivery = Boolean(
            agentQueueLocalId && params.hasAgentQueueEchoSuppressedLocalId(agentQueueLocalId),
        );
        const isAgentQueueDeliveredLocalId = Boolean(
            agentQueueLocalId && params.hasAgentQueueDeliveredLocalId?.(agentQueueLocalId),
        );
        const isAgentQueueInFlightLocalId = Boolean(
            agentQueueLocalId && params.hasAgentQueueInFlightLocalId?.(agentQueueLocalId),
        );
        const isAlreadyPendingAgentQueueMessage = hasPendingMessageLocalId(params.pendingMessages, agentQueueLocalId);
        const isDeterministicDaemonInitialPrompt =
            source === 'daemon-initial-prompt'
            && isDeterministicDaemonInitialPromptLocalId(agentQueueLocalId, params.sessionId);
        const isSelfEchoSuppressedCliWrite =
            isSelfEchoSuppressedLocalId && source === 'cli';
        const isAgentQueueEchoSuppressedCliWrite =
            isAgentQueueEchoSuppressedForDelivery && source === 'cli';
        const isProviderOwnedUserMessageEcho = params.isProviderOwnedUserMessageEcho?.(userResult.data, params.update) === true;
        const isPassiveCommittedUserMessageLocalId = Boolean(
            agentQueueLocalId && params.hasPassiveCommittedUserMessageLocalId?.(agentQueueLocalId),
        );
        const shouldRespectAgentQueueEchoSuppression = isAlreadyPendingAgentQueueMessage;
        const isEffectivelyAgentQueueEchoSuppressedLocalId =
            shouldRespectAgentQueueEchoSuppression
            && isAgentQueueEchoSuppressedForDelivery;
        const canRetryUndeliveredAgentQueueInFlightLocalId =
            params.allowRetryUndeliveredAgentQueueInFlightLocalIds === true
            && isAgentQueueInFlightLocalId
            && !isAgentQueueDeliveredLocalId
            && !isAlreadyPendingAgentQueueMessage;
        const isAgentQueueInFlightBlockingDelivery =
            isAgentQueueInFlightLocalId && !canRetryUndeliveredAgentQueueInFlightLocalId;
        const shouldDeliverToAgentQueue =
            !isAgentQueueDeliveredLocalId
            && !isAgentQueueInFlightBlockingDelivery
            && !isEffectivelyAgentQueueEchoSuppressedLocalId
            && !isAlreadyPendingAgentQueueMessage
            && !isSelfEchoSuppressedCliWrite
            && !isAgentQueueEchoSuppressedCliWrite
            && !isDeterministicDaemonInitialPrompt
            && !isProviderOwnedUserMessageEcho
            && !isPassiveCommittedUserMessageLocalId
            && (params.shouldDeliverUserMessageToAgentQueue?.(userResult.data, params.update) ?? true);
        if (shouldDeliverToAgentQueue) {
            const deliverableSeq = typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null;
            if (params.pendingMessageCallback) {
                params.pendingMessageCallback(userResult.data, { seq: deliverableSeq });
            } else {
                params.pendingMessages.push(userResult.data);
            }
            if (agentQueueLocalId) {
                params.markAgentQueueEchoSuppressedLocalId(agentQueueLocalId);
                params.markAgentQueueInFlightLocalId?.(agentQueueLocalId);
                if (params.deferAgentQueueDeliveryProofToProviderAcceptance !== true) {
                    params.markAgentQueueDeliveredLocalId?.(agentQueueLocalId);
                }
            }
            if (deliverableSeq !== null) {
                params.onUserMessageDeliveredToAgentQueue?.(deliverableSeq);
            }
        } else {
            // An agent-queue echo of a prompt we already handed to the loop locally (daemon initial
            // prompt, RPC send, pending materialization) proves delivery and carries its seq.
            // Provider-owned/native rows suppress replay, but they did not pass through this queue
            // handoff and must not advance the monotonic delivered-user watermark past older owed
            // prompts.
            const isDeliveredLocalPromptEcho =
                isAgentQueueDeliveredLocalId
                || isEffectivelyAgentQueueEchoSuppressedLocalId
                || isAlreadyPendingAgentQueueMessage
                || isSelfEchoSuppressedCliWrite
                || isAgentQueueEchoSuppressedCliWrite
                || isDeterministicDaemonInitialPrompt;
            if (isDeliveredLocalPromptEcho && typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                params.onUserMessageDeliveryProvenByLocalEcho?.(msgSeq);
            }
            params.debug('[SOCKET] [UPDATE] Skipped user-message delivery to agent queue', {
                source: source ?? null,
                sentFrom: sentFrom ?? null,
                localId,
                agentQueueLocalId,
                isSelfEchoSuppressedLocalId,
                isAgentQueueEchoSuppressedLocalId,
                isAgentQueueEchoSuppressedForDelivery,
                isAgentQueueInFlightLocalId,
                canRetryUndeliveredAgentQueueInFlightLocalId,
                isAgentQueueDeliveredLocalId,
                isAlreadyPendingAgentQueueMessage,
                isPendingQueueMaterializedLocalId,
                isSelfEchoSuppressedCliWrite,
                isAgentQueueEchoSuppressedCliWrite,
                isProviderOwnedUserMessageEcho,
                isPassiveCommittedUserMessageLocalId,
                shouldRespectAgentQueueEchoSuppression,
                isDeterministicDaemonInitialPrompt,
            });
        }
        if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
            nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
        }
        params.emit('user-message', userResult.data);
    } else {
        const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
        if (coerced) {
            const candidate = {
                role: 'user' as const,
                content: { type: 'text' as const, text: coerced.text },
                createdAt: (bodyWithTransportFields as any).createdAt,
                localId: (bodyWithTransportFields as any).localId,
                localKey: (bodyWithTransportFields as any).localKey,
                meta: (bodyWithTransportFields as any).meta,
            };
            const parsedCandidate = UserMessageSchema.safeParse(candidate);
            if (parsedCandidate.success) {
                const agentQueueLocalId = localId ?? readNonEmptyString(parsedCandidate.data.localId);
                const isAlreadyPendingAgentQueueMessage = hasPendingMessageLocalId(params.pendingMessages, agentQueueLocalId);
                const isAgentQueueEchoSuppressedForDelivery = Boolean(
                    agentQueueLocalId && params.hasAgentQueueEchoSuppressedLocalId(agentQueueLocalId),
                );
                const isAgentQueueDeliveredLocalId = Boolean(
                    agentQueueLocalId && params.hasAgentQueueDeliveredLocalId?.(agentQueueLocalId),
                );
                const isAgentQueueInFlightLocalId = Boolean(
                    agentQueueLocalId && params.hasAgentQueueInFlightLocalId?.(agentQueueLocalId),
                );
                const canRetryUndeliveredAgentQueueInFlightLocalId =
                    params.allowRetryUndeliveredAgentQueueInFlightLocalIds === true
                    && isAgentQueueInFlightLocalId
                    && !isAgentQueueDeliveredLocalId
                    && !isAlreadyPendingAgentQueueMessage;
                const isAgentQueueInFlightBlockingDelivery =
                    isAgentQueueInFlightLocalId && !canRetryUndeliveredAgentQueueInFlightLocalId;
                const isEffectivelyAgentQueueEchoSuppressedLocalId =
                    isAlreadyPendingAgentQueueMessage
                    && isAgentQueueEchoSuppressedForDelivery;
                const parsedSource = parsedCandidate.data.meta?.source;
                const isSelfEchoSuppressedCliWrite = Boolean(
                    agentQueueLocalId
                    && params.hasSelfEchoSuppressedLocalId(agentQueueLocalId)
                    && parsedSource === 'cli',
                );
                const isAgentQueueEchoSuppressedCliWrite =
                    isAgentQueueEchoSuppressedForDelivery && parsedSource === 'cli';
                const isDeterministicDaemonInitialPrompt =
                    parsedSource === 'daemon-initial-prompt'
                    && isDeterministicDaemonInitialPromptLocalId(agentQueueLocalId, params.sessionId);
                const isProviderOwnedUserMessageEcho =
                    params.isProviderOwnedUserMessageEcho?.(parsedCandidate.data, params.update) === true;
                const isPassiveCommittedUserMessageLocalId = Boolean(
                    agentQueueLocalId && params.hasPassiveCommittedUserMessageLocalId?.(agentQueueLocalId),
                );
                const shouldDeliverToAgentQueue =
                    !isAgentQueueDeliveredLocalId
                    && !isAgentQueueInFlightBlockingDelivery
                    && !isAlreadyPendingAgentQueueMessage
                    && !isEffectivelyAgentQueueEchoSuppressedLocalId
                    && !isSelfEchoSuppressedCliWrite
                    && !isAgentQueueEchoSuppressedCliWrite
                    && !isDeterministicDaemonInitialPrompt
                    && !isProviderOwnedUserMessageEcho
                    && !isPassiveCommittedUserMessageLocalId
                    && (params.shouldDeliverUserMessageToAgentQueue?.(parsedCandidate.data, params.update) ?? true);
                if (shouldDeliverToAgentQueue) {
                    const deliverableSeq = typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null;
                    if (params.pendingMessageCallback) {
                        params.pendingMessageCallback(parsedCandidate.data, { seq: deliverableSeq });
                    } else {
                        params.pendingMessages.push(parsedCandidate.data);
                    }
                    if (agentQueueLocalId) {
                        params.markAgentQueueEchoSuppressedLocalId(agentQueueLocalId);
                        params.markAgentQueueInFlightLocalId?.(agentQueueLocalId);
                        if (params.deferAgentQueueDeliveryProofToProviderAcceptance !== true) {
                            params.markAgentQueueDeliveredLocalId?.(agentQueueLocalId);
                        }
                    }
                    if (deliverableSeq !== null) {
                        params.onUserMessageDeliveredToAgentQueue?.(deliverableSeq);
                    }
                } else {
                    const isDeliveredLocalPromptEcho =
                        isAgentQueueDeliveredLocalId
                        || isEffectivelyAgentQueueEchoSuppressedLocalId
                        || isAlreadyPendingAgentQueueMessage
                        || isSelfEchoSuppressedCliWrite
                        || isAgentQueueEchoSuppressedCliWrite
                        || isDeterministicDaemonInitialPrompt;
                    if (isDeliveredLocalPromptEcho && typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                        params.onUserMessageDeliveryProvenByLocalEcho?.(msgSeq);
                    }
                    params.debug('[SOCKET] [UPDATE] Skipped coerced user-message delivery to agent queue', {
                        localId,
                        agentQueueLocalId,
                        isAlreadyPendingAgentQueueMessage,
                        isAgentQueueEchoSuppressedForDelivery,
                        isAgentQueueInFlightLocalId,
                        canRetryUndeliveredAgentQueueInFlightLocalId,
                        isAgentQueueDeliveredLocalId,
                        isEffectivelyAgentQueueEchoSuppressedLocalId,
                        isSelfEchoSuppressedCliWrite,
                        isAgentQueueEchoSuppressedCliWrite,
                        isDeterministicDaemonInitialPrompt,
                        isProviderOwnedUserMessageEcho,
                        isPassiveCommittedUserMessageLocalId,
                        source: parsedCandidate.data.meta?.source ?? null,
                        sentFrom: parsedCandidate.data.meta?.sentFrom ?? null,
                    });
                }
                if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                    nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
                }
                params.emit('user-message', parsedCandidate.data);
                return {
                    handled: true,
                    lastObservedMessageSeq: nextLastObservedMessageSeq,
                    lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
                };
            }
        }

        const rawRole = (bodyWithTransportFields as any)?.role;
        if (rawRole === 'user') {
            params.debug('[SOCKET] [UPDATE] Dropping user prompt delivery: unable to coerce into a UserMessage', {
                issues: userResult.error.issues.map((i) => ({
                    code: i.code,
                    path: i.path,
                    expected: 'expected' in i ? (i as any).expected : undefined,
                    received: 'received' in i ? (i as any).received : undefined,
                })),
                bodyShape: summarizeValueShapeForLog(bodyWithTransportFields),
            });
        }
        params.emit('message', bodyWithTransportFields);
    }

    return {
        handled: true,
        lastObservedMessageSeq: nextLastObservedMessageSeq,
        lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
    };
}
