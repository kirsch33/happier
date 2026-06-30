import { createClaudeReadyHandler } from '../ready/createClaudeReadyHandler';
import { createClaudePendingAwareInputConsumer } from '../createClaudePendingAwareInputConsumer';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import type { LauncherResult } from '../claudeLocalLauncher';
import { createClaudeSessionTranscriptProjector } from '../localControl/createClaudeSessionTranscriptProjector';
import type { SessionHookData } from '../utils/startHookServer';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { adoptClaudePermissionModeFromMetadata } from '../utils/syncPermissionModeFromMetadata';
import {
  surfaceClaudeRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from '../connectedServices/surfaceClaudeRuntimeIssues';
import { createClaudeInFlightSteerCapabilityPublisher } from './createClaudeInFlightSteerCapabilityPublisher';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import { isClaudeUnifiedTerminalManagedSettingsOptionError } from './buildClaudeUnifiedTerminalSpawn';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID, DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './tuiControls';
import { ClaudeUnifiedResumeChoiceBroker } from './resumeChoice/claudeUnifiedResumeChoiceBroker';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import type {
  ClaudeUnifiedRuntimeConfigOutcomeEvent,
  ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import {
  buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
  isClaudeUnifiedRuntimeControlUserDraftBlocker,
} from './runtimeControlIntegration';
import { createUnifiedTerminalGateOffRestartNoticeTracker } from './runtimeConfigRestartNotice';
import { createClaudeUnifiedTerminalMetadataModeApplier } from './metadataRuntimeModeApplier';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { bindClaudeUnifiedTerminalSession } from './bindClaudeUnifiedTerminalSession';
import { createTerminalComposerDraftBlockedEvent } from './terminalComposerDraftBlockedEvent';
import { isClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import { isClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import {
  isClaudeUnifiedTerminalRuntimeIssueError,
  surfaceClaudeUnifiedTerminalRuntimeIssue,
} from './surfaceClaudeUnifiedTerminalRuntimeIssue';
import {
  isClaudeUnifiedTerminalAmbiguousInjectionFailureError,
  isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure,
} from './terminalInjectionFailureError';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { isTerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { runTmuxAttach } from '@/terminal/attachment/tmuxAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { extractClaudeTerminalInitialPrompt } from '../cli/terminalInitialPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { configuration } from '@/configuration';
import { delay } from '@/utils/time';
import { readClaudeActiveUnifiedTerminalHost } from '../utils/readClaudeActiveTerminalMode';

function shouldForegroundAttachTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS = 5_000;

type ParkedUnifiedTerminalMessage = Readonly<{
  message: string;
  mode: EnhancedMode;
  maxUserMessageSeq: number | null;
  userMessageLocalIds: readonly string[];
}>;

type InFlightStartupMessage = Readonly<{
  source: 'initial' | 'parked' | 'queue';
  batch: ParkedUnifiedTerminalMessage;
}>;

function areSameUserMessageLocalIds(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  const rhs = b ?? [];
  if (a.length !== rhs.length) return false;
  return a.every((value, index) => value === rhs[index]);
}

function isInvalidPromptTextInjectionFailure(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_injection_failed'
    && (error as { failureState?: unknown }).failureState === 'failed_terminal'
    && (error as { reason?: unknown }).reason === 'invalid_prompt_text'
    && (error as { phase?: unknown }).phase === 'before_write'
    && (error as { duplicateRisk?: unknown }).duplicateRisk === 'none'
    && (error as { recoverable?: unknown }).recoverable === false;
}

function startForegroundAttach(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}>): void {
  if (!shouldForegroundAttachTerminal()) return;

  if (params.terminal.mode === 'tmux') {
    void runTmuxAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
    return;
  }

  if (params.terminal.mode === 'zellij') {
    void runZellijAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
  }
}

function sendUnifiedTerminalHostDeadMessage(
  session: Session,
  params: Readonly<{ promptDeliveryWasPending: boolean }>,
): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: params.promptDeliveryWasPending
      ? 'Claude unified terminal host is not alive. The terminal process exited before Happier could send your prompt.'
      : 'Claude unified terminal host is not alive. The terminal process exited.',
  });
}

function sendUnifiedTerminalDeliveryUnknownMessage(session: Session): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: 'Claude could not confirm whether your queued message reached the terminal. Happier stopped automatic retry to avoid sending the same prompt twice; send a new message or restart the session when you are ready.',
  });
}

