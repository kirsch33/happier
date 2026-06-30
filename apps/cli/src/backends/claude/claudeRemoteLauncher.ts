import { render } from "ink";
import { Session } from "./session";
import type { Metadata } from '@/api/types';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/backends/claude/ui/RemoteModeDisplay";
import React from "react";
import { claudeRemoteDispatch } from "./remote/claudeRemoteDispatch";
import { createClaudeInFlightSteerCapabilityPublisher } from './unifiedTerminal/createClaudeInFlightSteerCapabilityPublisher';
import {
    runClaudeUnifiedTerminalSession,
    type ClaudeUnifiedTerminalSessionOptions,
} from './unifiedTerminal/runClaudeUnifiedTerminalSession';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID, DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './unifiedTerminal/tuiControls';
import { ClaudeUnifiedResumeChoiceBroker } from './unifiedTerminal/resumeChoice/claudeUnifiedResumeChoiceBroker';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './unifiedTerminal/resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import type {
    ClaudeUnifiedRuntimeConfigOutcomeEvent,
    ClaudeUnifiedRuntimeControlApplyResult,
} from './unifiedTerminal/runtimeControlIntegration';
import {
    buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
    isClaudeUnifiedRuntimeControlUserDraftBlocker,
} from './unifiedTerminal/runtimeControlIntegration';
import { createTerminalComposerDraftBlockedEvent } from './unifiedTerminal/terminalComposerDraftBlockedEvent';
import {
    buildUnifiedTerminalRuntimeConfigRestartChanges,
    CLAUDE_UNIFIED_TERMINAL_RESTART_ONLY_OPTIONS_MESSAGE,
    CLAUDE_UNIFIED_TERMINAL_UNSUPPORTED_OPTIONS_MESSAGE,
    type ClaudeRuntimeConfigOutcomeChange,
} from './unifiedTerminal/runtimeConfigRestartNotice';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { bindClaudeUnifiedTerminalSession } from './unifiedTerminal/bindClaudeUnifiedTerminalSession';
import { surfaceClaudeUnifiedTerminalRuntimeIssue } from './unifiedTerminal/surfaceClaudeUnifiedTerminalRuntimeIssue';
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { AbortError, type SDKAssistantMessage, type SDKMessage, type SDKUserMessage } from "./sdk/types";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import type { EnhancedMode, PermissionMode } from "./loop";
import { RawJSONLines } from "@/backends/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { syncClaudePermissionModeFromMetadata } from "./utils/syncPermissionModeFromMetadata";
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from "./utils/permissionMode";
import { readClaudeActiveTerminalMode } from './utils/readClaudeActiveTerminalMode';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { createClaudePendingAwareInputConsumer } from './createClaudePendingAwareInputConsumer';
import type { MessageBatch } from '@/agent/runtime/sessionInput/types';
import { resolveClaudeRemoteQueuedPromptWithReplaySeed } from '@/backends/claude/remote/resolveClaudeRemoteQueuedPromptWithReplaySeed';
import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import { restoreStdinBestEffort } from '@/ui/ink/restoreStdinBestEffort';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import { ensureSessionInfoBeforeSwitch } from '@/backends/claude/utils/ensureSessionInfoBeforeSwitch';
import { ClaudeRemoteTaskOutputCollector } from './remote/sidechains/claudeRemoteTaskOutputCollector';
import { ClaudeRemoteSubagentFileCollector } from './remote/sidechains/claudeRemoteSubagentFileCollector';
import { resolveClaudeSubagentJsonlPathForRemoteSession } from './remote/sidechains/resolveClaudeSubagentJsonlPathForRemoteSession';
import { createClaudeRemoteTeamInboxBridge } from './remote/teamInbox/claudeRemoteTeamInboxBridge';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import {
    resolveRemoteModeControlSurface,
    startRemoteModeStaticControl,
    type RemoteModeStaticControl,
} from '@/ui/remoteControl/remoteModeControl';
import { dirname, join } from 'node:path';
import { configuration } from '@/configuration';
import { getProjectPath } from './utils/path';
import { resolveClaudeConfigDirOverride } from './utils/resolveClaudeConfigDirOverride';
import { tryReadTextFileTail } from '@/agent/runtime/readTextFileTail';
import { readClaudeSessionJsonlMessages } from './utils/readClaudeSessionJsonlMessages';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './utils/normalizeClaudeToolUseNames';
import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';
import { delay } from '@/utils/time';
import { ClaudeTurnChangeTracker } from './utils/ClaudeTurnChangeTracker';
import { isClaudeExplicitDiffToolInput } from './utils/isClaudeExplicitDiffToolInput';
import {
    buildClaudeSessionModelsMetadataFromSupportedModels,
    buildClaudeSessionModelsMetadataWithCurrentModelId,
} from './remote/buildClaudeSessionModelsMetadataFromSupportedModels';
import {
    createStreamedTranscriptWriter,
    type StreamedTranscriptWriter,
} from '@/api/session/streamedTranscriptWriter';
import { createClaudeRemoteStreamedTranscriptSession } from './remote/createClaudeRemoteStreamedTranscriptSession';
import { hashClaudeUnifiedTerminalLaunchOptionsForQueue } from './remote/modeHash';
import type { ClaudeCompletionEvent } from './contextCompactionEvents';
import { mergeSessionWorkStateMetadataV1, type SessionWorkStateV1 } from '@/session/workState/sessionWorkStateMetadata';
import { createClaudeReadyHandler } from './ready/createClaudeReadyHandler';
import {
    surfaceClaudeRuntimeAuthFailure,
    surfaceClaudeRateLimitRuntimeIssue,
} from './connectedServices/surfaceClaudeRuntimeIssues';
import type { NormalizedProviderUsageLimitDetailsV1 } from './connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { createClaudeUnifiedTerminalMetadataModeApplier } from './unifiedTerminal/metadataRuntimeModeApplier';

function mergeSessionWorkStateIntoMetadata(
    metadata: Metadata,
    params: Omit<Parameters<typeof mergeSessionWorkStateMetadataV1>[0], 'metadata'>,
): Metadata {
    return mergeSessionWorkStateMetadataV1({ ...params, metadata }) as unknown as Metadata;
}

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: PermissionMode;
    allowedTools?: string[];
}

type LaunchErrorInfo = {
    asString: string;
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
};

function getLaunchErrorInfo(e: unknown): LaunchErrorInfo {
    let asString = '[unprintable error]';
    try {
        asString = typeof e === 'string' ? e : String(e);
    } catch {
        // Ignore
    }

    if (!e || typeof e !== 'object') {
        return { asString };
    }

    const err = e as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };

    const name = typeof err.name === 'string' ? err.name : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : undefined;
    const stack = typeof err.stack === 'string' ? err.stack : undefined;

    return { asString, name, message, code, stack };
}

function sendClaudeCompletionEvent(params: Readonly<{
    session: Session;
    event: ClaudeCompletionEvent;
}>): void {
    if (typeof params.event === 'string') {
        params.session.client.sendSessionEvent({ type: 'message', message: params.event });
        return;
    }
    params.session.client.sendSessionEvent(params.event);
}

function isAbortError(e: unknown): boolean {
    if (e instanceof AbortError) return true;

    if (!e || typeof e !== 'object') {
        return false;
    }

    const err = e as { name?: unknown; code?: unknown };
    if (typeof err.name === 'string' && err.name === 'AbortError') return true;
    if (typeof err.code === 'string' && err.code === 'ABORT_ERR') return true;

    return false;
}

