import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import {
  ClaudeUnifiedTerminalReadinessTimeoutError,
  createClaudeUnifiedTerminalReadinessBridge,
  isClaudeUnifiedTerminalReadinessTimeoutError,
} from './createClaudeUnifiedTerminalReadinessBridge';
import { ClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';

const handle: TerminalHostHandle = {
  kind: 'zellij',
  sessionName: 'happier-claude-unified-test',
  paneId: 'terminal_1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

function createArbiter() {
  return {
    observeLifecycle: vi.fn(),
    observeUserTypingState: vi.fn(),
    drainWhenSafe: vi.fn().mockResolvedValue(undefined),
  };
}

const interactiveClaudeScreen = [
  'Some previous Claude output',
  '',
  'What would you like to work on?',
  '> ',
].join('\n');

// Real Claude renders a boxed composer (`│ > │`); the previous narrow readiness regex missed it
// (no bare `> $` line, no "What would you like to work on?" in the tail), producing a false-negative
// "not ready" that killed the live host on heavy/xhigh startups (incident cmq7zi1y).
const boxedInteractiveClaudeScreen = [
  'Claude Code v2.1.170',
  ' Tips for getting started:',
  '  Run /init to create a CLAUDE.md file',
  '╭───────────────────────────────────────────────╮',
  '│ >                                               │',
  '╰───────────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n');

const resumeChoiceDialogScreen = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

const tmuxHandle: TerminalHostHandle = {
  kind: 'tmux',
  sessionName: 'happier-claude-unified-test',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

describe('createClaudeUnifiedTerminalReadinessBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles the poll promise on abort without waiting out the pending poll timer', async () => {
    vi.useFakeTimers();
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: false, observedAt: 0 });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      arbiter,
      pollIntervalMs: 250,
      timeoutMs: 15_000,
      nowMs: () => 0,
    });
    const abortController = new AbortController();

    let settled = false;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .then(() => { settled = true; });
    // Let the first probe resolve and the loop enter its poll wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(evaluateLiveness).toHaveBeenCalledTimes(1);
    bridge.dispose();
    await started;
  });

  it('retries after a transient liveness probe failure and still reports startup readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn()
      .mockRejectedValueOnce(new Error('control plane unavailable'))
      .mockResolvedValueOnce({ paneAlive: true, observedAt: 10 });
    const captureInputState = vi.fn().mockResolvedValue({
      stable: true,
      currentInput: interactiveClaudeScreen,
      observedAt: 10,
    });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });

  it('retries after a transient input-state capture failure and still reports startup readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 10 });
    const captureInputState = vi.fn()
      .mockRejectedValueOnce(new Error('capture unavailable'))
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeUserTypingState).toHaveBeenCalledWith({
      userTyping: false,
      observedAtMs: 10,
    });

    bridge.dispose();
  });

  it('fails startup immediately when the terminal host has returned to shell', async () => {
    vi.useFakeTimers();
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockResolvedValue({
      paneAlive: true,
      paneCurrentCommand: 'zsh',
      observedAt: 0,
    });
    const captureInputState = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle: tmuxHandle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 100,
      nowMs: () => 0,
    });

    const started = Promise.resolve(bridge.start({ abortSignal: new AbortController().signal }))
      .then(
        () => null,
        (error) => error,
      );
    await vi.advanceTimersByTimeAsync(0);

    const error = await started;
    expect(error).toBeInstanceOf(ClaudeUnifiedTerminalHostDeadError);
    expect(error).toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness: {
        paneAlive: false,
        paneDead: true,
        paneCurrentCommand: 'zsh',
        paneScreenDumpError: 'terminal host returned to shell (zsh)',
      },
    });
    expect(captureInputState).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('returns a supervised promise when readiness drain fails', async () => {
    const arbiter = createArbiter();
    const drainError = new Error('readiness drain failed');
    arbiter.drainWhenSafe.mockRejectedValue(drainError);
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 10 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: interactiveClaudeScreen,
          observedAt: 10,
        }),
      },
      handle,
      arbiter,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });

    expect(started).toBeInstanceOf(Promise);
    await expect(started).rejects.toBe(drainError);

    bridge.dispose();
  });

  it('keeps retrying repeated liveness probe failures until startup timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const evaluateLiveness = vi.fn().mockRejectedValue(new Error('control plane unavailable'));
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      onStartupReady: vi.fn(),
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(evaluateLiveness.mock.calls.length).toBeGreaterThan(1);
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();
    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('clears the quiet drain timer on disposal', async () => {
    vi.useFakeTimers();
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: interactiveClaudeScreen,
          observedAt: 1,
        }),
      },
      handle,
      arbiter,
      quietPeriodMs: 50,
      timeoutMs: 100,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(arbiter.drainWhenSafe).toHaveBeenCalledTimes(1);

    bridge.dispose();
    await vi.advanceTimersByTimeAsync(50);

    expect(arbiter.drainWhenSafe).toHaveBeenCalledTimes(1);
  });

  it('does not report readiness when the host stays non-live through timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: false, observedAt: 0 });
    const captureInputState = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    await Promise.resolve();
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();
    expect(captureInputState).not.toHaveBeenCalled();
    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('rejects the supervised startup task when readiness never arrives before timeout', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: false,
          currentInput: '',
          observedAt: 0,
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const startupTimeoutExpectation = expect(started).rejects.toMatchObject({
      code: 'claude_unified_terminal_readiness_timeout',
    });
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    await startupTimeoutExpectation;

    bridge.dispose();
  });

  it('does not reject startup readiness after trusted provider progress is observed', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let providerProgressObserved = false;
    const arbiter = createArbiter();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: 'Claude is working on your request',
          observedAt: 0,
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 25,
      nowMs: () => nowMs,
      hasTrustedProviderProgress: () => providerProgressObserved,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    providerProgressObserved = true;
    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    await expect(started).resolves.toBeUndefined();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'output' }));

    bridge.dispose();
  });

  it('does not report zellij startup readiness for a stable but non-interactive resume screen', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: [
          'Resuming previous conversation...',
          'Rendering transcript messages and tools...',
        ].join('\n'),
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });

  it('lets a startup dialog resolver handle the resume-choice interstitial before reporting readiness', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const resolveStartupDialog = vi.fn()
      .mockResolvedValueOnce({ status: 'handled' })
      .mockResolvedValue({ status: 'unhandled' });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: resumeChoiceDialogScreen,
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: boxedInteractiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
      resolveStartupDialog,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveStartupDialog).toHaveBeenCalledTimes(1);
    expect(onStartupReady).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });
    bridge.dispose();
  });

  it('pauses startup timeout while the resume-choice resolver is waiting for a user action', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const abortController = new AbortController();
    const resolveStartupDialog = vi.fn().mockResolvedValue({ status: 'waiting_for_user' });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: resumeChoiceDialogScreen,
          observedAt: 0,
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 30,
      progressGraceMs: 1,
      nowMs: () => nowMs,
      resolveStartupDialog,
    });

    let settled = false;
    const started = Promise.resolve(bridge.start({ abortSignal: abortController.signal }))
      .then(() => { settled = true; });

    await Promise.resolve();
    for (let i = 0; i < 5; i += 1) {
      nowMs += 10;
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(settled).toBe(false);
    expect(resolveStartupDialog).toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

    abortController.abort();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    expect(settled).toBe(true);
    bridge.dispose();
  });

  it('reports startup readiness for a boxed interactive Claude composer via the shared parser (D15)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: boxedInteractiveClaudeScreen,
          observedAt: 1,
        }),
      },
      handle: tmuxHandle,
      arbiter,
      quietPeriodMs: 50,
      timeoutMs: 100,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await flushMicrotasks();

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'output' }));

    bridge.dispose();
  });

  it('extends the startup window for a live, progressing host until the interactive marker appears (D17)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let captures = 0;
    const captureInputState = vi.fn().mockImplementation(async () => {
      captures += 1;
      if (captures < 6) {
        return { stable: true, currentInput: `Rendering transcript chunk ${captures} of many…`, observedAt: Date.now() };
      }
      return { stable: true, currentInput: boxedInteractiveClaudeScreen, observedAt: Date.now() };
    });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState,
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      quietPeriodMs: 10,
      timeoutMs: 20,
      extendedTimeoutMs: 1_000,
      progressGraceMs: 80,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    await vi.waitFor(() => {
      expect(onStartupReady).toHaveBeenCalledTimes(1);
    }, { timeout: 2_000 });

    bridge.dispose();
    await expect(started).resolves.toBeUndefined();
    expect(captures).toBeGreaterThanOrEqual(6);
  });

  it('times out a live but stable unknown host past the base window and attaches sanitized diagnostics (D16/D18)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const stableUnknownScreen = 'Initializing Claude Code…\nLoading workspace configuration';
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState: vi.fn().mockResolvedValue({
          stable: true,
          currentInput: stableUnknownScreen,
          observedAt: Date.now(),
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      // With SessionStart observed, a static screen holds until the HARD ceiling (incident pid-15592:
      // a heavy-resume render stall >grace must not kill a confirmed provider session). Keep the
      // ceiling small here so the test stays fast.
      extendedTimeoutMs: 120,
      progressGraceMs: 40,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const error = await Promise.resolve(started).then(() => null, (rejection: unknown) => rejection);

    expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(true);
    expect(onStartupReady).not.toHaveBeenCalled();
    const diagnostics = (error as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics;
    expect(diagnostics?.hostAlive).toBe(true);
    expect(diagnostics?.sessionStartObserved).toBe(true);
    expect(diagnostics?.lastLivenessPaneAlive).toBe(true);
    expect(diagnostics?.lastScreenTail).toContain('Initializing Claude Code');

    bridge.dispose();
  });

  it('holds a SessionStart-confirmed host through a static render stall until the hard ceiling (D17 refinement, incident pid-15592)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let screen = 'Resumed conversation tail\n+canonical profile home with sh';
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: Date.now() }),
        captureInputState: vi.fn().mockImplementation(async () => ({
          stable: true,
          currentInput: screen,
          observedAt: Date.now(),
        })),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      extendedTimeoutMs: 400,
      progressGraceMs: 40,
      hasHostAliveEvidence: () => true,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    // Past base (20ms) + grace (40ms) the screen is still static — a confirmed provider session must
    // KEEP polling instead of fast-failing. Reveal the composer before the ceiling: readiness succeeds.
    setTimeout(() => {
      screen = '╭───╮\n│ ❯   │\n╰───╯\n  ? for shortcuts';
    }, 150);
    await started;

    expect(onStartupReady).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('does not extend the window for a non-live host even if the screen keeps changing (D17 safety)', async () => {
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    let captures = 0;
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: false, observedAt: Date.now() }),
        captureInputState: vi.fn().mockImplementation(async () => {
          captures += 1;
          return { stable: true, currentInput: `still booting ${captures}`, observedAt: Date.now() };
        }),
      },
      handle,
      arbiter,
      pollIntervalMs: 5,
      timeoutMs: 20,
      extendedTimeoutMs: 1_000,
      progressGraceMs: 80,
      hasHostAliveEvidence: () => false,
      onStartupReady,
    });

    const started = bridge.start({ abortSignal: new AbortController().signal });
    const error = await Promise.resolve(started).then(() => null, (rejection: unknown) => rejection);

    expect(isClaudeUnifiedTerminalReadinessTimeoutError(error)).toBe(true);
    expect((error as ClaudeUnifiedTerminalReadinessTimeoutError).diagnostics?.hostAlive).toBe(false);
    expect(onStartupReady).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('does not report tmux startup readiness for a stable but non-interactive resume screen', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const arbiter = createArbiter();
    const onStartupReady = vi.fn();
    const evaluateLiveness = vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 0 });
    const captureInputState = vi
      .fn()
      .mockResolvedValueOnce({
        stable: true,
        currentInput: [
          'Resuming previous conversation...',
          'Rendering transcript messages and tools...',
        ].join('\n'),
        observedAt: 0,
      })
      .mockResolvedValueOnce({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: 10,
      });
    const bridge = createClaudeUnifiedTerminalReadinessBridge({
      hostAdapter: { evaluateLiveness, captureInputState },
      handle: tmuxHandle,
      arbiter,
      pollIntervalMs: 10,
      quietPeriodMs: 25,
      timeoutMs: 100,
      nowMs: () => nowMs,
      onStartupReady,
    });

    bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();

    expect(onStartupReady).not.toHaveBeenCalled();
    expect(arbiter.observeLifecycle).not.toHaveBeenCalled();

    nowMs += 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(arbiter.observeLifecycle).toHaveBeenCalledWith({ type: 'output', observedAtMs: 10 });

    bridge.dispose();
  });
});
