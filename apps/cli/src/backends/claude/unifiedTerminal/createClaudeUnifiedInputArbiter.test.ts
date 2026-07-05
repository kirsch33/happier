import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveTerminalPromptProviderAcceptanceTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import type { ClaudeUnifiedInputArbiter } from './_types';

type ClaudeUnifiedCompactionLifecycleObservation = Readonly<{
  type: 'compaction';
  phase: 'started' | 'completed';
  observedAtMs?: number;
}>;

function observeCompaction(
  arbiter: ClaudeUnifiedInputArbiter,
  observation: ClaudeUnifiedCompactionLifecycleObservation,
): void {
  arbiter.observeLifecycle(observation as Parameters<ClaudeUnifiedInputArbiter['observeLifecycle']>[0]);
}

describe('createClaudeUnifiedInputArbiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects queued prompts in FIFO order when idle', async () => {
    let nowMs = 10_000;
    const injected: string[] = [];
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'first', origin: { kind: 'ui_pending' } });
    await arbiter.enqueueUiMessage({ message: 'second', origin: { kind: 'ui_pending' } });
    await arbiter.drainWhenSafe();
    expect(injected).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 2, lastDeferredReason: 'pane_initializing' });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first']);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, headInputState: 'submitted' });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first', 'second']);
    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first', 'second']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, headInputState: 'submitted' });
  });

  it('defers pending-queue prompts while Claude is running and injects them after the turn becomes idle', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const accepted: Array<readonly [string, string]> = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt,
      onPromptAccepted: async (batch, acceptance) => {
        accepted.push([batch.message, acceptance.acceptedAs]);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: 'terminal_busy',
      headInputState: 'waiting_for_readiness',
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual([['hello', 'new_turn']]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastDeferredReason: null });
  });

  it('scales provider acceptance timeout for large injected prompts before retrying', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const message = 'x'.repeat(128_000);
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: nowMs, bytesWritten: 128_000 });
    const failures: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 10,
      injectPrompt,
      onInjectionFailure: (failure) => failures.push(failure.failureState),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message, origin: { kind: 'ui_pending' } });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(failures).toEqual([]);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    const scaledTimeoutMs = resolveTerminalPromptProviderAcceptanceTimeoutMs(message, {
      baseTimeoutMs: 10,
      bytesWritten: 128_000,
    });
    await vi.advanceTimersByTimeAsync(scaledTimeoutMs + 1);

    expect(failures).toEqual(['failed_ambiguous']);
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('injects explicit immediate prompts while Claude is running when the input surface is quiet', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const accepted: Array<readonly [string, string]> = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt,
      onPromptAccepted: async (batch, acceptance) => {
        accepted.push([batch.message, acceptance.acceptedAs]);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_immediate' } });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual([['hello', 'in_flight_steer']]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastDeferredReason: null });
  });

  it('treats a steered prompt queued by the terminal as provider custody without retrying or handback', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const batch = { message: 'queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: nowMs, bytesWritten: batch.message.length });
    const failures: string[] = [];
    const accepted: string[] = [];
    const handedBack: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 10,
      injectPrompt,
      evaluateInFlightSteer: async () => ({ steer: true }),
      onInjectionFailure: (failure) => failures.push(failure.failureState),
      onPromptAccepted: async (acceptedBatch) => {
        accepted.push(acceptedBatch.message);
      },
      onUndeliverableBatches: (batches) => handedBack.push(...batches.map((item) => item.message)),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(batch);
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    const custodyObserved = await arbiter.observePromptCustodyByTerminal(batch);
    expect(custodyObserved).toBe(true);

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    await vi.advanceTimersByTimeAsync(5);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, headInputState: 'submitted' });

    arbiter.dispose();
    expect(handedBack).toEqual([]);
  });

  it('terminalizes a terminal-custody prompt when provider acceptance is lost after turn end', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const batch = { message: 'queued in Claude TUI without acceptance proof', origin: { kind: 'ui_pending' as const } };
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: nowMs, bytesWritten: batch.message.length });
    const onInjectionFailure = vi.fn();
    const accepted: string[] = [];
    const handedBack: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 10,
      injectPrompt,
      evaluateInFlightSteer: async () => ({ steer: true }),
      onInjectionFailure,
      onPromptAccepted: async (acceptedBatch) => {
        accepted.push(acceptedBatch.message);
      },
      onUndeliverableBatches: (batches) => handedBack.push(...batches.map((item) => item.message)),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(batch);
    nowMs += 1_000;
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(batch)).resolves.toBe(true);

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    await vi.advanceTimersByTimeAsync(10);

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
      batch,
      result: expect.objectContaining({
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
      }),
    }));
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      lastFailureReason: 'timeout',
      headInputState: 'failed_terminal',
    });

    arbiter.dispose();
    expect(handedBack).toEqual([]);
  });

  it('continues injecting later prompts while earlier steered prompts wait in Claude terminal custody', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const first = { message: 'first queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const second = { message: 'second queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const injected: string[] = [];
    const accepted: string[] = [];
    const handedBack: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 10,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
      evaluateInFlightSteer: async () => ({ steer: true }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onUndeliverableBatches: (batches) => handedBack.push(...batches.map((item) => item.message)),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first queued in Claude TUI']);
    await expect(arbiter.observePromptCustodyByTerminal(first)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await arbiter.enqueueUiMessage(second);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first queued in Claude TUI', 'second queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.observePromptCustodyByTerminal(second)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 2,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    await vi.advanceTimersByTimeAsync(5);

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['first queued in Claude TUI', 'second queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });

    arbiter.dispose();
    expect(handedBack).toEqual([]);
  });

  it('does not arm a later terminal-custody timeout when an earlier custody prompt is accepted during a running turn', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const first = { message: 'first queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const second = { message: 'second queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const injected: string[] = [];
    const accepted: string[] = [];
    const failures: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 10,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
      evaluateInFlightSteer: async () => ({ steer: true }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure: (failure) => {
        failures.push(failure.batch.message);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(first)).resolves.toBe(true);

    await arbiter.enqueueUiMessage(second);
    nowMs += 1_000;
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(second)).resolves.toBe(true);

    expect(injected).toEqual(['first queued in Claude TUI', 'second queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      terminalCustodyCount: 2,
      providerAcceptancePendingCount: 2,
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(failures).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
    });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    await vi.advanceTimersByTimeAsync(20);
    expect(failures).toEqual(['second queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'failed_terminal',
    });
  });

  it('keeps a later injected prompt awaiting acceptance when an earlier terminal-custody prompt is confirmed first', async () => {
    let nowMs = 10_000;
    const first = { message: 'first queued in Claude TUI', origin: { kind: 'ui_pending' as const } };
    const second = { message: 'second pending provider acceptance', origin: { kind: 'ui_pending' as const } };
    const injected: string[] = [];
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
      evaluateInFlightSteer: async () => ({ steer: true }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(first)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await arbiter.enqueueUiMessage(second);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first queued in Claude TUI', 'second pending provider acceptance']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['first queued in Claude TUI']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first queued in Claude TUI', 'second pending provider acceptance']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });
  });

  it('does not hand back a steered prompt with terminal custody when the arbiter is disposed before provider confirmation', async () => {
    let nowMs = 10_000;
    const batch = { message: 'already queued in terminal', origin: { kind: 'ui_pending' as const } };
    const handedBack: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt: async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }),
      evaluateInFlightSteer: async () => ({ steer: true }),
      onUndeliverableBatches: (batches) => handedBack.push(...batches.map((item) => item.message)),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage(batch);
    nowMs += 1_000;
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(batch);

    arbiter.dispose();

    expect(handedBack).toEqual([]);
  });

  it('defers queued prompts while permission is blocked', async () => {
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({ injectPrompt });

    arbiter.observeLifecycle({ type: 'permission', blocked: true, observedAtMs: 0 });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'permission_blocked' });
  });

  it('defers queued prompts while the terminal user is typing', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({ nowMs: () => nowMs, injectPrompt });

    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    nowMs += 1;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });
  });

  it('wakes a user-typing deferred prompt immediately after the terminal composer is cleared', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockImplementation(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      maxWaitMs: 60_000,
      injectPrompt,
    });

    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'deliver after clear', origin: { kind: 'ui_pending' } });
    nowMs += 1;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: 'user_typing',
      headInputState: 'waiting_for_readiness',
    });

    arbiter.notifyTerminalComposerCleared();
    await vi.advanceTimersByTimeAsync(0);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'deliver after clear' }),
      undefined,
    );
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    arbiter.dispose();
  });

  it('retries and injects after a stale user-typing startup observation expires', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockImplementation(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      maxWaitMs: 1_000,
      injectPrompt,
    });

    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'first prompt', origin: { kind: 'ui_pending' } });
    nowMs += 100;
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });

    nowMs += 900;
    await vi.advanceTimersByTimeAsync(900);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('redrains queued prompts after the quiet-window retry delay', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockImplementation(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 100,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'pane_initializing' });

    nowMs += 100;
    await vi.advanceTimersByTimeAsync(100);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('redrains queued prompts after an adapter deferral retry delay', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi
      .fn()
      .mockResolvedValueOnce({ status: 'deferred' as const, reason: 'user_typing' as const, retryAfterMs: 75 })
      .mockImplementationOnce(async (batch) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });

    nowMs += 75;
    await vi.advanceTimersByTimeAsync(75);

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });


  it('fails closed when the terminal host reports a dead pane', async () => {
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'pane_dead',
        phase: 'liveness',
        duplicateRisk: 'none',
        recoverable: false,
      }),
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'pane_dead',
      headInputState: 'failed_terminal',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
      batch: expect.objectContaining({ message: 'hello' }),
      result: expect.objectContaining({ reason: 'pane_dead' }),
    }));
  });

  it('terminalizes deterministic invalid prompt text without handing it back as undeliverable', async () => {
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const onUndeliverableBatches = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
      }),
      onInjectionFailure,
      onUndeliverableBatches,
    });

    await arbiter.enqueueUiMessage({
      message: 'bad\u0000prompt',
      mode: { permissionMode: 'default' },
      origin: { kind: 'ui_pending' },
    });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: 'invalid_prompt_text',
      headInputState: null,
    });
    expect(onInjectionFailure).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
      batch: expect.objectContaining({ message: 'bad\u0000prompt' }),
      result: expect.objectContaining({
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
      }),
    }));

    arbiter.dispose();

    expect(onUndeliverableBatches).not.toHaveBeenCalled();
  });

  it('drains a later valid prompt after an invalid prompt text rejection', async () => {
    let nowMs = 10_000;
    const injected: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async (batch) => {
        if (batch.message.includes('\u0000')) {
          return {
            status: 'failed',
            reason: 'invalid_prompt_text',
            phase: 'before_write',
            duplicateRisk: 'none',
            recoverable: false,
          };
        }
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
    });

    await arbiter.enqueueUiMessage({ message: 'bad\u0000prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    await arbiter.enqueueUiMessage({ message: 'valid prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['valid prompt']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('accepts the current queued prompt when Claude later confirms a recoverable terminal write', async () => {
    let nowMs = 10_000;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'timeout',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
      }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'large prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastFailureReason: 'timeout' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['large prompt']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastFailureReason: null });
  });

  it('retries safe recoverable injection failures instead of waiting for provider confirmation', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed' as const,
        reason: 'host_unreachable' as const,
        phase: 'before_write' as const,
        duplicateRisk: 'none' as const,
        recoverable: true,
      })
      .mockImplementationOnce(async (batch) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectionRetryLimit: 1,
      injectionRetryBaseDelayMs: 25,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'large prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'host_unreachable',
      headInputState: 'failed_retryable',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(false);

    nowMs += 25;
    await vi.advanceTimersByTimeAsync(25);

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastFailureReason: null, headInputState: 'awaiting_provider_acceptance' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['large prompt']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastFailureReason: null, headInputState: 'submitted' });
  });

  it('marks ambiguous injection failures failed when provider confirmation never arrives', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'timeout',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
      }),
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'ambiguous prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'awaiting_provider_acceptance',
    });

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'ambiguous prompt' }),
      result: expect.objectContaining({ reason: 'timeout' }),
    }));
  });

  it('accepts late provider confirmation after an ambiguous timeout without retrying the prompt', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'late confirmed prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'late confirmed prompt' }),
    }));

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual(['late confirmed prompt']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: null,
      headInputState: 'submitted',
    });
  });

  it('does not retry an ambiguous prompt that core delivery state already accepted', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    let deliveryAccepted = false;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      isPromptDeliveryAccepted: () => deliveryAccepted,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({
      message: 'prompt accepted by transcript before retry',
      origin: { kind: 'ui_pending' },
      maxUserMessageSeq: 739,
      userMessageLocalIds: ['prompt-739'],
    });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    deliveryAccepted = true;
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(0);
    await arbiter.drainWhenSafe();

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'prompt accepted by transcript before retry' }),
    }));
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual(['prompt accepted by transcript before retry']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: null,
      headInputState: 'submitted',
    });
  });

  it('retries a host-level injected prompt once after provider confirmation never arrives', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt typed but not submitted', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'prompt typed but not submitted' }),
      result: expect.objectContaining({
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
      }),
    }));
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('self-drives a retry after provider confirmation timeout without waiting for another lifecycle event', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch) => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt retries itself', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();
    expect(injectPrompt).toHaveBeenCalledTimes(1);

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersToNextTimerAsync();
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('submits an owned composer draft after an ambiguous provider timeout before retrying paste', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const injectedNotifications: string[] = [];
    const injectPrompt = vi.fn(async (batch) => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }));
    const submitOwnedAmbiguousPromptDraft = vi.fn(async () => ({ status: 'submitted' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      submitOwnedAmbiguousPromptDraft,
      onPromptInjected: async (batch) => {
        injectedNotifications.push(batch.message);
      },
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'owned draft stuck in Claude composer', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(submitOwnedAmbiguousPromptDraft).not.toHaveBeenCalled();

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersToNextTimerAsync();

    expect(submitOwnedAmbiguousPromptDraft).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(injectedNotifications).toEqual(['owned draft stuck in Claude composer']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['owned draft stuck in Claude composer']);
  });

  it('terminalizes a host-level injected prompt when provider confirmation never arrives after retry', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt never accepted', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();
    expect(injectPrompt).toHaveBeenCalledTimes(2);

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_terminal',
    });
    expect(onInjectionFailure).toHaveBeenLastCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
      batch: expect.objectContaining({ message: 'prompt never accepted' }),
      result: expect.objectContaining({
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
      }),
    }));
  });

  it('keeps a terminal-injected UI prompt retryable when compaction starts before provider acceptance', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt interrupted by compaction', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    observeCompaction(arbiter, { type: 'compaction', phase: 'started', observedAtMs: nowMs });
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
    });
    expect(arbiter.snapshot().headInputState).not.toBe('failed_ambiguous');

    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(injectPrompt.mock.calls.map(([batch]) => batch.message)).toEqual([
      'prompt interrupted by compaction',
      'prompt interrupted by compaction',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('accepts a terminal-injected UI prompt when a matching transcript echo appears after compaction', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt echoed after compaction', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    observeCompaction(arbiter, { type: 'compaction', phase: 'started', observedAtMs: nowMs });
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    await arbiter.drainWhenSafe();

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual(['prompt echoed after compaction']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: null,
      headInputState: 'submitted',
    });
  });

  it('keeps an ambiguous timeout retryable when compaction completion is observed later', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt compacted without precompact hook', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });

    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(injectPrompt.mock.calls.map(([batch]) => batch.message)).toEqual([
      'prompt compacted without precompact hook',
      'prompt compacted without precompact hook',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('does not re-inject a pending /compact prompt when compaction completes before the transcript boundary', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: '/compact', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    // PostCompact hook completes compaction before the compact_boundary transcript
    // row confirms acceptance. The /compact prompt must be consumed, not re-injected.
    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual(['/compact']);
    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: null,
      headInputState: 'submitted',
    });
  });

  it('notifies a successful injection at most once when an ambiguous prompt is retried', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectedNotifications: string[] = [];
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptInjected: (batch) => {
        injectedNotifications.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'retry me', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(injectedNotifications).toEqual(['retry me']);

    // Provider acceptance never arrives → failed_ambiguous → self-driven retry.
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(0);
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    // The retry re-injects the same batch but must not re-fire the injection
    // notification, which would suppress a later identical terminal-typed prompt.
    expect(injectedNotifications).toEqual(['retry me']);

    arbiter.dispose();
  });

  it('wakes a pending prompt deferred during a running turn via a bounded fallback timer', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
      busyTurnFallbackWakeMs: 50,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ lastDeferredReason: 'terminal_busy' });

    // Fallback wake fires while still running → re-defers (no mid-turn injection).
    await vi.advanceTimersByTimeAsync(50);
    expect(injectPrompt).not.toHaveBeenCalled();

    // The turn ends but no hook-driven redrain is delivered; the bounded fallback
    // wake must re-evaluate and inject so the prompt cannot starve.
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    await vi.advanceTimersByTimeAsync(50);
    expect(injectPrompt).toHaveBeenCalledTimes(1);

    arbiter.dispose();
  });

  it('defers an explicit immediate prompt while the terminal user is typing a draft', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({ nowMs: () => nowMs, injectPrompt });

    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'do not merge with my draft', origin: { kind: 'ui_immediate' } });
    await arbiter.drainWhenSafe();

    // A visible user draft must veto injection across origins so injected text is
    // never merged into the composer.
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: 'user_typing',
      headInputState: 'waiting_for_readiness',
    });

    arbiter.dispose();
  });

  describe('in-flight steering (incident cmq8171vw, D19/D20)', () => {
    it('injects a pending UI prompt mid-turn as an in-flight steer when the screen evaluation is safe', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const accepted: Array<readonly [string, string]> = [];
      const armed: string[] = [];
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        injectPrompt,
        evaluateInFlightSteer,
        onSteerAcceptanceArmed: (batch) => {
          armed.push(batch.message);
        },
        onPromptAccepted: async (batch, acceptance) => {
          accepted.push([batch.message, acceptance.acceptedAs]);
        },
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'steer me', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      // The incident regression: the prompt reaches the TUI mid-turn instead of
      // being deferred (terminal_busy) until turn end.
      expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'steer me' }),
        { inFlightSteer: true },
      );
      expect(arbiter.snapshot()).toMatchObject({
        lastDeferredReason: null,
        headInputState: 'awaiting_provider_acceptance',
      });

      // Provider acceptance arrives only at turn end: the short acceptance
      // timeout must NOT fire while the steered turn is still running.
      nowMs += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(arbiter.snapshot()).toMatchObject({
        lastFailureReason: null,
        headInputState: 'awaiting_provider_acceptance',
      });
      expect(armed).toEqual([]);

      // Turn-end evidence arms the acceptance expectation; UserPromptSubmit then
      // confirms the queued prompt as an in-flight steer.
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      expect(armed).toEqual(['steer me']);
      await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
      expect(accepted).toEqual([['steer me', 'in_flight_steer']]);
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, headInputState: 'submitted' });

      arbiter.dispose();
    });

    it('keeps the bounded deferred path when the steer evaluation vetoes the screen', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'permission_prompt',
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        injectPrompt,
        evaluateInFlightSteer,
        busyTurnFallbackWakeMs: 50,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'hold me', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      expect(injectPrompt).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({
        queuedCount: 1,
        lastDeferredReason: 'terminal_busy',
        headInputState: 'waiting_for_readiness',
      });

      // Fallback wake re-evaluates while still vetoed → re-defers.
      nowMs += 50;
      await vi.advanceTimersByTimeAsync(50);
      expect(injectPrompt).not.toHaveBeenCalled();

      // Turn end → normal new-turn injection (fallback wake unchanged for vetoed states).
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      nowMs += 50;
      await vi.advanceTimersByTimeAsync(50);
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(expect.objectContaining({ message: 'hold me' }), undefined);

      arbiter.dispose();
    });

    it('keeps side-effecting Happier slash commands deferred until idle', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        injectPrompt,
        evaluateInFlightSteer,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: '/clear', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      // Special commands keep the current defer-until-idle behavior.
      expect(evaluateInFlightSteer).not.toHaveBeenCalled();
      expect(injectPrompt).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({
        queuedCount: 1,
        lastDeferredReason: 'terminal_busy',
        headInputState: 'waiting_for_readiness',
      });

      arbiter.dispose();
    });

    it('allows non-side-effecting Claude slash commands to enter native in-flight custody', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        injectPrompt,
        evaluateInFlightSteer,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: '/model', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ message: '/model' }),
        { inFlightSteer: true },
      );

      arbiter.dispose();
    });

    it('recovers through failed_ambiguous when an armed steer acceptance never arrives', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const injectedNotifications: string[] = [];
      const onInjectionFailure = vi.fn();
      const injectPrompt = vi.fn(async (
        batch: { message: string },
        _options?: { inFlightSteer?: boolean | undefined } | undefined,
      ) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        injectPrompt,
        evaluateInFlightSteer: async () => ({ steer: true as const }),
        onPromptInjected: (batch) => {
          injectedNotifications.push(batch.message);
        },
        onInjectionFailure,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'lost steer', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledTimes(1);

      // Turn ends, acceptance armed, but never confirmed → failed_ambiguous.
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      nowMs += 40;
      await vi.advanceTimersByTimeAsync(40);
      expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        failureState: 'failed_ambiguous',
        batch: expect.objectContaining({ message: 'lost steer' }),
      }));

      // The existing single retry recovers it without re-firing onPromptInjected
      // (single-fire echo bookkeeping preserved — no F-10 regression).
      await vi.advanceTimersByTimeAsync(0);
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledTimes(2);
      expect(injectPrompt.mock.calls[1]?.[1]).toBeUndefined();
      expect(injectedNotifications).toEqual(['lost steer']);
      expect(arbiter.snapshot()).toMatchObject({ headInputState: 'awaiting_provider_acceptance' });

      arbiter.dispose();
    });

    it('holds subsequent pending prompts until the first steer resolves and preserves order', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const accepted: Array<readonly [string, string]> = [];
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        injectPrompt,
        evaluateInFlightSteer: async () => ({ steer: true as const }),
        onPromptAccepted: async (batch, acceptance) => {
          accepted.push([batch.message, acceptance.acceptedAs]);
        },
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'first steer', origin: { kind: 'ui_pending' } });
      await arbiter.enqueueUiMessage({ message: 'second prompt', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      // Only the head prompt steers; the second waits for the first to resolve.
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt.mock.calls[0]?.[0]).toMatchObject({ message: 'first steer' });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();

      expect(injectPrompt).toHaveBeenCalledTimes(2);
      expect(injectPrompt.mock.calls.map(([batch]) => (batch as { message: string }).message)).toEqual([
        'first steer',
        'second prompt',
      ]);
      await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
      expect(accepted).toEqual([
        ['first steer', 'in_flight_steer'],
        ['second prompt', 'new_turn'],
      ]);

      arbiter.dispose();
    });

    it('arms steer acceptance from screen evidence when turn-end lifecycle signals are lost', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const armed: string[] = [];
      let evaluations = 0;
      const onInjectionFailure = vi.fn();
      const injectPrompt = vi.fn(async (
        batch: { message: string },
        _options?: { inFlightSteer?: boolean | undefined } | undefined,
      ) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        busyTurnFallbackWakeMs: 50,
        injectPrompt,
        evaluateInFlightSteer: async () => {
          evaluations += 1;
          return evaluations === 1
            ? { steer: true as const }
            : { steer: false as const, reason: 'not_generating', turnLikelyEnded: true };
        },
        onSteerAcceptanceArmed: (batch) => {
          armed.push(batch.message);
        },
        onInjectionFailure,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'steer without stop hook', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(armed).toEqual([]);

      // No turn_state idle ever arrives, but the bounded fallback re-checks the
      // screen and arms acceptance when the screen says the turn ended.
      nowMs += 50;
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => {
        expect(armed).toEqual(['steer without stop hook']);
      });

      // The armed acceptance timeout then recovers through failed_ambiguous as
      // usual (no wedged awaiting_provider_acceptance forever).
      nowMs += 40;
      await vi.advanceTimersByTimeAsync(40);
      expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        failureState: 'failed_ambiguous',
        batch: expect.objectContaining({ message: 'steer without stop hook' }),
      }));
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1 });

      arbiter.dispose();
    });

    it('defers in-flight steer acceptance arming for explicit immediate prompts injected mid-turn', async () => {
      vi.useFakeTimers();
      let nowMs = 10_000;
      const armed: string[] = [];
      const onInjectionFailure = vi.fn();
      const injectPrompt = vi.fn(async (
        batch: { message: string },
        _options?: { inFlightSteer?: boolean | undefined } | undefined,
      ) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        providerAcceptanceTimeoutMs: 40,
        injectPrompt,
        onSteerAcceptanceArmed: (batch) => {
          armed.push(batch.message);
        },
        onInjectionFailure,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'immediate steer', origin: { kind: 'ui_immediate' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledTimes(1);

      // The queued prompt submits only at turn end: the short acceptance timeout
      // must not mark it ambiguous (and risk a double-queued retry) mid-turn.
      nowMs += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onInjectionFailure).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({ headInputState: 'awaiting_provider_acceptance' });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
      expect(armed).toEqual(['immediate steer']);

      arbiter.dispose();
    });
  });

  describe('stale-turn recovery (incident cmq7pyqkj, L1)', () => {
    it('drains a steer-vetoed ui_pending prompt as a new turn when the running turn is stale with idle-composer evidence', async () => {
      let nowMs = 10_000;
      const accepted: Array<readonly [string, string]> = [];
      const injectPrompt = vi.fn(async (
        batch: { message: string },
        _options?: { inFlightSteer?: boolean | undefined } | undefined,
      ) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      // Incident shape: the prompt carries a permission-mode change, so steering is
      // refused by design — but the screen proves an idle interactive composer.
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'permission_mode_change',
        turnLikelyEnded: true,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
        onPromptAccepted: async (batch, acceptance) => {
          accepted.push([batch.message, acceptance.acceptedAs]);
        },
      });

      // Stale 'running' turn: lifecycle marked running (e.g. from replayed transcript
      // rows after a respawn) and no provider activity ever follows.
      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'continuation prompt', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({
        queuedCount: 1,
        lastDeferredReason: 'terminal_busy',
      });

      // Bounded staleness window elapses with NO provider output: the turn must be
      // treated as not-running and the prompt drained normally (not steered).
      nowMs += 31_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'continuation prompt' }),
        undefined,
      );
      await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
      expect(accepted).toEqual([['continuation prompt', 'new_turn']]);

      arbiter.dispose();
    });

    it('keeps deferring while the running turn shows live provider activity', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: 4 }));
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'permission_mode_change',
        turnLikelyEnded: true,
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'hold', origin: { kind: 'ui_pending' } });

      // Live turn: provider output keeps arriving, so the window never elapses.
      for (let i = 0; i < 4; i += 1) {
        nowMs += 10_000;
        arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
        await arbiter.drainWhenSafe();
        expect(injectPrompt).not.toHaveBeenCalled();
      }
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'terminal_busy' });

      arbiter.dispose();
    });

    it('keeps deferring a stale-looking turn when screen evidence is unavailable (fail-closed)', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: 4 }));
      // Veto without turnLikelyEnded: the screen could not prove the turn ended.
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'screen_capture_failed',
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'hold', origin: { kind: 'ui_pending' } });
      nowMs += 31_000;
      await arbiter.drainWhenSafe();

      expect(injectPrompt).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'terminal_busy' });

      arbiter.dispose();
    });

    // Lane N2: the canonical session turn lifecycle is a stronger truth source than a one-frame
    // screen parse. When it reports NO active turn (and provider evidence is stale), the arbiter
    // must not stay 'running' even without turn-end screen evidence.
    it('recovers a stale running turn without screen evidence when the canonical lifecycle has no active turn', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: 4 }));
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'screen_capture_failed',
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
        isCanonicalTurnActive: () => false,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'drain me', origin: { kind: 'ui_pending' } });
      nowMs += 31_000;
      await arbiter.drainWhenSafe();

      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(expect.objectContaining({ message: 'drain me' }), undefined);

      arbiter.dispose();
    });

    it('does not steer into a stale running turn when the canonical lifecycle has no active turn', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: 4 }));
      const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
        isCanonicalTurnActive: () => false,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'do not steer stale turn', origin: { kind: 'ui_pending' } });
      nowMs += 31_000;
      await arbiter.drainWhenSafe();

      expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'do not steer stale turn' }),
        undefined,
      );

      arbiter.dispose();
    });

    it('keeps deferring without screen evidence while the canonical lifecycle still has an active turn', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async () => ({ status: 'injected' as const, at: nowMs, bytesWritten: 4 }));
      const evaluateInFlightSteer = vi.fn(async () => ({
        steer: false as const,
        reason: 'screen_capture_failed',
      }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
        isCanonicalTurnActive: () => true,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: 'hold', origin: { kind: 'ui_pending' } });
      nowMs += 31_000;
      await arbiter.drainWhenSafe();

      expect(injectPrompt).not.toHaveBeenCalled();
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'terminal_busy' });

      arbiter.dispose();
    });

    it('recovers a stale running turn for slash-command prompts on lifecycle staleness alone', async () => {
      let nowMs = 10_000;
      const injectPrompt = vi.fn(async (batch: { message: string }) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
      const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        quietPeriodMs: 0,
        staleTurnRecoveryMs: 30_000,
        injectPrompt,
        evaluateInFlightSteer,
      });

      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
      await arbiter.enqueueUiMessage({ message: '/compact', origin: { kind: 'ui_pending' } });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(injectPrompt).not.toHaveBeenCalled();

      nowMs += 31_000;
      await arbiter.drainWhenSafe();
      // Slash prompts are never steered; staleness recovery drains them as a new turn.
      expect(evaluateInFlightSteer).not.toHaveBeenCalled();
      expect(injectPrompt).toHaveBeenCalledTimes(1);
      expect(injectPrompt).toHaveBeenCalledWith(expect.objectContaining({ message: '/compact' }), undefined);

      arbiter.dispose();
    });
  });

  it('does not accept the next queued prompt when Claude sends an extra confirmation', async () => {
    let nowMs = 10_000;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async (batch) => ({ status: 'injected', at: nowMs, bytesWritten: batch.message.length }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'first', origin: { kind: 'ui_pending' } });
    await arbiter.enqueueUiMessage({ message: 'second', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 2, headInputState: 'awaiting_provider_acceptance' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, headInputState: 'submitted' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(false);

    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1 });
  });

  describe('undeliverable batch handback (F-1 / A3-MED-1)', () => {
    it('hands back ALL still-queued batches in FIFO order on dispose instead of dropping them', async () => {
      let nowMs = 10_000;
      const handedBack: string[] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        injectPrompt: async (batch) => ({ status: 'injected', at: nowMs, bytesWritten: batch.message.length }),
        onUndeliverableBatches: (batches) => {
          handedBack.push(...batches.map((batch) => batch.message));
        },
      });

      await arbiter.enqueueUiMessage({ message: 'first', origin: { kind: 'ui_pending' } });
      await arbiter.enqueueUiMessage({ message: 'second', origin: { kind: 'ui_pending' } });

      arbiter.dispose();

      expect(handedBack).toEqual(['first', 'second']);
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, disposed: true });

      // A second dispose must not double-hand-back.
      arbiter.dispose();
      expect(handedBack).toEqual(['first', 'second']);
    });

    it('hands back the failed_terminal head batch on dispose (failed_terminal park drop, F-1)', async () => {
      let nowMs = 10_000;
      const handedBack: string[] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        nowMs: () => nowMs,
        injectPrompt: async () => ({
          status: 'failed' as const,
          reason: 'no_target' as const,
          phase: 'before_write' as const,
          duplicateRisk: 'none' as const,
          recoverable: false,
        }),
        injectionRetryLimit: 0,
        onUndeliverableBatches: (batches) => {
          handedBack.push(...batches.map((batch) => batch.message));
        },
      });

      await arbiter.enqueueUiMessage({ message: 'doomed', origin: { kind: 'ui_pending' } });
      arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
      nowMs += 1_000;
      await arbiter.drainWhenSafe();
      expect(arbiter.snapshot()).toMatchObject({ headInputState: 'failed_terminal', queuedCount: 1 });

      arbiter.dispose();

      expect(handedBack).toEqual(['doomed']);
    });

    it('hands back a batch enqueued after dispose instead of silently dropping it', async () => {
      const handedBack: string[] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }),
        onUndeliverableBatches: (batches) => {
          handedBack.push(...batches.map((batch) => batch.message));
        },
      });

      arbiter.dispose();
      await arbiter.enqueueUiMessage({ message: 'late', origin: { kind: 'ui_pending' } });

      expect(handedBack).toEqual(['late']);
    });
  });
});