function isRecentClaudeUnifiedTerminalAuthFailure(params: Readonly<{
  authFailureAtMs: number | null;
  nowMs: number;
}>): boolean {
  return params.authFailureAtMs !== null
    && params.nowMs - params.authFailureAtMs >= 0
    && params.nowMs - params.authFailureAtMs <= CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS;
}

async function flushUnifiedStartupFailureSurface(session: Session, reason: string): Promise<void> {
  try {
    await session.client.flush();
  } catch (error) {
    logger.debug('[unified]: failed to flush Claude unified startup failure surface (non-fatal)', {
      reason,
      error,
    });
  }
}

function asStandaloneUnifiedMode(mode: EnhancedMode): EnhancedMode {
  return {
    ...mode,
    claudeUnifiedTerminalEnabled: true,
  };
}

function readActiveUnifiedTerminalHost(session: Session): 'tmux' | 'zellij' | null {
  return readClaudeActiveUnifiedTerminalHost({
    terminalRuntime: session.terminalRuntime,
    metadata: session.client.getMetadataSnapshot?.(),
  });
}

function applyActiveTerminalHostToStartupMode(session: Session, mode: EnhancedMode): EnhancedMode {
  const activeHost = readActiveUnifiedTerminalHost(session);
  if (!activeHost) return mode;
  if (mode.claudeUnifiedTerminalHost === activeHost) return mode;
  return {
    ...mode,
    claudeUnifiedTerminalHost: activeHost,
  };
}

function resolveCurrentRuntimeModeForActiveTerminalRuntime(session: Session, mode: EnhancedMode): EnhancedMode {
  return asStandaloneUnifiedMode(applyActiveTerminalHostToStartupMode(session, mode));
}

