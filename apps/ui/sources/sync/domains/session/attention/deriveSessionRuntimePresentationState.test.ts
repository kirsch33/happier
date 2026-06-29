import { describe, expect, it } from 'vitest';

import {
    deriveSessionRuntimePresentationState,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from './deriveSessionRuntimePresentationState';

describe('deriveSessionRuntimePresentationState', () => {
    it('treats a fresh in-progress turn projection as working without legacy presence evidence', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: false,
            activeAt: 0,
            presence: 0,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.runtimeProjectionInProgress).toBe(true);
        expect(runtimeState.runtimeActivelyWorking).toBe(false);
    });

    it('falls back to fresh legacy thinking when turn fields are absent', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(true);
        expect(runtimeState.working).toBe(true);
    });

    it('treats a completed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('suppresses stale legacy thinking after a terminal turn projection', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 3_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('treats a failed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('keeps pending permission actionable when the pending request itself is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: 0,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.freshPermissionRequired).toBe(true);
        expect(runtimeState.freshActionRequired).toBe(false);
    });

    it('keeps live pending user actions actionable until the request resolves', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.freshPermissionRequired).toBe(false);
        expect(runtimeState.freshActionRequired).toBe(true);
    });

    it('extends stale in-progress projection from a fresh active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
    });

    it('extends stale in-progress projection from a fresh active heartbeat without requiring legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.runtimeProjectionInProgress).toBe(true);
        expect(runtimeState.runtimeActivelyWorking).toBe(true);
    });

    it('does not keep an in-progress turn working from newer meaningful activity alone', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: 0,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not refresh an in-progress turn from older transcript activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 2_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not extend stale in-progress projection from a stale active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });

    it('does not extend an in-progress projection from heartbeat when the observed timestamp is missing', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: null,
        }, nowMs);

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
    });
});
