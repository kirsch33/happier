import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type TranscriptViewportController = Readonly<{
    getMode(): TranscriptViewportMode;
    resolve(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
}>;

export function createTranscriptViewportController(): TranscriptViewportController {
    let sessionId: string | null = null;
    let mode: TranscriptViewportMode = 'hydrating';

    return {
        getMode() {
            return mode;
        },
        resolve(input) {
            if (sessionId !== input.sessionId) {
                sessionId = input.sessionId;
                mode = 'hydrating';
                if (input.type === 'user-scroll' || input.type === 'auto-follow') {
                    return { kind: 'none', sessionId: input.sessionId, reason: 'session-change', mode };
                }
            }

            switch (input.type) {
                case 'first-paint':
                    return resolveFirstPaint(input);
                case 'user-scroll':
                    return resolveUserScroll(input);
                case 'auto-follow':
                    return resolveAutoFollow(input);
                case 'jump-to-bottom':
                    mode = 'jump-to-bottom';
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: 'jump-to-bottom',
                        mode,
                        force: true,
                        animated: true,
                    };
                case 'jump-to-top':
                    mode = 'jump-to-top';
                    return {
                        kind: 'scroll-offset',
                        sessionId: input.sessionId,
                        reason: 'jump-to-top',
                        mode,
                        offsetY: 0,
                        animated: true,
                    };
                case 'pin-bottom':
                    mode = input.mode;
                    return {
                        kind: 'pin-bottom',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        ...(typeof input.force === 'boolean' ? { force: input.force } : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'scroll-offset':
                    mode = input.mode;
                    return {
                        kind: 'scroll-offset',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        offsetY: normalizeNonNegative(input.offsetY),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'restore-anchor':
                    mode = 'restore-anchor';
                    return {
                        kind: 'restore-index',
                        sessionId: input.sessionId,
                        reason: input.reason,
                        mode,
                        index: Math.max(0, Math.trunc(input.index)),
                        ...(typeof input.viewOffset === 'number' && Number.isFinite(input.viewOffset)
                            ? { viewOffset: Math.trunc(input.viewOffset) }
                            : {}),
                        ...(typeof input.animated === 'boolean' ? { animated: input.animated } : {}),
                    };
                case 'jump-to-seq':
                    mode = 'jump-to-seq';
                    return {
                        kind: 'jump-to-seq',
                        sessionId: input.sessionId,
                        reason: 'jump-to-seq',
                        mode,
                        seq: input.seq,
                        ...(typeof input.index === 'number' && Number.isFinite(input.index)
                            ? { index: Math.max(0, Math.trunc(input.index)) }
                            : {}),
                    };
            }
        },
    };

    function resolveFirstPaint(
        input: Extract<TranscriptViewportControllerInput, { type: 'first-paint' }>,
    ): TranscriptViewportCommand {
        if (typeof input.jumpToSeq === 'number' && Number.isFinite(input.jumpToSeq)) {
            mode = 'jump-to-seq';
            return {
                kind: 'jump-to-seq',
                sessionId: input.sessionId,
                reason: 'jump-to-seq',
                mode,
                seq: Math.trunc(input.jumpToSeq),
            };
        }

        const entrySnapshot = input.entrySnapshot ?? null;
        if (entrySnapshot?.shouldFollowBottom === false || input.shouldFollowBottom === false) {
            const anchorIndex = entrySnapshot?.anchorIndex;
            if (typeof anchorIndex === 'number' && Number.isFinite(anchorIndex)) {
                const anchorViewOffset = entrySnapshot?.anchorViewOffset;
                mode = 'restore-anchor';
                return {
                    kind: 'restore-index',
                    sessionId: input.sessionId,
                    reason: 'entry-restore',
                    mode,
                    index: Math.max(0, Math.trunc(anchorIndex)),
                    ...(typeof anchorViewOffset === 'number' && Number.isFinite(anchorViewOffset)
                        ? { viewOffset: Math.trunc(anchorViewOffset) }
                        : {}),
                };
            }

            mode = 'restore-distance';
            return {
                kind: 'restore-offset',
                sessionId: input.sessionId,
                reason: 'entry-restore',
                mode,
                offsetY: normalizeNonNegative(entrySnapshot?.offsetY),
            };
        }

        mode = 'follow-bottom';
        return {
            kind: 'pin-bottom',
            sessionId: input.sessionId,
            reason: 'initial-open',
            mode,
        };
    }

    function resolveUserScroll(
        input: Extract<TranscriptViewportControllerInput, { type: 'user-scroll' }>,
    ): TranscriptViewportCommand {
        if (normalizeNonNegative(input.distanceFromBottom) > normalizeNonNegative(input.pinThresholdPx)) {
            mode = 'user-unpinned';
            return {
                kind: 'none',
                sessionId: input.sessionId,
                reason: 'user-unpinned',
                mode,
            };
        }

        mode = 'follow-bottom';
        return {
            kind: 'none',
            sessionId: input.sessionId,
            reason: 'already-pinned',
            mode,
        };
    }

    function resolveAutoFollow(
        input: Extract<TranscriptViewportControllerInput, { type: 'auto-follow' }>,
    ): TranscriptViewportCommand {
        const distanceFromBottom = normalizeNonNegative(input.distanceFromBottom);
        const pinThresholdPx = normalizeNonNegative(input.pinThresholdPx);
        if (!input.wantsPinned || mode === 'user-unpinned') {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'user-unpinned', mode };
        }
        if (distanceFromBottom <= pinThresholdPx) {
            mode = 'follow-bottom';
            return { kind: 'none', sessionId: input.sessionId, reason: 'already-pinned', mode };
        }
        if (input.recentUserIntent) {
            mode = 'user-unpinned';
            return { kind: 'none', sessionId: input.sessionId, reason: 'recent-user-intent', mode };
        }

        mode = 'follow-bottom';
        if (input.skipNativeJsPin === true) {
            return {
                kind: 'skip-native-js-pin',
                sessionId: input.sessionId,
                reason: input.reason,
                skipReason: 'mvcp-only',
                mode,
            };
        }
        if (typeof input.targetOffsetY === 'number' && Number.isFinite(input.targetOffsetY)) {
            return {
                kind: 'scroll-offset',
                sessionId: input.sessionId,
                reason: input.reason,
                mode,
                offsetY: Math.max(0, Math.trunc(input.targetOffsetY)),
            };
        }
        return {
            kind: 'pin-bottom',
            sessionId: input.sessionId,
            reason: input.reason,
            mode,
        };
    }
}

function normalizeNonNegative(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}
