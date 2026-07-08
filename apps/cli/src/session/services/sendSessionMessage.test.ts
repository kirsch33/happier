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
        const assistantMessageRow = {
            id: 'msg-agent',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'done' } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn()
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValue([userMessageRow, assistantMessageRow]);
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

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                meta: expect.objectContaining({
                    happierDeliveryIntentV1: 'explicit_pending',
                }),
            }),
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

    it('does not report waited success when socket idle has no assistant activity after the current user turn', async () => {
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
            agentState: null,
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
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
    });

    it('does not report waited success when socket idle only observed a bare ready event after the current user turn', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const bareReadyRow = {
            id: 'msg-ready',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 100) {
                return [userMessageRow, bareReadyRow];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
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
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('does not report waited success when transcript activity is unavailable after local materialization', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 51) {
                return [userMessageRow];
            }
            throw new Error('transcript unavailable');
        });
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
        const waitForIdleViaSocket = vi.fn(async (request: Readonly<{
            initialTurnActivity?: Readonly<{ turnInFlight?: boolean }>;
        }>) => {
            if (request.initialTurnActivity?.turnInFlight === false) {
                return { idle: true as const, observedAt: 456 };
            }
            throw new Error('timeout');
        });

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
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        const result = await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
            localId: 'local-user',
        });

        expect(result).toEqual(expect.objectContaining({ ok: false }));
        expect(result).not.toEqual(expect.objectContaining({
            ok: true,
            waited: true,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({
            limit: 20,
        }));
        if (waitForIdleViaSocket.mock.calls.length > 0) {
            expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
                initialTurnActivity: expect.objectContaining({
                    turnInFlight: true,
                }),
            }));
        }
    });

    it('uses an explicit localId for runtime RPC delivery when provided', async () => {
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
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
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                localId: 'connected-service-continuation:test',
            }),
        }));
        expect(sendSessionMessageViaSocketCommitted).not.toHaveBeenCalled();
    });

    it('treats runtime queue-custody failures as failed sends without duplicating the committed row', async () => {
        const callSessionRpc = vi.fn(async () => ({
            ok: false,
            errorCode: 'session_user_message_not_consumed',
            error: 'session_user_message_not_consumed:local-stuck',
        }));
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didMaterialize: true,
            message: {
                id: 'msg-stuck',
                seq: 9,
                localId: 'local-stuck',
                messageRole: 'user' as const,
                content: null,
                createdAt: 100,
                updatedAt: 100,
            },
        }));

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
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
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'local-stuck',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'session_user_message_not_consumed:local-stuck',
        });

        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(sendSessionMessageViaSocketCommitted).not.toHaveBeenCalled();
    });

    it('invokes onCommittedViaSocket when the message is committed through the pending queue path', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => ({ ok: true })),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
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
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });

    it('wakes an inactive local session runner after committing a message through the pending queue', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didMaterialize: true,
            localId: 'local-wake',
            didWrite: true,
            message: {
                id: 'msg-wake',
                seq: 42,
                localId: 'local-wake',
                messageRole: 'user' as const,
                content: null,
                createdAt: 100,
                updatedAt: 100,
            },
        }));
        const spawnDaemonSession = vi.fn(async () => ({ success: true, sessionId: 'sess-1' }));
        const metadata = JSON.stringify({
            machineId: 'machine-1',
            path: '/workspace/project',
            flavor: 'claude',
        });

        vi.doMock('@/persistence', () => ({
            readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
        }));
        vi.doMock('@/daemon/controlClient', () => ({
            spawnDaemonSession,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => ({ ok: true })),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    metadata,
                    encryptionMode: 'plain',
                    path: '/workspace/project',
                    machineId: 'machine-1',
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
            idOrPrefix: 'sess-1',
            message: 'wake up',
            localId: 'local-wake',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-wake',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
            existingSessionId: 'sess-1',
            directory: '/workspace/project',
            machineId: 'machine-1',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            initialTranscriptAfterSeq: 41,
        }));
    });

    it('invokes onCommittedViaSocket when runtime RPC falls back to socket-committed delivery', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => {
                throw new Error('Socket connect timeout');
            }),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
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
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });
});
