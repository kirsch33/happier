import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { delayUnrefAbortable } from '@/utils/time';

import type { ClaudeUnifiedInputArbiter, ClaudeUnifiedStartableDisposable } from './_types';
import { ClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import { normalizeClaudeUnifiedHostLiveness } from './normalizeClaudeUnifiedHostLiveness';
import {
  isClaudeScreenReadyForInput,
  parseClaudeScreenState,
  type ClaudeScreenState,
} from './tuiControls/screenState';

const DEFAULT_STARTUP_READINESS_POLL_MS = 250;
const DEFAULT_STARTUP_READINESS_TIMEOUT_MS = 15_000;

const DIAGNOSTICS_MAX_TAIL_LINES = 40;
const DIAGNOSTICS_MAX_TAIL_CHARS = 2_000;

/**
 * Sanitized diagnostics captured when startup readiness times out. Attached to the timeout error so a
 * live-host startup failure surfaces with actionable context (last normalized screen tail + liveness)
 * instead of dying as a silent, generic fatal command error. The screen tail is already ANSI-stripped
 * by the shared capture parser and is bounded in size here.
 */
export type ClaudeUnifiedReadinessTimeoutDiagnostics = Readonly<{
  elapsedMs: number;
  hostAlive: boolean;
  sessionStartObserved: boolean;
  lastLivenessPaneAlive: boolean | null;
  lastScreenTail: string | null;
}>;

export class ClaudeUnifiedTerminalReadinessTimeoutError extends Error {
  readonly code = 'claude_unified_terminal_readiness_timeout';
  readonly timeoutMs: number;
  readonly handle: TerminalHostHandle;
  readonly diagnostics: ClaudeUnifiedReadinessTimeoutDiagnostics | undefined;

  constructor(params: Readonly<{
    timeoutMs: number;
    handle: TerminalHostHandle;
    diagnostics?: ClaudeUnifiedReadinessTimeoutDiagnostics | undefined;
  }>) {
    super('Claude unified terminal did not become ready before startup timeout');
    this.name = 'ClaudeUnifiedTerminalReadinessTimeoutError';
    this.timeoutMs = params.timeoutMs;
    this.handle = params.handle;
    this.diagnostics = params.diagnostics;
  }
}

export function isClaudeUnifiedTerminalReadinessTimeoutError(
  error: unknown,
): error is ClaudeUnifiedTerminalReadinessTimeoutError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_readiness_timeout';
}

function sanitizeScreenTail(text: string | null): string | null {
  if (!text) return null;
  const tail = text.split('\n').slice(-DIAGNOSTICS_MAX_TAIL_LINES).join('\n');
  return tail.length > DIAGNOSTICS_MAX_TAIL_CHARS ? tail.slice(-DIAGNOSTICS_MAX_TAIL_CHARS) : tail;
}

function isInputStateReady(
  state: Readonly<{ stable: boolean }>,
  screen: ClaudeScreenState,
): boolean {
  if (!state.stable) return false;
  return isClaudeScreenReadyForInput(screen);
}

export type ClaudeUnifiedStartupDialogResolution =
  | Readonly<{ status: 'unhandled' }>
  | Readonly<{ status: 'handled' }>
  | Readonly<{ status: 'waiting_for_user' }>;

export type ClaudeUnifiedStartupDialogResolver = (input: Readonly<{
  screenState: ClaudeScreenState;
  observedAtMs: number;
  abortSignal: AbortSignal;
}>) => Promise<ClaudeUnifiedStartupDialogResolution> | ClaudeUnifiedStartupDialogResolution;

