import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const updateSessionMetadata = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionAgentState = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const applySessionTurnMutation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const applySessionReadCursorOperation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const materializeNextPendingMessage = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const readSessionPendingState = vi.fn(async (): Promise<unknown> => ({ ok: true, pendingCount: 0, pendingVersion: 0 }));
const applySessionEnd = vi.fn(async (): Promise<unknown> => ({ ok: true }));
const recordSessionAlive = vi.fn(async (): Promise<unknown> => undefined);
const emitEphemeral = vi.fn();
const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn((_message: unknown, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-message" },
}));
const buildMessageUpdatedUpdate = vi.fn((_message: unknown, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "message-updated" },
}));
const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, _metadata: unknown, _agentState: unknown, projection?: unknown) => ({
        id: updateId,
        seq,
        body: { t: "update-session", ...(projection && typeof projection === "object" ? projection : {}) },
    }),
);
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata,
    updateSessionAgentState,
    applySessionTurnMutation,
    applySessionReadCursorOperation,
}));
vi.mock("@/app/session/applySessionEnd", () => ({
    applySessionEnd,
}));
vi.mock("@/app/presence/presenceRecorder", () => ({
    recordSessionAlive,
}));
vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        materializeNextPendingMessage,
        readSessionPendingState,
    };
});
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral,
        emitUpdate,
    },
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildPendingChangedUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate,
}));

const checkSessionAccess = vi.fn(async () => ({
    userId: "user-1",
    sessionId: "s-1",
    level: "owner",
    isOwner: true,
}));
const requireAccessLevel = vi.fn(() => true);
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

const getSessionParticipantUserIds = vi.fn(async () => ["user-1"]);
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));
const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
const isSessionValid = vi.fn(async () => true);
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { isSessionValid },
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => await fn({})),
}));
const log = vi.fn();
vi.mock("@/utils/logging/log", () => ({ log }));

