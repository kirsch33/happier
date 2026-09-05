import { delay } from '@/utils/time';

export type AutomaticRecoveryCancellationBoundaryResult =
  | Readonly<{ status: 'settled'; results: readonly PromiseSettledResult<unknown>[] }>
  | Readonly<{ status: 'timeout' }>;

export async function awaitAutomaticRecoveryCancellationBoundary(params: Readonly<{
  operations: readonly Promise<unknown>[];
  timeoutMs: number;
  wait?: (ms: number) => Promise<void>;
}>): Promise<AutomaticRecoveryCancellationBoundaryResult> {
  const wait = params.wait ?? delay;
  const settled = Promise.allSettled(params.operations).then((results) => ({
    status: 'settled' as const,
    results,
  }));
  return await Promise.race([
    settled,
    wait(params.timeoutMs).then(() => ({ status: 'timeout' as const })),
  ]);
}
