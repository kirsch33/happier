import {
  readActiveGoalSnapshotFromSessionWorkStateMetadata,
  type ActiveGoalSnapshot,
} from '@/agent/runtime/sessionGoals/activeGoalSnapshot';

import {
  readSessionAutonomyMetadataV1,
  withSessionAutonomyMetadataV1,
  type SessionAutonomyMetadataV1,
} from './sessionAutonomyMetadata';
import { buildSessionAutonomyContinuationPrompt } from './sessionAutonomyPrompt';

type MetadataRecord = Record<string, unknown>;
type TimerHandle = unknown;

export type SessionAutonomyContinuation = Readonly<{
  message: string;
  localId: string;
  goal: ActiveGoalSnapshot;
}>;

export type SessionAutonomyDriver = Readonly<{
  handleProviderIdle: () => Promise<void>;
  handleProviderInputStarted: (localId: string | null | undefined) => Promise<void>;
  cancel: () => void;
}>;

export type SessionAutonomyClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
}>;

export type SessionAutonomyDriverOptions = Readonly<{
  sessionId: string;
  agentId: string;
  backendId: string;
  cadenceMs: number;
  clock?: SessionAutonomyClock;
  getMetadata: () => MetadataRecord | null | undefined;
  updateMetadata: (updater: (metadata: MetadataRecord) => MetadataRecord) => void | Promise<void>;
  hasQueuedInput: () => boolean;
  hasPendingInput: () => boolean | Promise<boolean>;
  isWakeLocalIdInFlight?: (localId: string) => boolean | Promise<boolean>;
  enqueueContinuation: (continuation: SessionAutonomyContinuation) => void | Promise<void>;
}>;

const defaultClock: SessionAutonomyClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildWakeLocalId(sessionId: string, goalItemId: string, attempt: number): string {
  return `autonomy:${sessionId}:${goalItemId}:${attempt}`;
}

function resolveCadenceMs(opts: SessionAutonomyDriverOptions, existing: SessionAutonomyMetadataV1 | null): number {
  return existing && existing.cadenceMs > 0 ? existing.cadenceMs : opts.cadenceMs;
}

function readMetadata(opts: SessionAutonomyDriverOptions): MetadataRecord {
  return opts.getMetadata() ?? {};
}

async function hasCompetingInput(
  opts: SessionAutonomyDriverOptions,
  autonomy: SessionAutonomyMetadataV1 | null,
): Promise<boolean> {
  if (opts.hasQueuedInput()) return true;
  if (await opts.hasPendingInput()) return true;
  const inFlightLocalId = autonomy?.inFlightLocalId;
  return Boolean(inFlightLocalId && await opts.isWakeLocalIdInFlight?.(inFlightLocalId));
}

export function createSessionAutonomyDriver(opts: SessionAutonomyDriverOptions): SessionAutonomyDriver {
  const clock = opts.clock ?? defaultClock;
  let timer: TimerHandle | null = null;
  let cancelled = false;

  const clearTimer = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  const persist = async (next: SessionAutonomyMetadataV1): Promise<void> => {
    await opts.updateMetadata((metadata) => withSessionAutonomyMetadataV1(metadata, next));
  };

  const clearAutonomyForInactiveGoal = async (metadata: MetadataRecord, nowMs: number): Promise<void> => {
    const existing = readSessionAutonomyMetadataV1(metadata);
    if (!existing) return;
    await persist({
      ...existing,
      status: 'inactive',
      nextWakeAt: null,
      inFlightLocalId: null,
      updatedAt: isoFromMs(nowMs),
    });
  };

  const scheduleWake = async (goal: ActiveGoalSnapshot, metadata: MetadataRecord, nowMs: number): Promise<void> => {
    clearTimer();
    const existing = readSessionAutonomyMetadataV1(metadata);
    const cadenceMs = resolveCadenceMs(opts, existing);
    const nextWakeAtMs = nowMs + cadenceMs;
    await persist({
      v: 1,
      goalItemId: goal.itemId,
      status: 'active',
      cadenceMs,
      nextWakeAt: isoFromMs(nextWakeAtMs),
      wakeAttempt: existing?.goalItemId === goal.itemId ? existing.wakeAttempt : 0,
      ...(existing?.goalItemId === goal.itemId && existing.lastWakeAt !== undefined
        ? { lastWakeAt: existing.lastWakeAt }
        : {}),
      ...(existing?.goalItemId === goal.itemId && existing.lastWakeLocalId !== undefined
        ? { lastWakeLocalId: existing.lastWakeLocalId }
        : {}),
      ...(existing?.goalItemId === goal.itemId && existing.inFlightLocalId !== undefined
        ? { inFlightLocalId: existing.inFlightLocalId }
        : {}),
      updatedAt: isoFromMs(nowMs),
    });

    timer = clock.setTimeout(() => {
      timer = null;
      void fireWake();
    }, cadenceMs);
  };

  const fireWake = async (): Promise<void> => {
    if (cancelled) return;
    const nowMs = clock.now();
    const metadata = readMetadata(opts);
    const goal = readActiveGoalSnapshotFromSessionWorkStateMetadata(metadata);
    if (!goal) {
      await clearAutonomyForInactiveGoal(metadata, nowMs);
      return;
    }

    const existing = readSessionAutonomyMetadataV1(metadata);
    if (await hasCompetingInput(opts, existing)) {
      return;
    }

    const attempt = existing?.goalItemId === goal.itemId ? existing.wakeAttempt + 1 : 1;
    const cadenceMs = resolveCadenceMs(opts, existing);
    const localId = buildWakeLocalId(opts.sessionId, goal.itemId, attempt);
    const timestamp = isoFromMs(nowMs);
    await persist({
      v: 1,
      goalItemId: goal.itemId,
      status: 'active',
      cadenceMs,
      nextWakeAt: null,
      lastWakeAt: timestamp,
      wakeAttempt: attempt,
      lastWakeLocalId: localId,
      inFlightLocalId: localId,
      updatedAt: timestamp,
    });
    await opts.enqueueContinuation({
      message: buildSessionAutonomyContinuationPrompt(goal),
      localId,
      goal,
    });
  };

  return {
    async handleProviderIdle(): Promise<void> {
      if (cancelled) return;
      const nowMs = clock.now();
      const metadata = readMetadata(opts);
      const goal = readActiveGoalSnapshotFromSessionWorkStateMetadata(metadata);
      if (!goal) {
        clearTimer();
        await clearAutonomyForInactiveGoal(metadata, nowMs);
        return;
      }

      const existing = readSessionAutonomyMetadataV1(metadata);
      if (await hasCompetingInput(opts, existing)) {
        clearTimer();
        return;
      }
      const dueWakeAt = existing?.goalItemId === goal.itemId ? parseIsoMs(existing.nextWakeAt) : null;
      if (dueWakeAt !== null && dueWakeAt <= nowMs) {
        clearTimer();
        await fireWake();
        return;
      }

      await scheduleWake(goal, metadata, nowMs);
    },

    async handleProviderInputStarted(localId): Promise<void> {
      const normalizedLocalId = typeof localId === 'string' && localId.trim().length > 0 ? localId.trim() : null;
      if (!normalizedLocalId) return;

      const metadata = readMetadata(opts);
      const existing = readSessionAutonomyMetadataV1(metadata);
      if (!existing || existing.inFlightLocalId !== normalizedLocalId) return;

      await persist({
        ...existing,
        inFlightLocalId: null,
        updatedAt: isoFromMs(clock.now()),
      });
    },

    cancel(): void {
      cancelled = true;
      clearTimer();
    },
  };
}
