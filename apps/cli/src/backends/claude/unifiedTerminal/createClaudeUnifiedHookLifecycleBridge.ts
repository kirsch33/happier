import {
  createLocalTurnLifecycleController,
  type LocalTurnLifecycleController,
  type LocalTurnLifecycleEvent,
  type LocalTurnTerminalReason,
} from '@/agent/localControl/turnLifecycle';
import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';

import { createClaudeLocalLifecycleTracker } from '../localControl/claudeLocalLifecycleTracker';
import { isClaudeRuntimeAuthFailureEvidence } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeStopFailureHookToUsageDetails,
  type NormalizedProviderUsageLimitDetailsV1,
} from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import { isSidechainSessionHook } from '../utils/sessionHookAttribution';
import type { ClaudeUnifiedRuntimeAuthFailureDisposition } from './claudeUnifiedTerminalRuntimeAuthRestartError';
import type { ClaudeUnifiedInputArbiter, ClaudeUnifiedStartableDisposable } from './_types';
import { logger } from '@/ui/logger';

export type ClaudeUnifiedSessionHookSubscription = (
  callback: (data: SessionHookData) => void,
) => (() => void) | null | undefined;

export type ClaudeUnifiedHookLifecycleBridge = ClaudeUnifiedStartableDisposable & Readonly<{
  observeTranscript(message: RawJSONLines): void;
}>;

export type ClaudeUnifiedPromptTurnTerminalEvent = Readonly<{
  reason: LocalTurnTerminalReason;
  source: string;
  detail?: string | undefined;
}>;

export type ClaudeUnifiedSessionEndEvent = Readonly<{
  reason: string | null;
  source: string;
}>;

function disposeSubscription(dispose: (() => void) | null): void {
  if (!dispose) return;
  dispose();
}

function readHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