export function createClaudeUnifiedTerminalReadinessBridge(opts: Readonly<{
  hostAdapter: Pick<TerminalHostAdapter, 'captureInputState' | 'evaluateLiveness'>;
  handle: TerminalHostHandle;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'observeLifecycle' | 'observeUserTypingState' | 'drainWhenSafe'>;
  pollIntervalMs?: number | undefined;
  quietPeriodMs?: number | undefined;
  timeoutMs?: number | undefined;
  /**
   * Hard ceiling (D17). Past the base `timeoutMs`, a host that is alive AND still progressing keeps
   * polling until this ceiling so heavy/xhigh fresh startups are not killed before the interactive
   * marker renders. Defaults to `timeoutMs` (no extension) so existing callers are unaffected.
   */
  extendedTimeoutMs?: number | undefined;
  /**
   * Static-screen grace (D17). Past the base window, a live host whose screen has been unchanged for
   * this long is considered stuck and times out (with diagnostics). Defaults to `timeoutMs`.
   */
  progressGraceMs?: number | undefined;
  emitOutputReadiness?: boolean | undefined;
  nowMs?: (() => number) | undefined;
  onStartupReady?: (() => void) | undefined;
  hasTrustedProviderProgress?: (() => boolean) | undefined;
  /**
   * Host-alive evidence independent of injection-readiness (D17), e.g. the Claude `SessionStart` hook.
   * SessionStart proves the host process is alive but NOT that the interactive composer is ready, so it
   * extends the startup window instead of standing it down.
   */
  hasHostAliveEvidence?: (() => boolean) | undefined;
  canReportStartupReady?: (() => boolean) | undefined;
  /**
   * Known startup dialogs are blocking, but some can be resolved before the normal composer appears.
   * The resolver may auto-handle the dialog or publish a user action; while it is waiting on the
   * user, startup timeout pauses without marking the screen ready for prompt injection.
   */
  resolveStartupDialog?: ClaudeUnifiedStartupDialogResolver | undefined;
}>): ClaudeUnifiedStartableDisposable {
  const pollIntervalMs = Math.max(1, Math.trunc(opts.pollIntervalMs ?? DEFAULT_STARTUP_READINESS_POLL_MS));
  const quietPeriodMs = Math.max(0, Math.trunc(opts.quietPeriodMs ?? TERMINAL_INPUT_QUIET_PERIOD_MS));
  const timeoutMs = Math.max(1, Math.trunc(opts.timeoutMs ?? DEFAULT_STARTUP_READINESS_TIMEOUT_MS));
  const extendedTimeoutMs = Math.max(timeoutMs, Math.trunc(opts.extendedTimeoutMs ?? timeoutMs));
  const progressGraceMs = Math.max(0, Math.trunc(opts.progressGraceMs ?? timeoutMs));
  const emitOutputReadiness = opts.emitOutputReadiness ?? true;
  const nowMs = opts.nowMs ?? Date.now;

  let disposed = false;
  let started = false;
  let quietDrainTimer: ReturnType<typeof setTimeout> | null = null;

  const clearQuietDrainTimer = (): void => {
    if (!quietDrainTimer) return;
    clearTimeout(quietDrainTimer);
    quietDrainTimer = null;
  };

  const scheduleQuietDrain = (): void => {
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(() => {
      void opts.arbiter.drainWhenSafe().catch(() => undefined);
    }, quietPeriodMs);
    quietDrainTimer.unref?.();
  };

  const observeReady = async (observedAtMs: number): Promise<void> => {
    opts.onStartupReady?.();
    if (!emitOutputReadiness) return;
    opts.arbiter.observeLifecycle({ type: 'output', observedAtMs });
    await opts.arbiter.drainWhenSafe();
    scheduleQuietDrain();
  };

  const pollUntilReady = async (abortSignal: AbortSignal): Promise<void> => {
    const startedAtMs = nowMs();
    let lastLivenessPaneAlive: boolean | null = null;
    let lastScreenText: string | null = null;
    let lastProgressAtMs = startedAtMs;
    let startupReadinessTimeoutPaused = false;

    const hasTrustedProviderProgress = (): boolean => opts.hasTrustedProviderProgress?.() === true;
    const hasHostAliveEvidence = (): boolean => opts.hasHostAliveEvidence?.() === true;
    const canReportStartupReady = (): boolean => opts.canReportStartupReady?.() !== false;
    const isHostAlive = (): boolean => lastLivenessPaneAlive === true || hasHostAliveEvidence();

    const recordScreenProgress = (screenText: string): void => {
      if (screenText !== lastScreenText) {
        lastScreenText = screenText;
        lastProgressAtMs = nowMs();
      }
    };

    // Adaptive timeout (D17): before the base window, never time out. After the base window but within
    // the extended ceiling, keep a LIVE host alive while its output is still progressing (heavy/xhigh
    // fresh startups render the interactive composer slowly). A host whose provider session is CONFIRMED
    // (SessionStart observed) holds through static render stalls until the hard ceiling — a heavy-resume
    // replay can pause rendering longer than the progress grace while the TUI is healthy (incident
    // pid-15592). A pane-alive-only host static past the grace, a host past the hard ceiling, or any
    // non-live host, times out.
    const isTimedOut = (): boolean => {
      const elapsed = nowMs() - startedAtMs;
      if (startupReadinessTimeoutPaused && isHostAlive()) return false;
      if (elapsed < timeoutMs) return false;
      if (elapsed >= extendedTimeoutMs) return true;
      if (!isHostAlive()) return true;
      if (hasHostAliveEvidence()) return false;
      return nowMs() - lastProgressAtMs >= progressGraceMs;
    };

    const buildTimeoutError = (): ClaudeUnifiedTerminalReadinessTimeoutError =>
      new ClaudeUnifiedTerminalReadinessTimeoutError({
        timeoutMs,
        handle: opts.handle,
        diagnostics: {
          elapsedMs: Math.max(0, nowMs() - startedAtMs),
          hostAlive: isHostAlive(),
          sessionStartObserved: hasHostAliveEvidence(),
          lastLivenessPaneAlive,
          lastScreenTail: sanitizeScreenTail(lastScreenText),
        },
      });

    const waitForNextPoll = async (): Promise<'continue' | 'stopped' | 'timeout'> => {
      if (disposed || abortSignal.aborted) return 'stopped';
      if (hasTrustedProviderProgress()) return 'stopped';
      if (isTimedOut()) return 'timeout';
      await delayUnrefAbortable(pollIntervalMs, abortSignal);
      if (disposed || abortSignal.aborted) return 'stopped';
      if (hasTrustedProviderProgress()) return 'stopped';
      return isTimedOut() ? 'timeout' : 'continue';
    };
    const continueAfterDelay = async (): Promise<boolean> => {
      const next = await waitForNextPoll();
      if (next === 'timeout') {
        if (hasTrustedProviderProgress()) return false;
        throw buildTimeoutError();
      }
      return next === 'continue';
    };
    while (!disposed && !abortSignal.aborted) {
      if (hasTrustedProviderProgress()) return;
      const observedAtMs = nowMs();
      let liveness;
      try {
        liveness = normalizeClaudeUnifiedHostLiveness(await opts.hostAdapter.evaluateLiveness(opts.handle));
      } catch {
        if (!(await continueAfterDelay())) return;
        continue;
      }
      if (disposed || abortSignal.aborted) return;
      lastLivenessPaneAlive = liveness.paneAlive;
      if (!liveness.paneAlive) {
        if (liveness.paneDead) {
          throw new ClaudeUnifiedTerminalHostDeadError(liveness);
        }
        if (!(await continueAfterDelay())) return;
        continue;
      }

      if (opts.hostAdapter.captureInputState) {
        let inputState;
        try {
          inputState = await opts.hostAdapter.captureInputState(opts.handle);
        } catch {
          if (!(await continueAfterDelay())) return;
          continue;
        }
        if (disposed || abortSignal.aborted) return;
        opts.arbiter.observeUserTypingState({
          userTyping: !inputState.stable,
          observedAtMs: inputState.observedAt,
        });
        const screenState = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
        recordScreenProgress(screenState.text);
        if (opts.resolveStartupDialog) {
          const resolution = await opts.resolveStartupDialog({
            screenState,
            observedAtMs: inputState.observedAt,
            abortSignal,
          });
          if (disposed || abortSignal.aborted) return;
          startupReadinessTimeoutPaused = resolution.status === 'waiting_for_user';
          if (resolution.status === 'handled' || resolution.status === 'waiting_for_user') {
            if (!(await continueAfterDelay())) return;
            continue;
          }
        }
        startupReadinessTimeoutPaused = false;
        if (isInputStateReady(inputState, screenState)) {
          if (canReportStartupReady()) {
            await observeReady(inputState.observedAt);
            return;
          }
          if (!(await continueAfterDelay())) return;
          continue;
        }
      } else {
        if (canReportStartupReady()) {
          await observeReady(observedAtMs);
          return;
        }
        if (!(await continueAfterDelay())) return;
        continue;
      }

      if (!(await continueAfterDelay())) return;
    }
  };

  return {
    start({ abortSignal }) {
      if (disposed || started) return;
      started = true;
      return pollUntilReady(abortSignal);
    },
    dispose() {
      disposed = true;
      clearQuietDrainTimer();
    },
  };
}
