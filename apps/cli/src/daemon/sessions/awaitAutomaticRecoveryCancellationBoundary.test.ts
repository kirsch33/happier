import { describe, expect, it, vi } from 'vitest';

import { awaitAutomaticRecoveryCancellationBoundary } from './awaitAutomaticRecoveryCancellationBoundary';

describe('awaitAutomaticRecoveryCancellationBoundary', () => {
  it('preserves complete rejection evidence when every cancellation settles', async () => {
    await expect(awaitAutomaticRecoveryCancellationBoundary({
      operations: [Promise.resolve('ok'), Promise.reject(new Error('store unavailable'))],
      timeoutMs: 100,
    })).resolves.toMatchObject({
      status: 'settled',
      results: [{ status: 'fulfilled' }, { status: 'rejected' }],
    });
  });

  it('releases explicit Stop when one automatic-recovery cancellation never settles', async () => {
    const wait = vi.fn(async () => undefined);
    await expect(awaitAutomaticRecoveryCancellationBoundary({
      operations: [Promise.resolve(), new Promise<never>(() => {})],
      timeoutMs: 1,
      wait,
    })).resolves.toEqual({ status: 'timeout' });
    expect(wait).toHaveBeenCalledWith(1);
  });
});
