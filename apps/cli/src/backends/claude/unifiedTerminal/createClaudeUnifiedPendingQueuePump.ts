import type { DrainPendingOptions, DrainPendingResult, MessageBatch } from '@/agent/runtime/sessionInput/types';

import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedPendingQueuePump,
} from './_types';

const NULL_INPUT_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function createClaudeUnifiedPendingQueuePump<Mode = unknown>(opts: Readonly<{
  inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  arbiter: Pick<ClaudeUnifiedInputArbiter<Mode>, 'enqueueUiMessage' | 'drainWhenSafe'>;
  /**
   * Called when a batch was already pulled from the input consumer but the pump
   * can no longer deliver it (aborted/disposed mid-wait, e.g. host-death
   * unwind). Lets the owner return the message to its queue instead of
   * permanently dropping it into a dead session.
   */
  onUndeliverableBatch?: (batch: MessageBatch<Mode, string>) => void;
  nullInputRetryDelayMs?: number | undefined;
}>): ClaudeUnifiedPendingQueuePump<Mode> {
  let disposed = false;
  let runPromise: Promise<void> | null = null;

  const pumpOnce = async (pumpOpts: { abortSignal: AbortSignal }): Promise<boolean> => {
    if (disposed || pumpOpts.abortSignal.aborted) {
      return false;
    }
    const batch = await opts.inputConsumer.waitForNextInput({ abortSignal: pumpOpts.abortSignal });
    if (!batch) {
      return false;
    }
    if (pumpOpts.abortSignal.aborted || disposed) {
      opts.onUndeliverableBatch?.(batch);
      return false;
    }
    await opts.arbiter.enqueueUiMessage({
      message: batch.message,
      mode: batch.mode,
      origin: { kind: 'ui_pending' },
      maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
      userMessageLocalIds: batch.userMessageLocalIds ?? [],
    });
    await opts.arbiter.drainWhenSafe();
    return true;
  };

  const run = async (runOpts: { abortSignal: AbortSignal }): Promise<void> => {
    const retryDelayMs = opts.nullInputRetryDelayMs ?? NULL_INPUT_RETRY_DELAY_MS;
    while (!disposed && !runOpts.abortSignal.aborted) {
      const pumped = await pumpOnce(runOpts);
      if (!pumped && !disposed && !runOpts.abortSignal.aborted) {
        await sleep(retryDelayMs);
      }
    }
  };

  return {
    pumpOnce,
    async drainPending(drainOpts?: DrainPendingOptions): Promise<DrainPendingResult | null> {
      return await (opts.inputConsumer.drainPending?.(drainOpts) ?? Promise.resolve(null));
    },
    start(startOpts) {
      if (runPromise) return runPromise;
      if (disposed) return Promise.resolve();
      runPromise = run(startOpts).finally(() => {
        runPromise = null;
      });
      return runPromise;
    },
    dispose() {
      disposed = true;
    },
  };
}
