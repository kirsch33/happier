import { describe, expect, it } from 'vitest';

import { createTranscriptViewportController } from '@/components/sessions/transcript/viewport/createTranscriptViewportController';

describe('transcript viewport controller', () => {
    it('resolves initial follow bottom to a pin command', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'initial-open',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resolves unpinned entry distance to restore offset', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 420,
            },
            jumpToSeq: null,
            platform: 'android',
            listImplementation: 'flash_v2',
        });

        expect(command).toEqual({
            kind: 'restore-offset',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            offsetY: 420,
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('resolves unpinned entry anchor to restore index', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 80,
                anchorIndex: 12,
                anchorViewOffset: 24,
            },
            jumpToSeq: null,
            platform: 'web',
            listImplementation: 'web-fallback',
        });

        expect(command).toEqual({
            kind: 'restore-index',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            index: 12,
            viewOffset: 24,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('prefers jumpToSeq over first paint state', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 420,
                anchorIndex: 12,
            },
            jumpToSeq: 34,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('prefers jump to bottom over unpinned restore', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, offsetY: 420 },
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        const command = controller.resolve({
            type: 'jump-to-bottom',
            sessionId: 'session-a',
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            force: true,
            animated: true,
        });
        expect(controller.getMode()).toBe('jump-to-bottom');
    });

    it('resolves jump to top as an explicit top offset command', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'jump-to-top',
            sessionId: 'session-a',
        });

        expect(command).toEqual({
            kind: 'scroll-offset',
            sessionId: 'session-a',
            reason: 'jump-to-top',
            mode: 'jump-to-top',
            offsetY: 0,
            animated: true,
        });
        expect(controller.getMode()).toBe('jump-to-top');
    });

    it('resolves fallback bottom pins through the controller', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('resolves dynamic-height scroll-offset fallbacks through the controller', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'scroll-offset',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            offsetY: 123.8,
            animated: true,
        });

        expect(command).toEqual({
            kind: 'scroll-offset',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            offsetY: 123,
            animated: true,
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('resolves explicit anchor restores without first-paint semantics', () => {
        const controller = createTranscriptViewportController();

        const command = controller.resolve({
            type: 'restore-anchor',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            index: 7.8,
            viewOffset: -42.5,
            animated: false,
        });

        expect(command).toEqual({
            kind: 'restore-index',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            index: 7,
            viewOffset: -42,
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('does not repin passive drift while user unpinned', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: false,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'user-unpinned',
            mode: 'user-unpinned',
        });
        expect(controller.getMode()).toBe('user-unpinned');
    });

    it('preserves automatic native MVCP-only skip reason', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'initial-open',
            targetOffsetY: 420,
            skipNativeJsPin: true,
        } as Parameters<typeof controller.resolve>[0]);

        expect(command).toEqual({
            kind: 'skip-native-js-pin',
            sessionId: 'session-a',
            reason: 'initial-open',
            skipReason: 'mvcp-only',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('settles jump to bottom back to follow bottom', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({ type: 'jump-to-bottom', sessionId: 'session-a' });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 0,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'already-pinned',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resets to hydrating on session identity change', () => {
        const controller = createTranscriptViewportController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        const command = controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-b',
            distanceFromBottom: 200,
            pinThresholdPx: 80,
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-b',
            reason: 'session-change',
            mode: 'hydrating',
        });
        expect(controller.getMode()).toBe('hydrating');
    });

    it('uses adapter-specific command targets for shared modes', () => {
        const webController = createTranscriptViewportController();
        const nativeController = createTranscriptViewportController();

        const webCommand = webController.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, offsetY: 120 },
            jumpToSeq: null,
            platform: 'web',
            listImplementation: 'web-fallback',
        });
        const nativeCommand = nativeController.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: { shouldFollowBottom: false, offsetY: 120 },
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        expect(webCommand).toMatchObject({ kind: 'restore-offset', mode: 'restore-distance', offsetY: 120 });
        expect(nativeCommand).toMatchObject({ kind: 'restore-offset', mode: 'restore-distance', offsetY: 120 });
    });
});
