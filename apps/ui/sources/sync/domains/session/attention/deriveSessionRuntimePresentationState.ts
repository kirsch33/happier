import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;

export type SessionRuntimePresentationState = Readonly<{
    isOnline: boolean;
    isActive: boolean;
    hasTerminalMaterializedTurnStatus: boolean;
    terminalStatus: PrimaryTurnStatusV1 | null;
    freshThinking: boolean;
    freshInProgress: boolean;
    working: boolean;
    runtimeProjectionInProgress: boolean;
    runtimeActivelyWorking: boolean;
    freshPermissionRequired: boolean;
    freshActionRequired: boolean;
}>;

export type DeriveSessionRuntimePresentationStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    meaningfulActivityAt?: number | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
}>;

export type SessionRuntimePresenceFields = Readonly<{
    thinking: boolean;
    thinkingAt: number;
}>;

export function isFreshTimestamp(
    timestamp: number | null | undefined,
    nowMs: number,
    budgetMs: number,
): boolean {
    return typeof timestamp === 'number'
        && Number.isFinite(timestamp)
        && timestamp > 0
        && timestamp + budgetMs > nowMs;
}

export function deriveSessionRuntimePresentationState(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): SessionRuntimePresentationState {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const freshInProgressSignals = readFreshInProgressRuntimeSignalTimestamps(input, nowMs);
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
    const isOnline = input.presence === 'online';
    const isActive = input.active === true;
    const isLiveRuntime = isActive && isOnline;
    const hasTerminalMaterializedTurnStatus = isTerminalPrimaryTurnStatus(latestTurnStatus);
    const blocksLegacyThinking = isLegacyThinkingBlockedByTurnProjection(latestTurnStatus);
    const freshThinking =
        input.thinking === true
        && isLiveRuntime
        && isFreshTimestamp(thinkingAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        && !blocksLegacyThinking;
    const freshInProgress = freshInProgressSignals.length > 0;
    const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
    const hasFreshPendingRequest =
        pendingRequestObservedAt !== null
        && isFreshTimestamp(pendingRequestObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    const hasKnownPendingRequest = pendingRequestObservedAt !== null;
    const hasLivePendingRuntimeRequest =
        isLiveRuntime
        && (input.hasPendingPermissionRequests === true || input.hasPendingUserActionRequests === true)
        && (hasFreshPendingRequest || hasKnownPendingRequest);
    const working = (freshInProgress || freshThinking) && !hasLivePendingRuntimeRequest;
    const runtimeActivelyWorking = isLiveRuntime && working;

    return {
        isOnline,
        isActive,
        hasTerminalMaterializedTurnStatus,
        terminalStatus: hasTerminalMaterializedTurnStatus ? latestTurnStatus : null,
        freshThinking,
        freshInProgress,
        working,
        runtimeProjectionInProgress: freshInProgress,
        runtimeActivelyWorking,
        freshPermissionRequired:
            input.hasPendingPermissionRequests === true
            && isLiveRuntime
            && (working || hasFreshPendingRequest || hasKnownPendingRequest),
        freshActionRequired:
            input.hasPendingUserActionRequests === true
            && isLiveRuntime
            && (working || hasFreshPendingRequest || hasKnownPendingRequest),
    };
}

export function readFreshInProgressRuntimeSignalTimestamps(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): readonly number[] {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt);
    if (latestTurnStatus !== 'in_progress' || latestTurnStatusObservedAt === null) return [];

    const timestamps: number[] = [];
    if (isFreshTimestamp(latestTurnStatusObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) {
        timestamps.push(latestTurnStatusObservedAt);
    }
    const activeAt = normalizeRuntimeStatusTimestamp(input.activeAt);
    if (
        input.active === true
        && input.presence === 'online'
        && activeAt !== null
        && activeAt >= latestTurnStatusObservedAt
        && isFreshTimestamp(activeAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
    ) {
        timestamps.push(activeAt);
    }
    return timestamps;
}

export function readSessionRuntimePresentationFreshnessTimestamps(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): readonly number[] {
    const runtimeStatus = deriveSessionRuntimePresentationState(input, nowMs);
    const timestamps: number[] = [];
    if (runtimeStatus.freshThinking) {
        const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
        if (thinkingAt !== null) timestamps.push(thinkingAt);
    }
    timestamps.push(...readFreshInProgressRuntimeSignalTimestamps(input, nowMs));
    if (runtimeStatus.freshPermissionRequired || runtimeStatus.freshActionRequired) {
        const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
        if (pendingRequestObservedAt !== null) timestamps.push(pendingRequestObservedAt);
    }
    return timestamps;
}

export function resolveSessionRuntimePresenceFields(
    input: Pick<DeriveSessionRuntimePresentationStateInput,
        'thinking' | 'thinkingAt' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'>,
): SessionRuntimePresenceFields {
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt) ?? 0;
    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (isTerminalPrimaryTurnStatus(latestTurnStatus)) {
        return {
            thinking: false,
            thinkingAt: normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt) ?? thinkingAt,
        };
    }
    return {
        thinking: input.thinking === true,
        thinkingAt,
    };
}

export function isTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function isLegacyThinkingBlockedByTurnProjection(latestTurnStatus: PrimaryTurnStatusV1 | null): boolean {
    return isTerminalPrimaryTurnStatus(latestTurnStatus);
}

function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}