export async function claudeUnifiedTerminalLauncher(
  session: Session,
  opts: Readonly<{
    initialMode?: EnhancedMode | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<LauncherResult> {
  const abortController = new AbortController();
  // Standalone/local Unified gets the SAME runtime-control integration as remote Unified (gap 26).
  const tuiRuntimeControlEnabled = resolveCliFeatureDecision({
    featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
    env: process.env,
  }).state === 'enabled';
  // QA-B B6 (live 2026-06-12, session cmqawdqzj): with the gate OFF the standalone launcher had no
  // legacy restart-notice path — runtime-config changes between turns were silently dropped. The
  // daemon launcher surfaces these notices at its mode boundary; the standalone launcher observes
  // each outgoing batch mode instead (one notice per distinct change signature).
  const gateOffRestartNoticeTracker = tuiRuntimeControlEnabled
    ? null
    : createUnifiedTerminalGateOffRestartNoticeTracker({
        emit: (emission) => {
          session.client.sendSessionEvent({ type: 'message', message: emission.message });
          session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent({
            status: emission.status,
            reason: emission.reason,
            message: emission.message,
            changes: emission.changes,
          }));
        },
      });
  const normalizeStartupMode = (mode: EnhancedMode): EnhancedMode =>
    applyActiveTerminalHostToStartupMode(session, mode);
  let currentRuntimeMode: EnhancedMode | null = opts.initialMode
    ? resolveCurrentRuntimeModeForActiveTerminalRuntime(session, opts.initialMode)
    : null;
  let applyUnifiedTerminalMetadataMode: ((mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>) | null = null;
  const applyUnifiedTerminalPermissionMetadata = createClaudeUnifiedTerminalMetadataModeApplier({
    getCurrentMode: () => currentRuntimeMode,
    getApplier: () => applyUnifiedTerminalMetadataMode,
  });
  const observeOutgoingBatchMode = (mode: EnhancedMode): EnhancedMode => {
    const nextMode = normalizeStartupMode(mode);
    currentRuntimeMode = asStandaloneUnifiedMode(nextMode);
    gateOffRestartNoticeTracker?.observeBatchMode(nextMode);
    return nextMode;
  };
  let removeExternalAbortListener: (() => void) | null = null;
  if (opts.signal) {
    const abortFromExternalSignal = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(opts.signal?.reason ?? 'claude-unified-external-abort');
      }
    };
    if (opts.signal.aborted) {
      abortFromExternalSignal();
    } else {
      opts.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      removeExternalAbortListener = () => opts.signal?.removeEventListener('abort', abortFromExternalSignal);
    }
  }
  let turnInterrupt: (() => Promise<void>) | null = null;
  const initialPrompt = extractClaudeTerminalInitialPrompt(session.claudeArgs);
  let initialPromptPending = typeof initialPrompt.prompt === 'string';
  const transcriptProjector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[unified]' });
  const transcriptHookCallback = (data: SessionHookData) => {
    transcriptProjector.observeHook(data);
  };
  session.addClaudeSessionHookCallback(transcriptHookCallback);
  let lastSurfacedRuntimeAuthFailureAtMs: number | null = null;
  const readyHandler = createClaudeReadyHandler({
    session: session.client,
    pushSender: session.pushSender,
    waitingForCommandLabel: 'Claude',
    logPrefix: '[unified]',
    getPending: () => null,
    getQueueSize: () => session.queue.size(),
    accountSettings: session.accountSettings,
    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
    includeAssistantPreviewText:
      session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
  });
  const { mcpConfigJson } = await session.getOrCreateHappierMcpBridge();
  const binding = bindClaudeUnifiedTerminalSession({
    session: session.client,
    logPrefix: '[unified]',
    acceptedPromptEchoWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
    onMessage: (message) => {
      transcriptProjector.observe(message);
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
  await binding.seedPersistedPromptEchoes();

  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    void surfaceClaudeRateLimitRuntimeIssue(session, details, '[unified]')
      .catch((error) => {
        logger.debug('[unified]: failed to surface Claude rate-limit runtime issue', error);
      })
      .finally(binding.notePromptTurnTerminal);
  }

  const surfacePromptTurnTerminal = async (event: Readonly<{
    reason: string;
    source: string;
    detail?: string | undefined;
  }>): Promise<void> => {
    if (event.reason === 'aborted') {
      await binding.recordPromptTurnCancelled();
      session.abortCurrentTaskTurn();
      return;
    }
    try {
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
          logger.debug('[unified]: failed to surface Claude transcript API-error turn failure (non-fatal)', error);
          return null;
        });
      }
    } finally {
      // Any non-aborted terminal projection (hook StopFailure, process exit, unknown) must
      // terminalize the canonical turn; leaving it open keeps the server turn 'in_progress'
      // forever and permanently blocks daemon pending-queue draining (QA A-F3/C-F2).
      await binding.recordPromptTurnFailed().catch(() => undefined);
    }
  };
  const surfaceTerminalRuntimeIssue = async (error: unknown): Promise<void> => {
    if (isClaudeUnifiedTerminalAmbiguousInjectionFailureError(error)) {
      logger.debug('[unified]: Claude unified terminal prompt delivery is ambiguous; waiting for confirmation or retry');
      return;
    }
    session.onThinkingChange(false);
    const surfaced = await surfaceClaudeUnifiedTerminalRuntimeIssue({
      error,
      session: session.client,
      onSurfaceError: (surfaceError) => {
        logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
      },
    }).catch((surfaceError) => {
      logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
      return null;
    });
    if (surfaced) {
      binding.notePromptTurnTerminal();
    }
  };

  session.client.rpcHandlerManager.registerHandler('abort', async () => {
    session.noteUserAbortRequested();
    if (turnInterrupt) {
      try {
        await turnInterrupt();
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        return true;
      } catch (error) {
        logger.debug('[unified]: failed to interrupt Claude terminal turn; keeping unified host alive', error);
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        return true;
      }
    }
    logger.debug('[unified]: UI abort requested before Claude terminal turn interrupt handler was ready');
    await binding.recordPromptTurnCancelled();
    session.abortCurrentTaskTurn();
    return true;
  });

  // Lane P (O-design Seam A): publish live steer availability (+reason) to agentState.
  const inFlightSteerCapabilityPublisher = createClaudeInFlightSteerCapabilityPublisher({
    session: session.client,
    isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
  });

  // Daemon-owned pending drain (QA C-F2/A-F3, live repro cmqb329qm044z): all idle input waits go
  // through the pending-aware consumer so server-side queued rows materialize on turn-end/idle
  // wakes. A raw `session.queue` wait only ever sees UI-RPC-delivered messages and strands queued
  // pending rows until a manual "Send now".
  const sessionInputConsumer = createClaudePendingAwareInputConsumer(session, {
    onMetadataUpdate: async () => {
      const updated = adoptClaudePermissionModeFromMetadata({ session });
      if (updated) {
        await applyUnifiedTerminalPermissionMetadata(updated.intent);
      }
    },
  });
  const resumeChoiceBroker = new ClaudeUnifiedResumeChoiceBroker(session);
  // A3-HIGH-1: this launcher confirms provider acceptance (runner onPromptAcceptedByProvider),
  // so the delivered-watermark must NOT advance at queue handoff anymore.
  session.client.deferDeliveredUserMessageWatermarkToProviderAcceptance?.();
  const waitForNextSessionInputBatch = async (): Promise<ParkedUnifiedTerminalMessage | null> => {
    try {
      const batch = await sessionInputConsumer.waitForNextInput({ abortSignal: abortController.signal });
      if (!batch) return null;
      return {
        message: batch.message,
        mode: batch.mode,
        maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch.userMessageLocalIds ?? [],
      };
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        // Classified terminal-auth stop: end the wait gracefully instead of escaping
        // into the generic fatal-command-error path (incident cmq7pyqkj family).
        logger.debug('[unified]: pending-queue materialization stopped after supervisor auth failure');
        return null;
      }
      throw error;
    }
  };

  // A classified unified runtime failure (injection failure, host death) must NEVER escape as a
  // process-killing `[claude] Fatal command error` (incident cmq7pyqkj: a mid-turn steer injection
  // hit its provider-acceptance timeout, the failed_terminal error was surfaced and then RETHROWN
  // out of this launcher, and loop.ts has no retry loop around it — the runner exited and the
  // session went dead). Instead the launcher parks: it surfaces the structured runtime issue,
  // waits for the next queued message, and relaunches the unified host with that message.
  let parkedMessage: ParkedUnifiedTerminalMessage | null = null;
  let inFlightStartupMessage: InFlightStartupMessage | null = null;
  // A4-MED-3: bounded park/relaunch budget. The undeliverable-batch handback (F-1) re-pends a
  // terminally failed message, so a deterministically dying host would otherwise relaunch with
  // the SAME message forever. Any provider acceptance proves real progress and resets the budget.
  const MAX_CONSECUTIVE_PARK_RELAUNCHES = 3;
  let consecutiveParkRelaunches = 0;
  const consumeParkRelaunchBudget = (): boolean => {
    consecutiveParkRelaunches += 1;
    if (consecutiveParkRelaunches <= MAX_CONSECUTIVE_PARK_RELAUNCHES) return true;
    session.client.sendSessionEvent({
      type: 'message',
      message: `Claude unified terminal failed ${MAX_CONSECUTIVE_PARK_RELAUNCHES + 1} times in a row. Not retrying automatically — your queued message stays on the server and will be redelivered when the session restarts.`,
    });
    return false;
  };
  const parkForNextMessageAfterRuntimeIssue = async (reason: string): Promise<boolean> => {
    session.client.sendSessionEvent({
      type: 'message',
      message: 'Claude unified terminal exited unexpectedly. Waiting for the next message to retry...',
    });
    await flushUnifiedStartupFailureSurface(session, reason);
    const batch = await waitForNextSessionInputBatch();
    if (!batch) return false;
    parkedMessage = batch;
    return true;
  };
  const isInFlightStartupMessage = (input: Readonly<{
    message: string;
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>): boolean => {
    return inFlightStartupMessage !== null
      && inFlightStartupMessage.batch.message === input.message
      && inFlightStartupMessage.batch.maxUserMessageSeq === (input.maxUserMessageSeq ?? null)
      && areSameUserMessageLocalIds(inFlightStartupMessage.batch.userMessageLocalIds, input.userMessageLocalIds);
  };
  const restoreInFlightStartupMessageAfterHostStartupFailure = (): boolean => {
    if (!inFlightStartupMessage) return false;
    const inFlight = inFlightStartupMessage;
    inFlightStartupMessage = null;
    if (inFlight.source === 'initial') {
      initialPromptPending = true;
      return true;
    }
    try {
      session.queue.unshift(inFlight.batch.message, inFlight.batch.mode, {
        userMessageSeq: inFlight.batch.maxUserMessageSeq,
        userMessageLocalIds: inFlight.batch.userMessageLocalIds,
      });
    } catch (error) {
      logger.debug('[unified]: failed to requeue in-flight unified terminal startup message after startup failure', error);
    }
    return false;
  };

  const runUnifiedTerminalSessionOnce = async (): Promise<void> => {
    await runClaudeUnifiedTerminalSession({
      path: session.path,
      happySessionId: session.client.sessionId,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      claudeArgs: initialPrompt.claudeArgs,
      hookSettingsPath: session.hookSettingsPath,
      hookPluginDir: session.hookPluginDir,
      statuslineForwarder: session.claudeStatuslineForwarder ?? undefined,
      happierMcpConfigJson: mcpConfigJson,
      systemPromptText: session.defaultSystemPromptText,
      // A parked message (post-runtime-issue relaunch) must drive the relaunch mode itself,
      // so initialMode stays undefined and the parked batch becomes the first message.
      initialMode: initialPromptPending || parkedMessage || !opts.initialMode
        ? undefined
        : normalizeStartupMode(opts.initialMode),
      // C11 (incident cmq8y3nlx): binding-owned registry, seeded from the persisted prompt store,
      // so a respawned runner recognizes its predecessor's leftover composer injection as our own.
      ownComposerTexts: binding.ownComposerTexts,
      ...binding.sessionOptions,
      signal: abortController.signal,
      // A message pulled by the runner's input pump during a death/dispose unwind
      // must come back to the session queue instead of being dropped into the
      // dead host (silent queue-swallow, incident cmq8y3nlx).
      returnUnconsumedMessage: ({ message, mode, maxUserMessageSeq, userMessageLocalIds }) => {
        try {
          if (isInFlightStartupMessage({ message, maxUserMessageSeq, userMessageLocalIds })) {
            inFlightStartupMessage = null;
          }
          // Preserve watermark attribution: a re-pended batch must stay confirmable at its
          // eventual provider acceptance (A3-HIGH-1).
          session.queue.unshift(message, mode, {
            userMessageSeq: maxUserMessageSeq ?? null,
            userMessageLocalIds: userMessageLocalIds ?? [],
          });
        } catch (error) {
          logger.debug('[unified]: failed to requeue undeliverable unified terminal message', error);
        }
      },
      // A3-HIGH-1 root fix: the delivered-user-message watermark persists HERE — when the
      // provider provably accepted the batch — not when the row entered volatile memory.
      onPromptAcceptedByProvider: ({ maxUserMessageSeq, userMessageLocalIds }) => {
        consecutiveParkRelaunches = 0;
        inFlightStartupMessage = null;
        session.client.confirmUserMessageDeliveredToProvider?.(maxUserMessageSeq, {
          localIds: userMessageLocalIds,
        });
      },
      onPromptTerminallyRejectedBeforeProvider: ({ maxUserMessageSeq, userMessageLocalIds }) => {
        consecutiveParkRelaunches = 0;
        inFlightStartupMessage = null;
        session.client.confirmUserMessageDeliveredToProvider?.(maxUserMessageSeq, {
          localIds: userMessageLocalIds,
        });
      },
      registerTerminalComposerClearRuntimeControl: (clearTerminalComposer, submitTerminalComposer) =>
        session.client.registerSessionRuntimeControls?.({ clearTerminalComposer, submitTerminalComposer }) ?? (() => undefined),
      nextMessage: async () => {
        if (parkedMessage) {
          const parked = parkedMessage;
          const mode = observeOutgoingBatchMode(parked.mode);
          parkedMessage = null;
          inFlightStartupMessage = { source: 'parked', batch: { ...parked, mode } };
          binding.noteNextInjectedPromptShouldSuppressEcho();
          return {
            ...parked,
            mode,
          };
        }
        if (initialPromptPending && initialPrompt.prompt) {
          initialPromptPending = false;
          binding.noteNextInjectedPromptShouldImportEcho();
          const initialBatchMode = observeOutgoingBatchMode(opts.initialMode ?? {
            permissionMode: session.lastPermissionMode ?? 'default',
            claudeUnifiedTerminalEnabled: true,
          });
          inFlightStartupMessage = {
            source: 'initial',
            batch: {
              message: initialPrompt.prompt,
              mode: initialBatchMode,
              maxUserMessageSeq: null,
              userMessageLocalIds: [],
            },
          };
          return {
            message: initialPrompt.prompt,
            mode: initialBatchMode,
          };
        }
        initialPromptPending = false;
        const batch = await waitForNextSessionInputBatch();
        if (!batch) return null;
        const mode = observeOutgoingBatchMode(batch.mode);
        inFlightStartupMessage = {
          source: 'queue',
          batch: {
            message: batch.message,
            mode,
            maxUserMessageSeq: batch.maxUserMessageSeq,
            userMessageLocalIds: batch.userMessageLocalIds,
          },
        };
        binding.noteNextInjectedPromptShouldSuppressEcho();
        return {
          message: batch.message,
          mode,
          maxUserMessageSeq: batch.maxUserMessageSeq,
          userMessageLocalIds: batch.userMessageLocalIds,
        };
      },
      subscribeClaudeSessionHooks: (callback) => {
        session.addClaudeSessionHookCallback(callback);
        return () => {
          session.removeClaudeSessionHookCallback(callback);
        };
      },
      loadCommittedClaudeJsonlMessageBaseline: () =>
        session.client.fetchCommittedClaudeJsonlMessageBaseline?.()
        ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null },
      // Unknown canonical state (no accessor) counts as ACTIVE (fail-closed).
      isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
      isPromptDeliveryAccepted: (batch) => session.client.hasUserMessageProviderAcceptance?.({
        userMessageSeq: batch.maxUserMessageSeq ?? null,
        localIds: batch.userMessageLocalIds ?? [],
      }) === true,
      // Persist a consumed marker for controller-command echoes the runner suppresses, so they
      // join the committed baseline and cannot replay as "new" messages after a respawn
      // (resume-replay leak, 2026-06-11).
      onTranscriptMessageSuppressed: (message) => {
        session.client.recordClaudeJsonlMessageConsumed?.(message, {
          suppressedBy: 'control_command_echo',
        });
      },
      onInFlightSteerAvailabilitySnapshot: inFlightSteerCapabilityPublisher.publish,
      // Lane X (incident cmq8y3nlx): one honest notice per starvation episode instead of a silent
      // 15s retry loop — the queued message is blocked by a draft in the terminal composer.
      onInFlightSteerUserDraftStarvation: () => {
        inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
        session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('in_flight_steer'));
      },
      onDraftGuardStarvation: () => {
        inFlightSteerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
        session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'));
      },
      onSessionFound: (sessionId, data) => {
        session.onSessionFound(sessionId, data);
      },
      onThinkingChange: (thinking) => {
        session.onThinkingChange(thinking);
      },
      onUsageLimitDetails: surfaceRateLimit,
      onRuntimeAuthFailureEvent: async (error) => {
        try {
          const surfaced = await surfaceClaudeRuntimeAuthFailure(session, error, '[unified]');
          if (surfaced) {
            lastSurfacedRuntimeAuthFailureAtMs = Date.now();
          }
        } finally {
          binding.notePromptTurnTerminal();
        }
      },
      onPromptTurnTerminal: surfacePromptTurnTerminal,
      onTerminalInjectionFailure: surfaceTerminalRuntimeIssue,
      createStartupDialogResolver: ({ controlPort, startupMode }) =>
        createClaudeUnifiedResumeChoiceStartupResolver({
          choice: startupMode.claudeUnifiedTerminalResumeChoice ?? 'ask_every_time',
          broker: resumeChoiceBroker,
          port: controlPort,
          wait: delay,
          settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
        }),
      tuiRuntimeControl: {
        featureEnabled: tuiRuntimeControlEnabled,
        emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => {
          session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent(event));
        },
        // F2 (qa/QA-B.md): one honest notice per stuck-unsafe-window episode — an idle queued
        // message kept deferring because runtime controls could not be applied over a composer
        // draft/dialog on the TUI. Mirrors the daemon-resume launcher wiring.
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
        // Lane Y: feed statusline-reported effective model/effort into the controller's
        // lastVerified through the session-level statusline applier.
        registerStatuslineRuntimeReconciler: (reconcile) =>
          session.setClaudeStatuslineRuntimeReconciler(reconcile),
        registerMetadataRuntimeModeApplier: (apply) => {
          applyUnifiedTerminalMetadataMode = apply;
          void applyUnifiedTerminalPermissionMetadata.flushPending().catch((error) => {
            logger.debug('[unified]: failed to flush pending metadata runtime mode after applier registration', error);
          });
          return () => {
            if (applyUnifiedTerminalMetadataMode === apply) {
              applyUnifiedTerminalMetadataMode = null;
            }
          };
        },
      },
      onTerminalHostReady: ({ terminal }) => {
        startForegroundAttach({
          sessionId: session.client.sessionId,
          terminal,
        });
      },
    });
  };

  try {
    while (true) {
      try {
        await runUnifiedTerminalSessionOnce();
        return { type: 'exit', code: 0 };
      } catch (error) {
        if (isClaudeUnifiedTerminalHostDeadError(error)) {
          session.onThinkingChange(false);
          if (isRecentClaudeUnifiedTerminalAuthFailure({
            authFailureAtMs: lastSurfacedRuntimeAuthFailureAtMs,
            nowMs: Date.now(),
          })) {
            logger.debug('[unified]: terminal host died after Claude auth failure; keeping auth diagnostic primary');
            await flushUnifiedStartupFailureSurface(session, 'host_dead_after_auth_failure');
            binding.notePromptTurnTerminal();
            throw error;
          }
          await surfacePrimarySessionRuntimeIssue({
            provider: 'claude',
            cause: 'process_exit',
            error,
            session: session.client,
            // Host death routinely lands between turns (incident cmq8y3nlx); an
            // idle lifecycle must still surface it instead of no-opping.
            allocateTurnWhenIdle: true,
          }).catch((surfaceError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal host death (non-fatal)', surfaceError);
            return null;
          });
          sendUnifiedTerminalHostDeadMessage(session, {
            promptDeliveryWasPending: Boolean(initialPromptPending || parkedMessage || inFlightStartupMessage),
          });
          await flushUnifiedStartupFailureSurface(session, 'host_dead');
          binding.notePromptTurnTerminal();
          if (!consumeParkRelaunchBudget()) return { type: 'exit', code: 1 };
          if (await parkForNextMessageAfterRuntimeIssue('host_dead')) continue;
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalReadinessTimeoutError(error)) {
          // Startup readiness timed out on a (possibly slow) live host. Surface a structured runtime issue
          // with diagnostics, then exit gracefully (D16) instead of escalating to a generic
          // `[claude] Fatal command error` / silent dead session in the standalone startup path.
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(session, 'readiness_timeout');
          return { type: 'exit', code: 1 };
        }
        if (
          isInvalidPromptTextInjectionFailure(error)
          || isClaudeUnifiedTerminalManagedSettingsOptionError(error)
        ) {
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(
            session,
            isInvalidPromptTextInjectionFailure(error)
              ? 'invalid_prompt_text'
              : 'managed_settings_option',
          );
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure(error)) {
          session.onThinkingChange(false);
          await binding.recordPromptTurnCancelled().catch((cancelError) => {
            logger.debug('[unified]: failed to cancel Claude unified delivery-unknown turn (non-fatal)', cancelError);
          });
          sendUnifiedTerminalDeliveryUnknownMessage(session);
          await flushUnifiedStartupFailureSurface(session, 'provider_acceptance_unknown');
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRuntimeIssueError(error)) {
          // Classified injection failure: surface structured, park for the next message, relaunch.
          // Never rethrow into `[claude] Fatal command error` (incident cmq7pyqkj).
          const shouldRetryRestoredStartupMessage = isTerminalHostStartupError(error)
            && restoreInFlightStartupMessageAfterHostStartupFailure();
          await surfaceTerminalRuntimeIssue(error);
          if (!consumeParkRelaunchBudget()) return { type: 'exit', code: 1 };
          if (shouldRetryRestoredStartupMessage) continue;
          if (await parkForNextMessageAfterRuntimeIssue('injection_failure')) continue;
          return { type: 'exit', code: 1 };
        }
        throw error;
      }
    }
  } finally {
    resumeChoiceBroker.dispose();
    inFlightSteerCapabilityPublisher.dispose();
    removeExternalAbortListener?.();
    session.removeClaudeSessionHookCallback(transcriptHookCallback);
  }
}