describe("sessionUpdateHandler", () => {
    let registerSessionUpdateHandler: (userId: string, socket: any, connection: any) => void;

    beforeAll(async () => {
        ({ sessionUpdateHandler: registerSessionUpdateHandler } = await import("./sessionUpdateHandler"));
    }, 120_000);

    beforeEach(() => {
        createSessionMessage.mockClear();
        updateSessionMetadata.mockClear();
        updateSessionAgentState.mockClear();
        applySessionTurnMutation.mockClear();
        applySessionReadCursorOperation.mockClear();
        materializeNextPendingMessage.mockClear();
        readSessionPendingState.mockClear();
        readSessionPendingState.mockResolvedValue({ ok: true, pendingCount: 0, pendingVersion: 0 });
        applySessionEnd.mockClear();
        recordSessionAlive.mockClear();
        emitEphemeral.mockClear();
        emitUpdate.mockClear();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        checkSessionAccess.mockClear();
        requireAccessLevel.mockClear();
        getSessionParticipantUserIds.mockClear();
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(1);
        isSessionValid.mockClear();
        isSessionValid.mockResolvedValue(true);
        log.mockClear();
    });

    it("does not crash on invalid message payloads and acks with invalid-params when callback is provided", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            // minimal connection object for logging
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const callback = vi.fn();
        await handler({ sid: "s-1" }, callback); // missing message

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                ok: false,
                error: "invalid-params",
            }),
        );
    });

    it("does not crash on invalid message payloads when callback is missing (old clients)", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        await expect(handler({ sid: "s-1" })).resolves.toBeUndefined();
    });

    it("accepts plain message envelopes and forwards them to createSessionMessage", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: null,
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });

    it("serializes message writes for the same session across socket connections", async () => {
        let resolveFirstWrite!: (value: unknown) => void;
        const firstWrite = new Promise<unknown>((resolve) => {
            resolveFirstWrite = resolve;
        });
        createSessionMessage
            .mockImplementationOnce(async () => await firstWrite)
            .mockResolvedValueOnce({ ok: false, error: "invalid-params" });

        const firstSocket = createFakeSocket();
        const secondSocket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            firstSocket as any,
            { connectionType: "session-scoped", socket: firstSocket as any, userId: "user-1", sessionId: "s-1" } as any,
        );
        registerSessionUpdateHandler(
            "user-1",
            secondSocket as any,
            { connectionType: "session-scoped", socket: secondSocket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const payload = { sid: "s-1", message: { t: "plain", v: { type: "assistant", text: "hi" } } };
        const firstResult = getSocketHandler(firstSocket, "message")(payload, vi.fn());
        const secondResult = getSocketHandler(secondSocket, "message")(payload, vi.fn());

        await Promise.resolve();
        await Promise.resolve();
        expect(createSessionMessage).toHaveBeenCalledTimes(1);

        resolveFirstWrite({ ok: false, error: "invalid-params" });
        await Promise.all([firstResult, secondResult]);
        expect(createSessionMessage).toHaveBeenCalledTimes(2);
    });

    it("serializes turn mutations behind an in-flight message write for the same session", async () => {
        let resolveMessageWrite!: (value: unknown) => void;
        const messageWrite = new Promise<unknown>((resolve) => {
            resolveMessageWrite = resolve;
        });
        createSessionMessage.mockImplementationOnce(async () => await messageWrite);

        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const messageResult = getSocketHandler(socket, "message")(
            { sid: "s-1", message: { t: "plain", v: { type: "assistant", text: "hi" } } },
            vi.fn(),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(createSessionMessage).toHaveBeenCalledTimes(1);

        const turnResult = getSocketHandler(socket, "session-turn-mutation")({
            v: 1,
            sessionId: "s-1",
            mutationId: "mutation-1",
            action: "complete",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "provider-turn-1",
            observedAt: 123,
        }, vi.fn());
        await Promise.resolve();
        await Promise.resolve();
        expect(applySessionTurnMutation).not.toHaveBeenCalled();

        resolveMessageWrite({ ok: false, error: "invalid-params" });
        await Promise.all([messageResult, turnResult]);
        expect(applySessionTurnMutation).toHaveBeenCalledTimes(1);
    });

    it("does not emit per-message socket diagnostics by default", async () => {
        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, vi.fn());

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "websocket" }),
            expect.stringContaining("Received message from socket"),
        );
    });

    it("classifies legacy UI encrypted message payloads as user messages", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket,
            { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" },
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: "encrypted-payload",
            localId: "local-user-1",
            sentFrom: "web",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "encrypted", c: "encrypted-payload" },
            localId: "local-user-1",
            sidechainId: null,
            messageRole: "user",
        });
    });

    it("does not crash when plain message envelopes contain unserializable payloads", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const circular: any = { kind: "circular" };
        circular.self = circular;

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: circular } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: circular },
            localId: null,
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });

    it.each([
        {
            event: "update-metadata",
            payload: { sid: "s-2", metadata: "{}", expectedVersion: 1 },
            service: updateSessionMetadata,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ result: "forbidden" });
            },
        },
        {
            event: "update-state",
            payload: { sid: "s-2", agentState: "{}", expectedVersion: 1 },
            service: updateSessionAgentState,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ result: "forbidden" });
            },
        },
        {
            event: "session-turn-mutation",
            payload: {
                v: 1,
                sessionId: "s-2",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 123,
            },
            service: applySessionTurnMutation,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ result: "forbidden" });
            },
        },
        {
            event: "update-read-cursor",
            payload: { sid: "s-2", lastViewedSessionSeq: 7 },
            service: applySessionReadCursorOperation,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ result: "forbidden" });
            },
        },
        {
            event: "message",
            payload: { sid: "s-2", message: { t: "plain", v: { type: "user", text: "hi" } } },
            service: createSessionMessage,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
            },
        },
        {
            event: "session-end",
            payload: { sid: "s-2", time: 123 },
            service: applySessionEnd,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
            },
        },
        {
            event: "session-alive",
            payload: { sid: "s-2", time: Date.now(), thinking: false },
            service: recordSessionAlive,
            assertRejected: (callback: ReturnType<typeof vi.fn>) => {
                expect(callback).not.toHaveBeenCalled();
            },
        },
    ])("rejects $event when a session-scoped socket is bound to another session", async ({ event, payload, service, assertRejected }) => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, event);
        const callback = vi.fn();
        await handler(payload, callback);

        expect(service).not.toHaveBeenCalled();
        assertRejected(callback);
    });

    it("ignores runtimeIssueSummaryV1 and still updates agent state", async () => {
        updateSessionAgentState.mockResolvedValueOnce({
            ok: true,
            agentState: "{}",
            version: 2,
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "update-state");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            agentState: "{}",
            expectedVersion: 1,
            runtimeIssueSummaryV1: {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "auth_error",
                    source: "auth_error",
                    occurredAt: 123,
                    provider: "codex",
                    sanitizedPreview: "Authentication failed",
                },
            },
        }, callback);

        expect(updateSessionAgentState).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            expectedVersion: 1,
            agentStateCiphertext: "{}",
        });
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, agentState: "{}" });
    });

    it("applies session turn socket mutations and fans out materialized updates", async () => {
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            participantCursors: [
                { accountId: "user-1", cursor: 10 },
                { accountId: "user-2", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "session-turn-mutation");
        const callback = vi.fn();
        await handler({
            v: 1,
            sessionId: "s-1",
            mutationId: "mutation-1",
            action: "complete",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "turn-1",
            observedAt: 123,
        }, callback);

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "user-1",
            mutation: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "turn-1",
                observedAt: 123,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s-1", 10, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s-1", 11, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            applied: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
        });
    });

    it("does not skip the user-scoped socket that reports a session turn mutation", async () => {
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "begin",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();
        const connection = { connectionType: "user-scoped", socket: socket as any, userId: "user-1" } as any;

        registerSessionUpdateHandler("user-1", socket as any, connection);

        const handler = getSocketHandler(socket, "session-turn-mutation");
        const callback = vi.fn();
        await handler({
            v: 1,
            sessionId: "s-1",
            mutationId: "mutation-1",
            action: "begin",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "turn-1",
            observedAt: 123,
        }, callback);

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            userId: "user-1",
            recipientFilter: { type: "all-interested-in-session", sessionId: "s-1" },
        }));
        expect(emitUpdate.mock.calls[0]?.[0]?.skipSenderConnection).toBeUndefined();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "success", applied: true }));
    });

    it("forwards ready event hints so the message write service can apply owner-only validation", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                content: { t: "plain", v: { type: "event" } },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "event" } },
            localId: "ready-local",
            sessionEventType: "ready",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "event" } },
            localId: "ready-local",
            trustedSessionEventType: "ready",
        }));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s-1", 10, expect.any(String));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didWrite: true }));
    });

    it("does not forward caller-supplied attention overrides from the public socket event", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-user",
                seq: 10,
                localId: "local-user-1",
                sidechainId: null,
                content: { t: "plain", v: { type: "user", text: "hi" } },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "local-user-1",
            attentionImpact: {
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            },
            affectsUnread: false,
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "local-user-1",
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didWrite: true }));
    });

    it("throttles repeated socket no-op pending materialization calls per session", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 5,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-throttle" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        await handler({ sid: "s-throttle" }, firstCallback);
        await handler({ sid: "s-throttle" }, secondCallback);

        expect(materializeNextPendingMessage).toHaveBeenCalledTimes(1);
        expect(secondCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 5 });
    });

    it("throttles socket no-op pending materialization calls across reconnects for the same user and session", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 9,
        });
        const firstSocket = createFakeSocket();
        const secondSocket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            firstSocket as any,
            { connectionType: "session-scoped", socket: firstSocket as any, userId: "user-1", sessionId: "s-reconnect-throttle" } as any,
        );
        registerSessionUpdateHandler(
            "user-1",
            secondSocket as any,
            { connectionType: "session-scoped", socket: secondSocket as any, userId: "user-1", sessionId: "s-reconnect-throttle" } as any,
        );

        const firstHandler = getSocketHandler(firstSocket, "pending-materialize-next");
        const secondHandler = getSocketHandler(secondSocket, "pending-materialize-next");
        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        await firstHandler({ sid: "s-reconnect-throttle" }, firstCallback);
        await secondHandler({ sid: "s-reconnect-throttle" }, secondCallback);

        expect(materializeNextPendingMessage).toHaveBeenCalledTimes(1);
        expect(secondCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 9 });
    });

    it("uses a default no-op throttle longer than the legacy one-second idle poll", async () => {
        const previousThrottle = process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
        materializeNextPendingMessage.mockResolvedValue({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 11,
        });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-default-throttle" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const firstCallback = vi.fn();
            const secondCallback = vi.fn();
            await handler({ sid: "s-default-throttle" }, firstCallback);
            nowSpy.mockReturnValue(11_000);
            await handler({ sid: "s-default-throttle" }, secondCallback);

            expect(materializeNextPendingMessage).toHaveBeenCalledTimes(1);
            expect(secondCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 11 });
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("bypasses a cached no-op when the client has observed a newer pending version", async () => {
        materializeNextPendingMessage
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 5,
            })
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: true,
                didWriteMessage: true,
                message: {
                    id: "msg-new",
                    seq: 12,
                    localId: "pending-new",
                    messageRole: "user",
                    content: { t: "plain", v: { type: "user", text: "hello" } },
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                pendingCount: 0,
                pendingVersion: 7,
                participantCursorsMessage: [],
                participantCursorsPending: [],
                badgeAttentionChanged: false,
            });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-bypass" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        await handler({ sid: "s-bypass" }, firstCallback);
        await handler({ sid: "s-bypass", pendingVersion: 6 }, secondCallback);

        expect(materializeNextPendingMessage).toHaveBeenCalledTimes(2);
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didMaterialize: true,
            pendingVersion: 7,
            message: expect.objectContaining({ messageRole: "user" }),
        }));
    });

    it("bypasses a cached no-op when server pending state advanced after the cached response", async () => {
        materializeNextPendingMessage
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 5,
            })
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: true,
                didWriteMessage: true,
                message: {
                    id: "msg-new",
                    seq: 12,
                    localId: "pending-new",
                    messageRole: "user",
                    content: { t: "plain", v: { type: "user", text: "hello" } },
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                pendingCount: 0,
                pendingVersion: 6,
                participantCursorsMessage: [],
                participantCursorsPending: [],
                badgeAttentionChanged: false,
            });
        readSessionPendingState.mockResolvedValueOnce({ ok: true, pendingCount: 1, pendingVersion: 6 });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-server-advanced" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        await handler({ sid: "s-server-advanced" }, firstCallback);
        await handler({ sid: "s-server-advanced" }, secondCallback);

        expect(readSessionPendingState).toHaveBeenCalledWith({ actorUserId: "user-1", sessionId: "s-server-advanced" });
        expect(materializeNextPendingMessage).toHaveBeenCalledTimes(2);
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didMaterialize: true,
            pendingVersion: 6,
            message: expect.objectContaining({ messageRole: "user" }),
        }));
    });

    it("returns pending state when socket pending materialization has no pending row", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 5,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-noop-state" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({ sid: "s-noop-state" }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 5 });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("emits ready projection updates after socket pending materialization returns a ready projection", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: {
                id: "m-ready",
                seq: 7,
                localId: "ready-local",
                messageRole: "event",
                content: { t: "plain", v: { type: "event" } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [{ accountId: "user-1", cursor: 10 }],
            participantCursorsPending: [{ accountId: "user-1", cursor: 20 }],
            badgeAttentionChanged: false,
            readyProjection: {
                latestReadyEventSeq: 7,
                latestReadyEventAt: 1_000,
            },
        });
        getSessionParticipantUserIds.mockResolvedValueOnce(["user-1"]);
        markAccountChanged.mockResolvedValueOnce(11);
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({ sid: "s-1" }, callback);

        expect(materializeNextPendingMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
        });
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s-1", 10, expect.any(String));
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith("s-1", 11, expect.any(String), undefined, undefined, {
            latestReadyEventSeq: 7,
            latestReadyEventAt: 1_000,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(3);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didWrite: true,
            pendingCount: 0,
            pendingVersion: 2,
            message: expect.objectContaining({
                id: "m-ready",
                seq: 7,
                localId: "ready-local",
                messageRole: "event",
                content: { t: "plain", v: { type: "event" } },
                createdAt: 1_000,
                updatedAt: 1_000,
            }),
        }));
    });

});
