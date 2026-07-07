import type { InFlightConfigApplyOutcome } from '@/agent/runtime/permission/bindPermissionModeQueue';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';

import type {
  ClaudeUnifiedInFlightSteerDecision,
  ClaudeUnifiedInFlightSteerEvaluator,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptBatch,
} from './_types';
import type { ClaudeUnifiedTelemetrySink } from './telemetry';
import { emitClaudeUnifiedSteerDecision } from './telemetry';
import type { ClaudeScreenState } from './tuiControls/screenState';
import {
  isClaudeScreenReadyForInput,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './tuiControls/screenState';
import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './tuiControls/composerCaptureClassification';
import type { EnhancedMode } from '../loop';
import { mapToClaudeMode } from '../utils/permissionMode';

const DEFAULT_QUEUED_BANNER_CHECK_DELAY_MS = 400;
const DEFAULT_DRAFT_CLEAR_SETTLE_MS = 250;
// One bounded escalation per starvation episode after this many consecutive `user_draft` vetoes
// (the arbiter's fallback wake retries every ~15s; 4 vetoes ≈ a minute of starvation).
const DEFAULT_USER_DRAFT_ESCALATION_THRESHOLD = 4;
// Same bounded semantics as the slash-control leftover clear (lane U): one Escape can leave the
// draft text behind, so allow a second press before giving up.
const MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS = 2;

export type ClaudeUnifiedSteerUnavailableTeeReason = 'unsafe_window' | 'user_terminal_draft';

export type ClaudeUnifiedUserDraftStarvationInfo = Readonly<{
  consecutiveVetoes: number;
  ownLeftover: boolean;
  draftLength: number;
}>;

export type ClaudeUnifiedInFlightSteerWiring<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  evaluateInFlightSteer: ClaudeUnifiedInFlightSteerEvaluator<Mode>;
  /** Arbiter callback: a steered prompt's provider-acceptance expectation armed on turn-end evidence. */
  onSteerAcceptanceArmed: (batch: ClaudeUnifiedPromptBatch<Mode>) => void;
  /**
   * Arbiter `onPromptInjected` tap: tracks the running turn's permission mode from new-turn
   * injections and schedules the queued-message banner diagnostic for in-flight steers.
   */
  observeInjectedPrompt: (batch: ClaudeUnifiedPromptBatch<Mode>, acceptance: ClaudeUnifiedPromptAcceptance) => void;
  dispose: () => void;
}>;

/**
 * In-flight steering screen policy (D19, incident cmq8171vw): decides whether a `ui_pending` prompt
 * delivered DURING a running turn may be written into the live TUI now (Claude natively queues
 * mid-generation text and submits it at turn end, probe P-D) or must keep the bounded
 * defer-until-idle path. Every decision emits a `unified.steer.decision` telemetry line so a
 * steered-or-held prompt always leaves log evidence.
 *
 * Decisions use parsed screen CONTENT (shared `tuiControls/screenState.ts` owner), not capture
 * quietness: a generating screen redraws constantly, so quiet/stable gating would permanently veto
 * legitimate steers. A mid-redraw capture that misses the generating marker fails closed into the
 * `no_interactive_composer` veto and is retried by the arbiter's bounded fallback wake.
 *
 * Permission-mode policy: a prompt whose `mode.permissionMode` differs from the mode the running
 * turn was started with is REFUSED for steering (the TUI would silently drop the mode change) and
 * keeps the deferred path; at turn end it drains as a normal new-turn prompt where the existing
 * mode-application semantics (runtime-control bridge or restart notice) own the change.
 */
