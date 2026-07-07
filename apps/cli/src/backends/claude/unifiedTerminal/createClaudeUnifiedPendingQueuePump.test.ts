import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';

describe('createClaudeUnifiedPendingQueuePump', () => {
  it('enqueues batches already produced by SessionProviderInputConsumer without materializing again', async () => {
    const waitForNextInput = vi.fn().mockResolvedValue({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      isolate: false,
      hash: 'same-mode',
    });
    const drainPending = vi.fn();
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);

    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput, drainPending },
      arbiter: { enqueueUiMessage, drainWhenSafe },
    });

    await pump.pumpOnce({ abortSignal: new AbortController().signal });

    expect(enqueueUiMessage).toHaveBeenCalledWith({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      origin: { kind: 'ui_pending' },
      maxUserMessageSeq: null,
      userMessageLocalIds: [],
    });
    expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();
  });

  it('delegates explicit pending drain to SessionProviderInputConsumer', async () => {
    const drainPending = vi.fn().mockResolvedValue({ materialized: 2, stoppedReason: 'no_pending' });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(),
        drainPending,
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn() },
    });

    await expect(pump.drainPending({ reason: 'unified-test' })).resolves.toEqual({
      materialized: 2,
      stoppedReason: 'no_pending',
    });
    expect(drainPending).toHaveBeenCalledWith({ reason: 'unified-test' });
  });

  it('returns an observable running promise from start when input waiting fails', async () => {
    const error = new Error('pending materialization failed');
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockRejectedValue(error),
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn() },
    });

    const startResult: unknown = pump.start({ abortSignal: new AbortController().signal });

    expect(startResult).toBeInstanceOf(Promise);
    await expect(startResult).rejects.toBe(error);
  });

  it('restarts an inactive pump when the input consumer reports new input', async () => {
    const error = new Error('transient input failure');
    const inputAvailableListeners: Array<() => void> = [];
    let resolveThirdWait!: (value: null) => void;
    const waitForNextInput = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        message: 'after wake',
        mode: undefined,
        isolate: false,
        hash: 'h-wake',
      })
      .mockImplementationOnce(() => new Promise<null>((resolve) => {
        resolveThirdWait = resolve;
      }));
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
        onInputAvailable: (listener) => {
          inputAvailableListeners.push(listener);
          return () => {
            const index = inputAvailableListeners.indexOf(listener);
            if (index >= 0) {
              inputAvailableListeners.splice(index, 1);
            }
          };
        },
      },
      arbiter: { enqueueUiMessage, drainWhenSafe },
    });

    await expect(pump.start({ abortSignal: new AbortController().signal })).rejects.toBe(error);
    expect(inputAvailableListeners).toHaveLength(1);

    inputAvailableListeners[0]?.();

    await vi.waitFor(() => {
      expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
        message: 'after wake',
      }));
    });
    await vi.waitFor(() => {
      expect(waitForNextInput).toHaveBeenCalledTimes(3);
    });

    pump.dispose();
    resolveThirdWait(null);
  });

  it('returns an observable running promise from start when safe drain fails', async () => {
    const error = new Error('drain failed');
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockResolvedValue({
          message: 'from queue',
          mode: undefined,
          isolate: false,
          hash: 'same-mode',
        }),
      },
      arbiter: {
        enqueueUiMessage: vi.fn().mockResolvedValue(undefined),
        drainWhenSafe: vi.fn().mockRejectedValue(error),
      },
    });

    const startResult: unknown = pump.start({ abortSignal: new AbortController().signal });

    expect(startResult).toBeInstanceOf(Promise);
    await expect(startResult).rejects.toBe(error);
  });

  it('keeps the running pump alive when the input consumer transiently returns null', async () => {
    vi.useFakeTimers();
    try {
      const waitForNextInput = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          message: 'after transient null',
          mode: undefined,
          isolate: false,
          hash: 'h-after-null',
        })
        .mockResolvedValue(null);
      const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
      const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
      const pump = createClaudeUnifiedPendingQueuePump({
        inputConsumer: { waitForNextInput },
        arbiter: { enqueueUiMessage, drainWhenSafe },
        nullInputRetryDelayMs: 1,
      });

      const running = pump.start({ abortSignal: new AbortController().signal });

      await vi.waitFor(() => {
        expect(waitForNextInput).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
          message: 'after transient null',
        }));
      });

      pump.dispose();
      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toBeUndefined();
      expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands an already-consumed batch back instead of dropping it when aborted during the input wait (silent queue-swallow fix)', async () => {
    const abortController = new AbortController();
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn() },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: abortController.signal });
    abortController.abort();
    resolveInput({ message: 'arrived during unwind', mode: undefined, isolate: false, hash: 'h1' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'arrived during unwind',
    }));
  });

  it('hands an already-consumed batch back when disposed during the input wait', async () => {
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn() },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput({ message: 'stolen by stale waiter', mode: undefined, isolate: false, hash: 'h2' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'stolen by stale waiter',
    }));
  });

  it('resolves the running promise after disposal when the consumer stops', async () => {
    let resolveInput!: (value: null) => void;
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<null>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn() },
    });

    const startResult = pump.start({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput(null);

    await expect(startResult).resolves.toBeUndefined();
  });
});
