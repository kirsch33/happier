import { buildMessageUpdatedUpdate, buildUpdateSessionUpdate } from '@/app/events/eventRouter';
import { parseSessionMessageRole } from '@/app/session/messageRole/resolveSessionMessageRole';
import { db } from '@/storage/db';
import { SessionTranscriptObservationProvenanceV1Schema } from '@happier-dev/protocol';
import type { Socket } from 'socket.io';

export const RELEASED_IOS_295_SOCKET_CATCH_UP_WINDOW_MS = 5 * 60 * 1_000;
export const RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_SESSIONS = 4;
export const RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_MESSAGES_PER_SESSION = 16;

function isReleasedIos295UserAgent(userAgent: string | undefined): boolean {
    return /^Happierdev\/295(?:\s|$)/.test(String(userAgent ?? ''));
}

/**
 * Build 295 starts its foreground changes read concurrently with opening the sync socket. A durable
 * message can therefore land after the read snapshot but before the socket subscription exists.
 * Replaying a bounded, recent tail after registration closes that exact gap for the released build;
 * its message-updated path is idempotent by message id. Remove this adapter after build 295 leaves
 * the supported native-client window.
 */
export async function replayReleasedIos295SocketCatchUp(params: Readonly<{
    accountId: string;
    userAgent: string | undefined;
    socket: Socket;
    connectedAtMs?: number;
}>): Promise<void> {
    if (!isReleasedIos295UserAgent(params.userAgent)) return;

    const connectedAtMs = params.connectedAtMs ?? Date.now();
    const changedAfter = new Date(connectedAtMs - RELEASED_IOS_295_SOCKET_CATCH_UP_WINDOW_MS);
    const sessions = await db.session.findMany({
        where: { accountId: params.accountId },
        orderBy: [
            { updatedAt: 'desc' },
            { id: 'desc' },
        ],
        take: RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_SESSIONS,
        select: {
            id: true,
            seq: true,
            metadata: true,
            metadataVersion: true,
            messages: {
                where: { updatedAt: { gte: changedAfter } },
                orderBy: [
                    { seq: 'desc' },
                    { id: 'desc' },
                ],
                take: RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_MESSAGES_PER_SESSION,
                select: {
                    id: true,
                    seq: true,
                    content: true,
                    localId: true,
                    sidechainId: true,
                    messageRole: true,
                    createdAt: true,
                    updatedAt: true,
                    sourceCreatedAt: true,
                    sourceUpdatedAt: true,
                    transcriptObservationProvenance: true,
                    deliveryResolution: true,
                },
            },
        },
    });

    for (const session of sessions) {
        params.socket.emit('update', buildUpdateSessionUpdate(
            session.id,
            session.seq,
            `released-ios295-session-catch-up:${session.id}:${session.metadataVersion}`,
            { value: session.metadata, version: session.metadataVersion },
        ));
    }

    const messages = sessions.flatMap((session) => session.messages.map((message) => ({
        sessionId: session.id,
        message,
    })));
    messages.sort((left, right) => {
        const byUpdatedAt = left.message.updatedAt.getTime() - right.message.updatedAt.getTime();
        if (byUpdatedAt !== 0) return byUpdatedAt;
        const bySession = left.sessionId.localeCompare(right.sessionId);
        if (bySession !== 0) return bySession;
        return left.message.seq - right.message.seq;
    });

    for (const { sessionId, message } of messages) {
        const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(
            message.transcriptObservationProvenance,
        );
        params.socket.emit('update', buildMessageUpdatedUpdate(
            {
                ...message,
                messageRole: parseSessionMessageRole(message.messageRole),
                transcriptObservationProvenance: provenance.success ? provenance.data : null,
            },
            sessionId,
            message.seq,
            `released-ios295-catch-up:${message.id}:${message.updatedAt.getTime()}`,
        ));
    }
}
