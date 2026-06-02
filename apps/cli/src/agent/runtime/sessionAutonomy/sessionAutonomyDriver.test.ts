import { describe, expect, it, vi } from 'vitest';
import { createSessionAutonomyDriver } from './sessionAutonomyDriver';
import type { SessionAutonomyMetadataV1 } from './sessionAutonomyMetadata';

type Timer = Readonly<{ id: number }>;
type MetadataRecord = Record<string, unknown>;

function isTimer(value: unknown): value is Timer {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { id?: unknown }).id === 'number';
}

function createManualClock(startMs = Date.UTC(2026, 5, 2, 10, 45, 0)): {
  clock: {
    now: () => number;
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (timer: unknown) => void;
  };
  advanceBy: (delayMs: number) => void;
  scheduledCount: () => number;
} {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        const timer = { id: nextId++ };
        timers.set(timer.id, { at: now + delayMs, callback });
        return timer;
      },
      clearTimeout: (timer) => {
        if (isTimer(timer)) timers.delete(timer.id);
      },
    },
    advanceBy: (delayMs) => {
      now += delayMs;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
    scheduledCount: () => timers.size,
  };
}

function createGoalMetadata(status: 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' = 'active'): MetadataRecord {
  return {
    sessionWorkStateV1: {
      v: 1,
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 100,
      primaryItemId: 'goal:overwatch',
      items: [
        {
          id: 'goal:overwatch',
          kind: 'goal',
          origin: 'happier',
          backendId: 'claude',
          agentId: 'claude',
          status,
          title: 'Run Overwatch autonomously',
          tokenBudget: 5000,
          updatedAt: 100,
        },
      ],
    },
  };
}

function readAutonomy(metadata: MetadataRecord): SessionAutonomyMetadataV1 | undefined {
  return (metadata as { sessionAutonomyV1?: SessionAutonomyMetadataV1 }).sessionAutonomyV1;
}

