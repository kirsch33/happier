import * as React from 'react';
import {
    getStorage,
    useForkedTranscriptSnapshot,
    useMessage,
    useSessionChatFooterState,
    useSessionActionDrafts,
    useSessionLatestThinkingMessageId,
    useSessionLatestThinkingMessageActivityAtMs,
    useSessionMessages,
    useSessionMessagesById,
    useSessionPendingMessages,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { Dimensions, FlatList, PixelRatio, Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, LayoutCommitObserver } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { useCallback } from 'react';
import { MessageView, MessageViewWithSessionCommon } from './MessageView';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { buildSessionMetadataStabilitySignatureValue, buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { buildSessionTranscriptRenderSignature } from '@/sync/domains/session/transcriptRenderSignature';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { ChatFooter, type ChatFooterDirectControlState } from './ChatFooter';
import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import { buildForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import { insertForkDividersIntoTranscriptItems, type ForkDividerTranscriptItem } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import { PendingMessagesTranscriptBlock, type PendingMessageEditRequest } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { useSessionCatchingUpNewer } from '@/sync/store/hooks';
import { jumpToTranscriptSeq } from '@/utils/sessions/jumpToTranscriptSeq';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildTranscriptTurnsCached, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { buildTranscriptTurnUnits } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { shouldAutoExpandToolCallsGroupForShortTranscript } from '@/components/sessions/transcript/toolCalls/resolveToolCallsGroupAutoExpandPolicy';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { JumpToTopButton } from '@/components/sessions/transcript/scroll/JumpToTopButton';
import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { resolveNextJumpToBottomDistanceVisibilityState } from '@/components/sessions/transcript/scroll/jumpToBottomVisibilityDistanceState';
import {
    resolveTranscriptScrollPinStateUpdate,
    type TranscriptScrollPinEvent,
    type TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptScrollPinController';
import { subscribeToFlashListOffsetCorrections } from '@/components/sessions/transcript/scroll/flashListOffsetCorrectionHook';
import {
    resolveTranscriptRowContentCount,
    resolveTranscriptRowViewportRelation,
} from '@/components/sessions/transcript/scroll/transcriptRowEvidence';
import {
    configureTranscriptViewportTelemetryFromTuning,
    recordTranscriptViewportTelemetryEvent,
    resolveTranscriptViewportTelemetryListImplementation,
    resolveTranscriptViewportTelemetryPlatform,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryBlankAreaSource,
    type TranscriptViewportTelemetryBottomFollowMode,
    type TranscriptViewportTelemetryListOrientation,
    type TranscriptViewportTelemetryLiveTailAnchorKind,
    type TranscriptViewportTelemetryMvcpPolicy,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryScrollWriter,
    type TranscriptViewportTelemetryVisibleWindowSource,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    createTranscriptViewportCommandController,
    type TranscriptViewportCommandController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import {
    type TranscriptViewportTransactionOutcome,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import { resolveInitialWebPinRetryDelays } from '@/components/sessions/transcript/scroll/resolveInitialWebPinRetryDelays';
import { resolveWebPinRetryTimeoutMs } from '@/components/sessions/transcript/scroll/resolveWebPinRetryTimeoutMs';
import { resolveSessionEntryBottomFollow } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import { resolveTranscriptBottomFollowIntent } from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import { canAutoFollowTranscriptBottom, isExplicitTranscriptBottomFollowCommand } from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
import {
    resolveTranscriptBottomFollowMode,
    type TranscriptBottomFollowModeState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    resolveTranscriptFlashListBottomMaintenance,
    type TranscriptFlashListBottomMaintenanceResult,
} from '@/components/sessions/transcript/scroll/transcriptFlashListBottomMaintenance';
import {
    fromCanonicalScrollOffset,
    orientTranscriptListItems,
    resolveBottomRawScrollCommandOffset,
    resolveBottomRawScrollOffset,
    resolveEntrySliceSourceBounds,
    resolveOlderNeighborRenderedIndex,
    resolveOrientedListEdgeSlots,
    resolveTranscriptListPresentation,
    toCanonicalScrollOffset,
    type TranscriptListOrientation,
} from '@/components/sessions/transcript/listOrientation';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    isEnrichedMarkdownRuntimePreloaded,
    preloadEnrichedMarkdownRuntime,
} from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteractionFromSession, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';
import { buildChatListNativeId } from './chatListNativeId';
import { useWebFlashListCrashFallback } from '@/components/ui/lists/useWebFlashListCrashFallback';
import {
    TranscriptMessageSelectionBoundary,
    useOptionalTranscriptSelectionState,
} from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import { resolveNativeInvertedColdScrollIndex, resolveWebColdListScrollTarget } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import { TranscriptHotTail } from '@/components/sessions/transcript/segments/TranscriptHotTail';
import { resolvePendingWebPrependAnchorIndex as resolvePendingWebPrependAnchorItemIndex } from '@/components/sessions/transcript/webTranscriptPrependAnchorIndex';
import {
    isMessageRolledBack,
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
    type TranscriptRollbackAction,
    type SessionRollbackRangeV1,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptMaxScrollTop,
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { resolveWebBottomFollowAdjustment } from '@/components/sessions/transcript/scroll/resolveWebBottomFollowAdjustment';
import { WebTranscriptSplitFooter } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    ComposerKeyboardFloatingInset,
    ComposerKeyboardScrollInset,
} from '@/components/sessions/keyboardAvoidance';
import {
    captureWebTranscriptPrependAnchor,
    captureWebTranscriptViewportAnchor,
    refreshWebTranscriptPrependAnchor,
    resolveWebTranscriptViewportAnchorAlignment,
    restoreWebTranscriptPrependAnchor,
    restoreWebTranscriptViewportAnchor,
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependAnchor,
    type WebTranscriptPrependRestoreResult,
    type WebTranscriptViewportAnchor,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { resolveWebTranscriptPrependRangeReservePx } from '@/components/sessions/transcript/webTranscriptPrependRangeReserve';
import {
    captureNativeTranscriptViewportAnchor,
    planNativeTranscriptViewportAnchorRestore,
    resolveNativeTranscriptViewportAnchorRestoreObservation,
} from '@/components/sessions/transcript/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/transcriptViewportAnchorResolution';
import { resolveTranscriptJumpSeqIndex } from '@/components/sessions/transcript/transcriptJumpSeqIndexResolution';
import {
    clearStreamingSessionUiTelemetryMarks,
    readSessionUiTelemetryNowMs,
    recordSessionOpenPaintForSessionUiTelemetry,
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_TOP_GUTTER_PX,
    TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX,
} from '@/components/sessions/transcript/_constants';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationSnapshot,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';
import {
    observePrependOutcome,
    type PrependCapturedAnchor,
    type PrependOutcome,
} from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';
import {
    createPrependFallbackQuietGate,
    type PrependFallbackQuietGate,
} from '@/components/sessions/transcript/viewport/prepend/prependFallbackQuietGate';
import {
    createPrependTransaction,
    type PrependTransaction,
} from '@/components/sessions/transcript/viewport/prepend/prependTransaction';
import { LruMap } from '@/utils/cache/lruMap';
import {
    buildTranscriptItemHeightSignatureKey,
    getDefaultTranscriptItemHeightCache,
    type TranscriptItemHeightValiditySignature,
} from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import {
    createTranscriptMeasurementReconciler,
    isStructuralSignatureDelta,
    type TranscriptMeasurementReconciler,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import {
    TranscriptRowLayoutMutationProvider,
    type TranscriptRowLayoutMutation,
} from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { resolveTranscriptRowShellHeight } from '@/components/sessions/transcript/measurement/resolveTranscriptRowShellHeight';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptItemActiveThinkingMessageId,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';
import {
    createTranscriptMountSettlePinCoordinator,
    type TranscriptMountSettlePinCoordinator,
    type TranscriptMountSettleTuning,
} from '@/components/sessions/transcript/scroll/transcriptMountSettlePinCoordinator';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
    hasTranscriptWarmStablePaint,
    rememberTranscriptWarmStablePaint,
} from '@/components/sessions/transcript/paint/transcriptWarmPaintCache';
import {
    nativeBottomFollowCanApplyCompletion,
    nativeBottomFollowCanCompletePendingPin,
    nativeBottomFollowPinTargetObserved,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';
import {
    nativeEntryRestoreObservationMatches,
    resolveNativeSliceEntryObservation,
} from '@/components/sessions/transcript/viewport/nativeEntryRestoreObservationPolicy';
import {
    createEntryRestoreTransaction,
    type EntryRestoreTransaction,
    type EntryRestoreTransactionTarget,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreTransaction';
import {
    resolveEntryRestoreTarget,
    type EntryRestoreSliceTarget,
} from '@/components/sessions/transcript/viewport/entryRestore/resolveEntryRestoreTarget';
import {
    shouldIgnoreNativeInvalidScrollObservation as resolveShouldIgnoreNativeInvalidScrollObservation,
    shouldIgnoreNativePassiveViewportScroll as resolveShouldIgnoreNativePassiveViewportScroll,
    shouldRecordNativePassiveUnpinnedMovement as resolveShouldRecordNativePassiveUnpinnedMovement,
} from '@/components/sessions/transcript/viewport/nativePassiveScrollPolicy';

type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
    scrollToEnd?: (params?: { animated?: boolean }) => void;
    clearLayoutCacheOnUpdate?: () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

type ChatTranscriptListItem = TranscriptRowShellItem;

type TranscriptLiveTailAnchorReason = TranscriptViewportTelemetryLiveTailAnchorKind;
type TranscriptLiveTailAnchor = Readonly<{ messageId: string; reason: TranscriptLiveTailAnchorReason }> | null;

/**
 * Classify a candidate live-tail row: a per-token-streaming assistant message, or an in-flight
 * (running) tool call. Returns null for everything else (the carve does not engage on it directly).
 *
 * BOTH live-tail signals are scoped to `sessionActive` (R2 + defense-in-depth): a tool left
 * `running`, OR an assistant segment left `segmentState:'streaming'`, after a disconnect / missed
 * completion / interrupted turn on an otherwise-idle session must NOT keep the carve open, or its
 * trailing rows would be permanently detached into the edge slot — the exact idle orphan the carve
 * exists to avoid. A streaming assistant segment is normally self-gating (the reducer clears
 * `segmentState` on finalize), but that clear can be missed (interrupt / reconnect) leaving a stale
 * `streaming` flag far up a completed transcript; gating on `sessionActive` makes the carve fail
 * closed on an idle session regardless of a stale segment marker. `sessionActive` is true throughout
 * a genuinely-active streaming turn, so the legitimate live case is unaffected.
 */
function classifyLiveTailAnchorMessage(
    message: Message | null,
    sessionActive: boolean,
): 'streaming-message' | 'streaming-tool' | null {
    if (!message) return null;
    if (!sessionActive) return null;
    if (message.kind === 'tool-call') {
        return message.tool?.state === 'running' ? 'streaming-tool' : null;
    }
    if (message.kind !== 'agent-text') return null;
    return readStreamSegmentMetaV1(message.meta)?.segmentState === 'streaming' ? 'streaming-message' : null;
}

/**
 * Derive the native edge-slot carve anchor (plan §12 #1). The anchor is the FIRST actively-streaming
 * row (assistant text or running tool, scanning oldest→newest so the carve runs anchor→end). When no
 * row is detectably mid-stream this frame, two fallbacks keep the carve from collapsing mid-turn:
 *   1. `thinkingFallbackMessageId` (activeThinkingMessageId) — the live thinking pulse row.
 *   2. the WHOLE-TURN floor: while `turnActive` (`session.thinking` spans the whole turn) and a
 *      committed row exists, anchor at `latestCommittedActivityKey`. This is what prevents the carve
 *      collapsing at the thinking→answer / text→tool transition frame (where the thinking pulse has
 *      cleared and the next row has not yet been flagged streaming). Idle (turnActive false, nothing
 *      streaming) returns null → no carve → no orphaned trailing block.
 */
function resolveTranscriptLiveTailAnchor(params: Readonly<{
    items: readonly ChatTranscriptListItem[];
    getMessageById: (messageId: string) => Message | null;
    thinkingFallbackMessageId: string | null;
    turnActive: boolean;
    sessionActive: boolean;
    latestCommittedActivityKey: string | null;
}>): TranscriptLiveTailAnchor {
    const sessionActive = params.sessionActive;
    for (const item of params.items) {
        if (item.kind === 'message') {
            const reason = classifyLiveTailAnchorMessage(params.getMessageById(item.messageId), sessionActive);
            if (reason) return { messageId: item.messageId, reason };
            continue;
        }

        if (
            item.kind === 'tool-calls-group' ||
            item.kind === 'tool-group-header' ||
            item.kind === 'tool-group-expand' ||
            item.kind === 'tool-group-tool' ||
            item.kind === 'tool-group-footer'
        ) {
            for (const messageId of item.toolMessageIds) {
                const reason = classifyLiveTailAnchorMessage(params.getMessageById(messageId), sessionActive);
                if (reason) return { messageId, reason };
            }
            continue;
        }

        if (item.kind === 'turn') {
            if (item.turn.userMessageId) {
                const reason = classifyLiveTailAnchorMessage(params.getMessageById(item.turn.userMessageId), sessionActive);
                if (reason) return { messageId: item.turn.userMessageId, reason };
            }
            for (const contentItem of item.turn.content) {
                if (contentItem.kind === 'message') {
                    const reason = classifyLiveTailAnchorMessage(params.getMessageById(contentItem.messageId), sessionActive);
                    if (reason) return { messageId: contentItem.messageId, reason };
                    continue;
                }
                if (contentItem.kind === 'tool_calls') {
                    for (const messageId of contentItem.toolMessageIds) {
                        const reason = classifyLiveTailAnchorMessage(params.getMessageById(messageId), sessionActive);
                        if (reason) return { messageId, reason };
                    }
                }
            }
        }
    }

    if (params.thinkingFallbackMessageId != null) {
        return { messageId: params.thinkingFallbackMessageId, reason: 'thinking' };
    }

    // The whole-turn floor must fail closed on an idle session exactly like the streaming-message and
    // running-tool anchors (FIX 1 / orphan-safe). A `thinking && !active` state (a debounced thinking
    // grace flag lingering after the turn ended, or a thinking flag stuck across a disconnect) is NOT
    // a live turn — anchoring on it would detach the trailing block into the edge slot with no growing
    // row to justify it (the idle orphan). A genuinely-active turn is BOTH active and thinking, so the
    // legitimate live case (incl. the Gemini/legacy no-segment-meta path) is unaffected.
    if (sessionActive && params.turnActive && params.latestCommittedActivityKey != null) {
        return { messageId: params.latestCommittedActivityKey, reason: 'turn-floor' };
    }

    return null;
}

function measureTranscriptDerivation<T>(
    name: string,
    buildFields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, buildFields(), fn);
}

/**
 * Host-side context for the single entry-restore write (plan F2): everything the
 * alignment predicate and the one allowed correction need to re-derive targets.
 * The transaction itself (`entryRestoreTransaction.ts`) owns the write budget.
 */
type EntryRestoreWriteContext = Readonly<{
    anchor: SessionViewportAnchorSnapshot | null;
    createdAtMs: number;
    /** Remembered distance from the bottom of the transcript, in px. */
    distanceFromBottom: number;
    /** Canonical content height (scroll-event contentSize basis) at issue time. */
    issuedContentHeight: number;
    issuedLayoutHeight: number;
    /**
     * `slice-anchor` (N2b.2): the entry's initial act was the data-window slice —
     * an observe-only transaction that confirms the visible anchor still sits at
     * the saved pixel offset and can never authorize a write.
     */
    kind: 'anchor' | 'distance' | 'bottom' | 'slice-anchor';
    sessionId: string;
    targetOffsetY: number | null;
    targetOffsetYWasClamped: boolean;
}>;

type LastNativeRestoreIndexCommand = Readonly<{
    index: number;
    issuedAtMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    viewOffset?: number;
}>;

type NativeVisibleWindowSnapshot = Readonly<{
    blankAreaPx: number;
    blankAreaSource: TranscriptViewportTelemetryBlankAreaSource;
    firstVisibleItemId?: string;
    hasVisibleRows: boolean;
    lastVisibleItemId?: string;
    lastKnownFirstVisibleItemId?: string;
    lastKnownLastVisibleItemId?: string;
    visibleWindowStale?: boolean;
    visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource;
}>;

type NativeViewableTranscriptItem = Readonly<{
    index?: number | null;
    isViewable?: boolean;
    item?: ChatTranscriptListItem | null;
}>;

type ScheduledPinToBottom = {
    kind: 'raf' | 'timeout';
    id: any;
    previousWebMetrics: WebTranscriptScrollMetrics | null;
    reason: TranscriptViewportTelemetryScrollReason;
    /**
     * Native hot/cold carve only: snapshot of "was following the live tail at the inverted bottom"
     * taken BEFORE the data/layout change. The post-change distance is unreliable on native because
     * FlashList MVCP offset-correction re-anchors the index-0 (live-tail-advance) insert; this
     * pre-change decision lets the bottom pin fire authoritatively (mirrors web's capture-before).
     */
    nativePrevFollowAtBottom?: boolean;
};

const EMPTY_MESSAGES_BY_ID: Readonly<Record<string, Message>> = Object.freeze({});
const TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS = 200;
const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
const TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS = 500;
// Plan E3: consecutive same-direction non-programmatic web scroll frames required before the
// movement heuristic treats it as user intent (scrollbar drag / keyboard scrolling, which fire
// no wheel/pointer/touch handlers). A single frame can be virtualization height-churn noise.
const TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES = 2;
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX = 600;
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX = 1200;
const TRANSCRIPT_NATIVE_ENTRY_SLICE_HEAD_OFFSET_TOLERANCE_PX = 2;
const TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS = 32;
const TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX = 12;
const TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX = 4;
const TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS = 1500;
const TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS = 250;
const TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS = 16;
const TRANSCRIPT_ROW_WIDTH_BUCKET_PX = 64;

function resolveIndexScrollWriter(params: Readonly<{
    platform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
    listImplementation: string;
}>): TranscriptViewportTelemetryScrollWriter {
    if (params.platform === 'web') return 'web-scroll-to-index';
    if (params.listImplementation === 'flatlist_legacy') return 'legacy-scroll-to-index';
    return 'native-scroll-to-index';
}

function resolveNativeScrollEventMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function canUseWriteFreeEntrySliceForAnchorOffset(itemOffsetPx: number): boolean {
    return (
        Number.isFinite(itemOffsetPx) &&
        Math.abs(itemOffsetPx) <= TRANSCRIPT_NATIVE_ENTRY_SLICE_HEAD_OFFSET_TOLERANCE_PX
    );
}

function readFiniteTelemetryNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTelemetryBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function resolveNativeTelemetryMvcpPolicy(
    maintenance: TranscriptFlashListBottomMaintenanceResult | undefined,
): TranscriptViewportTelemetryMvcpPolicy {
    if (!maintenance) return 'default';
    if ('disabled' in maintenance && maintenance.disabled === true) return 'disabled';
    if (
        'startRenderingFromBottom' in maintenance &&
        maintenance.startRenderingFromBottom === true
    ) {
        if (typeof maintenance.autoscrollToBottomThreshold === 'number') return 'autoscroll-threshold';
        return 'start-rendering-from-bottom';
    }
    return 'default';
}

function readTouchPageY(event: unknown): number | null {
    const nativeEvent = (event as { nativeEvent?: unknown } | null | undefined)?.nativeEvent as Record<string, unknown> | undefined;
    if (!nativeEvent) return null;
    const candidates = [
        nativeEvent.pageY,
        nativeEvent.locationY,
        Array.isArray(nativeEvent.touches)
            ? (nativeEvent.touches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
        Array.isArray(nativeEvent.changedTouches)
            ? (nativeEvent.changedTouches[0] as Record<string, unknown> | undefined)?.pageY
            : undefined,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
    }
    return null;
}

function withTranscriptViewportCommandAnimation(
    command: TranscriptViewportCommand,
    animated: boolean,
): TranscriptViewportCommand {
    switch (command.kind) {
        case 'pin-bottom':
        case 'scroll-offset':
        case 'restore-offset':
        case 'restore-index':
        case 'jump-to-seq':
            return { ...command, animated };
        case 'none':
        case 'skip-native-js-pin':
            return command;
    }
}

type TranscriptDerivedItemsCacheEntry = {
    linearItemsCache: ChatListItemsBuildCache | null;
    turnsCache: TranscriptTurnsBuildCache | null;
};

const transcriptDerivedItemsCacheBySessionId = new LruMap<string, TranscriptDerivedItemsCacheEntry>({
    maxEntries: TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS,
});

function resolveTranscriptDerivedItemsCacheMaxSessions(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS;
    }
    return Math.max(1, Math.min(64, Math.trunc(value)));
}

function readTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
): TranscriptDerivedItemsCacheEntry {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId);
    if (existing) return existing;
    const entry: TranscriptDerivedItemsCacheEntry = {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, entry);
    return entry;
}

function writeTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
    patch: Partial<TranscriptDerivedItemsCacheEntry>,
): void {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId) ?? {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, {
        ...existing,
        ...patch,
    });
}

type LoadOlderOptions = Readonly<{
    loadingIndicatorDelayMs?: number;
    preservePrependViewport?: boolean;
    showLoadingIndicator?: boolean;
}>;

type SyncLoadOlderOptions = Readonly<{
    limit: number;
}>;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

function readSessionViewportForEntry(
    sessionId: string,
    options?: Readonly<{ jumpToSeq?: number | null; platformOS?: typeof Platform.OS }>,
) {
    if (options?.platformOS === 'web' && options.jumpToSeq == null) return null;
    return typeof sync.getSessionViewport === 'function' ? sync.getSessionViewport(sessionId) : null;
}

function buildRollbackActionsInputSignature(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string {
    let signature = '';
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) {
            signature += `${messageId}:missing|`;
            continue;
        }
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : '';
        signature += `${message.id}:${message.kind}:${seq}`;
        if (message.kind === 'user-text') {
            signature += `:${message.text}`;
        }
        signature += '|';
    }
    return signature;
}

function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({ signature, value });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}

function resolveTranscriptRowWidthBucket(width: unknown): string {
    const normalizedWidth = typeof width === 'number' && Number.isFinite(width)
        ? Math.max(1, Math.trunc(width))
        : 1;
    const bucket = Math.max(
        TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
        Math.ceil(normalizedWidth / TRANSCRIPT_ROW_WIDTH_BUCKET_PX) * TRANSCRIPT_ROW_WIDTH_BUCKET_PX,
    );
    return `width:${bucket}`;
}

function resolveInitialTranscriptRowWidthBucket(): string {
    return resolveTranscriptRowWidthBucket(Dimensions.get('window')?.width);
}

function resolveFontScaleKey(): string {
    const fontScale = typeof PixelRatio.getFontScale === 'function'
        ? PixelRatio.getFontScale()
        : Dimensions.get('window')?.fontScale;
    const normalized = typeof fontScale === 'number' && Number.isFinite(fontScale)
        ? Math.max(0.5, fontScale)
        : 1;
    return `font:${Math.round(normalized * 100)}`;
}

function resolveTranscriptMountSettleTuning(): TranscriptMountSettleTuning {
    const tuning = sync.getSyncTuning();
    return {
        quiescentWindowMs: tuning.transcriptMountSettleQuiescentWindowMs,
        dimensionNoiseFloorPx: tuning.transcriptMountSettleDimensionNoiseFloorPx,
        bottomDistanceNoiseFloorPx: tuning.transcriptMountSettleBottomDistanceNoiseFloorPx,
    };
}

export type TranscriptViewportChangeState = Readonly<{
    isPinned: boolean;
    offsetY: number;
    shouldRestoreViewport: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

type ChatListProps = Readonly<{
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
}>;

function areChatListSessionRelevantPropsEqual(left: Session, right: Session): boolean {
    return buildSessionTranscriptRenderSignature(left) === buildSessionTranscriptRenderSignature(right);
}

function areChatListNonSessionPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    return left.bottomNotice === right.bottomNotice
        && left.controlledByUserOverride === right.controlledByUserOverride
        && left.controlSwitchTo === right.controlSwitchTo
        && left.onRequestSwitchToRemote === right.onRequestSwitchToRemote
        && left.directControlFooter === right.directControlFooter
        && left.approvalRequests === right.approvalRequests
        && left.jumpToSeq === right.jumpToSeq
        && left.followBottomIntentKey === right.followBottomIntentKey
        && left.onViewportChange === right.onViewportChange
        && left.onEditPendingMessage === right.onEditPendingMessage
        && left.isWarmKeepAliveInstance === right.isWarmKeepAliveInstance
        && left.routeHydrationPending === right.routeHydrationPending;
}

function areChatListPropsEqual(left: ChatListProps, right: ChatListProps): boolean {
    if (!areChatListNonSessionPropsEqual(left, right)) return false;
    if (left.session === right.session) return true;
    return areChatListSessionRelevantPropsEqual(left.session, right.session);
}

export const ChatList = React.memo(function ChatList(props: ChatListProps) {
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'ChatList.preloadEnrichedMarkdownRuntime' });
    }, []);

    const fork = useForkedTranscriptSnapshot(props.session.id);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(props.session.id);
    const childMessagesById = useSessionMessagesById(props.session.id);
    const forkedTranscriptEnabled = fork != null;
    const swrFallbackCandidateEnabled = !forkedTranscriptEnabled && childMessageIdsOldestFirst.length === 0;
    const { messages: swrCommittedMessages } = useSessionMessages(props.session.id, { enabled: swrFallbackCandidateEnabled });
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.session.id);
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;

    const swrFallbackEnabled = !forkedTranscriptEnabled
        && childMessageIdsOldestFirst.length === 0
        && swrCommittedMessages.length > 0;
    const swrFallbackMessageIdsOldestFirst = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessageIdsOldestFirst;
        return swrCommittedMessages.map((message) => message.id);
    }, [childMessageIdsOldestFirst, swrCommittedMessages, swrFallbackEnabled]);
    const swrFallbackMessagesById = React.useMemo(() => {
        if (!swrFallbackEnabled) return childMessagesById;
        const out: Record<string, Message> = {};
        for (const message of swrCommittedMessages) {
            out[message.id] = message;
        }
        return out;
    }, [childMessagesById, swrCommittedMessages, swrFallbackEnabled]);

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(props.session.id), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, props.session.id]);

    const forkAwareMessageDescriptors = React.useMemo(() => {
        if (!forkedTranscriptEnabled || !fork) return null;
        return buildForkAwareMessageDescriptors(fork);
    }, [fork, forkedTranscriptEnabled]);
    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messageIdsOldestFirst as string[];
        }
        return swrFallbackMessageIdsOldestFirst;
    }, [forkAwareMessageDescriptors, swrFallbackMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messagesById as Record<string, Message>;
        }
        return swrFallbackMessagesById;
    }, [forkAwareMessageDescriptors, swrFallbackMessagesById]);
    const committedMessagesForPendingRequests = React.useMemo(() => (
        messageIdsOldestFirst
            .map((messageId) => messagesById[messageId])
            .filter((message): message is Message => Boolean(message))
    ), [messageIdsOldestFirst, messagesById]);
    const pendingUserActionRequests = React.useMemo(
        () => listPendingUserActionRequests(props.session, committedMessagesForPendingRequests),
        [committedMessagesForPendingRequests, props.session],
    );
    const sessionMetadataSignature = React.useMemo(
        () => buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(props.session.metadata ?? null)),
        [props.session.metadata],
    );
    const stableSessionMetadata = useStableValueBySignature(props.session.metadata, sessionMetadataSignature);

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const syncTuning = sync.getSyncTuning();
    const derivedItemsCacheMaxSessions = resolveTranscriptDerivedItemsCacheMaxSessions(
        syncTuning.transcriptDerivedItemsCacheMaxSessions,
    );
    const transcriptMaxTurnEntriesPerListItem = syncTuning.transcriptMaxTurnEntriesPerListItem;
    const derivedItemsCacheEntry = readTranscriptDerivedItemsCacheEntry(
        props.session.id,
        derivedItemsCacheMaxSessions,
    );
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.turns', () => ({
            cacheProvided: derivedItemsCacheEntry.turnsCache ? 1 : 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
        }), () => {
            return buildTranscriptTurnsCached({
                cache: derivedItemsCacheEntry.turnsCache,
                messageIdsOldestFirst,
                messagesById,
                groupToolCalls,
                toolCallsGroupStrategy,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [forkAwareMessageDescriptors, groupingMode, messageIdsOldestFirst, messagesById, groupToolCalls, toolCallsGroupStrategy]);

    React.useEffect(() => {
        if (groupingMode !== 'turns' || !turnsCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            turnsCache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, props.session.id, turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return measureTranscriptDerivation('ui.sessions.transcript.derived.linearItems', () => ({
            actionDraftCount: actionDrafts.length,
            cacheProvided: derivedItemsCacheEntry.linearItemsCache ? 1 : 0,
            discardedPendingCount: discardedPendingMessages?.length ?? 0,
            forked: forkAwareMessageDescriptors ? 1 : 0,
            groupToolCalls: groupToolCalls ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            pendingCount: pendingMessages.length,
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            return buildChatListItemsCached({
                cache: derivedItemsCacheEntry.linearItemsCache,
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                groupConsecutiveToolCalls: groupToolCalls,
                forkBoundaryBeforeMessageIds: forkAwareMessageDescriptors?.forkBoundaryBeforeMessageIds,
                forkBoundarySignature: forkAwareMessageDescriptors?.forkBoundarySignature,
                forkMetadataByMessageId: forkAwareMessageDescriptors?.metadataByMessageId,
            });
        });
    }, [actionDrafts, forkAwareMessageDescriptors, groupingMode, groupToolCalls, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, pendingUserActionRequests]);

    React.useEffect(() => {
        if (groupingMode === 'turns' || !linearCache) return;
        writeTranscriptDerivedItemsCacheEntry(props.session.id, derivedItemsCacheMaxSessions, {
            linearItemsCache: linearCache.cache,
        });
    }, [derivedItemsCacheMaxSessions, groupingMode, linearCache, props.session.id]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return measureTranscriptDerivation('ui.sessions.transcript.derived.groupedItems', () => ({
            actionDraftCount: actionDrafts.length,
            forked: forkedTranscriptEnabled && fork ? 1 : 0,
            messageCount: messageIdsOldestFirst.length,
            modeTurns: groupingMode === 'turns' ? 1 : 0,
            pendingCount: pendingMessages.length + (discardedPendingMessages?.length ?? 0),
            pendingUserActionCount: pendingUserActionRequests.length,
        }), () => {
            if (groupingMode !== 'turns') {
                const base = linearCache?.items ?? buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages: discardedPendingMessages, pendingUserActionRequests, actionDrafts });
                if (!forkedTranscriptEnabled || !fork) return base;
                return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
            }

            const trailing = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages,
                discardedMessages: discardedPendingMessages,
                pendingUserActionRequests,
                actionDrafts,
                includeCommittedMessages: false,
            });

            // N2c: turn items are emitted UNDECOMPOSED here; per-unit decomposition for
            // flash_v2 happens inside ChatListInternal where tool-group expansion state lives.
            const turns = turnsCache?.turns ?? [];
            const turnItems: ForkDividerTranscriptItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
            const base: ForkDividerTranscriptItem[] = [...turnItems, ...trailing];
            if (!forkedTranscriptEnabled || !fork) return base;
            return insertForkDividersIntoTranscriptItems({ items: base, fork }) as ChatTranscriptListItem[];
        });
    }, [actionDrafts, fork, forkedTranscriptEnabled, groupingMode, linearCache, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, pendingUserActionRequests, turnsCache]);

    const latestCommittedActivityKey =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    const rollbackActionsInputSignature = React.useMemo(
        () => buildRollbackActionsInputSignature({ messageIdsOldestFirst, messagesById }),
        [messageIdsOldestFirst, messagesById],
    );
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session: props.session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
        }),
        [
            props.session.accessLevel,
            props.session.active,
            props.session.sessionTurns,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
        ],
    );

    const latestThinkingMessageId = useSessionLatestThinkingMessageId(props.session.id);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(props.session.id);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (props.session.thinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, props.session.thinking, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: props.session.thinking === true,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            active: props.session.active,
            presence: props.session.presence,
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.active, props.session.presence]);
    const internalMessagesById = forkedTranscriptEnabled ? messagesById : EMPTY_MESSAGES_BY_ID;

    return (
        <TranscriptMessageSelectionBoundary
            key={props.session.id}
            sessionId={props.session.id}
            eligibleMessageIdsInOrder={messageIdsOldestFirst}
            enabled={transcriptSessionCommon.messageDisplay.transcriptMessageSelectionEnabled === true}
        >
            <SyncPerformanceReactProfiler id="sessions.transcript.chatList">
                <ChatListInternal
                    metadata={stableSessionMetadata}
                sessionId={props.session.id}
                sessionActive={props.session.active === true}
                sessionThinking={props.session.thinking === true}
                groupingMode={groupingMode}
                forkedTranscriptEnabled={forkedTranscriptEnabled}
                items={groupedItems}
                maxTurnEntriesPerListItem={transcriptMaxTurnEntriesPerListItem}
                messagesById={internalMessagesById}
                forkMessageMetadataById={forkAwareMessageDescriptors?.metadataByMessageId ?? null}
                committedMessagesCount={messageIdsOldestFirst.length}
                latestCommittedActivityKey={latestCommittedActivityKey}
                activeThinkingMessageId={activeThinkingMessageId}
                rollbackRanges={rollbackRanges}
                rollbackActionsByMessageId={rollbackActionsByMessageId}
                isLoaded={isLoaded}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControlFooter={props.directControlFooter}
                approvalRequests={props.approvalRequests}
                interaction={interaction}
                jumpToSeq={props.jumpToSeq ?? null}
                followBottomIntentKey={props.followBottomIntentKey ?? null}
                onViewportChange={props.onViewportChange}
                onEditPendingMessage={props.onEditPendingMessage}
                isWarmKeepAliveInstance={props.isWarmKeepAliveInstance === true}
                routeHydrationPending={props.routeHydrationPending === true}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            </SyncPerformanceReactProfiler>
        </TranscriptMessageSelectionBoundary>
    );
}, areChatListPropsEqual);

const ListHeader = React.memo(() => {
    return (
        <View>
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
}) => {
    const footerState = useSessionChatFooterState(props.sessionId);
    if (!footerState) {
        return null;
    }
    return (
        <ChatFooter
            controlledByUser={props.controlledByUserOverride ?? footerState.controlledByUser}
            localControl={footerState.localControl}
            permissionsInUiWhileLocal={footerState.permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            directControl={props.directControl ?? null}
        />
    )
});

const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    directControl?: ChatFooterDirectControlState;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            <ListFooter
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControl ?? null}
            />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});

const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackAction?: TranscriptRollbackAction | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
} & Partial<TranscriptSessionCommonProps>) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useMessage(originSessionId, props.messageId);
    const message = props.messageOverride ?? committedMessage;
    if (!message) return null;

    const isThinking = message.kind === 'agent-text' && message.isThinking === true;
    const readOnlyInteraction = deriveReadOnlyTranscriptInteraction(props.interaction, props.isReadOnlyContext === true);
    const historical = isMessageRolledBack({ message, rollbackRanges: props.rollbackRanges });
    const canUseParentCommon = originSessionId === props.sessionId && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            approvalRequests={props.approvalRequests}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            metadata={props.metadata}
            sessionId={originSessionId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            approvalRequests={props.approvalRequests}
        />
    );
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`}>
            <View testID={`transcript-message-${props.messageId}`}>
                {messageView}
            </View>
        </View>
    );
});

const TranscriptRowShell = React.memo(function TranscriptRowShell(props: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    children: React.ReactNode;
    itemId: string;
    onRowLayoutMutation?: (params: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => void;
    /** N1.2 evidence callback (dev-gated telemetry only; no layout behavior). */
    onRowMeasured?: (params: Readonly<{ itemId: string; rowKind: string; heightPx: number }>) => void;
    signature: TranscriptItemHeightValiditySignature;
}>) {
    // C1: the row-shell reservation is sourced from the single measurement reconciler. Stable rows
    // carry an exact minHeight (== last measured); streaming/prepended/never-measured rows carry a
    // monotonic floor (>= last measured) so a growing or freshly-inserted row never leaves the next
    // row positioned above where the previous frame ended (overlap is structurally impossible during
    // append). The floor resets on a structural/expansion/width/font change (the shrink-capable
    // transitions) so a collapse leaves no persistent over-reservation.
    const reservation = resolveTranscriptRowShellHeight({
        reconciler: props.reconciler,
        signature: props.signature,
    });
    const reservedMinHeight = reservation?.minHeight;
    const shellStyle = React.useMemo(() => (
        reservedMinHeight === undefined ? undefined : { minHeight: reservedMinHeight }
    ), [reservedMinHeight]);
    const signatureKey = React.useMemo(
        () => buildTranscriptItemHeightSignatureKey(props.signature),
        [props.signature],
    );
    const lastSignatureKeyRef = React.useRef(signatureKey);
    const lastSignatureRef = React.useRef(props.signature);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
            const heightPx = Math.max(1, Math.trunc(height));
            props.reconciler.recordMeasuredHeight({ signature: props.signature, heightPx });
            props.onRowMeasured?.({
                itemId: props.itemId,
                rowKind: props.signature.kind,
                heightPx,
            });
        }
    }, [props.reconciler, props.itemId, props.onRowMeasured, props.signature]);

    React.useLayoutEffect(() => {
        if (lastSignatureKeyRef.current === signatureKey) return;
        const previousSignature = lastSignatureRef.current;
        lastSignatureKeyRef.current = signatureKey;
        lastSignatureRef.current = props.signature;
        // Reset the per-item floor on any shrink-capable structural change (expansion toggle,
        // rowState transition, shape, width/font) so the next onLayout re-seeds from the new
        // (possibly smaller) height — collapse never carries a stale tall floor.
        if (isStructuralSignatureDelta(previousSignature, props.signature)) {
            props.reconciler.resetReservationForStructuralChange({
                itemId: props.itemId,
                signature: props.signature,
            });
        }
        props.onRowLayoutMutation?.({
            itemId: props.itemId,
            mutation: {
                reason: 'signature-change',
                sourceId: props.itemId,
                previousSignature,
                nextSignature: props.signature,
            },
            rowKind: props.signature.kind,
        });
    }, [props.onRowLayoutMutation, props.reconciler, props.itemId, signatureKey, props.signature]);
    const handleChildRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation) => {
        props.onRowLayoutMutation?.({
            itemId: props.itemId,
            mutation,
            rowKind: props.signature.kind,
        });
    }, [props.itemId, props.onRowLayoutMutation, props.signature.kind]);

    return (
        <TranscriptRowLayoutMutationProvider value={handleChildRowLayoutMutation}>
            <View
                testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.itemId}`}
                style={shellStyle}
                onLayout={handleLayout}
            >
                {props.children}
            </View>
        </TranscriptRowLayoutMutationProvider>
    );
});

/**
 * C1: a structural (shrink-capable) signature delta warrants resetting the per-item floor and is the
 * only thing that may drive a whole-list invalidation. A pure streaming append (rowState stays
 * streaming, only the content revision grew) is NOT structural — the per-row onLayout channel absorbs
 * growth. This generalizes (and replaces) the old streaming-specific suppression band-aid.
 */
const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionActive: boolean,
    sessionThinking: boolean,
    groupingMode: string,
    forkedTranscriptEnabled: boolean,
    items: ChatTranscriptListItem[],
    maxTurnEntriesPerListItem: number,
    messagesById: Readonly<Record<string, Message>>,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    activeThinkingMessageId: string | null,
    rollbackRanges: readonly SessionRollbackRangeV1[],
    rollbackActionsByMessageId: Readonly<Record<string, TranscriptRollbackAction>>,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void,
    directControlFooter?: ChatFooterDirectControlState;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    followBottomIntentKey?: string | number | null;
    onViewportChange?: (state: TranscriptViewportChangeState) => void;
    onEditPendingMessage?: (request: PendingMessageEditRequest) => void | Promise<void>;
    isWarmKeepAliveInstance?: boolean;
    routeHydrationPending?: boolean;
} & TranscriptSessionCommonProps) => {
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [nativePrependTransactionRevision, bumpNativePrependTransactionRevision] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listLayoutWidthBucket, setListLayoutWidthBucket] = React.useState(resolveInitialTranscriptRowWidthBucket);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const [webMarkdownRuntimeReady, setWebMarkdownRuntimeReady] = React.useState(isEnrichedMarkdownRuntimePreloaded);
    const [nativeMountSettleStable, setNativeMountSettleStable] = React.useState(false);
    const [nativeMountSettleDeadlineReached, setNativeMountSettleDeadlineReached] = React.useState(false);
    const [nativeInitialViewportPendingObservation, setNativeInitialViewportPendingObservation] = React.useState(false);
    const nativeMountSettleDeadlineReachedRef = React.useRef(false);
    const nativeMountSettleAutoPinSuppressedRef = React.useRef(false);
    const loadOlderInFlight = React.useRef(false);
    const hasMoreOlderRef = React.useRef<boolean | null>(null);
    const olderLoadSpinnerDelayTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeFirstPaintFallbackReleaseTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const nativeEntryRestorePaintReleaseTimeoutRef = React.useRef<{
        issuedAtMs: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const flushViewportAnchorCaptureRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    const flushExitLiveTailIntentRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
    // Render-safe handle for session-exit/unmount disposal of an open entry-restore
    // transaction (mirror of invalidateNativePrependTransactionRef): the lifecycle fn is
    // defined after the command seam in source order.
    const disposeEntryRestoreTransactionForExitRef = React.useRef<() => void>(() => {});
    const currentSessionIdRef = React.useRef(props.sessionId);
    if (currentSessionIdRef.current !== props.sessionId) {
        // Session exit (plan A3): capture the debounced anchor synchronously while the previous
        // session's list/data refs are still mounted and the current-session ref still points at
        // the exiting session; the emit itself is deferred off the render phase.
        flushViewportAnchorCaptureRef.current({ deferEmit: true });
        // Session exit (plan P3): if the viewport visibly sits at the bottom, persist live-tail
        // intent deterministically — the B8 arrival emission may not have fired (passive
        // arrival / swallowed momentum frames). Runs AFTER the anchor flush so the live-tail
        // report is the final persisted state for the exiting session.
        flushExitLiveTailIntentRef.current({ deferEmit: true });
    }
    currentSessionIdRef.current = props.sessionId;
    const viewportCommandControllerRef = React.useRef<TranscriptViewportCommandController | null>(null);
    if (viewportCommandControllerRef.current === null) {
        viewportCommandControllerRef.current = createTranscriptViewportCommandController();
    }
    const viewportCommandController = viewportCommandControllerRef.current;
    viewportCommandController.setCurrentSessionId(props.sessionId);
    React.useLayoutEffect(() => {
        viewportCommandController.setActive(true);
        return () => {
            viewportCommandController.setActive(false);
        };
    }, [viewportCommandController]);
    const closeViewportOwnershipTransaction = React.useCallback((
        owner: 'entry' | 'prepend',
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (viewportCommandController.activeOwner() !== owner) return;
        viewportCommandController.closeTransaction(owner, outcome);
    }, [viewportCommandController]);
    const closeEntryViewportOwnership = React.useCallback((outcome: TranscriptViewportTransactionOutcome) => {
        closeViewportOwnershipTransaction('entry', outcome);
    }, [closeViewportOwnershipTransaction]);
    /**
     * Trusted user takeover during entry (plan A2: touch-escape semantics). Closes the
     * entry-restore transaction as preempted when one is open; when none was created yet,
     * suppresses this entry permanently and releases the entry ownership phase.
     */
    const preemptEntryRestoreTransaction = React.useCallback(() => {
        const transaction = entryRestoreTransactionRef.current;
        if (transaction && !transaction.isClosed()) {
            transaction.onTrustedUserScroll();
            finishEntryRestoreTransactionRef.current(transaction);
            return;
        }
        if (!transaction) {
            entryRestoreSuppressedRef.current = true;
        }
        closeEntryViewportOwnership('preempted');
    }, [closeEntryViewportOwnership]);
    const itemsRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    const listDataRef = React.useRef<readonly ChatTranscriptListItem[]>(props.items);
    // Pre-decomposition source (turn / tool-calls-group shapes) for visitors that must
    // not see per-unit rows (auto-expand policy scan).
    const preDecompositionItemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const toolRouteCommonRef = React.useRef(props.toolRouteCommon);
    toolRouteCommonRef.current = props.toolRouteCommon;
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listLayoutWidthBucketRef = React.useRef<string>(listLayoutWidthBucket);
    const listContentHeightRef = React.useRef<number>(0);
    const lastMeasuredContentActivityKeyRef = React.useRef<string | null>(null);
    const initialFillStatusRef = React.useRef<'idle' | 'in_progress' | 'done'>('idle');
    // C1: the single measurement reconciler — sole recycle-type/reservation/global-invalidation
    // authority for transcript rows. It composes the shared height cache for the exact (stable) path
    // and owns the per-item monotonic floors, per-type medians, and the transaction-gated, once-per-
    // commit `clearLayoutCacheOnUpdate` decision.
    const measurementReconciler = React.useMemo<TranscriptMeasurementReconciler>(
        () => createTranscriptMeasurementReconciler({ cache: getDefaultTranscriptItemHeightCache() }),
        [],
    );
    const mountSettleCoordinatorRef = React.useRef<TranscriptMountSettlePinCoordinator | null>(null);
    if (mountSettleCoordinatorRef.current === null) {
        mountSettleCoordinatorRef.current = createTranscriptMountSettlePinCoordinator({
            tuning: resolveTranscriptMountSettleTuning(),
        });
    }
    const recordListLayoutWidth = React.useCallback((width: unknown) => {
        if (typeof width !== 'number' || !Number.isFinite(width)) return;
        const nextBucket = resolveTranscriptRowWidthBucket(width);
        if (listLayoutWidthBucketRef.current === nextBucket) return;
        listLayoutWidthBucketRef.current = nextBucket;
        setListLayoutWidthBucket(nextBucket);
    }, []);
    const initialPinSessionIdRef = React.useRef<string | null>(null);
    const didAutoExpandToolCallsGroupsForSessionRef = React.useRef<string | null>(null);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const pendingWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const inFlightWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const webHotColdCountsRef = React.useRef<{ coldCount: number; hotCount: number }>({
        coldCount: props.items.length,
        hotCount: 0,
    });
    const olderPaginationSnapshotRef = React.useRef<TranscriptOlderPaginationSnapshot>({
        phase: 'idle',
        suspendedReasons: [],
        hasMore: true,
        insideThreshold: false,
    });
    // Native prepend transaction (plan F4 / Lane C): exactly one transaction per older-page
    // prepend; commit opens the prepend ownership phase; one post-commit layout timeout.
    const nativePrependTransactionRef = React.useRef<PrependTransaction | null>(null);
    // Pending explicit jump-to-bottom confirmation (plan B7): armed when a native flash
    // explicit jump write is issued; spent on ONE bounded re-confirm if the content height
    // churns before the bottom is observed; cleared on bottom arrival / trusted scroll /
    // session change. Never a correction loop.
    const pendingNativeExplicitJumpConfirmRef = React.useRef<{
        sessionId: string;
        issuedContentHeight: number;
    } | null>(null);
    // Pending entry-bottom settle confirmation (plan P3, mirror of B7): armed when a
    // follow-bottom entry first marks the initial viewport applied. The baseline content
    // height comes from the SCROLL-EVENT source only (never mixed with the measured ref —
    // the two disagree by the composer inset, E7) and refreshes on every bottom-confirmed
    // frame. Spent on ONE bounded re-confirm when late content settle GROWS the event
    // content height while the viewport is left above the bottom and the mode machine still
    // says 'following'; cleared on trusted scroll / release / session change. Never a loop.
    const pendingNativeEntrySettleConfirmRef = React.useRef<{
        sessionId: string;
        issuedContentHeight: number | null;
    } | null>(null);
    const nativePrependCommitArmedRef = React.useRef(false);
    const nativePrependLayoutTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Layout-quiet gate (plan P1): the single fallback write is withheld until the anchor
    // row's observed offset is stable across one quiet window, so FlashList's asynchronous
    // MVCP correction can land first (mvcp-preserved, zero writes) instead of double-shifting.
    const nativePrependQuietGateRef = React.useRef<PrependFallbackQuietGate | null>(null);
    const nativePrependQuietTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // N2d.1 corrector deference: one pending re-observation scheduled when an applied corrector
    // correction lands during a committed transaction, so the corrector-covered classification
    // closes the window (mvcp-preserved, zero writes) before the quiet gate can spend the fallback.
    const nativePrependCorrectorNudgeRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const observeNativePrependTransactionRef = React.useRef<() => void>(() => {});
    const invalidateNativePrependTransactionRef = React.useRef<() => void>(() => {});
    // Plan P2: lets the momentum-settle handler (defined before the scheduler) arm a capture
    // for the dwelled position when every momentum frame was swallowed (open transactions).
    const scheduleViewportAnchorCaptureRef = React.useRef<(state: TranscriptViewportChangeState) => void>(() => {});
    const resetOlderPaginationRef = React.useRef<() => void>(() => {});
    const pendingWebPrependIndexRecoveryRef = React.useRef(false);
    const scheduledWebPrependIndexRecoveryRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
    const webPrependRestoreWindowExpiryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [webPrependRangeReservePx, setWebPrependRangeReservePx] = React.useState(0);
    const clearWebPrependRangeReserve = React.useCallback(() => {
        setWebPrependRangeReservePx((previous) => previous === 0 ? previous : 0);
    }, []);
    const cancelWebPrependRestoreWindowExpiry = React.useCallback(() => {
        const timeoutId = webPrependRestoreWindowExpiryTimeoutRef.current;
        if (timeoutId === null) return;
        webPrependRestoreWindowExpiryTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);
    const cancelScheduledWebPrependIndexRecovery = React.useCallback(() => {
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (!scheduledRecovery) return;
        scheduledWebPrependIndexRecoveryRef.current = null;
        if (scheduledRecovery.kind === 'raf') {
            for (const id of scheduledRecovery.ids) {
                cancelAnimationFrame(id);
            }
            return;
        }
        for (const id of scheduledRecovery.ids) {
            clearTimeout(id);
        }
    }, []);
    const clearWebPrependRestoreWindowState = React.useCallback(() => {
        pendingWebPrependAnchorRef.current = null;
        pendingWebPrependIndexRecoveryRef.current = false;
        cancelWebPrependRestoreWindowExpiry();
        cancelScheduledWebPrependIndexRecovery();
        clearWebPrependRangeReserve();
    }, [cancelScheduledWebPrependIndexRecovery, cancelWebPrependRestoreWindowExpiry, clearWebPrependRangeReserve]);
    const closeWebPrependViewportOwnership = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (Platform.OS !== 'web') return;
        if (viewportCommandController.activeOwner() !== 'prepend') return;
        viewportCommandController.closeTransaction('prepend', outcome);
    }, [viewportCommandController]);
    const clearWebPrependRestoreWindow = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        clearWebPrependRestoreWindowState();
        closeWebPrependViewportOwnership(outcome);
    }, [clearWebPrependRestoreWindowState, closeWebPrependViewportOwnership]);
    const wantsPinnedRef = React.useRef(true);
    const pinThresholdPxRef = React.useRef(72);
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const nativeTranscriptTouchStartYRef = React.useRef<number | null>(null);
    const webTranscriptTouchStartYRef = React.useRef<number | null>(null);
    // Last web scroll-container `scrollTop` we observed or wrote programmatically. Used to detect a
    // genuine web user scroll-up (movement toward the top) without relying on `isTrusted`, which RNW
    // does not reliably set, while excluding our own programmatic pin/restore scroll writes.
    const lastObservedWebScrollTopRef = React.useRef<number | null>(null);
    // Plan E3: consecutive same-direction non-programmatic web movement streak feeding the
    // scrollbar/keyboard intent heuristic in the web onScroll path.
    const webNonProgrammaticScrollStreakRef = React.useRef<{ direction: -1 | 1; count: number } | null>(null);
    const lastAutoRepinAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const lastScrollOffsetForIntentRef = React.useRef<number | null>(null);
    const bottomFollowModeStateRef = React.useRef<TranscriptBottomFollowModeState>({
        dragSession: null,
        mode: resolveSessionEntryBottomFollow(readSessionViewportForEntry(props.sessionId, { platformOS: Platform.OS, jumpToSeq: props.jumpToSeq }))
            ? 'following'
            : 'released',
    });
    const [bottomFollowModeRevision, bumpBottomFollowModeRevision] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const lastNativePinOffsetRef = React.useRef<number | null>(null);
    const lastNativeBottomFollowPinCommandRef = React.useRef<{
        sessionId: string;
        offsetY: number;
        writtenAtMs: number;
    } | null>(null);
    const lastNativeRestoreIndexCommandRef = React.useRef<LastNativeRestoreIndexCommand | null>(null);
    const nativeAutomaticBottomPinCommandSessionRef = React.useRef<string | null>(null);
    const nativeContentMaterializationAutoPinRef = React.useRef<{ contentHeight: number; sessionId: string } | null>(null);
    // Single stream writer (plan B3): at most one follow command per measured content version.
    const lastNativeStreamAppendPinRef = React.useRef<{ contentHeight: number; sessionId: string } | null>(null);
    const nativeListDragActiveRef = React.useRef(false);
    const nativeBottomFollowRearmedAfterDragRef = React.useRef(false);
    // Plan B9: true between onMomentumScrollBegin and onMomentumScrollEnd. Combined with the
    // mode machine's retained trusted drag session it forms the post-drag release attribution
    // window: momentum frames may release follow, height-churn frames without a drag never can.
    const nativeMomentumScrollActiveRef = React.useRef(false);
    const nativeVisibleWindowSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const lastNativeVisibleRowsSnapshotRef = React.useRef<NativeVisibleWindowSnapshot | null>(null);
    const nativeFlashListMvcpPolicyRef = React.useRef<TranscriptViewportTelemetryMvcpPolicy>('none');
    const lastProactiveAutoFollowActivityKeyRef = React.useRef<string | null>(props.latestCommittedActivityKey);
    const pendingNativeMountSettleBottomPinRef = React.useRef(false);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<(() => void) | null>(null);
    const nativeContentMeasurementSessionRef = React.useRef<{ sessionId: string; measured: boolean }>({
        sessionId: props.sessionId,
        measured: false,
    });
    const nativeInitialViewportAppliedSessionRef = React.useRef<{ sessionId: string; applied: boolean }>({
        sessionId: props.sessionId,
        applied: false,
    });
    const nativeInitialViewportPendingObservationRef = React.useRef(false);
    // Entry-restore single owner (plan F2 / Lane A): one transaction per session entry.
    const entryRestoreTransactionRef = React.useRef<EntryRestoreTransaction | null>(null);
    const entryRestoreWriteContextRef = React.useRef<EntryRestoreWriteContext | null>(null);
    // N2b.2 slice-from-anchor entry window (native flash_v2 anchored entries).
    const [entrySliceWindow, setEntrySliceWindow] = React.useState<{
        sessionId: string;
        anchorRowId: string;
    } | null>(null);
    const entrySliceWindowRef = React.useRef<{ sessionId: string; anchorRowId: string } | null>(null);
    const entrySliceWithheldCountRef = React.useRef(0);
    /** Per-session degradation latch: slice identity unresolvable → existing write pipeline. */
    const entrySliceDegradedSessionRef = React.useRef<string | null>(null);
    const revealEntrySliceWindowRef = React.useRef<() => number>(() => 0);
    const entryRestoreDeadlineTimeoutRef = React.useRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>(null);
    // Set when the user (or jump-to-seq) took over before any transaction was created:
    // this entry will never open one.
    const entryRestoreSuppressedRef = React.useRef(false);
    const finishEntryRestoreTransactionRef = React.useRef<(transaction: EntryRestoreTransaction) => void>(() => {});
    const legacyEntryRestoreAppliedRef = React.useRef<{ sessionId: string; offsetY: number } | null>(null);
    const composerInsetHeightRef = React.useRef(0);
    // Render-visible mirror of `composerInsetHeightRef` (the single source of truth). Bottom-anchored
    // overlays that live OUTSIDE the scroll geometry (e.g. the catch-up overlay) must re-position when
    // the composer inset changes, which a ref alone cannot drive. Committed from
    // `handleComposerInsetHeightChange` so it stays in lockstep with the ref.
    const [composerInsetHeight, setComposerInsetHeight] = React.useState(0);
    // Rendered height of the native hot-tail block (live-tail rows carved into the inverted
    // visual-bottom edge slot). Folded into the inverted bottom command's viewOffset so the
    // live tail lands fully above the composer. 0 when the native split is OFF/empty.
    const nativeHotTailHeightRef = React.useRef(0);
    // §12 #4: live-region carve context for per-pin telemetry (anchor id+kind, hot/cold counts,
    // whether the carve owns the bottom). Updated each render; read by the scroll-write executor
    // and the height-driven pin so they never re-derive it inside scroll callbacks.
    const liveTailCarveTelemetryRef = React.useRef<{
        active: boolean;
        anchorId: string | null;
        anchorKind: TranscriptLiveTailAnchorReason | null;
        coldCount: number;
        hotCount: number;
    }>({ active: false, anchorId: null, anchorKind: null, coldCount: 0, hotCount: 0 });
    // §12 #2: stable bridge to the latest height-driven live-tail pin (assigned after the pin
    // helpers exist). Keeps `handleNativeHotTailHeightChange` identity-stable while still calling
    // the freshest pin logic — height + pin become ONE event, killing the async-ref overlap race.
    const pinNativeLiveTailForHotTailHeightRef = React.useRef<((height: number) => void) | null>(null);
    // §12 #4: carve fields for an issued inverted bottom pin (the deterministic inset = composerInset
    // + hot-tail height, the anchor that opened the carve, hot/cold counts). Empty when the carve is
    // OFF so non-carve / flag=0 pins stay byte-for-byte unchanged.
    const resolveInvertedBottomPinCarveTelemetryFields = React.useCallback((): Record<string, unknown> => {
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return {};
        return {
            liveRegionActive: true,
            nativeHotTailHeightPx: nativeHotTailHeightRef.current,
            nativeCarvePinIssued: true,
            ...(carve.anchorId ? { liveTailAnchorId: carve.anchorId } : {}),
            ...(carve.anchorKind ? { liveTailAnchorKind: carve.anchorKind } : {}),
            coldCount: carve.coldCount,
            hotCount: carve.hotCount,
        };
    }, []);
    const scheduledPinRef = React.useRef<ScheduledPinToBottom | null>(null);
    const cancelScheduledPinToBottom = React.useCallback(() => {
        pendingNativeMountSettleBottomPinRef.current = false;
        const scheduled = scheduledPinRef.current;
        if (!scheduled) return;
        scheduledPinRef.current = null;
        if (scheduled.kind === 'raf') {
            const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
            if (typeof caf === 'function') {
                caf(scheduled.id);
            }
            return;
        }
        clearTimeout(scheduled.id);
    }, []);
    const latestJumpToSeqRef = React.useRef<number | null>(props.jumpToSeq ?? null);
    latestJumpToSeqRef.current = props.jumpToSeq ?? null;
    const initialWebPinStabilizingRef = React.useRef(false);
    const scheduledViewportAnchorCaptureRef = React.useRef<{
        captureAnchor: () => SessionViewportAnchorSnapshot | null;
        dueAtMs: number;
        emit: ((state: TranscriptViewportChangeState) => void) | undefined;
        generation: number;
        sessionId: string;
        state: TranscriptViewportChangeState;
        timeoutId: ReturnType<typeof setTimeout>;
        wantsPinned: boolean;
    } | null>(null);
    const viewportAnchorCaptureGenerationRef = React.useRef(0);
    const attemptEntryRestoreRef = React.useRef<() => void>(() => {});
    const anchorLookupLoadCountRef = React.useRef(0);
    const anchorLookupInFlightRef = React.useRef(false);
    const anchorLookupExhaustedRef = React.useRef(false);
    const loadOlderForAnchorLookupRef = React.useRef<((options?: LoadOlderOptions) => Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null>) | null>(null);

    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
    const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
    const reducedMotionPreferred = useReducedMotionPreference();
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');

    const releaseWebBottomFollowIntent = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        wantsPinnedRef.current = false;
        cancelScheduledPinToBottom();
    }, [cancelScheduledPinToBottom]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the transcript subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        preemptEntryRestoreTransaction();
        const nowMs = Date.now();
        lastUserScrollIntentAtMsRef.current = nowMs;
        // If the user scrolls away from the bottom, treat that as explicit intent to unpin
        // immediately, even if a reliable scroll observation has not arrived yet. This prevents
        // delayed bottom-follow pins from fighting touch scrolling in the web/PWA transcript.
        const deltaY = (event as any)?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            releaseWebBottomFollowIntent();
        } else {
            const currentY = readTouchPageY(event);
            const startY = webTranscriptTouchStartYRef.current;
            if (startY == null && currentY != null) {
                webTranscriptTouchStartYRef.current = currentY;
            }
            const movedVertically =
                startY != null &&
                currentY != null &&
                Math.abs(currentY - startY) >= TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX;
            if (movedVertically) {
                if (currentY != null) {
                    webTranscriptTouchStartYRef.current = currentY;
                }
                releaseWebBottomFollowIntent();
            }
        }
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, [
        preemptEntryRestoreTransaction,
        releaseWebBottomFollowIntent,
    ]);

    const recordWebTranscriptTouchStartIntent = React.useCallback((event?: unknown) => {
        if (Platform.OS !== 'web') return;
        webTranscriptTouchStartYRef.current = readTouchPageY(event);
    }, []);

    const recordWebTranscriptTouchEndIntent = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        webTranscriptTouchStartYRef.current = null;
    }, []);

    const markUserScrollIntentOnWeb = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        preemptEntryRestoreTransaction();
        lastUserScrollIntentAtMsRef.current = Date.now();
    }, [preemptEntryRestoreTransaction]);

    const updateNativeInitialViewportPendingObservation = React.useCallback((pending: boolean) => {
        if (Platform.OS === 'web') return;
        if (nativeInitialViewportPendingObservationRef.current === pending) return;
        nativeInitialViewportPendingObservationRef.current = pending;
        setNativeInitialViewportPendingObservation(pending);
    }, []);

    const recordNativeUserScrollIntent = React.useCallback((nowMs: number = Date.now()) => {
        if (Platform.OS === 'web') return;
        preemptEntryRestoreTransaction();
        lastUserScrollIntentAtMsRef.current = nowMs;
        pendingNativeMountSettleBottomPinRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = true;
        updateNativeInitialViewportPendingObservation(false);
    }, [
        preemptEntryRestoreTransaction,
        updateNativeInitialViewportPendingObservation,
    ]);

    const resetNativeSessionViewportLifecycle = React.useCallback((sessionId: string) => {
        if (Platform.OS === 'web') return;
        nativeContentMeasurementSessionRef.current = { sessionId, measured: false };
        nativeInitialViewportAppliedSessionRef.current = { sessionId, applied: false };
        updateNativeInitialViewportPendingObservation(false);
    }, [updateNativeInitialViewportPendingObservation]);

    const hasNativeContentMeasurementForCurrentSession = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return true;
        const state = nativeContentMeasurementSessionRef.current;
        return state.sessionId === props.sessionId && state.measured === true;
    }, [props.sessionId]);

    const markNativeContentMeasurementForCurrentSession = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeContentMeasurementSessionRef.current = { sessionId: props.sessionId, measured: true };
    }, [props.sessionId]);

    const hasNativeInitialViewportAppliedForCurrentSession = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return true;
        const state = nativeInitialViewportAppliedSessionRef.current;
        return state.sessionId === props.sessionId && state.applied === true;
    }, [props.sessionId]);

    const markNativeInitialViewportAppliedForCurrentSession = React.useCallback((options?: Readonly<{
        entrySettleBaselineContentHeight?: number;
    }>) => {
        if (Platform.OS === 'web') return;
        const previousState = nativeInitialViewportAppliedSessionRef.current;
        const wasApplied = previousState.sessionId === props.sessionId && previousState.applied === true;
        nativeInitialViewportAppliedSessionRef.current = { sessionId: props.sessionId, applied: true };
        updateNativeInitialViewportPendingObservation(false);
        if (!wasApplied && sessionEntryViewportRef.current?.shouldFollowBottom !== false) {
            // Plan P3: arm the one-shot settle re-confirm for follow-bottom entries — late
            // content settle after the entry pin must still end at the TRUE bottom. The
            // baseline stays event-source-only; callers without an event content height
            // arm with null and the first bottom-confirmed frame fills it.
            const baseline = options?.entrySettleBaselineContentHeight;
            pendingNativeEntrySettleConfirmRef.current = {
                sessionId: props.sessionId,
                issuedContentHeight: typeof baseline === 'number' && Number.isFinite(baseline)
                    ? baseline
                    : null,
            };
        }
        if (entryRestoreTransactionRef.current === null) {
            // Cold-open entry phase (no entry-restore transaction): applied = confirmed.
            // Restore entries close their phase through finishEntryRestoreTransaction.
            closeEntryViewportOwnership('confirmed');
        }
    }, [
        closeEntryViewportOwnership,
        props.sessionId,
        updateNativeInitialViewportPendingObservation,
    ]);

    const shouldRecordNativePassiveUnpinnedMovement = React.useCallback((distanceFromBottom: number, thresholdPx: number): boolean => {
        return resolveShouldRecordNativePassiveUnpinnedMovement({
            configuredBottomDistanceNoiseFloorPx: resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx,
            distanceFromBottom,
            hasNativeContentMeasurement: hasNativeContentMeasurementForCurrentSession(),
            hasNativeInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            isWeb: Platform.OS === 'web',
            pinThresholdPx: thresholdPx,
            wantsPinned: wantsPinnedRef.current,
        });
    }, [
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
    ]);

    const shouldIgnoreNativeInvalidScrollObservation = React.useCallback((
        offsetY: number,
        distanceFromBottom: number,
        layoutHeight: number,
        contentHeight: number,
    ): boolean => {
        return resolveShouldIgnoreNativeInvalidScrollObservation({
            contentHeight,
            distanceFromBottom,
            isWeb: Platform.OS === 'web',
            layoutHeight,
            offsetY,
            orientation: listOrientationRef.current,
        });
    }, []);

    const shouldIgnoreNativePassiveViewportScroll = React.useCallback((
        isTrusted: boolean,
        nowMs: number,
        distanceFromBottom: number,
        thresholdPx: number,
    ): boolean => {
        const entryViewport = sessionEntryViewportRef.current;
        return resolveShouldIgnoreNativePassiveViewportScroll({
            configuredBottomDistanceNoiseFloorPx: resolveTranscriptMountSettleTuning().bottomDistanceNoiseFloorPx,
            currentSessionId: props.sessionId,
            distanceFromBottom,
            entryViewportSessionId: entryViewport?.sessionId ?? null,
            entryViewportShouldFollowBottom: entryViewport?.shouldFollowBottom ?? null,
            hasNativeContentMeasurement: hasNativeContentMeasurementForCurrentSession(),
            hasNativeInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            isTrusted,
            isWeb: Platform.OS === 'web',
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs,
            pinThresholdPx: thresholdPx,
            shouldRecordPassiveUnpinnedMovement: shouldRecordNativePassiveUnpinnedMovement(distanceFromBottom, thresholdPx),
            userIntentRecentMs: TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS,
            wantsPinned: wantsPinnedRef.current,
        });
    }, [
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        props.sessionId,
        shouldRecordNativePassiveUnpinnedMovement,
    ]);

    const refreshNativeRecentPassiveUserScrollIntent = React.useCallback((isTrusted: boolean, nowMs: number) => {
        if (Platform.OS === 'web' || isTrusted) return;
        if (nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS) return;
        recordNativeUserScrollIntent(nowMs);
    }, [recordNativeUserScrollIntent]);

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => {
                const sh = (el as any).scrollHeight;
                return typeof sh === 'number' && Number.isFinite(sh) ? sh : 0;
            },
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId]);

    const resolveFirstVisibleWebAnchorTestId = React.useCallback((metrics: WebTranscriptScrollMetrics): string | undefined => {
        const querySelectorAll = metrics.element.querySelectorAll?.bind(metrics.element);
        const getContainerRect = metrics.element.getBoundingClientRect?.bind(metrics.element);
        if (!querySelectorAll || !getContainerRect) return undefined;
        let containerRect: DOMRect | null = null;
        try {
            containerRect = getContainerRect();
        } catch {
            return undefined;
        }
        const viewportTop = containerRect.top;
        const viewportBottom = containerRect.top + metrics.clientHeight;
        try {
            const anchors = Array.from(querySelectorAll<HTMLElement>('[data-testid]'));
            for (const anchor of anchors) {
                const testId = anchor.getAttribute('data-testid') ?? undefined;
                if (!testId) continue;
                const rect = anchor.getBoundingClientRect?.();
                if (!rect) continue;
                if (rect.bottom > viewportTop && rect.top < viewportBottom) {
                    return testId;
                }
            }
        } catch {
            return undefined;
        }
        return undefined;
    }, []);

    const resolveWebViewportTelemetryDiagnostics = React.useCallback((params: Readonly<{
        flashListContentHeight?: number;
        flashListLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
        paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    }>) => {
        const metrics = params.metrics ?? null;
        const paginationSnapshot = olderPaginationSnapshotRef.current;
        const counts = webHotColdCountsRef.current;
        const pendingAnchor = pendingWebPrependAnchorRef.current;
        const pendingWebPrependAnchorKind =
            pendingAnchor?.anchorTestId ? 'stable'
                : pendingAnchor?.itemTestId ? 'item'
                    : 'none';
        const pendingWebPrependAnchorId =
            pendingAnchor?.anchorTestId ?? pendingAnchor?.itemTestId ?? undefined;
        const pendingWebPrependAnchorIndex = pendingAnchor
            ? resolvePendingWebPrependAnchorItemIndex({
                anchorTestId: pendingAnchor.anchorTestId,
                itemTestId: pendingAnchor.itemTestId,
                items: itemsRef.current,
            })
            : undefined;
        return {
            trigger: params.trigger,
            ...(metrics ? {
                domScrollTop: metrics.scrollTop,
                domScrollHeight: metrics.scrollHeight,
                domClientHeight: metrics.clientHeight,
                firstVisibleAnchorTestId: resolveFirstVisibleWebAnchorTestId(metrics) ?? 'none',
            } : {
                firstVisibleAnchorTestId: 'none',
            }),
            flashListContentHeight: params.flashListContentHeight ?? listContentHeightRef.current,
            flashListLayoutHeight: params.flashListLayoutHeight ?? listLayoutHeightRef.current,
            scrollable: params.scrollable ?? (metrics ? isWebTranscriptScrollable(metrics, 1) : false),
            paginationPhase: params.paginationPhase ?? paginationSnapshot.phase,
            paginationSuspendedReasons: params.paginationSuspendedReasons ?? paginationSnapshot.suspendedReasons,
            coldCount: counts.coldCount,
            hotCount: counts.hotCount,
            pendingWebPrependAnchorKind,
            ...(pendingWebPrependAnchorId ? { pendingWebPrependAnchorId } : {}),
            ...(pendingWebPrependAnchorIndex !== undefined ? { pendingWebPrependAnchorIndex } : {}),
            programmaticWebWrite: params.programmaticWebWrite,
        };
    }, [resolveFirstVisibleWebAnchorTestId]);

    const resolveBackwardPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: tuning.transcriptBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const waitForNextVisualUpdate = React.useCallback(async () => {
        await Promise.resolve();
        await Promise.resolve();
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            await new Promise<void>((resolve) => {
                raf(() => resolve());
            });
        }
    }, []);

    const motionConfig = React.useMemo(() => {
        return resolveTranscriptMotionConfig({
            reducedMotionPreferred,
            transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomRevealViewportRatio = useSetting('transcriptScrollJumpToBottomRevealViewportRatio');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

    const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>(() => ({
        isPinned: resolveSessionEntryBottomFollow(readSessionViewportForEntry(props.sessionId, { platformOS: Platform.OS, jumpToSeq: props.jumpToSeq })),
        newActivityCount: 0,
        lastActivityKey: null,
    }));
    const scrollPinRef = React.useRef(scrollPin);
    const commitScrollPinState = React.useCallback((next: TranscriptScrollPinState) => {
        const current = scrollPinRef.current;
        if (
            current === next ||
            (
                current.isPinned === next.isPinned &&
                current.newActivityCount === next.newActivityCount &&
                current.lastActivityKey === next.lastActivityKey
            )
        ) {
            return;
        }
        scrollPinRef.current = next;
        setScrollPin(next);
    }, []);
    const commitScrollPinEvent = React.useCallback((event: TranscriptScrollPinEvent) => {
        const next = resolveTranscriptScrollPinStateUpdate(scrollPinRef.current, event);
        if (!next) return;
        commitScrollPinState(next);
    }, [commitScrollPinState]);
    const [jumpToBottomDistanceFromBottom, setJumpToBottomDistanceFromBottom] = React.useState(0);
    const jumpToBottomDistanceFromBottomRef = React.useRef(0);
    const [jumpToTopVisible, setJumpToTopVisible] = React.useState(false);
    const jumpToTopVisibleRef = React.useRef(false);
    const isPinnedRef = React.useRef(true);
    const sessionEntryViewportRef = React.useRef<{
        sessionId: string;
        shouldFollowBottom: boolean;
        // Finite persisted distance-from-bottom, or null when the stored viewport carried
        // no trustworthy offset (missing or non-finite) — consumers must not treat null as 0
        // where 0 means "at the bottom".
        offsetY: number | null;
        anchor: SessionViewportAnchorSnapshot | null;
    } | null>(null);
    if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) {
        const sessionViewport = readSessionViewportForEntry(props.sessionId, { platformOS: Platform.OS, jumpToSeq: props.jumpToSeq });
        const shouldFollowBottom = resolveSessionEntryBottomFollow(sessionViewport);
        // Persisted viewports are untrusted input: a non-finite stored offsetY must read as
        // "no remembered offset" everywhere downstream (entry restore, exit-flush fallback).
        const persistedEntryOffsetY =
            typeof sessionViewport?.offsetY === 'number' && Number.isFinite(sessionViewport.offsetY)
                ? sessionViewport.offsetY
                : null;
        sessionEntryViewportRef.current = {
            sessionId: props.sessionId,
            shouldFollowBottom,
            offsetY: persistedEntryOffsetY,
            anchor: sessionViewport?.anchor ?? null,
        };
        wantsPinnedRef.current = shouldFollowBottom;
        isPinnedRef.current = shouldFollowBottom;
        bottomFollowModeStateRef.current = resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'session-entry',
            shouldFollowBottom,
        });
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : persistedEntryOffsetY;
        lastScrollOffsetForIntentRef.current = null;
        lastObservedWebScrollTopRef.current = null;
        webNonProgrammaticScrollStreakRef.current = null;
        lastNativePinOffsetRef.current = null;
        lastNativeBottomFollowPinCommandRef.current = null;
        nativeAutomaticBottomPinCommandSessionRef.current = null;
        nativeBottomFollowRearmedAfterDragRef.current = false;
        nativeMomentumScrollActiveRef.current = false;
        lastNativeStreamAppendPinRef.current = null;
        lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
        lastMeasuredContentActivityKeyRef.current = null;
        hasMoreOlderRef.current = null;
        resetOlderPaginationRef.current();
            resetNativeSessionViewportLifecycle(props.sessionId);
            // An entry transaction left open by the exiting session closes with an
            // attributable outcome (mirror of the prepend disposal below) — entry
            // restores must never be dropped silently (plan §4).
            disposeEntryRestoreTransactionForExitRef.current();
            entryRestoreTransactionRef.current = null;
            entryRestoreWriteContextRef.current = null;
            entryRestoreSuppressedRef.current = false;
            legacyEntryRestoreAppliedRef.current = null;
            // Slice window/degradation are per-entry; state clears in the session-scope effect.
            entrySliceWindowRef.current = null;
            entrySliceDegradedSessionRef.current = null;
            const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
            if (entryRestoreDeadlineTimeout) {
                entryRestoreDeadlineTimeoutRef.current = null;
                clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
            }
            const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
            if (nativeEntryRestorePaintReleaseTimeout) {
                nativeEntryRestorePaintReleaseTimeoutRef.current = null;
                clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
            }
            invalidateNativePrependTransactionRef.current();
            pendingNativeExplicitJumpConfirmRef.current = null;
            // Plan P3: follow-bottom entries (cold or warm keep-alive) arm the one-shot
            // settle re-confirm at entry — warm reopens never re-run the applied lifecycle,
            // yet a catch-up content swap can leave them above the bottom. The event-source
            // baseline is filled by the first observed frame.
            pendingNativeEntrySettleConfirmRef.current =
                shouldFollowBottom && Platform.OS !== 'web' && transcriptListImplementation !== 'flatlist_legacy'
                    ? { sessionId: props.sessionId, issuedContentHeight: null }
                    : null;
            lastNativeRestoreIndexCommandRef.current = null;
        anchorLookupLoadCountRef.current = 0;
        anchorLookupInFlightRef.current = false;
        anchorLookupExhaustedRef.current = false;
        // Single-owner phase machine: a fresh controller state per session entry.
        // Restore entries open the entry phase at mount; native cold opens own the
        // viewport until the initial bottom viewport is applied.
        viewportCommandController.resetForSession({
            sessionId: props.sessionId,
            openEntryTransaction:
                !shouldFollowBottom ||
                (Platform.OS !== 'web' && transcriptListImplementation !== 'flatlist_legacy'),
        });
        // C1: drop per-item floors, per-type medians, and the per-commit clear latch on session
        // entry so a new session never reserves heights from the previous one.
        measurementReconciler.resetForSession(props.sessionId);
    }
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );

    const clearOlderLoadSpinnerDelay = React.useCallback(() => {
        const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
        if (!timeoutId) return;
        olderLoadSpinnerDelayTimeoutRef.current = null;
        clearTimeout(timeoutId);
    }, []);

    const hideOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(false);
    }, [clearOlderLoadSpinnerDelay]);

    const showOlderLoadSpinner = React.useCallback(() => {
        clearOlderLoadSpinnerDelay();
        setIsLoadingOlder(true);
    }, [clearOlderLoadSpinnerDelay]);

    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        pendingNativeMountSettleBottomPinRef.current = false;
        // Jump-to-seq takes over the viewport: the entry-restore transaction (if any) is
        // preempted and this entry never opens another one.
        entryRestoreSuppressedRef.current = true;
        preemptEntryRestoreTransaction();
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        invalidateNativePrependTransactionRef.current();
        lastNativeRestoreIndexCommandRef.current = null;
    }, [
        preemptEntryRestoreTransaction,
        props.jumpToSeq,
    ]);

    const commitBottomFollowModeState = React.useCallback((next: TranscriptBottomFollowModeState) => {
        const previous = bottomFollowModeStateRef.current;
        bottomFollowModeStateRef.current = next;
        if (previous.mode !== next.mode) {
            bumpBottomFollowModeRevision();
        }
    }, []);

    const beginNativeBottomFollowGestureIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        recordNativeUserScrollIntent();
        markNativeInitialViewportAppliedForCurrentSession();
        nativeListDragActiveRef.current = true;
        nativeBottomFollowRearmedAfterDragRef.current = false;
        // A finger down catches any in-flight fling: its momentum window ends here.
        nativeMomentumScrollActiveRef.current = false;
        if (listOrientationRef.current !== 'inverted') {
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
        }
        cancelScheduledPinToBottom();
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'list-drag-start',
        }));
    }, [
        cancelScheduledPinToBottom,
        commitBottomFollowModeState,
        markNativeInitialViewportAppliedForCurrentSession,
        recordNativeUserScrollIntent,
    ]);

    const hasOpenEntryRestoreTransactionForSession = React.useCallback(() => {
        const transaction = entryRestoreTransactionRef.current;
        return transaction != null && transaction.sessionId === props.sessionId && !transaction.isClosed();
    }, [props.sessionId]);

    const hasOpenNativePrependTransactionForSession = React.useCallback((): boolean => {
        const transaction = nativePrependTransactionRef.current;
        return transaction != null && transaction.sessionId === props.sessionId && !transaction.isClosed();
    }, [props.sessionId]);

    const hasActiveNativeViewportRestore = React.useCallback(() => (
        hasOpenEntryRestoreTransactionForSession() ||
        hasOpenNativePrependTransactionForSession()
    ), [hasOpenEntryRestoreTransactionForSession, hasOpenNativePrependTransactionForSession]);

    const recordNativeTranscriptTouchStartIntent = React.useCallback((event?: unknown) => {
        if (Platform.OS === 'web') return;
        nativeTranscriptTouchStartYRef.current = readTouchPageY(event);
    }, []);

    const recordNativeTranscriptTouchEndIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeTranscriptTouchStartYRef.current = null;
    }, []);

    const recordNativeTranscriptTouchIntent = React.useCallback((event?: unknown) => {
        if (Platform.OS === 'web') return;
        const hasActiveNativeRestore = hasActiveNativeViewportRestore();
        const currentY = readTouchPageY(event);
        const startY = nativeTranscriptTouchStartYRef.current;
        if (startY == null && currentY != null) {
            nativeTranscriptTouchStartYRef.current = currentY;
        }
        const movedVertically =
            startY != null &&
            currentY != null &&
            Math.abs(currentY - startY) >= TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX;
        if (movedVertically && !hasActiveNativeRestore && wantsPinnedRef.current) {
            nativeTranscriptTouchStartYRef.current = currentY;
            beginNativeBottomFollowGestureIntent();
            if (listOrientationRef.current === 'inverted') {
                const releaseThresholdPx = pinThresholdPxRef.current;
                // Inverted active streams can remain physically bottom-pinned long
                // enough that no trusted scroll frame arrives before drag-end. Once
                // the user's touch has moved beyond the escape threshold, the
                // gesture itself owns the viewport: release live-tail now and let a
                // later trusted bottom observation re-arm follow if the user returns.
                commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
                    distanceFromBottom: releaseThresholdPx + 1,
                    movedAwayFromBottom: true,
                    pinThresholdPx: releaseThresholdPx,
                    type: 'trusted-away-observation',
                }));
                wantsPinnedRef.current = false;
                isPinnedRef.current = false;
                nativeBottomFollowRearmedAfterDragRef.current = false;
                commitScrollPinState({ ...scrollPinRef.current, isPinned: false });
            }
            return;
        }
        if (!hasActiveNativeRestore) {
            lastUserScrollIntentAtMsRef.current = Date.now();
        }
        nativeMountSettleAutoPinSuppressedRef.current = true;
        pendingNativeMountSettleBottomPinRef.current = false;
        cancelScheduledPinToBottom();
    }, [
        cancelScheduledPinToBottom,
        commitBottomFollowModeState,
        commitScrollPinState,
        hasActiveNativeViewportRestore,
        beginNativeBottomFollowGestureIntent,
    ]);

    const recordNativeListDragEscapeIntent = React.useCallback(() => {
        beginNativeBottomFollowGestureIntent();
    }, [beginNativeBottomFollowGestureIntent]);

    const recordNativeTranscriptResponderStartIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchStartIntent(event);
        return false;
    }, [recordNativeTranscriptTouchStartIntent]);

    const recordNativeTranscriptResponderMoveIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchIntent(event);
        return false;
    }, [recordNativeTranscriptTouchIntent]);

    const nativeFlashListScrollOverrideProps = React.useMemo(() => {
        if (Platform.OS === 'web') return undefined;
        return {
            onMoveShouldSetResponderCapture: recordNativeTranscriptResponderMoveIntent,
            onStartShouldSetResponderCapture: recordNativeTranscriptResponderStartIntent,
            onTouchCancel: recordNativeTranscriptTouchEndIntent,
            onTouchEnd: recordNativeTranscriptTouchEndIntent,
            onTouchMove: recordNativeTranscriptTouchIntent,
            onTouchStart: recordNativeTranscriptTouchStartIntent,
        };
    }, [
        recordNativeTranscriptResponderMoveIntent,
        recordNativeTranscriptResponderStartIntent,
        recordNativeTranscriptTouchEndIntent,
        recordNativeTranscriptTouchIntent,
        recordNativeTranscriptTouchStartIntent,
    ]);

    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        lastUserScrollIntentAtMsRef.current = Date.now();
        nativeMountSettleAutoPinSuppressedRef.current = true;
        cancelScheduledPinToBottom();
    }, [cancelScheduledPinToBottom]);

    const prepareWebToolGroupLocalHeightChange = React.useCallback((): 'anchor' | 'bottom' | 'none' => {
        if (Platform.OS !== 'web') return 'none';
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return 'none';
        const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
        if (wantsPinnedRef.current && distanceFromBottom <= pinThresholdPxRef.current) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'bottom';
        }
        if (!isWebTranscriptScrollable(metrics, 1)) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        if (!anchor) {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return 'none';
        }
        pendingWebLocalHeightChangeAnchorRef.current = {
            sessionId: props.sessionId,
            anchor,
        };
        return 'anchor';
    }, [props.sessionId, resolveWebScrollMetrics]);

    const applyToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (params.expanded) {
                const toolMessageIds = params.toolMessageIds;
                const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor) {
                    next.add(anchor);
                }
            } else {
                for (const id of params.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, []);

    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);

    const applyThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [thinkingDefaultExpanded]);

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const webHeightPolicy = prepareWebToolGroupLocalHeightChange();
        if (Platform.OS !== 'web' || webHeightPolicy !== 'bottom') {
            deferAutoPinAfterLocalTranscriptInteraction();
        }
        applyToolCallsGroupExpanded(params);
    }, [applyToolCallsGroupExpanded, deferAutoPinAfterLocalTranscriptInteraction, prepareWebToolGroupLocalHeightChange]);

    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        deferAutoPinAfterLocalTranscriptInteraction();
        applyThinkingExpanded(messageId, expanded);
    }, [applyThinkingExpanded, deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded]);

    const onViewportChangeRef = React.useRef(props.onViewportChange);
    React.useEffect(() => {
        onViewportChangeRef.current = props.onViewportChange;
    }, [props.onViewportChange]);
    const emitViewportChange = React.useCallback((state: TranscriptViewportChangeState) => {
        onViewportChangeRef.current?.(state);
    }, []);
    const cancelScheduledViewportAnchorCapture = React.useCallback(() => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);
    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(props.followBottomIntentKey ?? null);

    React.useEffect(() => {
        return () => {
            flushViewportAnchorCaptureRef.current();
            flushExitLiveTailIntentRef.current();
            // An entry transaction still open at unmount closes with an attributable
            // outcome (mirror of the prepend invalidation below) — never a silent drop.
            disposeEntryRestoreTransactionForExitRef.current();
            const entryRestoreDeadlineTimeout = entryRestoreDeadlineTimeoutRef.current;
            if (entryRestoreDeadlineTimeout) {
                entryRestoreDeadlineTimeoutRef.current = null;
                clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
            }
            initialFillAbortRef.current?.abort();
            initialFillAbortRef.current = null;
            const timeoutId = olderLoadSpinnerDelayTimeoutRef.current;
            if (timeoutId) {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                clearTimeout(timeoutId);
            }
            const nativeFirstPaintFallbackReleaseTimeout = nativeFirstPaintFallbackReleaseTimeoutRef.current;
            if (nativeFirstPaintFallbackReleaseTimeout) {
                nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
                clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
            }
            const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
            if (nativeEntryRestorePaintReleaseTimeout) {
                nativeEntryRestorePaintReleaseTimeoutRef.current = null;
                clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
            }
            mountSettleCoordinatorRef.current?.reset({ reason: 'unmount' });
            pendingNativeMountSettleBottomPinRef.current = false;
            invalidateNativePrependTransactionRef.current();
            lastNativeRestoreIndexCommandRef.current = null;
            nativeMountSettleAutoPinSuppressedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        // Reset per-session state.
        flushViewportAnchorCaptureRef.current();
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        initialFillStatusRef.current = 'idle';
        setNativeMountSettleStable(false);
        nativeMountSettleDeadlineReachedRef.current = false;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        setNativeMountSettleDeadlineReached(false);
        hideOlderLoadSpinner();
        const nativeFirstPaintFallbackReleaseTimeout = nativeFirstPaintFallbackReleaseTimeoutRef.current;
        if (nativeFirstPaintFallbackReleaseTimeout) {
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        hasMoreOlderRef.current = null;
        resetOlderPaginationRef.current();
        cancelScheduledPinToBottom();
        didAutoExpandToolCallsGroupsForSessionRef.current = null;
        inFlightWebPrependAnchorRef.current = null;
        clearWebPrependRestoreWindow('abandoned-identity');
        setExpandedToolCallsAnchorMessageIds(new Set());
        const entryViewport = sessionEntryViewportRef.current;
        const shouldFollowBottom = entryViewport?.shouldFollowBottom ?? true;
        const offsetY = entryViewport?.offsetY ?? 0;
        const entryAnchor = shouldFollowBottom ? null : (entryViewport?.anchor ?? null);
        wantsPinnedRef.current = shouldFollowBottom;
        isPinnedRef.current = shouldFollowBottom;
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'session-entry',
            shouldFollowBottom,
        }));
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        // Null (no trustworthy remembered offset) must survive here: 0 would read as
        // "at the bottom" and let the exit flush fabricate a live-tail report.
        lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : (entryViewport?.offsetY ?? null);
        lastScrollOffsetForIntentRef.current = null;
        lastObservedWebScrollTopRef.current = null;
        webNonProgrammaticScrollStreakRef.current = null;
            lastNativePinOffsetRef.current = null;
            lastNativeBottomFollowPinCommandRef.current = null;
            lastProactiveAutoFollowActivityKeyRef.current = props.latestCommittedActivityKey;
            resetNativeSessionViewportLifecycle(props.sessionId);
            invalidateNativePrependTransactionRef.current();
            lastNativeRestoreIndexCommandRef.current = null;
            if (Platform.OS !== 'web') {
                listContentHeightRef.current = 0;
                setListContentHeight(0);
        }
        pendingNativeMountSettleBottomPinRef.current = false;
        const nextScrollPinState = {
            isPinned: shouldFollowBottom,
            newActivityCount: 0,
            lastActivityKey: null,
        };
        scrollPinRef.current = nextScrollPinState;
        setScrollPin(nextScrollPinState);
        jumpToBottomDistanceFromBottomRef.current = offsetY;
        setJumpToBottomDistanceFromBottom(offsetY);
        jumpToTopVisibleRef.current = false;
        setJumpToTopVisible(false);
        emitViewportChange({
            isPinned: shouldFollowBottom,
            offsetY,
            shouldRestoreViewport: !shouldFollowBottom,
            anchor: entryAnchor,
        });
    }, [
        cancelScheduledPinToBottom,
        cancelScheduledViewportAnchorCapture,
        clearWebPrependRestoreWindow,
        commitBottomFollowModeState,
        emitViewportChange,
        hideOlderLoadSpinner,
        props.sessionId,
        resetNativeSessionViewportLifecycle,
    ]);

    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    pinThresholdPxRef.current = pinThresholdPx;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const pinEnabledRef = React.useRef(pinEnabled);
    const autoFollowWhenPinnedRef = React.useRef(autoFollowWhenPinned);
    const jumpToSeqActiveRef = React.useRef(props.jumpToSeq != null);
    pinEnabledRef.current = pinEnabled;
    autoFollowWhenPinnedRef.current = autoFollowWhenPinned;
    jumpToSeqActiveRef.current = props.jumpToSeq != null;
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpRevealViewportRatio =
        typeof transcriptScrollJumpToBottomRevealViewportRatio === 'number' && Number.isFinite(transcriptScrollJumpToBottomRevealViewportRatio)
            ? Math.max(0, Math.min(TRANSCRIPT_SCROLL_JUMP_TO_BOTTOM_REVEAL_VIEWPORT_RATIO_MAX, transcriptScrollJumpToBottomRevealViewportRatio))
            : settingsDefaults.transcriptScrollJumpToBottomRevealViewportRatio;
    const jumpRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * jumpRevealViewportRatio));
    const jumpToTopRevealOffsetThresholdPx = Math.max(pinThresholdPx, Math.trunc(listLayoutHeight * 0.25));
    const commitJumpToBottomDistanceForVisibility = React.useCallback((distanceFromBottom: number) => {
        jumpToBottomDistanceFromBottomRef.current = distanceFromBottom;
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: distanceFromBottom,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    const commitJumpToTopOffsetForVisibility = React.useCallback((offsetFromTop: number) => {
        const nextVisible = Math.max(0, Math.trunc(offsetFromTop)) > jumpToTopRevealOffsetThresholdPx;
        if (jumpToTopVisibleRef.current === nextVisible) return;
        jumpToTopVisibleRef.current = nextVisible;
        setJumpToTopVisible(nextVisible);
    }, [jumpToTopRevealOffsetThresholdPx]);
    const canAutoFollowForReason = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
        options?: Readonly<{ explicit?: boolean }>,
    ): boolean => canAutoFollowTranscriptBottom({
        autoFollowWhenPinned: autoFollowWhenPinnedRef.current,
        bottomFollowMode: bottomFollowModeStateRef.current.mode,
        isExplicitUserCommand: options?.explicit === true || isExplicitTranscriptBottomFollowCommand(reason),
        jumpToSeqActive: jumpToSeqActiveRef.current && reason !== 'jump-to-seq',
        pinEnabled: pinEnabledRef.current,
        reason,
        wantsPinned: wantsPinnedRef.current,
    }), []);
    const readCurrentNativeDistanceFromBottom = React.useCallback((params: {
        contentHeight?: number;
        layoutHeight?: number;
    } = {}): number | null => {
        if (Platform.OS === 'web') return null;
        const offset = listRef.current?.getAbsoluteLastScrollOffset?.();
        if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
        const layoutHeight = typeof params.layoutHeight === 'number' && Number.isFinite(params.layoutHeight)
            ? params.layoutHeight
            : listLayoutHeightRef.current;
        const contentHeight = typeof params.contentHeight === 'number' && Number.isFinite(params.contentHeight)
            ? params.contentHeight
            : listContentHeightRef.current;
        if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        // Raw offsets map through the orientation seam once. FlashList/RN inverted
        // transforms the rendered rows, but native offsets still grow physically
        // toward the visual bottom, so the canonical offset is the native offset.
        const canonicalOffset = toCanonicalScrollOffset({
            offsetY: offset,
            contentHeight,
            layoutHeight,
            orientation: listOrientationRef.current,
        });
        return Math.max(0, Math.trunc(contentHeight - layoutHeight - canonicalOffset));
    }, []);
    const releaseNativeBottomFollowIfFlashListOffsetEscaped = React.useCallback((params: {
        contentHeight: number;
        layoutHeight: number;
    }): boolean => {
        if (Platform.OS === 'web') return false;
        if (!wantsPinnedRef.current) return false;
        if (hasActiveNativeViewportRestore()) return false;
        if (
            nativeBottomFollowRearmedAfterDragRef.current &&
            bottomFollowModeStateRef.current.mode === 'following'
        ) return false;
        // Plan P3 (B6-consistent): a stale offset against freshly grown content is only an
        // ESCAPE when the user could have escaped — an active/retained drag session, live
        // momentum, a finger on the list, or recent scroll intent. A streaming burst with no
        // touch attribution must never release follow off the not-yet-corrected offset.
        if (
            bottomFollowModeStateRef.current.mode === 'following' &&
            bottomFollowModeStateRef.current.dragSession == null &&
            !nativeMomentumScrollActiveRef.current &&
            nativeTranscriptTouchStartYRef.current == null &&
            Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
        ) return false;
        const distanceFromBottom = readCurrentNativeDistanceFromBottom(params);
        if (distanceFromBottom == null) return false;
        if (distanceFromBottom <= pinThresholdPx) return false;
        beginNativeBottomFollowGestureIntent();
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'trusted-away-observation',
            distanceFromBottom,
            movedAwayFromBottom: true,
            pinThresholdPx,
        }));
        wantsPinnedRef.current = false;
        isPinnedRef.current = false;
        return true;
    }, [
        beginNativeBottomFollowGestureIntent,
        commitBottomFollowModeState,
        hasActiveNativeViewportRestore,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
    ]);
    /**
     * Trusted arrival back at the bottom (plan B8): re-arming follow is a first-class
     * live-tail transition — the viewport emission must agree with the mode within the
     * same observation window so sync marks live-tail intent (catch-up resolves
     * `tail_reset_latest_page`, never `defer_forward_loading`, on the next big gap).
     */
    const adoptNativeFollowingForTrustedBottomArrival = React.useCallback((distanceFromBottom: number | null) => {
        if (Platform.OS === 'web') return;
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        nativeMountSettleAutoPinSuppressedRef.current = false;
        nativeBottomFollowRearmedAfterDragRef.current = true;
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        const normalizedDistance = typeof distanceFromBottom === 'number' && Number.isFinite(distanceFromBottom)
            ? Math.max(0, Math.trunc(distanceFromBottom))
            : 0;
        lastPinOffsetForIntentRef.current = normalizedDistance;
        commitJumpToBottomDistanceForVisibility(normalizedDistance);
        commitScrollPinState({ ...scrollPinRef.current, isPinned: true, newActivityCount: 0 });
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
    }, [
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinState,
        emitViewportChange,
    ]);
    const recordNativeListDragEndIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeListDragActiveRef.current = false;
        const dragSession = bottomFollowModeStateRef.current.dragSession;
        const distanceFromBottom =
            dragSession?.latestDistanceFromBottom ??
            readCurrentNativeDistanceFromBottom() ??
            null;
        const nextBottomFollowState = resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            distanceFromBottom,
            pinThresholdPx,
            sawAwayMovement: dragSession?.sawAwayMovement ?? false,
            type: 'drag-end',
        });
        commitBottomFollowModeState(nextBottomFollowState);
        if (nextBottomFollowState.mode === 'following') {
            adoptNativeFollowingForTrustedBottomArrival(distanceFromBottom);
        } else {
            nativeBottomFollowRearmedAfterDragRef.current = false;
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        commitBottomFollowModeState,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
    ]);
    const recordNativeMomentumScrollBeginIntent = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeMomentumScrollActiveRef.current = true;
    }, []);
    /**
     * Post-drag momentum settle (plan B8): a trusted fling that lands within the pin
     * threshold re-arms follow even though every momentum frame is untrusted — the
     * retained trusted drag session is the user attribution, and it closes here either way.
     * Plan B9: the window also settles out of 'following' (drag ended near the bottom with
     * momentum pending) — a fling that carried the viewport away must end released, with the
     * pin/jump-button state committed even if every momentum frame was swallowed elsewhere.
     */
    const recordNativeMomentumScrollEndSettle = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        nativeMomentumScrollActiveRef.current = false;
        const state = bottomFollowModeStateRef.current;
        if (
            (state.mode !== 'released' && state.mode !== 'following') ||
            state.dragSession?.trusted !== true
        ) return;
        const distanceFromBottom = readCurrentNativeDistanceFromBottom();
        const nextBottomFollowState = resolveTranscriptBottomFollowMode(state, {
            distanceFromBottom,
            pinThresholdPx,
            type: 'momentum-settle',
        });
        commitBottomFollowModeState(nextBottomFollowState);
        if (nextBottomFollowState.mode === 'following') {
            adoptNativeFollowingForTrustedBottomArrival(
                distanceFromBottom ?? state.dragSession.latestDistanceFromBottom,
            );
            return;
        }
        if (wantsPinnedRef.current) {
            // The fling settled away from the bottom but the drag-end-near-bottom adoption
            // left follow armed: release it now and surface the released UI state.
            const settledDistanceFromBottom = Math.max(
                0,
                Math.trunc(distanceFromBottom ?? state.dragSession.latestDistanceFromBottom ?? 0),
            );
            wantsPinnedRef.current = false;
            isPinnedRef.current = false;
            nativeBottomFollowRearmedAfterDragRef.current = false;
            cancelScheduledPinToBottom();
            lastPinOffsetForIntentRef.current = settledDistanceFromBottom;
            commitJumpToBottomDistanceForVisibility(settledDistanceFromBottom);
            commitScrollPinEvent({
                type: 'scroll',
                enabled: pinEnabledRef.current,
                offsetY: settledDistanceFromBottom,
                pinnedOffsetThresholdPx: 0,
            });
            const settledViewportState = {
                isPinned: false,
                offsetY: settledDistanceFromBottom,
                shouldRestoreViewport: true,
            };
            emitViewportChange(settledViewportState);
            // Plan P2: the settle is user-attributed (trusted drag session) — capture the
            // dwelled position even when every momentum frame was swallowed elsewhere.
            scheduleViewportAnchorCaptureRef.current(settledViewportState);
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        cancelScheduledPinToBottom,
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility,
        commitScrollPinEvent,
        emitViewportChange,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
    ]);
    React.useEffect(() => {
        setJumpToBottomDistanceFromBottom((previousCommittedDistance) =>
            resolveNextJumpToBottomDistanceVisibilityState({
                previousCommittedDistance,
                nextDistance: jumpToBottomDistanceFromBottomRef.current,
                revealThresholdPx: jumpRevealOffsetThresholdPx,
            })
        );
    }, [jumpRevealOffsetThresholdPx]);
    const jumpToBottomAffordance = resolveJumpToBottomAffordanceState({
        distanceFromBottom: jumpToBottomDistanceFromBottom,
        enabled: jumpEnabled,
        isPinned: scrollPin.isPinned,
        minNewActivityCount: jumpMinNewCount,
        newActivityCount: scrollPin.newActivityCount,
        revealThresholdPx: jumpRevealOffsetThresholdPx,
    });
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;
    // §13 catch-up overlay gate. `useSessionCatchingUpNewer` is the canonical UI-observable per-session
    // "sync is catching the transcript up to newer activity" signal (fail-closed). The signal is
    // catch-up-only by construction — sync brackets it ONLY around resume catch-up
    // (`catchUpDirectSessionMessages`), the deferred-newer backlog drain (`loadNewerMessages`, fired
    // only when a missed-while-away backlog exists), and socket-reconnect catch-up
    // (`invalidateMessagesForSession`); ordinary realtime live streaming applies messages straight
    // through the socket path and never raises it. So it cannot nag during normal pinned streaming and
    // needs NO pin gate. A `!scrollPin.isPinned` gate would in fact suppress the overlay in its
    // primary scenario: reopening a background-working session restores the user PINNED at the live
    // tail while sync silently catches up, which is exactly when the surface must show.
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const showCatchUpOverlay = isCatchingUpNewer;
    const transcriptListExtraData = React.useMemo(() => ({
        selectionVersion: transcriptMessageSelection.selectionVersion,
    }), [transcriptMessageSelection.selectionVersion]);

    // N3.1: the inverted pilot rides the flash_v2 machinery with orientation as an
    // orthogonal axis — every `=== 'flash_v2'` gate below stays authoritative; the
    // orientation is consumed ONLY at the seam boundaries (data order, raw<->canonical
    // scroll offsets, edge slots, chronological neighbor lookups).
    const transcriptListPresentation = resolveTranscriptListPresentation({
        setting: transcriptListImplementation,
        platformIsWeb: Platform.OS === 'web',
    });
    const preferredListImplementation = transcriptListPresentation.implementation;
    // Plan E1: capture the viewport synchronously inside the crash handler, BEFORE the
    // implementation flip renders, so the fallback list can restore the reading position.
    const webCrashFallbackViewportRef = React.useRef<Readonly<{
        sessionId: string;
        anchor: ReturnType<typeof captureWebTranscriptViewportAnchor>;
        distanceFromBottom: number;
    }> | null>(null);
    const pendingWebLocalHeightChangeAnchorRef = React.useRef<Readonly<{
        sessionId: string;
        anchor: WebTranscriptViewportAnchor;
    }> | null>(null);
    const captureWebCrashFallbackViewport = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        let anchor: ReturnType<typeof captureWebTranscriptViewportAnchor> = null;
        try {
            anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
        } catch {
            anchor = null;
        }
        webCrashFallbackViewportRef.current = {
            sessionId: props.sessionId,
            anchor,
            distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(metrics))),
        };
    }, [props.sessionId, resolveWebScrollMetrics]);
    const webFlashListCrashed = useWebFlashListCrashFallback({
        enabled: Platform.OS === 'web' && preferredListImplementation === 'flash_v2',
        onBeforeFallback: captureWebCrashFallbackViewport,
    });
    const listImplementation =
        Platform.OS === 'web' && preferredListImplementation === 'flash_v2' && webFlashListCrashed
            ? 'flatlist_legacy'
            : preferredListImplementation;
    const listOrientation: TranscriptListOrientation =
        listImplementation === 'flash_v2' ? transcriptListPresentation.orientation : 'standard';
    const isInvertedNativeList = listOrientation === 'inverted';
    const listOrientationRef = React.useRef(listOrientation);
    listOrientationRef.current = listOrientation;
    const resolveSyncLoadOlderOptions = React.useCallback((): SyncLoadOlderOptions | undefined => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return undefined;
        const configuredLimit = sync.getSyncTuning().transcriptNativeOlderMessagesPageSize;
        if (typeof configuredLimit !== 'number' || !Number.isFinite(configuredLimit)) return undefined;
        return { limit: Math.max(1, Math.trunc(configuredLimit)) };
    }, [listImplementation]);
    const [firstListPaintObserved, setFirstListPaintObserved] = React.useState(false);
    const [nativeViewportPaintObserved, setNativeViewportPaintObservedState] = React.useState(false);
    const nativeViewportPaintObservedRef = React.useRef(false);
    const [nativeEntryRestorePaintReleaseState, setNativeEntryRestorePaintReleaseState] = React.useState<{
        released: boolean;
        sessionId: string;
    }>(() => ({
        released: false,
        sessionId: props.sessionId,
    }));
    const nativeEntryRestorePaintReleasedRef = React.useRef<{
        released: boolean;
        sessionId: string;
    }>({
        released: false,
        sessionId: props.sessionId,
    });
    const nativeEntryRestorePaintReleased =
        nativeEntryRestorePaintReleaseState.sessionId === props.sessionId &&
        nativeEntryRestorePaintReleaseState.released;
    const updateNativeViewportPaintObserved = React.useCallback((observed: boolean) => {
        if (Platform.OS === 'web') return;
        nativeViewportPaintObservedRef.current = observed;
        setNativeViewportPaintObservedState(observed);
    }, []);
    const updateNativeEntryRestorePaintReleased = React.useCallback((released: boolean) => {
        if (Platform.OS === 'web') return;
        const nextState = {
            released,
            sessionId: props.sessionId,
        };
        nativeEntryRestorePaintReleasedRef.current = nextState;
        setNativeEntryRestorePaintReleaseState(nextState);
    }, [props.sessionId]);
    const releaseNativePaintForIssuedEntryRestore = React.useCallback(() => {
        if (Platform.OS === 'web') return false;
        if (listImplementation !== 'flash_v2') return false;
        if (nativeViewportPaintObservedRef.current) return false;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return false;
        }
        if (listLayoutHeightRef.current <= 0 || listContentHeightRef.current <= 0) return false;
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return false;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return false;
        if (entryRestoreTransactionRef.current?.sessionId !== props.sessionId) return false;

        updateNativeEntryRestorePaintReleased(true);
        return true;
    }, [listImplementation, props.sessionId, updateNativeEntryRestorePaintReleased]);
    /**
     * 32ms paint-release polish (plan A4): once the entry-restore transaction has issued its
     * write (background sessions) or closed, reveal the restored viewport shortly after.
     * The transaction deadline always fires, so the placeholder can never hang.
     */
    const scheduleNativePaintReleaseForEntryRestore = React.useCallback((options?: Readonly<{ force?: boolean }>) => {
        if (Platform.OS === 'web') return;
        if (listImplementation !== 'flash_v2') return;
        if (options?.force !== true && props.sessionActive) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === props.sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return;
        }
        if (sessionEntryViewportRef.current?.sessionId !== props.sessionId) return;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return;
        const writeContext = entryRestoreWriteContextRef.current;
        if (writeContext?.sessionId !== props.sessionId) return;
        const existing = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (
            existing?.sessionId === props.sessionId &&
            existing.issuedAtMs === writeContext.createdAtMs
        ) {
            return;
        }
        if (existing) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(existing.timeoutId);
        }

        const handle = {
            issuedAtMs: writeContext.createdAtMs,
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeEntryRestorePaintReleaseTimeoutRef.current !== handle) return;
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (entryRestoreWriteContextRef.current?.createdAtMs !== handle.issuedAtMs) return;
            releaseNativePaintForIssuedEntryRestore();
        }, TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS);
        nativeEntryRestorePaintReleaseTimeoutRef.current = handle;
    }, [listImplementation, props.sessionActive, props.sessionId, releaseNativePaintForIssuedEntryRestore]);
    const firstPaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const stablePaintTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    const [webStablePaintRetryTick, bumpWebStablePaintRetryTick] = React.useReducer((value: number) => (value + 1) % 1_000_000, 0);
    const webStablePaintRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearWebStablePaintRetry = React.useCallback(() => {
        const timeout = webStablePaintRetryTimeoutRef.current;
        if (timeout === null) return;
        clearTimeout(timeout);
        webStablePaintRetryTimeoutRef.current = null;
    }, []);
    const scheduleWebStablePaintRetry = React.useCallback(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        if (Platform.OS !== 'web') return;
        if (stablePaintTelemetryRef.current?.recorded === true) return;
        if (webStablePaintRetryTimeoutRef.current !== null) return;
        webStablePaintRetryTimeoutRef.current = setTimeout(() => {
            webStablePaintRetryTimeoutRef.current = null;
            bumpWebStablePaintRetryTick();
        }, 16);
    }, []);
    if (firstPaintTelemetryRef.current?.sessionId !== props.sessionId) {
        firstPaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }
    if (stablePaintTelemetryRef.current?.sessionId !== props.sessionId) {
        stablePaintTelemetryRef.current = {
            recorded: false,
            sessionId: props.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }

    React.useEffect(() => clearWebStablePaintRetry, [clearWebStablePaintRetry]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        if (isEnrichedMarkdownRuntimePreloaded()) {
            setWebMarkdownRuntimeReady(true);
            return undefined;
        }

        let cancelled = false;
        const preload = preloadEnrichedMarkdownRuntime();
        fireAndForget(preload, { tag: 'ChatList.webMarkdownRuntimeFirstPaint' });
        preload.then(
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
        );

        return () => {
            cancelled = true;
        };
    }, []);

    const getTurnMessageById = React.useCallback((messageId: string): Message | null => {
        const forkAwareMessage = props.messagesById[messageId];
        if (forkAwareMessage) return forkAwareMessage;
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        return session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
    }, [props.messagesById, props.sessionId]);
    const resolveToolCallMessagesForIds = React.useCallback((toolMessageIds: readonly string[]): ToolCallMessage[] => {
        const toolMessages: ToolCallMessage[] = [];
        for (const toolMessageId of toolMessageIds) {
            const message = getTurnMessageById(toolMessageId);
            if (message?.kind === 'tool-call') toolMessages.push(message);
        }
        return toolMessages;
    }, [getTurnMessageById]);
    // N2c stable virtualization units: under flash_v2 (native AND web), turn items and
    // linear tool-calls-group items decompose into per-unit rows HERE, where the
    // tool-group expansion state lives. `props.items` stays the pre-decomposition
    // source for consumers that visit turn/tool-calls-group shapes (auto-expand).
    const decomposedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        if (listImplementation !== 'flash_v2') return props.items;
        return buildTranscriptTurnUnits({
            items: props.items,
            getMessageById: getTurnMessageById,
            metadataByMessageId: props.forkMessageMetadataById ?? undefined,
            isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
            collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        listImplementation,
        props.forkMessageMetadataById,
        props.items,
        transcriptToolCallsCollapsedPreviewCountSetting,
    ]);
    // N2b.2 slice-from-anchor entry window: while set (native flash_v2 anchored
    // entries only), the rendered window STARTS at the anchor row — the anchor
    // lands at the viewport head with zero scroll writes. The withheld older rows
    // reveal as one prepend-observed commit when the entry transaction closes.
    const entrySliceSourceBounds = React.useMemo(() => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return null;
        if (!entrySliceWindow || entrySliceWindow.sessionId !== props.sessionId) return null;
        const index = decomposedItems.findIndex((item) => item.id === entrySliceWindow.anchorRowId);
        // Anchor row id no longer present (fail open: reveal everything).
        if (index < 0) return null;
        // N3.1: standard withholds OLDER rows (window starts at the anchor); inverted
        // withholds NEWER rows (window ends at the anchor) — either way the anchor is
        // the rendered HEAD (index 0 after orientation) and lands write-free.
        const bounds = resolveEntrySliceSourceBounds({
            anchorSourceIndex: index,
            count: decomposedItems.length,
            orientation: listOrientation,
        });
        return bounds.end - bounds.start < decomposedItems.length ? bounds : null;
    }, [decomposedItems, entrySliceWindow, listImplementation, listOrientation, props.sessionId]);
    entrySliceWithheldCountRef.current = entrySliceSourceBounds
        ? decomposedItems.length - (entrySliceSourceBounds.end - entrySliceSourceBounds.start)
        : 0;
    // Canonical (oldest-first) windowed view BEFORE the orientation boundary. The hot/cold
    // segmentation runs here so web (standard) and native (inverted) share one policy call;
    // each segment is then oriented independently for the rendered list.
    const canonicalWindowedItems = React.useMemo<readonly ChatTranscriptListItem[]>(() => {
        if (listImplementation === 'flatlist_legacy') return decomposedItems;
        return entrySliceSourceBounds
            ? decomposedItems.slice(entrySliceSourceBounds.start, entrySliceSourceBounds.end)
            : decomposedItems;
    }, [decomposedItems, entrySliceSourceBounds, listImplementation]);
    const displayItems = React.useMemo<readonly ChatTranscriptListItem[]>(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.items].reverse();
        }
        // N3.1: the orientation reversal is a view adapter at the LIST BOUNDARY only —
        // turn grouping, derived items, and the slice window above stay oldest-first.
        return orientTranscriptListItems(canonicalWindowedItems, listOrientation);
    }, [canonicalWindowedItems, listImplementation, listOrientation, props.items]);
    const liveTailAnchor = React.useMemo(() => resolveTranscriptLiveTailAnchor({
        items: canonicalWindowedItems,
        getMessageById: getTurnMessageById,
        thinkingFallbackMessageId: props.activeThinkingMessageId,
        // Whole-turn gate (plan §12 #1): session.thinking spans the entire active turn, so the carve
        // stays anchored at the latest committed row through the thinking→answer / text→tool
        // transition instead of collapsing on the frame no single row is flagged streaming.
        turnActive: props.sessionThinking,
        // R2: scope the running-tool anchor to a genuinely-active session — an idle session whose
        // trailing tool is stuck in `running` (disconnect / missed completion) yields NO anchor, so
        // its trailing rows are not permanently carved into the edge slot (the idle orphan).
        sessionActive: props.sessionActive,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
    }), [
        canonicalWindowedItems,
        getTurnMessageById,
        props.activeThinkingMessageId,
        props.latestCommittedActivityKey,
        props.sessionActive,
        props.sessionThinking,
    ]);
    const liveTailAnchorMessageId = liveTailAnchor?.messageId ?? null;
    const transcriptHotColdSegments = React.useMemo(() => {
        const tuning = sync.getSyncTuning();
        const platformIsWeb = Platform.OS === 'web';
        // Web keeps its trailing-N window; native carves only the live-tail (flag = item count,
        // default 0 = OFF = today's all-in-FlashList behavior). Both call ONE policy on the
        // canonical oldest-first array (trailing = newest), then orient each segment.
        const hotTailItemCount = platformIsWeb
            ? tuning.transcriptWebHotTailItemCount
            : tuning.transcriptNativeHotTailItemCount;
        // FIX 2 (native standard orientation guard): the native carve renders the live tail in the
        // edge slot, which hardcodes `displayIndexMode="invertedEdgeSlot"` and whose pin guards assume
        // inverted orientation. flash_v2 STANDARD is selectable on native (non-default), so the native
        // carve must ONLY engage under inverted orientation — standard-native flash_v2 falls back to
        // the cold list / all-in behavior (never the inverted edge slot). Web is always standard and
        // owns its in-flow footer carve, so it is unaffected by this guard.
        const enabled =
            listImplementation === 'flash_v2' &&
            (platformIsWeb || (hotTailItemCount > 0 && listOrientation === 'inverted'));
        const segments = buildTranscriptHotColdSegments({
            enabled,
            hotTailItemCount: hotTailItemCount > 0 ? hotTailItemCount : 1,
            // Native renders the hot tail OUTSIDE the recycler (inverted edge slot), so it must be
            // bounded to the trailing window — otherwise an early active item un-virtualizes the whole
            // transcript (device-proven blank/jank). Web keeps the unbounded pullers (web-virtualized cold).
            maxHotTailItems: platformIsWeb ? undefined : (hotTailItemCount > 0 ? hotTailItemCount : 1),
            // Native carves ONLY the actively-streaming live tail (empty when idle) — the edge slot's
            // sole job is the per-token-growing row, so an idle/trailing block there just orphans +
            // persists stale rows. Web keeps its trailing-N window (in-flow footer, recent rows hot).
            liveTailOnly: !platformIsWeb,
            items: canonicalWindowedItems,
            activeThinkingMessageId: props.activeThinkingMessageId,
            liveTailAnchorMessageId,
            expandedToolCallsAnchorMessageIds,
        });
        return {
            coldItems: orientTranscriptListItems(segments.coldItems, listOrientation),
            hotItems: orientTranscriptListItems(segments.hotItems, listOrientation),
            // The CANONICAL (pre-orientation, oldest-first) hot slice. The native inverted edge
            // slot renders these directly (top→bottom = oldest→newest) so, under the slot's
            // order-preserving scaleY(-1) translation, the newest row sits at the VISUAL bottom.
            // The oriented `hotItems` above is newest-first; on web (standard orientation) the two
            // are byte-identical references (orientTranscriptListItems is identity for 'standard'),
            // so the web footer path is unchanged.
            hotItemsCanonical: segments.hotItems,
            // Counts/boundary stay in canonical oldest-first terms (orientation-invariant length).
            coldCount: segments.coldItems.length,
            hotCount: segments.hotItems.length,
            splitIndex: segments.splitIndex,
        };
    }, [canonicalWindowedItems, expandedToolCallsAnchorMessageIds, listImplementation, listOrientation, liveTailAnchorMessageId, props.activeThinkingMessageId]);
    const transcriptHotColdSplitActive =
        listImplementation === 'flash_v2' && transcriptHotColdSegments.hotItems.length > 0;
    const shouldUseWebHotColdSplit = Platform.OS === 'web' && transcriptHotColdSplitActive;
    const shouldUseNativeHotColdSplit = Platform.OS !== 'web' && transcriptHotColdSplitActive;
    const listData = transcriptHotColdSplitActive ? transcriptHotColdSegments.coldItems : displayItems;
    if (!shouldUseNativeHotColdSplit) {
        // The native hot tail unmounts when the split is OFF/empty (e.g. after a finalize
        // hand-off) — drop its captured height so the inverted bottom inset returns to the
        // composer-only inset on the next pin.
        nativeHotTailHeightRef.current = 0;
    }
    webHotColdCountsRef.current = {
        coldCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.coldItems.length
            : listData.length,
        hotCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.hotItems.length
            : 0,
    };
    // §12 #4 telemetry (review R9): snapshot the live-region carve context each render so the
    // scroll-write executor + the height-driven pin can stamp every carve pin with the anchor that
    // opened it, the hot/cold counts, and whether the live region owns the bottom — without
    // re-deriving any of it inside the scroll callbacks (which would force a recompute).
    liveTailCarveTelemetryRef.current = {
        active: shouldUseNativeHotColdSplit,
        anchorId: liveTailAnchor?.messageId ?? null,
        anchorKind: liveTailAnchor?.reason ?? null,
        coldCount: transcriptHotColdSegments.coldCount,
        hotCount: transcriptHotColdSegments.hotCount,
    };

    React.useEffect(() => {
        // A stale slice window from the previous session is already inert (sessionId
        // mismatch); release the state so the next entry starts clean.
        if (entrySliceWindow && entrySliceWindow.sessionId !== props.sessionId) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
        }
    }, [entrySliceWindow, props.sessionId]);

    React.useEffect(() => {
        if (props.jumpToSeq == null) return;
        if (entrySliceWindowRef.current?.sessionId !== props.sessionId) return;
        // An explicit jump owns the viewport: drop the slice window without a prepend
        // transaction — the jump's own write places the viewport next.
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
    }, [props.jumpToSeq, props.sessionId]);

    React.useEffect(() => {
        setFirstListPaintObserved(false);
        updateNativeViewportPaintObserved(false);
        updateNativeEntryRestorePaintReleased(false);
        nativeVisibleWindowSnapshotRef.current = null;
        lastNativeVisibleRowsSnapshotRef.current = null;
    }, [
        listImplementation,
        props.sessionId,
        updateNativeEntryRestorePaintReleased,
        updateNativeViewportPaintObserved,
    ]);

    // Keep a synchronous view of the current list items for effects that run between renders
    // (e.g. initial viewport fill and jump-to-seq resolution). `itemsRef`/`listDataRef`
    // ALWAYS hold the same decomposed array the list renders; index-based consumers
    // (renderItem prev-row lookup, jump/anchor/prepend index math) must use these.
    itemsRef.current = displayItems;
    listDataRef.current = listData;
    preDecompositionItemsRef.current = props.items;

    React.useEffect(() => {
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId: props.sessionId,
            latestMessageId: props.latestCommittedActivityKey,
            committedMessages: props.committedMessagesCount,
            transcriptLoaded: props.isLoaded ? 1 : 0,
            visibleItems: listData.length,
        });
    }, [
        listData.length,
        props.committedMessagesCount,
        props.isLoaded,
        props.latestCommittedActivityKey,
        props.sessionId,
    ]);

    React.useEffect(() => {
        return () => {
            clearStreamingSessionUiTelemetryMarks(props.sessionId);
        };
    }, [props.sessionId]);

    const usesNativeFlashListBottomMaintenance =
        Platform.OS !== 'web' && listImplementation === 'flash_v2';
    const hasRearmedNativeBottomFollow = React.useCallback((): boolean => (
        usesNativeFlashListBottomMaintenance &&
        bottomFollowModeStateRef.current.mode === 'following' &&
        wantsPinnedRef.current &&
        isPinnedRef.current
    ), [usesNativeFlashListBottomMaintenance]);
    const nativeEntryShouldUseBottomMaintenance =
        sessionEntryViewportRef.current?.shouldFollowBottom !== false;
    const configuredFlashListDrawDistance = sync.getSyncTuning().transcriptFlashListDrawDistance;
    // C4: explicit tuning stays the override; the unset default is ~1x viewport height clamped
    // to [600, 1200]px so rows above the viewport (where prepends land and where the user is
    // heading while paginating) are measured before they enter (E4 height churn, prepend
    // layout-not-ready windows). FlashList's own default is only 250px on native.
    const flashListDrawDistance =
        Platform.OS !== 'web'
            ? (typeof configuredFlashListDrawDistance === 'number' &&
                Number.isFinite(configuredFlashListDrawDistance) &&
                configuredFlashListDrawDistance > 0
                ? Math.trunc(configuredFlashListDrawDistance)
                : Math.min(
                    TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX,
                    Math.max(
                        TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX,
                        Math.ceil(Number.isFinite(listLayoutHeight) ? listLayoutHeight : 0),
                    ),
                ))
            : undefined;
    const telemetryPlatform = resolveTranscriptViewportTelemetryPlatform(Platform.OS);
    const telemetryListImplementation = resolveTranscriptViewportTelemetryListImplementation({
        platform: telemetryPlatform,
        listImplementation,
    });
    const resolveNativeVisibleWindowSnapshot = React.useCallback((): NativeVisibleWindowSnapshot => {
        const data = listDataRef.current;
        const layoutHeight = listLayoutHeightRef.current;
        const blankAreaPx = data.length > 0 && Number.isFinite(layoutHeight) && layoutHeight > 0
            ? Math.max(0, Math.trunc(layoutHeight))
            : 0;
        const resolveLastKnownVisibleRowsSnapshot = (): NativeVisibleWindowSnapshot | null => {
            const snapshot = lastNativeVisibleRowsSnapshotRef.current;
            if (!snapshot?.hasVisibleRows) return null;
            const rowIds = new Set(data.map((item) => item.id));
            if (
                (snapshot.firstVisibleItemId && !rowIds.has(snapshot.firstVisibleItemId)) ||
                (snapshot.lastVisibleItemId && !rowIds.has(snapshot.lastVisibleItemId))
            ) {
                return null;
            }
            return snapshot;
        };
        const buildBlankSnapshot = (
            visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
        ): NativeVisibleWindowSnapshot => {
            const lastKnownSnapshot = resolveLastKnownVisibleRowsSnapshot();
            if (lastKnownSnapshot) {
                return {
                    blankAreaPx,
                    blankAreaSource: 'index-estimate',
                    hasVisibleRows: false,
                    lastKnownFirstVisibleItemId: lastKnownSnapshot.firstVisibleItemId,
                    lastKnownLastVisibleItemId: lastKnownSnapshot.lastVisibleItemId,
                    visibleWindowSource,
                    visibleWindowStale: true,
                };
            }
            return {
                blankAreaPx,
                blankAreaSource: 'index-estimate',
                hasVisibleRows: false,
                visibleWindowSource,
            };
        };
        const buildSnapshotFromRange = (
            startIndex: number,
            endIndex: number,
            visibleWindowSource: TranscriptViewportTelemetryVisibleWindowSource,
        ): NativeVisibleWindowSnapshot | null => {
            if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
            if (data.length === 0) {
                return {
                    blankAreaPx: 0,
                    blankAreaSource: 'none',
                    hasVisibleRows: false,
                    visibleWindowSource,
                };
            }
            const normalizedStart = Math.trunc(startIndex);
            const normalizedEnd = Math.trunc(endIndex);
            if (normalizedStart > normalizedEnd) {
                return buildBlankSnapshot(visibleWindowSource);
            }
            const clampedStart = Math.max(0, Math.min(data.length - 1, normalizedStart));
            const clampedEnd = Math.max(0, Math.min(data.length - 1, normalizedEnd));
            if (clampedStart > clampedEnd) {
                return buildBlankSnapshot(visibleWindowSource);
            }
            const firstVisibleItemId = data[clampedStart]?.id;
            const lastVisibleItemId = data[clampedEnd]?.id;
            if (!firstVisibleItemId && !lastVisibleItemId) {
                return buildBlankSnapshot(visibleWindowSource);
            }
            const snapshot: NativeVisibleWindowSnapshot = {
                blankAreaPx: 0,
                blankAreaSource: 'none',
                firstVisibleItemId,
                hasVisibleRows: true,
                lastVisibleItemId,
                visibleWindowSource,
            };
            lastNativeVisibleRowsSnapshotRef.current = snapshot;
            return snapshot;
        };

        try {
            const visibleIndices = listRef.current?.computeVisibleIndices?.();
            const snapshot = visibleIndices
                ? buildSnapshotFromRange(visibleIndices.startIndex, visibleIndices.endIndex, 'ref-compute')
                : null;
            if (snapshot) return snapshot;
        } catch {
            // Fall through to the viewability/ref fallback; telemetry must not affect scrolling.
        }

        try {
            const firstVisibleIndex = listRef.current?.getFirstVisibleIndex?.();
            if (typeof firstVisibleIndex === 'number' && Number.isFinite(firstVisibleIndex)) {
                const snapshot = buildSnapshotFromRange(firstVisibleIndex, firstVisibleIndex, 'ref-first-index');
                if (snapshot) return snapshot;
            }
        } catch {
            // Fall through to the last viewability callback snapshot.
        }

        return nativeVisibleWindowSnapshotRef.current ?? {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            hasVisibleRows: false,
            visibleWindowSource: 'none',
        };
    }, []);

    const resolveNativeTelemetryDiagnostics = React.useCallback((
        source: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
        if (Platform.OS === 'web' || telemetryListImplementation !== 'flash_v2') return {};
        const orientation: TranscriptViewportTelemetryListOrientation =
            listOrientationRef.current === 'inverted' ? 'inverted' : 'standard';
        const rawOffsetFromSource = readFiniteTelemetryNumber(source.rawOffsetY);
        let rawOffsetFromList: number | undefined;
        try {
            rawOffsetFromList = readFiniteTelemetryNumber(listRef.current?.getAbsoluteLastScrollOffset?.());
        } catch {
            rawOffsetFromList = undefined;
        }
        const rawOffsetY = rawOffsetFromSource ?? rawOffsetFromList;
        const layoutHeight =
            readFiniteTelemetryNumber(source.layoutHeight) ?? readFiniteTelemetryNumber(listLayoutHeightRef.current);
        const contentHeight =
            readFiniteTelemetryNumber(source.contentHeight) ?? readFiniteTelemetryNumber(listContentHeightRef.current);
        const canonicalOffsetY =
            readFiniteTelemetryNumber(source.canonicalOffsetY)
            ?? (
                rawOffsetY !== undefined &&
                layoutHeight !== undefined &&
                contentHeight !== undefined
                    ? toCanonicalScrollOffset({
                        offsetY: rawOffsetY,
                        contentHeight,
                        layoutHeight,
                        orientation,
                    })
                    : readFiniteTelemetryNumber(source.offsetY)
            );
        const distanceFromBottom =
            readFiniteTelemetryNumber(source.distanceFromBottom)
            ?? (
                canonicalOffsetY !== undefined &&
                layoutHeight !== undefined &&
                contentHeight !== undefined
                    ? Math.max(0, Math.trunc(contentHeight - layoutHeight - canonicalOffsetY))
                    : undefined
            );
        const isAtRawBottom =
            readTelemetryBoolean(source.isAtRawBottom)
            ?? (
                rawOffsetY !== undefined &&
                layoutHeight !== undefined &&
                contentHeight !== undefined
                    ? (
                        Math.abs(rawOffsetY - resolveBottomRawScrollOffset({
                            contentHeight,
                            layoutHeight,
                            orientation,
                        })) <= 1
                    )
                    : undefined
            );
        const visibleSnapshot = resolveNativeVisibleWindowSnapshot();
        const bottomFollowState = bottomFollowModeStateRef.current;
        const bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode =
            bottomFollowState.mode === 'escaping' || bottomFollowState.mode === 'released'
                ? bottomFollowState.mode
                : 'following';

        return {
            orientation,
            ...(rawOffsetY !== undefined ? { rawOffsetY } : {}),
            ...(canonicalOffsetY !== undefined ? { canonicalOffsetY } : {}),
            ...(layoutHeight !== undefined ? { layoutHeight } : {}),
            ...(contentHeight !== undefined ? { contentHeight } : {}),
            ...(distanceFromBottom !== undefined ? { distanceFromBottom } : {}),
            bottomFollowMode,
            dragSessionTrusted: bottomFollowState.dragSession?.trusted === true,
            nativeMomentumActive: nativeMomentumScrollActiveRef.current,
            mvcpPolicy: nativeFlashListMvcpPolicyRef.current,
            ...(isAtRawBottom !== undefined ? { isAtRawBottom } : {}),
            hasVisibleRows: visibleSnapshot.hasVisibleRows,
            ...(visibleSnapshot.firstVisibleItemId ? { firstVisibleItemId: visibleSnapshot.firstVisibleItemId } : {}),
            ...(visibleSnapshot.lastVisibleItemId ? { lastVisibleItemId: visibleSnapshot.lastVisibleItemId } : {}),
            ...(visibleSnapshot.visibleWindowStale ? { visibleWindowStale: true } : {}),
            ...(visibleSnapshot.lastKnownFirstVisibleItemId ? { lastKnownFirstVisibleItemId: visibleSnapshot.lastKnownFirstVisibleItemId } : {}),
            ...(visibleSnapshot.lastKnownLastVisibleItemId ? { lastKnownLastVisibleItemId: visibleSnapshot.lastKnownLastVisibleItemId } : {}),
            blankAreaPx: visibleSnapshot.blankAreaPx,
            blankAreaSource: visibleSnapshot.blankAreaSource,
            visibleWindowSource: visibleSnapshot.visibleWindowSource,
        };
    }, [
        resolveNativeVisibleWindowSnapshot,
        telemetryListImplementation,
    ]);
    const resolveViewportTelemetryMode = React.useCallback((mode?: TranscriptViewportMode): TranscriptViewportMode => {
        return mode ?? (wantsPinnedRef.current ? 'follow-bottom' : 'user-unpinned');
    }, []);
    const recordViewportTelemetryEvent = React.useCallback((
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => {
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        if (!transcriptViewportTelemetry.isEnabled()) return;
        const nativeDiagnostics = resolveNativeTelemetryDiagnostics(event);
        recordTranscriptViewportTelemetryEvent({
            ...event,
            ...nativeDiagnostics,
            sessionId: options?.sessionId ?? props.sessionId,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
            timestampMs: Date.now(),
        }, tuning);
    }, [
        props.sessionId,
        resolveNativeTelemetryDiagnostics,
        telemetryListImplementation,
        telemetryPlatform,
    ]);
    const recordRestoreDecisionTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason,
        params: Readonly<{
            anchorCorrectionAttempt?: number;
            anchorCorrectionTargetOffsetY?: number;
            anchorDeltaPx?: number;
            anchorIndex?: number;
            anchorItemOffsetPx?: number;
            anchorObservedItemOffsetPx?: number;
            anchorRestoreViewOffset?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            layoutHeight?: number;
            mode?: TranscriptViewportMode;
            offsetY?: number;
            programmaticWebWrite?: boolean;
            scrollable?: boolean;
            webTrigger?: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
        }> = {},
    ) => {
        const webMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: resolveViewportTelemetryMode(params.mode ?? 'restore-distance'),
            reason,
            offsetY: params.offsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            anchorIndex: params.anchorIndex,
            anchorItemOffsetPx: params.anchorItemOffsetPx,
            anchorObservedItemOffsetPx: params.anchorObservedItemOffsetPx,
            anchorDeltaPx: params.anchorDeltaPx,
            anchorCorrectionAttempt: params.anchorCorrectionAttempt,
            anchorCorrectionTargetOffsetY: params.anchorCorrectionTargetOffsetY,
            anchorRestoreViewOffset: params.anchorRestoreViewOffset,
            ...(Platform.OS === 'web' ? resolveWebViewportTelemetryDiagnostics({
                metrics: webMetrics,
                flashListContentHeight: params.contentHeight,
                flashListLayoutHeight: params.layoutHeight,
                programmaticWebWrite: params.programmaticWebWrite ?? false,
                scrollable: params.scrollable,
                trigger: params.webTrigger ?? (params.mode === 'jump-to-bottom' ? 'jump' : 'restore'),
            }) : {}),
        });
    }, [
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
    ]);

    const scheduleWebPrependRestoreWindowExpiry = React.useCallback((anchor: WebTranscriptPrependAnchor | null) => {
        cancelWebPrependRestoreWindowExpiry();
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2' || anchor === null) return;

        const arm = (target: WebTranscriptPrependAnchor) => {
            const delayMs = Math.max(0, Math.ceil(target.expiresAtMs - Date.now())) + 1;
            webPrependRestoreWindowExpiryTimeoutRef.current = setTimeout(() => {
                webPrependRestoreWindowExpiryTimeoutRef.current = null;
                const pendingAnchor = pendingWebPrependAnchorRef.current;
                if (!pendingAnchor) return;
                if (Date.now() <= pendingAnchor.expiresAtMs) {
                    arm(pendingAnchor);
                    return;
                }
                clearWebPrependRestoreWindow('abandoned-identity');
                recordRestoreDecisionTelemetry('skipped', {
                    mode: 'restore-anchor',
                    programmaticWebWrite: false,
                    webTrigger: 'prepend-restore',
                });
            }, delayMs);
        };

        arm(anchor);
    }, [
        cancelWebPrependRestoreWindowExpiry,
        clearWebPrependRestoreWindow,
        listImplementation,
        recordRestoreDecisionTelemetry,
    ]);

    const recordScrollObservedTelemetry = React.useCallback((
        params: Readonly<{
            contentHeight?: number;
            distanceFromBottom: number;
            layoutHeight?: number;
            offsetY: number;
            rawOffsetY?: number;
            canonicalOffsetY?: number;
            reason?: TranscriptViewportTelemetryObservationReason;
        }>,
    ) => {
        recordViewportTelemetryEvent({
            type: 'scroll-observed',
            mode: resolveViewportTelemetryMode(),
            reason: params.reason ?? 'observed',
            offsetY: params.offsetY,
            rawOffsetY: params.rawOffsetY,
            canonicalOffsetY: params.canonicalOffsetY,
            layoutHeight: params.layoutHeight,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
        });
    }, [recordViewportTelemetryEvent, resolveViewportTelemetryMode]);

    const recordNativeVisibleWindowTelemetry = React.useCallback((
        reason: TranscriptViewportTelemetryObservationReason = 'observed',
        params: Readonly<{
            canonicalOffsetY?: number;
            contentHeight?: number;
            distanceFromBottom?: number;
            layoutHeight?: number;
            rawOffsetY?: number;
        }> = {},
    ) => {
        if (Platform.OS === 'web' || telemetryListImplementation !== 'flash_v2') return;
        const rawOffsetY = params.rawOffsetY ?? readFiniteTelemetryNumber(listRef.current?.getAbsoluteLastScrollOffset?.());
        const layoutHeight = params.layoutHeight ?? listLayoutHeightRef.current;
        const contentHeight = params.contentHeight ?? listContentHeightRef.current;
        const canonicalOffsetY =
            params.canonicalOffsetY ??
            (
                rawOffsetY !== undefined
                    ? toCanonicalScrollOffset({
                        offsetY: rawOffsetY,
                        contentHeight,
                        layoutHeight,
                        orientation: listOrientationRef.current,
                    })
                    : undefined
            );
        const distanceFromBottom =
            params.distanceFromBottom ??
            (
                canonicalOffsetY !== undefined
                    ? Math.max(0, Math.trunc(contentHeight - layoutHeight - canonicalOffsetY))
                    : undefined
            );
        recordViewportTelemetryEvent({
            type: 'visible-window-observed',
            mode: resolveViewportTelemetryMode(),
            reason,
            rawOffsetY,
            canonicalOffsetY,
            offsetY: canonicalOffsetY,
            layoutHeight,
            contentHeight,
            distanceFromBottom,
        });
    }, [
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        telemetryListImplementation,
    ]);

    const handleNativeViewableItemsChanged = React.useCallback((info: Readonly<{
        viewableItems?: readonly NativeViewableTranscriptItem[];
    }>) => {
        if (Platform.OS === 'web' || telemetryListImplementation !== 'flash_v2') return;
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        if (!transcriptViewportTelemetry.isEnabled()) return;
        const viewableItems = Array.isArray(info.viewableItems) ? info.viewableItems : [];
        const visibleItems = viewableItems
            .filter((item) => item.isViewable !== false)
            .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
        const first = visibleItems[0];
        const last = visibleItems[visibleItems.length - 1];
        const layoutHeight = listLayoutHeightRef.current;
        const blankAreaPx =
            visibleItems.length === 0 &&
            listDataRef.current.length > 0 &&
            Number.isFinite(layoutHeight) &&
            layoutHeight > 0
                ? Math.max(0, Math.trunc(layoutHeight))
                : 0;
        nativeVisibleWindowSnapshotRef.current = {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            firstVisibleItemId: first?.item?.id,
            hasVisibleRows: visibleItems.length > 0,
            lastVisibleItemId: last?.item?.id,
            visibleWindowSource: 'viewability-callback',
        };
        if (nativeVisibleWindowSnapshotRef.current.hasVisibleRows) {
            lastNativeVisibleRowsSnapshotRef.current = nativeVisibleWindowSnapshotRef.current;
        }
        recordNativeVisibleWindowTelemetry('observed');
    }, [
        recordNativeVisibleWindowTelemetry,
        telemetryListImplementation,
    ]);

    const shouldAttachNativeViewabilityTelemetry =
        Platform.OS !== 'web' &&
        telemetryListImplementation === 'flash_v2' &&
        sync.getSyncTuning().transcriptViewportTelemetryEnabled === true;
    const nativeViewabilityConfig = React.useMemo(() => (
        shouldAttachNativeViewabilityTelemetry
            ? { itemVisiblePercentThreshold: 1 }
            : undefined
    ), [shouldAttachNativeViewabilityTelemetry]);

    // ---- N1 evidence wiring (dev-gated telemetry only; zero product behavior) ----
    // Row identity state for N1.2/N1.3: last measured height and last content count per row id,
    // plus a lazy index lookup over the current list data for viewport-relation geometry.
    const rowEvidenceHeightsRef = React.useRef(new Map<string, number>());
    const rowEvidenceContentCountsRef = React.useRef(new Map<string, number>());
    const rowEvidenceIndexLookupRef = React.useRef<{
        data: readonly ChatTranscriptListItem[];
        indexById: Map<string, number>;
    } | null>(null);
    React.useEffect(() => {
        rowEvidenceHeightsRef.current.clear();
        rowEvidenceContentCountsRef.current.clear();
        rowEvidenceIndexLookupRef.current = null;
    }, [props.sessionId]);
    const isViewportEvidenceTelemetryEnabled = React.useCallback((): boolean => {
        // The telemetry singleton is reconfigured on every record call; refresh it here too so
        // the gate observes CDP debug overrides armed after the last recorded event.
        configureTranscriptViewportTelemetryFromTuning(sync.getSyncTuning());
        return transcriptViewportTelemetry.isEnabled();
    }, []);
    const resolveRowEvidenceViewportRelation = React.useCallback((itemId: string) => {
        const data = listDataRef.current;
        let lookup = rowEvidenceIndexLookupRef.current;
        if (!lookup || lookup.data !== data) {
            const indexById = new Map<string, number>();
            for (let i = 0; i < data.length; i += 1) {
                const item = data[i];
                if (item) indexById.set(item.id, i);
            }
            lookup = { data, indexById };
            rowEvidenceIndexLookupRef.current = lookup;
        }
        const index = lookup.indexById.get(itemId);
        const layout = index === undefined ? undefined : listRef.current?.getLayout?.(index);
        return resolveTranscriptRowViewportRelation({
            rowTopY: layout?.y,
            rowHeightPx: layout?.height,
            scrollOffsetY: listRef.current?.getAbsoluteLastScrollOffset?.(),
            viewportHeightPx: listLayoutHeightRef.current,
        });
    }, []);
    const handleRowShellMeasured = React.useCallback((params: Readonly<{
        itemId: string;
        rowKind: string;
        heightPx: number;
    }>) => {
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousHeightPx = rowEvidenceHeightsRef.current.get(params.itemId);
        rowEvidenceHeightsRef.current.set(params.itemId, params.heightPx);
        // Same-height re-layouts are not visual deltas; record first measures and changes only.
        if (previousHeightPx === params.heightPx) return;
        recordViewportTelemetryEvent({
            type: 'row-measured',
            mode: resolveViewportTelemetryMode(),
            rowId: params.itemId,
            rowKind: params.rowKind,
            rowHeightPx: params.heightPx,
            rowPreviousHeightPx: previousHeightPx,
            rowDeltaPx: previousHeightPx === undefined ? undefined : params.heightPx - previousHeightPx,
            rowMeasurePhase: previousHeightPx === undefined ? 'first' : 'remeasure',
            rowViewportRelation: resolveRowEvidenceViewportRelation(params.itemId),
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        recordViewportTelemetryEvent,
        resolveRowEvidenceViewportRelation,
        resolveViewportTelemetryMode,
    ]);
    // C1: a monotonically increasing per-commit token. The reconciler coalesces the global
    // `clearLayoutCacheOnUpdate` to at most one clear per commit token, so the host only needs to
    // advance it once per React commit.
    const layoutInvalidationCommitTokenRef = React.useRef(0);
    React.useEffect(() => {
        layoutInvalidationCommitTokenRef.current += 1;
    });
    const handleRowLayoutMutation = React.useCallback((params: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => {
        const { reason, previousSignature, nextSignature } = params.mutation;
        const viewportTransactionOpen =
            hasOpenNativePrependTransactionForSession() || hasOpenEntryRestoreTransactionForSession();
        const commitToken = layoutInvalidationCommitTokenRef.current;
        // C1: the sole, transaction-gated `clearLayoutCacheOnUpdate` caller. The reconciler clears
        // only on a real structural delta (never on a streaming append) and never while a prepend or
        // entry-restore transaction owns the viewport — preserving the anti-thrash intent without the
        // blunt streaming suppression. A deferred clear is not queued; the next post-transaction
        // structural mutation re-requests (a clear is a refresh, not a debt). A direct expand/collapse
        // is a discrete structural action with no signature pair, so it asks for a structural clear.
        const decision = (reason === 'signature-change' && previousSignature !== undefined && nextSignature !== undefined)
            ? measurementReconciler.requestGlobalLayoutInvalidation({
                previous: previousSignature,
                next: nextSignature,
                viewportTransactionOpen,
                commitToken,
            })
            : measurementReconciler.requestGlobalLayoutInvalidation({
                structural: reason === 'expand' || reason === 'collapse',
                viewportTransactionOpen,
                commitToken,
            });
        if (decision.clear) {
            listRef.current?.clearLayoutCacheOnUpdate?.();
        }
    }, [
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        measurementReconciler,
    ]);
    React.useEffect(() => {
        // N1.1 + N2d.1: one always-on subscription to the patched FlashList offset corrector.
        // Production consumer: the open prepend transaction's corrector-deference signal —
        // applied corrections accumulate on the transaction so the observation can classify a
        // corrector-covered commit as mvcp-preserved instead of double-correcting. Dev/QA
        // consumer: viewport telemetry (gated per event at the listener level).
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return undefined;
        return subscribeToFlashListOffsetCorrections((event) => {
            if (event.type === 'correction-applied' && typeof event.diffPx === 'number') {
                const transaction = nativePrependTransactionRef.current;
                if (transaction && !transaction.isClosed()) {
                    transaction.onCorrectorCorrectionApplied(event.diffPx);
                    if (transaction.state() === 'committed' && nativePrependCorrectorNudgeRef.current == null) {
                        // Re-observe off the vendor scroll path so the covered classification
                        // closes the window promptly (before the quiet gate can spend the fallback).
                        nativePrependCorrectorNudgeRef.current = setTimeout(() => {
                            nativePrependCorrectorNudgeRef.current = null;
                            observeNativePrependTransactionRef.current();
                        }, 0);
                    }
                }
            }
            if (!isViewportEvidenceTelemetryEnabled()) return;
            recordViewportTelemetryEvent({
                type: 'offset-correction',
                mode: resolveViewportTelemetryMode(),
                correctionAction: event.type,
                correctionSource: event.source,
                correctionDiffPx: event.diffPx,
            });
        });
    }, [
        isViewportEvidenceTelemetryEnabled,
        listImplementation,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
    ]);

    /**
     * Deferred-newer drain (plan C6/D3): the list supplies viewport GEOMETRY only. The data layer
     * accrues the deferred-forward backlog and owns the release decision (threshold + in-flight
     * dedupe + fetch) in `sync.maybeDrainDeferredNewerMessages`. Routing the list through that single
     * owner removes the parallel list-side decision path that silently stalled catch-up on list
     * shells that did not reproduce the old onScroll callbacks.
     */
    const drainDeferredNewerMessages = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        pinned: boolean;
    }>) => {
        sync.maybeDrainDeferredNewerMessages(props.sessionId, {
            isPinned: params.pinned,
            distanceFromBottomPx: params.distanceFromBottom,
        });
    }, [props.sessionId]);

    const resolveViewportCommand = React.useCallback((input: TranscriptViewportControllerInput): TranscriptViewportCommand => {
        return viewportCommandController.resolve(input);
    }, [viewportCommandController]);

    const hasWebPrependRestoreWindow = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        return (
            inFlightWebPrependAnchorRef.current != null ||
            pendingWebPrependAnchorRef.current != null ||
            pendingWebPrependIndexRecoveryRef.current === true
        );
    }, []);

    const resolveViewportCommandTelemetryWriter = React.useCallback((
        command: TranscriptViewportCommand,
    ): TranscriptViewportTelemetryScrollWriter => {
        if (command.kind === 'none' || command.kind === 'skip-native-js-pin') return 'mvcp-skip';
        if (command.kind === 'restore-index' || command.kind === 'jump-to-seq') {
            return resolveIndexScrollWriter({ platform: telemetryPlatform, listImplementation });
        }
        if (Platform.OS === 'web') {
            return command.kind === 'pin-bottom' || command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom'
                ? 'web-dom-bottom'
                : 'web-dom-restore';
        }
        return command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset';
    }, [listImplementation, telemetryPlatform]);

    const executeViewportCommand = React.useCallback((command: TranscriptViewportCommand): boolean => {
        return viewportCommandController.execute(command, {
            hasWebPrependRestoreWindow,
            isWeb: Platform.OS === 'web',
            recordRejectedWrite: ({ command: rejectedCommand, rejectedOwner, activeOwner }) => {
                recordViewportTelemetryEvent({
                    type: 'scroll-write-rejected',
                    writer: resolveViewportCommandTelemetryWriter(rejectedCommand),
                    reason: rejectedCommand.reason,
                    rejectedOwner,
                    activeOwner,
                    mode: rejectedCommand.mode,
                    targetOffsetY: rejectedCommand.kind === 'scroll-offset' || rejectedCommand.kind === 'restore-offset'
                        ? rejectedCommand.offsetY
                        : rejectedCommand.kind === 'restore-index' || rejectedCommand.kind === 'jump-to-seq'
                            ? rejectedCommand.index
                            : undefined,
                    layoutHeight: listLayoutHeightRef.current,
                    contentHeight: listContentHeightRef.current,
                    nativeMountSettleStable,
                });
            },
            perform: (commandToPerform) => {
        const command = commandToPerform;
        if (command.kind === 'skip-native-js-pin') {
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: 'mvcp-skip',
                reason: command.reason,
                mode: command.mode,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: lastPinOffsetForIntentRef.current ?? undefined,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'pin-bottom') {
            if (Platform.OS === 'web') {
                clearWebPrependRangeReserve();
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
                try {
                    metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                } catch {
                    try {
                        metrics.element.scrollTop = scrollToVisualBottom ? metrics.scrollHeight : 0;
                    } catch {
                        return false;
                    }
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                const targetOffsetY = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: 'web-dom-bottom',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                    ...resolveWebViewportTelemetryDiagnostics({
                        metrics,
                        programmaticWebWrite: true,
                        scrollable: isWebTranscriptScrollable(metrics, 1),
                        trigger: command.reason === 'prepend-restore' ? 'prepend-restore' : command.mode === 'jump-to-bottom' ? 'jump' : 'restore',
                    }),
                });
                return true;
            }

            const node = listRef.current;
            if (!node) return false;
            const isLegacyList = listImplementation === 'flatlist_legacy';
            const isInvertedOrientation = listOrientationRef.current === 'inverted';
            const offset = isLegacyList
                ? 0
                : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
            if (!isLegacyList && !isInvertedOrientation && command.mode === 'jump-to-bottom' && typeof node.scrollToEnd === 'function') {
                // Plan B7: an explicit jump targets the list's OWN end. Our contentHeight
                // snapshot can be mid-churn (field trace: jump landed at ~93% after the
                // height shrank under the write), so never derive the explicit bottom
                // target from it when the list exposes scrollToEnd (FlashList 2.3.2 does).
                node.scrollToEnd({ animated: command.animated ?? false });
            } else {
                if (typeof node.scrollToOffset !== 'function') return false;
                if (
                    !isLegacyList &&
                    !isInvertedOrientation &&
                    command.mode === 'jump-to-bottom' &&
                    offset <= 0 &&
                    listDataRef.current.length > 0 &&
                    (listContentHeightRef.current <= 0 || listLayoutHeightRef.current <= 0)
                ) {
                    // Plan B7: never issue scrollToOffset(0) for an explicit jump while the
                    // content is unmeasured (0 is the TOP of a scrollable transcript). Defer
                    // to the bounded explicit re-confirm and telemeter the deferral.
                    recordRestoreDecisionTelemetry('not-ready', {
                        mode: 'jump-to-bottom',
                        contentHeight: listContentHeightRef.current,
                        layoutHeight: listLayoutHeightRef.current,
                    });
                    return false;
                }
                const rawBottomOffset = isLegacyList
                    ? offset
                    : command.mode === 'jump-to-bottom'
                        ? resolveBottomRawScrollCommandOffset({
                            contentHeight: listContentHeightRef.current,
                            layoutHeight: listLayoutHeightRef.current,
                            orientation: listOrientationRef.current,
                        })
                        : resolveBottomRawScrollOffset({
                            contentHeight: listContentHeightRef.current,
                            layoutHeight: listLayoutHeightRef.current,
                            orientation: listOrientationRef.current,
                        });
                // Device-proven: an inverted FlashList ignores scrollToOffset({offset: 0}) (the list
                // does not move to raw 0). The newest row is index 0 of the reversed newest-first data,
                // so the visual bottom must be commanded via scrollToIndex(0). scrollToOffset stays the
                // path for standard/legacy and for non-bottom restore writes.
                if (!isLegacyList && isInvertedOrientation && typeof node.scrollToIndex === 'function') {
                    // Offset the inverted bottom command UP by the composer/agent-input inset so the
                    // newest row lands fully ABOVE the input rather than one inset-height short (device-
                    // proven: viewOffset = -composerInset drives distance-from-bottom to exactly 0; +inset
                    // or 0 leaves the gap the user has to manually scroll past). No inset (e.g. tests) →
                    // the plain index-0 command.
                    // With the native hot/cold split ON, the live tail lives in the visual-bottom edge
                    // slot BELOW data[0], so the bottom command must clear BOTH the composer inset and
                    // the hot-tail's rendered height for the live tail to land above the composer. The
                    // hot-tail ref is 0 when the split is OFF, so this reduces to the composer-only inset.
                    const bottomInset = composerInsetHeightRef.current + nativeHotTailHeightRef.current;
                    node.scrollToIndex(
                        bottomInset > 0
                            ? { index: 0, animated: command.animated ?? false, viewOffset: -bottomInset }
                            : { index: 0, animated: command.animated ?? false },
                    );
                } else {
                    node.scrollToOffset({ offset: rawBottomOffset, animated: command.animated ?? false });
                }
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY: rawBottomOffset,
                    previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                    layoutHeight: listLayoutHeightRef.current,
                    contentHeight: listContentHeightRef.current,
                    distanceFromBottom: 0,
                    nativeMountSettleStable,
                    // §12 #4: stamp the deterministic pin inset (composerInset + hot-tail height) so
                    // device QA can prove the inverted bottom command compensated for the EXACT
                    // rendered live-tail height. Only when the carve owns this pin (flag=0 unchanged).
                    ...resolveInvertedBottomPinCarveTelemetryFields(),
                });
                return true;
            }
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY: offset,
                previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                layoutHeight: listLayoutHeightRef.current,
                contentHeight: listContentHeightRef.current,
                distanceFromBottom: 0,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'scroll-offset' || command.kind === 'restore-offset') {
            if (Platform.OS === 'web') {
                const metrics = resolveWebScrollMetrics();
                if (!metrics) return false;
                const previousOffsetY = metrics.scrollTop;
                const targetOffsetY = command.kind === 'restore-offset'
                    ? listImplementation === 'flatlist_legacy'
                        ? Math.min(resolveWebTranscriptMaxScrollTop(metrics), command.offsetY)
                        : Math.max(0, resolveWebTranscriptMaxScrollTop(metrics) - command.offsetY)
                    : Math.max(0, Math.trunc(command.offsetY));
                try {
                    metrics.element.scrollTop = targetOffsetY;
                } catch {
                    return false;
                }
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: command.mode === 'follow-bottom' || command.mode === 'jump-to-bottom'
                        ? 'web-dom-bottom'
                        : 'web-dom-restore',
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY,
                    previousOffsetY,
                    layoutHeight: metrics.clientHeight,
                    contentHeight: metrics.scrollHeight,
                    distanceFromBottom: command.kind === 'restore-offset'
                        ? command.offsetY
                        : Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - targetOffsetY)),
                    ...resolveWebViewportTelemetryDiagnostics({
                        metrics,
                        programmaticWebWrite: true,
                        scrollable: isWebTranscriptScrollable(metrics, 1),
                        trigger: command.reason === 'prepend-restore' ? 'prepend-restore' : command.mode === 'jump-to-bottom' ? 'jump' : 'restore',
                    }),
                });
                return true;
            }

            const node = listRef.current;
            if (!node || typeof node.scrollToOffset !== 'function') return false;
            const layoutHeight = listLayoutHeightRef.current;
            const contentHeight = command.kind === 'restore-offset' && typeof command.contentHeight === 'number' && Number.isFinite(command.contentHeight)
                ? Math.max(0, Math.trunc(command.contentHeight))
                : listContentHeightRef.current;
            const maxOffset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
            const targetOffsetY = command.kind === 'restore-offset'
                ? listImplementation === 'flatlist_legacy'
                    ? Math.min(maxOffset, command.offsetY)
                    : Math.max(0, maxOffset - command.offsetY)
                : Math.max(0, Math.trunc(command.offsetY));
            // N3.2: command/telemetry offsets stay CANONICAL (standard-space); the raw
            // write target maps through the orientation seam at this single boundary.
            const rawTargetOffsetY = listImplementation === 'flatlist_legacy'
                ? targetOffsetY
                : Math.max(0, fromCanonicalScrollOffset({
                    offsetY: targetOffsetY,
                    contentHeight,
                    layoutHeight,
                    orientation: listOrientationRef.current,
                }));
            node.scrollToOffset({ offset: rawTargetOffsetY, animated: command.animated ?? false });
            recordViewportTelemetryEvent({
                type: 'scroll-write',
                writer: command.mode === 'jump-to-bottom' ? 'native-explicit-jump' : 'native-scroll-to-offset',
                reason: command.reason,
                mode: command.mode,
                targetOffsetY,
                previousOffsetY: lastNativePinOffsetRef.current ?? undefined,
                layoutHeight,
                contentHeight,
                distanceFromBottom: command.kind === 'restore-offset' ? command.offsetY : undefined,
                nativeMountSettleStable,
            });
            return true;
        }

        if (command.kind === 'restore-index' || command.kind === 'jump-to-seq') {
            let index = command.kind === 'restore-index' ? command.index : command.index;
            if (typeof index !== 'number' || !Number.isFinite(index)) return false;
            if (Platform.OS === 'web' && shouldUseWebHotColdSplit) {
                const target = resolveWebColdListScrollTarget({
                    fullIndex: index,
                    coldCount: transcriptHotColdSegments.coldItems.length,
                    reason: command.kind === 'jump-to-seq'
                        ? 'jump-to-seq'
                        : command.reason === 'prepend-restore'
                            ? 'prepend-recovery'
                            : 'restore-index',
                });
                if (target.kind === 'pin_to_bottom') {
                    const metrics = resolveWebScrollMetrics();
                    if (!metrics) return false;
                    const previousOffsetY = metrics.scrollTop;
                    try {
                        metrics.element.scrollTop = metrics.scrollHeight;
                    } catch {
                        return false;
                    }
                    lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
                    recordViewportTelemetryEvent({
                        type: 'scroll-write',
                        writer: 'web-dom-bottom',
                        reason: command.reason,
                        mode: command.mode,
                        targetOffsetY: metrics.element.scrollTop,
                        previousOffsetY,
                        layoutHeight: metrics.clientHeight,
                        contentHeight: metrics.scrollHeight,
                        distanceFromBottom: getWebTranscriptDistanceFromBottom({
                            ...metrics,
                            scrollTop: metrics.element.scrollTop,
                        }),
                        ...resolveWebViewportTelemetryDiagnostics({
                            metrics,
                            programmaticWebWrite: true,
                            scrollable: isWebTranscriptScrollable(metrics, 1),
                            trigger: command.kind === 'jump-to-seq' ? 'jump' : command.reason === 'prepend-restore' ? 'prepend-restore' : 'restore',
                        }),
                    });
                    return true;
                }
                index = target.index;
            }
            if (Platform.OS !== 'web' && shouldUseNativeHotColdSplit) {
                // Map the FULL rendered display index to a COLD rendered index (FlashList `data` is the
                // cold slice). A hot-tail target resolves to the newest cold row, bringing the live
                // tail's edge slot into view — mirroring the web hot/cold index discipline.
                const renderedColdIndex = resolveNativeInvertedColdScrollIndex({
                    renderedFullIndex: index,
                    fullCount: itemsRef.current.length,
                    coldCount: listDataRef.current.length,
                });
                if (renderedColdIndex != null) {
                    index = renderedColdIndex;
                }
            }
            const node = listRef.current;
            if (!node || typeof node.scrollToIndex !== 'function') return false;
                if (command.kind === 'restore-index') {
                    if (Platform.OS !== 'web') {
                        lastNativeRestoreIndexCommandRef.current = {
                            index,
                            issuedAtMs: Date.now(),
                            reason: command.reason,
                            sessionId: command.sessionId,
                            viewOffset: command.viewOffset,
                        };
                    }
                    const restoreParams = {
                        index,
                        animated: command.animated ?? false,
                        viewOffset: command.viewOffset,
                        ...(Platform.OS === 'web' ? { viewPosition: 0 } : {}),
                    };
                    node.scrollToIndex(restoreParams);
                } else {
                if (Platform.OS !== 'web') {
                    lastNativeRestoreIndexCommandRef.current = {
                        index,
                        issuedAtMs: Date.now(),
                        reason: command.reason,
                        sessionId: command.sessionId,
                    };
                }
                node.scrollToIndex({ index, animated: command.animated ?? true, viewPosition: 0.5 });
            }
                recordViewportTelemetryEvent({
                    type: 'scroll-write',
                    writer: resolveIndexScrollWriter({
                        platform: telemetryPlatform,
                        listImplementation,
                    }),
                    reason: command.reason,
                    mode: command.mode,
                    targetOffsetY: index,
                    layoutHeight: listLayoutHeightRef.current,
                    contentHeight: listContentHeightRef.current,
                    nativeMountSettleStable,
                    ...(Platform.OS === 'web' ? resolveWebViewportTelemetryDiagnostics({
                        metrics: resolveWebScrollMetrics(),
                        programmaticWebWrite: true,
                        scrollable: undefined,
                        trigger: command.kind === 'jump-to-seq' ? 'jump' : command.reason === 'prepend-restore' ? 'prepend-restore' : 'restore',
                    }) : {}),
                });
                return true;
            }

        return false;
            },
        });
    }, [
            clearWebPrependRangeReserve,
            hasWebPrependRestoreWindow,
            listImplementation,
            nativeMountSettleStable,
            recordRestoreDecisionTelemetry,
            recordViewportTelemetryEvent,
            resolveInvertedBottomPinCarveTelemetryFields,
            resolveViewportCommandTelemetryWriter,
            resolveWebViewportTelemetryDiagnostics,
            resolveWebScrollMetrics,
            shouldUseNativeHotColdSplit,
            shouldUseWebHotColdSplit,
            telemetryPlatform,
            transcriptHotColdSegments.coldItems.length,
            viewportCommandController,
        ]);

    const writeWebRestoreScrollTopThroughViewportCommand = React.useCallback((
        params: Readonly<{
            mode: Extract<TranscriptViewportMode, 'restore-anchor' | 'restore-distance'>;
            reason: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'entry-restore' | 'prepend-restore'>;
            targetScrollTop: number;
        }>,
    ): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'scroll-offset',
            sessionId: props.sessionId,
            reason: params.reason,
            mode: params.mode,
            offsetY: params.targetScrollTop,
            animated: false,
        }));
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand]);

    const restoreWebPrependAnchorThroughViewportCommand = React.useCallback((
        anchor: WebTranscriptPrependAnchor,
        options?: Readonly<{ allowGrowthFallback?: boolean }>,
    ): WebTranscriptPrependRestoreResult => {
        return restoreWebTranscriptPrependAnchor(anchor, {
            allowGrowthFallback: options?.allowGrowthFallback,
            writeScrollTop: (targetScrollTop) => writeWebRestoreScrollTopThroughViewportCommand({
                mode: 'restore-anchor',
                reason: 'prepend-restore',
                targetScrollTop,
            }),
        });
    }, [writeWebRestoreScrollTopThroughViewportCommand]);

    const restoreWebViewportAnchorThroughViewportCommand = React.useCallback((params: Readonly<{
        anchor: Parameters<typeof restoreWebTranscriptViewportAnchor>[0]['anchor'];
        container: HTMLElement;
        reason?: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'entry-restore'>;
    }>) => {
        return restoreWebTranscriptViewportAnchor(params, {
            writeScrollTop: (targetScrollTop) => writeWebRestoreScrollTopThroughViewportCommand({
                mode: 'restore-anchor',
                reason: params.reason ?? 'entry-restore',
                targetScrollTop,
            }),
        });
    }, [writeWebRestoreScrollTopThroughViewportCommand]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const pending = pendingWebLocalHeightChangeAnchorRef.current;
        if (!pending) return;
        if (pending.sessionId !== props.sessionId || listImplementation !== 'flash_v2') {
            pendingWebLocalHeightChangeAnchorRef.current = null;
            return;
        }
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        pendingWebLocalHeightChangeAnchorRef.current = null;
        restoreWebViewportAnchorThroughViewportCommand({
            anchor: pending.anchor,
            container: metrics.element,
            reason: 'content-size-change',
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        listContentHeight,
        listData.length,
        listImplementation,
        props.sessionId,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
    ]);

    const observeMountSettleMetrics = React.useCallback((options: Readonly<{
        distanceFromBottom?: number;
        nowMs?: number;
    }> = {}) => {
        mountSettleCoordinatorRef.current?.observeMetrics({
            sessionId: props.sessionId,
            nowMs: options.nowMs ?? Date.now(),
            initialFillStatus: initialFillStatusRef.current,
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            composerInsetHeight: composerInsetHeightRef.current,
            distanceFromBottom: options.distanceFromBottom ?? lastPinOffsetForIntentRef.current ?? 0,
        });
    }, [props.sessionId]);

    React.useEffect(() => {
        if (!usesNativeFlashListBottomMaintenance) return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const coordinator = mountSettleCoordinatorRef.current;
            if (!coordinator) {
                clearInterval(intervalId);
                return;
            }
            const nowMs = Date.now();
            coordinator.sample({ sessionId: props.sessionId, nowMs });
            if (coordinator.getSnapshot().stableSettle) {
                closeEntryViewportOwnership('deadline');
                setNativeMountSettleStable(true);
                nativeMountSettleDeadlineReachedRef.current = false;
                flushPendingNativeMountSettleBottomPinRef.current?.();
                clearInterval(intervalId);
                return;
            }
            if (nowMs >= deadlineMs) {
                closeEntryViewportOwnership('deadline');
                nativeMountSettleDeadlineReachedRef.current = true;
                setNativeMountSettleDeadlineReached(true);
                if (!nativeMountSettleAutoPinSuppressedRef.current) {
                    pendingNativeMountSettleBottomPinRef.current = true;
                    flushPendingNativeMountSettleBottomPinRef.current?.();
                }
                clearInterval(intervalId);
            }
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [closeEntryViewportOwnership, props.sessionId, usesNativeFlashListBottomMaintenance]);

    const recordFirstListPaint = React.useCallback(() => {
        setFirstListPaintObserved(true);
        const nowMs = Date.now();
        const telemetryState = firstPaintTelemetryRef.current;
        if (
            telemetryState &&
            telemetryState.sessionId === props.sessionId &&
            telemetryState.recorded === false &&
            syncPerformanceTelemetry.isEnabled()
        ) {
            telemetryState.recorded = true;
            syncPerformanceTelemetry.recordDuration(
                'ui.sessions.transcript.firstPaint',
                readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
                {
                    committedMessages: props.committedMessagesCount,
                    items: listDataRef.current.length,
                    native: Platform.OS === 'web' ? 0 : 1,
                    routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                    web: Platform.OS === 'web' ? 1 : 0,
                },
            );
            recordSessionOpenPaintForSessionUiTelemetry({
                committedMessages: props.committedMessagesCount,
                items: listDataRef.current.length,
                native: Platform.OS === 'web' ? 0 : 1,
                phase: 'firstPaint',
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                sessionId: props.sessionId,
                web: Platform.OS === 'web' ? 1 : 0,
            });
        }
        mountSettleCoordinatorRef.current?.recordFirstListPaint({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        releaseNativePaintForIssuedEntryRestore();
    }, [
        observeMountSettleMetrics,
        props.committedMessagesCount,
        props.routeHydrationPending,
        props.sessionId,
        releaseNativePaintForIssuedEntryRestore,
    ]);

    const handleFlashListLoad = React.useCallback(() => {
        recordFirstListPaint();
        recordNativeVisibleWindowTelemetry('observed');
    }, [
        recordFirstListPaint,
        recordNativeVisibleWindowTelemetry,
    ]);

    const resolveEffectiveListPaintMetrics = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const webMetrics = resolveWebScrollMetrics();
            if (webMetrics && webMetrics.clientHeight > 0 && webMetrics.scrollHeight > 0) {
                return {
                    contentHeight: Math.max(0, Math.trunc(webMetrics.scrollHeight)),
                    distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(webMetrics))),
                    layoutHeight: Math.max(0, Math.trunc(webMetrics.clientHeight)),
                };
            }
        }

        const measuredLayoutHeight = listLayoutHeightRef.current;
        const measuredContentHeight = listContentHeightRef.current;
        if (measuredLayoutHeight > 0 && measuredContentHeight > 0) {
            const distanceFromBottom =
                typeof lastPinOffsetForIntentRef.current === 'number' &&
                Number.isFinite(lastPinOffsetForIntentRef.current)
                    ? Math.max(0, Math.trunc(lastPinOffsetForIntentRef.current))
                    : 0;
            return {
                contentHeight: Math.max(0, Math.trunc(measuredContentHeight)),
                distanceFromBottom,
                layoutHeight: Math.max(0, Math.trunc(measuredLayoutHeight)),
            };
        }

        return null;
    }, [resolveWebScrollMetrics]);
    const hasWarmStablePaint = hasTranscriptWarmStablePaint({
        committedMessagesCount: props.committedMessagesCount,
        items: listData.length,
        latestCommittedActivityKey: props.latestCommittedActivityKey,
        listImplementation: telemetryListImplementation,
        platform: telemetryPlatform,
        routeHydrationPending: props.routeHydrationPending === true,
        sessionId: props.sessionId,
    });
    const isWarmKeepAliveInstance = props.isWarmKeepAliveInstance === true || hasWarmStablePaint;

    const recordStablePaintTelemetry = React.useCallback((
        paintMetrics: Readonly<{
            contentHeight: number;
            distanceFromBottom: number;
            layoutHeight: number;
        }>,
        options: Readonly<{
            nativeViewportObserved?: boolean;
        }> = {},
    ): boolean => {
        if (options.nativeViewportObserved === true) {
            rememberTranscriptWarmStablePaint({
                committedMessagesCount: props.committedMessagesCount,
                items: listData.length,
                latestCommittedActivityKey: props.latestCommittedActivityKey,
                listImplementation: telemetryListImplementation,
                platform: telemetryPlatform,
                routeHydrationPending: props.routeHydrationPending === true,
                sessionId: props.sessionId,
            });
        }
        const telemetryState = stablePaintTelemetryRef.current;
        if (
            !telemetryState ||
            telemetryState.sessionId !== props.sessionId ||
            telemetryState.recorded === true ||
            !syncPerformanceTelemetry.isEnabled()
        ) {
            return false;
        }
        clearWebStablePaintRetry();
        telemetryState.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.transcript.stablePaint',
            readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
            {
                coldItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems.length : 0,
                committedMessages: props.committedMessagesCount,
                contentHeight: paintMetrics.contentHeight,
                distanceFromBottom: paintMetrics.distanceFromBottom,
                firstListPaintObserved: firstListPaintObserved ? 1 : 0,
                hotItems: shouldUseWebHotColdSplit ? transcriptHotColdSegments.hotItems.length : 0,
                items: listData.length,
                layoutHeight: paintMetrics.layoutHeight,
                native: Platform.OS === 'web' ? 0 : 1,
                nativeMountSettleDeadlineReached: nativeMountSettleDeadlineReached ? 1 : 0,
                nativeMountSettleStable: nativeMountSettleStable ? 1 : 0,
                nativeViewportObserved: options.nativeViewportObserved === true ? 1 : 0,
                routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
                warmKeepAlive: isWarmKeepAliveInstance ? 1 : 0,
                web: Platform.OS === 'web' ? 1 : 0,
                webHotColdSplit: shouldUseWebHotColdSplit ? 1 : 0,
            },
        );
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: props.committedMessagesCount,
            distanceFromBottom: paintMetrics.distanceFromBottom,
            items: listData.length,
            native: Platform.OS === 'web' ? 0 : 1,
            phase: 'stablePaint',
            routeHydrationPending: props.routeHydrationPending === true ? 1 : 0,
            sessionId: props.sessionId,
            web: Platform.OS === 'web' ? 1 : 0,
        });
        return true;
    }, [
        clearWebStablePaintRetry,
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        listData.length,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        props.committedMessagesCount,
        props.latestCommittedActivityKey,
        props.routeHydrationPending,
        props.sessionId,
        shouldUseWebHotColdSplit,
        telemetryListImplementation,
        telemetryPlatform,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems.length,
    ]);

    const recordLayoutCommitObserved = React.useCallback(() => {
        const nowMs = Date.now();
        mountSettleCoordinatorRef.current?.recordLayoutCommitObserved({
            sessionId: props.sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        scheduleNativePaintReleaseForEntryRestore();
    }, [observeMountSettleMetrics, props.sessionId, scheduleNativePaintReleaseForEntryRestore]);

    const shouldCommitContentHeightState = React.useCallback(() => {
        if (Platform.OS === 'web') return true;
        if (initialFillStatusRef.current !== 'done') return true;
        return props.jumpToSeq != null;
    }, [props.jumpToSeq]);

    // Arm the MVCP bottom-autoscroll threshold from the real viewport height as soon as the
    // viewport is laid out, decoupled from content mount-settle. On the inverted native path the
    // JS pin is a deliberate no-op, so this threshold is the ONLY bottom-pin authority; gating it
    // behind `nativeMountSettleStable` (a quiescent content-height window that never settles while
    // rows measure late on a tall cold open) was half of the cold-open follow-bottom deadlock.
    // The resolver still withholds the threshold for non-follow / open-transaction / web / legacy
    // (see resolveTranscriptFlashListBottomMaintenance), and `normalizePositive` rejects a
    // not-yet-laid-out (<= 0) height, so passing the raw layout height is safe.
    const flashListMvcpThresholdLayoutHeight = listLayoutHeight;
    const flashListMaintainVisibleContentPosition = React.useMemo(() => {
        // FlashList/web can throw "index out of bounds, not enough layouts" under heavy append + scroll
        // when `maintainVisibleContentPosition.startRenderingFromBottom` is enabled. On web we already
        // pin via direct DOM scroll writes, so omit this prop to avoid the crash.
        const bottomFollowModeState = bottomFollowModeStateRef.current;
        return resolveTranscriptFlashListBottomMaintenance({
            autoFollowWhenPinned,
            bottomFollowMode: bottomFollowModeState.mode,
            hasOpenViewportTransaction:
                hasOpenEntryRestoreTransactionForSession() || hasOpenNativePrependTransactionForSession(),
            layoutHeight: flashListMvcpThresholdLayoutHeight,
            // Plan §12 #3: while the native edge-slot carve is active the JS force-pin owns the
            // bottom; withhold the MVCP bottom autoscroll threshold so it cannot fight the pin.
            liveRegionActive: shouldUseNativeHotColdSplit,
            nativeEntryShouldUseBottomMaintenance,
            orientation: listOrientation,
            pinEnabled,
            pinThresholdPx,
            platformIsWeb: Platform.OS === 'web',
        });
    }, [
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        flashListMvcpThresholdLayoutHeight,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        listOrientation,
        nativeEntryShouldUseBottomMaintenance,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        shouldUseNativeHotColdSplit,
    ]);
    nativeFlashListMvcpPolicyRef.current =
        Platform.OS !== 'web' && listImplementation === 'flash_v2'
            ? resolveNativeTelemetryMvcpPolicy(flashListMaintainVisibleContentPosition)
            : 'none';

    const flatListMaintainVisibleContentPosition = React.useMemo(() => {
        return canAutoFollowForReason('stream-append')
            ? { minIndexForVisible: 0, autoscrollToTopThreshold: pinThresholdPx }
            : undefined;
    }, [bottomFollowModeRevision, canAutoFollowForReason, pinThresholdPx]);

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [props.sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [props.sessionId]);

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [props.sessionId]);

    const resolveForkedTurnMessageOrigin = React.useCallback((messageId: string) => {
        const metadata = props.forkMessageMetadataById?.[messageId] ?? null;
        if (!metadata) return null;
        return {
            sessionId: metadata.originSessionId,
            isReadOnlyContext: metadata.isReadOnlyContext,
        };
    }, [props.forkMessageMetadataById]);
    const getTurnMessageOrigin = props.forkedTranscriptEnabled ? resolveForkedTurnMessageOrigin : undefined;

    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const rowWidthBucket = listLayoutWidthBucket;
    const rowFontScaleKey = resolveFontScaleKey();
    const getItemType = useCallback((item: ChatTranscriptListItem): string => (
        resolveTranscriptRowItemType({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId),
            getMessageById: getTurnMessageById,
            item,
        })
    ), [getTurnMessageById, props.activeThinkingMessageId]);
    React.useEffect(() => {
        // N1.3 evidence: intra-row content mutations (a rendered turn/tool-group row gaining or
        // losing entries post-mount) — the D6 blind spot no list-level maintenance can absorb.
        if (!isViewportEvidenceTelemetryEnabled()) return;
        const previousCounts = rowEvidenceContentCountsRef.current;
        const nextCounts = new Map<string, number>();
        for (const item of listData) {
            const count = resolveTranscriptRowContentCount(item);
            if (count === undefined) continue;
            nextCounts.set(item.id, count);
            const previousCount = previousCounts.get(item.id);
            if (previousCount !== undefined && previousCount !== count) {
                recordViewportTelemetryEvent({
                    type: 'row-mutated',
                    mode: resolveViewportTelemetryMode(),
                    rowId: item.id,
                    rowKind: getItemType(item),
                    rowContentCount: count,
                    rowPreviousContentCount: previousCount,
                    rowViewportRelation: resolveRowEvidenceViewportRelation(item.id),
                });
            }
        }
        rowEvidenceContentCountsRef.current = nextCounts;
    }, [
        getItemType,
        isViewportEvidenceTelemetryEnabled,
        listData,
        recordViewportTelemetryEvent,
        resolveRowEvidenceViewportRelation,
        resolveViewportTelemetryMode,
    ]);
    const resolveRollbackActionForMessage = React.useCallback((messageId: string): TranscriptRollbackAction | null => {
        return props.rollbackActionsByMessageId[messageId] ?? null;
    }, [props.rollbackActionsByMessageId]);
    const buildRowShellSignature = React.useCallback((item: ChatTranscriptListItem) => (
        buildTranscriptRowShellSignature({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId),
            expandedToolCallsAnchorMessageIds,
            forkMessageMetadataById: props.forkMessageMetadataById,
            getMessageById: getTurnMessageById,
            groupingMode: props.groupingMode,
            item,
            latestCommittedActivityKey: props.latestCommittedActivityKey,
            resolveThinkingExpanded,
            sessionActive: props.sessionActive,
            widthBucket: rowWidthBucket,
            fontScaleKey: rowFontScaleKey,
        })
    ), [
        expandedToolCallsAnchorMessageIds,
        getTurnMessageById,
        props.groupingMode,
        props.activeThinkingMessageId,
        props.forkMessageMetadataById,
        props.latestCommittedActivityKey,
        props.sessionActive,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
    ]);
    const shouldHoldNativeFirstPaintPlaceholderForMountSettle =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        props.jumpToSeq == null &&
        !nativeMountSettleStable &&
        !nativeMountSettleDeadlineReached;
    const shouldHoldNativeFirstPaintPlaceholderForPendingViewport =
        usesNativeFlashListBottomMaintenance &&
        props.jumpToSeq == null &&
        !nativeMountSettleDeadlineReached &&
        nativeInitialViewportPendingObservation &&
        (
            sessionEntryViewportRef.current?.shouldFollowBottom !== false ||
            (
                entryRestoreTransactionRef.current?.sessionId === props.sessionId &&
                !entryRestoreTransactionRef.current.isClosed()
            )
        );
    const nativeWarmFirstPaintDistanceAppearsOffBottom =
        usesNativeFlashListBottomMaintenance &&
        sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
        typeof lastPinOffsetForIntentRef.current === 'number' &&
        Number.isFinite(lastPinOffsetForIntentRef.current) &&
        lastPinOffsetForIntentRef.current > pinThresholdPx;
    const canWarmKeepAliveBypassNativeFirstPaintPlaceholder =
        isWarmKeepAliveInstance &&
        !nativeWarmFirstPaintDistanceAppearsOffBottom;
    const shouldHoldNativeFirstPaintPlaceholder =
        !nativeViewportPaintObserved &&
        !nativeEntryRestorePaintReleased &&
        (
            (
                !nativeMountSettleStable &&
                !nativeMountSettleDeadlineReached &&
                (!firstListPaintObserved || shouldHoldNativeFirstPaintPlaceholderForMountSettle)
            ) ||
            shouldHoldNativeFirstPaintPlaceholderForPendingViewport
        );
    const showNativeFirstPaintPlaceholder =
        Platform.OS !== 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !canWarmKeepAliveBypassNativeFirstPaintPlaceholder &&
        shouldHoldNativeFirstPaintPlaceholder;
    const showWebMarkdownRuntimeFirstPaintPlaceholder =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        props.isLoaded &&
        listData.length > 0 &&
        !firstListPaintObserved &&
        !webMarkdownRuntimeReady;
    const showRouteHydrationFirstPaintPlaceholder =
        props.routeHydrationPending === true &&
        props.isLoaded &&
        listData.length > 0;
    const showFirstPaintPlaceholder =
        showNativeFirstPaintPlaceholder ||
        showWebMarkdownRuntimeFirstPaintPlaceholder ||
        showRouteHydrationFirstPaintPlaceholder;
    const nativeFirstPaintReleasedWithoutListLoad =
        Platform.OS !== 'web' &&
        listImplementation === 'flash_v2' &&
        (nativeMountSettleStable || nativeMountSettleDeadlineReached);
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        if (listImplementation !== 'flash_v2') return;
        if (!usesNativeFlashListBottomMaintenance) return;
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (nativeFirstPaintFallbackReleaseTimeoutRef.current?.sessionId === props.sessionId) return;

        const tuning = sync.getSyncTuning();
        const timeoutMs =
            tuning.transcriptInitialFillBudgetMs +
            tuning.transcriptMountSettleQuiescentWindowMs * 2 +
            1;
        const handle = {
            sessionId: props.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeFirstPaintFallbackReleaseTimeoutRef.current !== handle) return;
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (nativeViewportPaintObservedRef.current) return;
            nativeMountSettleDeadlineReachedRef.current = true;
            setNativeMountSettleDeadlineReached(true);
            updateNativeInitialViewportPendingObservation(false);
        }, timeoutMs);
        nativeFirstPaintFallbackReleaseTimeoutRef.current = handle;
    }, [
        listData.length,
        listImplementation,
        props.isLoaded,
        props.sessionId,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
    ]);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (listImplementation !== 'flash_v2') return;
        if (firstListPaintObserved) return;
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showRouteHydrationFirstPaintPlaceholder) return;
        if (!resolveEffectiveListPaintMetrics()) return;

        recordFirstListPaint();
    }, [
        firstListPaintObserved,
        listContentHeight,
        listData.length,
        listImplementation,
        listLayoutHeight,
        props.isLoaded,
        recordFirstListPaint,
        resolveEffectiveListPaintMetrics,
        showRouteHydrationFirstPaintPlaceholder,
    ]);
    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (listData.length <= 0) return;
        if (showFirstPaintPlaceholder) return;
        if (
            !firstListPaintObserved &&
            !isWarmKeepAliveInstance &&
            !nativeFirstPaintReleasedWithoutListLoad &&
            !nativeEntryRestorePaintReleased &&
            !nativeViewportPaintObserved &&
            !nativeViewportPaintObservedRef.current
        ) {
            return;
        }
        const paintMetrics = resolveEffectiveListPaintMetrics();
        if (!paintMetrics) {
            scheduleWebStablePaintRetry();
            return;
        }
        if (
            Platform.OS === 'web' &&
            sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
            paintMetrics.distanceFromBottom > pinThresholdPx
        ) {
            scheduleWebStablePaintRetry();
            return;
        }
        recordStablePaintTelemetry(paintMetrics, {
            nativeViewportObserved: nativeViewportPaintObserved || nativeViewportPaintObservedRef.current,
        });
    }, [
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        listContentHeight,
        listData.length,
        listLayoutHeight,
        nativeFirstPaintReleasedWithoutListLoad,
        nativeEntryRestorePaintReleased,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        props.committedMessagesCount,
        props.isLoaded,
        props.routeHydrationPending,
        props.sessionId,
        pinThresholdPx,
        recordStablePaintTelemetry,
        resolveEffectiveListPaintMetrics,
        scheduleWebStablePaintRetry,
        showFirstPaintPlaceholder,
        webStablePaintRetryTick,
    ]);
    const wrapTranscriptItemForAnchor = React.useCallback((item: ChatTranscriptListItem, node: React.ReactNode) => {
        const signature = buildRowShellSignature(item);
        return (
            <TranscriptRowShell
                reconciler={measurementReconciler}
                itemId={item.id}
                onRowLayoutMutation={handleRowLayoutMutation}
                onRowMeasured={handleRowShellMeasured}
                signature={signature}
            >
                {node}
            </TranscriptRowShell>
        );
    }, [buildRowShellSignature, handleRowLayoutMutation, handleRowShellMeasured, measurementReconciler]);

    const captureCurrentWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
        return anchor;
    }, [listImplementation, pinThresholdPx, resolveWebScrollMetrics]);

    /**
     * Plan E2: every web prepend capture/restore/growth-fallback/recovery outcome is
     * telemetered as a restore decision (existing reasons only; no behavior change).
     * Growth fallbacks report mode 'restore-distance' so they are distinguishable from
     * anchor/item restores; intermediate outcomes use non-transaction reasons so native
     * invariant-D outcome counting stays unaffected.
     */
    const recordWebPrependRestoreOutcome = React.useCallback((
        result: Readonly<{ didAdjustScroll: boolean; strategy: 'anchor' | 'item' | 'growth' | 'none' }>,
    ) => {
        if (Platform.OS !== 'web') return;
        const prependDiagnostics = {
            programmaticWebWrite: result.didAdjustScroll,
            webTrigger: 'prepend-restore' as const,
        };
        if (result.strategy === 'growth') {
            recordRestoreDecisionTelemetry('restored', { mode: 'restore-distance', ...prependDiagnostics });
            return;
        }
        if (result.strategy === 'none') {
            recordRestoreDecisionTelemetry('not-ready', { mode: 'restore-anchor', ...prependDiagnostics });
            return;
        }
        recordRestoreDecisionTelemetry(result.didAdjustScroll ? 'restored' : 'observed', {
            mode: 'restore-anchor',
            ...prependDiagnostics,
        });
    }, [recordRestoreDecisionTelemetry]);

    const clearNativePrependQuietState = React.useCallback(() => {
        nativePrependQuietGateRef.current = null;
        const quietTimer = nativePrependQuietTimerRef.current;
        if (quietTimer != null) {
            nativePrependQuietTimerRef.current = null;
            clearTimeout(quietTimer);
        }
    }, []);

    const finishNativePrependTransaction = React.useCallback((transaction: PrependTransaction) => {
        if (nativePrependTransactionRef.current === transaction) {
            nativePrependTransactionRef.current = null;
        }
        nativePrependCommitArmedRef.current = false;
        clearNativePrependQuietState();
        const layoutTimeout = nativePrependLayoutTimeoutRef.current;
        if (layoutTimeout != null) {
            nativePrependLayoutTimeoutRef.current = null;
            clearTimeout(layoutTimeout);
        }
        const correctorNudge = nativePrependCorrectorNudgeRef.current;
        if (correctorNudge != null) {
            nativePrependCorrectorNudgeRef.current = null;
            clearTimeout(correctorNudge);
        }
        const outcome = transaction.outcome() ?? 'abandoned-identity';
        if (viewportCommandController.activeOwner() === 'prepend') {
            viewportCommandController.closeTransaction('prepend', outcome);
        }
        // Every prepend outcome is telemetered (invariant D: never silent), attributed to the
        // transaction's own session even when disposal happens during a session switch.
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: 'restore-anchor',
            reason: outcome,
            anchorItemOffsetPx: transaction.capturedAnchor.itemOffsetPx,
            anchorDeltaPx: transaction.conclusiveAnchorDeltaPx() ?? undefined,
            correctorAppliedDiffTotalPx: transaction.correctorCoverage().appliedDiffTotalPx,
            correctorEventCount: transaction.correctorCoverage().eventCount,
        }, { sessionId: transaction.sessionId });
        bumpNativePrependTransactionRevision();
    }, [clearNativePrependQuietState, recordViewportTelemetryEvent, viewportCommandController]);

    const invalidateNativePrependTransaction = React.useCallback(() => {
        const transaction = nativePrependTransactionRef.current;
        if (!transaction) return;
        if (!transaction.isClosed()) {
            transaction.onCaptureInvalidated();
        }
        finishNativePrependTransaction(transaction);
    }, [finishNativePrependTransaction]);
    invalidateNativePrependTransactionRef.current = invalidateNativePrependTransaction;

    const beginNativePrependTransaction = React.useCallback((): PrependTransaction | null => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return null;
        if (wantsPinnedRef.current) return null;
        if (viewportCommandController.activeOwner() === 'entry') {
            // N2d.3(i): entry-owned MATERIALIZATION loads never reach here (they pass
            // preservePrependViewport:false — LA-R contract). A begin call while the entry
            // owner is still active is therefore an entry-ADJACENT prepend (first user
            // older-load / slice reveal): close the entry transaction with an attributable
            // outcome and let the prepend transaction observe the commit instead of
            // letting it land transaction-less (the N2d live begin-miss).
            preemptEntryRestoreTransaction();
            if (viewportCommandController.activeOwner() === 'entry') return null;
        }
        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        if (!Number.isFinite(contentHeight) || contentHeight <= layoutHeight + 1) return null;

        const result = captureNativeTranscriptViewportAnchor({
            ref: listRef.current,
            data: listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(layoutHeight),
            capturedAtMs: Date.now(),
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        if (result.status !== 'captured') return null;
        // LC-R capture hardening: a non-finite captured offset can never produce a conclusive
        // observation, so skip creating a transaction at all.
        if (!Number.isFinite(result.anchor.itemOffsetPx)) return null;
        const anchorItemId = result.anchor.itemId;
        if (typeof anchorItemId !== 'string' || anchorItemId.length === 0) return null;
        const capturedAnchor: PrependCapturedAnchor = {
            key: { itemId: anchorItemId, messageId: result.anchor.messageId ?? null },
            itemOffsetPx: result.anchor.itemOffsetPx,
            capturedDataLength: listDataRef.current.length,
            capturedFirstItemId: typeof listDataRef.current[0]?.id === 'string'
                ? listDataRef.current[0].id
                : null,
        };

        invalidateNativePrependTransaction();
        const transaction = createPrependTransaction({ sessionId: props.sessionId, capturedAnchor });
        nativePrependTransactionRef.current = transaction;
        nativePrependCommitArmedRef.current = false;
        nativePrependQuietGateRef.current = createPrependFallbackQuietGate();
        return transaction;
    }, [invalidateNativePrependTransaction, listImplementation, preemptEntryRestoreTransaction, props.sessionId, viewportCommandController]);

    /**
     * N2b.2: reveals the withheld slice-window rows as ONE prepend-observed data
     * commit (zero scroll writes expected — the corrector/MVCP covers it; the
     * prepend transaction observes the outcome per the N2d rules). Returns the
     * number of revealed rows.
     */
    const revealEntrySliceWindow = React.useCallback((): number => {
        const sliceWindow = entrySliceWindowRef.current;
        if (!sliceWindow || sliceWindow.sessionId !== props.sessionId) return 0;
        const withheldCount = entrySliceWithheldCountRef.current;
        if (withheldCount <= 0) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
            return 0;
        }
        // Clear the window ref before beginning the transaction: begin may preempt an
        // open entry transaction whose close hook re-enters this reveal (no-op then).
        // The capture still reads the pre-reveal listData — the data growth only
        // commits on the next render and the transaction observes it (commit armed).
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
        const transaction = beginNativePrependTransaction();
        if (
            transaction &&
            nativePrependTransactionRef.current === transaction &&
            !transaction.isClosed()
        ) {
            nativePrependCommitArmedRef.current = true;
        }
        return withheldCount;
    }, [beginNativePrependTransaction, props.sessionId]);
    revealEntrySliceWindowRef.current = revealEntrySliceWindow;

    const computeNativePrependObservation = React.useCallback((transaction: PrependTransaction): PrependOutcome => {
        const node = listRef.current;
        const absoluteScrollOffset = (() => {
            try {
                const value = node?.getAbsoluteLastScrollOffset?.();
                return typeof value === 'number' ? value : Number.NaN;
            } catch {
                return Number.NaN;
            }
        })();
        return observePrependOutcome({
            capturedAnchor: transaction.capturedAnchor,
            postCommit: {
                items: listDataRef.current,
                getLayout: (index: number) => {
                    try {
                        return node?.getLayout?.(index) ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
                absoluteScrollOffset,
                contentHeight: listContentHeightRef.current,
                layoutHeight: listLayoutHeightRef.current,
            },
            // N2d.1: a misalignment fully explained by corrections the vendor corrector already
            // applied classifies mvcp-preserved (zero writes) instead of double-correcting.
            correctorCoverage: transaction.correctorCoverage(),
        });
    }, []);

    const forwardNativePrependObservation = React.useCallback((
        transaction: PrependTransaction,
        outcome: PrependOutcome,
    ) => {
        const write = transaction.onObservationWindow(outcome);
        if (write) {
            // Execute the single fallback against the same live snapshot the observation came
            // from (LC-R #7); the prepend phase is open, so the seam accepts owner='prepend'.
            executeViewportCommand(resolveViewportCommand({
                type: 'scroll-offset',
                sessionId: transaction.sessionId,
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                offsetY: write.write.targetOffsetY,
                animated: false,
            }));
        }
    }, [executeViewportCommand, resolveViewportCommand]);

    const observeNativePrependTransaction = React.useCallback(() => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return;
        const transaction = nativePrependTransactionRef.current;
        if (!transaction) return;
        if (transaction.sessionId !== props.sessionId) {
            invalidateNativePrependTransaction();
            return;
        }
        if (transaction.isClosed()) {
            finishNativePrependTransaction(transaction);
            return;
        }
        if (transaction.state() === 'awaiting-commit') {
            if (!nativePrependCommitArmedRef.current) return;
            // Commit once the prepended page is reflected in the rendered items (LC-R #2):
            // the prepend ownership phase opens here, bounded by ONE post-commit layout timeout.
            transaction.onCommit();
            const openResult = viewportCommandController.openTransaction('prepend');
            if (!openResult.opened) {
                transaction.onCaptureInvalidated();
                finishNativePrependTransaction(transaction);
                return;
            }
            bumpNativePrependTransactionRevision();
            const tuning = sync.getSyncTuning();
            const { budgetMs } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            nativePrependLayoutTimeoutRef.current = setTimeout(() => {
                nativePrependLayoutTimeoutRef.current = null;
                const current = nativePrependTransactionRef.current;
                if (current !== transaction || transaction.isClosed()) return;
                // Plan P1: the deadline bounds the layout-quiet wait. If a conclusive
                // observation exists at the deadline, spend it (write-once: fallback-restored
                // or mvcp-preserved) instead of abandoning the reading position.
                const finalOutcome = computeNativePrependObservation(transaction);
                if (finalOutcome.kind === 'mvcp-preserved' || finalOutcome.kind === 'needs-fallback') {
                    forwardNativePrependObservation(transaction, finalOutcome);
                }
                if (!transaction.isClosed()) {
                    transaction.onLayoutTimeout();
                }
                finishNativePrependTransaction(transaction);
            }, budgetMs);
        }
        if (transaction.state() !== 'committed') return;
        const outcome = computeNativePrependObservation(transaction);
        if (outcome.kind === 'needs-fallback') {
            // Layout-quiet gate (plan P1): FlashList's own MVCP correction applies
            // asynchronously — withhold the single fallback until the misalignment is stable
            // across one quiet window, re-observing on a single re-armed timer. The post-commit
            // layout timeout above bounds the whole wait.
            const gate = nativePrependQuietGateRef.current ?? createPrependFallbackQuietGate();
            nativePrependQuietGateRef.current = gate;
            const decision = gate.onMisalignedObservation({
                observedItemOffsetPx: transaction.capturedAnchor.itemOffsetPx + outcome.deltaPx,
                nowMs: Date.now(),
            });
            if (decision.kind === 'wait') {
                const previousTimer = nativePrependQuietTimerRef.current;
                if (previousTimer != null) clearTimeout(previousTimer);
                nativePrependQuietTimerRef.current = setTimeout(() => {
                    nativePrependQuietTimerRef.current = null;
                    observeNativePrependTransactionRef.current();
                }, decision.reobserveInMs);
                return;
            }
        }
        forwardNativePrependObservation(transaction, outcome);
        if (transaction.isClosed()) {
            finishNativePrependTransaction(transaction);
        }
        // Non-conclusive outcomes (layout-not-ready / identity-unchanged) keep the single
        // window open; the host re-observes on the next layout/content/scroll event.
    }, [
        computeNativePrependObservation,
        finishNativePrependTransaction,
        forwardNativePrependObservation,
        invalidateNativePrependTransaction,
        listImplementation,
        props.sessionId,
        viewportCommandController,
    ]);
    observeNativePrependTransactionRef.current = observeNativePrependTransaction;

    const captureCurrentViewportAnchor = React.useCallback((): SessionViewportAnchorSnapshot | null => {
        if (wantsPinnedRef.current) return null;

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web' && listImplementation === 'flash_v2') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) return null;
            return {
                ...anchor,
                capturedAtMs,
            };
        }

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const result = captureNativeTranscriptViewportAnchor({
                ref: listRef.current,
                data: listDataRef.current,
                focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(listLayoutHeightRef.current),
                capturedAtMs,
                resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
            });
            return result.status === 'captured' ? result.anchor : null;
        }

        return null;
    }, [listImplementation, resolveWebScrollMetrics]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: () => SessionViewportAnchorSnapshot | null,
        sessionId: string,
    ) => {
        const recordCaptureOutcome = (
            reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped',
            anchorItemOffsetPx?: number,
        ) => {
            recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason,
                distanceFromBottom: typeof state.offsetY === 'number' ? state.offsetY : undefined,
                anchorItemOffsetPx,
            }, { sessionId });
        };
        if (viewportAnchorCaptureGenerationRef.current !== generation) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        // Session guard (plan A3): a capture scheduled for session A must never run against
        // session B's mounted list/data — it would write B's anchor into A's viewport memory.
        // Exit flushes happen synchronously in the session-entry render block, before the
        // current-session ref flips, so legitimate flushes pass this guard.
        if (sessionId !== currentSessionIdRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }

        const anchor = captureAnchor();
        recordCaptureOutcome(
            anchor ? 'anchor-captured' : 'anchor-capture-empty',
            anchor?.itemOffsetPx,
        );
        emit?.({
            ...state,
            anchor,
        });
    }, [recordViewportTelemetryEvent]);

    const scheduleViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => {
        if (options?.suppressAnchorCapture === true) {
            // Plan P2: an unattributable (churn) frame must not initiate or refresh a capture,
            // but it no longer destroys a pending user-attributed capture — the debounced
            // capture re-reads the anchor from the live list at fire time, so it stays
            // truthful even when churn moves content in between. Recycled-jump pollution is
            // no worse than the already-persisted distance from the same frames (FW3 delta).
            return;
        }

        if (state.shouldRestoreViewport !== true || state.isPinned === true) {
            viewportAnchorCaptureGenerationRef.current += 1;
            cancelScheduledViewportAnchorCapture();
            return;
        }

        const debounceMs = sync.getSyncTuning().transcriptViewportAnchorCaptureDebounceMs;
        const captureAnchor = captureCurrentViewportAnchor;
        const dueAtMs = Date.now() + debounceMs;
        const emit = onViewportChangeRef.current;
        const generation = viewportAnchorCaptureGenerationRef.current;
        const sessionId = currentSessionIdRef.current;
        const wantsPinned = wantsPinnedRef.current;
        const existing = scheduledViewportAnchorCaptureRef.current;
        if (existing && existing.generation === generation && existing.sessionId === sessionId) {
            existing.captureAnchor = captureAnchor;
            existing.dueAtMs = dueAtMs;
            existing.emit = emit;
            existing.state = state;
            existing.wantsPinned = wantsPinned;
            return;
        }
        cancelScheduledViewportAnchorCapture();
        const armTimeout = (delayMs: number): ReturnType<typeof setTimeout> => {
            const timeoutId = setTimeout(() => {
                const scheduled = scheduledViewportAnchorCaptureRef.current;
                if (!scheduled || scheduled.timeoutId !== timeoutId) return;
                const remainingMs = scheduled.dueAtMs - Date.now();
                if (remainingMs > 0) {
                    scheduled.timeoutId = armTimeout(remainingMs);
                    return;
                }
                scheduledViewportAnchorCaptureRef.current = null;
                emitViewportAnchorCapture(
                    scheduled.state,
                    scheduled.generation,
                    scheduled.wantsPinned,
                    scheduled.emit,
                    scheduled.captureAnchor,
                    scheduled.sessionId,
                );
            }, Math.max(0, delayMs));
            return timeoutId;
        };
        const timeoutId = armTimeout(debounceMs);
        scheduledViewportAnchorCaptureRef.current = { captureAnchor, dueAtMs, emit, generation, sessionId, state, timeoutId, wantsPinned };
    }, [cancelScheduledViewportAnchorCapture, captureCurrentViewportAnchor, emitViewportAnchorCapture]);
    scheduleViewportAnchorCaptureRef.current = scheduleViewportAnchorCapture;

    const flushScheduledViewportAnchorCapture = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        const scheduled = scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
        if (scheduled.generation !== viewportAnchorCaptureGenerationRef.current) return;
        // Session guard (plan A3): only flush a capture that still belongs to the session the
        // refs currently point at; otherwise drop it instead of polluting another session.
        if (scheduled.sessionId !== currentSessionIdRef.current) return;
        if (scheduled.state.shouldRestoreViewport !== true || scheduled.state.isPinned === true || scheduled.wantsPinned) {
            return;
        }
        // Capture against the still-mounted list synchronously; the render-phase exit flush
        // defers only the emit so it never writes to the sync store mid-render.
        const anchor = scheduled.captureAnchor();
        recordViewportTelemetryEvent({
            type: 'anchor-capture',
            mode: 'user-unpinned',
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
        }, { sessionId: scheduled.sessionId });
        const emit = scheduled.emit;
        const state = scheduled.state;
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.({ ...state, anchor });
            });
            return;
        }
        emit?.({ ...state, anchor });
    }, [recordViewportTelemetryEvent]);

    React.useLayoutEffect(() => {
        flushViewportAnchorCaptureRef.current = flushScheduledViewportAnchorCapture;
    }, [flushScheduledViewportAnchorCapture]);

    /**
     * Exit-flush live-tail intent (plan P3): on navigation away/unmount, when the viewport
     * visibly sits within the pin threshold of the bottom, persist an explicit live-tail
     * report ({isPinned:true, shouldRestoreViewport:false}) for the exiting session. The B8
     * arrival emission only fires on trusted arrivals — passive settles and swallowed
     * momentum tails leave the stored viewport unpinned, which reopens slightly above the
     * bottom and poisons catch-up. The report intentionally bypasses the sync seam's
     * observed-unpinned preserve branch (shouldRestoreViewport:false routes straight to
     * markSessionLiveTailIntent): exit-time bottom is a deliberate, deterministic signal.
     */
    const flushExitLiveTailIntent = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return;
        // Real navigation detaches the list ref before the passive unmount cleanup runs —
        // fall back to the last observed distance (kept honest by the passive bottom-arrival
        // branch) when the live read is unavailable.
        const distanceFromBottom = readCurrentNativeDistanceFromBottom() ?? lastPinOffsetForIntentRef.current;
        if (distanceFromBottom == null || distanceFromBottom > pinThresholdPx) return;
        const emit = onViewportChangeRef.current;
        if (!emit) return;
        const liveTailState = { isPinned: true, offsetY: 0, shouldRestoreViewport: false };
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit(liveTailState);
            });
            return;
        }
        emit(liveTailState);
    }, [listImplementation, pinThresholdPx, readCurrentNativeDistanceFromBottom]);
    React.useLayoutEffect(() => {
        flushExitLiveTailIntentRef.current = flushExitLiveTailIntent;
    }, [flushExitLiveTailIntent]);

    const refreshInFlightWebPrependAnchor = React.useCallback((options?: Readonly<{ userScrolledDuringLoad?: boolean }>) => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        if (options?.userScrolledDuringLoad !== true) return;
        const currentAnchor = inFlightWebPrependAnchorRef.current;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        if (!currentAnchor) {
            inFlightWebPrependAnchorRef.current = captureCurrentWebPrependAnchor();
            return;
        }
        inFlightWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(currentAnchor, {
            ...metrics,
            scrollHeight: currentAnchor.metrics.scrollHeight,
        }, {
            recaptureAnchor: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
    }, [captureCurrentWebPrependAnchor, listImplementation, resolveWebScrollMetrics]);

    const retargetPendingWebPrependAnchorForUserScroll = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(pendingAnchor, metrics, {
            recaptureAnchor: true,
            resetExpiry: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
        pendingWebPrependIndexRecoveryRef.current = false;
    }, [listImplementation, resolveWebScrollMetrics]);

    const resolvePendingWebPrependRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { adoptCurrentAnchorPosition: true, recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { adoptCurrentAnchorPosition: true, recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const updateWebPrependRangeReserve = React.useCallback((
        anchor: WebTranscriptPrependAnchor | null,
        metrics: Readonly<{ scrollHeight: number }> | null,
    ) => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2' || !anchor || !metrics) {
            clearWebPrependRangeReserve();
            return;
        }
        const nextReserve = resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: anchor.metrics.scrollHeight,
            currentScrollHeight: metrics.scrollHeight,
        });
        setWebPrependRangeReservePx((previous) => previous === nextReserve ? previous : nextReserve);
    }, [clearWebPrependRangeReserve, listImplementation]);

    const resolvePendingWebPrependItemIndex = React.useCallback((itemTestId: string | null): number | null => {
        if (!itemTestId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) return null;
        const itemId = itemTestId.slice(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        const index = itemsRef.current.findIndex((item) => item.id === itemId);
        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependAnchorIndex = React.useCallback((anchorTestId: string | null): number | null => {
        let anchorMessageId: string | null = null;
        if (anchorTestId?.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        }
        if (!anchorMessageId) return null;

        // Two-pass like resolveTranscriptViewportAnchorIndex (N2c): exact message-owning
        // rows (incl. per-unit tool rows) win; the group header cap is the containment
        // fallback for tools hidden behind a collapsed preview.
        const items = itemsRef.current;
        const owningIndex = items.findIndex((item) => {
            if (item.kind === 'message') {
                return item.messageId === anchorMessageId;
            }
            if (item.kind === 'tool-group-tool') {
                return item.toolMessageId === anchorMessageId;
            }
            if (item.kind === 'tool-calls-group') {
                return item.toolMessageIds.includes(anchorMessageId);
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId === anchorMessageId) return true;
                return item.turn.content.some((content) => {
                    if (content.kind === 'message') {
                        return content.messageId === anchorMessageId;
                    }
                    if (content.kind === 'tool_calls') {
                        return content.toolMessageIds.includes(anchorMessageId);
                    }
                    return false;
                });
            }
            return false;
        });
        if (owningIndex >= 0) return owningIndex;

        const containingIndex = items.findIndex((item) => (
            item.kind === 'tool-group-header' && item.toolMessageIds.includes(anchorMessageId)
        ));
        return containingIndex >= 0 ? containingIndex : null;
    }, []);

    const resolvePendingWebPrependRecoveryIndex = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): number | null => {
        if (!pendingAnchor) return null;
        return resolvePendingWebPrependAnchorIndex(pendingAnchor.anchorTestId) ?? resolvePendingWebPrependItemIndex(pendingAnchor.itemTestId);
    }, [resolvePendingWebPrependAnchorIndex, resolvePendingWebPrependItemIndex]);

    const hasPendingWebPrependIdentity = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): boolean => {
        return Boolean(pendingAnchor?.anchorTestId || pendingAnchor?.itemTestId);
    }, []);

        const tryScrollPendingWebPrependItemIntoView = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): boolean => {
            if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
            const index = resolvePendingWebPrependRecoveryIndex(pendingAnchor);
            if (index == null) return false;
            const target = resolveWebColdListScrollTarget({
                fullIndex: index,
                coldCount: shouldUseWebHotColdSplit
                    ? transcriptHotColdSegments.coldItems.length
                    : listDataRef.current.length,
                reason: 'prepend-recovery',
            });
            try {
                if (target.kind === 'pin_to_bottom') {
                    return false;
                }
                return executeViewportCommand(resolveViewportCommand({
                    type: 'restore-anchor',
                    sessionId: props.sessionId,
                    reason: 'prepend-restore',
                    index: target.index,
                    animated: false,
                }));
            } catch {
                return false;
            }
        }, [
            executeViewportCommand,
            listImplementation,
            props.sessionId,
            resolvePendingWebPrependRecoveryIndex,
            resolveViewportCommand,
            shouldUseWebHotColdSplit,
            transcriptHotColdSegments.coldItems.length,
        ]);

    const attemptPendingWebPrependIndexRecovery = React.useCallback((): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        if (!pendingWebPrependIndexRecoveryRef.current || !pendingWebPrependAnchorRef.current) return false;
        const scheduleRetry = () => {
            if (scheduledWebPrependIndexRecoveryRef.current) return;
            const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const timeoutId = setTimeout(() => {
                if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                scheduledWebPrependIndexRecoveryRef.current = null;
                attemptPendingWebPrependIndexRecovery();
            }, 16);
            handle.ids.push(timeoutId);
        };
        const didRecoverIndex = tryScrollPendingWebPrependItemIntoView(pendingWebPrependAnchorRef.current);
        if (!didRecoverIndex) {
            if (Date.now() <= pendingWebPrependAnchorRef.current.expiresAtMs) {
                scheduleRetry();
            } else {
                clearWebPrependRestoreWindow('abandoned-identity');
                // Plan E2: recovery window expired without remounting the anchor row.
                recordRestoreDecisionTelemetry('skipped', {
                    mode: 'restore-anchor',
                    programmaticWebWrite: false,
                    webTrigger: 'prepend-restore',
                });
            }
            return false;
        }

        pendingWebPrependIndexRecoveryRef.current = false;
        const retryAnchor = pendingWebPrependAnchorRef.current;
        const retryRestoreResult = restoreWebPrependAnchorThroughViewportCommand(retryAnchor, {
            allowGrowthFallback: false,
        });
        recordWebPrependRestoreOutcome(retryRestoreResult);
        const retryMetrics = resolveWebScrollMetrics();
        if (!retryMetrics) {
            clearWebPrependRestoreWindow('confirmed');
            return true;
        }
        updateWebPrependRangeReserve(retryAnchor, retryMetrics);
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            retryAnchor,
            retryMetrics,
            resolvePendingWebPrependRefreshOptions(retryRestoreResult.strategy),
        );
        scheduleWebPrependRestoreWindowExpiry(pendingWebPrependAnchorRef.current);
        if (
            (retryRestoreResult.strategy === 'growth' || retryRestoreResult.strategy === 'none') &&
            pendingWebPrependAnchorRef.current &&
            Date.now() <= pendingWebPrependAnchorRef.current.expiresAtMs
        ) {
            pendingWebPrependIndexRecoveryRef.current = true;
            scheduleRetry();
        }
        return true;
        }, [
            clearWebPrependRestoreWindow,
            listImplementation,
            recordRestoreDecisionTelemetry,
            recordWebPrependRestoreOutcome,
            resolvePendingWebPrependRefreshOptions,
            resolveWebScrollMetrics,
            scheduleWebPrependRestoreWindowExpiry,
            restoreWebPrependAnchorThroughViewportCommand,
            tryScrollPendingWebPrependItemIntoView,
            updateWebPrependRangeReserve,
        ]);

    const schedulePendingWebPrependIndexRecovery = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) return;

        if (typeof requestAnimationFrame === 'function') {
            const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const first = requestAnimationFrame(() => {
                const second = requestAnimationFrame(() => {
                    if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                    scheduledWebPrependIndexRecoveryRef.current = null;
                    attemptPendingWebPrependIndexRecovery();
                });
                handle.ids.push(second);
            });
            handle.ids.push(first);
            return;
        }

        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
        scheduledWebPrependIndexRecoveryRef.current = handle;
        const timeoutId = setTimeout(() => {
            if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
            scheduledWebPrependIndexRecoveryRef.current = null;
            attemptPendingWebPrependIndexRecovery();
        }, 0);
        handle.ids.push(timeoutId);
    }, [attemptPendingWebPrependIndexRecovery, listImplementation]);

      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return wrapTranscriptItemForAnchor(item, <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />);
          }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                        onEditPendingMessage={props.onEditPendingMessage}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-user-action') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <UserActionPromptCard
                        chrome="card"
                        request={item.request}
                        location={null}
                        sessionId={props.sessionId}
                        metadata={props.metadata}
                        canApprovePermissions={props.interaction.permissionDisabledReason === 'inactive'
                            ? true
                            : props.interaction.canApprovePermissions}
                        disabledReason={props.interaction.permissionDisabledReason === 'inactive'
                            ? undefined
                            : props.interaction.permissionDisabledReason}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={interaction}
                    approvalRequests={props.approvalRequests}
                    getMessageById={props.forkedTranscriptEnabled ? getTurnMessageById : undefined}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-header') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const headerToolMessageIds = item.toolMessageIds;
            const headerGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitHeaderRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    toolMessages={resolveToolCallMessagesForIds(item.toolMessageIds)}
                    expanded={item.expanded}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: headerGroupId,
                        toolMessageIds: headerToolMessageIds,
                        expanded,
                    })}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-expand') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const expandToolMessageIds = item.toolMessageIds;
            const expandGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitExpandRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    hiddenCount={item.hiddenCount}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: expandGroupId,
                        toolMessageIds: expandToolMessageIds,
                        expanded,
                    })}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-tool') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            const toolMessage = getTurnMessageById(item.toolMessageId);
            return wrapTranscriptItemForAnchor(item, toolMessage?.kind === 'tool-call' ? (
                <ToolCallsGroupUnitToolRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    message={toolMessage}
                    expanded={item.expanded}
                    approvalRequests={props.approvalRequests}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ) : null);
        }
        if (item.kind === 'tool-group-footer') {
            const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitFooterRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={interaction}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'turn') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId);
            const turnCreatedAt =
                (item.turn.userMessageId ? resolveCreatedAtForMessageId(item.turn.userMessageId) : null) ??
                (item.turn.content[0]?.kind === 'message'
                    ? resolveCreatedAtForMessageId(item.turn.content[0].messageId)
                    : item.turn.content[0]?.kind === 'tool_calls'
                        ? (item.turn.content[0].toolMessageIds[0]
                            ? resolveCreatedAtForMessageId(item.turn.content[0].toolMessageIds[0])
                            : null)
                        : null) ??
                0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                          <TurnViewWithSessionCommon
                           turn={item.turn}
                           metadata={props.metadata}
                           sessionId={props.sessionId}
                           interaction={props.interaction}
                           activeThinkingMessageId={rowActiveThinkingMessageId}
                           getMessageById={getTurnMessageById}
                           getMessageOrigin={getTurnMessageOrigin}
                           approvalRequests={props.approvalRequests}
                           rollbackRanges={props.rollbackRanges}
                           resolveRollbackAction={resolveRollbackActionForMessage}
                             resolveThinkingExpanded={resolveThinkingExpanded}
                             setThinkingExpanded={setThinkingExpanded}
                           expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                          setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                          forkCommon={props.forkCommon}
                          messageDisplayCommon={props.messageDisplayCommon}
                          toolChromeCommon={props.toolChromeCommon}
                          toolRouteCommon={toolRouteCommonRef.current}
                      />
                  </TranscriptEnterWrapper>
              ));
          }
        if (item.kind === 'message') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, props.activeThinkingMessageId);
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            // N3.1: the chronologically-previous (older) row is index - 1 in standard
            // orientation and index + 1 under inverted (rendered order is newest-first).
            // Hot/cold split: cold rows carry a `listData` index, hot-tail rows carry a full
            // `displayItems` index. Resolve the neighbor against whichever array actually holds
            // the item at this index — when the split is OFF both refs are the same array, so this
            // is identical to the full-array lookup (no behavior change).
            const neighborItems = listDataRef.current[index]?.id === item.id
                ? listDataRef.current
                : itemsRef.current;
            const olderNeighborIndex = resolveOlderNeighborRenderedIndex(
                index,
                neighborItems.length,
                listOrientationRef.current,
            );
            const prev = listImplementation === 'flash_v2' && olderNeighborIndex != null
                ? neighborItems[olderNeighborIndex]
                : undefined;
            const shouldTightenToolStack =
                listImplementation === 'flash_v2' &&
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;

            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            messageOverride={item.originSessionId ? (props.messagesById[item.messageId] ?? null) : undefined}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={rowActiveThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackAction={props.rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={props.rollbackRanges}
                            approvalRequests={props.approvalRequests}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={toolRouteCommonRef.current}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
      }, [expandedToolCallsAnchorMessageIds, getTurnMessageById, getTurnMessageOrigin, listImplementation, props.activeThinkingMessageId, props.approvalRequests, props.forkCommon, props.interaction, props.messageDisplayCommon, props.metadata, props.rollbackRanges, props.sessionId, props.toolChromeCommon, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveRollbackActionForMessage, resolveThinkingExpanded, resolveToolCallMessagesForIds, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode, wrapTranscriptItemForAnchor]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);
    const listHeaderNode = React.useMemo(() => (
        <ListHeader />
    ), []);

    const loadOlder = useCallback(async (options: LoadOlderOptions = {}): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded && props.forkedTranscriptEnabled !== true) return null;
        const showLoadingIndicator = options.showLoadingIndicator !== false;
        const preservePrependViewport = options.preservePrependViewport !== false;
        if (loadOlderInFlight.current || hasMoreOlderRef.current === false || hasMoreOlder === false) {
            if (loadOlderInFlight.current && showLoadingIndicator && options.loadingIndicatorDelayMs === 0) {
                showOlderLoadSpinner();
            }
            return null;
        }
        loadOlderInFlight.current = true;
        const loadingIndicatorDelayMs = typeof options.loadingIndicatorDelayMs === 'number' && Number.isFinite(options.loadingIndicatorDelayMs)
            ? Math.max(0, Math.trunc(options.loadingIndicatorDelayMs))
            : 0;
        if (!showLoadingIndicator) {
            clearOlderLoadSpinnerDelay();
        } else if (loadingIndicatorDelayMs > 0) {
            olderLoadSpinnerDelayTimeoutRef.current = setTimeout(() => {
                olderLoadSpinnerDelayTimeoutRef.current = null;
                setIsLoadingOlder(true);
            }, loadingIndicatorDelayMs);
        } else {
            showOlderLoadSpinner();
        }
        try {
            if (
                preservePrependViewport &&
                entrySliceWindowRef.current?.sessionId === props.sessionId
            ) {
                // N2b.2: a user-triggered older load while the slice window is still
                // active reveals the withheld LOCAL rows first (one prepend-observed
                // commit, no network) — the next load paginates normally.
                const revealed = revealEntrySliceWindowRef.current();
                if (revealed > 0) {
                    return {
                        loaded: revealed,
                        // The top guard already excluded `false`; null means unknown → assume more.
                        hasMore: hasMoreOlderRef.current ?? true,
                        status: 'loaded',
                    };
                }
            }
            inFlightWebPrependAnchorRef.current = preservePrependViewport
                ? captureCurrentWebPrependAnchor()
                : null;
            // In inverted native mode, real older-history loads append at the rendered data end
            // (visual top). They are not prepends from the list's raw-offset perspective, so the
            // standard native prepend fallback would be a second, wrong scroll owner.
            const shouldOpenNativePrependTransaction =
                preservePrependViewport &&
                listOrientationRef.current !== 'inverted';
            const nativePrependTransaction = shouldOpenNativePrependTransaction
                ? beginNativePrependTransaction()
                : null;

            const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
            const result = props.forkedTranscriptEnabled
                ? (syncLoadOlderOptions
                    ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessagesForkAware(props.sessionId))
                : (syncLoadOlderOptions
                    ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                    : await sync.loadOlderMessages(props.sessionId));

            const webPrependAnchor = inFlightWebPrependAnchorRef.current;
            inFlightWebPrependAnchorRef.current = null;

            if (Platform.OS === 'web' && listImplementation === 'flash_v2' && preservePrependViewport && result.loaded > 0) {
                // Plan E2: capture outcome — a restore window opens ('pending') or the capture
                // was skipped (pinned/non-scrollable viewport) and the prepend rides bottom-follow.
                recordRestoreDecisionTelemetry(webPrependAnchor ? 'pending' : 'skipped', {
                    mode: 'restore-anchor',
                    programmaticWebWrite: false,
                    webTrigger: 'prepend-restore',
                });
            }
            if (webPrependAnchor && result.loaded > 0) {
                pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                    webPrependAnchor,
                    webPrependAnchor.metrics,
                    {
                        resetExpiry: true,
                        userIntentAtMs: lastUserScrollIntentAtMsRef.current,
                    },
                );
                const recoveryIndex = resolvePendingWebPrependRecoveryIndex(pendingWebPrependAnchorRef.current);
                const hasIdentity = hasPendingWebPrependIdentity(pendingWebPrependAnchorRef.current);
                const restoreResult = restoreWebPrependAnchorThroughViewportCommand(
                    pendingWebPrependAnchorRef.current,
                    { allowGrowthFallback: !hasIdentity && recoveryIndex == null },
                );
                recordWebPrependRestoreOutcome(restoreResult);
                const metrics = resolveWebScrollMetrics();
                updateWebPrependRangeReserve(webPrependAnchor, metrics);
                if (metrics && pendingWebPrependAnchorRef.current) {
                    pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                        pendingWebPrependAnchorRef.current,
                        metrics,
                        resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
                    );
                }
                pendingWebPrependIndexRecoveryRef.current =
                    restoreResult.strategy === 'growth' || (restoreResult.strategy === 'none' && recoveryIndex != null);
                scheduleWebPrependRestoreWindowExpiry(pendingWebPrependAnchorRef.current);
                if (pendingWebPrependIndexRecoveryRef.current) {
                    schedulePendingWebPrependIndexRecovery();
                }
            }
            if (
                nativePrependTransaction &&
                nativePrependTransactionRef.current === nativePrependTransaction &&
                !nativePrependTransaction.isClosed()
            ) {
                if (result.loaded > 0) {
                    // Commit happens when the prepended items are reflected in the rendered
                    // array (layout effect), not here at promise resolution (LC-R #2).
                    nativePrependCommitArmedRef.current = true;
                } else {
                    // Empty/no-op loads dispose the capture with an explicit outcome (LC-R #4).
                    invalidateNativePrependTransaction();
                }
            }

            if (result.status === 'no_more') {
                hasMoreOlderRef.current = false;
                setHasMoreOlder(false);
            } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
                hasMoreOlderRef.current = result.hasMore;
                setHasMoreOlder(result.hasMore);
            }
            return {
                loaded: result.loaded,
                hasMore: result.hasMore,
                status: result.status,
            };
        } finally {
            inFlightWebPrependAnchorRef.current = null;
            const danglingTransaction = nativePrependTransactionRef.current;
            if (
                danglingTransaction != null &&
                !nativePrependCommitArmedRef.current &&
                danglingTransaction.sessionId === props.sessionId &&
                danglingTransaction.state() === 'awaiting-commit'
            ) {
                // The load threw or yielded nothing observable: never drop the capture silently.
                invalidateNativePrependTransaction();
            }
            hideOlderLoadSpinner();
            loadOlderInFlight.current = false;
        }
    }, [
        beginNativePrependTransaction,
        captureCurrentWebPrependAnchor,
        clearOlderLoadSpinnerDelay,
        hasMoreOlder,
        hasPendingWebPrependIdentity,
        hideOlderLoadSpinner,
        invalidateNativePrependTransaction,
        listImplementation,
        pinThresholdPx,
        props.committedMessagesCount,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        recordWebPrependRestoreOutcome,
        resolvePendingWebPrependRecoveryIndex,
        resolveSyncLoadOlderOptions,
        resolveWebScrollMetrics,
        scheduleWebPrependRestoreWindowExpiry,
        restoreWebPrependAnchorThroughViewportCommand,
        showOlderLoadSpinner,
    ]);
    loadOlderForAnchorLookupRef.current = loadOlder;

    const paginationLoadOlder = React.useCallback(async () => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' as const };
        }
        // The hook owns pacing and the loading indicator (plan D2/D3).
        return await loadOlder({ showLoadingIndicator: false });
    }, [loadOlder]);

    // Single owner of user-triggered older pagination (plan D2): machine-driven hook shared
    // with ChainTranscriptList; replaces the deleted dwell scheduler family. Suspension while
    // any viewport transaction is open comes from the ownership machine.
    const olderPagination = useTranscriptOlderPagination({
        enabled: listImplementation === 'flash_v2',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveBackwardPrefetchThresholdPx(listLayoutHeight),
        cooldownMs: sync.getSyncTuning().transcriptOlderLoadCooldownMs,
        spinnerDelayMs: sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => initialFillStatusRef.current === 'done',
        isTransactionOpen: () => viewportCommandController.activeOwner() !== 'follow',
    });
    olderPaginationSnapshotRef.current = olderPagination.getSnapshot();
    resetOlderPaginationRef.current = olderPagination.reset;
    const onOlderPaginationScrollObservation = olderPagination.onScrollObservation;

    const observeOlderPaginationScroll = React.useCallback((params: Readonly<{
        offsetY: number;
        layoutHeight: number;
        contentHeight: number;
        distanceFromBottom: number;
        webMetrics?: WebTranscriptScrollMetrics | null;
        trigger?: 'scroll' | 'edge-reached';
    }>) => {
        if (listImplementation !== 'flash_v2') return;
        const usesWebDomMetrics = Platform.OS === 'web' && params.webMetrics != null;
        const layoutHeight = usesWebDomMetrics ? params.webMetrics!.clientHeight : params.layoutHeight;
        const contentHeight = usesWebDomMetrics ? params.webMetrics!.scrollHeight : params.contentHeight;
        const offsetY = usesWebDomMetrics ? params.webMetrics!.scrollTop : params.offsetY;
        const distanceFromBottom = usesWebDomMetrics
            ? getWebTranscriptDistanceFromBottom(params.webMetrics!)
            : params.distanceFromBottom;
        const scrollable = usesWebDomMetrics
            ? isWebTranscriptScrollable(params.webMetrics!, 16)
            : layoutHeight > 0 && contentHeight > layoutHeight + 16;
        // The follow-mode gate stays consumer-side (Lane D contract): no top prefetch while
        // the native mode machine reports 'following' or the viewport wants the bottom.
        const followGateOpen = Platform.OS === 'web'
            ? !(wantsPinnedRef.current && distanceFromBottom <= pinThresholdPx)
            : bottomFollowModeStateRef.current.mode !== 'following' && !wantsPinnedRef.current;
        onOlderPaginationScrollObservation({
            offsetY,
            scrollable: scrollable && followGateOpen,
            trigger: params.trigger,
        });
        if (Platform.OS === 'web') {
            const snapshot = olderPagination.getSnapshot();
            recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: resolveViewportTelemetryMode(),
                reason: 'observed',
                offsetY,
                layoutHeight,
                contentHeight,
                distanceFromBottom,
                ...resolveWebViewportTelemetryDiagnostics({
                    metrics: params.webMetrics,
                    flashListContentHeight: params.contentHeight,
                    flashListLayoutHeight: params.layoutHeight,
                    paginationPhase: snapshot.phase,
                    paginationSuspendedReasons: snapshot.suspendedReasons,
                    programmaticWebWrite: false,
                    scrollable: scrollable && followGateOpen,
                    trigger: params.trigger ?? 'scroll',
                }),
            });
        }
    }, [
        listImplementation,
        olderPagination,
        onOlderPaginationScrollObservation,
        pinThresholdPx,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        resolveWebViewportTelemetryDiagnostics,
    ]);

    /**
     * FlashList can miss onStartReached (#1785); the older visual edge feeds one
     * more canonical-space observation to the pagination machine. The callback
     * source itself is authoritative: under inverted data-start is visual bottom,
     * and stale ref offsets from a previous frame must never turn that bottom
     * callback into an older-page load.
     */
    const observePaginationEdgeReachedNudge = React.useCallback((visualEdge: 'older' | 'newer') => {
        if (visualEdge !== 'older') return;
        const liveWebMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
        const rawEdgeOffset = liveWebMetrics
            ? liveWebMetrics.scrollTop
            : (() => {
                try {
                    const value = listRef.current?.getAbsoluteLastScrollOffset?.();
                    return typeof value === 'number' && Number.isFinite(value) ? value : null;
                } catch {
                    return null;
                }
            })();
        if (typeof rawEdgeOffset !== 'number') return;
        const layoutH = liveWebMetrics?.clientHeight ?? listLayoutHeightRef.current;
        const contentH = liveWebMetrics?.scrollHeight ?? listContentHeightRef.current;
        const canonicalEdgeOffset = toCanonicalScrollOffset({
            offsetY: rawEdgeOffset,
            contentHeight: contentH,
            layoutHeight: layoutH,
            orientation: listOrientationRef.current,
        });
        observeOlderPaginationScroll({
            offsetY: canonicalEdgeOffset,
            layoutHeight: layoutH,
            contentHeight: contentH,
            distanceFromBottom: Math.max(0, Math.trunc(contentH - layoutH - canonicalEdgeOffset)),
            webMetrics: liveWebMetrics,
            trigger: 'edge-reached',
        });
    }, [observeOlderPaginationScroll, resolveWebScrollMetrics]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;

        let pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        if (pendingAnchor.userIntentAtMs !== lastUserScrollIntentAtMsRef.current) {
            const metrics = resolveWebScrollMetrics();
            if (!metrics || !isWebTranscriptScrollable(metrics, 1)) {
                clearWebPrependRestoreWindow('abandoned-identity');
                // Plan E2: the scroller went away/unscrollable — the restore window is disposed.
                recordRestoreDecisionTelemetry('skipped', {
                    mode: 'restore-anchor',
                    programmaticWebWrite: false,
                    webTrigger: 'prepend-restore',
                });
                return;
            }
            pendingAnchor = refreshWebTranscriptPrependAnchor(pendingAnchor, metrics, {
                recaptureAnchor: true,
                resetExpiry: true,
                userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            });
            pendingWebPrependAnchorRef.current = pendingAnchor;
            pendingWebPrependIndexRecoveryRef.current = false;
        }
        if (Date.now() > pendingAnchor.expiresAtMs) {
            clearWebPrependRestoreWindow('abandoned-identity');
            // Plan E2: the stabilization window expired; the restore window closes silently no more.
            recordRestoreDecisionTelemetry('skipped', {
                mode: 'restore-anchor',
                programmaticWebWrite: false,
                webTrigger: 'prepend-restore',
            });
            return;
        }

        if (pendingWebPrependIndexRecoveryRef.current) {
            attemptPendingWebPrependIndexRecovery();
            return;
        }

        const recoveryIndex = resolvePendingWebPrependRecoveryIndex(pendingAnchor);
        const hasIdentity = hasPendingWebPrependIdentity(pendingAnchor);
        const restoreResult = restoreWebPrependAnchorThroughViewportCommand(pendingAnchor, {
            allowGrowthFallback: !hasIdentity && recoveryIndex == null,
        });
        recordWebPrependRestoreOutcome(restoreResult);
        const metrics = resolveWebScrollMetrics();
        if (!metrics) {
            clearWebPrependRestoreWindow(restoreResult.didAdjustScroll ? 'confirmed' : 'abandoned-identity');
            return;
        }
        updateWebPrependRangeReserve(pendingAnchor, metrics);
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            pendingAnchor,
            metrics,
            resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
        );
        scheduleWebPrependRestoreWindowExpiry(pendingWebPrependAnchorRef.current);
        pendingWebPrependIndexRecoveryRef.current =
            pendingWebPrependIndexRecoveryRef.current
            || restoreResult.strategy === 'growth'
            || (restoreResult.strategy === 'none' && recoveryIndex != null);
        if (pendingWebPrependIndexRecoveryRef.current && pendingWebPrependAnchorRef.current) {
            attemptPendingWebPrependIndexRecovery();
        }
    }, [attemptPendingWebPrependIndexRecovery, clearWebPrependRestoreWindow, hasPendingWebPrependIdentity, listContentHeight, listData.length, listImplementation, props.sessionId, recordRestoreDecisionTelemetry, recordWebPrependRestoreOutcome, resolvePendingWebPrependRecoveryIndex, resolvePendingWebPrependRefreshOptions, resolveWebScrollMetrics, restoreWebPrependAnchorThroughViewportCommand, scheduleWebPrependRestoreWindowExpiry, updateWebPrependRangeReserve]);

        const tryPinToBottomDom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
            if (reason === 'jump-to-bottom') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'jump-to-bottom',
                    sessionId: props.sessionId,
                }));
            }
            if (reason === 'initial-open') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'first-paint',
                    sessionId: props.sessionId,
                    shouldFollowBottom: true,
                    entrySnapshot: null,
                    jumpToSeq: null,
                    platform: telemetryPlatform,
                    listImplementation: telemetryListImplementation,
                }));
            }
            if (reason === 'jump-to-seq') {
                return executeViewportCommand(resolveViewportCommand({
                    type: 'pin-bottom',
                    sessionId: props.sessionId,
                    reason,
                    mode: 'jump-to-seq',
                }));
            }
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: true,
                reason,
            }));
        }, [
            executeViewportCommand,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            telemetryListImplementation,
            telemetryPlatform,
        ]);

    const resolveNearestSurvivingViewportAnchorIndex = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorMessageId = typeof anchor.messageId === 'string' && anchor.messageId.length > 0
            ? anchor.messageId
            : null;
        if (!anchorMessageId) return null;
        const anchorSeq = resolveSeqForMessageId(anchorMessageId);
        if (typeof anchorSeq !== 'number' || !Number.isFinite(anchorSeq)) return null;

        type AnchorIndexCandidate = { index: number; seq: number };
        let earlier: AnchorIndexCandidate | null = null;
        let later: AnchorIndexCandidate | null = null;
        const resolveItemSeqs = (item: ChatTranscriptListItem): number[] => {
            const seqs: number[] = [];
            const addSeq = (seq: number | null | undefined) => {
                if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(Math.trunc(seq));
            };
            if (item.kind === 'message') {
                addSeq(item.seq ?? resolveSeqForMessageId(item.messageId));
                return seqs;
            }
            if (item.kind === 'tool-calls-group') {
                for (const toolMessageId of item.toolMessageIds) {
                    addSeq(resolveSeqForMessageId(toolMessageId));
                }
                return seqs;
            }
            // N2c per-unit rows: a tool unit resolves its OWN seq; header/expand/footer
            // caps resolve none, so the nearest surviving anchor lands on a real row.
            if (item.kind === 'tool-group-tool') {
                addSeq(item.seq ?? resolveSeqForMessageId(item.toolMessageId));
                return seqs;
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId) {
                    addSeq(resolveSeqForMessageId(item.turn.userMessageId));
                }
                for (const content of item.turn.content) {
                    if (content.kind === 'message') {
                        addSeq(resolveSeqForMessageId(content.messageId));
                    } else if (content.kind === 'tool_calls') {
                        for (const toolMessageId of content.toolMessageIds) {
                            addSeq(resolveSeqForMessageId(toolMessageId));
                        }
                    }
                }
            }
            return seqs;
        };

        const items = listDataRef.current;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index]!;
            for (const normalizedSeq of resolveItemSeqs(item)) {
                if (normalizedSeq < anchorSeq) {
                    if (!earlier || normalizedSeq > earlier.seq) earlier = { index, seq: normalizedSeq };
                    continue;
                }
                if (normalizedSeq > anchorSeq) {
                    if (!later || normalizedSeq < later.seq) later = { index, seq: normalizedSeq };
                }
            }
        }

        return earlier?.index ?? later?.index ?? null;
    }, [resolveSeqForMessageId]);

    React.useLayoutEffect(() => {
        // Prepend transaction commit/observe loop (plan F4): commits once the prepended page
        // is reflected in the rendered items, then re-observes the single window on every
        // layout/data pass until the transaction closes.
        observeNativePrependTransaction();
    }, [
        listContentHeight,
        listData.length,
        listImplementation,
        observeNativePrependTransaction,
        props.sessionId,
    ]);

    const handleNativeRestoreIndexFailure = React.useCallback((failedIndex: number): boolean => {
        if (Platform.OS === 'web') return false;
        const lastCommand = lastNativeRestoreIndexCommandRef.current;
        if (!lastCommand || lastCommand.sessionId !== props.sessionId || lastCommand.index !== failedIndex) return false;
        if (lastCommand.reason === 'jump-to-seq') return false;

        // entry-restore index failures need no recovery scheduling (plan F2): the transaction
        // either confirms through a later conclusive observation or closes at its deadline.
        return lastCommand.reason === 'entry-restore';
    }, [
        props.sessionId,
    ]);

    const canRequestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupExhaustedRef.current) return false;
        if (anchorLookupInFlightRef.current) return true;
        if (!loadOlderForAnchorLookupRef.current) return false;
        return anchorLookupLoadCountRef.current < sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
    }, []);

    const resolveEntryRestoreCanonicalMetrics = React.useCallback((): { contentHeight: number; layoutHeight: number } => {
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            return {
                contentHeight: metrics ? Math.max(0, Math.trunc(metrics.scrollHeight)) : 0,
                layoutHeight: metrics ? Math.max(0, Math.trunc(metrics.clientHeight)) : 0,
            };
        }
        // A6: ONE canonical native content basis — the scroll-event contentSize. The measured
        // ref carries the composer inset added back (`resolveMeasuredContentHeight`), so the
        // canonical basis subtracts it again; entry alignment checks in onScroll read the same
        // basis directly from the scroll event.
        if (!hasNativeContentMeasurementForCurrentSession()) {
            return { contentHeight: 0, layoutHeight: listLayoutHeightRef.current };
        }
        const contentHeight = listImplementation === 'flash_v2'
            ? Math.max(0, Math.trunc(listContentHeightRef.current - composerInsetHeightRef.current))
            : Math.max(0, Math.trunc(listContentHeightRef.current));
        return { contentHeight, layoutHeight: listLayoutHeightRef.current };
    }, [hasNativeContentMeasurementForCurrentSession, listImplementation, resolveWebScrollMetrics]);

    const clearEntryRestoreDeadlineTimeout = React.useCallback(() => {
        const scheduled = entryRestoreDeadlineTimeoutRef.current;
        if (!scheduled) return;
        entryRestoreDeadlineTimeoutRef.current = null;
        clearTimeout(scheduled.timeoutId);
    }, []);

    /**
     * Single close point of the entry-restore lifecycle (plan F2): ownership phase release,
     * outcome telemetry, and the native first-paint reveal all hang off the transaction close.
     */
    const finishEntryRestoreTransaction = React.useCallback((transaction: EntryRestoreTransaction) => {
        if (entryRestoreTransactionRef.current !== transaction) return;
        if (!transaction.isClosed()) return;
        clearEntryRestoreDeadlineTimeout();
        const outcome = transaction.outcome();
        const writeContext = entryRestoreWriteContextRef.current;
        closeEntryViewportOwnership(
            outcome === 'preempted-user-scroll'
                ? 'preempted'
                : outcome === 'deadline'
                    ? 'deadline'
                    : 'confirmed',
        );
        recordRestoreDecisionTelemetry(
            outcome === 'confirmed'
                ? 'restored'
                : outcome === 'deadline'
                    ? 'not-ready'
                    : 'skipped',
            {
                mode: writeContext?.kind === 'anchor' || writeContext?.kind === 'slice-anchor'
                    ? 'restore-anchor'
                    : writeContext?.kind === 'bottom'
                        ? 'follow-bottom'
                        : 'restore-distance',
                offsetY: writeContext?.distanceFromBottom,
                contentHeight: writeContext?.issuedContentHeight,
                layoutHeight: writeContext?.issuedLayoutHeight,
            },
        );
        if (Platform.OS !== 'web' && transaction.sessionId === currentSessionIdRef.current) {
            updateNativeInitialViewportPendingObservation(false);
            if (outcome === 'confirmed') {
                markNativeInitialViewportAppliedForCurrentSession();
            } else {
                // A4: the placeholder release is driven by transaction close; the 32ms polish
                // keeps the reveal off the same frame as the final write. The deadline timer
                // always fires, so this can never hang.
                scheduleNativePaintReleaseForEntryRestore({ force: true });
            }
            if (writeContext?.kind === 'slice-anchor') {
                // N2b.2: the entry phase is over (any outcome) — reveal the withheld
                // older rows as one prepend-observed commit so scroll room above the
                // anchor exists again (the window must never stay stranded).
                revealEntrySliceWindowRef.current();
            }
        }
    }, [
        clearEntryRestoreDeadlineTimeout,
        closeEntryViewportOwnership,
        markNativeInitialViewportAppliedForCurrentSession,
        recordRestoreDecisionTelemetry,
        scheduleNativePaintReleaseForEntryRestore,
        updateNativeInitialViewportPendingObservation,
    ]);
    finishEntryRestoreTransactionRef.current = finishEntryRestoreTransaction;

    /**
     * Disposes an OPEN entry-restore transaction on session exit/unmount (mirror of
     * invalidateNativePrependTransaction): the transaction closes preempted and its outcome
     * is telemetered against the transaction's own session — entry restores must never be
     * dropped silently (plan §4 "every outcome telemetered"). Deliberately bypasses
     * finishEntryRestoreTransaction: that path attributes telemetry to the CURRENT session
     * (wrong across a switch) and schedules paint-release work for a lifecycle the exiting
     * session no longer owns.
     */
    const disposeEntryRestoreTransactionForExit = React.useCallback(() => {
        const transaction = entryRestoreTransactionRef.current;
        if (!transaction || transaction.isClosed()) return;
        transaction.onTrustedUserScroll();
        clearEntryRestoreDeadlineTimeout();
        const writeContext = entryRestoreWriteContextRef.current;
        closeEntryViewportOwnership('preempted');
        recordViewportTelemetryEvent({
            type: 'restore-decision',
            mode: writeContext?.kind === 'anchor' || writeContext?.kind === 'slice-anchor'
                ? 'restore-anchor'
                : writeContext?.kind === 'bottom'
                    ? 'follow-bottom'
                    : 'restore-distance',
            reason: 'skipped',
            offsetY: writeContext?.distanceFromBottom,
        }, { sessionId: transaction.sessionId });
    }, [
        clearEntryRestoreDeadlineTimeout,
        closeEntryViewportOwnership,
        recordViewportTelemetryEvent,
    ]);
    disposeEntryRestoreTransactionForExitRef.current = disposeEntryRestoreTransactionForExit;

    const armEntryRestoreDeadline = React.useCallback((transaction: EntryRestoreTransaction, deadlineMs: number) => {
        clearEntryRestoreDeadlineTimeout();
        const handle = {
            sessionId: transaction.sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (entryRestoreDeadlineTimeoutRef.current !== handle) return;
            entryRestoreDeadlineTimeoutRef.current = null;
            if (entryRestoreTransactionRef.current !== transaction || transaction.isClosed()) return;
            // The deadline must always close the transaction, regardless of timer clock skew.
            transaction.onDeadline(Number.MAX_SAFE_INTEGER);
            finishEntryRestoreTransactionRef.current(transaction);
        }, Math.max(0, Math.trunc(deadlineMs)));
        entryRestoreDeadlineTimeoutRef.current = handle;
    }, [clearEntryRestoreDeadlineTimeout]);

    const resolveEntryRestoreDeadlineMs = React.useCallback((): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
            transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
        }).budgetMs;
    }, []);

    const requestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (anchorLookupInFlightRef.current) return true;
        if (anchorLookupExhaustedRef.current) return false;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (anchorLookupLoadCountRef.current >= maxLoads) return false;
        const loadOlderForAnchorLookup = loadOlderForAnchorLookupRef.current;
        if (!loadOlderForAnchorLookup) return false;

        anchorLookupInFlightRef.current = true;
        anchorLookupLoadCountRef.current += 1;
        fireAndForget((async () => {
            let shouldRetryRestore = false;
            try {
                const result = await loadOlderForAnchorLookup({ preservePrependViewport: false, showLoadingIndicator: false });
                shouldRetryRestore = true;
                if (result && (result.status === 'no_more' || result.hasMore === false)) {
                    anchorLookupExhaustedRef.current = true;
                }
                await Promise.resolve();
                await Promise.resolve();
            } finally {
                anchorLookupInFlightRef.current = false;
            }
            if (shouldRetryRestore) {
                attemptEntryRestoreRef.current();
            }
        })(), { tag: 'ChatList.restoreEntryAnchorLookup' });
        return true;
    }, []);

    const issueEntryRestoreAnchorWrite = React.useCallback((index: number, viewOffset: number): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 0,
                anchorIndex: index,
                anchorViewOffset: viewOffset,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        }));
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand, telemetryListImplementation, telemetryPlatform]);

    const issueEntryRestoreDistanceWrite = React.useCallback((distanceFromBottom: number, contentHeight: number): boolean => {
        const command = resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: distanceFromBottom,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        });
        const commandWithContentHeight = Platform.OS !== 'web' && command.kind === 'restore-offset'
            ? { ...command, contentHeight }
            : command;
        return executeViewportCommand(commandWithContentHeight);
    }, [executeViewportCommand, props.sessionId, resolveViewportCommand, telemetryListImplementation, telemetryPlatform]);

    const issueWebEntryRestoreAnchorWrite = React.useCallback((anchor: SessionViewportAnchorSnapshot | null): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2' || !anchor) return false;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return false;
        const result = restoreWebViewportAnchorThroughViewportCommand({
            container: metrics.element,
            anchor: { ...anchor, messageId: anchor.messageId ?? null },
        });
        return result.status === 'restored' || result.status === 'already_aligned';
    }, [listImplementation, resolveWebScrollMetrics, restoreWebViewportAnchorThroughViewportCommand]);

    // Plan E1: after the crash fallback flips the implementation, restore the viewport that
    // was captured from the crashed list — a fresh entry restore on the new implementation,
    // anchor-first through the viewport command seam with the remembered distance as fallback.
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !webFlashListCrashed) return;
        const snapshot = webCrashFallbackViewportRef.current;
        if (!snapshot) return;
        webCrashFallbackViewportRef.current = null;
        if (snapshot.sessionId !== props.sessionId) return;
        // An open entry transaction still owns the viewport and will place it itself.
        const entryTransaction = entryRestoreTransactionRef.current;
        if (entryTransaction && !entryTransaction.isClosed()) return;
        // A pinned-at-bottom viewport rides bottom-follow on the new implementation.
        if (wantsPinnedRef.current && snapshot.distanceFromBottom <= pinThresholdPx) return;
        const opened = viewportCommandController.activeOwner() === 'follow'
            ? viewportCommandController.openTransaction('entry').opened
            : false;
        try {
            let restored = false;
            if (snapshot.anchor) {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    const result = restoreWebViewportAnchorThroughViewportCommand({
                        container: metrics.element,
                        anchor: snapshot.anchor,
                    });
                    restored = result.status === 'restored' || result.status === 'already_aligned';
                }
            }
            if (!restored) {
                issueEntryRestoreDistanceWrite(snapshot.distanceFromBottom, listContentHeightRef.current);
            }
        } finally {
            if (opened) {
                viewportCommandController.closeTransaction('entry', 'confirmed');
            }
        }
    }, [
        issueEntryRestoreDistanceWrite,
        pinThresholdPx,
        props.sessionId,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        viewportCommandController,
        webFlashListCrashed,
    ]);

    /**
     * Web confirm-or-deadline (plan A5): verify the open web entry transaction against live DOM
     * metrics. Conclusive misalignment spends the single correction; stale-height frames are
     * inconclusive and never forwarded (only-conclusive-observations rule).
     */
    const verifyWebEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const transaction = entryRestoreTransactionRef.current;
        const writeContext = entryRestoreWriteContextRef.current;
        if (!transaction || transaction.isClosed() || transaction.sessionId !== props.sessionId || !writeContext) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        const nowMs = Date.now();
        const tolerancePx = Math.max(pinThresholdPx, 2);
        if (writeContext.kind === 'anchor') {
            if (!writeContext.anchor) return;
            // A still-open web anchor transaction means the issue-time anchor restore could
            // not see the anchor row (seam scroll-to-index fallback). Once the row mounts, a
            // read-only alignment observation drives confirm or the single DOM correction.
            const alignment = resolveWebTranscriptViewportAnchorAlignment({
                container: metrics.element,
                anchor: { ...writeContext.anchor, messageId: writeContext.anchor.messageId ?? null },
                tolerancePx,
            });
            if (alignment.status === 'aligned') {
                transaction.onObservation({ status: 'aligned' }, nowMs);
            } else if (alignment.status === 'misaligned') {
                const directive = transaction.onObservation({ status: 'misaligned' }, nowMs);
                if (directive.action === 'issue-correction-write') {
                    const result = restoreWebViewportAnchorThroughViewportCommand({
                        container: metrics.element,
                        anchor: { ...writeContext.anchor, messageId: writeContext.anchor.messageId ?? null },
                    });
                    if (result.status === 'restored' || result.status === 'already_aligned') {
                        // The helper read the anchor back and applied the exact delta.
                        transaction.onObservation({ status: 'aligned' }, nowMs);
                    }
                }
            }
            // not_found stays inconclusive; the deadline closes the transaction honestly.
        } else {
            const distanceTarget = writeContext.kind === 'bottom' ? 0 : writeContext.distanceFromBottom;
            const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
            if (Math.abs(distanceFromBottom - distanceTarget) <= tolerancePx) {
                transaction.onObservation({ status: 'aligned' }, nowMs);
            } else if (metrics.scrollHeight + tolerancePx >= writeContext.issuedContentHeight) {
                const directive = transaction.onObservation({ status: 'misaligned' }, nowMs);
                if (directive.action === 'issue-correction-write') {
                    const issuedContentHeight = Math.max(0, Math.trunc(metrics.scrollHeight));
                    if (writeContext.kind === 'bottom') {
                        tryPinToBottomDom('initial-open');
                    } else {
                        issueEntryRestoreDistanceWrite(distanceTarget, issuedContentHeight);
                    }
                    entryRestoreWriteContextRef.current = {
                        ...writeContext,
                        issuedContentHeight,
                    };
                }
            }
        }
        if (transaction.isClosed()) {
            finishEntryRestoreTransaction(transaction);
        }
    }, [
        finishEntryRestoreTransaction,
        issueEntryRestoreDistanceWrite,
        pinThresholdPx,
        props.sessionId,
        resolveWebScrollMetrics,
        restoreWebViewportAnchorThroughViewportCommand,
        tryPinToBottomDom,
    ]);

    /**
     * Maps a native scroll observation to a CONCLUSIVE transaction observation, or null when
     * the frame is inconclusive (anchor layout unmeasured, stale content metrics): only
     * conclusive aligned|misaligned observations are ever forwarded (Lane A review contract).
     */
    const resolveNativeEntryRestoreAlignmentObservation = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        offsetY: number;
        rawOffsetY?: number;
    }>): { status: 'aligned' | 'misaligned' } | null => {
        const writeContext = entryRestoreWriteContextRef.current;
        if (!writeContext || writeContext.sessionId !== props.sessionId) return null;
        const tolerancePx = Math.max(pinThresholdPx, 2);
        if (writeContext.kind === 'slice-anchor' && writeContext.anchor) {
            // N2b.2: zero-write entries confirm only when the visible anchor row
            // is still sitting at its saved pixel offset.
            const anchorIndex = resolveTranscriptViewportAnchorIndex({
                anchor: writeContext.anchor,
                items: listDataRef.current,
            });
            if (anchorIndex == null) return null;
            const layout = (() => {
                try {
                    return listRef.current?.getLayout?.(anchorIndex) ?? null;
                } catch {
                    return null;
                }
            })();
            const visibleRange = (() => {
                try {
                    return listRef.current?.computeVisibleIndices?.() ?? null;
                } catch {
                    return null;
                }
            })();
            const status = resolveNativeSliceEntryObservation({
                anchorIndex,
                anchorLayout: layout,
                absoluteScrollOffset: params.rawOffsetY ?? params.offsetY,
                contentHeight: params.contentHeight,
                itemOffsetPx: writeContext.anchor.itemOffsetPx,
                layoutHeight: listLayoutHeightRef.current,
                tolerancePx,
                visibleRange,
            });
            return status === 'inconclusive' ? null : { status };
        }
        if (writeContext.kind === 'anchor' && writeContext.anchor) {
            const anchorIndex = resolveTranscriptViewportAnchorIndex({
                anchor: writeContext.anchor,
                items: listDataRef.current,
            }) ?? resolveNearestSurvivingViewportAnchorIndex(writeContext.anchor);
            if (anchorIndex == null) return null;
            const observation = resolveNativeTranscriptViewportAnchorRestoreObservation({
                ref: listRef.current,
                index: anchorIndex,
                itemOffsetPx: writeContext.anchor.itemOffsetPx,
                tolerancePx,
            });
            if (observation.status === 'aligned' || observation.status === 'misaligned') {
                return { status: observation.status };
            }
            return null;
        }
        if (writeContext.kind === 'distance') {
            const matches = nativeEntryRestoreObservationMatches({
                contentHeight: writeContext.issuedContentHeight,
                kind: 'distance',
                offsetY: writeContext.distanceFromBottom,
                sessionId: writeContext.sessionId,
                targetOffsetY: writeContext.targetOffsetY ?? undefined,
                targetOffsetYWasClamped: writeContext.targetOffsetYWasClamped,
            }, {
                contentHeight: params.contentHeight,
                distanceFromBottom: params.distanceFromBottom,
                observedOffsetY: params.offsetY,
                sessionId: props.sessionId,
                tolerancePx,
            });
            if (matches) return { status: 'aligned' };
            if (params.contentHeight + tolerancePx < writeContext.issuedContentHeight) {
                // Stale content frame: the list has not laid out the issued basis yet.
                return null;
            }
            return { status: 'misaligned' };
        }
        return null;
    }, [pinThresholdPx, props.sessionId, resolveNearestSurvivingViewportAnchorIndex]);

    /** Host-derived single correction write for the open native entry transaction. */
    const issueNativeEntryRestoreCorrection = React.useCallback((params: Readonly<{
        contentHeight: number;
        layoutHeight: number;
    }>) => {
        const writeContext = entryRestoreWriteContextRef.current;
        if (!writeContext || writeContext.sessionId !== props.sessionId) return;
        // N2b.2: slice entries are observe-only — the transaction never directs a
        // correction, and the host must never write for them either.
        if (writeContext.kind === 'slice-anchor') return;
        if (writeContext.kind === 'anchor' && writeContext.anchor) {
            const anchorIndex = resolveTranscriptViewportAnchorIndex({
                anchor: writeContext.anchor,
                items: listDataRef.current,
            }) ?? resolveNearestSurvivingViewportAnchorIndex(writeContext.anchor);
            if (anchorIndex == null) return;
            const restorePlan = planNativeTranscriptViewportAnchorRestore({
                index: anchorIndex,
                itemOffsetPx: writeContext.anchor.itemOffsetPx,
            });
            if (restorePlan.status !== 'planned') return;
            executeViewportCommand(resolveViewportCommand({
                type: 'restore-anchor',
                sessionId: props.sessionId,
                reason: 'entry-restore',
                index: restorePlan.index,
                viewOffset: restorePlan.viewOffset,
                animated: false,
            }));
            return;
        }
        if (writeContext.kind === 'distance') {
            const issuedContentHeight = Math.max(0, Math.trunc(params.contentHeight));
            const maxOffsetY = Math.max(0, Math.trunc(issuedContentHeight - params.layoutHeight));
            const targetOffsetY = Math.max(0, maxOffsetY - writeContext.distanceFromBottom);
            executeViewportCommand(resolveViewportCommand({
                type: 'scroll-offset',
                sessionId: props.sessionId,
                reason: 'entry-restore',
                mode: 'restore-distance',
                offsetY: targetOffsetY,
                animated: false,
            }));
            entryRestoreWriteContextRef.current = {
                ...writeContext,
                issuedContentHeight,
                targetOffsetY,
                targetOffsetYWasClamped: maxOffsetY < writeContext.distanceFromBottom,
            };
        }
    }, [executeViewportCommand, props.sessionId, resolveNearestSurvivingViewportAnchorIndex, resolveViewportCommand]);

    /**
     * N2b.2: layout-driven confirmation for slice entries — a write-free entry produces
     * NO scroll events, so the open observe-only transaction is verified from layout/
     * content commits by reading the anchor row position straight off the list ref.
     */
    const verifyNativeSliceEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') return;
        const transaction = entryRestoreTransactionRef.current;
        const writeContext = entryRestoreWriteContextRef.current;
        if (!transaction || transaction.isClosed() || transaction.sessionId !== props.sessionId) return;
        if (writeContext?.kind !== 'slice-anchor' || !writeContext.anchor) return;
        const anchorIndex = resolveTranscriptViewportAnchorIndex({
            anchor: writeContext.anchor,
            items: listDataRef.current,
        });
        if (anchorIndex == null) return;
        const node = listRef.current;
        const layout = (() => {
            try {
                return node?.getLayout?.(anchorIndex) ?? null;
            } catch {
                return null;
            }
        })();
        const absoluteScrollOffset = (() => {
            try {
                const value = node?.getAbsoluteLastScrollOffset?.();
                return typeof value === 'number' ? value : Number.NaN;
            } catch {
                return Number.NaN;
            }
        })();
        const status = resolveNativeSliceEntryObservation({
            anchorIndex,
            anchorLayout: layout,
            absoluteScrollOffset,
            contentHeight: listContentHeightRef.current,
            itemOffsetPx: writeContext.anchor.itemOffsetPx,
            layoutHeight: listLayoutHeightRef.current,
            tolerancePx: Math.max(pinThresholdPx, 2),
            visibleRange: (() => {
                try {
                    return node?.computeVisibleIndices?.() ?? null;
                } catch {
                    return null;
                }
            })(),
        });
        if (status === 'inconclusive') return;
        transaction.onObservation({ status }, Date.now());
        if (transaction.isClosed()) {
            const confirmed = transaction.outcome() === 'confirmed';
            finishEntryRestoreTransaction(transaction);
            if (confirmed) {
                updateNativeViewportPaintObserved(true);
            }
        }
    }, [
        finishEntryRestoreTransaction,
        listImplementation,
        pinThresholdPx,
        props.sessionId,
        updateNativeViewportPaintObserved,
    ]);

    /**
     * KEEP-INLINE legacy escape hatch (Lane A review F2 contract): `flatlist_legacy` keeps its
     * old inline distance restore (the seam applies the inverted-offset semantics) and never
     * opens an entry-restore transaction; this path dies with flatlist_legacy itself.
     */
    const attemptLegacyEntryDistanceRestore = React.useCallback(() => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== props.sessionId) return;
        if (entryViewport.shouldFollowBottom !== false) return;
        if (props.jumpToSeq != null) return;
        if (wantsPinnedRef.current) return;
        if (lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY) return;
        const offsetY = typeof entryViewport.offsetY === 'number' && Number.isFinite(entryViewport.offsetY)
            ? Math.max(0, Math.trunc(entryViewport.offsetY))
            : 0;
        const applied = legacyEntryRestoreAppliedRef.current;
        if (applied?.sessionId === entryViewport.sessionId && applied.offsetY === offsetY) return;
        if (Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return;
            if (resolveWebTranscriptMaxScrollTop(metrics) < offsetY && requestBoundedEntryViewportMaterialization()) {
                return;
            }
        } else {
            const layoutHeight = listLayoutHeightRef.current;
            const contentHeight = listContentHeightRef.current;
            if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;
            if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
            if (
                Math.max(0, Math.trunc(contentHeight - layoutHeight)) < offsetY &&
                requestBoundedEntryViewportMaterialization()
            ) {
                return;
            }
        }
        if (!executeViewportCommand(resolveViewportCommand({
            type: 'first-paint',
            sessionId: props.sessionId,
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY,
            },
            jumpToSeq: null,
            platform: telemetryPlatform,
            listImplementation: telemetryListImplementation,
        }))) {
            return;
        }
        legacyEntryRestoreAppliedRef.current = { sessionId: entryViewport.sessionId, offsetY };
        closeEntryViewportOwnership('confirmed');
        recordRestoreDecisionTelemetry('restored', { mode: 'restore-distance', offsetY });
    }, [
        closeEntryViewportOwnership,
        executeViewportCommand,
        props.jumpToSeq,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        requestBoundedEntryViewportMaterialization,
        resolveViewportCommand,
        resolveWebScrollMetrics,
        telemetryListImplementation,
        telemetryPlatform,
    ]);

    /**
     * Entry-restore resolution driver (plan F2 + Lane A): resolves the entry target through
     * `resolveEntryRestoreTarget`, runs pre-transaction materialization for unresolved anchors
     * and too-deep distances, and creates exactly ONE transaction per session entry whose
     * initial write is issued here. Content-height churn can never re-issue a write: there is
     * no reapply path (evidence E1).
     */
    const attemptEntryRestore = React.useCallback((): void => {
        const entryViewport = sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== props.sessionId) return;
        if (entryViewport.shouldFollowBottom !== false) return;
        if (listImplementation === 'flatlist_legacy') {
            attemptLegacyEntryDistanceRestore();
            return;
        }
        if (entryRestoreTransactionRef.current != null) return;
        if (entryRestoreSuppressedRef.current) return;
        if (props.jumpToSeq != null || latestJumpToSeqRef.current != null) {
            entryRestoreSuppressedRef.current = true;
            closeEntryViewportOwnership('preempted');
            return;
        }
        if (lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY) {
            entryRestoreSuppressedRef.current = true;
            closeEntryViewportOwnership('preempted');
            return;
        }

        const { contentHeight, layoutHeight } = resolveEntryRestoreCanonicalMetrics();
        const items = listDataRef.current;
        const anchor = entryViewport.anchor;
        const exactAnchorIndex = anchor
            ? resolveTranscriptViewportAnchorIndex({ anchor, items })
            : null;
        const distanceFromBottom = typeof entryViewport.offsetY === 'number' && Number.isFinite(entryViewport.offsetY)
            ? Math.max(0, Math.trunc(entryViewport.offsetY))
            : 0;
        const resolveParams = {
            snapshot: { shouldFollowBottom: false, offsetY: distanceFromBottom, anchor },
            items,
            contentMeasured: { contentHeight, layoutHeight },
            fillSettled: initialFillStatusRef.current === 'done',
            canMaterializeOlder: canRequestBoundedEntryViewportMaterialization(),
            anchorIndexResolver: () => exactAnchorIndex,
            nearestSurvivingResolver: () => (anchor ? resolveNearestSurvivingViewportAnchorIndex(anchor) : null),
            anchorSeqResolver: () => (
                typeof anchor?.messageId === 'string' && anchor.messageId.length > 0
                    ? resolveSeqForMessageId(anchor.messageId) ?? null
                    : null
            ),
        };

        /**
         * N2b.2: maps the slice target's durable identity (server id + seq for hydrated
         * persisted anchors; rendered id for in-memory captures) to a rendered anchor
         * the row resolution understands. Returns null when no rendered row owns it.
         */
        const resolveEntrySliceRenderedAnchor = (
            sliceTarget: EntryRestoreSliceTarget,
        ): SessionViewportAnchorSnapshot | null => {
            const baseAnchor: SessionViewportAnchorSnapshot = {
                kind: anchor?.kind ?? 'message',
                messageId: sliceTarget.anchorMessageId,
                itemId: anchor?.itemId ?? sliceTarget.anchorMessageId,
                itemOffsetPx: sliceTarget.anchorItemOffsetPx,
                capturedAtMs: anchor?.capturedAtMs ?? Date.now(),
            };
            if (resolveTranscriptViewportAnchorIndex({ anchor: baseAnchor, items: listDataRef.current }) != null) {
                return baseAnchor;
            }
            // Rendered ids are runtime-local: map the persisted server id (realID),
            // then the seq, to the rendered message (durable-identity lesson, N2b.1).
            const state = getStorage().getState();
            const session = state?.sessionMessages?.[props.sessionId];
            const messagesById: Record<string, Message | undefined> =
                session?.messagesById ?? session?.messagesMap ?? {};
            let renderedId: string | null = null;
            for (const message of Object.values(messagesById)) {
                if (message?.realID === sliceTarget.anchorMessageId) {
                    renderedId = message.id;
                    break;
                }
            }
            if (renderedId == null && sliceTarget.anchorSeq != null) {
                for (const message of Object.values(messagesById)) {
                    if (
                        typeof message?.seq === 'number' &&
                        Math.trunc(message.seq) === sliceTarget.anchorSeq
                    ) {
                        renderedId = message.id;
                        break;
                    }
                }
            }
            if (renderedId == null) return null;
            return { ...baseAnchor, messageId: renderedId, itemId: renderedId };
        };

        /** N2b.2: applies the slice window + the observe-only entry transaction. */
        const applyEntrySliceWindow = (
            sliceTarget: EntryRestoreSliceTarget,
        ): 'applied' | 'materializing' | 'degraded' => {
            const renderedAnchor = resolveEntrySliceRenderedAnchor(sliceTarget);
            const sliceIndex = renderedAnchor != null
                ? resolveTranscriptViewportAnchorIndex({ anchor: renderedAnchor, items: listDataRef.current })
                : null;
            if (renderedAnchor == null || sliceIndex == null) {
                if (canRequestBoundedEntryViewportMaterialization() && requestBoundedEntryViewportMaterialization()) {
                    recordRestoreDecisionTelemetry('missing-anchor', {
                        mode: 'restore-anchor',
                        offsetY: distanceFromBottom,
                        contentHeight,
                        layoutHeight,
                    });
                    return 'materializing';
                }
                return 'degraded';
            }

            if (!canUseWriteFreeEntrySliceForAnchorOffset(sliceTarget.anchorItemOffsetPx)) {
                const restorePlan = planNativeTranscriptViewportAnchorRestore({
                    index: sliceIndex,
                    itemOffsetPx: sliceTarget.anchorItemOffsetPx,
                });
                if (restorePlan.status !== 'planned') return 'degraded';
                const fallbackNowMs = Date.now();
                const fallbackDeadlineMs = resolveEntryRestoreDeadlineMs();
                const target = {
                    kind: 'anchor' as const,
                    index: restorePlan.index,
                    viewOffset: restorePlan.viewOffset,
                };
                const issued = issueEntryRestoreAnchorWrite(target.index, target.viewOffset);
                if (!issued) {
                    recordRestoreDecisionTelemetry('not-ready', {
                        mode: 'restore-anchor',
                        offsetY: distanceFromBottom,
                        contentHeight,
                        layoutHeight,
                    });
                    return 'materializing';
                }
                const transaction = createEntryRestoreTransaction({
                    sessionId: props.sessionId,
                    target,
                    nowMs: fallbackNowMs,
                    deadlineMs: fallbackDeadlineMs,
                });
                entryRestoreTransactionRef.current = transaction;
                entryRestoreWriteContextRef.current = {
                    anchor: renderedAnchor,
                    createdAtMs: fallbackNowMs,
                    distanceFromBottom,
                    issuedContentHeight: contentHeight,
                    issuedLayoutHeight: layoutHeight,
                    kind: 'anchor',
                    sessionId: props.sessionId,
                    targetOffsetY: null,
                    targetOffsetYWasClamped: false,
                };
                armEntryRestoreDeadline(transaction, fallbackDeadlineMs);
                updateNativeInitialViewportPendingObservation(true);
                recordRestoreDecisionTelemetry('pending', {
                    mode: 'restore-anchor',
                    offsetY: distanceFromBottom,
                    contentHeight,
                    layoutHeight,
                    anchorIndex: target.index,
                    anchorRestoreViewOffset: target.viewOffset,
                });
                return 'applied';
            }

            const anchorRowId = listDataRef.current[sliceIndex]?.id;
            if (typeof anchorRowId !== 'string' || anchorRowId.length === 0) return 'degraded';

            const sliceNowMs = Date.now();
            const sliceDeadlineMs = resolveEntryRestoreDeadlineMs();
            entrySliceWindowRef.current = { sessionId: props.sessionId, anchorRowId };
            setEntrySliceWindow(entrySliceWindowRef.current);
            const transaction = createEntryRestoreTransaction({
                sessionId: props.sessionId,
                // Post-slice the anchor is the window head; this target is the
                // OBSERVATION target only — observe-only transactions never write.
                target: { kind: 'anchor', index: 0, viewOffset: 0 },
                nowMs: sliceNowMs,
                deadlineMs: sliceDeadlineMs,
                writePolicy: 'observe-only',
            });
            entryRestoreTransactionRef.current = transaction;
            entryRestoreWriteContextRef.current = {
                anchor: renderedAnchor,
                createdAtMs: sliceNowMs,
                distanceFromBottom,
                issuedContentHeight: contentHeight,
                issuedLayoutHeight: layoutHeight,
                kind: 'slice-anchor',
                sessionId: props.sessionId,
                targetOffsetY: null,
                targetOffsetYWasClamped: false,
            };
            armEntryRestoreDeadline(transaction, sliceDeadlineMs);
            updateNativeInitialViewportPendingObservation(true);
            recordRestoreDecisionTelemetry('pending', {
                mode: 'restore-anchor',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return 'applied';
        };

        const sliceCapable =
            Platform.OS !== 'web' &&
            listImplementation === 'flash_v2' &&
            entrySliceDegradedSessionRef.current !== props.sessionId;
        if (sliceCapable) {
            const sliceResolved = resolveEntryRestoreTarget({
                ...resolveParams,
                slice: { hostCanBuildAnchorWindow: true },
            });
            if (sliceResolved.kind === 'slice') {
                const sliceOutcome = applyEntrySliceWindow(sliceResolved);
                if (sliceOutcome !== 'degraded') return;
                // Identity unfindable within the bounded budget: this entry falls back
                // to the existing write pipeline (distance one-shot stays the ONLY
                // degraded identity-less path).
                entrySliceDegradedSessionRef.current = props.sessionId;
            }
        }

        const target = resolveEntryRestoreTarget(resolveParams);

        if (target.kind === 'none' && (target.reason === 'awaiting-fill-settle' || target.reason === 'content-unmeasured')) {
            // Wait verdict (type-split per Lane A review): re-resolve on the next
            // measurement/fill change without opening a transaction.
            return;
        }
        if (target.kind === 'materialize-then-anchor') {
            requestBoundedEntryViewportMaterialization();
            recordRestoreDecisionTelemetry('missing-anchor', {
                mode: 'restore-anchor',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }
        if (
            target.kind === 'distance-oneshot' &&
            distanceFromBottom > Math.max(0, Math.trunc(contentHeight - layoutHeight)) &&
            requestBoundedEntryViewportMaterialization()
        ) {
            // Wiring-layer extension over resolveEntryRestoreTarget (ledger note): a remembered
            // distance deeper than the loaded window materializes older pages first (bounded),
            // then the one-shot still issues exactly once.
            recordRestoreDecisionTelemetry('not-ready', {
                mode: 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }
        if (anchor && exactAnchorIndex == null && target.kind !== 'none') {
            recordRestoreDecisionTelemetry('entry-anchor-missing', {
                mode: 'restore-anchor',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
        }

        const nowMs = Date.now();
        const deadlineMs = resolveEntryRestoreDeadlineMs();
        if (target.kind === 'none') {
            if (target.reason === 'awaiting-fill-settle' || target.reason === 'content-unmeasured') {
                return;
            }
            const transaction = createEntryRestoreTransaction({
                sessionId: props.sessionId,
                target: { kind: 'none', reason: target.reason },
                nowMs,
                deadlineMs,
            });
            entryRestoreTransactionRef.current = transaction;
            finishEntryRestoreTransaction(transaction);
            return;
        }

        let issued = false;
        let targetOffsetY: number | null = null;
        let targetOffsetYWasClamped = false;
        let webAnchorConfirmedAtIssue = false;
        if (target.kind === 'anchor') {
            if (Platform.OS === 'web') {
                webAnchorConfirmedAtIssue = issueWebEntryRestoreAnchorWrite(anchor);
                issued = webAnchorConfirmedAtIssue || issueEntryRestoreAnchorWrite(target.index, target.viewOffset);
            } else {
                issued = issueEntryRestoreAnchorWrite(target.index, target.viewOffset);
            }
        } else if (target.kind === 'distance-oneshot') {
            const maxOffsetY = Math.max(0, Math.trunc(contentHeight - layoutHeight));
            targetOffsetY = target.targetOffsetY;
            targetOffsetYWasClamped = maxOffsetY < distanceFromBottom;
            issued = issueEntryRestoreDistanceWrite(distanceFromBottom, contentHeight);
        } else {
            // 'bottom' cannot occur for restore entries (shouldFollowBottom === false), but the
            // resolver type carries it; route it through the seam for completeness.
            issued = executeViewportCommand(resolveViewportCommand({
                type: 'first-paint',
                sessionId: props.sessionId,
                shouldFollowBottom: true,
                entrySnapshot: null,
                jumpToSeq: null,
                platform: telemetryPlatform,
                listImplementation: telemetryListImplementation,
            }));
        }
        if (!issued) {
            // No write landed (list ref/metrics not ready): retry on the next layout pass —
            // the transaction only exists once its initial write is real.
            recordRestoreDecisionTelemetry('not-ready', {
                mode: target.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
            });
            return;
        }

        const transaction = createEntryRestoreTransaction({
            sessionId: props.sessionId,
            target,
            nowMs,
            deadlineMs,
        });
        entryRestoreTransactionRef.current = transaction;
        entryRestoreWriteContextRef.current = {
            anchor: target.kind === 'anchor' ? anchor : null,
            createdAtMs: nowMs,
            distanceFromBottom,
            issuedContentHeight: contentHeight,
            issuedLayoutHeight: layoutHeight,
            kind: target.kind === 'anchor' ? 'anchor' : target.kind === 'bottom' ? 'bottom' : 'distance',
            sessionId: props.sessionId,
            targetOffsetY,
            targetOffsetYWasClamped,
        };
        armEntryRestoreDeadline(transaction, deadlineMs);
        if (Platform.OS !== 'web') {
            updateNativeInitialViewportPendingObservation(true);
        }
        recordRestoreDecisionTelemetry(
            target.kind === 'distance-oneshot' ? 'entry-distance-oneshot' : 'pending',
            {
                mode: target.kind === 'anchor' ? 'restore-anchor' : 'restore-distance',
                offsetY: distanceFromBottom,
                contentHeight,
                layoutHeight,
                anchorIndex: target.kind === 'anchor' ? target.index : undefined,
                anchorRestoreViewOffset: target.kind === 'anchor' ? target.viewOffset : undefined,
            },
        );
        if (webAnchorConfirmedAtIssue) {
            // The helper read the anchor position and routed the exact target through the
            // command seam; that read-back is the conclusive aligned observation.
            transaction.onObservation({ status: 'aligned' }, nowMs);
            finishEntryRestoreTransaction(transaction);
            return;
        }
        if (Platform.OS === 'web' && initialFillStatusRef.current === 'done') {
            verifyWebEntryRestoreTransaction();
        }
    }, [
        armEntryRestoreDeadline,
        attemptLegacyEntryDistanceRestore,
        canRequestBoundedEntryViewportMaterialization,
        closeEntryViewportOwnership,
        executeViewportCommand,
        finishEntryRestoreTransaction,
        issueEntryRestoreAnchorWrite,
        issueEntryRestoreDistanceWrite,
        issueWebEntryRestoreAnchorWrite,
        listImplementation,
        props.jumpToSeq,
        props.sessionId,
        recordRestoreDecisionTelemetry,
        requestBoundedEntryViewportMaterialization,
        resolveEntryRestoreCanonicalMetrics,
        resolveEntryRestoreDeadlineMs,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveSeqForMessageId,
        resolveViewportCommand,
        telemetryListImplementation,
        telemetryPlatform,
        updateNativeInitialViewportPendingObservation,
        verifyWebEntryRestoreTransaction,
    ]);
    attemptEntryRestoreRef.current = attemptEntryRestore;

    React.useLayoutEffect(() => {
        attemptEntryRestore();
        if (Platform.OS === 'web') {
            verifyWebEntryRestoreTransaction();
        } else {
            verifyNativeSliceEntryRestoreTransaction();
        }
    }, [attemptEntryRestore, listContentHeight, listData.length, listImplementation, listLayoutHeight, props.sessionId, verifyNativeSliceEntryRestoreTransaction, verifyWebEntryRestoreTransaction]);

    const captureWebBottomFollowPreviousMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        return {
            ...metrics,
            clientHeight: listLayoutHeightRef.current > 0 ? listLayoutHeightRef.current : metrics.clientHeight,
            scrollHeight: listContentHeightRef.current > 0 ? listContentHeightRef.current : metrics.scrollHeight,
        };
    }, [listImplementation, resolveWebScrollMetrics]);

    // Native analog of captureWebBottomFollowPreviousMetrics (carve only). Snapshots "the user was
    // following the live tail at the inverted bottom" BEFORE a data/layout change, using the
    // bottom-follow MODE (the reliable persisted signal) rather than the post-change distance, which
    // FlashList MVCP offset-correction corrupts on the hot→cold (index-0) insert. Returns false when
    // the carve is OFF (nativeHotTailHeightRef === 0), so flag=0 behavior is byte-for-byte unchanged.
    const captureNativeBottomFollowPreviousFollow = React.useCallback((): boolean => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return false;
        if (nativeHotTailHeightRef.current <= 0) return false;
        if (!wantsPinnedRef.current) return false;
        if (bottomFollowModeStateRef.current.mode !== 'following') return false;
        if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
        return true;
    }, [usesNativeFlashListBottomMaintenance]);

    const applyWebBottomFollowAdjustment = React.useCallback((
        previousMetrics: WebTranscriptScrollMetrics,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        const nextMetrics = resolveWebScrollMetrics();
        if (!nextMetrics) return false;
        const targetScrollTop = resolveWebBottomFollowAdjustment({
            mode: wantsPinnedRef.current ? 'following' : 'released',
            previousMetrics,
            nextMetrics,
            tolerancePx: pinThresholdPx,
            recentUserIntent: Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
        });
        if (targetScrollTop === null) return false;
            return executeViewportCommand(resolveViewportCommand({
                type: 'auto-follow',
                sessionId: props.sessionId,
                distanceFromBottom: Number.MAX_SAFE_INTEGER,
                pinThresholdPx,
                recentUserIntent: false,
                wantsPinned: wantsPinnedRef.current,
                reason,
                targetOffsetY: targetScrollTop,
            }));
        }, [
            executeViewportCommand,
            listImplementation,
            pinThresholdPx,
            props.sessionId,
            resolveViewportCommand,
            resolveWebScrollMetrics,
        ]);

    const pinNativeFlashListToBottomIfMeasured = React.useCallback((options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        telemetryReason?: TranscriptViewportTelemetryScrollReason;
        /**
         * Native carve only: the pre-change "was following the live tail" decision (captured before
         * the data/layout change). When true the inverted bottom command is issued authoritatively,
         * bypassing the post-change distance gate that FlashList MVCP offset-correction corrupts on
         * the hot→cold (index-0) insert. Mirrors web's applyWebBottomFollowAdjustment writing the
         * absolute bottom regardless of the (re-anchored) intermediate offset.
         */
        forceFollowPin?: boolean;
    }): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        const telemetryReason = options?.telemetryReason ?? 'content-size-change';
        const isExplicitNativeCommand =
            telemetryReason === 'jump-to-bottom' ||
            telemetryReason === 'jump-to-seq';
        if (props.jumpToSeq != null && telemetryReason !== 'jump-to-seq') return false;
        if (
            !canAutoFollowForReason(telemetryReason, { explicit: isExplicitNativeCommand })
        ) return false;
        if (
            !isExplicitNativeCommand &&
            !hasRearmedNativeBottomFollow() &&
            Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
        ) return false;
        const shouldSkipAutomaticNativeJsPin =
            !isExplicitNativeCommand &&
            (
                telemetryReason === 'stream-append' ||
                listOrientationRef.current === 'inverted'
            );
        if (
            !shouldSkipAutomaticNativeJsPin &&
            !isExplicitNativeCommand &&
            !(options?.force === true && telemetryReason === 'mount-settle') &&
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) {
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }

        const layoutHeight = listLayoutHeightRef.current;
        const contentHeight = listContentHeightRef.current;
        if (!hasNativeContentMeasurementForCurrentSession()) return false;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return false;
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) return false;

        const offset = Math.max(0, Math.trunc(contentHeight - layoutHeight));
        // Inverted cold opens establish the visual bottom at first paint via
        // startRenderingFromBottom. The JS pin writes nothing on inverted
        // (shouldSkipAutomaticNativeJsPin), so the "initial bottom viewport applied" condition is
        // satisfied the moment the viewport is measured — there is no later offset-at-bottom
        // observation to wait for. Treating inverted like an already-at-bottom (offset <= 0) entry
        // closes the entry viewport transaction at first paint, which arms the MVCP threshold (the
        // only inverted bottom-pin authority) and breaks the cold-open follow-bottom deadlock.
        const invertedFirstPaintEstablishesBottom =
            shouldSkipAutomaticNativeJsPin && listOrientationRef.current === 'inverted';
        // Inverted follow-bottom bottom-reach + maintenance (device-proven on session
        // cmqbym9nh0m1ztmwgdjd8rsqw: shouldFollowBottom=true yet the list opened ~17000px from the
        // bottom). On an inverted FlashList, scrollToOffset({offset: 0}) is a no-op and MVCP's
        // autoscrollToBottomThreshold only MAINTAINS a bottom you already reached — neither TRAVELS to
        // the newest row. So inverted bottom-follow is owned by an explicit pin-bottom command, whose
        // perform now commands scrollToIndex(0) on inverted. Re-issue it on every automatic
        // content/layout pin while in `following` mode: the list reaches the bottom as the cold-open
        // content settles AND stays pinned as new content streams in. The user-intent delay guard
        // above plus the `following` mode check keep it from fighting a deliberate scroll-up.
        const invertedFollowBottomNeedsExplicitPin =
            invertedFirstPaintEstablishesBottom &&
            wantsPinnedRef.current &&
            bottomFollowModeStateRef.current.mode === 'following';
        if (invertedFollowBottomNeedsExplicitPin) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                pendingNativeMountSettleBottomPinRef.current = false;
                markNativeInitialViewportAppliedForCurrentSession();
            }
            // Only command the bottom when the viewport is measurably OFF it. When already pinned at the
            // inverted visual bottom the native list holds position, so no write is issued — keeping
            // steady-state streaming write-free and only re-pinning when content growth (or a stale
            // cold-open layout) has pushed the viewport away from the newest row.
            const distanceFromInvertedBottom = readCurrentNativeDistanceFromBottom();
            // Carve auto-follow: when the pre-change state was "following the live tail" (captured
            // before MVCP could re-anchor the hot→cold index-0 insert), re-issue the inverted bottom
            // command authoritatively — the post-change distance is unreliable here (MVCP races it).
            // Otherwise keep the steady-state write-free gate (only pin when measurably off-bottom).
            const willFireInvertedPin =
                options?.forceFollowPin === true ||
                (distanceFromInvertedBottom != null && distanceFromInvertedBottom > pinThresholdPx);
            if (willFireInvertedPin) {
                executeViewportCommand(resolveViewportCommand({
                    type: 'pin-bottom',
                    sessionId: props.sessionId,
                    reason: telemetryReason,
                    mode: 'follow-bottom',
                    animated: false,
                }));
            }
            return true;
        }
        const shouldDeferInitialViewportAppliedUntilObserved =
            options?.markInitialViewportApplied === 'when-scrollable';
        const shouldMarkInitialViewportApplied =
            !shouldDeferInitialViewportAppliedUntilObserved;
        const shouldRetryUnobservedNativeBottomPin =
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            nativeMountSettleStable;
        const shouldSkipUnstableAutomaticRetryUntilObserved =
            !shouldSkipAutomaticNativeJsPin &&
            !isExplicitNativeCommand &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            telemetryReason === 'initial-open';
        const shouldSkipLateInitialOpenAfterAutomaticNativePin =
            !shouldSkipAutomaticNativeJsPin &&
            !isExplicitNativeCommand &&
            telemetryReason === 'initial-open' &&
            nativeAutomaticBottomPinCommandSessionRef.current === props.sessionId;
        const shouldSkipDefaultNativeMaterializationPin =
            !shouldSkipAutomaticNativeJsPin &&
            !isExplicitNativeCommand &&
            !(
                telemetryReason === 'content-size-change' &&
                nativeContentMaterializationAutoPinRef.current?.sessionId === props.sessionId &&
                nativeContentMaterializationAutoPinRef.current.contentHeight === contentHeight
            ) &&
            (
                telemetryReason === 'initial-open' ||
                telemetryReason === 'layout-change' ||
                telemetryReason === 'content-size-change'
            );
        const shouldSkipDuplicateAutomaticRetryUntilObserved =
            !shouldSkipAutomaticNativeJsPin &&
            !isExplicitNativeCommand &&
            !(options?.force === true && telemetryReason === 'mount-settle') &&
            offset > 0 &&
            pendingNativeMountSettleBottomPinRef.current &&
            lastNativePinOffsetRef.current != null &&
            (
                lastNativePinOffsetRef.current === offset ||
                telemetryReason === 'initial-open'
            );
        if (
            shouldSkipDefaultNativeMaterializationPin ||
            shouldSkipUnstableAutomaticRetryUntilObserved ||
            shouldSkipLateInitialOpenAfterAutomaticNativePin ||
            shouldSkipDuplicateAutomaticRetryUntilObserved
        ) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            options?.force !== true &&
            lastNativePinOffsetRef.current === offset &&
            !shouldRetryUnobservedNativeBottomPin
        ) {
            if (shouldMarkInitialViewportApplied) {
                markNativeInitialViewportAppliedForCurrentSession();
            }
            if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return true;
        }
        if (
            options?.force === true &&
            telemetryReason === 'mount-settle' &&
            pendingNativeMountSettleBottomPinRef.current &&
            !hasNativeInitialViewportAppliedForCurrentSession() &&
            lastNativePinOffsetRef.current === offset
        ) {
            // One idempotent settle pin per mount window (plan B4): a same-offset
            // mount-settle wake never re-issues the write.
            if (shouldDeferInitialViewportAppliedUntilObserved && offset > 0) {
                updateNativeInitialViewportPendingObservation(true);
            }
            return true;
        }

        const streamAppendAlreadyOwnsContentVersion =
            lastNativeStreamAppendPinRef.current?.sessionId === props.sessionId &&
            lastNativeStreamAppendPinRef.current.contentHeight === contentHeight;
        if (shouldSkipAutomaticNativeJsPin && streamAppendAlreadyOwnsContentVersion) {
            // Invariant F: never two follow commands for the same content version.
            return true;
        }
        if (
            !isExplicitNativeCommand &&
            telemetryReason === 'mount-settle' &&
            streamAppendAlreadyOwnsContentVersion
        ) {
            // The current content version was already claimed by the stream-append
            // MVCP-only owner. Mount settle must not add a JS scroll write for the
            // same height or it recreates a second competing bottom-follow writer.
            if (shouldMarkInitialViewportApplied) {
                pendingNativeMountSettleBottomPinRef.current = false;
                markNativeInitialViewportAppliedForCurrentSession();
            }
            return true;
        }
        if (!executeViewportCommand(resolveViewportCommand({
            type: 'auto-follow',
            sessionId: props.sessionId,
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx,
            recentUserIntent: false,
            wantsPinned: wantsPinnedRef.current,
            reason: telemetryReason,
            targetOffsetY: offset,
            skipNativeJsPin: shouldSkipAutomaticNativeJsPin,
        }))) {
            return false;
        }
        if (shouldSkipAutomaticNativeJsPin && telemetryReason === 'stream-append') {
            lastNativeStreamAppendPinRef.current = {
                contentHeight,
                sessionId: props.sessionId,
            };
        }
        if (!shouldSkipAutomaticNativeJsPin) {
            lastNativePinOffsetRef.current = offset;
        }
        if (!isExplicitNativeCommand && !shouldSkipAutomaticNativeJsPin) {
            lastNativeBottomFollowPinCommandRef.current = {
                sessionId: props.sessionId,
                offsetY: offset,
                writtenAtMs: Date.now(),
            };
        }
        if (!isExplicitNativeCommand && !shouldSkipAutomaticNativeJsPin) {
            nativeAutomaticBottomPinCommandSessionRef.current = props.sessionId;
        }
        if (telemetryReason === 'content-size-change') {
            nativeContentMaterializationAutoPinRef.current = null;
        }
        if (
            shouldMarkInitialViewportApplied ||
            (shouldDeferInitialViewportAppliedUntilObserved &&
                (offset <= 0 || invertedFirstPaintEstablishesBottom))
        ) {
            pendingNativeMountSettleBottomPinRef.current = false;
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (
            shouldDeferInitialViewportAppliedUntilObserved &&
            offset > 0 &&
            !invertedFirstPaintEstablishesBottom
        ) {
            pendingNativeMountSettleBottomPinRef.current = true;
            updateNativeInitialViewportPendingObservation(true);
        }
        return true;
    }, [
        executeViewportCommand,
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleStable,
        props.jumpToSeq,
        props.sessionId,
        pinThresholdPx,
        resolveViewportCommand,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinNativeInitialFollowBottomViewportIfReady = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        if (props.jumpToSeq != null) return false;
        if (!canAutoFollowForReason(reason)) return false;
        if (hasNativeInitialViewportAppliedForCurrentSession()) return false;
        if (
            !hasRearmedNativeBottomFollow() &&
            Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
        ) return false;
        if (
            reason === 'initial-open' &&
            (
                pendingNativeMountSettleBottomPinRef.current ||
                lastNativePinOffsetRef.current != null
            )
        ) {
            return true;
        }
        return pinNativeFlashListToBottomIfMeasured({
            force: true,
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: reason,
        });
    }, [
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        props.jumpToSeq,
        usesNativeFlashListBottomMaintenance,
    ]);

    const shouldKeepPendingNativeMountSettleBottomPin = React.useCallback((): boolean => {
        if (!usesNativeFlashListBottomMaintenance) return false;
        if (props.jumpToSeq != null) return false;
        if (!canAutoFollowForReason('mount-settle')) return false;
        return hasRearmedNativeBottomFollow() ||
            Date.now() - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS;
    }, [canAutoFollowForReason, hasRearmedNativeBottomFollow, props.jumpToSeq, usesNativeFlashListBottomMaintenance]);

    const pinToBottom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open') => {
        if (Platform.OS === 'web') {
            // Prefer DOM scroll writes on web: RNW list refs can apply delayed `scrollToOffset` that
            // fights against our pinning and results in visible drift/jitter.
            if (tryPinToBottomDom(reason)) {
                return;
            }
            // If we cannot reliably locate a DOM scroll container yet, avoid falling back to the
            // list ref scroll APIs on web. Early `scrollToOffset({ offset: 0 })` calls can create
            // visible "scroll to top" jitter during mount while the real scroll container is still
            // being attached/measured.
            return;
        }
        if (usesNativeFlashListBottomMaintenance) {
            const isExplicitNativeCommand = reason === 'jump-to-bottom' || reason === 'jump-to-seq';
            if (isExplicitNativeCommand) {
                pendingNativeMountSettleBottomPinRef.current = false;
            }
            pinNativeFlashListToBottomIfMeasured({
                force: isExplicitNativeCommand,
                telemetryReason: reason,
            });
            return;
        }
        executeViewportCommand(resolveViewportCommand(reason === 'jump-to-bottom'
            ? {
                type: 'jump-to-bottom',
                sessionId: props.sessionId,
            }
            : {
                type: 'pin-bottom',
                sessionId: props.sessionId,
                reason,
                mode: reason === 'jump-to-seq' ? 'jump-to-seq' : 'follow-bottom',
                animated: false,
            }));
    }, [
        executeViewportCommand,
        listImplementation,
        pinNativeFlashListToBottomIfMeasured,
        props.sessionId,
        resolveViewportCommand,
        resolveViewportTelemetryMode,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const pinToBottomRespectingNativeMountSettle = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'mount-settle',
        forceFollowPin: boolean = false,
    ) => {
        if (usesNativeFlashListBottomMaintenance) {
            if (pinNativeInitialFollowBottomViewportIfReady(reason)) {
                return;
            }
            if (reason === 'initial-open') {
                return;
            }
            if (pinNativeFlashListToBottomIfMeasured({ telemetryReason: reason, forceFollowPin })) {
                if (hasNativeInitialViewportAppliedForCurrentSession()) {
                    pendingNativeMountSettleBottomPinRef.current = false;
                }
                return;
            }
            if (shouldKeepPendingNativeMountSettleBottomPin()) {
                pendingNativeMountSettleBottomPinRef.current = true;
            }
            return;
        }
        pinToBottom(reason);
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeInitialFollowBottomViewportIfReady,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        if (!pendingNativeMountSettleBottomPinRef.current && !nativeMountSettleDeadlineReachedRef.current) return;
        if (!shouldKeepPendingNativeMountSettleBottomPin()) {
            pendingNativeMountSettleBottomPinRef.current = false;
            return;
        }
        if (
            mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
            !nativeMountSettleDeadlineReachedRef.current
        ) return;
        if (pinNativeFlashListToBottomIfMeasured({
            markInitialViewportApplied: 'when-scrollable',
            telemetryReason: 'mount-settle',
        })) {
            if (!hasNativeInitialViewportAppliedForCurrentSession()) {
                return;
            }
            pendingNativeMountSettleBottomPinRef.current = false;
        }
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        shouldKeepPendingNativeMountSettleBottomPin,
    ]);
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;

    // §12 #2/#3: synchronized live-tail pin. Fired from the edge-slot onLayout (same event that
    // measured the height) so the inverted bottom inset compensates for the EXACT rendered hot-tail
    // height. While the carve owns the bottom (#3) the MVCP threshold is withheld, so this
    // authoritative JS force-pin is the sole bottom owner; it only fires while the reader is still
    // following (captured before the change), so a scrolled-up reader is never yanked.
    const pinNativeLiveTailForHotTailHeight = React.useCallback((height: number) => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return;
        if (listOrientationRef.current !== 'inverted') return;
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return;
        const wasFollowing = captureNativeBottomFollowPreviousFollow();
        if (!wasFollowing) {
            // Reader scrolled up (escaped/released): record the skip so device QA can PROVE the
            // growing live row did not yank the reader, then leave the viewport untouched.
            recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: resolveViewportTelemetryMode(),
                reason: 'skipped',
                nativeHotTailHeightPx: height,
                liveRegionActive: true,
                nativeCarvePinIssued: false,
                liveTailAnchorId: carve.anchorId ?? undefined,
                liveTailAnchorKind: carve.anchorKind ?? undefined,
                coldCount: carve.coldCount,
                hotCount: carve.hotCount,
            });
            return;
        }
        // Authoritative inverted bottom pin: bypasses the post-change distance gate MVCP corrupts on
        // the hot→cold index-0 insert (forceFollowPin), reading the just-committed hot-tail height.
        pinNativeFlashListToBottomIfMeasured({ telemetryReason: 'stream-append', forceFollowPin: true });
    }, [
        captureNativeBottomFollowPreviousFollow,
        pinNativeFlashListToBottomIfMeasured,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        usesNativeFlashListBottomMaintenance,
    ]);
    pinNativeLiveTailForHotTailHeightRef.current = pinNativeLiveTailForHotTailHeight;

    React.useEffect(() => {
        if (!nativeMountSettleStable) return;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, nativeMountSettleStable]);

    React.useEffect(() => {
        if (!nativeMountSettleDeadlineReached) return;
        if (nativeMountSettleAutoPinSuppressedRef.current) return;
        if (hasNativeInitialViewportAppliedForCurrentSession()) return;
        pendingNativeMountSettleBottomPinRef.current = true;
        flushPendingNativeMountSettleBottomPin();
    }, [flushPendingNativeMountSettleBottomPin, hasNativeInitialViewportAppliedForCurrentSession, nativeMountSettleDeadlineReached]);

    const deferPinToBottomAfterScroll = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
    ) => {
        fireAndForget(Promise.resolve().then(() => {
            if (usesNativeFlashListBottomMaintenance) {
                pinNativeFlashListToBottomIfMeasured({
                    force: true,
                    markInitialViewportApplied: pendingNativeMountSettleBottomPinRef.current || !hasNativeInitialViewportAppliedForCurrentSession()
                        ? 'when-scrollable'
                        : undefined,
                    telemetryReason: reason,
                });
                return;
            }
            pinToBottom(reason);
        }), { tag: 'ChatList.deferPinToBottomAfterScroll' });
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const jumpToBottom = React.useCallback(() => {
        // Plan B7: an explicit jump preempts and closes BOTH restore transactions BEFORE
        // the write is issued, so no restore decision can fire after the jump.
        preemptEntryRestoreTransaction();
        const prependTransaction = nativePrependTransactionRef.current;
        if (prependTransaction && !prependTransaction.isClosed()) {
            prependTransaction.onTrustedUserScroll();
            finishNativePrependTransaction(prependTransaction);
        }
        if (Platform.OS === 'web') {
            if (tryPinToBottomDom('jump-to-bottom')) {
                viewportAnchorCaptureGenerationRef.current += 1;
                cancelScheduledViewportAnchorCapture();
                isPinnedRef.current = true;
                wantsPinnedRef.current = true;
                commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
                    type: 'jump-to-bottom',
                }));
                commitScrollPinState({ ...scrollPinRef.current, isPinned: true, newActivityCount: 0 });
                emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
                return;
            }
        }
        if (usesNativeFlashListBottomMaintenance) {
            // Arm the single bounded re-confirm (plan B7): if the content height churns
            // before the bottom is observed, ONE more explicit write lands the jump.
            pendingNativeExplicitJumpConfirmRef.current = {
                sessionId: props.sessionId,
                issuedContentHeight: listContentHeightRef.current,
            };
        }
        const command = resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId: props.sessionId,
        });
        if (!executeViewportCommand(withTranscriptViewportCommandAnimation(command, jumpAnimateScroll))) {
            pinToBottom('jump-to-bottom');
        }
        isPinnedRef.current = true;
        wantsPinnedRef.current = true;
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'jump-to-bottom',
        }));
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        commitScrollPinState({ ...scrollPinRef.current, isPinned: true, newActivityCount: 0 });
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        if (Platform.OS === 'web') {
            tryPinToBottomDom('jump-to-bottom');
        }
    }, [
        cancelScheduledViewportAnchorCapture,
        commitBottomFollowModeState,
        commitScrollPinState,
        finishNativePrependTransaction,
        preemptEntryRestoreTransaction,
            emitViewportChange,
            executeViewportCommand,
            jumpAnimateScroll,
            pinToBottom,
            props.sessionId,
            resolveViewportCommand,
            tryPinToBottomDom,
            usesNativeFlashListBottomMaintenance,
        ]);

    const jumpToTop = React.useCallback(() => {
        preemptEntryRestoreTransaction();
        const prependTransaction = nativePrependTransactionRef.current;
        if (prependTransaction && !prependTransaction.isClosed()) {
            prependTransaction.onTrustedUserScroll();
            finishNativePrependTransaction(prependTransaction);
        }
        const command = resolveViewportCommand({
            type: 'jump-to-top',
            sessionId: props.sessionId,
        });
        const executed = executeViewportCommand(withTranscriptViewportCommandAnimation(command, jumpAnimateScroll));
        if (!executed && Platform.OS === 'web') {
            const metrics = resolveWebScrollMetrics();
            if (metrics) {
                metrics.element.scrollTop = 0;
                lastObservedWebScrollTopRef.current = metrics.element.scrollTop;
            }
        }
        wantsPinnedRef.current = false;
        isPinnedRef.current = false;
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'jump-to-top',
        }));
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        commitJumpToTopOffsetForVisibility(0);
        const metrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
        const distanceFromBottom = metrics
            ? getWebTranscriptDistanceFromBottom(metrics)
            : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
        commitJumpToBottomDistanceForVisibility(distanceFromBottom);
        commitScrollPinState({ ...scrollPinRef.current, isPinned: false });
        emitViewportChange({ isPinned: false, offsetY: distanceFromBottom, shouldRestoreViewport: true });
    }, [
        cancelScheduledViewportAnchorCapture,
        commitBottomFollowModeState,
        commitJumpToBottomDistanceForVisibility,
        commitJumpToTopOffsetForVisibility,
        commitScrollPinState,
        emitViewportChange,
        executeViewportCommand,
        finishNativePrependTransaction,
        jumpAnimateScroll,
        preemptEntryRestoreTransaction,
        props.sessionId,
        resolveViewportCommand,
        resolveWebScrollMetrics,
    ]);

    React.useLayoutEffect(() => {
        const followBottomIntentKey = props.followBottomIntentKey ?? null;
        if (followBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === followBottomIntentKey) return;

        lastFollowBottomIntentKeyRef.current = followBottomIntentKey;
        wantsPinnedRef.current = true;
        isPinnedRef.current = true;
        commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
            type: 'follow-bottom-intent',
        }));
        viewportAnchorCaptureGenerationRef.current += 1;
        cancelScheduledViewportAnchorCapture();
        preemptEntryRestoreTransaction();
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        lastPinOffsetForIntentRef.current = 0;
        commitScrollPinState({ ...scrollPinRef.current, isPinned: true, newActivityCount: 0 });
        emitViewportChange({ isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        pinToBottom('jump-to-bottom');
    }, [
        cancelScheduledViewportAnchorCapture,
        commitBottomFollowModeState,
        commitScrollPinState,
        emitViewportChange,
        pinToBottom,
        preemptEntryRestoreTransaction,
        props.followBottomIntentKey,
    ]);

    const resolveAutoPinWaitMs = React.useCallback((reason: TranscriptViewportTelemetryScrollReason): number | null => {
        if (!canAutoFollowForReason(reason)) return null;
        if (hasRearmedNativeBottomFollow()) {
            return 0;
        }
        const elapsedSinceUserIntentMs = Date.now() - lastUserScrollIntentAtMsRef.current;
        if (elapsedSinceUserIntentMs >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return 0;
        return Math.max(0, TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS - elapsedSinceUserIntentMs);
    }, [canAutoFollowForReason, hasRearmedNativeBottomFollow]);

    const schedulePinToBottom = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        nativePrevFollowAtBottom: boolean = false,
    ) => {
        if (listImplementation !== 'flash_v2') return;
        const waitMs = resolveAutoPinWaitMs(reason);
        if (waitMs === null) return;
        if (scheduledPinRef.current) {
            const scheduled = scheduledPinRef.current;
            const shouldSupersedeStaleNativePin =
                Platform.OS !== 'web' &&
                usesNativeFlashListBottomMaintenance &&
                reason === 'stream-append' &&
                scheduled.reason !== 'stream-append';
            if (!shouldSupersedeStaleNativePin) return;
            cancelScheduledPinToBottom();
        }

        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (waitMs === 0 && typeof raf === 'function') {
            const handle: ScheduledPinToBottom = { kind: 'raf', id: 0, previousWebMetrics, reason, nativePrevFollowAtBottom };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                if (scheduledPinRef.current !== handle) return;
                scheduledPinRef.current = null;
                if (resolveAutoPinWaitMs(reason) !== 0) return;
                if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, reason)) return;
                if (usesNativeFlashListBottomMaintenance) {
                    pinToBottomRespectingNativeMountSettle(reason, handle.nativePrevFollowAtBottom === true);
                    return;
                }
                pinToBottom(reason);
            });
            return;
        }

        const handle: ScheduledPinToBottom = { kind: 'timeout', id: null, previousWebMetrics, reason, nativePrevFollowAtBottom };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            if (scheduledPinRef.current !== handle) return;
            scheduledPinRef.current = null;
            if (resolveAutoPinWaitMs(reason) !== 0) return;
            if (handle.previousWebMetrics && applyWebBottomFollowAdjustment(handle.previousWebMetrics, reason)) return;
            if (usesNativeFlashListBottomMaintenance) {
                pinToBottomRespectingNativeMountSettle(reason, handle.nativePrevFollowAtBottom === true);
                return;
            }
            pinToBottom(reason);
        }, waitMs);
    }, [
        applyWebBottomFollowAdjustment,
        cancelScheduledPinToBottom,
        listImplementation,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        resolveAutoPinWaitMs,
        usesNativeFlashListBottomMaintenance,
    ]);

    const updateNativeBottomFollowModeFromScrollObservation = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        isTrusted: boolean;
        movedAwayFromBottom: boolean;
        movedTowardBottom: boolean;
        recentUserIntent: boolean;
    }>) => {
        if (Platform.OS === 'web') return;
        if (params.movedAwayFromBottom && params.recentUserIntent) {
            commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
                distanceFromBottom: params.distanceFromBottom,
                movedAwayFromBottom: true,
                pinThresholdPx,
                type: 'trusted-away-observation',
            }));
            return;
        }
        if (params.isTrusted && params.movedTowardBottom) {
            commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
                distanceFromBottom: params.distanceFromBottom,
                movedTowardBottom: true,
                pinThresholdPx,
                type: 'trusted-bottom-observation',
            }));
            return;
        }
        if (!params.isTrusted && params.distanceFromBottom <= pinThresholdPx) {
            commitBottomFollowModeState(resolveTranscriptBottomFollowMode(bottomFollowModeStateRef.current, {
                distanceFromBottom: params.distanceFromBottom,
                pinThresholdPx,
                type: 'passive-bottom-observation',
            }));
        }
    }, [commitBottomFollowModeState, pinThresholdPx]);

    const handleComposerInsetHeightChange = React.useCallback((height: number) => {
        const nextHeight = typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        const previousHeight = composerInsetHeightRef.current;
        if (previousHeight === nextHeight) return;
        composerInsetHeightRef.current = nextHeight;
        setComposerInsetHeight(nextHeight);
        observeMountSettleMetrics();

        if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
            const delta = nextHeight - previousHeight;
            if (delta !== 0 && listContentHeightRef.current > 0) {
                const nextContentHeight = Math.max(0, listContentHeightRef.current + delta);
                listContentHeightRef.current = nextContentHeight;
                if (shouldCommitContentHeightState()) {
                    setListContentHeight(nextContentHeight);
                }
            }
        }

        schedulePinToBottom(null, 'layout-change');
    }, [listImplementation, observeMountSettleMetrics, schedulePinToBottom, shouldCommitContentHeightState]);

    const resolveMeasuredContentHeight = React.useCallback((height: number): number => {
        const normalizedHeight = Math.max(0, Math.trunc(height));
        if (Platform.OS === 'web' || listImplementation !== 'flash_v2') {
            return normalizedHeight;
        }
        return normalizedHeight + composerInsetHeightRef.current;
    }, [listImplementation]);

    const listFooterNode = React.useMemo(() => (
        <>
            {webPrependRangeReservePx > 0 ? (
                <View
                    pointerEvents="none"
                    testID="transcript-web-prepend-range-reserve"
                    style={{ height: webPrependRangeReservePx }}
                />
            ) : null}
            <ChatListFooterWithKeyboardInset
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                directControl={props.directControlFooter}
                onComposerInsetHeightChange={handleComposerInsetHeightChange}
            />
        </>
    ), [
        handleComposerInsetHeightChange,
        props.bottomNotice,
        props.controlSwitchTo,
        props.controlledByUserOverride,
        props.directControlFooter,
        props.onRequestSwitchToRemote,
        props.sessionId,
        webPrependRangeReservePx,
    ]);
    const handleNativeHotTailHeightChange = React.useCallback((height: number) => {
        const normalizedHeight =
            typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        if (nativeHotTailHeightRef.current === normalizedHeight) return;
        // §12 #2: the edge-slot re-measured (the live row grew a token). Commit the fresh height and
        // pin in the SAME event so the inverted bottom inset (composerInset + hot-tail height) is read
        // from this exact measurement — never the stale async ref a separate onContentSizeChange→rAF
        // pin would read (the device-proven under-compensation / overlap race).
        nativeHotTailHeightRef.current = normalizedHeight;
        pinNativeLiveTailForHotTailHeightRef.current?.(normalizedHeight);
    }, []);
    const flashListFooterNode = React.useMemo(() => {
        if (shouldUseWebHotColdSplit) {
            return (
                <WebTranscriptSplitFooter
                    hotItems={transcriptHotColdSegments.hotItems}
                    startIndex={transcriptHotColdSegments.coldItems.length}
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                />
            );
        }
        if (shouldUseNativeHotColdSplit) {
            // The visual-bottom edge slot (inverted ListHeaderComponent) is rendered OUTSIDE the
            // recycler, so the live-tail row flows in real layout and cannot be positioned from a
            // stale committed height. The slot's nested scaleY(-1) transforms compose to a pure
            // TRANSLATION that preserves child DOM stacking order, so we feed the CANONICAL
            // (oldest-first) hot slice and render it top→bottom: the newest row lands at the visual
            // bottom (just above the composer) and a multi-row hot tail (reasoning + tool rows +
            // answer) reads in correct chronological order. Each row's DISPLAY index counts DOWN
            // from `hotCount - 1` (its index in the newest-first displayItems), so the host
            // older-neighbor lookup + tool-stack tightening resolve the identical displayItems
            // entry as the pre-carve render. The hot rows reuse the cold renderItem.
            return (
                <TranscriptHotTail
                    hotItems={transcriptHotColdSegments.hotItemsCanonical}
                    startIndex={Math.max(0, transcriptHotColdSegments.hotCount - 1)}
                    displayIndexMode="invertedEdgeSlot"
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                    testIDPrefix="transcript-native-hot-tail"
                    onHeightChange={handleNativeHotTailHeightChange}
                />
            );
        }
        return listFooterNode;
    }, [
        handleNativeHotTailHeightChange,
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotCount,
        transcriptHotColdSegments.hotItems,
        transcriptHotColdSegments.hotItemsCanonical,
    ]);
    // N3.2: in an inverted FlashList the header slot renders at the data start =
    // VISUAL BOTTOM, so the visual-top/visual-bottom nodes swap slots there.
    const orientedFlashListEdgeSlots = React.useMemo(() => resolveOrientedListEdgeSlots({
        orientation: listOrientation,
        visualTopNode: listHeaderNode,
        visualBottomNode: flashListFooterNode,
    }), [flashListFooterNode, listHeaderNode, listOrientation]);

    React.useEffect(() => {
        return () => {
            const scheduled = scheduledPinRef.current;
            if (!scheduled) return;
            scheduledPinRef.current = null;
            if (scheduled.kind === 'raf') {
                const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
                if (typeof caf === 'function') {
                    caf(scheduled.id);
                }
            } else {
                clearTimeout(scheduled.id);
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        // When pinned, proactively keep the list at the visual bottom as new activity arrives.
        // This complements `maintainVisibleContentPosition`, especially on platforms where
        // inverted list anchoring can be inconsistent.
        const latestActivityKey = props.latestCommittedActivityKey;
        const hasNewCommittedActivity =
            latestActivityKey != null &&
            lastProactiveAutoFollowActivityKeyRef.current !== latestActivityKey;
        if (latestActivityKey == null) {
            lastProactiveAutoFollowActivityKeyRef.current = null;
        }
        if (hasNewCommittedActivity) {
            lastProactiveAutoFollowActivityKeyRef.current = latestActivityKey;
            const nativeOffsetEscapedBottomFollow = releaseNativeBottomFollowIfFlashListOffsetEscaped({
                contentHeight: listContentHeightRef.current,
                layoutHeight: listLayoutHeightRef.current,
            });
            if (
                !nativeOffsetEscapedBottomFollow &&
                isPinnedRef.current &&
                canAutoFollowForReason('stream-append') &&
                !usesNativeFlashListBottomMaintenance
            ) {
                // Native flash stream growth pins exactly once per measured content
                // version from onContentSizeChange (plan B3 single writer).
                pinToBottomRespectingNativeMountSettle('stream-append');
            }
        }
        const nextScrollPin = resolveTranscriptScrollPinStateUpdate(
            { ...scrollPinRef.current, isPinned: isPinnedRef.current },
            {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: props.latestCommittedActivityKey,
            },
        );
        if (nextScrollPin) {
            commitScrollPinState(nextScrollPin);
        }
    }, [
        canAutoFollowForReason,
        commitScrollPinState,
        pinEnabled,
        pinToBottomRespectingNativeMountSettle,
        props.latestCommittedActivityKey,
        releaseNativeBottomFollowIfFlashListOffsetEscaped,
        usesNativeFlashListBottomMaintenance,
    ]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialPinSessionIdRef.current === props.sessionId) return;
        if (sessionEntryViewportRef.current?.shouldFollowBottom === false) {
            initialPinSessionIdRef.current = props.sessionId;
            initialWebPinStabilizingRef.current = false;
            return;
        }

        // Some platforms (especially web) can apply scroll anchoring / restoration
        // during the first render+layout ticks, resulting in the transcript appearing "scrolled up"
        // after a refresh. The web follow-bottom entry runs through the entry-restore transaction
        // (plan A5): one initial pin write, at most one correction, and a stop-condition of
        // confirm-or-deadline instead of the legacy bottom-stability polling.
        initialPinSessionIdRef.current = props.sessionId;
        let cancelled = false;

        const tuning = sync.getSyncTuning();
        const stabilizeMaxMsRaw = tuning.transcriptWebInitialPinStabilizeMs;
        const retryIntervalMsRaw = tuning.transcriptWebInitialPinRetryIntervalMs;
        const stabilizeMaxMs =
            typeof stabilizeMaxMsRaw === 'number' && Number.isFinite(stabilizeMaxMsRaw)
                ? Math.max(0, Math.trunc(stabilizeMaxMsRaw))
                : TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS;
        const retryIntervalMs =
            typeof retryIntervalMsRaw === 'number' && Number.isFinite(retryIntervalMsRaw)
                ? Math.max(16, Math.trunc(retryIntervalMsRaw))
                : TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS;

        const ensureWebEntryBottomTransaction = (): EntryRestoreTransaction | null => {
            const existing = entryRestoreTransactionRef.current;
            if (existing) {
                return existing.sessionId === props.sessionId ? existing : null;
            }
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return null;
            // First write of the web follow-bottom entry.
            pinToBottom('initial-open');
            const nowMs = Date.now();
            const transaction = createEntryRestoreTransaction({
                sessionId: props.sessionId,
                target: { kind: 'bottom' },
                nowMs,
                deadlineMs: stabilizeMaxMs,
            });
            entryRestoreTransactionRef.current = transaction;
            entryRestoreWriteContextRef.current = {
                anchor: null,
                createdAtMs: nowMs,
                distanceFromBottom: 0,
                issuedContentHeight: Math.max(0, Math.trunc(metrics.scrollHeight)),
                issuedLayoutHeight: Math.max(0, Math.trunc(metrics.clientHeight)),
                kind: 'bottom',
                sessionId: props.sessionId,
                targetOffsetY: null,
                targetOffsetYWasClamped: false,
            };
            armEntryRestoreDeadline(transaction, stabilizeMaxMs);
            return transaction;
        };

        const attempt = (): boolean => {
            if (cancelled) return true;
            // If the user is actively scrolling (or scroll inertia is still firing wheel events),
            // avoid fighting their intent with initial pin retries.
            if (Platform.OS === 'web') {
                if (wantsPinnedRef.current === false) {
                    preemptEntryRestoreTransaction();
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                if (Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS) return false;
                const transaction = ensureWebEntryBottomTransaction();
                if (!transaction) return false;
                if (!transaction.isClosed()) {
                    verifyWebEntryRestoreTransaction();
                }
                if (transaction.isClosed()) {
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                return false;
            }
            pinToBottomRespectingNativeMountSettle('initial-open');
            return false;
        };

        if (Platform.OS === 'web') {
            const startedAtMs = Date.now();

            if (stabilizeMaxMs <= 0 || attempt()) {
                if (stabilizeMaxMs <= 0) {
                    attempt();
                }
                return () => {
                    cancelled = true;
                    initialWebPinStabilizingRef.current = false;
                };
            }

            const delays = resolveInitialWebPinRetryDelays({
                milestonesMs: tuning.transcriptWebInitialPinRetryMilestonesMs,
                stabilizeMaxMs,
                retryIntervalMs,
            });

            if (delays.length === 0) {
                initialWebPinStabilizingRef.current = false;
                return () => {
                    cancelled = true;
                };
            }

            initialWebPinStabilizingRef.current = true;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            let delayIndex = 0;

            const scheduleNext = () => {
                if (cancelled) return;
                if (delayIndex >= delays.length) {
                    initialWebPinStabilizingRef.current = false;
                    return;
                }
                const delayMs = delays[delayIndex];
                delayIndex += 1;
                const timeoutMs = resolveWebPinRetryTimeoutMs({
                    startedAtMs,
                    nowMs: Date.now(),
                    milestoneMs: delayMs,
                });
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    if (attempt()) return;
                    scheduleNext();
                }, timeoutMs);
            };

            scheduleNext();
            return () => {
                cancelled = true;
                initialWebPinStabilizingRef.current = false;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
        }

        // One idempotent settle pin per mount window (plan B4): pin once; the
        // mount-settle coordinator owns any later settle pin.
        attempt();
        return () => { cancelled = true; };
    }, [
        armEntryRestoreDeadline,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        preemptEntryRestoreTransaction,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        resolveWebScrollMetrics,
        verifyWebEntryRestoreTransaction,
    ]);

    const isScrollable = React.useCallback((): boolean => {
        // On web, list content height can include collapsed/offscreen subtrees (e.g. tool-call group bodies),
        // which can cause false positives. Prefer DOM scroll metrics when available.
        if (Platform.OS === 'web') {
            try {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    return isWebTranscriptScrollable(metrics, 1);
                }
            } catch {
                // fall through to measurement-based heuristic
            }
        }

        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);

    const flashListStartReachedThreshold = React.useMemo(() => {
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        const thresholdPx = resolveBackwardPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveBackwardPrefetchThresholdPx]);

    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        return resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting);
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);

    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        // The visitor needs turn/tool-calls-group shapes, so it scans the
        // PRE-decomposition source (always oldest-first) rather than the rendered
        // (possibly per-unit decomposed, possibly legacy-reversed) list data.
        const items = preDecompositionItemsRef.current;
        const shouldAutoExpandGroup = (toolMessageIds: readonly string[]): boolean => (
            shouldAutoExpandToolCallsGroupForShortTranscript({
                toolMessageCount: toolMessageIds.length,
                collapsedPreviewCount: previewCount,
                maxTurnEntriesPerListItem: props.maxTurnEntriesPerListItem,
            })
        );

        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (!shouldAutoExpandGroup(toolMessageIds)) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                applyToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (!shouldAutoExpandGroup(toolMessageIds)) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    applyToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };

        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        props.maxTurnEntriesPerListItem,
        resolveToolCallsCollapsedPreviewCount,
    ]);

    React.useEffect(() => {
        // Intentionally runs after every render until the transcript becomes scrollable or we succeed.
        // The turns/grouping builder can update in-place as message bodies hydrate, so relying on
        // `items`/`listData` identity is not robust here.
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (didAutoExpandToolCallsGroupsForSessionRef.current === props.sessionId) return;
        if (isScrollable()) return;

        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;

        didAutoExpandToolCallsGroupsForSessionRef.current = props.sessionId;
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            if (sessionEntryViewportRef.current?.shouldFollowBottom === false) return;
            pinToBottom('content-size-change');
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });

    const resolveJumpIndex = React.useCallback((): number | null => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;
        return resolveTranscriptJumpSeqIndex({
            targetSeq: target,
            items: itemsRef.current,
            resolveSeqForMessageId,
            // Treat unknown as "may have more": resolving the nearest-loaded fallback too
            // early aborts jump materialization, while the load loop self-terminates on
            // `no_more` and flips this latch for the post-exhaustion fallback landing.
            hasMoreOlder: hasMoreOlderRef.current !== false,
        });
    }, [props.jumpToSeq, resolveSeqForMessageId]);

    React.useEffect(() => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return;
        if (!props.isLoaded) return;
        if (lastJumpSeqRef.current === target) return;
        if (!props.sessionId) return;

        lastJumpSeqRef.current = target;
        fireAndForget((async () => {
            await jumpToTranscriptSeq({
                targetSeq: target,
                getIndex: resolveJumpIndex,
                loadOlder: async () => {
                    const syncLoadOlderOptions = resolveSyncLoadOlderOptions();
                    const result = props.forkedTranscriptEnabled
                        ? (syncLoadOlderOptions
                            ? await sync.loadOlderMessagesForkAware(props.sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessagesForkAware(props.sessionId))
                        : (syncLoadOlderOptions
                            ? await sync.loadOlderMessages(props.sessionId, syncLoadOlderOptions)
                            : await sync.loadOlderMessages(props.sessionId));
                    if (result.status === 'no_more') return { status: 'no_more' as const };
                    return { status: 'loaded' as const, hasMore: result.hasMore };
                },
                afterLoadOlder: async () => {
                    // Yield to allow store updates + list re-render before re-checking `getIndex`.
                    await Promise.resolve();
                    await Promise.resolve();
                },
                scrollToIndex: (index) => {
                    if (shouldUseWebHotColdSplit) {
                        const decision = resolveWebColdListScrollTarget({
                            fullIndex: index,
                            coldCount: transcriptHotColdSegments.coldItems.length,
                            reason: 'jump-to-seq',
                        });
                        if (decision.kind === 'pin_to_bottom') {
                            pinToBottom('jump-to-seq');
                            return;
                        }
                        const command = resolveViewportCommand({
                            type: 'jump-to-seq',
                            sessionId: props.sessionId,
                            seq: target,
                            index: decision.index,
                        });
                        executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                        return;
                    }
                    const command = resolveViewportCommand({
                        type: 'jump-to-seq',
                        sessionId: props.sessionId,
                        seq: target,
                        index,
                    });
                    executeViewportCommand(withTranscriptViewportCommandAnimation(command, true));
                },
                maxLoads: 25,
            });
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [
        pinToBottom,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        executeViewportCommand,
        resolveJumpIndex,
        resolveSyncLoadOlderOptions,
        resolveViewportCommand,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
    ]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialFillStatusRef.current !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        initialFillStatusRef.current = 'in_progress';
        initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        initialFillAbortRef.current = controller;
        const signal = controller.signal;
        const shouldPinDuringInitialFill = sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            if (shouldPinDuringInitialFill) {
                // Pin once up front for follow-bottom entries; observed unpinned restores must keep
                // their reading viewport while initial fill fetches older pages.
                pinToBottomRespectingNativeMountSettle('initial-open');
                if (Platform.OS === 'web') {
                    // D5 (evidence E10): rAF starvation in background tabs must not stall fill.
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                }
            }

            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;

            while (true) {
                if (signal.aborted) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;
                // N2b.2: the slice decided WHAT to fill — a sliced window is its own fill
                // verdict (under-filled sliced entries stay write-free by construction;
                // filling above the anchor would only grow the withheld range).
                if (entrySliceWindowRef.current?.sessionId === props.sessionId) break;
                if (Date.now() - startedAtMs >= budgetMs) break;

                const result = await loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                if (!result) break;
                if (result.status === 'no_more') break;

                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                if (shouldPinDuringInitialFill && wantsPinnedRef.current) {
                    pinToBottomRespectingNativeMountSettle('initial-open');
                }
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            initialFillStatusRef.current = 'done';
            observeMountSettleMetrics();
            if (!shouldPinDuringInitialFill) {
                // Fill settled: resolve (and verify on web) the entry-restore transaction.
                attemptEntryRestore();
                verifyWebEntryRestoreTransaction();
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        attemptEntryRestore,
        isScrollable,
        listContentHeight,
        listLayoutHeight,
        loadOlder,
        observeMountSettleMetrics,
        pinToBottomRespectingNativeMountSettle,
        props.committedMessagesCount,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        verifyWebEntryRestoreTransaction,
        waitForNextVisualUpdate,
    ]);

    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1 }}
              {...(Platform.OS === 'web'
                ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                : {})}
            >
          {listImplementation === 'flatlist_legacy' ? (
          <FlatList<ChatTranscriptListItem>
          ref={(node) => {
            // react-test-renderer does not provide a stable ref object; we store it manually.
            listRef.current = node as unknown as ScrollableChatListRef | null;
          }}
            {...(Platform.OS === 'web'
              ? ({
                                    onWheel: stopScrollEventPropagationOnWeb,
                                    onTouchMove: stopScrollEventPropagationOnWeb,
                                    onPointerDown: markUserScrollIntentOnWeb,
                                    onMouseDown: markUserScrollIntentOnWeb,
                              } as any)
              : ({
                                    onTouchCancel: recordNativeTranscriptTouchEndIntent,
                                    onTouchEnd: recordNativeTranscriptTouchEndIntent,
                                    onTouchMove: recordNativeTranscriptTouchIntent,
                                    onTouchStart: recordNativeTranscriptTouchStartIntent,
                              } as any)
              )}
          testID="transcript-chat-list"
          data={listData}
          extraData={transcriptListExtraData}
          inverted={true}
          key={props.sessionId}
                      nativeID={chatListNativeId}
                      keyExtractor={keyExtractor}
                      maintainVisibleContentPosition={
                        flatListMaintainVisibleContentPosition
                      }
                    onLayout={(e) => {
                        const layout = e?.nativeEvent?.layout;
                        recordListLayoutWidth(layout?.width);
                        const h = layout?.height;
                        if (typeof h === 'number' && Number.isFinite(h)) {
                            const layoutHeightChanged = listLayoutHeightRef.current !== h;
                            listLayoutHeightRef.current = h;
                            setListLayoutHeight(h);
                            if (layoutHeightChanged) {
                                recordViewportTelemetryEvent({
                                    type: 'layout-measured',
                                    mode: resolveViewportTelemetryMode(),
                                    reason: 'layout-change',
                                    layoutHeight: h,
                                    contentHeight: listContentHeightRef.current,
                                });
                            }
                        }
                    }}
                    onContentSizeChange={(_, h) => {
                        if (typeof h === 'number' && Number.isFinite(h)) {
                            const contentHeightChanged = listContentHeightRef.current !== h;
                            markNativeContentMeasurementForCurrentSession();
                            listContentHeightRef.current = h;
                            setListContentHeight(h);
                            if (contentHeightChanged) {
                                recordViewportTelemetryEvent({
                                    type: 'content-measured',
                                    mode: resolveViewportTelemetryMode(),
                                    reason: 'content-size-change',
                                    layoutHeight: listLayoutHeightRef.current,
                                    contentHeight: h,
                                });
                            }
                        }
                    }}
                onScroll={(e) => {
                    const y = e?.nativeEvent?.contentOffset?.y;
                    if (typeof y !== 'number' || !Number.isFinite(y)) return;
                    const nowMs = Date.now();
                    const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                    const nativeDistanceFromBottom = y;
                    const shouldIgnoreInvalidNativeScroll = shouldIgnoreNativeInvalidScrollObservation(
                        y,
                        nativeDistanceFromBottom,
                        listLayoutHeightRef.current,
                        listContentHeightRef.current,
                    );
                    if (Platform.OS !== 'web') {
                        recordScrollObservedTelemetry({
                            offsetY: y,
                            layoutHeight: listLayoutHeightRef.current,
                            contentHeight: listContentHeightRef.current,
                            distanceFromBottom: nativeDistanceFromBottom,
                            reason: shouldIgnoreInvalidNativeScroll
                                ? 'invalid-native-offset'
                                : 'observed',
                        });
                    }
                    // Invalid (NaN/negative) observations are dropped only (plan B5):
                    // no recovery repin side effects.
                    if (shouldIgnoreInvalidNativeScroll) return;
                    const shouldIgnorePassiveNativeScroll = shouldIgnoreNativePassiveViewportScroll(
                        isTrusted,
                        nowMs,
                        nativeDistanceFromBottom,
                        pinThresholdPx,
                    );
                    const shouldRecordPassiveNativeMovement =
                        !isTrusted && shouldRecordNativePassiveUnpinnedMovement(nativeDistanceFromBottom, pinThresholdPx);
                    if (isTrusted) {
                                            recordNativeUserScrollIntent(nowMs);
                                            markNativeInitialViewportAppliedForCurrentSession();
                    } else if (shouldIgnorePassiveNativeScroll) {
                        return;
                    } else if (shouldRecordPassiveNativeMovement) {
                        recordNativeUserScrollIntent(nowMs);
                    } else {
                        refreshNativeRecentPassiveUserScrollIntent(isTrusted, nowMs);
                    }
                    const flatListPreviousScrollOffset =
                        lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? 0 : null);
                    const flatListMovedAwayFromBottom =
                        flatListPreviousScrollOffset !== null && y > flatListPreviousScrollOffset;
                    const flatListMovedTowardBottom =
                        flatListPreviousScrollOffset !== null && y < flatListPreviousScrollOffset;
                    const flatListRecentUserIntent =
                        isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                    const flatListNativeAwayGestureStillOpen =
                        Platform.OS !== 'web' &&
                        bottomFollowModeStateRef.current.dragSession?.trusted === true &&
                        bottomFollowModeStateRef.current.dragSession.sawAwayMovement === true;
                    if (
                        flatListNativeAwayGestureStillOpen &&
                        !isTrusted &&
                        nativeDistanceFromBottom <= pinThresholdPx
                    ) {
                        if (nativeListDragActiveRef.current) {
                            updateNativeBottomFollowModeFromScrollObservation({
                                distanceFromBottom: nativeDistanceFromBottom,
                                isTrusted,
                                movedAwayFromBottom: flatListMovedAwayFromBottom,
                                movedTowardBottom: flatListMovedTowardBottom,
                                recentUserIntent: flatListRecentUserIntent,
                            });
                        }
                        return;
                    }
                    const followIntent = resolveTranscriptBottomFollowIntent({
                        canRearmBottom:
                            !flatListNativeAwayGestureStillOpen ||
                            (isTrusted && flatListMovedTowardBottom),
                        // Plan B6 trusted-gate: on native only trusted scrolls release follow;
                        // web keeps gesture-derived recent intent as release authority.
                        canRelease: Platform.OS === 'web'
                            ? flatListRecentUserIntent
                            : isTrusted &&
                                (
                                    listOrientationRef.current !== 'inverted' ||
                                    nativeDistanceFromBottom > pinThresholdPx
                                ),
                        direction: 'toward-zero',
                        distanceFromBottom: y,
                        pinThresholdPx,
                        previousScrollOffset: flatListPreviousScrollOffset,
                        scrollOffset: y,
                        wantsPinned: wantsPinnedRef.current,
                    });
                    updateNativeBottomFollowModeFromScrollObservation({
                        distanceFromBottom: followIntent.nextDistanceFromBottom,
                        isTrusted,
                        movedAwayFromBottom: flatListMovedAwayFromBottom,
                        movedTowardBottom: flatListMovedTowardBottom,
                        recentUserIntent: flatListRecentUserIntent,
                    });
                    if (
                        Platform.OS !== 'web' &&
                        !isTrusted &&
                        bottomFollowModeStateRef.current.mode !== 'following' &&
                        followIntent.isPinned &&
                        followIntent.wantsPinned
                    ) {
                        return;
                    }
                    lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                    lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                    wantsPinnedRef.current = followIntent.wantsPinned;

                    const distanceFromBottom = followIntent.nextDistanceFromBottom;
                    const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                    const pinned = followIntent.isPinned;
                    if (
                        !pinned &&
                        wantsPinnedRef.current &&
                        pinEnabled &&
                        autoFollowWhenPinned &&
                        canAutoFollowForReason('stream-append') &&
                        props.jumpToSeq == null &&
                        Platform.OS !== 'web' &&
                        nowMs - lastAutoRepinAtMsRef.current > TRANSCRIPT_SCROLL_AUTO_REPIN_THROTTLE_MS &&
                        nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
                    ) {
                        // Web/virtualization can sometimes drift the scroll position even without user intent.
                        // If we still "want pinned", repin opportunistically.
                        lastAutoRepinAtMsRef.current = nowMs;
                            deferPinToBottomAfterScroll('stream-append');
                    }
                    isPinnedRef.current = pinned;
                    const viewportState = {
                        isPinned: pinned,
                        offsetY: distanceFromBottom,
                        shouldRestoreViewport: !wantsPinnedRef.current,
                    };
                    emitViewportChange(viewportState);
                    scheduleViewportAnchorCapture(viewportState, {
                        suppressAnchorCapture: shouldRecordPassiveNativeMovement,
                    });
                    commitJumpToTopOffsetForVisibility(y);
                    commitJumpToBottomDistanceForVisibility(distanceFromBottom);
                    commitScrollPinEvent({
                        type: 'scroll',
                        enabled: pinEnabled,
                        offsetY: distanceFromBottom,
                        pinnedOffsetThresholdPx: effectiveThresholdPx,
                    });

                    drainDeferredNewerMessages({ distanceFromBottom, pinned });
                }}
                onScrollBeginDrag={() => {
                    recordNativeListDragEscapeIntent();
                }}
                onScrollEndDrag={recordNativeListDragEndIntent}
                scrollEventThrottle={TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                renderItem={renderItem}
                onEndReachedThreshold={0.2}
                onEndReached={() => {
                    if (initialFillStatusRef.current !== 'done') return;
                    void loadOlder();
                }}
	                        onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                                if (handleNativeRestoreIndexFailure(info.index)) return;
                                if (props.jumpToSeq == null) return;
	                            // Best-effort fallback for dynamic-height explicit jump targets.
	                            const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
	                                executeViewportCommand(resolveViewportCommand({
	                                type: 'scroll-offset',
	                                sessionId: props.sessionId,
	                                reason: 'jump-to-seq',
	                                mode: 'jump-to-seq',
	                            offsetY: offset,
	                            animated: true,
	                        }));
	                    }}
                  ListHeaderComponent={listHeaderNode}
                  ListFooterComponent={
                        listFooterNode
                    }
              />
              ) : (
                  <LayoutCommitObserver onCommitLayoutEffect={recordLayoutCommitObserved}>
                  <FlashList
                      ref={(node: ScrollableChatListRef | null) => {
                          listRef.current = node as unknown as ScrollableChatListRef | null;
                      }}
                        {...(Platform.OS === 'web'
                            ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchCancel: recordWebTranscriptTouchEndIntent,
                                        onTouchEnd: recordWebTranscriptTouchEndIntent,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onTouchStart: recordWebTranscriptTouchStartIntent,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                                  : ({
                                        onTouchCancel: recordNativeTranscriptTouchEndIntent,
                                        onTouchEnd: recordNativeTranscriptTouchEndIntent,
                                        onTouchMove: recordNativeTranscriptTouchIntent,
                                        onTouchStart: recordNativeTranscriptTouchStartIntent,
                                  } as any)
                            )}
                        testID="transcript-chat-list"
                      data={listData}
                      inverted={isInvertedNativeList ? true : undefined}
                      extraData={transcriptListExtraData}
                      key={props.sessionId}
                      nativeID={chatListNativeId}
                      keyExtractor={keyExtractor}
                        overrideProps={nativeFlashListScrollOverrideProps}
                        getItemType={getItemType}
                        drawDistance={flashListDrawDistance}
                      onLoad={handleFlashListLoad}
                      maintainVisibleContentPosition={
                          flashListMaintainVisibleContentPosition
                      }
                      onViewableItemsChanged={shouldAttachNativeViewabilityTelemetry ? handleNativeViewableItemsChanged : undefined}
                      viewabilityConfig={nativeViewabilityConfig}
                      onLayout={(e: LayoutChangeEvent) => {
                          const layout = e?.nativeEvent?.layout;
                          recordListLayoutWidth(layout?.width);
                          const h = layout?.height;
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              const layoutHeightChanged = listLayoutHeightRef.current !== h;
                              const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                              const nativePrevFollowAtBottom = captureNativeBottomFollowPreviousFollow();
                              listLayoutHeightRef.current = h;
                                      setListLayoutHeight(h);
                                      if (layoutHeightChanged) {
                                          recordViewportTelemetryEvent({
                                              type: 'layout-measured',
                                              mode: resolveViewportTelemetryMode(),
                                              reason: 'layout-change',
                                              layoutHeight: h,
                                              contentHeight: listContentHeightRef.current,
                                          });
                                      }
                                      recordNativeVisibleWindowTelemetry('layout-change', {
                                          layoutHeight: h,
                                          contentHeight: listContentHeightRef.current,
                                      });
                                      observeMountSettleMetrics();
                                      pinNativeInitialFollowBottomViewportIfReady('layout-change');
                                  if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                                      observeNativePrependTransaction();
                                  }
                                  if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                      // One transaction per entry: this only resolves while no
                                      // transaction exists yet (no E1 reapply on layout change).
                                      attemptEntryRestore();
                                      verifyNativeSliceEntryRestoreTransaction();
                                  }
                                        if (layoutHeightChanged && listContentHeightRef.current > 0) {
                                            schedulePinToBottom(previousWebMetrics, 'layout-change', nativePrevFollowAtBottom);
                                        }
                          }
                      }}
                          onContentSizeChange={(_: number, h: number) => {
                                  if (typeof h === 'number' && Number.isFinite(h)) {
                                      const measuredContentHeight = resolveMeasuredContentHeight(h);
                                      const previousMeasuredContentHeight = listContentHeightRef.current;
                                      const contentHeightChanged = previousMeasuredContentHeight !== measuredContentHeight;
                                      const contentHeightGrew = measuredContentHeight > previousMeasuredContentHeight;
                                      const previousMeasuredActivityKey = lastMeasuredContentActivityKeyRef.current;
                                      const latestActivityKey = props.latestCommittedActivityKey;
                                      const contentSizeScrollReason: TranscriptViewportTelemetryScrollReason =
                                          props.sessionActive &&
                                          previousMeasuredActivityKey != null &&
                                          latestActivityKey != null &&
                                          (
                                              previousMeasuredActivityKey !== latestActivityKey ||
                                              (previousMeasuredActivityKey === latestActivityKey && contentHeightGrew)
                                          )
                                              ? 'stream-append'
                                              : 'content-size-change';
                                      const materializationLayoutHeight = listLayoutHeightRef.current;
                                      const materializationDeltaHeight = measuredContentHeight - previousMeasuredContentHeight;
                                      const materializationPreviousTargetOffsetY =
                                          Number.isFinite(materializationLayoutHeight) && materializationLayoutHeight > 0
                                              ? Math.max(0, Math.trunc(previousMeasuredContentHeight - materializationLayoutHeight))
                                              : 0;
                                      const lastNativeBottomFollowPinCommand = lastNativeBottomFollowPinCommandRef.current;
                                      const hasNativeBottomFollowPinCommandForCurrentSession =
                                          lastNativeBottomFollowPinCommand?.sessionId === props.sessionId;
                                      const shouldAllowNativeContentMaterializationAutoPin =
                                          Platform.OS !== 'web' &&
                                          usesNativeFlashListBottomMaintenance &&
                                          contentSizeScrollReason === 'content-size-change' &&
                                          wantsPinnedRef.current &&
                                          (
                                              hasNativeInitialViewportAppliedForCurrentSession() ||
                                              hasNativeBottomFollowPinCommandForCurrentSession
                                          ) &&
                                          previousMeasuredContentHeight > 0 &&
                                          Number.isFinite(materializationLayoutHeight) &&
                                          materializationLayoutHeight > 0 &&
                                          materializationDeltaHeight >= materializationLayoutHeight &&
                                          materializationPreviousTargetOffsetY <= Math.max(
                                              pinThresholdPx,
                                              materializationLayoutHeight * 0.5,
                                          );
                                      nativeContentMaterializationAutoPinRef.current =
                                          shouldAllowNativeContentMaterializationAutoPin
                                              ? { sessionId: props.sessionId, contentHeight: measuredContentHeight }
                                              : null;
                                  const previousWebMetrics = captureWebBottomFollowPreviousMetrics();
                                  const nativePrevFollowAtBottom = captureNativeBottomFollowPreviousFollow();
                                  markNativeContentMeasurementForCurrentSession();
                                      listContentHeightRef.current = measuredContentHeight;
                                      lastMeasuredContentActivityKeyRef.current = props.latestCommittedActivityKey;
                                      if (shouldCommitContentHeightState()) {
                                          setListContentHeight(measuredContentHeight);
                                      }
                                      if (
                                          contentHeightChanged &&
                                          contentSizeScrollReason === 'stream-append' &&
                                          Platform.OS !== 'web'
                                      ) {
                                          releaseNativeBottomFollowIfFlashListOffsetEscaped({
                                              contentHeight: measuredContentHeight,
                                              layoutHeight: listLayoutHeightRef.current,
                                          });
                                      }
                                      if (contentHeightChanged) {
                                          recordViewportTelemetryEvent({
                                              type: 'content-measured',
                                              mode: resolveViewportTelemetryMode(),
                                              reason: contentSizeScrollReason,
                                              layoutHeight: listLayoutHeightRef.current,
                                              contentHeight: measuredContentHeight,
                                          });
                                      }
                                      recordNativeVisibleWindowTelemetry(contentSizeScrollReason, {
                                          layoutHeight: listLayoutHeightRef.current,
                                          contentHeight: measuredContentHeight,
                                      });
                                      observeMountSettleMetrics();
                                      pinNativeInitialFollowBottomViewportIfReady(contentSizeScrollReason);
                                      if (Platform.OS !== 'web' && listImplementation === 'flash_v2') {
                                          observeNativePrependTransaction();
                                      }
                                  if (Platform.OS !== 'web' && sessionEntryViewportRef.current?.shouldFollowBottom === false) {
                                      // One transaction per entry: content-size changes can only
                                      // resolve a not-yet-issued restore, never re-issue one (E1).
                                      attemptEntryRestore();
                                      verifyNativeSliceEntryRestoreTransaction();
                                  }
                                        if (contentHeightChanged && listLayoutHeightRef.current > 0) {
                                            schedulePinToBottom(previousWebMetrics, contentSizeScrollReason, nativePrevFollowAtBottom);
                                        }
                          }
                      }}
                        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                                // React Native Web exposes `contentOffset.y` via a computed getter on every
                                // scroll event. For web FlashList we already need live DOM metrics, so read
                                // those first and only fall back to the synthetic event when the DOM scroller
                                // is unavailable.
                                const nativeEvent = e?.nativeEvent;
                                const liveWebMetrics = Platform.OS === 'web' ? resolveWebScrollMetrics() : null;
                                const rawObservedOffsetY = liveWebMetrics ? liveWebMetrics.scrollTop : nativeEvent?.contentOffset?.y;
                                if (typeof rawObservedOffsetY !== 'number' || !Number.isFinite(rawObservedOffsetY)) return;
                                            const nowMs = Date.now();
                                            const isTrusted = (nativeEvent as any)?.isTrusted === true;
                              const eventLayoutH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(nativeEvent?.layoutMeasurement?.height)
                                      : null;
                              const eventContentH =
                                  Platform.OS !== 'web'
                                      ? resolveNativeScrollEventMetric(nativeEvent?.contentSize?.height)
                                      : null;
                              const layoutH = eventLayoutH ?? listLayoutHeightRef.current;
                              const contentH = eventContentH ?? listContentHeightRef.current;
                              // N3.2: ALL downstream observation logic reads CANONICAL standard-space
                              // offsets (0 = oldest edge); inverted raw offsets map here, at the single
                              // observation boundary (identity under standard orientation).
                              const y = toCanonicalScrollOffset({
                                  offsetY: rawObservedOffsetY,
                                  contentHeight: contentH,
                                  layoutHeight: layoutH,
                                  orientation: listOrientationRef.current,
                              });
                              const refDistanceFromBottom =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH - y))
                                      : 0;
                              const refVisualBottomScrollOffset =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH))
                                      : null;
                                    const recordNativeScrollObservation = (
                                        reason: TranscriptViewportTelemetryObservationReason = 'observed',
                                    ) => {
                                        if (Platform.OS === 'web') return;
                                        recordScrollObservedTelemetry({
                                            offsetY: y,
                                            rawOffsetY: rawObservedOffsetY,
                                            canonicalOffsetY: y,
                                            layoutHeight: layoutH,
                                            contentHeight: contentH,
                                            distanceFromBottom: refDistanceFromBottom,
                                            reason,
                                        });
                                        recordNativeVisibleWindowTelemetry(reason, {
                                            rawOffsetY: rawObservedOffsetY,
                                            canonicalOffsetY: y,
                                            layoutHeight: layoutH,
                                            contentHeight: contentH,
                                            distanceFromBottom: refDistanceFromBottom,
                                        });
                                    };
                                    const shouldIgnoreInvalidNativeScroll = shouldIgnoreNativeInvalidScrollObservation(
                                        rawObservedOffsetY,
                                        refDistanceFromBottom,
                                        layoutH,
                                        contentH,
                                    );
                                    if (shouldIgnoreInvalidNativeScroll) {
                                        // Drop-only (plan B5): no recovery repin side effects.
                                        recordNativeScrollObservation('invalid-native-offset');
                                        return;
                                    }
                                    const shouldIgnorePassiveNativeScroll = shouldIgnoreNativePassiveViewportScroll(
                                        isTrusted,
                                        nowMs,
                                        refDistanceFromBottom,
                                        pinThresholdPx,
                                    );
                                    const entryRestoreTransaction = entryRestoreTransactionRef.current;
                                    const hasOpenNativeEntryRestoreTransaction =
                                        Platform.OS !== 'web' &&
                                        entryRestoreTransaction != null &&
                                        entryRestoreTransaction.sessionId === props.sessionId &&
                                        !entryRestoreTransaction.isClosed();
                                    const commitOpenEntryRestoreVisibleState = () => {
                                        if (Platform.OS === 'web' || !hasOpenNativeEntryRestoreTransaction) return;
                                        const entryRestoreWriteContext = entryRestoreWriteContextRef.current;
                                        if (props.isLoaded && listDataRef.current.length > 0) {
                                            updateNativeViewportPaintObserved(true);
                                            if (firstPaintTelemetryRef.current?.recorded === false) {
                                                recordFirstListPaint();
                                            }
                                        }
                                        const visibleDistanceFromBottom = Math.max(
                                            0,
                                            Math.trunc(Math.max(
                                                entryRestoreWriteContext?.distanceFromBottom ?? 0,
                                                refDistanceFromBottom,
                                            )),
                                        );
                                        commitJumpToBottomDistanceForVisibility(visibleDistanceFromBottom);
                                        commitScrollPinEvent({
                                            type: 'scroll',
                                            enabled: pinEnabled,
                                            offsetY: visibleDistanceFromBottom,
                                            pinnedOffsetThresholdPx: pinThresholdPx,
                                        });
                                    };
                                    // Entry-restore transaction observation forwarding (plan F2):
                                    // trusted scrolls preempt; conclusive aligned|misaligned
                                    // observations drive confirm / the single correction; any
                                    // other frame holds ownership without writing.
                                    let entryRestoreConfirmedByThisObservation = false;
                                    if (hasOpenNativeEntryRestoreTransaction && entryRestoreTransaction) {
                                        if (isTrusted) {
                                            preemptEntryRestoreTransaction();
                                        } else {
                                            const alignmentObservation = resolveNativeEntryRestoreAlignmentObservation({
                                                contentHeight: contentH,
                                                distanceFromBottom: refDistanceFromBottom,
                                                offsetY: y,
                                                rawOffsetY: rawObservedOffsetY,
                                            });
                                            if (alignmentObservation == null) {
                                                commitOpenEntryRestoreVisibleState();
                                                recordNativeScrollObservation('pending');
                                                return;
                                            }
                                            const entryRestoreDirective = entryRestoreTransaction.onObservation(alignmentObservation, nowMs);
                                            if (entryRestoreTransaction.isClosed()) {
                                                entryRestoreConfirmedByThisObservation =
                                                    entryRestoreTransaction.outcome() === 'confirmed';
                                                finishEntryRestoreTransaction(entryRestoreTransaction);
                                                if (entryRestoreConfirmedByThisObservation) {
                                                    updateNativeViewportPaintObserved(true);
                                                }
                                            } else {
                                                if (entryRestoreDirective.action === 'issue-correction-write') {
                                                    issueNativeEntryRestoreCorrection({
                                                        contentHeight: contentH,
                                                        layoutHeight: layoutH,
                                                    });
                                                }
                                                commitOpenEntryRestoreVisibleState();
                                                recordNativeScrollObservation('pending');
                                                return;
                                            }
                                        }
                                    }
                                    if (Platform.OS === 'web') {
                                        verifyWebEntryRestoreTransaction();
                                    }
                                    const nativePrependTransaction =
                                        Platform.OS !== 'web' ? nativePrependTransactionRef.current : null;
                                    if (
                                        nativePrependTransaction != null &&
                                        nativePrependTransaction.sessionId === props.sessionId &&
                                        !nativePrependTransaction.isClosed()
                                    ) {
                                        if (isTrusted) {
                                            // Trusted scrolls preempt the transaction with zero writes;
                                            // MVCP alone holds the position under the finger (LC-R #5).
                                            nativePrependTransaction.onTrustedUserScroll();
                                            finishNativePrependTransaction(nativePrependTransaction);
                                        } else {
                                            observeNativePrependTransaction();
                                            if (!nativePrependTransaction.isClosed()) {
                                                recordNativeScrollObservation('pending');
                                                return;
                                            }
                                        }
                                    }
                                    const pendingExplicitJump = pendingNativeExplicitJumpConfirmRef.current;
                                    if (Platform.OS !== 'web' && pendingExplicitJump) {
                                        if (pendingExplicitJump.sessionId !== props.sessionId || isTrusted) {
                                            pendingNativeExplicitJumpConfirmRef.current = null;
                                        } else if (refDistanceFromBottom <= pinThresholdPx) {
                                            // Bottom reached: the explicit jump is confirmed;
                                            // MVCP bottom maintenance owns it from here.
                                            pendingNativeExplicitJumpConfirmRef.current = null;
                                        } else if (contentH !== pendingExplicitJump.issuedContentHeight) {
                                            // Plan B7: the content height churned under the explicit
                                            // jump before the bottom was observed. Spend the ONE
                                            // bounded re-confirm (snap) inside the explicit phase —
                                            // never a correction loop.
                                            pendingNativeExplicitJumpConfirmRef.current = null;
                                            executeViewportCommand(withTranscriptViewportCommandAnimation(
                                                resolveViewportCommand({
                                                    type: 'jump-to-bottom',
                                                    sessionId: props.sessionId,
                                                }),
                                                false,
                                            ));
                                        }
                                    }
                                    const pendingEntrySettle = pendingNativeEntrySettleConfirmRef.current;
                                    if (Platform.OS !== 'web' && pendingEntrySettle) {
                                        if (
                                            pendingEntrySettle.sessionId !== props.sessionId ||
                                            isTrusted ||
                                            !wantsPinnedRef.current ||
                                            bottomFollowModeStateRef.current.mode !== 'following'
                                        ) {
                                            pendingNativeEntrySettleConfirmRef.current = null;
                                        } else if (refDistanceFromBottom <= pinThresholdPx) {
                                            // Bottom-confirmed frame: refresh the event-source
                                            // baseline (the entry bottom holds at this content
                                            // version); the one-shot stays armed for late settle.
                                            pendingNativeEntrySettleConfirmRef.current = {
                                                ...pendingEntrySettle,
                                                issuedContentHeight: contentH,
                                            };
                                        } else if (pendingEntrySettle.issuedContentHeight == null) {
                                            // First observed frame after a (warm) entry: record the
                                            // event-source baseline; only GROWTH from here can spend
                                            // the one-shot (bogus recycled offsets carry no growth).
                                            pendingNativeEntrySettleConfirmRef.current = {
                                                ...pendingEntrySettle,
                                                issuedContentHeight: contentH,
                                            };
                                        } else if (
                                            pendingEntrySettle.issuedContentHeight != null &&
                                            contentH > pendingEntrySettle.issuedContentHeight &&
                                            (
                                                nativeMountSettleStable ||
                                                nativeMountSettleDeadlineReachedRef.current
                                            )
                                        ) {
                                            // Plan P3: LATE content settle (after the mount window —
                                            // the coordinator owns pins inside it) GREW the content
                                            // and left the viewport above the bottom while still
                                            // 'following'. Spend the ONE bounded settle re-confirm
                                            // (mirror of B7) — never a loop. Bogus recycled offsets
                                            // never spend it: they carry no event-source growth.
                                            pendingNativeEntrySettleConfirmRef.current = null;
                                            pinNativeFlashListToBottomIfMeasured({
                                                force: true,
                                                telemetryReason: 'mount-settle',
                                            });
                                        }
                                    }
                                    recordNativeScrollObservation(
                                        shouldIgnorePassiveNativeScroll ? 'skipped' : 'observed',
                                    );
                                    const observedPendingNativeBottomPinTarget =
                                        Platform.OS !== 'web' &&
                                        usesNativeFlashListBottomMaintenance &&
                                        pendingNativeMountSettleBottomPinRef.current &&
                                        nativeBottomFollowPinTargetObserved({
                                            lastNativePinOffset: lastNativePinOffsetRef.current,
                                            pinThresholdPx,
                                            visualBottomScrollOffset: refVisualBottomScrollOffset,
                                        });
                                    const canCompletePendingNativeBottomFollow = nativeBottomFollowCanCompletePendingPin({
                                        mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
                                        mountSettleStable: nativeMountSettleStable,
                                        pendingBottomPin: pendingNativeMountSettleBottomPinRef.current,
                                        pinTargetObserved: observedPendingNativeBottomPinTarget,
                                    });
                                    if (nativeBottomFollowCanApplyCompletion({
                                        canCompletePendingPin: canCompletePendingNativeBottomFollow,
                                        distanceFromBottom: refDistanceFromBottom,
                                        isNative: Platform.OS !== 'web',
                                        pinThresholdPx,
                                        wantsPinned: wantsPinnedRef.current,
                                    })) {
                                        pendingNativeMountSettleBottomPinRef.current = false;
                                        markNativeInitialViewportAppliedForCurrentSession({
                                            // Plan P3: the applying frame's event content height is
                                            // the settle-confirm baseline (event source only, E7).
                                            entrySettleBaselineContentHeight: contentH,
                                        });
                                    }
	                                    const shouldRecordPassiveNativeMovement =
	                                        !entryRestoreConfirmedByThisObservation &&
	                                        !isTrusted &&
	                                        shouldRecordNativePassiveUnpinnedMovement(refDistanceFromBottom, pinThresholdPx);
                                    if (isTrusted) {
                                        recordNativeUserScrollIntent(nowMs);
                                        markNativeInitialViewportAppliedForCurrentSession();
                                    } else if (shouldIgnorePassiveNativeScroll) {
                                        return;
                                    } else if (shouldRecordPassiveNativeMovement) {
                                        recordNativeUserScrollIntent(nowMs);
                                    } else if (!entryRestoreConfirmedByThisObservation) {
                                        refreshNativeRecentPassiveUserScrollIntent(isTrusted, nowMs);
                                    }
                                // On web the FlashList content height can be stale or collapsed (the hot/cold
                                // split renders the tail in the footer), so the ref-based distance can read 0
                                // even while the user is scrolled up. Prefer the live DOM scroller metrics so
                                // the released/observed viewport intent is not discarded by a measurement zero.
                                const distanceFromBottom = liveWebMetrics
                                    ? getWebTranscriptDistanceFromBottom(liveWebMetrics)
                                    : refDistanceFromBottom;
                                const visualBottomScrollOffset = liveWebMetrics
                                    ? resolveWebTranscriptMaxScrollTop(liveWebMetrics)
                                    : refVisualBottomScrollOffset;
                                mountSettleCoordinatorRef.current?.sample({
                                    sessionId: props.sessionId,
                                    nowMs,
                                });
                                let webObservedUserScrollMovement = false;
                                if (liveWebMetrics) {
                                    // Plan E3: genuine web scroll movement (scrollbar drag / keyboard) fires
                                    // no wheel/pointer/touch handler and is not reliably `isTrusted`, so it is
                                    // detected as "scroll moved without a recent programmatic write".
                                    // Programmatic pin/restore scroll writes update
                                    // `lastObservedWebScrollTopRef` to their own target, so they are not
                                    // misread as user movement. A single upward frame counts only beyond the
                                    // pin threshold (legacy behavior); SUSTAINED movement counts anywhere,
                                    // and upward movement unpins, mirroring the wheel path.
                                    const liveScrollTop = liveWebMetrics.scrollTop;
                                    const previousObservedScrollTop =
                                        lastObservedWebScrollTopRef.current
                                        ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null);
                                    if (previousObservedScrollTop != null && liveScrollTop !== previousObservedScrollTop) {
                                        const movementDirection: -1 | 1 = liveScrollTop < previousObservedScrollTop ? -1 : 1;
                                        const previousStreak = webNonProgrammaticScrollStreakRef.current;
                                        const streakCount = previousStreak?.direction === movementDirection
                                            ? previousStreak.count + 1
                                            : 1;
                                        webNonProgrammaticScrollStreakRef.current = {
                                            direction: movementDirection,
                                            count: streakCount,
                                        };
                                        const beyondPinThreshold = distanceFromBottom > pinThresholdPx;
                                        const sustainedMovement =
                                            streakCount >= TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES;
                                        const upwardIntent = movementDirection === -1 && (beyondPinThreshold || sustainedMovement);
                                        const downwardIntent = movementDirection === 1 && beyondPinThreshold && sustainedMovement;
                                        if (upwardIntent || downwardIntent) {
                                            webObservedUserScrollMovement = true;
                                            lastUserScrollIntentAtMsRef.current = nowMs;
                                            if (upwardIntent) {
                                                // Mirror the wheel path: upward movement is explicit
                                                // intent to unpin, even within the pinned threshold.
                                                wantsPinnedRef.current = false;
                                                preemptEntryRestoreTransaction();
                                            }
                                        }
                                    }
                                    lastObservedWebScrollTopRef.current = liveScrollTop;
                                }
                                observeMountSettleMetrics({
                                    nowMs,
                                    distanceFromBottom,
                                });
                                const recentUserIntent =
                                    isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_RECENT_MS;
                                // Plan B2 (evidence E8): passive-drift repin and the
                                // `effectiveDistanceFromBottom = 0` ground-truth falsification are deleted.
                                // Decisions below read the observed distance as-is.
                                const effectiveDistanceFromBottom = distanceFromBottom;
                                const effectiveScrollOffset = liveWebMetrics ? liveWebMetrics.scrollTop : y;
                                // The continuous web DOM-scroll path reports the genuine top as a
                                // near-zero `effectiveScrollOffset`. The browser rounds `scrollTop` to an
                                // integer (dpr=1) or leaves a sub-pixel residue (Retina), so a viewport
                                // resting at the very top is rarely EXACTLY 0 — a strict `=== 0` test
                                // mis-fires and the genuine-top frame never re-arms. A plain 'scroll'
                                // trigger SUSPENDS the older-pagination machine within the genuine-top band
                                // (offsetSuspended), so a viewport parked inside the threshold (e.g. when
                                // the top rendered row is a tall tool group whose height keeps the offset
                                // off zero until the genuine top is reached) never re-arms after its
                                // cooldown. Classify only the genuine-top frame as 'edge-reached' so it
                                // satisfies the machine's existing `allowsExactEdge` (-> `exactEdgeRetryEligible`)
                                // re-arm. Strictly gated on web/standard (non-inverted) + within the
                                // `TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX` band (the machine uses the SAME
                                // epsilon) so the 800px band cannot widen and a mid-band frame cannot
                                // re-arm (anti-burst preserved).
                                const isGenuineWebTopFrame =
                                    Platform.OS === 'web' &&
                                    listOrientationRef.current !== 'inverted' &&
                                    effectiveScrollOffset >= 0 &&
                                    effectiveScrollOffset <= TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX;
                                observeOlderPaginationScroll({
                                    offsetY: effectiveScrollOffset,
                                    layoutHeight: layoutH,
                                    contentHeight: contentH,
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    webMetrics: liveWebMetrics,
                                    trigger: isGenuineWebTopFrame ? 'edge-reached' : 'scroll',
                                });
                                if (loadOlderInFlight.current) {
                                    refreshInFlightWebPrependAnchor({
                                        userScrolledDuringLoad: isTrusted || webObservedUserScrollMovement,
                                    });
                                }
                                if (recentUserIntent && (Platform.OS !== 'web' || isTrusted)) {
                                    retargetPendingWebPrependAnchorForUserScroll();
                                }
                                const flashListPreviousScrollOffset =
                                    lastScrollOffsetForIntentRef.current ?? (wantsPinnedRef.current ? visualBottomScrollOffset : null);
                                const flashListMovedAwayFromBottom =
                                    flashListPreviousScrollOffset !== null &&
                                    typeof effectiveScrollOffset === 'number' &&
                                    effectiveScrollOffset < flashListPreviousScrollOffset;
                                const flashListMovedTowardBottom =
                                    flashListPreviousScrollOffset !== null &&
                                    typeof effectiveScrollOffset === 'number' &&
                                    effectiveScrollOffset > flashListPreviousScrollOffset;
                                const nativeAwayGestureStillOpen =
                                    Platform.OS !== 'web' &&
                                    bottomFollowModeStateRef.current.dragSession?.trusted === true &&
                                    bottomFollowModeStateRef.current.dragSession.sawAwayMovement === true;
                                if (
                                    nativeAwayGestureStillOpen &&
                                    !isTrusted &&
                                    effectiveDistanceFromBottom <= pinThresholdPx
                                ) {
                                    if (nativeListDragActiveRef.current) {
                                        updateNativeBottomFollowModeFromScrollObservation({
                                            distanceFromBottom: effectiveDistanceFromBottom,
                                            isTrusted,
                                            movedAwayFromBottom: flashListMovedAwayFromBottom,
                                            movedTowardBottom: flashListMovedTowardBottom,
                                            recentUserIntent,
                                        });
                                    }
                                    // Bottom-follow finish: the away-gesture bail must keep read-only UI state
                                    // honest (jump-button distance + pin badge) even while it declines to
                                    // re-pin for the open trusted away-gesture — exactly as the precedent
                                    // below does — otherwise the jump affordance freezes at a stale distance.
                                    // BUT only when `effectiveDistanceFromBottom` is trustworthy: in the
                                    // inverted model an active streaming session can glue the raw offset at 0,
                                    // so an untrusted near-bottom frame after an away drag is STALE and must
                                    // NOT hide the affordance (it would falsely report the user back at bottom).
                                    // Non-inverted distance is reliable, so commit there. No `wantsPinned`
                                    // write / mode change: release attribution stays with the away-gesture.
                                    if (listOrientationRef.current !== 'inverted') {
                                        lastPinOffsetForIntentRef.current = effectiveDistanceFromBottom;
                                        commitJumpToTopOffsetForVisibility(effectiveScrollOffset);
                                        commitJumpToBottomDistanceForVisibility(effectiveDistanceFromBottom);
                                        commitScrollPinEvent({
                                            type: 'scroll',
                                            enabled: pinEnabled,
                                            offsetY: effectiveDistanceFromBottom,
                                            pinnedOffsetThresholdPx: pinThresholdPx,
                                        });
                                    }
                                    return;
                                }
                                const followIntent = resolveTranscriptBottomFollowIntent({
                                    canRearmBottom:
                                        !nativeAwayGestureStillOpen ||
                                        (isTrusted && flashListMovedTowardBottom),
                                    // Plan B6 trusted-gate: on native only trusted scrolls release
                                    // follow; web keeps gesture-derived recent intent as release
                                    // authority (wheel/pointer/streak paths own web unpinning).
                                    // Plan B9: untrusted momentum frames inside the post-drag
                                    // attribution window (active momentum + retained trusted drag
                                    // session) carry the drag's release authority — height churn
                                    // without a drag still never releases.
                                    canRelease: Platform.OS === 'web'
                                        ? recentUserIntent
                                        : (
                                            isTrusted ||
                                            (
                                                nativeMomentumScrollActiveRef.current &&
                                                bottomFollowModeStateRef.current.dragSession?.trusted === true
                                            )
                                        ) &&
                                            (
                                                listOrientationRef.current !== 'inverted' ||
                                                refDistanceFromBottom > pinThresholdPx
                                            ),
                                    direction: 'toward-max',
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    pinThresholdPx,
                                    previousScrollOffset: flashListPreviousScrollOffset,
                                    scrollOffset: effectiveScrollOffset,
                                    wantsPinned: wantsPinnedRef.current,
                                });
                                updateNativeBottomFollowModeFromScrollObservation({
                                    distanceFromBottom: followIntent.nextDistanceFromBottom,
                                    isTrusted,
                                    movedAwayFromBottom: flashListMovedAwayFromBottom,
                                    movedTowardBottom: flashListMovedTowardBottom,
                                    recentUserIntent,
                                });
                                if (
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    bottomFollowModeStateRef.current.mode !== 'following' &&
                                    followIntent.isPinned &&
                                    followIntent.wantsPinned
                                ) {
                                    // The mode machine only re-follows on trusted movement, but the
                                    // viewport visibly sits at the bottom: keep read-only UI state
                                    // (jump button, pin badge) honest without writes or mode changes.
                                    // Plan P3: also record the observed distance so the exit-flush
                                    // live-tail fallback sees the visible bottom truth.
                                    lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                                    commitJumpToTopOffsetForVisibility(effectiveScrollOffset);
                                    commitJumpToBottomDistanceForVisibility(followIntent.nextDistanceFromBottom);
                                    commitScrollPinEvent({
                                        type: 'scroll',
                                        enabled: pinEnabled,
                                        offsetY: followIntent.nextDistanceFromBottom,
                                        pinnedOffsetThresholdPx: followIntent.effectivePinnedOffsetThresholdPx,
                                    });
                                    return;
                                }
                                if (
                                    Platform.OS !== 'web' &&
                                    usesNativeFlashListBottomMaintenance &&
                                    !isTrusted &&
                                    wantsPinnedRef.current &&
                                    bottomFollowModeStateRef.current.mode === 'following' &&
                                    mountSettleCoordinatorRef.current?.getSnapshot().isMountSettleActive === true &&
                                    nowMs - lastUserScrollIntentAtMsRef.current >= TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS
                                ) {
                                    // Cold-open open-flicker root fix: a structural
                                    // `clearLayoutCacheOnUpdate` inside the mount-settle window resets
                                    // FlashList bottom maintenance and yanks the inverted follow-bottom
                                    // list toward the visual top. MVCP only MAINTAINS a bottom already
                                    // reached — it never re-travels there — so the passive-drift bail
                                    // below would wrongly leave the list yanked. While the mount window
                                    // is still active and an untrusted frame observes the list off the
                                    // bottom with no recent user intent, re-issue the canonical inverted
                                    // bottom pin to catch the yank (and a known ~260ms second-source
                                    // transient). The pin's own off-bottom guard makes a same-content
                                    // re-pin a no-op once the bottom is reached, so this cannot loop.
                                    const mountSettleDistanceFromBottom = readCurrentNativeDistanceFromBottom();
                                    if (
                                        mountSettleDistanceFromBottom != null &&
                                        mountSettleDistanceFromBottom > pinThresholdPx
                                    ) {
                                        pinNativeFlashListToBottomIfMeasured({ telemetryReason: 'layout-change' });
                                    }
                                }
                                if (
                                    Platform.OS !== 'web' &&
                                    !isTrusted &&
                                    bottomFollowModeStateRef.current.mode === 'following' &&
                                    followIntent.wantsPinned &&
                                    !followIntent.isPinned
                                ) {
                                    // Passive height-churn drift while the mode machine still says
                                    // 'following' (plan B1/E8): MVCP owns bottom maintenance, so a
                                    // drift frame never surfaces released UI state, emits viewport
                                    // changes, or schedules writes.
                                    return;
                                }
                                lastPinOffsetForIntentRef.current = followIntent.nextDistanceFromBottom;
                                lastScrollOffsetForIntentRef.current = followIntent.nextScrollOffset;
                                wantsPinnedRef.current = followIntent.wantsPinned;

                                const effectiveThresholdPx = followIntent.effectivePinnedOffsetThresholdPx;
                                const pinned = followIntent.isPinned;
                                isPinnedRef.current = pinned;
                                const viewportState = {
                                    isPinned: pinned,
                                    offsetY: effectiveDistanceFromBottom,
                                    shouldRestoreViewport: !wantsPinnedRef.current,
                                };
                                emitViewportChange(viewportState);
                                // Plan P2: momentum frames inside the post-drag attribution window
                                // (B9) are USER movement — they must schedule/refresh the anchor
                                // capture so a dwell after a fling captures the reading position.
                                const momentumCarriesUserAttribution =
                                    nativeMomentumScrollActiveRef.current &&
                                    bottomFollowModeStateRef.current.dragSession?.trusted === true;
                                scheduleViewportAnchorCapture(viewportState, {
                                    suppressAnchorCapture:
                                        shouldRecordPassiveNativeMovement && !momentumCarriesUserAttribution,
                                });
                                commitJumpToTopOffsetForVisibility(effectiveScrollOffset);
                                commitJumpToBottomDistanceForVisibility(effectiveDistanceFromBottom);
                                commitScrollPinEvent({
                                    type: 'scroll',
                                    enabled: pinEnabled,
                                    offsetY: effectiveDistanceFromBottom,
                                    pinnedOffsetThresholdPx: effectiveThresholdPx,
                                });

                                const nativeFollowBottomObservationCanReleasePaint =
                                    refDistanceFromBottom <= effectiveThresholdPx &&
                                    (
                                        !usesNativeFlashListBottomMaintenance ||
                                        nativeMountSettleStable ||
                                        nativeMountSettleDeadlineReachedRef.current ||
                                        (
                                            isWarmKeepAliveInstance &&
                                            sessionEntryViewportRef.current?.shouldFollowBottom !== false
                                        )
                                    );
                                const nativeAcceptedViewportPaintObservation =
                                    Platform.OS !== 'web' &&
                                    props.isLoaded &&
                                    listDataRef.current.length > 0 &&
                                    !isTrusted &&
                                    (
                                        nativeFollowBottomObservationCanReleasePaint ||
                                        entryRestoreConfirmedByThisObservation ||
                                        (!wantsPinnedRef.current && refDistanceFromBottom > effectiveThresholdPx)
                                    );
                                if (nativeAcceptedViewportPaintObservation) {
                                    updateNativeViewportPaintObserved(true);
                                    if (firstPaintTelemetryRef.current?.recorded === false) {
                                        recordFirstListPaint();
                                    }
                                    if (!showFirstPaintPlaceholder) {
                                        const paintMetrics = resolveEffectiveListPaintMetrics() ?? {
                                            contentHeight: Math.max(0, Math.trunc(contentH)),
                                            distanceFromBottom: Math.max(0, Math.trunc(refDistanceFromBottom)),
                                            layoutHeight: Math.max(0, Math.trunc(layoutH)),
                                        };
                                        recordStablePaintTelemetry(paintMetrics, {
                                            nativeViewportObserved: true,
                                        });
                                    }
                                }

                                drainDeferredNewerMessages({
                                    distanceFromBottom: effectiveDistanceFromBottom,
                                    pinned,
                                });
                            }}
                            onScrollBeginDrag={() => {
                                recordNativeListDragEscapeIntent();
                            }}
                            onScrollEndDrag={recordNativeListDragEndIntent}
                            onMomentumScrollBegin={recordNativeMomentumScrollBeginIntent}
                            onMomentumScrollEnd={recordNativeMomentumScrollEndSettle}
                            scrollEventThrottle={
                                Platform.OS === 'web'
                                    ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                                    : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS
                            }
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="none"
                            renderItem={renderItem}
                            onStartReachedThreshold={flashListStartReachedThreshold}
                            onStartReached={() => {
                                observePaginationEdgeReachedNudge(listOrientation === 'inverted' ? 'newer' : 'older');
                            }}
                            onEndReachedThreshold={flashListStartReachedThreshold}
                            onEndReached={() => {
                                observePaginationEdgeReachedNudge(listOrientation === 'inverted' ? 'older' : 'newer');
                            }}
                            onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                                      if (handleNativeRestoreIndexFailure(info.index)) return;
                                      if (props.jumpToSeq == null) return;
	                                  // The averageItemLength estimate approximates a RAW offset of the
	                                  // rendered index; commands carry CANONICAL offsets (N3.2 seam).
	                                  const rawEstimatedOffset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
	                                  const offset = toCanonicalScrollOffset({
	                                      offsetY: rawEstimatedOffset,
	                                      contentHeight: listContentHeightRef.current,
	                                      layoutHeight: listLayoutHeightRef.current,
	                                      orientation: listOrientationRef.current,
	                                  });
	                                      executeViewportCommand(resolveViewportCommand({
	                                      type: 'scroll-offset',
	                                      sessionId: props.sessionId,
	                                      reason: 'jump-to-seq',
	                                      mode: 'jump-to-seq',
	                                  offsetY: offset,
	                                  animated: true,
	                              }));
	                          }}
                      ListHeaderComponent={orientedFlashListEdgeSlots.listHeaderNode}
                      ListFooterComponent={orientedFlashListEdgeSlots.listFooterNode}
                  />
                  </LayoutCommitObserver>
              )}
              {showFirstPaintPlaceholder ? (
                  <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
              ) : null}
              {(olderPagination.isLoadingOlder || isLoadingOlder) && !showFirstPaintPlaceholder ? (
                  <OlderLoadProgressOverlay />
              ) : null}
              {jumpToTopVisible ? (
                  <ComposerKeyboardFloatingInset
                      testID="transcript-jump-to-top-keyboard-offset"
                      baseBottom={jumpToBottomAffordance.isVisible ? 60 : 12}
                      style={{ position: 'absolute', right: 12 }}
                  >
                      <JumpToTopButton
                          testID="transcript-jump-to-top"
                          onPress={jumpToTop}
                      />
                  </ComposerKeyboardFloatingInset>
              ) : null}
              {jumpToBottomAffordance.isVisible ? (
                  <ComposerKeyboardFloatingInset
                      testID="transcript-jump-to-bottom-keyboard-offset"
                      baseBottom={12}
                      style={{ position: 'absolute', right: 12 }}
                  >
                      <JumpToBottomButton
                          testID="transcript-jump-to-bottom"
                          count={jumpToBottomAffordance.count}
                          onPress={jumpToBottom}
                          presentation={jumpToBottomAffordance.presentation}
                    />
                </ComposerKeyboardFloatingInset>
            ) : null}
              <CatchUpProgressOverlay
                  isCatchingUp={showCatchUpOverlay}
                  bottomInset={composerInsetHeight}
                  spinnerDelayMs={sync.getSyncTuning().transcriptOlderLoadSpinnerDelayMs}
              />
            </View>
        </TranscriptMotionProvider>
    )
});