function isClaudeExecutionErrorAfterUserAbort(e: unknown): boolean {
    const info = getLaunchErrorInfo(e);
    const values = [info.name, info.message, info.code, info.asString]
        .filter((value): value is string => typeof value === 'string');
    return values.some((value) => value.includes('error_during_execution'));
}

function readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRemoteControlTerminalMode(session: Session): string | null {
    return readClaudeActiveTerminalMode({
        terminalRuntime: session.terminalRuntime,
        metadata: session.client.getMetadataSnapshot?.(),
    });
}

function resolveWorkStateSourceFamiliesFromSnapshot(snapshot: SessionWorkStateV1): readonly string[] {
    const explicitFamilies = (snapshot as { ownedSourceFamilies?: unknown }).ownedSourceFamilies;
    if (Array.isArray(explicitFamilies)) {
        const families = explicitFamilies.flatMap((family): string[] => {
            const normalized = readNonEmptyString(family);
            return normalized ? [normalized] : [];
        });
        if (families.length > 0) return families;
    }

    const first = readRecord(snapshot.items[0]);
    const kind = readNonEmptyString(first?.kind);
    if (kind === 'goal' || kind === 'task' || kind === 'todo') {
        return [kind];
    }
    return [];
}

type ClaudeCodeArtifacts = Readonly<{
    debugFilePath: string | null;
    stderrFilePath: string | null;
}>;

function resolveClaudeCodeExitCode(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/Claude Code process exited with code (\d+)/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveClaudeCodeArtifacts(error: unknown): ClaudeCodeArtifacts | null {
    if (!error || typeof error !== 'object') return null;
    const raw = (error as any).happierClaudeCodeArtifacts as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const debugFilePath = typeof (raw as any).debugFilePath === 'string' ? (raw as any).debugFilePath : null;
    const stderrFilePath = typeof (raw as any).stderrFilePath === 'string' ? (raw as any).stderrFilePath : null;
    if (!debugFilePath && !stderrFilePath) return null;
    return { debugFilePath, stderrFilePath };
}

function resolveClaudeCurrentModelIdFromMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
    const preferred = typeof (metadata as any)?.modelOverrideV1?.modelId === 'string'
        ? String((metadata as any).modelOverrideV1.modelId).trim()
        : '';
    if (preferred) return preferred;

    const sessionCurrent = typeof (metadata as any)?.sessionModelsV1?.currentModelId === 'string'
        ? String((metadata as any).sessionModelsV1.currentModelId).trim()
        : '';
    if (sessionCurrent) return sessionCurrent;

    const acpCurrent = typeof (metadata as any)?.acpSessionModelsV1?.currentModelId === 'string'
        ? String((metadata as any).acpSessionModelsV1.currentModelId).trim()
        : '';
    return acpCurrent || null;
}

async function formatClaudeCodeArtifactsTailForUi(artifacts: ClaudeCodeArtifacts): Promise<string> {
    const sections: string[] = [];

    const addTailSection = async (label: string, path: string | null) => {
        if (!path) return;
        const tail = await tryReadTextFileTail(path, { maxBytes: 32_000 });
        if (!tail) return;
        const header = `--- ${label} tail (${path}) ---`;
        const body = tail.tail.trimEnd();
        sections.push([header, body.length > 0 ? body : '[empty]', ''].join('\n'));
    };

    await addTailSection('claude-code-debug', artifacts.debugFilePath);
    await addTailSection('claude-code-stderr', artifacts.stderrFilePath);

    return sections.join('\n');
}

function resolveClaudeProjectDir(session: Session): string {
    if (session.transcriptPath) {
        return dirname(session.transcriptPath);
    }
    return getProjectPath(session.path, resolveClaudeConfigDirOverride(process.env));
}

export { createClaudeReadyHandler as createClaudeRemoteReadyHandler };

