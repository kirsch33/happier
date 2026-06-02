import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import axios from 'axios';
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageAckResponseSchema, MessageContent, Metadata, ServerToClientEvents, Session, SessionMessageContentSchema, Update, UserMessage, UserMessageSchema, Usage } from '../types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import type { RawJSONLines } from '@/backends/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { registerEphemeralTaskHandlers } from '@/rpc/handlers/ephemeralTasks';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { readCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { addDiscardedCommittedMessageLocalIds } from '../queue/discardedCommittedMessageLocalIds';
import { fetchSessionSnapshotUpdateFromServer, shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import { createUserScopedSocket } from './sockets';
import { isToolTraceEnabled, recordAcpToolTraceEventIfNeeded, recordClaudeToolTraceEvents, recordCodexToolTraceEventIfNeeded } from './toolTrace';
import { updateSessionAgentStateWithAck, updateSessionMetadataWithAck } from './stateUpdates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { isSessionContinuationRecoveryBlockingPendingDrain } from '@happier-dev/protocol';
import type { PrimaryTurnStatusV1, SessionMessageRole } from '@happier-dev/protocol';
import { calculateCost } from '@/utils/pricing';
import { buildAcpAgentMessageEnvelope, shouldTraceAcpMessageType } from './acpMessageEnvelope';
import { normalizeAcpSessionMessageBody, normalizeCodexSessionMessageBody } from './sessionOutboundMessageNormalization';
import {
    resolveAcpSessionMessageRole,
    resolveClaudeSessionMessageRole,
    resolveCodexSessionMessageRole,
    resolveSessionEventMessageRole,
} from './messageRole';
import { buildUsageReportFromAcpTokenCount } from './acpTokenCountUsageReport';
import {
    fetchLatestUserPermissionIntentFromEncryptedTranscript,
    fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from './transcriptQueries';
import {
    discardPendingQueueV2Messages,
    listPendingQueueV2LocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from './pendingQueueV2Transport';
import { waitForTranscriptEncryptedMessageByLocalId } from './transcriptMessageLookup';
import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { isV2ChangesSyncEnabled, runSessionChangesSyncOnConnect } from './sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../changes';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';
import { handleSessionStateUpdate } from './sessionStateUpdateHandling';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import {
    createTurnAssistantTextSnapshotStore,
    extractTurnAssistantTextFromSessionContent,
    type TurnAssistantTextCandidate,
    type TurnAssistantTextSnapshot,
} from './turnAssistantTextSnapshot';
import { buildDaemonInitialPromptLocalId, consumeDaemonInitialPromptFromEnv } from '@/agent/runtime/daemonInitialPrompt';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { createKeyedSingleFlightScheduler, type KeyedSingleFlightScheduler } from '../connection/scheduling';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { isAuthenticationError, readAuthenticationStatus } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import {
    executeExecutionRunAction,
    getExecutionRun,
    listExecutionRuns,
    sendExecutionRunMessage,
    startExecutionRun,
    stopExecutionRun,
    waitForExecutionRun,
} from '@/session/services/executionRuns';
import { normalizeExecutionRunWaitTimeoutMs } from '@/session/services/executionRunWaitTiming';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { updateMetadataBestEffort } from './sessionWritesBestEffort';
import { normalizeAgentPromptPayload } from '@/agent/core/AgentPromptPayload';
import type { MaterializeNextPendingResult } from './sessionClientPort';
import {
    CommittedUserMessageSeqTracker,
    type CommittedUserMessageSeqWaitOptions,
} from './committedUserMessageSeqTracker';
import {
    createSessionMutationOutbox,
    type SessionMutationOutbox,
} from './mutations/createSessionMutationOutbox';
import {
    createSessionEndMutation,
} from './mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { observeAcpLifecycleMarker } from '@/agent/runtime/session/turn/lifecycleMarkerAdapter';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';
import { createSessionTurnMutationWriter } from '@/agent/runtime/session/turn/writer';
import { notifyDaemonConnectedServiceTurnLifecycle } from '@/daemon/controlClient';
import {
    applyKnownPendingQueueState,
    derivePendingQueueStateAfterMaterializeResult,
    readKnownPendingQueueState,
    UNKNOWN_PENDING_QUEUE_STATE,
    type KnownPendingQueueState,
    type PendingQueueState,
} from './pendingQueueState';

function arePendingQueueStatesEqual(left: PendingQueueState, right: PendingQueueState): boolean {
    if (left.known !== right.known) return false;
    if (!left.known || !right.known) return true;
    return left.pendingCount === right.pendingCount && left.pendingVersion === right.pendingVersion;
}

function resolveSessionSocketMachineIdForBootstrap(metadata: Metadata | null): string | undefined {
    if (!metadata || typeof metadata.machineId !== 'string') {
        return undefined;
    }
    const machineId = metadata.machineId.trim();
    return machineId.length > 0 ? machineId : undefined;
}

function readUnknownRecordProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
}

export function classifySessionTransportErrorToProbeResult(
    error: unknown,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    const statusCode = readAuthenticationStatus(error);
    if (!statusCode) return null;
    return {
        status: 'auth_failed',
        statusCode,
        errorMessage: error instanceof Error ? error.message : 'Authentication failed',
    };
}

export class ApiSessionClient extends EventEmitter {
    private static readonly STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private userMessageCallbackAttachedAtMs: number | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private readonly outboundShapeLogger = createEventShapeLoggerForLog({ logger, scope: 'session-out' });
    private sessionConnectionSupervisor: ManagedConnectionSupervisor | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private queuedDisconnectedSessionMessages = new Map<string, { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }>();
    private readonly sessionEncryptionMode: 'e2ee' | 'plain';
    private disconnectedSendLogged = false;
    // LocalId registries are intentionally phase-specific:
    // pendingMaterializedLocalIds: optimistic UI rows awaiting materialization.
    // committedLocalIdsAwaitingEcho: committed outbound rows awaiting socket echo.
    // pendingQueueMaterializedLocalIds: pending queue rows already emitted locally.
    // agentQueueEchoSuppressedLocalIds: RPC prompt attempts already fed to the live agent.
    private readonly pendingMaterializedLocalIds = new Set<string>();
    private readonly committedLocalIdsAwaitingEcho = new Set<string>();
    private readonly pendingQueueMaterializedLocalIds = new Set<string>();
    private readonly agentQueueEchoSuppressedLocalIds = new Set<string>();
    private readonly committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly agentQueueEchoSuppressedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingWakeSeq = 0;
    private pendingQueueState: PendingQueueState = UNKNOWN_PENDING_QUEUE_STATE;
    private pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    private lastPendingQueueStateReconcileAt = 0;
    private readonly pendingCommitRetryAttemptsByLocalId = new Map<string, number>();
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private snapshotSyncInFlight: Promise<void> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private readonly receivedMessageIds = new Set<string>();
    private lastObservedMessageSeq = 0;
    private lastObservedUserMessageSeq = 0;
    private readonly turnAssistantTextSnapshotStore = createTurnAssistantTextSnapshotStore({
        maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
    });
    private hasConnectedOnce = false;
    private changesSyncInFlight: Promise<void> | null = null;
    private accountIdPromise: Promise<string> | null = null;
    private daemonInitialPrompt: string | null = null;
    private daemonInitialPromptSeeded = false;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private startupMessageCatchUpInitialAfterSeqIsExplicit = false;
    private readonly startupMessageCatchUpExplicitAfterSeq: number | null;
    private readonly startedByDaemonProcess: boolean;
    private readonly transcriptStorage: 'persisted' | 'direct';
    private readonly materializationRecoveryScheduler: KeyedSingleFlightScheduler;
    private readonly transcriptRecoveryErrorStateByLocalId = new Map<string, { lastLoggedAt: number; suppressed: number }>();
    private messageCommitQueueTail: Promise<unknown> = Promise.resolve();
    private readonly pendingSessionTurnWrites = new Set<Promise<void>>();
    private readonly pendingSessionEndWrites = new Set<Promise<void>>();
    private readonly committedUserMessageSeqTracker = new CommittedUserMessageSeqTracker();
    private readonly sessionMutationOutbox: SessionMutationOutbox;
    readonly sessionTurnLifecycle: SessionTurnLifecycleController;
    private readonly sessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    readonly executionRuns = {
        start: async (request: unknown) =>
            await startExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        list: async (request: unknown) =>
            await listExecutionRuns({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        get: async (request: unknown) =>
            await getExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        send: async (request: unknown) =>
            await sendExecutionRunMessage({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        stop: async (request: unknown) =>
            await stopExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        action: async (request: unknown) =>
            await executeExecutionRunAction({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        wait: async (request: unknown) => {
            const rawTimeoutSeconds = readUnknownRecordProperty(request, 'timeoutSeconds');

            const rawPollIntervalMs = readUnknownRecordProperty(request, 'pollIntervalMs');
            const requestPollIntervalMs =
                typeof rawPollIntervalMs === 'number' && Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
                    ? Math.min(60_000, rawPollIntervalMs)
                    : null;
            const envPollIntervalRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
            const envPollIntervalParsed = envPollIntervalRaw ? Number.parseInt(envPollIntervalRaw, 10) : NaN;
            const envPollIntervalMs =
                Number.isFinite(envPollIntervalParsed) && envPollIntervalParsed > 0 ? Math.min(60_000, envPollIntervalParsed) : 1_000;

            return await waitForExecutionRun({
                ...this.getExecutionRunServiceContext(),
                runId: String(readUnknownRecordProperty(request, 'runId') ?? ''),
                timeoutMs: normalizeExecutionRunWaitTimeoutMs(rawTimeoutSeconds),
                pollIntervalMs: requestPollIntervalMs ?? envPollIntervalMs,
            });
        },
    } as const;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    beginTurnAssistantTextSnapshot(params?: {
        turnToken?: string;
        startSeqExclusive?: number | null;
    }): string {
        return this.turnAssistantTextSnapshotStore.beginTurn(params);
    }

    getTurnAssistantTextSnapshot(params: {
        turnToken?: string | null;
        startSeqExclusive?: number | null;
    }): TurnAssistantTextSnapshot | null {
        return this.turnAssistantTextSnapshotStore.getForTurn(params);
    }

    private getExecutionRunServiceContext() {
        return {
            token: this.token,
            sessionId: this.sessionId,
            mode: this.sessionEncryptionMode,
            ctx: {
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            },
        } as const;
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; queueing ${context} until supervised reconnect.`,
            details
        );
    }

    private observeTurnAssistantTextFromSessionContent(
        content: unknown,
        params: Omit<TurnAssistantTextCandidate, 'text' | 'provider' | 'sidechainId'> & {
            provider?: string | null;
            sidechainId?: string | null;
        },
    ): void {
        const extracted = extractTurnAssistantTextFromSessionContent(content);
        if (!extracted) return;
        this.turnAssistantTextSnapshotStore.observe({
            ...params,
            text: extracted.text,
            provider: params.provider ?? extracted.provider,
            sidechainId: params.sidechainId ?? extracted.sidechainId,
        });
    }

	    constructor(token: string, session: Session) {
	        super()
	        this.token = token;
	        this.sessionId = session.id;
	        this.metadata = session.metadata;
	        this.metadataVersion = session.metadataVersion;
	        this.agentState = session.agentState;
	        this.agentStateVersion = session.agentStateVersion;
            this.pendingQueueState = readKnownPendingQueueState(session) ?? UNKNOWN_PENDING_QUEUE_STATE;
            this.lastObservedMessageSeq =
                typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
                    ? Math.trunc(session.seq)
                    : 0;
            this.startupMessageCatchUpExplicitAfterSeq =
                typeof session.initialTranscriptAfterSeq === 'number'
                && Number.isFinite(session.initialTranscriptAfterSeq)
                && session.initialTranscriptAfterSeq >= 0
                    ? Math.trunc(session.initialTranscriptAfterSeq)
                    : null;
	        if (session.encryptionMode === 'plain') {
	            this.sessionEncryptionMode = 'plain';
	            // Plaintext sessions should not require encryption materials. Keep dummy values for
	            // legacy surfaces that still accept encryption key args; they must branch on
	            // `sessionEncryptionMode` and never encrypt/decrypt.
	            this.encryptionKey = new Uint8Array(32);
	            this.encryptionVariant = 'dataKey';
	        } else {
	            this.sessionEncryptionMode = 'e2ee';
	            this.encryptionKey = session.encryptionKey;
	            this.encryptionVariant = session.encryptionVariant;
	        }
	        this.transcriptStorage = (() => {
	            const raw = typeof process.env.HAPPIER_TRANSCRIPT_STORAGE === 'string'
	                ? process.env.HAPPIER_TRANSCRIPT_STORAGE.trim().toLowerCase()
	                : '';
	            return raw === 'direct' ? 'direct' : 'persisted';
	        })();
	        this.daemonInitialPrompt = consumeDaemonInitialPromptFromEnv();
        this.materializationRecoveryScheduler = createKeyedSingleFlightScheduler({
            delayMs: configuration.transcriptRecoveryDelayMs,
            maxConcurrent: configuration.transcriptRecoveryMaxConcurrent,
        });
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.indexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            encryptionMode: this.sessionEncryptionMode,
            logger: (msg, data) => logger.debug(msg, data)
        });
        const resolvedFlavor = typeof (this.metadata as any)?.flavor === 'string' ? String((this.metadata as any).flavor).trim() : '';
        const parentProvider: CatalogAgentId =
            (CATALOG_AGENT_IDS as readonly string[]).includes(resolvedFlavor) ? (resolvedFlavor as CatalogAgentId) : 'claude';

        registerSessionHandlers(this.rpcHandlerManager, this.metadata.path, {
            getSessionMetadata: () => this.getMetadataSnapshot(),
            updateSessionMetadata: (handler) => this.updateMetadata(handler),
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            sessionRuntimeControls: this.sessionRuntimeControls,
        });

        const transcriptWriter = {
            appendUserText: (text: string, meta: Record<string, unknown>) => {
                this.sendUserTextMessage(text, { meta });
            },
            appendAssistantText: (text: string, meta: Record<string, unknown>) => {
                this.sendAgentMessage(parentProvider as any, { type: 'message', message: text }, { meta });
            },
            appendUserTextCommitted: async (text: string, meta: Record<string, unknown>) => {
                await this.sendUserTextMessageCommitted(text, { localId: randomUUID(), meta });
            },
            appendAssistantTextCommitted: async (text: string, meta: Record<string, unknown>) => {
                await this.sendAgentMessageCommitted(parentProvider as any, { type: 'message', message: text }, { localId: randomUUID(), meta });
            },
        };

        const hasBudgetCaps =
            configuration.executionRunsMaxConcurrentPerSession !== null
            || configuration.ephemeralTasksMaxConcurrentPerSession !== null
            || typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            || (configuration.executionBudgetMaxConcurrentByClass && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0);
        const executionBudgetRegistry = hasBudgetCaps
            ? new ExecutionBudgetRegistry({
                maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
                maxConcurrentEphemeralTasks: configuration.ephemeralTasksMaxConcurrentPerSession,
                ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
                    ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
                    : {}),
                ...(configuration.executionBudgetMaxConcurrentByClass
                    && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
                    ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
                    : {}),
            })
            : undefined;

        // Always register execution-run RPC methods so callers never see "RPC method not available".
        // Feature gating is enforced inside the handler implementations.
        const streamedTranscriptSession = {
            sendAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }) =>
                this.sendAgentMessageCommitted(provider, body, opts),
            sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }) =>
                this.sendAgentMessageEphemeral(provider, body, opts),
        };

        registerExecutionRunHandlers(this.rpcHandlerManager, {
            sessionId: this.sessionId,
            cwd: this.metadata?.path ?? process.cwd(),
            serverUrl: configuration.serverUrl,
            parentProvider,
            createBackend: ({ backendId, backendTarget, permissionMode, modelId, accountSettings, start }) =>
                createExecutionRunBackend({
                    cwd: this.metadata?.path ?? process.cwd(),
                    backendId,
                    backendTarget,
                    permissionMode,
                    modelId,
                    accountSettings,
                    start,
                }),
            sendAcp: (provider, body, opts) => this.sendAgentMessage(provider as any, body as any, opts),
            streamedTranscriptSession,
            transcriptWriter,
            budgetRegistry: executionBudgetRegistry,
            onExecutionRunPublicStateUpdated: (run) => {
                try {
                    if (!this.socket.connected) {
                        return;
                    }
                    this.socket.emit('execution-run-updated', { sid: this.sessionId, run });
                } catch {
                    // best effort
                }
            },
            policy: {
                maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
                boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
                reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
                maxTurns: configuration.executionRunsMaxTurns,
                maxDepth: configuration.executionRunsMaxDepth,
            },
            resolveAccountSettings: async () => {
                const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
                if (activeSettings) return activeSettings;
                const credentials = await readCredentials();
                if (!credentials) return null;
                const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
                return context.settings ?? null;
            },
        });

        registerEphemeralTaskHandlers(this.rpcHandlerManager, {
          workingDirectory: this.metadata?.path ?? process.cwd(),
          createBackend: ({ backendId, permissionMode, backendTarget }) =>
            createExecutionRunBackend({
              cwd: this.metadata?.path ?? process.cwd(),
              backendId,
              permissionMode,
              ...(backendTarget ? { backendTarget } : {}),
            }),
          budgetRegistry: executionBudgetRegistry,
        });

        //
        // Create socket
        //

        // A user-scoped socket is used to observe our own materialized pending-queue messages.
        //
        // Server-side broadcasting skips the sender connection, so a session-scoped agent that emits a
        // transcript message will not receive its own "new-message" update. Without observing the
        // materialized message, the agent can't enqueue it for processing.
        //
        // A second (user-scoped) connection will still receive the broadcast, letting us safely
        // drive the normal update pipeline without server changes.
        this.userSocket = createUserScopedSocket({ token: this.token });
        this.sessionMutationOutbox = createSessionMutationOutbox({
            token: this.token,
            sessionId: this.sessionId,
            getSocket: () => this.socket as any,
            requestReconnect: (reason) => this.kickSessionSocketReconnectForDurableMutation(reason),
        });
        this.sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: this.sessionId,
            enqueueSessionTurn: createSessionTurnMutationWriter(this.sessionMutationOutbox).enqueueSessionTurn,
            onTurnLifecycleEvent: (event) => {
                void this.notifyDaemonConnectedServiceTurnLifecycle(event);
            },
        });

        //
        // Handlers
        //
        this.userSocket.on('update', (data: Update) => this.handleUpdate(data, { source: 'user-scoped' }));
        // Broadcast-safe session events are optional hints; ignore unless explicitly used.
        this.userSocket.on('session', () => {});

        let currentTransportSocket: typeof this.socket | null = null;
        this.sessionConnectionSupervisor = createManagedConnectionSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport: () => {
                const { socket, transport } = createSessionSocketTransport({
                    token: this.token,
                    sessionId: this.sessionId,
                    machineId: resolveSessionSocketMachineIdForBootstrap(this.metadata),
                });
                this.socket = socket;
                currentTransportSocket = socket;
                this.installSessionSocketEventHandlers(socket);
                return transport;
            },
            classifyTransportErrorToProbeResult: classifySessionTransportErrorToProbeResult,
            probeReadiness: createLoopbackReadinessProbe({
                serverUrl: configuration.apiServerUrl,
                token: this.token,
            }),
            onStateChange: (state) => {
                this.currentConnectionState = state;
            },
            onConnected: async () => {
                logger.debug('Socket connected successfully');
                this.disconnectedSendLogged = false;
                connectionState.recover();
                this.rpcHandlerManager.onSocketConnect(this.socket);

                const isReconnect = this.hasConnectedOnce;
                this.hasConnectedOnce = true;

                if (this.shouldKeepUserSocketConnected()) {
                    this.kickUserSocketConnect();
                }

                await this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' }).catch((error) => {
                    logger.debug('[API] Session changes sync on connect failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });

                if (shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion })) {
                    void this.syncSessionSnapshotFromServer({ reason: 'connect' });
                }

                await this.flushQueuedSessionMessagesOnReconnect().catch((error) => {
                    logger.debug('[API] Failed to replay queued session messages on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
                await this.sessionMutationOutbox.flush('connect').catch((error) => {
                    logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
            onDisconnected: async ({ event }) => {
                logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
            onAuthFailed: async () => {
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
        });

        void this.sessionConnectionSupervisor.start();
    }

    setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
        delete this.sessionRuntimeControls.refreshGoal;
        delete this.sessionRuntimeControls.setGoal;
        delete this.sessionRuntimeControls.clearGoal;
        delete this.sessionRuntimeControls.listVendorPlugins;
        delete this.sessionRuntimeControls.listSkills;
        delete this.sessionRuntimeControls.startInlineReview;
        delete this.sessionRuntimeControls.invalidateConnectedServiceAuthTransports;
        delete this.sessionRuntimeControls.enableUsageLimitWaitResume;
        delete this.sessionRuntimeControls.cancelUsageLimitWaitResume;
        delete this.sessionRuntimeControls.checkUsageLimitRecoveryNow;
        delete this.sessionRuntimeControls.handleUserMessage;
        if (!controls) return;
        if (typeof controls.refreshGoal === 'function') this.sessionRuntimeControls.refreshGoal = controls.refreshGoal;
        if (typeof controls.setGoal === 'function') this.sessionRuntimeControls.setGoal = controls.setGoal;
        if (typeof controls.clearGoal === 'function') this.sessionRuntimeControls.clearGoal = controls.clearGoal;
        if (typeof controls.listVendorPlugins === 'function') this.sessionRuntimeControls.listVendorPlugins = controls.listVendorPlugins;
        if (typeof controls.listSkills === 'function') this.sessionRuntimeControls.listSkills = controls.listSkills;
        if (typeof controls.startInlineReview === 'function') this.sessionRuntimeControls.startInlineReview = controls.startInlineReview;
        if (typeof controls.invalidateConnectedServiceAuthTransports === 'function') {
            this.sessionRuntimeControls.invalidateConnectedServiceAuthTransports = controls.invalidateConnectedServiceAuthTransports;
        }
        if (typeof controls.enableUsageLimitWaitResume === 'function') this.sessionRuntimeControls.enableUsageLimitWaitResume = controls.enableUsageLimitWaitResume;
        if (typeof controls.cancelUsageLimitWaitResume === 'function') this.sessionRuntimeControls.cancelUsageLimitWaitResume = controls.cancelUsageLimitWaitResume;
        if (typeof controls.checkUsageLimitRecoveryNow === 'function') this.sessionRuntimeControls.checkUsageLimitRecoveryNow = controls.checkUsageLimitRecoveryNow;
        if (typeof controls.handleUserMessage === 'function') this.sessionRuntimeControls.handleUserMessage = controls.handleUserMessage;
    }

    private debugTranscriptRecoveryFetchError(localId: string, error: unknown): void {
        const now = Date.now();
        const throttleMs = configuration.transcriptRecoveryErrorLogThrottleMs;
        const state = this.transcriptRecoveryErrorStateByLocalId.get(localId) ?? { lastLoggedAt: 0, suppressed: 0 };

        if (state.lastLoggedAt === 0 || now - state.lastLoggedAt >= throttleMs) {
            const suppressed = state.suppressed;
            state.lastLoggedAt = now;
            state.suppressed = 0;
            this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
            logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', {
                localId,
                suppressedSinceLastLog: suppressed,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        state.suppressed += 1;
        this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
    }

    private applyPendingQueueState(state: KnownPendingQueueState, opts?: { emit?: boolean }): boolean {
        const applied = applyKnownPendingQueueState(this.pendingQueueState, state);
        this.pendingQueueState = applied.state;
        if (applied.changed) {
            this.pendingWakeSeq += 1;
            if (opts?.emit === true && !this.closed) {
                this.emit('metadata-updated');
            }
        }
        return applied.changed;
    }

    async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
        if (this.closed) return false;
        if (!opts?.force && this.pendingQueueState.known && this.pendingQueueState.pendingCount > 0) {
            return false;
        }

        const now = Date.now();
        if (
            !opts?.force
            && this.lastPendingQueueStateReconcileAt > 0
            && now - this.lastPendingQueueStateReconcileAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return false;
        }

        if (this.pendingQueueStateReconcileInFlight) {
            return await this.pendingQueueStateReconcileInFlight;
        }

        const run = async (): Promise<boolean> => {
            this.lastPendingQueueStateReconcileAt = Date.now();
            const before = this.pendingQueueState;
            await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            return !arePendingQueueStatesEqual(before, this.pendingQueueState);
        };

        const reconcile = run().finally(() => {
            if (this.pendingQueueStateReconcileInFlight === reconcile) {
                this.pendingQueueStateReconcileInFlight = null;
            }
        });
        this.pendingQueueStateReconcileInFlight = reconcile;
        return await reconcile;
    }

    shouldAttemptPendingMaterialization(): boolean {
        if (isSessionContinuationRecoveryBlockingPendingDrain(this.metadata)) return false;
        return this.pendingQueueState.known && this.pendingQueueState.pendingCount > 0;
    }

    private syncSessionSnapshotFromServer(opts: { reason: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async () => {
            try {
                const request = () => fetchSessionSnapshotUpdateFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                    currentMetadata: this.metadata,
                    currentAgentState: this.agentState,
                });
                const supervisor = this.sessionConnectionSupervisor;
                const update = supervisor
                    ? await runSupervisedRequest({
                        supervisor,
                        requireAuth: true,
                        requireOnline: false,
                        request,
                    })
                    : await request();

                if (this.closed) return;

                if (update.metadata) {
                    this.metadata = update.metadata.metadata;
                    this.metadataVersion = update.metadata.metadataVersion;
                    this.emit('metadata-updated');
                }

                if (update.agentState) {
                    this.agentState = update.agentState.agentState;
                    this.agentStateVersion = update.agentState.agentStateVersion;
                }

                if (update.pendingQueueState) {
                    this.applyPendingQueueState(update.pendingQueueState, { emit: true });
                }
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', {
                    reason: opts.reason,
                    error: serializeAxiosErrorForLog(error),
                });
            }
        })();

        const inFlight = p.finally(() => {
            if (this.snapshotSyncInFlight === inFlight) {
                this.snapshotSyncInFlight = null;
            }
        });
        this.snapshotSyncInFlight = inFlight;

        return this.snapshotSyncInFlight;
    }

    private kickUserSocketConnect(): void {
        if (this.closed) return;
        if (
            !this.socket?.connected
            && this.currentConnectionState.phase !== 'online'
            && this.currentConnectionState.phase !== 'connecting'
        ) {
            return;
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        if (this.userSocket.connected) return;
        try {
            this.userSocket.connect();
        } catch {
            // ignore; transcript recovery will handle missed updates
        }
    }

    private maybeScheduleUserSocketDisconnect(): void {
        if (this.closed) return;
        if (this.shouldKeepUserSocketConnected()) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.shouldKeepUserSocketConnected()) return;
            if (!this.userSocket.connected) return;
            try {
                this.userSocket.disconnect();
            } catch {
                // ignore
            }
        }, 2_000);
        this.userSocketDisconnectTimer.unref?.();
    }

    private hasMaterializedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId)
            || this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private shouldKeepUserSocketConnected(): boolean {
        return this.pendingMessageCallback !== null
            || this.pendingMaterializedLocalIds.size > 0
            || this.committedLocalIdsAwaitingEcho.size > 0
            || this.pendingQueueMaterializedLocalIds.size > 0
            || this.queuedDisconnectedSessionMessages.size > 0;
    }

    private queueSessionMessageUntilReconnect(params: { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }): void {
        if (this.closed) return;
        this.queuedDisconnectedSessionMessages.set(params.localId, params);
        this.kickSessionSocketReconnectForQueuedMessage(params.localId);
    }

    private kickSessionSocketReconnectForQueuedMessage(localId: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for queued message', {
                localId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private kickSessionSocketReconnectForDurableMutation(reason: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for durable mutation', {
                reason,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private async flushQueuedSessionMessagesOnReconnect(): Promise<void> {
        if (this.closed) return;
        if (!this.socket.connected) return;
        if (this.queuedDisconnectedSessionMessages.size === 0) return;

        const queued = [...this.queuedDisconnectedSessionMessages.values()];
        this.queuedDisconnectedSessionMessages.clear();
        for (const params of queued) {
            await this.enqueueMessageCommit(() =>
                this.commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            );
        }
    }

    private hasSelfEchoSuppressedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId);
    }

    private hasAgentQueueEchoSuppressedLocalId(localId: string): boolean {
        return this.agentQueueEchoSuppressedLocalIds.has(localId);
    }

    private hasPendingQueueMaterializedLocalId(localId: string): boolean {
        return this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private markAgentQueueEchoSuppressedLocalId(localId: string): void {
        if (!localId) return;
        this.agentQueueEchoSuppressedLocalIds.add(localId);
        const existingTimer = this.agentQueueEchoSuppressedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.agentQueueEchoSuppressedLocalIdCleanupTimers.delete(localId);
            this.agentQueueEchoSuppressedLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.set(localId, timer);
    }

    private markCommittedLocalIdAwaitingEcho(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.add(localId);
        const existingTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.committedLocalIdCleanupTimers.delete(localId);
            this.committedLocalIdsAwaitingEcho.delete(localId);
            this.maybeScheduleUserSocketDisconnect();
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.committedLocalIdCleanupTimers.set(localId, timer);
    }

    private deleteMaterializedLocalId(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.delete(localId);
        this.pendingQueueMaterializedLocalIds.delete(localId);
        const cleanupTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (cleanupTimer) {
            clearTimeout(cleanupTimer);
            this.committedLocalIdCleanupTimers.delete(localId);
        }
        this.materializationRecoveryScheduler.cancel(localId);
        this.transcriptRecoveryErrorStateByLocalId.delete(localId);
        this.maybeScheduleUserSocketDisconnect();
    }

    private shouldDeliverUserMessageToAgentQueueFromUpdate(
        message: UserMessage,
        update: Update,
        opts: { catchUpAfterSeq?: number; catchUpAfterSeqIsExplicit?: boolean },
    ): boolean {
        const localId = typeof message.localId === 'string' ? message.localId.trim() : '';
        const msgSeq =
            update.body?.t === 'new-message'
                && typeof update.body.message.seq === 'number'
                && Number.isFinite(update.body.message.seq)
                ? Math.trunc(update.body.message.seq)
                : null;
        const logUnauthorizedCatchUpSuppression = (): boolean => {
            logger.debug('[DELIVERY-DECISION] catch-up user-message suppressed (no explicit authorization)', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                messageSource: message.meta?.source ?? null,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAfterSeqIsExplicit: opts.catchUpAfterSeqIsExplicit,
                callbackAttachedAtMs: this.userMessageCallbackAttachedAtMs,
                createdAtMs: message.createdAt,
                decision: false,
                reason: 'no_explicit_authorization',
            });
            return false;
        };
        const logStaleCatchUpSuppression = (ageMs: number): boolean => {
            logger.debug('[DELIVERY-DECISION] stale catch-up user-message suppressed', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                messageSource: message.meta?.source ?? null,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAfterSeqIsExplicit: opts.catchUpAfterSeqIsExplicit,
                createdAtMs: message.createdAt,
                ageMs,
                staleAfterMs: configuration.resumeStaleUserMessageMs,
                decision: false,
                reason: 'stale_replay',
            });
            return false;
        };

        if (!update?.id?.startsWith('catchup-')) return true;

        if (message.meta?.source === 'daemon-initial-prompt') {
            const expectedLocalId = buildDaemonInitialPromptLocalId(this.sessionId);
            return Boolean(expectedLocalId && localId === expectedLocalId);
        }

        const staleUserMessageMs = configuration.resumeStaleUserMessageMs;
        if (staleUserMessageMs > 0 && typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)) {
            const ageMs = Date.now() - message.createdAt;
            if (ageMs > staleUserMessageMs) {
                return logStaleCatchUpSuppression(ageMs);
            }
        }

        const rawCatchUpAfterSeq = opts.catchUpAfterSeq;
        const catchUpAfterSeq =
            typeof rawCatchUpAfterSeq === 'number' && Number.isFinite(rawCatchUpAfterSeq) && rawCatchUpAfterSeq >= 0
                ? Math.trunc(rawCatchUpAfterSeq)
                : null;

        if (catchUpAfterSeq !== null && opts.catchUpAfterSeqIsExplicit === true) {
            return msgSeq !== null && msgSeq > catchUpAfterSeq;
        }

        return logUnauthorizedCatchUpSuppression();
    }

    private handleUpdate(data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
        catchUpAfterSeq?: number;
        catchUpAfterSeqIsExplicit?: boolean;
    }): void {
        try {
            logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

            if (!data.body) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                return;
            }

            if (
                (data.body as any)?.t === 'message-updated'
                && (data.body as any)?.sid === this.sessionId
            ) {
                const updatedLocalId = typeof (data.body as any)?.message?.localId === 'string'
                    ? (data.body as any).message.localId
                    : null;
                if (updatedLocalId && this.hasSelfEchoSuppressedLocalId(updatedLocalId)) {
                    this.deleteMaterializedLocalId(updatedLocalId);
                }
            }

            this.recordCommittedUserMessageSeqFromUpdate(data);

            const newMessageHandlingResult = handleSessionNewMessageUpdate({
                update: data,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                receivedMessageIds: this.receivedMessageIds,
                lastObservedMessageSeq: this.lastObservedMessageSeq,
                lastObservedUserMessageSeq: this.lastObservedUserMessageSeq,
                hasSelfEchoSuppressedLocalId: (localId) => this.hasSelfEchoSuppressedLocalId(localId),
                hasAgentQueueEchoSuppressedLocalId: (localId) => this.hasAgentQueueEchoSuppressedLocalId(localId),
                markAgentQueueEchoSuppressedLocalId: (localId) => this.markAgentQueueEchoSuppressedLocalId(localId),
                hasPendingQueueMaterializedLocalId: (localId) => this.hasPendingQueueMaterializedLocalId(localId),
                deleteMaterializedLocalId: (localId) => this.deleteMaterializedLocalId(localId),
                pendingMessageCallback: this.pendingMessageCallback,
                pendingMessages: this.pendingMessages,
                shouldDeliverUserMessageToAgentQueue: (message, update) =>
                    this.shouldDeliverUserMessageToAgentQueueFromUpdate(message, update, {
                        catchUpAfterSeq: opts.catchUpAfterSeq,
                        catchUpAfterSeqIsExplicit: opts.catchUpAfterSeqIsExplicit,
                    }),
                onObservedMessage: (message) => {
                    this.observeTurnAssistantTextFromSessionContent(message.body, {
                        source: 'transcript',
                        seq: message.seq,
                        localId: message.localId,
                        sidechainId: message.sidechainId,
                        observedAtMs: message.createdAt ?? Date.now(),
                    });
                },
                emit: (event, payload) => this.emit(event, payload),
                debug: (message, payload) => logger.debug(message, payload),
                debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
            });
            if (newMessageHandlingResult.handled) {
                this.lastObservedMessageSeq = newMessageHandlingResult.lastObservedMessageSeq;
                this.lastObservedUserMessageSeq = Math.max(
                    this.lastObservedUserMessageSeq,
                    newMessageHandlingResult.lastObservedUserMessageSeq,
                );
                return;
            }

            let shouldEmitMetadataUpdated = false;
            const stateUpdateResult = handleSessionStateUpdate({
                update: data,
                updateSource: opts.source,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                metadata: this.metadata,
                metadataVersion: this.metadataVersion,
                agentState: this.agentState,
                agentStateVersion: this.agentStateVersion,
                pendingWakeSeq: this.pendingWakeSeq,
                pendingQueueState: this.pendingQueueState,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                onMetadataUpdated: () => {
                    shouldEmitMetadataUpdated = true;
                },
                onWarning: (message) => logger.debug(message),
            });
            if (stateUpdateResult.handled) {
                this.metadata = stateUpdateResult.metadata;
                this.metadataVersion = stateUpdateResult.metadataVersion;
                this.agentState = stateUpdateResult.agentState;
                this.agentStateVersion = stateUpdateResult.agentStateVersion;
                this.pendingWakeSeq = stateUpdateResult.pendingWakeSeq;
                this.pendingQueueState = stateUpdateResult.pendingQueueState;
                if (shouldEmitMetadataUpdated) {
                    this.emit('metadata-updated');
                }
                return;
            }

            // If not a user message, it might be a permission response or other message type
            this.emit('message', data.body);
        } catch (error) {
            logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private recordCommittedUserMessageSeqFromUpdate(data: Update): void {
        const body = data.body as any;
        if (
            body?.sid !== this.sessionId
            || (body?.t !== 'new-message' && body?.t !== 'message-updated')
        ) {
            return;
        }
        const message = body.message;
        if (message?.messageRole !== 'user') {
            return;
        }
        this.committedUserMessageSeqTracker.record(message.localId, message.seq);
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            try {
                return await this.accountIdPromise;
            } catch (error) {
                this.accountIdPromise = null;
                if (isAuthenticationError(error)) {
                    if (this.sessionConnectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            }
        }

        const request = () => fetchChangesAccountId({ token: this.token });
        const supervisor = this.sessionConnectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async catchUpSessionMessages(afterSeq: number, opts: { afterSeqIsExplicit?: boolean } = {}): Promise<void> {
        const request = () => catchUpSessionMessagesAfterSeq({
            token: this.token,
            sessionId: this.sessionId,
            afterSeq,
            onUpdate: (update) => this.handleUpdate(update, {
                source: 'session-scoped',
                catchUpAfterSeq: afterSeq,
                catchUpAfterSeqIsExplicit: opts.afterSeqIsExplicit,
            }),
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            await request();
            return;
        }
        await runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    private shouldRunStartupTranscriptCatchUp(): boolean {
        return (
            this.startedByDaemonProcess ||
            this.metadata?.startedBy === 'daemon' ||
            this.metadata?.startedFromDaemon === true
        );
    }

    private resolveStartupTranscriptCatchUpInitialCursor(): { afterSeq: number; afterSeqIsExplicit: boolean } {
        if (this.startupMessageCatchUpExplicitAfterSeq !== null) {
            return {
                afterSeq: this.startupMessageCatchUpExplicitAfterSeq,
                afterSeqIsExplicit: true,
            };
        }

        const base = Math.max(0, Math.trunc(this.lastObservedMessageSeq));
        if (!this.shouldRunStartupTranscriptCatchUp()) {
            return { afterSeq: base, afterSeqIsExplicit: false };
        }
        const rewind = Math.max(0, Math.trunc(configuration.startupTranscriptCatchUpSeqRewind));
        if (rewind <= 0) {
            return { afterSeq: base, afterSeqIsExplicit: false };
        }
        return { afterSeq: Math.max(0, base - rewind), afterSeqIsExplicit: false };
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        if (this.closed) return;
        if (this.startupMessageCatchUpRetryTimer) return;
        if (!this.shouldRunStartupTranscriptCatchUp()) return;
        if (this.currentConnectionState?.phase === 'auth_failed') return;

        const delayMs = ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS[this.startupMessageCatchUpRetryIndex];
        if (typeof delayMs !== 'number') return;

        logger.debug('[API] Scheduling startup transcript catch-up retry', {
            delayMs,
            retryIndex: this.startupMessageCatchUpRetryIndex,
            startupMessageCatchUpInitialAfterSeq: this.startupMessageCatchUpInitialAfterSeq,
            startupMessageCatchUpInitialAfterSeqIsExplicit: this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
        });
        this.startupMessageCatchUpRetryTimer = setTimeout(() => {
            this.startupMessageCatchUpRetryTimer = null;
            if (this.closed) return;

            this.startupMessageCatchUpRetryIndex += 1;
            logger.debug('[API] Running startup transcript catch-up retry', {
                retryIndex: this.startupMessageCatchUpRetryIndex,
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                afterSeqIsExplicit: this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            });
            void this.catchUpSessionMessages(this.startupMessageCatchUpInitialAfterSeq, {
                afterSeqIsExplicit: this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Startup transcript catch-up retry failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Startup transcript catch-up retry failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }, delayMs);
        this.startupMessageCatchUpRetryTimer.unref?.();
    }

    private async syncChangesOnConnect(opts: { reason: 'connect' | 'reconnect' }): Promise<void> {
        const enabled = isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES);
        if (!enabled) {
            return;
        }

        if (this.closed) return;
        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
        }

        const p = runSessionChangesSyncOnConnect({
            reason: opts.reason,
            token: this.token,
            sessionId: this.sessionId,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
            getAccountId: () => this.getAccountId(),
            catchUpSessionMessages: (afterSeq) => this.catchUpSessionMessages(afterSeq),
            syncSessionSnapshotFromServer: (syncOpts) => this.syncSessionSnapshotFromServer(syncOpts),
            applyPendingQueueState: (state) => this.applyPendingQueueState(state, { emit: true }),
            connectionSupervisor: this.sessionConnectionSupervisor,
            onDebug: (message, data) => logger.debug(message, data),
        });

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            if (this.changesSyncInFlight === p) {
                this.changesSyncInFlight = null;
            }
        }
    }

    private async recoverMaterializedLocalId(
        localId: string,
        opts?: { maxWaitMs?: number },
    ): Promise<
        | { status: 'recovered' }
        | { status: 'not_found' }
        | { status: 'unsupported'; error: unknown }
    > {
        let unsupportedLookupError: unknown = null;
        const found = await waitForTranscriptEncryptedMessageByLocalId({
            token: this.token,
            sessionId: this.sessionId,
            localId,
            supervisor: this.sessionConnectionSupervisor ?? undefined,
            maxWaitMs: opts?.maxWaitMs,
            onError: (error) => {
                this.debugTranscriptRecoveryFetchError(localId, error);
            },
            onUnsupported: (error) => {
                unsupportedLookupError = error;
            },
        });
        if (unsupportedLookupError) {
            return { status: 'unsupported', error: unsupportedLookupError };
        }
        if (!found) return { status: 'not_found' };

        // Prevent later user-scoped updates from double-processing this localId.
        this.deleteMaterializedLocalId(localId);

        const update: Update = {
            id: `recovered-${localId}`,
            seq: 0,
            createdAt: found.createdAt,
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: found.id,
                    seq: found.seq,
                    content: found.content,
                    localId: found.localId,
                    sidechainId: found.sidechainId,
                    createdAt: found.createdAt,
                    updatedAt: found.updatedAt,
                },
            },
        } as Update;

        this.handleUpdate(update, { source: 'session-scoped' });
        return { status: 'recovered' };
    }

    private scheduleMaterializationRecovery(localId: string): void {
        // Belt-and-suspenders: if we fail to observe the socket broadcast for a committed transcript row,
        // recover by scanning the transcript and re-injecting the message into the normal update pipeline.
        this.materializationRecoveryScheduler.schedule(localId, async () => {
            if (!this.hasMaterializedLocalId(localId)) return;
            await this.recoverMaterializedLocalId(localId, { maxWaitMs: configuration.transcriptRecoveryMaxWaitMs });
        });
    }

    private deliverMaterializedPendingQueueMessage(message: PendingQueueMaterializedMessage | null | undefined): boolean {
        if (!message?.id || !message.content) return false;
        const createdAt = message.createdAt ?? Date.now();
        const updatedAt = message.updatedAt ?? createdAt;
        const update: Update = {
            id: `pending-materialized-${message.id}`,
            seq: 0,
            createdAt,
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: message.id,
                    seq: message.seq,
                    content: message.content,
                    localId: message.localId,
                    createdAt,
                    updatedAt,
                    ...(typeof message.messageRole === 'string' ? { messageRole: message.messageRole } : {}),
                },
            },
        } as Update;
        this.handleUpdate(update, { source: 'session-scoped' });
        return true;
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        logger.debug('[API] onUserMessage callback attached', {
            sessionId: this.sessionId,
            startedByDaemonProcess: this.startedByDaemonProcess,
            metadataStartedBy: this.metadata?.startedBy ?? null,
            metadataStartedFromDaemon: this.metadata?.startedFromDaemon ?? null,
        });
        this.pendingMessageCallback = callback;
        if (this.userMessageCallbackAttachedAtMs === null) {
            this.userMessageCallbackAttachedAtMs = Date.now();
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.kickUserSocketConnect();
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
        if (!this.daemonInitialPromptSeeded && typeof this.daemonInitialPrompt === 'string') {
            this.daemonInitialPromptSeeded = true;
            const initialPrompt = this.daemonInitialPrompt;
            const initialPromptLocalId = buildDaemonInitialPromptLocalId(this.sessionId);
            this.daemonInitialPrompt = null;
            void this.enqueueSessionUserMessage({
                text: initialPrompt,
                ...(initialPromptLocalId ? { localId: initialPromptLocalId } : {}),
                meta: {
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                },
            });
        }

        if (!this.startupMessageCatchUpStarted) {
            this.startupMessageCatchUpStarted = true;
            this.startupMessageCatchUpRetryIndex = 0;
            const startupCursor = this.resolveStartupTranscriptCatchUpInitialCursor();
            this.startupMessageCatchUpInitialAfterSeq = startupCursor.afterSeq;
            this.startupMessageCatchUpInitialAfterSeqIsExplicit = startupCursor.afterSeqIsExplicit;
            void this.catchUpSessionMessages(this.startupMessageCatchUpInitialAfterSeq, {
                afterSeqIsExplicit: this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Initial transcript catch-up failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Initial transcript catch-up failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) {
            return Promise.resolve(false);
        }

        const startMetadataVersion = this.metadataVersion;
        const startAgentStateVersion = this.agentStateVersion;
        const startPendingWakeSeq = this.pendingWakeSeq;
        if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }
        return new Promise((resolve) => {
            let cleanedUp = false;
            const shouldWatchConnect = !this.userSocket.connected;
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onConnect = () => {
                void (async () => {
                    // If we just connected the user-scoped socket, we may have missed "update-session" broadcasts
                    // while it was disconnected. Sync a snapshot once so callers can reliably observe the latest
                    // metadata/agentState immediately after this wakeup.
                    await this.syncSessionSnapshotFromServer({ reason: 'connect' });
                    cleanup();
                    resolve(true);
                })();
            };
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(false);
            };
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                if (shouldWatchConnect) {
                    this.userSocket.off('connect', onConnect);
                }
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            if (shouldWatchConnect) {
                this.userSocket.on('connect', onConnect);
            }
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('disconnect', onDisconnect);

            // Ensure we can observe metadata updates even when the server broadcasts them only to user-scoped clients.
            // This keeps idle agents wakeable without requiring server changes.
            this.kickUserSocketConnect();

            if (abortSignal?.aborted) {
                onAbort();
                return;
            }

            // Avoid lost wakeups if a snapshot sync or socket event raced with handler registration.
            if (
                this.metadataVersion !== startMetadataVersion ||
                this.agentStateVersion !== startAgentStateVersion ||
                this.pendingWakeSeq !== startPendingWakeSeq
            ) {
                onUpdate();
                return;
            }
            if (shouldWatchConnect && this.userSocket.connected) {
                onConnect();
                return;
            }
        });
    }

    /**
     * Ensure we have a decrypted metadata snapshot from the server.
     *
     * Unlike waitForMetadataUpdate(), this does not resolve early just because the socket connected.
     * It resolves only once metadataVersion is >= 0 and metadata is available (or times out).
     */
    async ensureMetadataSnapshot(opts?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<Metadata | null> {
        const abortSignal = opts?.abortSignal;
        if (abortSignal?.aborted) return null;

        if (this.metadataVersion >= 0 && this.metadata) {
            return this.metadata;
        }

        const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 15_000;

        if (this.metadataVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }

        return await new Promise((resolve) => {
            let cleanedUp = false;
            const onAbort = () => {
                cleanup();
                resolve(null);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(null);
            };
            const onUpdate = () => {
                if (this.metadataVersion >= 0 && this.metadata) {
                    cleanup();
                    resolve(this.metadata);
                }
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve(this.metadataVersion >= 0 ? this.metadata : null);
            }, timeoutMs);
            timer.unref?.();

            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                clearTimeout(timer);
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            this.userSocket.on('disconnect', onDisconnect);
            abortSignal?.addEventListener('abort', onAbort, { once: true });

            // Avoid lost wakeups if the snapshot sync raced with handler registration.
            onUpdate();
        });
    }

    /**
     * Force a session snapshot sync from the server.
     *
     * This is useful when metadata/agentState may have been updated by another client (e.g. daemon RPC)
     * and this runner needs the latest snapshot before making turn decisions (e.g. replaySeedV1).
     */
    async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        const reason = opts?.reason ?? 'waitForMetadataUpdate';
        await this.syncSessionSnapshotFromServer({ reason });
    }

    private async commitSessionMessage(
        params: {
            message: string | { t: 'plain'; v: unknown };
            localId: string;
            sidechainId: string | null;
            messageRole?: SessionMessageRole;
            sessionEventType?: 'ready';
            requireCommit: boolean;
            markAsUserMessage?: boolean;
        },
    ): Promise<number | null> {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return null;
        }
        if (this.transcriptStorage === 'direct') {
            if (!this.socket.connected) {
                if (params.requireCommit) {
                    throw new Error('Socket not connected');
                }
                this.queueSessionMessageUntilReconnect({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                });
                return null;
            }

            if (!params.requireCommit) {
                this.pendingMaterializedLocalIds.add(localId);
            }

            const ack = await (async () => {
                try {
                    const raw = await emitSocketWithAck({
                        socket: this.socket as any,
                        event: 'message',
                        payload: {
                            sid: this.sessionId,
                            message: params.message,
                            localId,
                            echoToSender: true,
                            sidechainId: params.sidechainId,
                            ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                            ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                        },
                    });

                    const parsed = MessageAckResponseSchema.safeParse(raw);
                    return parsed.success ? parsed.data : null;
                } catch (error) {
                    logger.debug('[SOCKET] Direct transcript commit ack failed', {
                        localId,
                        sidechainId: params.sidechainId,
                        requireCommit: params.requireCommit,
                        error: serializeAxiosErrorForLog(error),
                    });
                    return null;
                }
            })();

            if (ack && ack.ok === true) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                this.markCommittedLocalIdAwaitingEcho(localId);
                this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
                if (params.markAsUserMessage === true) {
                    this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                    this.committedUserMessageSeqTracker.record(ack.localId ?? localId, ack.seq);
                }
                return ack.seq;
            }
            if (ack && ack.ok === false) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                if (!params.requireCommit) {
                    this.deleteMaterializedLocalId(localId);
                }
                logger.debug('[SOCKET] Direct transcript commit rejected', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: ack.error,
                });
                throw new Error(ack.error);
            }
            if (!params.requireCommit) {
                this.scheduleCommitRetry({ message: params.message, localId, sidechainId: params.sidechainId, messageRole: params.messageRole, sessionEventType: params.sessionEventType });
                return null;
            }
            logger.debug('[SOCKET] Direct transcript commit was not confirmed', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
            });
            throw new Error('Message send not confirmed');
        }

        if (!this.socket.connected) {
            if (params.requireCommit) {
                throw new Error('Socket not connected');
            }
            this.queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
            });
            return null;
        }

        this.pendingMaterializedLocalIds.add(localId);
        const ack = await (async () => {
            try {
                const raw = await emitSocketWithAck({
                    socket: this.socket as any,
                    event: 'message',
                    payload: {
                        sid: this.sessionId,
                        message: params.message,
                        localId,
                        echoToSender: true,
                        sidechainId: params.sidechainId,
                        ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                    },
                });

                const parsed = MessageAckResponseSchema.safeParse(raw);
                return parsed.success ? parsed.data : null;
            } catch (error) {
                logger.debug('[SOCKET] Persisted transcript commit ack failed', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(error),
                });
                return null;
            }
        })();

        if (ack && ack.ok === true) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            this.markCommittedLocalIdAwaitingEcho(localId);
            // ACK confirms persistence. Do not inject a synthetic update here: outbound sends are not prompts.
            this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
            if (params.markAsUserMessage === true) {
                this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                this.committedUserMessageSeqTracker.record(ack.localId ?? localId, ack.seq);
            }
            return ack.seq;
        }

        if (ack && ack.ok === false) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            this.deleteMaterializedLocalId(localId);
            logger.debug('[SOCKET] Persisted transcript commit rejected', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
                error: ack.error,
            });
            if (params.requireCommit) {
                throw new Error(ack.error);
            }
            return null;
        }

        if (params.requireCommit) {
            const recovered = await this.recoverMaterializedLocalId(localId, { maxWaitMs: 12_000 });
            if (recovered.status === 'unsupported') {
                this.scheduleCommitRetry({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                });
                logger.debug('[SOCKET] Persisted transcript commit confirmation unsupported by server after ACK timeout', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(recovered.error),
                });
                throw new Error('Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)');
            }
            if (recovered.status !== 'recovered') {
                logger.debug('[SOCKET] Persisted transcript commit was not confirmed after ACK timeout and recovery miss', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                });
                throw new Error('Message commit not confirmed (ACK timed out and transcript recovery failed)');
            }
            return null;
        }

        this.scheduleMaterializationRecovery(localId);
        this.scheduleCommitRetry({ message: params.message, localId, sidechainId: params.sidechainId, messageRole: params.messageRole, sessionEventType: params.sessionEventType });
        return null;
    }

    private enqueueMessageCommit<T>(fn: () => Promise<T>): Promise<T> {
        const queued = this.messageCommitQueueTail.then(fn, fn);
        this.messageCommitQueueTail = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }

    private scheduleCommitRetry(params: { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }): void {
        const localId = params.localId;
        if (!localId) return;
        if (!this.pendingMaterializedLocalIds.has(localId)) return;

        const current = this.pendingCommitRetryAttemptsByLocalId.get(localId) ?? 0;
        const next = current + 1;
        if (next > 3) {
            return;
        }
        this.pendingCommitRetryAttemptsByLocalId.set(localId, next);

        const delayMs = 1_000 * next;
        const timer = setTimeout(() => {
            if (!this.pendingMaterializedLocalIds.has(localId)) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                return;
            }
            void this.enqueueMessageCommit(() =>
                this.commitSessionMessage({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            ).catch(() => {
                // Best-effort retry only.
            });
        }, delayMs);
        timer.unref?.();
    }

    private encryptSessionContent(content: unknown): string {
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content as any));
    }

    private buildOutboundSessionMessagePayload(content: unknown): string | { t: 'plain'; v: unknown } {
        if (this.sessionEncryptionMode === 'plain') {
            return { t: 'plain', v: content };
        }
        return this.encryptSessionContent(content);
    }

    private commitSessionMessageBestEffort(params: {
        message: string | { t: 'plain'; v: unknown };
        localId: string;
        sidechainId: string | null;
        messageRole?: SessionMessageRole;
        sessionEventType?: 'ready';
        logErrorMessage: string;
        markAsUserMessage?: boolean;
    }): void {
        void this.enqueueMessageCommit(() =>
            this.commitSessionMessage({
                message: params.message,
                localId: params.localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                requireCommit: false,
                markAsUserMessage: params.markAsUserMessage,
            }),
        ).catch((error) => {
            logger.debug(params.logErrorMessage, {
                localId: params.localId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private buildUserTextMessageContent(text: string, meta?: Record<string, unknown>): MessageContent {
        return {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                ...(meta && typeof meta === 'object' ? meta : {}),
            },
        };
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines, meta?: Record<string, unknown>) {
        if (isToolTraceEnabled()) {
            recordClaudeToolTraceEvents({ sessionId: this.sessionId, body });
        }

        this.outboundShapeLogger.log('claude:raw-jsonl', body);

        const sidechainId = (() => {
            const raw = (body as any)?.sidechainId;
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        })();

        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (
            body.type === 'user' &&
            typeof body.message.content === 'string' &&
            body.isSidechain !== true &&
            body.isMeta !== true
        ) {
            content = this.buildUserTextMessageContent(body.message.content, meta);
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli',
                    source: 'cli',
                    ...(meta && typeof meta === 'object' ? meta : {}),
                }
            };
        }

        this.outboundShapeLogger.log('claude:session-content', content);
        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        this.logSendWhileDisconnected('Claude session message', { type: body.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider: 'claude',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveClaudeSessionMessageRole(body),
            logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', serializeAxiosErrorForLog(error));
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            updateMetadataBestEffort(
                this,
                (metadata) => ({
                    ...metadata,
                    summary: {
                        text: body.summary,
                        updatedAt: Date.now()
                    }
                }),
                '[SOCKET]',
                'summary_message',
            );
        }
    }

    sendCodexMessage(body: any) {
        const normalizedBody = normalizeCodexSessionMessageBody({
            body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            debug: (message, data) => logger.debug(message, data),
        });

        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: normalizedBody  // This wraps the entire Codex message
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
            }
        };

        recordCodexToolTraceEventIfNeeded({ sessionId: this.sessionId, body: normalizedBody });
        
        this.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId: null,
            provider: 'codex',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveCodexSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody?.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider: 'codex',
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    private prepareAcpAgentMessage(params: {
        provider: ACPProvider;
        body: ACPMessageData;
        meta?: Record<string, unknown>;
        localId?: string;
    }): {
        normalizedBody: ACPMessageData;
        content: ReturnType<typeof buildAcpAgentMessageEnvelope>;
        localId: string;
        sidechainId: string | null;
    } {
        const normalizedBody = normalizeAcpSessionMessageBody({
            provider: params.provider,
            body: params.body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
        });
        const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();
        const sidechainId = (() => {
            const raw = normalizedBody.sidechainId;
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            return trimmed ? trimmed : null;
        })();
        const content = buildAcpAgentMessageEnvelope({
            provider: params.provider,
            body: normalizedBody,
            meta: params.meta,
        });
        return { normalizedBody, content, localId, sidechainId };
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) {
        const lifecycleMarker = observeAcpLifecycleMarker({
            lifecycle: this.sessionTurnLifecycle,
            provider,
            body,
        });
        if (lifecycleMarker.pendingWrite) {
            this.trackSessionTurnWrite(lifecycleMarker.pendingWrite, {
                latestTurnStatus: lifecycleMarker.body.type === 'task_started'
                    ? 'in_progress'
                    : lifecycleMarker.body.type === 'task_complete'
                        ? 'completed'
                        : lifecycleMarker.body.type === 'turn_failed'
                            ? 'failed'
                            : 'cancelled',
            });
        }
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body: lifecycleMarker.body,
            meta: opts?.meta,
            localId: opts?.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
            recordAcpToolTraceEventIfNeeded({
                sessionId: this.sessionId,
                provider,
                body: normalizedBody,
                localId,
            });
        }

        this.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);
        
        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: normalizedBody.type, hasMessage: 'message' in normalizedBody });
        this.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });
        const payload = this.buildOutboundSessionMessagePayload(content);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider,
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveAcpSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider,
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    sendAgentMessageEphemeral(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ): void {
        if (!this.socket.connected) return;

        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts.meta,
            localId: opts.localId,
        });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const createdAt =
            typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                ? Math.max(0, Math.trunc(opts.createdAt))
                : Date.now();
        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaUpdatedAt =
            streamSegmentMeta
            && typeof streamSegmentMeta === 'object'
            && typeof (streamSegmentMeta as Record<string, unknown>).updatedAtMs === 'number'
            && Number.isFinite((streamSegmentMeta as Record<string, unknown>).updatedAtMs)
                ? Math.trunc((streamSegmentMeta as Record<string, unknown>).updatedAtMs as number)
                : undefined;
        const updatedAt =
            typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                : typeof metaUpdatedAt === 'number'
                    ? Math.max(createdAt, metaUpdatedAt)
                    : Math.max(createdAt, Date.now());
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider,
            observedAtMs: updatedAt,
        });

        try {
            this.socket.emit('transcript-stream-segment', {
                sid: this.sessionId,
                message: {
                    localId,
                    messageRole: resolveAcpSessionMessageRole(normalizedBody),
                    ...(sidechainId ? { sidechainId } : {}),
                    content: payload,
                    createdAt,
                    updatedAt,
                },
            });
        } catch {
            // Ephemeral stream updates are best effort.
        }
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        const content = this.buildUserTextMessageContent(text, opts?.meta);

        this.logSendWhileDisconnected('User text message', { length: text.length });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = typeof opts?.localId === 'string' && opts.localId.length > 0 ? opts.localId : randomUUID();
        const meta = opts?.meta ?? null;
        const metaSource = typeof (meta as any)?.source === 'string' ? String((meta as any).source) : null;
        const metaSentFrom = typeof (meta as any)?.sentFrom === 'string' ? String((meta as any).sentFrom) : null;
        const shouldSuppressAgentQueueEcho =
            metaSource === 'cli'
            || metaSentFrom === 'cli';
        if (shouldSuppressAgentQueueEcho) {
            // Prevent our own CLI-originating outbound user messages from being treated as inbound prompts
            // if/when the server echoes the transcript update back to this runner.
            this.markAgentQueueEchoSuppressedLocalId(localId);
        }
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: 'user',
            markAsUserMessage: true,
            logErrorMessage: '[SOCKET] Failed to commit user message (non-fatal)',
        });
    }

    async sendUserTextMessageCommitted(
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const content = this.buildUserTextMessageContent(text, opts.meta);
        const payload = this.buildOutboundSessionMessagePayload(content);
        // Suppress agent-queue delivery for our own committed user messages; these are writes, not prompts.
        this.markAgentQueueEchoSuppressedLocalId(opts.localId);
        await this.enqueueMessageCommit(() =>
            this.commitSessionMessage({
                message: payload,
                localId: opts.localId,
                sidechainId: null,
                messageRole: 'user',
                requireCommit: true,
                markAsUserMessage: true,
            }),
        );
    }

    private async notifyDaemonConnectedServiceTurnLifecycle(
        event: 'prompt_or_steer' | 'assistant_message_end' | 'turn_cancelled',
    ): Promise<void> {
        if (!this.startedByDaemonProcess) return;
        try {
            const result = await notifyDaemonConnectedServiceTurnLifecycle({
                sessionId: this.sessionId,
                event,
            });
            if (result?.error) {
                logger.debug('[SESSION CLIENT] Failed to notify daemon connected-service turn lifecycle (non-fatal)', {
                    sessionId: this.sessionId,
                    event,
                    error: result.error,
                });
            }
        } catch (error) {
            logger.debug('[SESSION CLIENT] Connected-service turn lifecycle notify threw (non-fatal)', {
                sessionId: this.sessionId,
                event,
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private async enqueueSessionUserMessage(params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>): Promise<void> {
        const text = String(params.text ?? '');
        if (text.length === 0) return;
        const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();

        const rawMeta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
        const normalizedPayload = normalizeAgentPromptPayload({ text, meta: rawMeta });
        const meta: Record<string, unknown> = normalizedPayload.meta && typeof normalizedPayload.meta === 'object'
            ? { ...normalizedPayload.meta }
            : {};
        if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
            meta.source = 'ui';
        }
        if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
            meta.sentFrom = 'ui';
        }

        void this.notifyDaemonConnectedServiceTurnLifecycle('prompt_or_steer');

        // Deliver immediately to the agent queue: this RPC is a prompt input, not a passive transcript write.
        // Repeated RPC attempts with the same localId still commit through the transcript path below,
        // but only the first attempt should feed the running agent within the recovery window.
        const prompt = {
            role: 'user',
            content: { type: 'text', text },
            localId,
            meta,
            createdAt: Date.now(),
        } satisfies UserMessage;
        if (!this.hasAgentQueueEchoSuppressedLocalId(localId)) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(prompt);
            } else {
                this.pendingMessages.push(prompt);
            }
            this.markAgentQueueEchoSuppressedLocalId(localId);
        }

        this.sendUserTextMessage(text, { localId, meta });
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const payload = this.buildOutboundSessionMessagePayload(content);
        const seq = await this.enqueueMessageCommit(() =>
            this.commitSessionMessage({ message: payload, localId, sidechainId, messageRole: resolveAcpSessionMessageRole(normalizedBody), requireCommit: true }),
        );
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'committed',
            seq,
            localId,
            sidechainId,
            provider,
        });
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        const request = () => fetchRecentTranscriptTextItemsForAcpImportFromServer({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        const request = () => fetchLatestUserPermissionIntentFromEncryptedTranscript({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    sendSessionEvent(event: SessionEventMessage, id?: string) {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveSessionEventMessageRole(),
            sessionEventType: event.type === 'ready' ? 'ready' : undefined,
            logErrorMessage: '[SOCKET] Failed to commit session event (non-fatal)',
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        const payload = {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        };

        // Keep-alive/presence is ephemeral_drop_ok. Durable primary-turn status is delivered
        // through the session mutation outbox, not through session-alive.
        if (thinking) {
            if (!this.socket.connected) {
                return;
            }
            this.socket.emit('session-alive', payload);
            return;
        }

        if (!this.socket.connected) {
            return;
        }

        // When idle, prefer volatile to avoid any chance of backpressure.
        const volatileEmit = (this.socket as any)?.volatile?.emit;
        if (typeof volatileEmit === 'function') {
            volatileEmit.call((this.socket as any).volatile, 'session-alive', payload);
            return;
        }

        // Fallback for non-standard socket stubs.
        this.socket.emit('session-alive', payload);
    }

    /**
     * Send session death message
     */
    sendSessionDeath(): Promise<void> {
        this.trackSessionTurnWrite(
            this.sessionTurnLifecycle.endSession(),
            { latestTurnStatus: 'cancelled' },
        );
        const trackedSessionEndWrite = this.sessionMutationOutbox.enqueueSessionEnd(createSessionEndMutation({
            sessionId: this.sessionId,
        })).catch((error) => {
            logger.debug('[API] Failed to enqueue session-end mutation (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.pendingSessionEndWrites.add(trackedSessionEndWrite);
        void trackedSessionEndWrite.finally(() => {
            this.pendingSessionEndWrites.delete(trackedSessionEndWrite);
        });
        return trackedSessionEndWrite;
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        if (!this.socket.connected) {
            return;
        }
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await updateSessionMetadataWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getMetadata: () => this.metadata,
                setMetadata: (metadata) => {
                    this.metadata = metadata;
                },
                getMetadataVersion: () => this.metadataVersion,
                setMetadataVersion: (version) => {
                    this.metadataVersion = version;
                },
                syncSessionSnapshotFromServer: () => this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' }),
                handler,
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState): Promise<void> {
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.agentStateLock.inLock(async () => {
            await updateSessionAgentStateWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getAgentState: () => this.agentState,
                setAgentState: (agentState) => {
                    this.agentState = agentState;
                },
                getAgentStateVersion: () => this.agentStateVersion,
                setAgentStateVersion: (version) => {
                    this.agentStateVersion = version;
                },
                syncSessionSnapshotFromServer: () => this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' }),
                handler,
            });
        });
    }

    private trackSessionTurnWrite(
        update: Promise<void>,
        record: Readonly<{ latestTurnStatus: PrimaryTurnStatusV1 }>,
    ): void {
        const tracked = update.catch((error) => {
            logger.debug('[API] Failed to update primary turn runtime state (non-fatal)', {
                latestTurnStatus: record.latestTurnStatus,
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.pendingSessionTurnWrites.add(tracked);
        void tracked.finally(() => {
            this.pendingSessionTurnWrites.delete(tracked);
        });
    }

    private async drainBestEffortSessionWrites(): Promise<void> {
        await Promise.all([
            this.messageCommitQueueTail.catch(() => undefined),
            this.sessionMutationOutbox.flush('flush').catch(() => undefined),
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
        ]);
    }

    private async drainPendingLifecycleWritesBeforeClose(): Promise<void> {
        await Promise.all([
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
            ...[...this.pendingSessionEndWrites].map((update) => update.catch(() => undefined)),
        ]);
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await this.drainBestEffortSessionWrites();
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                resolve();
            };
            this.socket.emit('ping', () => {
                finish();
            });
            timer = setTimeout(() => {
                finish();
            }, 10000);
            timer.unref?.();
        });
    }

    /**
     * Read-only snapshot of the currently known session metadata (decrypted).
     *
     * This is useful for spawn-time decisions that depend on previous metadata values
     * (e.g. session-scoped feature toggles) without requiring a metadata write.
     */
    getMetadataSnapshot(): Metadata | null {
        return this.metadata;
    }

    /**
     * Read-only snapshot of the last transcript message seq observed by this client.
     *
     * Used for provider integrations that need to distinguish "fresh" sessions from sessions that
     * already contain imported history or prior user prompts (e.g. resume history import).
     */
    getLastObservedMessageSeq(): number {
        return this.lastObservedMessageSeq;
    }

    getLastObservedUserMessageSeq(): number {
        return this.lastObservedUserMessageSeq;
    }

    getCommittedUserMessageSeq(localId: string): number | null {
        return this.committedUserMessageSeqTracker.get(localId);
    }

    waitForCommittedUserMessageSeq(
        localId: string,
        options?: CommittedUserMessageSeqWaitOptions,
    ): Promise<number | null> {
        return this.committedUserMessageSeqTracker.wait(localId, options);
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.closed = true;
        if (this.startupMessageCatchUpRetryTimer) {
            clearTimeout(this.startupMessageCatchUpRetryTimer);
            this.startupMessageCatchUpRetryTimer = null;
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        await this.drainPendingLifecycleWritesBeforeClose();
        this.pendingMaterializedLocalIds.clear();
        this.committedLocalIdsAwaitingEcho.clear();
        this.pendingQueueMaterializedLocalIds.clear();
        this.committedUserMessageSeqTracker.clear();
        this.agentQueueEchoSuppressedLocalIds.clear();
        this.queuedDisconnectedSessionMessages.clear();
        for (const timer of this.committedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.committedLocalIdCleanupTimers.clear();
        for (const timer of this.agentQueueEchoSuppressedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.clear();
        this.pendingCommitRetryAttemptsByLocalId.clear();
        await this.sessionMutationOutbox.close();
        try {
            this.userSocket.close();
        } catch {
            // ignore
        }
        await this.sessionConnectionSupervisor?.stop();
    }

    private installSessionSocketEventHandlers(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });

        socket.on('update', (data: Update) => this.handleUpdate(data, { source: 'session-scoped' }));
        socket.on('session', () => {});
        socket.on('error', (error) => {
            logger.debug('[API] Socket error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        const request = () => listPendingQueueV2LocalIdsFromServer({
            token: this.token,
            sessionId: this.sessionId,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async peekPendingMessageQueueV2Count(): Promise<number> {
        if (!this.pendingQueueState.known || this.pendingQueueState.pendingCount <= 0) {
            await this.reconcilePendingQueueState({ force: true });
            if (this.pendingQueueState.known) {
                return this.pendingQueueState.pendingCount + this.pendingQueueMaterializedLocalIds.size;
            }
        }

        const localIds = await this.listPendingMessageQueueV2LocalIds();
        // Include materialized-but-not-yet-observed messages as "pending-ish" work.
        // These are messages we already removed from the server pending queue but haven't
        // seen broadcast into the transcript yet; switching modes during this window can
        // silently drop user intent in non-interactive (no TTY) flows.
        return localIds.length + this.pendingQueueMaterializedLocalIds.size;
    }

    async discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
        const localIds = await this.listPendingMessageQueueV2LocalIds();
        if (localIds.length === 0) return 0;
        const request = () => discardPendingQueueV2Messages({
            token: this.token,
            sessionId: this.sessionId,
            localIds,
            reason: opts.reason,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
        if (!this.socket.connected) {
            return 0;
        }
        if (!this.metadata) {
            return 0;
        }

        const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
        if (localIds.length === 0) {
            return 0;
        }

        let addedCount = 0;

        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata as unknown as Record<string, unknown>;

                const existingRaw = (current as any).discardedCommittedMessageLocalIds;
                const existing = Array.isArray(existingRaw) ? existingRaw.filter((v) => typeof v === 'string') : [];
                const existingSet = new Set(existing);
                const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                if (uniqueNew.length === 0) {
                    addedCount = 0;
                    return;
                }

                const nextMetadata = addDiscardedCommittedMessageLocalIds(current, uniqueNew);
                const metadataPayload =
                    this.sessionEncryptionMode === 'plain'
                        ? JSON.stringify(nextMetadata)
                        : encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, nextMetadata));
                const answer = await emitSocketWithAck<any>({
                    socket: this.socket as any,
                    event: 'update-metadata',
                    payload: {
                        sid: this.sessionId,
                        expectedVersion: this.metadataVersion,
                        metadata: metadataPayload,
                    },
                });

                if (answer.result === 'success') {
                    this.metadata =
                        this.sessionEncryptionMode === 'plain'
                            ? JSON.parse(String(answer.metadata ?? 'null'))
                            : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    addedCount = uniqueNew.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata =
                            this.sessionEncryptionMode === 'plain'
                                ? JSON.parse(String(answer.metadata ?? 'null'))
                                : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                }

                // Hard error - ignore
                addedCount = 0;
            });
        });

        return addedCount;
    }

    /**
     * Materialize one server-backed queued message (pending queue V2) into the normal session transcript.
     *
     * The server atomically:
     * - selects the next queued pending message,
     * - commits it into SessionMessage (idempotent via (sessionId, localId)),
     * - removes it from the pending queue.
     */
    private async runMaterializeNextPendingMessageInner(): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        try {
            materializeResult = await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request: async () => materializeNextPendingQueueV2Message({
                    token: this.token,
                    sessionId: this.sessionId,
                    socket: this.socket,
                    knownPendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
                }),
            });
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const pendingStateUpdate = derivePendingQueueStateAfterMaterializeResult({
            current: this.pendingQueueState,
            didMaterialize: materializeResult.didMaterialize,
            authoritativeState: materializeResult.pendingQueueState ?? null,
        });
        this.pendingQueueState = pendingStateUpdate.state;
        if (pendingStateUpdate.changed) {
            this.pendingWakeSeq += 1;
        }

        if (!materializeResult.didMaterialize) {
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        const deliveredMaterializedMessage = this.deliverMaterializedPendingQueueMessage(materializeResult.message);

        if (materializeResult.localId && !deliveredMaterializedMessage) {
            // Best-effort: recover if we miss socket broadcasts for the committed transcript row.
            this.pendingQueueMaterializedLocalIds.add(materializeResult.localId);
            this.scheduleMaterializationRecovery(materializeResult.localId);
        }
        if (
            materializeResult.message?.messageRole === 'user'
            && materializeResult.message.localId
        ) {
            this.committedUserMessageSeqTracker.record(
                materializeResult.message.localId,
                materializeResult.message.seq,
            );
        }

        const message = materializeResult.message;
        if (
            message
            && typeof message.localId === 'string'
            && message.localId.length > 0
            && typeof message.seq === 'number'
            && Number.isSafeInteger(message.seq)
            && message.seq >= 0
        ) {
            return {
                didMaterialize: true,
                result: {
                    type: 'materialized',
                    localId: message.localId,
                    seq: message.seq,
                    content: message.content ?? null,
                    ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
                    ...(typeof message.updatedAt === 'number' ? { updatedAt: message.updatedAt } : {}),
                },
            };
        }

        return { didMaterialize: true, result: { type: 'no_pending' } };
    }

    async materializeNextPendingMessageSafely(opts: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    } = {}): Promise<MaterializeNextPendingResult> {
        const supervisorState = this.sessionConnectionSupervisor?.getState();
        if (supervisorState?.phase === 'auth_failed') {
            return { type: 'deferred', reason: 'supervisor_auth_failed' };
        }
        if (supervisorState && supervisorState.phase !== 'online') {
            return { type: 'deferred', reason: 'supervisor_offline' };
        }

        const policy = opts.reconcileWhenEmpty ?? 'force';
        if (!this.pendingQueueState.known) {
            await this.reconcilePendingQueueState({ force: true });
        } else if (this.pendingQueueState.pendingCount <= 0) {
            if (policy === 'force') {
                await this.reconcilePendingQueueState({ force: true });
            } else if (policy === 'throttled') {
                await this.reconcilePendingQueueState({ force: false });
            }
        }
        if (!this.pendingQueueState.known || this.pendingQueueState.pendingCount <= 0) {
            return { type: 'no_pending' };
        }

        const inner = await this.runMaterializeNextPendingMessageInner();
        return inner.result;
    }

    async popPendingMessage(): Promise<boolean> {
        if (!this.pendingQueueState.known || this.pendingQueueState.pendingCount <= 0) {
            await this.reconcilePendingQueueState({ force: !this.pendingQueueState.known });
        }
        if (!this.pendingQueueState.known || this.pendingQueueState.pendingCount <= 0) {
            return false;
        }

        const inner = await this.runMaterializeNextPendingMessageInner();
        return inner.didMaterialize;
    }
}
