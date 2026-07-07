export type TranscriptScrollPinState = {
    isPinned: boolean;
    newActivityCount: number;
    lastActivityKey: string | null;
};

export type TranscriptScrollPinEvent =
    | {
        type: 'scroll';
        enabled: boolean;
        offsetY: number;
        pinnedOffsetThresholdPx: number;
    }
    | {
        type: 'newActivity';
        enabled: boolean;
        activityKey: string | null;
    }
    | {
        type: 'resetNewActivity';
    };

export function resolveTranscriptScrollPinStateUpdate(
    state: TranscriptScrollPinState,
    event: TranscriptScrollPinEvent,
): TranscriptScrollPinState | null {
    const next = reduceTranscriptScrollPinState(state, event);
    return next === state ? null : next;
}

export function reduceTranscriptScrollPinState(
    state: TranscriptScrollPinState,
    event: TranscriptScrollPinEvent,
): TranscriptScrollPinState {
    if (event.type === 'resetNewActivity') {
        if (state.newActivityCount === 0) return state;
        return { ...state, newActivityCount: 0 };
    }

    if (event.type === 'scroll') {
        const threshold =
            typeof event.pinnedOffsetThresholdPx === 'number' && Number.isFinite(event.pinnedOffsetThresholdPx)
                ? Math.max(0, Math.trunc(event.pinnedOffsetThresholdPx))
                : 0;
        const offsetY =
            typeof event.offsetY === 'number' && Number.isFinite(event.offsetY) ? event.offsetY : 0;
        const nextPinned = offsetY <= threshold;

        if (!event.enabled) {
            // Disabling automatic pinning must not blind the jump-to-bottom UI.
            // Keep tracking the visual bottom state, but do not retain activity badges.
            if (state.isPinned === nextPinned && state.newActivityCount === 0) return state;
            return { ...state, isPinned: nextPinned, newActivityCount: 0 };
        }

        if (nextPinned) {
            if (state.isPinned && state.newActivityCount === 0) return state;
            return { ...state, isPinned: true, newActivityCount: 0 };
        }

        if (!state.isPinned) return state;
        return { ...state, isPinned: false };
    }

    // newActivity
    if (!event.enabled) return state;

    const key = typeof event.activityKey === 'string' && event.activityKey.length > 0 ? event.activityKey : null;
    if (!key) return state;
    if (state.lastActivityKey === key) return state;

    if (state.isPinned) {
        return { ...state, lastActivityKey: key };
    }

    return {
        ...state,
        lastActivityKey: key,
        newActivityCount: state.newActivityCount + 1,
    };
}