const MAX_CONSECUTIVE_REMOTE_UNIFIED_PARK_RELAUNCHES = 3;

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');
    const turnAssistantPreviewTracker = createTurnAssistantPreviewTracker();
    // Resolve the Claude Unified TUI runtime-control feature gate once per launch. It defaults ON
    // (riding the unified-mode opt-in); the env flag is a kill-switch that restores the legacy
    // restart-notice path, and the controller fails closed on any unverified control regardless.
    const tuiRuntimeControlEnabled = resolveCliFeatureDecision({
        featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
        env: process.env,
    }).state === 'enabled';

    // Check if we have a TTY for UI rendering
    const terminalInkAvailable = resolveHasTTY({
        stdoutIsTTY: process.stdout.isTTY,
        stdinIsTTY: process.stdin.isTTY,
        startedBy: session.startedBy,
    });
    const controlSurface = session.startedBy === 'daemon'
        ? resolveRemoteModeControlSurface({
            stdoutIsTTY: process.stdout.isTTY,
            stdinIsTTY: process.stdin.isTTY,
            startedBy: session.startedBy,
            terminalMode: readRemoteControlTerminalMode(session),
        })
        : terminalInkAvailable
            ? 'ink'
            : 'none';
    const shouldRenderInkUi = controlSurface === 'ink';
    logger.debug(`[claudeRemoteLauncher] remote control surface: ${controlSurface}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;
    let staticControl: RemoteModeStaticControl | null = null;
    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;
    let turnInterrupt: (() => Promise<void>) | null = null;
    // Cancels the canonical Claude unified terminal turn on abort so an aborted
    // turn is never recorded completed by a later lifecycle settle. Mirrors the
    // standalone unified launcher abort path. Set when the unified binding is
    // created; cleared when the launch iteration tears down.
    let recordUnifiedPromptTurnCancelled: (() => Promise<void>) | null = null;
    let permissionHandler: PermissionHandler | null = null;
    let didUserAbortThisLaunch = false;
    const turnChangeTracker = new ClaudeTurnChangeTracker();
    const suppressedExplicitDiffCallIds = new Set<string>();

    if (shouldRenderInkUi) {
        console.clear();
        const inkStdout = createNonBlockingStdout(process.stdout as any);
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
	            onExit: async () => {
	                // Exit the entire client
	                logger.debug('[remote]: Exiting client via Ctrl-C');
                    session.noteUserAbortRequested();
	                if (!exitReason) {
	                    exitReason = 'exit';
	                }
                    await interruptThenTeardown('exit');
	            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false,
            stdout: inkStdout,
        });
    } else if (controlSurface === 'static') {
        staticControl = startRemoteModeStaticControl({
            providerName: 'Claude',
            stdin: process.stdin,
            stdout: process.stdout,
            allowSwitchToLocal: true,
            onExit: async () => {
                logger.debug('[remote]: Exiting client via Ctrl-C');
                session.noteUserAbortRequested();
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await interruptThenTeardown('exit');
            },
            onSwitchToLocal: () => {
                logger.debug('[remote]: Switching to local mode via static control');
                doSwitch();
            },
        });
    }

    if (shouldRenderInkUi) {
        // Ensure we can capture keypresses for the remote-mode UI.
        // Avoid forcing stdin encoding here; Ink (and Node) should handle key decoding safely.
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
    }

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

	    async function doAbort() {
	        logger.debug('[remote]: doAbort');
            session.noteUserAbortRequested();
            didUserAbortThisLaunch = true;
            await permissionHandler?.abortPendingRequestsAndFlush('Aborted by user');
	        if (turnInterrupt) {
	            try {
	                await turnInterrupt();
            } catch (error) {
                logger.debug('[remote]: turn interrupt failed; falling back to process abort', { error });
                session.noteUserAbortRequested();
                await recordUnifiedPromptTurnCancelled?.();
                session.abortCurrentTaskTurn();
                await abort();
                return;
            }
            await recordUnifiedPromptTurnCancelled?.();
            session.abortCurrentTaskTurn();
            session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
            return;
        }
	        session.noteUserAbortRequested();
	        await recordUnifiedPromptTurnCancelled?.();
	        session.abortCurrentTaskTurn();
	        await abort();
	    }

        async function interruptThenTeardown(label: string): Promise<void> {
            if (turnInterrupt) {
                try {
                    await turnInterrupt();
                } catch (error) {
                    logger.debug(`[remote]: turn interrupt failed during ${label}; falling back to process abort`, { error });
                }
            }

            if (!abortFuture) {
                await abort();
                return;
            }

            const graceMs = configuration.claudeRemoteInterruptThenTeardownGraceMs;
            if (!Number.isFinite(graceMs) || graceMs <= 0) {
                await abort();
                return;
            }

            const settled = await Promise.race([
                abortFuture.promise.then(() => true),
                new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(false), graceMs);
                    timer.unref?.();
                }),
            ]);

            if (!settled) {
                await abort();
            }
        }

	    async function doSwitch() {
	        logger.debug('[remote]: doSwitch');
            session.noteUserAbortRequested();
	        if (!exitReason) {
	            exitReason = 'switch';
	        }
	        await ensureSessionInfoBeforeSwitch({ session });
            await interruptThenTeardown('switch');
	    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', async (params: any) => {
        // Newer clients send a target mode. Older clients send no params.
        // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
        const to = resolveSwitchRequestTarget(params);
        if (to === 'remote') return true;
        await doSwitch();
        return true;
    }); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage, meta) => session.client.sendClaudeSessionMessage(logMessage, meta)
    );

    const streamedTranscriptWriter: StreamedTranscriptWriter = createStreamedTranscriptWriter({
        provider: 'claude' as any,
        session: createClaudeRemoteStreamedTranscriptSession(session.client),
    });

    const taskOutputCollector = new ClaudeRemoteTaskOutputCollector();
    const subagentFileCollector = new ClaudeRemoteSubagentFileCollector({
        emitImported: (body, meta) => {
            messageQueue.enqueue(body, { meta });
        },
        resolveJsonlPathForAgentId: ({ agentId, claudeSessionId }) => {
            const sanitized = String(agentId ?? '').trim();
            if (!sanitized) return null;
            return resolveClaudeSubagentJsonlPathForRemoteSession({
                transcriptPath: session.transcriptPath ?? null,
                projectDir: resolveClaudeProjectDir(session),
                claudeSessionId: claudeSessionId ?? session.sessionId,
                agentId: sanitized,
            });
        },
    });

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        void messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());

    const teamInboxBridge = createClaudeRemoteTeamInboxBridge({
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        enqueue: (message) => {
            messageQueue.enqueue(message, { meta: { importedFrom: 'claude-team-inbox' } });
        },
    });
    let activeUnifiedTranscriptBinding: Readonly<{
        isActive: () => boolean;
        shouldSuppressTranscriptMessage: (message: RawJSONLines) => boolean;
    }> | null = null;
    const teamInboxIntervalId = setInterval(() => {
        void teamInboxBridge.syncAll();
    }, 3000);

    const seededTeamInboxSessionIds = new Set<string>();
    const seedTeamInboxFromTranscriptPath = async (sessionId: string | null, transcriptPath: string | null): Promise<void> => {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return;
        if (seededTeamInboxSessionIds.has(sid)) return;

        const resolvedTranscriptPath = (() => {
            const direct = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
            if (direct.length > 0) return direct;
            // Best-effort fallback: try the heuristic project dir path (matches session scanner behavior).
            try {
                const projectDir = resolveClaudeProjectDir(session);
                return join(projectDir, `${sid}.jsonl`);
            } catch {
                return '';
            }
        })();
        if (!resolvedTranscriptPath) return;

        seededTeamInboxSessionIds.add(sid);
        try {
            const messages = await readClaudeSessionJsonlMessages({
                sessionFilePath: resolvedTranscriptPath,
                logLabel: 'CLAUDE_TEAM_INBOX_SEED',
            });
            for (const m of messages) {
                try {
                    teamInboxBridge.observe(normalizeClaudeToolUseNamesInRawJsonLines(m));
                } catch {
                    // ignore malformed history lines
                }
            }
            await teamInboxBridge.syncAll();
        } catch (error) {
            logger.debug('[remote]: failed seeding team inbox from transcript path (non-fatal)', { error });
        }
    };

    async function recordClaudeRemotePromptTurnStarted(): Promise<void> {
        try {
            await session.client.sessionTurnLifecycle?.beginTurn({ provider: 'claude' });
        } catch (error) {
            logger.debug('[remote]: Failed to record Claude remote turn start (non-fatal)', error);
        }
    }

    function onMessage(message: SDKMessage) {
        if (message.type === 'system') {
            updateMetadataBestEffort(
                session.client,
                (metadata) => ({
                    ...metadata,
                    ...(buildClaudeSessionModelsMetadataWithCurrentModelId({
                        currentModelId: (message as any).model,
                        metadata,
                    }) ?? {}),
                }),
                '[remote]',
                'runtime_model_update',
            );
        }

        let releaseIds: string[] = [];

        if (message.type === 'assistant') {
            const content = Array.isArray((message as SDKAssistantMessage).message?.content)
                ? (message as SDKAssistantMessage).message.content
                : [];
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type !== 'tool_use') continue;
                const callId = typeof block.id === 'string' ? block.id : '';
                const toolName = typeof block.name === 'string' ? block.name : '';
                const rawInput = block.input;
                const args = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                    ? rawInput as Record<string, unknown>
                    : {};
                if (!callId || !toolName) continue;
                turnChangeTracker.observeToolCall({
                    callId,
                    toolName,
                    args,
                    parentToolUseId: (message as SDKAssistantMessage).parent_tool_use_id,
                });
                if (isClaudeExplicitDiffToolInput(toolName, args)) {
                    suppressedExplicitDiffCallIds.add(callId);
                }
            }
        }

        if (message.type === 'user') {
            const content = Array.isArray((message as SDKUserMessage).message?.content)
                ? (message as SDKUserMessage).message.content
                : [];
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type !== 'tool_result') continue;
                const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                if (!callId) continue;
                turnChangeTracker.observeToolResult({
                    callId,
                    isError: block.is_error === true,
                });
                if (block.is_error === true) {
                    suppressedExplicitDiffCallIds.delete(callId);
                }
            }
        }

        if (message.type === 'result') {
            if (message.subtype === 'success') {
                const turnChangeSet = turnChangeTracker.completeTurn({
                    sessionId: session.sessionId ?? session.client.sessionId ?? 'unknown',
                    status: 'completed',
                });
                if (turnChangeSet) {
                    const diffCallId = `claude-diff-${turnChangeSet.turnId}`;
                    const syntheticMessages: SDKMessage[] = [
                        {
                            type: 'assistant',
                            parent_tool_use_id: null,
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: diffCallId,
                                        name: 'Diff',
                                        input: buildTurnChangeSetDiffInput({
                                            turnChangeSet,
                                            protocol: 'claude',
                                            rawToolName: 'ClaudeTurnDiff',
                                        }),
                                    },
                                ],
                            },
                        },
                        {
                            type: 'user',
                            parent_tool_use_id: null,
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: diffCallId,
                                        content: { status: 'completed' },
                                    },
                                ],
                            },
                        },
                    ];

                    for (const syntheticMessage of syntheticMessages) {
                        const converted = sdkToLogConverter.convert(syntheticMessage);
                        if (converted) {
                            messageQueue.enqueue(converted);
                        }
                    }
                }
                suppressedExplicitDiffCallIds.clear();
            } else {
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
            }
        }

        if (message && message.type === 'assistant') {
            const parentToolUseId =
                typeof (message as any).parent_tool_use_id === 'string' ? (message as any).parent_tool_use_id.trim() : '';
            if (!parentToolUseId) {
                const content = Array.isArray((message as SDKAssistantMessage).message?.content)
                    ? (message as SDKAssistantMessage).message.content
                    : [];
                const textParts = content
                    .map((block) => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
                        ? block.text
                        : ''))
                    .filter((part) => part.length > 0);
                if (textParts.length > 0) {
                    turnAssistantPreviewTracker.replace(textParts.join('\n\n'));
                }
            }
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler!.onMessage(message);

        const taskOutputIngest = taskOutputCollector.observe(message);
        subagentFileCollector.observe(message);

        if (message.type === 'user') {
            turnAssistantPreviewTracker.reset();
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        // When tool result received, release any delayed messages for this tool call
                        releaseIds.push(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        if (message.type === 'assistant') {
            const assistantContent = Array.isArray((message as SDKAssistantMessage).message?.content)
                ? (message as SDKAssistantMessage).message.content
                : [];
            const filteredContent = assistantContent.filter((block) => {
                if (!block || typeof block !== 'object') return false;
                if (block.type !== 'tool_use') return true;
                const callId = typeof block.id === 'string' ? block.id : '';
                return !callId || !suppressedExplicitDiffCallIds.has(callId);
            });
            if (filteredContent.length !== assistantContent.length) {
                msg = {
                    ...(message as SDKAssistantMessage),
                    message: {
                        ...(message as SDKAssistantMessage).message,
                        content: filteredContent,
                    },
                };
            }

        }

        if (message.type === 'user') {
            const rawUserContent = (message as SDKUserMessage).message?.content;
            const userContent = Array.isArray(rawUserContent) ? rawUserContent : [];
            const filteredContent = userContent.filter((block) => {
                if (!block || typeof block !== 'object') return false;
                if (block.type !== 'tool_result') return true;
                const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                return !callId || !suppressedExplicitDiffCallIds.has(callId);
            });
            if (filteredContent.length !== userContent.length) {
                msg = {
                    ...(message as SDKUserMessage),
                    message: {
                        ...(message as SDKUserMessage).message,
                        content: filteredContent,
                    },
                };
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            try {
                teamInboxBridge.observe(logMessage);
            } catch {
                // ignore
            }

            const taskOutputToolUseIds = new Set<string>();
            for (const info of taskOutputIngest.taskOutputToolResults) {
                taskOutputToolUseIds.add(info.toolUseId);
            }

            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler!.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            const allowedTools = response.allowedTools ?? response.allowTools;
                            if (allowedTools && allowedTools.length > 0) {
                                permissions.allowedTools = allowedTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }

                        if (taskOutputToolUseIds.has(c.tool_use_id)) {
                            // TaskOutput tool_result payloads can be huge (JSONL transcript). Keep the main transcript compact.
                            content[i] = {
                                ...content[i],
                                content: '',
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain =
                        typeof assistantMsg.parent_tool_use_id === 'string' && assistantMsg.parent_tool_use_id.trim().length > 0;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds,
                            releaseToolCallIds: releaseIds.length > 0 ? releaseIds : undefined,
                        });
                        return; // Don't queue again below
                    }
                }
            }

            if (
                activeUnifiedTranscriptBinding?.isActive() === true
                && activeUnifiedTranscriptBinding.shouldSuppressTranscriptMessage(logMessage)
            ) {
                return;
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage, releaseIds.length > 0 ? { releaseToolCallIds: releaseIds } : undefined);
        }

        for (const imported of taskOutputIngest.imported) {
            messageQueue.enqueue(imported.body, { meta: imported.meta });
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (
                        c.type === 'tool_use' &&
                        typeof c.name === 'string' &&
                        typeof c.id === 'string' &&
                        isGenericSubAgentToolName(c.name) &&
                        c.input &&
                        typeof (c.input as any).prompt === 'string'
                    ) {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: MessageBatch<EnhancedMode, string> | null = null;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null | undefined = undefined;
        let forceNewSession = false;
        let waitForMessageBeforeNextLaunch = false;
        let consecutiveUnifiedParkRelaunches = 0;
        const resetUnifiedParkRelaunchBudget = (): void => {
            consecutiveUnifiedParkRelaunches = 0;
        };
        const consumeUnifiedParkRelaunchBudget = (): boolean => {
            consecutiveUnifiedParkRelaunches += 1;
            if (consecutiveUnifiedParkRelaunches <= MAX_CONSECUTIVE_REMOTE_UNIFIED_PARK_RELAUNCHES) {
                return true;
            }
            const message = `Claude unified terminal failed ${MAX_CONSECUTIVE_REMOTE_UNIFIED_PARK_RELAUNCHES + 1} times in a row. Not retrying automatically; your queued message remains redeliverable when the session restarts.`;
            messageBuffer.addMessage(message, 'status');
            session.client.sendSessionEvent({
                type: 'message',
                message,
            });
            return false;
        };
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = forceNewSession || session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                await permissionHandler.resetAndFlush(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                subagentFileCollector.cleanup(); // Stop any watchers from prior sessions (subagent JSONL lives under session id).
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                forceNewSession = false;
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const sessionIdAtLaunchStart = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            didUserAbortThisLaunch = false;
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            let applyUnifiedTerminalMetadataMode: ((mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>) | null = null;
            const resumeChoiceBroker = new ClaudeUnifiedResumeChoiceBroker(session);
            const applyUnifiedTerminalPermissionMetadata = createClaudeUnifiedTerminalMetadataModeApplier({
                getCurrentMode: () => mode,
                getApplier: () => applyUnifiedTerminalMetadataMode,
            });
            let didReplaySeedBootstrap = false;
            let unifiedTerminalLaunchOptionsHash: string | null = null;
            let lastUnifiedTerminalRestartOnlyNoticeHash: string | null = null;
            let readyTurnContext: ReadyNotificationTurnContext | undefined;
            const beginReadyNotificationTurn = () => {
                if (typeof session.client.beginTurnAssistantTextSnapshot !== 'function') return;
                const startSeqExclusive = typeof session.client.getLastObservedMessageSeq === 'function'
                    ? session.client.getLastObservedMessageSeq()
                    : null;
                const turnToken = session.client.beginTurnAssistantTextSnapshot({ startSeqExclusive });
                readyTurnContext = { turnToken, startSeqExclusive };
            };
            const shouldDeferTurnStartUntilTerminalInjection = (nextMode: EnhancedMode): boolean =>
                nextMode.claudeUnifiedTerminalEnabled === true;
            const shouldTreatModeChangeAsRelaunchBoundary = (currentMode: EnhancedMode | null, nextMode: EnhancedMode, hashChanged: boolean, isolate: boolean): boolean => {
                if (isolate) return true;
                if (!hashChanged) return false;
                return !(currentMode?.claudeUnifiedTerminalEnabled === true && nextMode.claudeUnifiedTerminalEnabled === true);
            };
            const shouldSurfaceUnifiedTerminalRestartOnlyOptionsNotice = (
                currentMode: EnhancedMode | null,
                nextMode: EnhancedMode,
                launchOptionsChanged: boolean,
            ): boolean =>
                launchOptionsChanged
                && currentMode?.claudeUnifiedTerminalEnabled === true
                && nextMode.claudeUnifiedTerminalEnabled === true;
            const surfaceUnifiedTerminalRestartOnlyOptionsNotice = (
                currentMode: EnhancedMode | null,
                nextMode: EnhancedMode,
                nextHash: string,
            ): void => {
                if (lastUnifiedTerminalRestartOnlyNoticeHash === nextHash) return;
                lastUnifiedTerminalRestartOnlyNoticeHash = nextHash;
                const changes = buildUnifiedTerminalRuntimeConfigRestartChanges(currentMode, nextMode);
                // When the TUI runtime-control controller is active it applies model/permission/effort live
                // and reports max-thinking as unsupported through the verified-control outcome path, so those
                // keys must NOT also ride the blanket restart/unsupported notice. Truly launch-only options
                // (fallbackModel, host/launchOption) keep the restart notice.
                const tuiControllerHandledKeys: ReadonlySet<ClaudeRuntimeConfigOutcomeChange['key']> = tuiRuntimeControlEnabled
                    ? new Set(['model', 'permissionMode', 'reasoningEffort', 'maxThinkingTokens'])
                    : new Set();
                const unsupportedChanges = changes.filter(
                    (change) => change.key === 'maxThinkingTokens' && !tuiControllerHandledKeys.has(change.key),
                );
                const restartChanges = changes.filter(
                    (change) => change.key !== 'maxThinkingTokens' && !tuiControllerHandledKeys.has(change.key),
                );

                if (restartChanges.length > 0) {
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: CLAUDE_UNIFIED_TERMINAL_RESTART_ONLY_OPTIONS_MESSAGE,
                    });
                    session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent({
                        status: 'requires_restart',
                        reason: 'unified_terminal_launch_options_changed',
                        message: CLAUDE_UNIFIED_TERMINAL_RESTART_ONLY_OPTIONS_MESSAGE,
                        changes: restartChanges,
                    }));
                }
                if (unsupportedChanges.length > 0) {
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: CLAUDE_UNIFIED_TERMINAL_UNSUPPORTED_OPTIONS_MESSAGE,
                    });
                    session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent({
                        status: 'unsupported',
                        reason: 'unified_terminal_unsupported_options_changed',
                        message: CLAUDE_UNIFIED_TERMINAL_UNSUPPORTED_OPTIONS_MESSAGE,
                        changes: unsupportedChanges,
                    }));
                }
            };
            const beginPromptTurn = async (): Promise<void> => {
                beginReadyNotificationTurn();
                await recordClaudeRemotePromptTurnStarted();
            };
            const hasQueuedUnifiedTerminalPrompt = (): boolean =>
                session.queue.queue.some((item) => item.mode.claudeUnifiedTerminalEnabled === true);
            const isUnifiedTerminalTranscriptActive = (): boolean =>
                mode?.claudeUnifiedTerminalEnabled === true
                || pending?.mode.claudeUnifiedTerminalEnabled === true
                || hasQueuedUnifiedTerminalPrompt();
            let surfaceUnifiedTerminalRuntimeIssue: (error: unknown) => Promise<boolean> = async () => false;
            try {
                const inputConsumer = createClaudePendingAwareInputConsumer(session, {
                    onMetadataUpdate: async () => {
                        const updated = syncClaudePermissionModeFromMetadata({ session, permissionHandler });
                        if (updated) {
                            logger.debug(`[remote]: Permission mode updated from metadata to: ${updated}`);
                            await applyUnifiedTerminalPermissionMetadata(updated);
                        }
                    },
                });

                const waitForNextBatch = async (): Promise<MessageBatch<EnhancedMode, string> | null> => {
                    return await inputConsumer.waitForNextInput({ abortSignal: controller.signal });
                };

                // A3-HIGH-1: this launcher confirms provider handoff/acceptance for every consumed
                // batch (below + the unified runner's onPromptAcceptedByProvider), so the
                // delivered-watermark must not advance at queue handoff anymore.
                session.client.deferDeliveredUserMessageWatermarkToProviderAcceptance?.();
                const takeBatchDeliveryAttributionForProvider = (batch: MessageBatch<EnhancedMode, string>): {
                    maxUserMessageSeq: number | null;
                    userMessageLocalIds: readonly string[];
                } => {
                    const maxUserMessageSeq = batch.maxUserMessageSeq ?? null;
                    const userMessageLocalIds = batch.userMessageLocalIds ?? [];
                    if (batch.mode.claudeUnifiedTerminalEnabled === true) {
                        // The unified runner owns acceptance; the seq travels with the batch and is
                        // confirmed by onPromptAcceptedByProvider once the provider accepted it.
                        return { maxUserMessageSeq, userMessageLocalIds };
                    }
                    // SDK/legacy custody is synchronous from here: handing the batch to the provider
                    // loop is the acceptance seam for this runner family.
                    session.client.confirmUserMessageDeliveredToProvider?.(maxUserMessageSeq, {
                        localIds: userMessageLocalIds,
                    });
                    resetUnifiedParkRelaunchBudget();
                    return { maxUserMessageSeq: null, userMessageLocalIds: [] };
                };

                if (waitForMessageBeforeNextLaunch) {
                    waitForMessageBeforeNextLaunch = false;
                    messageBuffer.addMessage('Claude Code exited unexpectedly. Waiting for the next message to retry...', 'status');
                    const msg = await waitForNextBatch();
                    if (!msg) {
                        if (exitReason) {
                            continue;
                        }
                        if (session.queue.isClosed()) {
                            exitReason = 'exit';
                            continue;
                        }
                        // If we were aborted without an explicit exit/switch request (e.g. detached client),
                        // stay parked to avoid a tight retry loop.
                        waitForMessageBeforeNextLaunch = true;
                        continue;
                    }
                    pending = msg;
                }

                const readyHandler = createClaudeReadyHandler({
                    session: session.client,
                    pushSender: session.pushSender,
                    waitingForCommandLabel: 'Claude',
                    logPrefix: '[remote]',
                    assistantPreviewTracker: turnAssistantPreviewTracker,
                    getPending: () => pending,
                    getQueueSize: () => session.queue.size(),
                    accountSettings: session.accountSettings ?? null,
                    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
                    includeAssistantPreviewText:
                        session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
                    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
                });
                const unifiedBinding = bindClaudeUnifiedTerminalSession({
                    session: session.client,
                    logPrefix: '[remote]',
                    acceptedPromptEchoWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
                    onMessage: (message) => {
                        messageQueue.enqueue(message);
                    },
                    onReady: (context) => {
                        readyHandler(context);
                    },
                    onTurnInterruptChanged: (handler) => {
                        turnInterrupt = handler;
                    },
                    onPromptTurnStarted: () => {
                        session.setThinkingWithoutTaskLifecycle(true);
                    },
                });
                recordUnifiedPromptTurnCancelled = unifiedBinding.recordPromptTurnCancelled;
                await unifiedBinding.seedPersistedPromptEchoes();
                surfaceUnifiedTerminalRuntimeIssue = async (error: unknown): Promise<boolean> => {
                    session.onThinkingChange(false);
                    const surfaced = await surfaceClaudeUnifiedTerminalRuntimeIssue({
                        error,
                        session: session.client,
                        onSurfaceError: (surfaceError) => {
                            logger.debug('[remote]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
                        },
                    });
                    if (surfaced) {
                        unifiedBinding.notePromptTurnTerminal();
                    }
                    return surfaced;
                };
                activeUnifiedTranscriptBinding = {
                    isActive: isUnifiedTerminalTranscriptActive,
                    shouldSuppressTranscriptMessage: unifiedBinding.shouldSuppressTranscriptMessage,
                };

                const { mcpServers: baseMcpServers, mcpConfigJson: baseMcpConfigJson } = await session.getOrCreateHappierMcpBridge();

                // If this is a restarted daemon process resuming an existing agent-team session,
                // we may not replay transcript history through `onMessage`. Seed team inbox mapping
                // from the transcript file so unread teammate messages still import correctly.
                session.adoptExplicitResumeSessionIdFromArgs();
                await seedTeamInboxFromTranscriptPath(session.sessionId, session.transcriptPath ?? null);

                const remoteResult = await claudeRemoteDispatch({
                    sessionId: session.sessionId,
                    transcriptPath: session.transcriptPath,
                    path: session.path,
                    systemPromptText: session.defaultSystemPromptText,
                    hookSettingsPath: session.hookSettingsPath,
                    hookPluginDir: session.hookPluginDir,
                    jsRuntime: session.jsRuntime,
                    happierMcpServers: baseMcpServers,
                    happierMcpConfigJson: baseMcpConfigJson,
                    streamedTranscriptWriter,
                    setTurnInterrupt: unifiedBinding.sessionOptions.setTurnInterrupt,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    // A message pulled by the unified runner's input pump during a death/dispose
                    // unwind must come back to the session queue instead of being dropped into
                    // the dead host (silent queue-swallow, incident cmq8y3nlx).
                    returnUnconsumedMessage: ({ message, mode: unconsumedMode, maxUserMessageSeq, userMessageLocalIds }: {
                        message: string;
                        mode: EnhancedMode;
                        maxUserMessageSeq?: number | null;
                        userMessageLocalIds?: readonly string[] | null;
                    }) => {
                        try {
                            // Preserve watermark attribution across the handback (A3-HIGH-1).
                            session.queue.unshift(message, unconsumedMode, {
                                userMessageSeq: maxUserMessageSeq ?? null,
                                userMessageLocalIds: userMessageLocalIds ?? [],
                            });
                        } catch (error) {
                            logger.debug('[remote]: failed to requeue undeliverable unified terminal message', error);
                        }
                    },
                    nextMessage: async () => {
                        if (pending) {
                            const p = pending;
                            pending = null;
                            modeHash = p.hash;
                            mode = p.mode;
                            unifiedTerminalLaunchOptionsHash = p.mode.claudeUnifiedTerminalEnabled === true
                                ? hashClaudeUnifiedTerminalLaunchOptionsForQueue(p.mode)
                                : null;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            if (!shouldDeferTurnStartUntilTerminalInjection(p.mode)) {
                                await beginPromptTurn();
                            } else {
                                unifiedBinding.noteNextInjectedPromptShouldSuppressEcho();
                            }
                            return {
                                message: p.message,
                                mode: p.mode,
                                ...takeBatchDeliveryAttributionForProvider(p),
                            };
                        }

                        const msg = await waitForNextBatch();
                        if (!msg) {
                            return null;
                        }

                        // Check if mode has changed
                        const hashChanged = Boolean(modeHash && msg.hash !== modeHash);
                        if (shouldTreatModeChangeAsRelaunchBoundary(mode, msg.mode, hashChanged, msg.isolate)) {
                            logger.debug('[remote]: mode has changed, pending message');
                            pending = msg;
                            return null;
                        }
                        const nextUnifiedTerminalLaunchOptionsHash = msg.mode.claudeUnifiedTerminalEnabled === true
                            ? hashClaudeUnifiedTerminalLaunchOptionsForQueue(msg.mode)
                            : null;
                        const unifiedTerminalLaunchOptionsChanged = Boolean(
                            unifiedTerminalLaunchOptionsHash
                            && nextUnifiedTerminalLaunchOptionsHash
                            && nextUnifiedTerminalLaunchOptionsHash !== unifiedTerminalLaunchOptionsHash,
                        );
                        if (shouldSurfaceUnifiedTerminalRestartOnlyOptionsNotice(mode, msg.mode, unifiedTerminalLaunchOptionsChanged)) {
                            surfaceUnifiedTerminalRestartOnlyOptionsNotice(mode, msg.mode, nextUnifiedTerminalLaunchOptionsHash ?? msg.hash);
                        }
                        modeHash = msg.hash;
                        const nextMode = msg.mode;
                        mode = nextMode;
                        unifiedTerminalLaunchOptionsHash = nextUnifiedTerminalLaunchOptionsHash;
                        permissionHandler.handleModeChange(nextMode.permissionMode);
                        const replaySeedResolution = await resolveClaudeRemoteQueuedPromptWithReplaySeed({
                            sessionClient: session.client,
                            batch: { message: msg.message, mode: msg.mode },
                            didBootstrap: didReplaySeedBootstrap,
                        });
                        didReplaySeedBootstrap = replaySeedResolution.didBootstrap;
                        if (!shouldDeferTurnStartUntilTerminalInjection(nextMode)) {
                            await beginPromptTurn();
                        } else {
                            unifiedBinding.noteNextInjectedPromptShouldSuppressEcho();
                        }

                        return {
                            message: typeof replaySeedResolution.message === 'string' ? replaySeedResolution.message : '',
                            mode: msg.mode,
                            ...takeBatchDeliveryAttributionForProvider(msg),
                        };
                    },
                    onSessionFound: (sessionId: string, data: unknown) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId, data as any);
                        const transcriptPath = typeof (data as any)?.transcript_path === 'string' ? String((data as any).transcript_path) : null;
                        void seedTeamInboxFromTranscriptPath(sessionId, transcriptPath);
                    },
                    loadCommittedClaudeJsonlMessageBaseline: () =>
                        session.client.fetchCommittedClaudeJsonlMessageBaseline?.()
                        ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null },
                    // Unknown canonical state (no accessor) counts as ACTIVE (fail-closed).
                    isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
                    onCheckpointCaptured: (checkpointId: string) => {
                        updateMetadataBestEffort(
                            session.client,
                            (metadata) => ({
                                ...metadata,
                                claudeLastCheckpointId: checkpointId,
                            }),
                            '[remote]',
                            'checkpoint_captured',
                        );
                    },
                    onCapabilities: (caps: any) => {
                        if (!caps || typeof caps !== 'object') return;
                        updateMetadataBestEffort(
                            session.client,
                            (metadata) => {
                                const modelsMetadata = buildClaudeSessionModelsMetadataFromSupportedModels({
                                    modelsRaw: caps.models,
                                    metadata,
                                });
                                return {
                                    ...metadata,
                                    ...(Array.isArray(caps.slashCommands) ? { slashCommands: caps.slashCommands } : {}),
                                    ...(Array.isArray(caps.slashCommandDetails) ? { slashCommandDetails: caps.slashCommandDetails } : {}),
                                    ...(modelsMetadata ?? {}),
                                };
                            },
                            '[remote]',
                            'capabilities_update',
                        );
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onWorkStateSnapshot: (snapshot: SessionWorkStateV1) => {
                        const sourceFamilies = resolveWorkStateSourceFamiliesFromSnapshot(snapshot);
                        if (sourceFamilies.length === 0) return;
                        updateMetadataBestEffort(
                            session.client,
                            (metadata) => mergeSessionWorkStateIntoMetadata(metadata, {
                                nextOwned: snapshot,
                                ownedSourceFamilies: sourceFamilies,
                            }),
                            '[remote]',
                            'work_state',
                        );
                    },
                    onRateLimitEvent: async (details: NormalizedProviderUsageLimitDetailsV1) => {
                        await surfaceClaudeRateLimitRuntimeIssue(session, details, '[remote]');
                    },
                    // Unified terminal usage-limit evidence is detected by the hook lifecycle
                    // bridge and surfaced through onUsageLimitDetails (the legacy/agent-SDK
                    // runners use onRateLimitEvent instead). Without this the unified path
                    // would silently drop hook-detected usage limits.
                    onUsageLimitDetails: async (details: NormalizedProviderUsageLimitDetailsV1) => {
                        try {
                            await surfaceClaudeRateLimitRuntimeIssue(session, details, '[remote]');
                        } finally {
                            unifiedBinding.notePromptTurnTerminal();
                        }
                    },
                    // Forward unified terminal turn-terminal projection so failed/aborted
                    // turns terminalize the canonical turn instead of being recorded
                    // completed. Parity with the standalone unified launcher.
                    onPromptTurnTerminal: async (
                        event: Parameters<NonNullable<ClaudeUnifiedTerminalSessionOptions['onPromptTurnTerminal']>>[0],
                    ) => {
                        try {
                            if (event.reason === 'aborted') {
                                await unifiedBinding.recordPromptTurnCancelled();
                                session.abortCurrentTaskTurn();
                                return;
                            }
                            if (event.reason === 'failed' && event.source === 'claude_transcript_api_error') {
                                await surfacePrimarySessionRuntimeIssue({
                                    provider: 'claude',
                                    cause: 'status_error',
                                    error: {
                                        code: event.source,
                                        message: event.detail ?? event.source,
                                    },
                                    session: session.client,
                                }).catch((error) => {
                                    logger.debug('[remote]: failed to surface Claude transcript API-error turn failure (non-fatal)', error);
                                    return null;
                                });
                            }
                        } finally {
                            // Any non-aborted terminal projection (hook StopFailure, process exit,
                            // unknown) must terminalize the canonical turn; leaving it open keeps the
                            // server turn 'in_progress' forever and permanently blocks daemon
                            // pending-queue draining (QA A-F3/C-F2).
                            await unifiedBinding.recordPromptTurnFailed().catch(() => undefined);
                        }
                    },
                    onRuntimeAuthFailureEvent: async (error: unknown) => {
                        await surfaceClaudeRuntimeAuthFailure(session, error, '[remote]');
                    },
                    onCompletionEvent: (event: ClaudeCompletionEvent) => {
                        logger.debug('[remote]: Completion event', event);
                        sendClaudeCompletionEvent({ session, event });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        forceNewSession = true;
                        session.clearSessionId();
                    },
                    onReady: async () => {
                        await messageQueue.flush();
                        if (isUnifiedTerminalTranscriptActive()) {
                            await unifiedBinding.sessionOptions.onReady?.();
                            return;
                        }
                        readyHandler(readyTurnContext);
                    },
                    onSubagentFlush: async () => {
                        await messageQueue.flush();
                    },
                    onTerminalPromptInjected: async (
                        acceptedPrompt: Parameters<NonNullable<ClaudeUnifiedTerminalSessionOptions['onTerminalPromptInjected']>>[0],
                    ) => {
                        await unifiedBinding.sessionOptions.onTerminalPromptInjected?.(acceptedPrompt);
                    },
                    onProviderPromptStarted: () => {
                        if (isUnifiedTerminalTranscriptActive()) {
                            return unifiedBinding.sessionOptions.onProviderPromptStarted?.();
                        }
                        beginReadyNotificationTurn();
                        return undefined;
                    },
                    onTerminalInjectionFailure: surfaceUnifiedTerminalRuntimeIssue,
                    signal: abortController.signal,
                }, {
                    claudeUnifiedTerminal: async (dispatchOpts: unknown) => {
                        // Lane P (O-design Seam A): publish live steer availability (+reason) to agentState.
                        const inFlightSteerCapabilityPublisher = createClaudeInFlightSteerCapabilityPublisher({
                            session: session.client,
                            isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
                        });
                        try {
                        return await runClaudeUnifiedTerminalSession({
                            ...(dispatchOpts as ClaudeUnifiedTerminalSessionOptions),
                            happySessionId: session.client.sessionId,
                            statuslineForwarder: session.claudeStatuslineForwarder ?? undefined,
                            // Persist a consumed marker for controller-command echoes the runner
                            // suppresses, so they join the committed baseline and cannot replay as
                            // "new" messages after a respawn (resume-replay leak, 2026-06-11).
                            onTranscriptMessageSuppressed: (message: RawJSONLines) => {
                                session.client.recordClaudeJsonlMessageConsumed?.(message, {
                                    suppressedBy: 'control_command_echo',
                                });
                            },
                            onInFlightSteerAvailabilitySnapshot: inFlightSteerCapabilityPublisher.publish,
                            // A3-HIGH-1 root fix: the delivered-user-message watermark persists at
                            // provider acceptance, not when the row entered volatile memory.
                            onPromptAcceptedByProvider: ({ maxUserMessageSeq, userMessageLocalIds }: {
                                maxUserMessageSeq: number | null;
                                userMessageLocalIds: readonly string[];
                            }) => {
                                session.client.confirmUserMessageDeliveredToProvider?.(maxUserMessageSeq, {
                                    localIds: userMessageLocalIds,
                                });
                                resetUnifiedParkRelaunchBudget();
                            },
                            isPromptDeliveryAccepted: (batch) => session.client.hasUserMessageProviderAcceptance?.({
                                userMessageSeq: batch.maxUserMessageSeq ?? null,
                                localIds: batch.userMessageLocalIds ?? [],
                            }) === true,
                            registerTerminalComposerClearRuntimeControl: (clearTerminalComposer, submitTerminalComposer) =>
                                session.client.registerSessionRuntimeControls?.({ clearTerminalComposer, submitTerminalComposer }) ?? (() => undefined),
                            // C11 (incident cmq8y3nlx): binding-owned registry, seeded from the
                            // persisted prompt store above, so a respawned runner recognizes its
                            // predecessor's leftover composer injection as our own text.
                            ownComposerTexts: unifiedBinding.ownComposerTexts,
                            // Lane X (incident cmq8y3nlx): one honest notice per starvation
                            // episode — the queued message is blocked by a terminal composer draft.
                            onInFlightSteerUserDraftStarvation: () => {
                                inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
                                session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('in_flight_steer'));
                            },
                            onDraftGuardStarvation: () => {
                                inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
                                session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'));
                            },
                            createStartupDialogResolver: ({ controlPort, startupMode }) =>
                                createClaudeUnifiedResumeChoiceStartupResolver({
                                    choice: startupMode.claudeUnifiedTerminalResumeChoice ?? 'ask_every_time',
                                    broker: resumeChoiceBroker,
                                    port: controlPort,
                                    wait: delay,
                                    settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
                                }),
                            subscribeClaudeSessionHooks: (callback) => {
                                session.addClaudeSessionHookCallback(callback);
                                return () => {
                                    session.removeClaudeSessionHookCallback(callback);
                                };
                            },
                            tuiRuntimeControl: {
                                featureEnabled: tuiRuntimeControlEnabled,
                                // sessionMode change-key emission stays gated off until UI/dev consumers ship
                                // the widened enum (Lane B version-skew); plan-mode rides permissionMode.
                                emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => {
                                    session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent(event));
                                },
                                // F2 (qa/QA-B.md): one honest notice per stuck-unsafe-window episode —
                                // an idle queued message kept deferring because runtime controls could
                                // not be applied over a composer draft/dialog on the TUI.
                                onBlockedApplyStarvation: (info) => {
                                    if (isClaudeUnifiedRuntimeControlUserDraftBlocker(info.blockedReason)) {
                                        inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
                                        session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'));
                                        return;
                                    }
                                    session.client.sendSessionEvent({
                                        type: 'message',
                                        message: 'Your queued message is waiting: the terminal shows a draft or dialog that blocks applying your settings change. Clear the terminal composer (or dismiss the dialog) to deliver it.',
                                    });
                                },
                                // Lane Y: feed statusline-reported effective model/effort into the
                                // controller's lastVerified through the session statusline applier.
                                registerStatuslineRuntimeReconciler: (reconcile) =>
                                    session.setClaudeStatuslineRuntimeReconciler(reconcile),
                                registerMetadataRuntimeModeApplier: (apply) => {
                                    applyUnifiedTerminalMetadataMode = apply;
                                    void applyUnifiedTerminalPermissionMetadata.flushPending().catch((error) => {
                                        logger.debug('[remote]: failed to flush pending metadata runtime mode after applier registration', error);
                                    });
                                    return () => {
                                        if (applyUnifiedTerminalMetadataMode === apply) {
                                            applyUnifiedTerminalMetadataMode = null;
                                        }
                                    };
                                },
                            },
                        });
                        } finally {
                            resumeChoiceBroker.dispose();
                            inFlightSteerCapabilityPublisher.dispose();
                        }
                    },
                });

                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
                if (!exitReason && session.queue.isClosed()) {
                    exitReason = 'exit';
                }
            } catch (e) {
                const abortError = isAbortError(e);
                const executionErrorAfterUserAbort =
                    didUserAbortThisLaunch
                    && !exitReason
                    && isClaudeExecutionErrorAfterUserAbort(e);
                logger.debug('[remote]: launch error', {
                    ...getLaunchErrorInfo(e),
                    abortError,
                    executionErrorAfterUserAbort,
                });

                if (exitReason) {
                    // Exit already requested (switch/exit).
                } else if (abortError || executionErrorAfterUserAbort) {
                    if (controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                    // Claude Code sometimes exits in a non-resumable state after a force-abort. If this abort was
                    // explicitly user-initiated (not a mode switch), clear the stored session ID so the next launch
                    // doesn't get stuck trying to resume a dead session.
                    if (
                        controller.signal.aborted
                        && didUserAbortThisLaunch
                        && !exitReason
                    ) {
                        forceNewSession = true;
                        session.clearSessionId();
                    }
                    continue;
                } else {
                    if (await surfaceUnifiedTerminalRuntimeIssue(e)) {
                        if (!consumeUnifiedParkRelaunchBudget()) {
                            exitReason = 'exit';
                            continue;
                        }
                        waitForMessageBeforeNextLaunch = true;
                        continue;
                    }
                    const exitCode = resolveClaudeCodeExitCode(e);
                    if (exitCode === 1) {
                        const artifacts = resolveClaudeCodeArtifacts(e);
                        const tailText = artifacts ? await formatClaudeCodeArtifactsTailForUi(artifacts) : '';
                        const base = formatErrorForUi(e, { maxChars: 12_000 });
                        const message = tailText
                            ? `${base}\n\n${tailText}`
                            : base;
                        session.client.sendSessionEvent({ type: 'message', message });
                        if (
                            controller.signal.aborted
                            && didUserAbortThisLaunch
                            && !exitReason
                        ) {
                            forceNewSession = true;
                            session.clearSessionId();
                        } else if (
                            // If we attempted to resume an existing Claude Code session and it immediately exited with
                            // code 1 (common for non-resumable sessions after interrupts/crashes), avoid getting stuck
                            // in a permanent loop where we keep passing `--resume <dead-session-id>` forever.
                            //
                            // In that case, clear the stored session ID so the next launch creates a fresh Claude Code
                            // session. This is a best-effort recovery path: if the underlying session is resumable, a
                            // non-aborted run will keep the session id stable and this will not trigger.
                            !controller.signal.aborted
                            && typeof sessionIdAtLaunchStart === 'string'
                            && sessionIdAtLaunchStart.trim().length > 0
                            && session.sessionId === sessionIdAtLaunchStart
                            && !exitReason
                        ) {
                            forceNewSession = true;
                            session.clearSessionId();
                        }
                        waitForMessageBeforeNextLaunch = true;
                        continue;
                    } else {
                        session.client.sendSessionEvent({ type: 'message', message: `Claude process error: ${formatErrorForUi(e)}` });
                        continue;
                    }
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                turnInterrupt = null;
                recordUnifiedPromptTurnCancelled = null;
                activeUnifiedTranscriptBinding = null;
                logger.debug('[remote]: launch done');
                await permissionHandler.resetAndFlush();
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
                modeHash = null;
                mode = null;
                unifiedTerminalLaunchOptionsHash = null;
                // Session IDs can change during a remote run (system init / resume / fork / compact).
                // Keep previousSessionId in sync so we don't treat the same session as "new" again
                // on the next outer loop iteration.
                previousSessionId = session.sessionId;
            }
        }
    } finally {

        // Clean up permission handler
        await permissionHandler.resetAndFlush();
        permissionHandler.dispose();
        subagentFileCollector.cleanup();
        clearInterval(teamInboxIntervalId);
        teamInboxBridge.cleanup();

        if (inkInstance) {
            inkInstance.unmount();
        }
        if (staticControl) {
            await staticControl.stop();
            staticControl = null;
        }

        // Give Ink a brief moment to release stdin/tty state, then drain any buffered input
        // (e.g. “double space” spam) so it doesn't leak into the next interactive process.
        await cleanupStdinAfterInk({ stdin: process.stdin as any, drainMs: 75 });
        restoreStdinBestEffort({ stdin: process.stdin as any });

        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