export function createClaudeUnifiedInFlightSteerEvaluator<Mode extends EnhancedMode = EnhancedMode>(opts: Readonly<{
  hostAdapter: Pick<TerminalHostAdapter, 'captureInputState'>;
  handle: TerminalHostHandle;
  telemetry: ClaudeUnifiedTelemetrySink;
  /** Permission mode the session was spawned with (the first turn's mode baseline). */
  initialPermissionMode?: EnhancedMode['permissionMode'] | undefined;
  queuedBannerCheckDelayMs?: number | undefined;
  /**
   * Fired when the post-injection screen probe sees Claude's native "queued messages" banner.
   * This is terminal-custody evidence, not provider acceptance: it suppresses duplicate retries
   * while the arbiter still waits for hook/JSONL confirmation before consuming the queue head.
   */
  onPromptCustodyByTerminal?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => void | Promise<void>) | undefined;
  /**
   * Lane P (O-design Seam A): de-duplicated tee of the SESSION-level steer availability so the
   * launcher can publish it to agentState. Payload-specific refusals (permission-mode change) are
   * deliberately NOT teed — the UI computes those locally and synchronously.
   */
  onAvailabilitySnapshot?: ((snapshot: Readonly<{ available: boolean; reason: ClaudeUnifiedSteerUnavailableTeeReason | null }>) => void) | undefined;
  /**
   * Lane X (incident cmq8y3nlx): exact-match classifier over texts WE wrote into the TUI. A
   * `user_draft` veto whose composer content matches is OUR OWN leftover (e.g. partial injection
   * residue) and may be cleared; everything else is a genuine user draft and is never touched.
   */
  ownComposerTexts?: Readonly<{ matches: (draft: string) => boolean }> | undefined;
  /**
   * Sends ONE composer-clear keypress (Escape) for an own leftover draft. Only invoked on a
   * NON-generating screen (Escape interrupts a generating turn) and only for exact-match own
   * leftovers, bounded to {@link MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS} per evaluation.
   */
  clearOwnLeftoverDraft?: (() => Promise<void>) | undefined;
  draftClearSettleMs?: number | undefined;
  /** Consecutive `user_draft` vetoes before the single starvation escalation (default 4). */
  userDraftEscalationThreshold?: number | undefined;
  /**
   * Fired ONCE per starvation episode when the threshold is reached: the prompt is honestly
   * blocked on a composer draft (published as `user_terminal_draft`), not silently retried forever.
   */
  onUserDraftStarvation?: ((info: ClaudeUnifiedUserDraftStarvationInfo) => void) | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Lane Q (probe Q-A): apply a steered prompt's permission/plan mode delta to the RUNNING turn
   * (verified ShiftTab in the steer-safe generating window) so the prompt can steer instead of
   * deferring to turn end. `applied`/`scheduled_in_turn` lets the steer proceed (the backend owns
   * the mode now); anything else keeps the `permission_mode_change` veto (fail-closed).
   */
  applyPermissionModeDeltaInFlight?: ((mode: Mode) => Promise<InFlightConfigApplyOutcome>) | undefined;
}>): ClaudeUnifiedInFlightSteerWiring<Mode> {
  const queuedBannerCheckDelayMs = Math.max(0, Math.trunc(
    opts.queuedBannerCheckDelayMs ?? DEFAULT_QUEUED_BANNER_CHECK_DELAY_MS,
  ));
  const draftClearSettleMs = Math.max(0, Math.trunc(opts.draftClearSettleMs ?? DEFAULT_DRAFT_CLEAR_SETTLE_MS));
  const userDraftEscalationThreshold = Math.max(1, Math.trunc(
    opts.userDraftEscalationThreshold ?? DEFAULT_USER_DRAFT_ESCALATION_THRESHOLD,
  ));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  let disposed = false;
  let activePermissionMode: EnhancedMode['permissionMode'] | null = opts.initialPermissionMode ?? null;
  const queuedBannerTimers = new Set<ReturnType<typeof setTimeout>>();

  // Starvation episode tracking (lane X): consecutive `user_draft` vetoes across evaluations.
  let consecutiveUserDraftVetoes = 0;
  let userDraftEscalated = false;

  function resetUserDraftStarvation(): void {
    consecutiveUserDraftVetoes = 0;
    userDraftEscalated = false;
  }

  let lastSnapshotKey: string | null = null;
  function teeAvailabilitySnapshot(available: boolean, reason: ClaudeUnifiedSteerUnavailableTeeReason | null): void {
    if (!opts.onAvailabilitySnapshot) return;
    const key = `${available}:${reason ?? ''}`;
    if (key === lastSnapshotKey) return;
    lastSnapshotKey = key;
    opts.onAvailabilitySnapshot({ available, reason });
  }

  function veto(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    reason: string,
    turnLikelyEnded?: boolean,
  ): ClaudeUnifiedInFlightSteerDecision {
    if (reason !== 'user_draft') {
      resetUserDraftStarvation();
    }
    emitClaudeUnifiedSteerDecision(opts.telemetry, {
      decision: 'vetoed',
      reason,
      originKind: batch.origin.kind,
    });
    if (reason !== 'permission_mode_change') {
      // Session-level unavailability (screen veto / capture failure); payload refusals are skipped.
      // An escalated draft starvation keeps its honest published reason instead of downgrading.
      teeAvailabilitySnapshot(false, reason === 'user_draft' && userDraftEscalated ? 'user_terminal_draft' : 'unsafe_window');
    }
    return turnLikelyEnded === undefined
      ? { steer: false, reason }
      : { steer: false, reason, turnLikelyEnded };
  }

  /**
   * `user_draft` veto handling (lane X, incident cmq8y3nlx): the evaluator must never silently
   * starve a steered prompt behind a composer draft forever.
   *
   * - An OWN leftover (exact match against texts we wrote) on a NON-generating screen is cleared
   *   with the same bounded-Escape semantics as the slash-control leftover clear (lane U); a
   *   genuine user draft is NEVER touched, and nothing is cleared while generating (Escape would
   *   interrupt the running turn).
   * - A persisting draft escalates ONCE per episode after the bounded veto threshold: the honest
   *   `user_terminal_draft` reason is teed to the capability publisher (UI pending honesty) and
   *   the one-shot starvation callback fires (single user-visible notification, never a loop).
   */
  async function handleUserDraftVeto(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    screen: ClaudeScreenState,
    rawText: string,
  ): Promise<ClaudeUnifiedInFlightSteerDecision | null> {
    const captureInputState = opts.hostAdapter.captureInputState;
    let current = screen;
    let currentRawText = rawText;
    let ownLeftover = (current.composerContent ?? '').length > 0
      && opts.ownComposerTexts?.matches(current.composerContent ?? '') === true;
    if (!ownLeftover && isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(currentRawText, current)) {
      const draftLength = (current.composerContent ?? '').length;
      emitClaudeUnifiedSteerDecision(opts.telemetry, {
        decision: 'vetoed',
        reason: 'capture_style_unavailable',
        originKind: batch.origin.kind,
        draftLength,
        ownDraft: false,
      });
      teeAvailabilitySnapshot(false, 'unsafe_window');
      return { steer: false, reason: 'capture_style_unavailable' };
    }

    if (ownLeftover && opts.clearOwnLeftoverDraft && captureInputState && !current.generating) {
      for (let attempt = 0; attempt < MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS; attempt += 1) {
        try {
          await opts.clearOwnLeftoverDraft();
        } catch {
          break;
        }
        await wait(draftClearSettleMs);
        let recaptured: Awaited<ReturnType<NonNullable<typeof captureInputState>>>;
        try {
          recaptured = await captureInputState(opts.handle);
        } catch {
          break;
        }
        currentRawText = recaptured.currentInput;
        current = parseClaudeScreenState(recaptured.currentInput, { cursor: recaptured.cursor });
        emitClaudeUnifiedSteerDecision(opts.telemetry, {
          decision: 'own_draft_clear_attempted',
          reason: 'user_draft',
          originKind: batch.origin.kind,
          draftLength: (current.composerContent ?? '').length,
        });
        if (resolveClaudeScreenInFlightSteerVeto(current) !== 'user_draft') {
          // Draft gone (or screen changed): re-evaluate the fresh screen through the normal flow.
          resetUserDraftStarvation();
          return null;
        }
        ownLeftover = opts.ownComposerTexts?.matches(current.composerContent ?? '') === true;
        if (!ownLeftover && isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(currentRawText, current)) {
          const draftLength = (current.composerContent ?? '').length;
          emitClaudeUnifiedSteerDecision(opts.telemetry, {
            decision: 'vetoed',
            reason: 'capture_style_unavailable',
            originKind: batch.origin.kind,
            draftLength,
            ownDraft: false,
          });
          teeAvailabilitySnapshot(false, 'unsafe_window');
          return { steer: false, reason: 'capture_style_unavailable' };
        }
        if (!ownLeftover) break;
      }
    }

    const draftLength = (current.composerContent ?? '').length;
    consecutiveUserDraftVetoes += 1;
    const escalateNow = consecutiveUserDraftVetoes >= userDraftEscalationThreshold && !userDraftEscalated;
    if (escalateNow) {
      userDraftEscalated = true;
      emitClaudeUnifiedSteerDecision(opts.telemetry, {
        decision: 'starvation_escalated',
        reason: 'user_draft',
        originKind: batch.origin.kind,
        draftLength,
        ownDraft: ownLeftover,
        consecutiveVetoes: consecutiveUserDraftVetoes,
      });
      opts.onUserDraftStarvation?.({
        consecutiveVetoes: consecutiveUserDraftVetoes,
        ownLeftover,
        draftLength,
      });
    }
    emitClaudeUnifiedSteerDecision(opts.telemetry, {
      decision: 'vetoed',
      reason: 'user_draft',
      originKind: batch.origin.kind,
      draftLength,
      ownDraft: ownLeftover,
    });
    teeAvailabilitySnapshot(false, userDraftEscalated ? 'user_terminal_draft' : 'unsafe_window');
    return { steer: false, reason: 'user_draft' };
  }

  return {
    async evaluateInFlightSteer(batch) {
      const captureInputState = opts.hostAdapter.captureInputState;
      const requestedPermissionMode = batch.mode?.permissionMode;
      if (
        requestedPermissionMode !== undefined
        && activePermissionMode !== null
        // Incident 2026-06-12 (session cmq7pyqkj): compare Claude-EFFECTIVE modes, not raw Happier
        // aliases. The UI sends 'yolo' while daemon spawns normalize to 'bypassPermissions'; an
        // alias-only difference is not a mode change and must not starve the steer for a whole turn.
        && mapToClaudeMode(requestedPermissionMode) !== mapToClaudeMode(activePermissionMode)
      ) {
        // Lane Q: when the runtime-control bridge can own the mode change DURING the turn
        // (verified ShiftTab in the probe-proven steer-safe window), apply it first and let the
        // text steer. Any non-owned outcome falls back to the refusal below (fail-closed).
        let modeAppliedInFlight = false;
        const applyModeDelta = opts.applyPermissionModeDeltaInFlight;
        if (applyModeDelta && batch.mode !== undefined) {
          let outcome: InFlightConfigApplyOutcome;
          try {
            outcome = await applyModeDelta(batch.mode);
          } catch {
            outcome = { status: 'failed', reason: 'apply_hook_threw' };
          }
          if (outcome.status === 'applied' || outcome.status === 'scheduled_in_turn') {
            activePermissionMode = requestedPermissionMode;
            modeAppliedInFlight = true;
          }
        }
        if (!modeAppliedInFlight) {
          // Refused for steering by design — but still capture turn-end screen evidence (L1,
          // incident cmq7pyqkj): a stale 'running' turn with an idle composer must let the
          // arbiter's stale-turn recovery drain this prompt instead of starving it forever.
          if (captureInputState) {
            try {
              const inputState = await captureInputState(opts.handle);
              const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
              if (isClaudeScreenReadyForInput(screen)) {
                return veto(batch, 'permission_mode_change', true);
              }
            } catch {
              // Screen evidence unavailable; fall through to the plain refusal.
            }
          }
          return veto(batch, 'permission_mode_change');
        }
      }
      if (!captureInputState) {
        return veto(batch, 'screen_capture_unavailable');
      }
      // Two passes at most: a successful own-leftover clear (lane X) re-evaluates the fresh screen.
      for (let pass = 0; pass < 2; pass += 1) {
        let inputState: Awaited<ReturnType<NonNullable<typeof captureInputState>>>;
        try {
          inputState = await captureInputState(opts.handle);
        } catch {
          return veto(batch, 'screen_capture_failed');
        }
        const screenText = inputState.currentInput;
        const screen = parseClaudeScreenState(screenText, { cursor: inputState.cursor });
        const vetoReason = resolveClaudeScreenInFlightSteerVeto(screen);
        if (vetoReason === 'user_draft') {
          const decision = await handleUserDraftVeto(batch, screen, screenText);
          if (decision !== null) return decision;
          continue;
        }
        if (vetoReason !== null) {
          return veto(batch, vetoReason);
        }
        resetUserDraftStarvation();
        emitClaudeUnifiedSteerDecision(opts.telemetry, {
          decision: 'safe',
          originKind: batch.origin.kind,
          queuedBannerVisible: screen.queuedMessageBannerVisible,
        });
        teeAvailabilitySnapshot(true, null);
        // An idle interactive composer is trusted turn-end evidence (D19b makes it a SAFE steer
        // surface): the arbiter's lost-hook fallback uses it to arm a prior steer's acceptance.
        return isClaudeScreenReadyForInput(screen) ? { steer: true, turnLikelyEnded: true } : { steer: true };
      }
      return veto(batch, 'user_draft');
    },

    onSteerAcceptanceArmed(batch) {
      emitClaudeUnifiedSteerDecision(opts.telemetry, {
        decision: 'acceptance_armed',
        originKind: batch.origin.kind,
      });
    },

    observeInjectedPrompt(batch, acceptance) {
      if (acceptance.acceptedAs === 'new_turn') {
        const permissionMode = batch.mode?.permissionMode;
        if (permissionMode !== undefined) {
          activePermissionMode = permissionMode;
        }
        return;
      }
      if (disposed) return;
      const captureInputState = opts.hostAdapter.captureInputState;
      if (!captureInputState) return;
      // Shortly after a steer write, the TUI should show the "Press up to edit queued messages"
      // banner. That is terminal-custody evidence: it is strong enough to stop duplicate retries
      // and let the arbiter inject later prompts, but not enough to mark provider acceptance.
      const timer = setTimeout(() => {
        queuedBannerTimers.delete(timer);
        void (async () => {
          if (disposed) return;
          try {
            const inputState = await captureInputState(opts.handle);
            const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
            emitClaudeUnifiedSteerDecision(opts.telemetry, {
              decision: 'queued_banner_check',
              originKind: batch.origin.kind,
              queuedBannerVisible: screen.queuedMessageBannerVisible,
              composerDraftPresent: screen.userDraftPresent,
            });
            if (screen.queuedMessageBannerVisible && !screen.userDraftPresent) {
              await opts.onPromptCustodyByTerminal?.(batch);
            }
          } catch {
            // Screen evidence unavailable; keep the existing provider-confirmation path.
          }
        })();
      }, queuedBannerCheckDelayMs);
      timer.unref?.();
      queuedBannerTimers.add(timer);
    },

    dispose() {
      disposed = true;
      for (const timer of queuedBannerTimers) {
        clearTimeout(timer);
      }
      queuedBannerTimers.clear();
    },
  };
}
