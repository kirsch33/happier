import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendSessionMessage', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('uses transcript scan after materialized send when refreshed projection is idle', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [userMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: '{"requests":{"stale":{"createdAt":1}}}',
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'in_progress',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            sessionId: 'sess-1',
            waited: true,
        }));

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
        }));
        expect(waitForIdleViaSocket).not.toHaveBeenCalledWith(expect.objectContaining({
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('rejects inactive sends before appending an unprocessed user row', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq: vi.fn(async () => []),
            fetchEncryptedTranscriptPageLatest: vi.fn(async () => []),
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById: vi.fn(),
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-inactive',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-inactive',
                    active: false,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-inactive',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
        })).resolves.toMatchObject({
            ok: false,
            code: 'session_inactive',
        });

        expect(sendSessionMessageViaSocketCommitted).not.toHaveBeenCalled();
        expect(waitForTranscriptEncryptedMessageByLocalId).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).not.toHaveBeenCalled();
    });
});