describe('createSessionAutonomyDriver', () => {
  it('schedules and enqueues a continuation when the provider is idle with an active goal', async () => {
    const manual = createManualClock();
    let metadata = createGoalMetadata();
    const enqueued: Array<{ message: string; localId: string }> = [];

    const driver = createSessionAutonomyDriver({
      sessionId: 'session-1',
      agentId: 'claude',
      backendId: 'claude',
      cadenceMs: 270_000,
      clock: manual.clock,
      getMetadata: () => metadata,
      updateMetadata: vi.fn((updater) => {
        metadata = updater(metadata);
      }),
      hasQueuedInput: () => false,
      hasPendingInput: async () => false,
      enqueueContinuation: (continuation) => {
        enqueued.push({ message: continuation.message, localId: continuation.localId });
      },
    });

    await driver.handleProviderIdle();

    expect(manual.scheduledCount()).toBe(1);
    expect(readAutonomy(metadata)).toMatchObject({
      v: 1,
      goalItemId: 'goal:overwatch',
      status: 'active',
      cadenceMs: 270_000,
      nextWakeAt: '2026-06-02T10:49:30.000Z',
      wakeAttempt: 0,
    });

    manual.advanceBy(270_000);

    await expect.poll(() => enqueued.length).toBe(1);
    expect(enqueued[0]).toMatchObject({
      localId: 'autonomy:session-1:goal:overwatch:1',
    });
    expect(enqueued[0]?.message).toContain('Run Overwatch autonomously');
    expect(readAutonomy(metadata)).toMatchObject({
      lastWakeAt: '2026-06-02T10:49:30.000Z',
      lastWakeLocalId: 'autonomy:session-1:goal:overwatch:1',
      inFlightLocalId: 'autonomy:session-1:goal:overwatch:1',
      nextWakeAt: null,
      wakeAttempt: 1,
    });
  });

  it.each([
    ['queued input', true, false, null],
    ['pending input', false, true, null],
    ['wake localId already in flight', false, false, 'autonomy:session-1:goal:overwatch:4'],
  ] as const)('does not schedule duplicate continuation when %s exists', async (_label, queued, pending, inFlightLocalId) => {
    const manual = createManualClock();
    let metadata = createGoalMetadata();
    if (inFlightLocalId) {
      metadata = {
        ...metadata,
        sessionAutonomyV1: {
          v: 1,
          goalItemId: 'goal:overwatch',
          status: 'active',
          cadenceMs: 270_000,
          nextWakeAt: null,
          wakeAttempt: 4,
          lastWakeLocalId: inFlightLocalId,
          inFlightLocalId,
          updatedAt: '2026-06-02T10:45:00.000Z',
        },
      };
    }
    const enqueued: Array<{ message: string; localId: string }> = [];

    const driver = createSessionAutonomyDriver({
      sessionId: 'session-1',
      agentId: 'claude',
      backendId: 'claude',
      cadenceMs: 270_000,
      clock: manual.clock,
      getMetadata: () => metadata,
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
      hasQueuedInput: () => queued,
      hasPendingInput: async () => pending,
      isWakeLocalIdInFlight: async (localId) => localId === inFlightLocalId,
      enqueueContinuation: (continuation) => {
        enqueued.push({ message: continuation.message, localId: continuation.localId });
      },
    });

    await driver.handleProviderIdle();
    manual.advanceBy(270_000);
    await Promise.resolve();

    expect(manual.scheduledCount()).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('cancels timers and does not enqueue after cancellation', async () => {
    const manual = createManualClock();
    let metadata = createGoalMetadata();
    const enqueued: Array<{ message: string; localId: string }> = [];
    const driver = createSessionAutonomyDriver({
      sessionId: 'session-1',
      agentId: 'claude',
      backendId: 'claude',
      cadenceMs: 270_000,
      clock: manual.clock,
      getMetadata: () => metadata,
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
      hasQueuedInput: () => false,
      hasPendingInput: async () => false,
      enqueueContinuation: (continuation) => {
        enqueued.push({ message: continuation.message, localId: continuation.localId });
      },
    });

    await driver.handleProviderIdle();
    expect(manual.scheduledCount()).toBe(1);

    driver.cancel();
    manual.advanceBy(270_000);
    await Promise.resolve();

    expect(manual.scheduledCount()).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('clears the next wake when the goal becomes nonactive', async () => {
    const manual = createManualClock();
    let metadata: MetadataRecord = {
      ...createGoalMetadata('paused'),
      sessionAutonomyV1: {
        v: 1,
        goalItemId: 'goal:overwatch',
        status: 'active',
        cadenceMs: 270_000,
        nextWakeAt: '2026-06-02T10:49:30.000Z',
        wakeAttempt: 2,
        inFlightLocalId: 'autonomy:session-1:goal:overwatch:2',
        updatedAt: '2026-06-02T10:45:00.000Z',
      },
    };
    const driver = createSessionAutonomyDriver({
      sessionId: 'session-1',
      agentId: 'claude',
      backendId: 'claude',
      cadenceMs: 270_000,
      clock: manual.clock,
      getMetadata: () => metadata,
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
      hasQueuedInput: () => false,
      hasPendingInput: async () => false,
      enqueueContinuation: vi.fn(),
    });

    await driver.handleProviderIdle();

    expect(readAutonomy(metadata)).toMatchObject({
      status: 'inactive',
      nextWakeAt: null,
      inFlightLocalId: null,
    });
  });

  it('clears in-flight wake metadata when the provider starts that input', async () => {
    const manual = createManualClock();
    let metadata: MetadataRecord = {
      ...createGoalMetadata(),
      sessionAutonomyV1: {
        v: 1,
        goalItemId: 'goal:overwatch',
        status: 'active',
        cadenceMs: 270_000,
        nextWakeAt: null,
        wakeAttempt: 1,
        lastWakeLocalId: 'autonomy:session-1:goal:overwatch:1',
        inFlightLocalId: 'autonomy:session-1:goal:overwatch:1',
        updatedAt: '2026-06-02T10:49:30.000Z',
      },
    };
    const driver = createSessionAutonomyDriver({
      sessionId: 'session-1',
      agentId: 'claude',
      backendId: 'claude',
      cadenceMs: 270_000,
      clock: manual.clock,
      getMetadata: () => metadata,
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
      hasQueuedInput: () => false,
      hasPendingInput: async () => false,
      enqueueContinuation: vi.fn(),
    });

    await driver.handleProviderInputStarted('autonomy:session-1:goal:overwatch:1');

    expect(readAutonomy(metadata)).toMatchObject({
      inFlightLocalId: null,
      lastWakeLocalId: 'autonomy:session-1:goal:overwatch:1',
    });
  });
});
