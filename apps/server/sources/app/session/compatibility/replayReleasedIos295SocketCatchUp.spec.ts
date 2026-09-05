import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';

const findMany = vi.hoisted(() => vi.fn());
vi.mock('@/storage/db', () => ({ db: { session: { findMany } } }));

import {
    RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_MESSAGES_PER_SESSION,
    RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_SESSIONS,
    replayReleasedIos295SocketCatchUp,
} from './replayReleasedIos295SocketCatchUp';

describe('released iOS build 295 socket catch-up', () => {
    beforeEach(() => findMany.mockReset());

    it("replays a bounded recent message tail after the released client socket is subscribed", async () => {
        const firstUpdatedAt = new Date("2026-09-04T20:00:01.000Z");
        const secondUpdatedAt = new Date("2026-09-04T20:00:02.000Z");
        findMany.mockResolvedValue([{ id: "session-1", messages: [
            {
                id: "message-1", seq: 41, content: { t: "plain", v: "one" }, localId: null,
                sidechainId: null, messageRole: "agent", createdAt: firstUpdatedAt, updatedAt: firstUpdatedAt,
                sourceCreatedAt: null, sourceUpdatedAt: null, transcriptObservationProvenance: null, deliveryResolution: null,
            },
            {
                id: "message-2", seq: 42, content: { t: "plain", v: "two" }, localId: null,
                sidechainId: null, messageRole: "agent", createdAt: secondUpdatedAt, updatedAt: secondUpdatedAt,
                sourceCreatedAt: null, sourceUpdatedAt: null, transcriptObservationProvenance: null, deliveryResolution: null,
            },
        ] }]);
        const socket = { emit: vi.fn() };

        await replayReleasedIos295SocketCatchUp({
            accountId: "account-1",
            userAgent: "Happierdev/295 CFNetwork/3860.700.1 Darwin/25.6.0",
            socket: socket as unknown as Socket,
            connectedAtMs: Date.parse("2026-09-04T20:00:03.000Z"),
        });

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "account-1" },
            take: RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_SESSIONS,
            select: { id: true, messages: expect.objectContaining({
                take: RELEASED_IOS_295_SOCKET_CATCH_UP_MAX_MESSAGES_PER_SESSION,
            }) },
        }));
        expect(socket.emit).toHaveBeenCalledTimes(2);
        expect(socket.emit).toHaveBeenNthCalledWith(1, "update", expect.objectContaining({
            body: expect.objectContaining({ t: "message-updated", sid: "session-1", message: expect.objectContaining({ id: "message-1", seq: 41 }) }),
        }));
        expect(socket.emit).toHaveBeenNthCalledWith(2, "update", expect.objectContaining({
            body: expect.objectContaining({ t: "message-updated", sid: "session-1", message: expect.objectContaining({ id: "message-2", seq: 42 }) }),
        }));
    });

    it("does nothing for other native builds or web clients", async () => {
        const socket = { emit: vi.fn() };
        for (const userAgent of ["Happierdev/296 CFNetwork/3860.700.1 Darwin/25.6.0", "Mozilla/5.0"]) {
            await replayReleasedIos295SocketCatchUp({
                accountId: "account-1",
                userAgent,
                socket: socket as unknown as Socket,
                connectedAtMs: Date.now(),
            });
        }
        expect(findMany).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
    });
});