function readHookString(data: SessionHookData, key: string): string {
  const raw = data[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function readHookRequestId(data: SessionHookData): string {
  return readHookString(data, 'tool_use_id')
    || readHookString(data, 'toolUseId')
    || readHookString(data, 'request_id')
    || readHookString(data, 'requestId')
    || readHookString(data, 'id');
}

function readSystemSubtype(message: RawJSONLines): string {
  if (message.type !== 'system') return '';
  const raw = (message as Record<string, unknown>).subtype;
  return typeof raw === 'string' ? raw : '';
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSidechainTranscriptMessage(message: RawJSONLines): boolean {
  const record = message as Record<string, unknown>;
  if (record.isSidechain === true) return true;
  if (readTrimmedString(record.parent_tool_use_id).length > 0) return true;
  if (readTrimmedString(record.parentToolUseId).length > 0) return true;
  if (readTrimmedString(record.sidechainId).length > 0) return true;
  return false;
}

export function createClaudeUnifiedHookLifecycleBridge(opts: Readonly<{
  subscribeClaudeSessionHooks: ClaudeUnifiedSessionHookSubscription;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'observeLifecycle' | 'confirmPromptAcceptedByProvider' | 'drainWhenSafe'>;
  completionQuiescenceMs: number;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void | ClaudeUnifiedRuntimeAuthFailureDisposition>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  /**
   * Provider lifecycle evidence from `UserPromptSubmit` (e.g. the active permission mode). Used by the
   * runtime-control bridge to reconcile the controller's last-verified config — the strongest verification
   * rung. Optional; only the fields Claude includes on the hook are forwarded.
   */
  onProviderPromptSubmitMetadata?: ((metadata: Readonly<{
    permissionMode?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
  }>) => void) | undefined;
  onProviderSessionStarted?: (() => void) | undefined;
  onTrustedProviderProgress?: (() => void) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  onSessionEnd?: ((event: ClaudeUnifiedSessionEndEvent) => void | Promise<void>) | undefined;
}>): ClaudeUnifiedHookLifecycleBridge {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let lifecycle: LocalTurnLifecycleController | null = null;
  let tracker: ReturnType<typeof createClaudeLocalLifecycleTracker> | null = null;
  let quietDrainTimer: NodeJS.Timeout | null = null;
  let terminalSideEffects: Promise<void> = Promise.resolve();
  let anonymousPermissionBlockCount = 0;
  const pendingPermissionRequestIds = new Set<string>();

  const clearQuietDrainTimer = (): void => {
    if (!quietDrainTimer) return;
    clearTimeout(quietDrainTimer);
    quietDrainTimer = null;
  };

  const drainWhenSafe = (): void => {
    void opts.arbiter.drainWhenSafe().catch(() => undefined);
  };

  const chainTerminalSideEffect = (
    label: string,
    effect: (() => void | Promise<void | ClaudeUnifiedRuntimeAuthFailureDisposition>) | undefined,
  ): void => {
    if (!effect) return;
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await effect();
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const chainTerminalSideEffectResult = (
    label: string,
    result: void | Promise<void>,
  ): void => {
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await result;
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const waitForTerminalSideEffects = async (): Promise<void> => {
    await terminalSideEffects.catch(() => undefined);
  };

  const observeCompactionStarted = (): void => {
    clearQuietDrainTimer();
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'started' });
  };

  const observeCompactionCompleted = (): void => {
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'completed' });
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const hasPendingPermissionBlock = (): boolean => (
    anonymousPermissionBlockCount > 0 || pendingPermissionRequestIds.size > 0
  );

  const observePermissionBlocked = (data: SessionHookData): void => {
    const requestId = readHookRequestId(data);
    if (requestId) {
      pendingPermissionRequestIds.add(requestId);
    } else {
      anonymousPermissionBlockCount += 1;
    }
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: true });
  };

  const observePermissionReleased = (
    data: SessionHookData,
    optsOverride?: Readonly<{ redrain?: boolean; releaseAll?: boolean }>,
  ): void => {
    if (optsOverride?.releaseAll === true) {
      anonymousPermissionBlockCount = 0;
      pendingPermissionRequestIds.clear();
    } else {
      const requestId = readHookRequestId(data);
      if (requestId) {
        pendingPermissionRequestIds.delete(requestId);
      } else if (anonymousPermissionBlockCount > 0) {
        anonymousPermissionBlockCount -= 1;
      }
    }
    if (hasPendingPermissionBlock()) return;
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: false });
    if (optsOverride?.redrain === false) return;
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const observeStopFailureRuntimeIssue = (data: SessionHookData): void => {
    const details = mapClaudeStopFailureHookToUsageDetails(data);
    if (!details) return;
    chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(details));
  };

  const observeProviderPromptStarted = (): void => {
    if (!opts.onProviderPromptStarted) return;
    try {
      chainTerminalSideEffectResult('provider-prompt-start', opts.onProviderPromptStarted());
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal provider-prompt-start side effect', error);
    }
  };

  const observeSessionEnd = (data: SessionHookData): void => {
    if (!opts.onSessionEnd) return;
    const reason = readHookString(data, 'reason');
    try {
      void Promise.resolve(opts.onSessionEnd({
        reason: reason || null,
        source: 'claude_hook',
      })).catch((error) => {
        logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
      });
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
    }
  };

  const settleTerminalSnapshot = async (
    snapshot: Readonly<{
      terminal: boolean;
      lastTerminalReason: LocalTurnTerminalReason | null;
    }>,
    event: LocalTurnLifecycleEvent,
  ): Promise<void> => {
    if (disposed || !snapshot.terminal) return;
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'finalizing' });
    if (snapshot.lastTerminalReason === 'completed') {
      opts.onThinkingChange?.(false);
      chainTerminalSideEffect('ready', opts.onReady);
    } else {
      // A failed/aborted terminal turn must win over task-completion bookkeeping.
      // Run the terminal projection (which may abort/fail the canonical turn)
      // before clearing the thinking state; otherwise onThinkingChange(false)
      // emits task_complete first and a failed turn is recorded as completed.
      chainTerminalSideEffect('prompt-turn-terminal', () => opts.onPromptTurnTerminal?.({
        reason: snapshot.lastTerminalReason ?? 'unknown',
        source: event.source,
        ...(event.type === 'turn_terminal' && event.detail ? { detail: event.detail } : {}),
      }));
      chainTerminalSideEffect(
        'thinking-cleared',
        opts.onThinkingChange ? () => { opts.onThinkingChange?.(false); } : undefined,
      );
    }
    await waitForTerminalSideEffects();
    if (disposed) return;
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  return {
    start() {
      if (disposed || unsubscribe) return;
      lifecycle = createLocalTurnLifecycleController({
        completionQuiescenceMs: opts.completionQuiescenceMs,
        onStateChange: (snapshot, event) => {
          if (snapshot.active && !snapshot.terminal) {
            opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
            opts.onThinkingChange?.(true);
            return;
          }
          if (!snapshot.terminal) return;
          void settleTerminalSnapshot(snapshot, event);
        },
      });
      tracker = createClaudeLocalLifecycleTracker({ lifecycle });
      unsubscribe = opts.subscribeClaudeSessionHooks((data) => {
        const hookEventName = readHookEventName(data);
        // Sidechain (subagent) hooks carry an agent_id attribution. They must not
        // drive main-conversation lifecycle behavior: prompt acceptance, compaction
        // gating, turn-terminal projection, release-all permission unblocking, or
        // session end. Per-request permission accounting and account-level
        // StopFailure usage evidence remain valid from sidechains.
        const sidechain = isSidechainSessionHook(data);
        if (hookEventName === 'SessionStart') {
          if (!sidechain) opts.onProviderSessionStarted?.();
        } else if (hookEventName === 'PreCompact') {
          if (!sidechain) observeCompactionStarted();
        } else if (hookEventName === 'PostCompact') {
          if (!sidechain) observeCompactionCompleted();
        } else if (hookEventName === 'UserPromptSubmit') {
          if (!sidechain) {
            opts.onTrustedProviderProgress?.();
            observeProviderPromptStarted();
            if (opts.onProviderPromptSubmitMetadata) {
              const permissionMode = readHookString(data, 'permission_mode') || readHookString(data, 'permissionMode');
              const model = readHookString(data, 'model');
              const reasoningEffort = readHookString(data, 'reasoning_effort') || readHookString(data, 'effort');
              if (permissionMode || model || reasoningEffort) {
                opts.onProviderPromptSubmitMetadata({
                  ...(permissionMode ? { permissionMode } : {}),
                  ...(model ? { model } : {}),
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                });
              }
            }
            void opts.arbiter.confirmPromptAcceptedByProvider().catch(() => undefined);
          }
        } else if (hookEventName === 'PermissionRequest') {
          observePermissionBlocked(data);
        } else if (
          hookEventName === 'PostToolUse'
          || hookEventName === 'PermissionRequestCompleted'
        ) {
          observePermissionReleased(data);
        } else if (
          !sidechain
          && (
            hookEventName === 'Stop'
            || hookEventName === 'StopFailure'
            || hookEventName === 'SessionEnd'
          )
        ) {
          observePermissionReleased(data, { redrain: false, releaseAll: true });
        }
        if (hookEventName === 'SessionEnd' && !sidechain) {
          observeSessionEnd(data);
        }
        if (hookEventName === 'StopFailure') {
          observeStopFailureRuntimeIssue(data);
        }
        tracker?.observeHook(data);
      }) ?? null;
    },
    observeTranscript(message) {
      if (readSystemSubtype(message) === 'compact_boundary') {
        observeCompactionCompleted();
      }
      if (!isSidechainTranscriptMessage(message) && isClaudeRuntimeAuthFailureEvidence(message)) {
        chainTerminalSideEffect('runtime-auth', () => opts.onRuntimeAuthFailureEvent?.(message));
      }
      const usageLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
      if (usageLimitDetails) {
        chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(usageLimitDetails));
      }
      tracker?.observeTranscript(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearQuietDrainTimer();
      disposeSubscription(unsubscribe);
      unsubscribe = null;
      tracker = null;
      lifecycle?.dispose();
      lifecycle = null;
    },
  };
}
