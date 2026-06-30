import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { Text } from '@/components/ui/text/Text';
import type { AgentEvent } from '@/sync/typesRaw';
import { t } from '@/text';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { useSettings } from '@/sync/store/hooks';
import { buildConnectedServiceAccountSwitchMessage } from './connectedServiceAccountSwitchMessage';
import {
    isTerminalComposerDraftBlockedEvent,
    readTerminalComposerDraftBlockedStateAtMs,
} from '@/components/sessions/terminalComposer/terminalComposerDraftBlockedEvent';
import { useTerminalComposerClearAction } from '@/components/sessions/terminalComposer/useTerminalComposerClearAction';
import { useTerminalComposerSubmitAction } from '@/components/sessions/terminalComposer/useTerminalComposerSubmitAction';

const EVENT_ICON_SIZE = 18;
const EVENT_SPINNER_SIZE = 20;
const EVENT_ICON_CONTAINER_SIZE = 20;

function formatLimitReachedTime(timestamp: number): string {
    try {
        const date = new Date(timestamp * 1000);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

function formatQuotaResetTime(timestampMs: number): string {
    try {
        const date = new Date(timestampMs);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

function formatUnknownEventDetails(event: AgentEvent): string {
    const details: string[] = [event.type];
    if ('errorCode' in event && typeof event.errorCode === 'string' && event.errorCode.trim().length > 0) {
        details.push(event.errorCode.trim());
    }
    if ('reason' in event && typeof event.reason === 'string' && event.reason.trim().length > 0) {
        details.push(event.reason.trim());
    }
    if ('action' in event && typeof event.action === 'string' && event.action.trim().length > 0) {
        details.push(event.action.trim());
    }
    if ('policy' in event && typeof event.policy === 'string' && event.policy.trim().length > 0) {
        details.push(event.policy.trim());
    }
    return `${t('message.unknownEvent')} (${details.join(' · ')})`;
}

function formatConnectedServiceSwitchAttemptFailureText(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>): string {
    const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(event.diagnostic);
    const text = diagnosticPresentation
        ? t(diagnosticPresentation.statusKey)
        : t('connectedServices.authSwitch.switchFailed');
    if (diagnosticPresentation) return text;
    return typeof event.errorCode === 'string' && event.errorCode.trim().length > 0
        ? `${text} (${event.errorCode.trim()})`
        : text;
}

function formatConnectedServiceSwitchAttemptSuccessText(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>): string {
    const outcomeAction = event.outcomeAction;
    if (outcomeAction === 'hot_applied' || (!outcomeAction && event.action === 'hot_applied')) {
        return t('connectedServices.authSwitch.status.liveApplied');
    }
    if (outcomeAction === 'credential_refreshed' || event.attemptedContinuityMode === 'credential_refresh') {
        return t('connectedServices.authSwitch.status.credentialsRefreshed');
    }
    if (outcomeAction === 'restarted' || (!outcomeAction && event.action === 'restart_requested')) {
        return t('connectedServices.authSwitch.status.restarting');
    }
    if (outcomeAction === 'metadata_updated' || (!outcomeAction && event.action === 'metadata_updated')) {
        return t('connectedServices.authSwitch.status.appliesOnNextResume');
    }
    return t('connectedServices.authSwitch.confirmAction');
}

function resolveConnectedServiceSwitchAttemptOutcome(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>):
    | 'failed'
    | 'scheduled_retry'
    | 'succeeded'
    | 'observed'
    | 'terminal' {
    return event.outcome ?? (event.ok ? 'succeeded' : 'failed');
}

function isObservedOnlyConnectedServiceSwitchAttempt(
    event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>,
    outcome: ReturnType<typeof resolveConnectedServiceSwitchAttemptOutcome>,
): boolean {
    return outcome === 'observed' || event.sessionAdoption === 'observed_only';
}

function formatRuntimeAuthRecoveryText(event: Extract<AgentEvent, { type: 'connected-service-runtime-auth-recovery' }>): string {
    const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(event.diagnostic);
    if (diagnosticPresentation) return t(diagnosticPresentation.statusKey);
    switch (event.status) {
        case 'retry_scheduled':
            return t('connectedServices.diagnostics.status.recovery_retry_scheduled');
        case 'dead_lettered':
            return t('connectedServices.diagnostics.status.recovery_dead_lettered');
        case 'recovered':
            return t('message.connectedServiceRuntimeAuthRecoveryRecovered');
        case 'cancelled':
            return t('message.connectedServiceRuntimeAuthRecoveryCancelled');
    }
}

type RuntimeConfigOutcomeEvent = Extract<AgentEvent, { type: 'runtime-config-outcome' }>;

// The five public statuses are frozen. Optional `timing` carries when an already-statused change
// takes effect, and is surfaced as a calm, secondary sub-state (never a new status or an alarm).
function formatRuntimeConfigOutcomeTiming(timing: RuntimeConfigOutcomeEvent['timing']): string | undefined {
    switch (timing) {
        case 'scheduled_for_next_prompt':
        case 'before_next_prompt':
        case 'next_idle':
            return t('message.runtimeConfigOutcomeAppliesBeforeNextMessage');
        case 'queued_until_safe_window':
            return t('message.runtimeConfigOutcomeQueuedUntilReady');
        case 'skipped_already_effective':
            return t('message.runtimeConfigOutcomeAlreadySet');
        default:
            return undefined;
    }
}

// Pending timing means the change is not effective yet, so the row should read as a calm clock
// rather than a success checkmark. `current_window`/`skipped_already_effective` are effective now.
function isPendingRuntimeConfigOutcomeTiming(timing: RuntimeConfigOutcomeEvent['timing']): boolean {
    return timing === 'scheduled_for_next_prompt'
        || timing === 'before_next_prompt'
        || timing === 'next_idle'
        || timing === 'queued_until_safe_window';
}

type RuntimeConfigOutcomeChange = NonNullable<RuntimeConfigOutcomeEvent['changes']>[number];

function runtimeConfigOutcomeKeyLabel(key: RuntimeConfigOutcomeChange['key']): string {
    switch (key) {
        case 'model':
            return t('message.runtimeConfigOutcomeKeyModel');
        case 'fallbackModel':
            return t('message.runtimeConfigOutcomeKeyFallbackModel');
        case 'permissionMode':
            return t('message.runtimeConfigOutcomeKeyPermissionMode');
        case 'reasoningEffort':
            return t('message.runtimeConfigOutcomeKeyReasoningEffort');
        case 'maxThinkingTokens':
            return t('message.runtimeConfigOutcomeKeyMaxThinkingTokens');
        case 'launchOption':
            return t('message.runtimeConfigOutcomeKeyLaunchOption');
        case 'sessionMode':
            return t('message.runtimeConfigOutcomeSessionMode');
    }
}

// Single lower/camelCase tokens (enum-ish values such as `acceptEdits`, `medium`, `ultracode`) read
// better spaced and capitalized; ids with digits/separators (model ids) must stay verbatim.
const HUMANIZABLE_VALUE = /^[a-z]+(?:[A-Z][a-z]*)*$/;

function formatRuntimeConfigOutcomeValue(value: RuntimeConfigOutcomeChange['effective']): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value ? t('common.on') : t('common.off');
    if (typeof value === 'number') return String(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!HUMANIZABLE_VALUE.test(trimmed)) return trimmed;
    const spaced = trimmed.replace(/([A-Z])/g, ' $1').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function runtimeConfigOutcomeStatusPrefix(status: RuntimeConfigOutcomeEvent['status']): string | undefined {
    switch (status) {
        case 'applied':
            return undefined;
        case 'requires_restart':
            return t('message.runtimeConfigOutcomeRequiresRestart');
        case 'requires_interactive_control':
            return t('message.runtimeConfigOutcomeRequiresInteractiveControl');
        case 'unsupported':
            return t('message.runtimeConfigOutcomeUnsupported');
        case 'failed':
            return t('message.runtimeConfigOutcomeFailed');
    }
}

/**
 * Friendly per-change copy with values (L4): "Reasoning effort → Medium". Returns undefined when
 * no change carries a usable value, so the event message remains the fallback.
 */
function formatRuntimeConfigOutcomeChangesText(event: RuntimeConfigOutcomeEvent): string | undefined {
    const changes = event.changes;
    if (!changes || changes.length === 0) return undefined;
    const parts = changes.map((change) => {
        const label = runtimeConfigOutcomeKeyLabel(change.key);
        const value = formatRuntimeConfigOutcomeValue(change.effective ?? change.requested);
        return value !== undefined ? `${label} → ${value}` : undefined;
    });
    if (!parts.some((part) => part !== undefined)) return undefined;
    const list = changes
        .map((change, index) => parts[index] ?? runtimeConfigOutcomeKeyLabel(change.key))
        .join(' · ');
    const prefix = runtimeConfigOutcomeStatusPrefix(event.status);
    return prefix ? `${prefix}: ${list}` : list;
}

function formatRuntimeConfigOutcomeSessionModeChange(changes: RuntimeConfigOutcomeEvent['changes']): string | undefined {
    const change = changes?.find((entry) => entry.key === 'sessionMode');
    if (!change) return undefined;
    const label = t('message.runtimeConfigOutcomeSessionMode');
    const value = change.requested ?? change.effective;
    return typeof value === 'string' && value.trim().length > 0
        ? `${label} (${value.trim()})`
        : label;
}

const TerminalComposerClearActionButton = React.memo(function TerminalComposerClearActionButton(props: {
    sessionId: string;
    expectedStateAtMs: number | null;
}) {
    const { theme } = useUnistyles();
    const terminalComposerClear = useTerminalComposerClearAction(props.sessionId);

    return (
        <Pressable
            testID="transcriptEvent.clearTerminalComposer"
            accessibilityRole="button"
            accessibilityLabel={t('session.pendingMessages.clearTerminalComposer.action')}
            accessibilityState={{
                disabled: terminalComposerClear.busy,
                busy: terminalComposerClear.busy,
            }}
            disabled={terminalComposerClear.busy}
            onPress={() => {
                void terminalComposerClear.clearTerminalComposer({
                    expectedStateAtMs: props.expectedStateAtMs,
                });
            }}
            style={({ pressed }) => ([
                styles.action,
                {
                    borderColor: theme.colors.border.default,
                    backgroundColor: pressed ? theme.colors.surface.pressedOverlay : theme.colors.surface.base,
                    opacity: terminalComposerClear.busy ? 0.7 : 1,
                },
            ])}
        >
            {terminalComposerClear.busy ? (
                <ActivitySpinner
                    testID="transcriptEvent.clearTerminalComposerSpinner"
                    size={10}
                    color={theme.colors.text.secondary}
                />
            ) : (
                <Ionicons name="backspace-outline" size={12} color={theme.colors.text.secondary} />
            )}
            <Text style={[styles.actionText, { color: theme.colors.text.secondary }]}>
                {t('session.pendingMessages.clearTerminalComposer.action')}
            </Text>
        </Pressable>
    );
});

const TerminalComposerSubmitActionButton = React.memo(function TerminalComposerSubmitActionButton(props: {
    sessionId: string;
    expectedStateAtMs: number | null;
}) {
    const { theme } = useUnistyles();
    const terminalComposerSubmit = useTerminalComposerSubmitAction(props.sessionId);

    return (
        <Pressable
            testID="transcriptEvent.submitTerminalComposer"
            accessibilityRole="button"
            accessibilityLabel={t('session.pendingMessages.submitTerminalComposer.action')}
            accessibilityState={{
                disabled: terminalComposerSubmit.busy,
                busy: terminalComposerSubmit.busy,
            }}
            disabled={terminalComposerSubmit.busy}
            onPress={() => {
                void terminalComposerSubmit.submitTerminalComposer({
                    expectedStateAtMs: props.expectedStateAtMs,
                });
            }}
            style={({ pressed }) => ([
                styles.action,
                {
                    borderColor: theme.colors.border.default,
                    backgroundColor: pressed ? theme.colors.surface.pressedOverlay : theme.colors.surface.base,
                    opacity: terminalComposerSubmit.busy ? 0.7 : 1,
                },
            ])}
        >
            {terminalComposerSubmit.busy ? (
                <ActivitySpinner
                    testID="transcriptEvent.submitTerminalComposerSpinner"
                    size={10}
                    color={theme.colors.text.secondary}
                />
            ) : (
                <Ionicons name="return-down-forward-outline" size={12} color={theme.colors.text.secondary} />
            )}
            <Text style={[styles.actionText, { color: theme.colors.text.secondary }]}>
                {t('session.pendingMessages.submitTerminalComposer.action')}
            </Text>
        </Pressable>
    );
});

export const TranscriptEventRow = React.memo(function TranscriptEventRow(props: {
    event: AgentEvent;
    sessionId?: string | null;
}) {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const isTerminalComposerDraftBlocked = isTerminalComposerDraftBlockedEvent(props.event);
    const terminalComposerDraftBlockedStateAtMs = readTerminalComposerDraftBlockedStateAtMs(props.event);
    let iconName: React.ComponentProps<typeof Ionicons>['name'] = 'information-circle-outline';
    let text = formatUnknownEventDetails(props.event);
    let detailText: string | undefined;
    let isLoading = false;
    let testID: string | undefined;

    if (props.event.type === 'switch') {
        iconName = 'swap-horizontal-outline';
        text = t('message.switchedToMode', { mode: props.event.mode });
    } else if (props.event.type === 'message') {
        iconName = 'information-circle-outline';
        text = props.event.message;
    } else if (props.event.type === 'terminal-composer-draft-blocked') {
        testID = 'transcript-event-terminal-composer-draft-blocked';
        iconName = 'pause-circle-outline';
        text = props.event.message ?? t('session.pendingMessages.steerBlockedTerminalDraftNotice');
    } else if (props.event.type === 'runtime-config-outcome') {
        testID = `transcript-event-runtime-config-outcome-${props.event.status}`;
        const pendingTiming = isPendingRuntimeConfigOutcomeTiming(props.event.timing);
        if (props.event.status === 'applied') {
            iconName = pendingTiming ? 'time-outline' : 'checkmark-circle-outline';
        } else if (props.event.status === 'requires_restart' || props.event.status === 'requires_interactive_control') {
            iconName = 'time-outline';
        } else {
            iconName = 'warning-outline';
        }
        text = formatRuntimeConfigOutcomeChangesText(props.event) ?? props.event.message;
        const detailParts = [
            formatRuntimeConfigOutcomeSessionModeChange(props.event.changes),
            formatRuntimeConfigOutcomeTiming(props.event.timing),
        ].filter((part): part is string => Boolean(part));
        detailText = detailParts.length > 0 ? detailParts.join(' · ') : undefined;
    } else if (props.event.type === 'context-compaction') {
        const isPaused = props.event.phase === 'completed' && props.event.continuation === 'paused';
        testID = `transcript-event-context-compaction-${isPaused ? 'paused' : props.event.phase}`;
        if (props.event.phase === 'started' || props.event.phase === 'progress') {
            isLoading = true;
            text = t('message.contextCompactionStarted');
        } else if (props.event.phase === 'failed') {
            iconName = 'warning-outline';
            text = t('message.contextCompactionFailed');
        } else if (props.event.phase === 'cancelled') {
            iconName = 'close-circle-outline';
            text = t('message.contextCompactionCancelled');
        } else if (isPaused) {
            iconName = 'pause-circle-outline';
            text = t('message.contextCompactionPaused');
        } else {
            iconName = 'checkmark-circle-outline';
            text = t('message.contextCompactionCompleted');
        }
    } else if (props.event.type === 'limit-reached') {
        iconName = 'warning-outline';
        text = t('message.usageLimitUntil', { time: formatLimitReachedTime(props.event.endsAt) });
    } else if (props.event.type === 'connected-service-account-switch') {
        testID = 'transcript-event-connected-service-account-switch';
        iconName = 'swap-horizontal-outline';
        text = buildConnectedServiceAccountSwitchMessage({
            event: props.event,
            labelsByKey: settings.connectedServicesProfileLabelByKey,
        });
    } else if (props.event.type === 'provider-quota-wait') {
        testID = 'transcript-event-provider-quota-wait';
        iconName = 'time-outline';
        text = t('message.providerQuotaWait', { time: formatQuotaResetTime(props.event.resetAtMs) });
    } else if (props.event.type === 'provider-quota-recovered') {
        testID = 'transcript-event-provider-quota-recovered';
        iconName = 'checkmark-circle-outline';
        text = t('message.providerQuotaRecovered');
    } else if (props.event.type === 'connected-service-account-switch-attempt') {
        testID = 'transcript-event-connected-service-account-switch-attempt';
        const outcome = resolveConnectedServiceSwitchAttemptOutcome(props.event);
        if (outcome === 'failed' || outcome === 'terminal') {
            iconName = 'warning-outline';
            text = formatConnectedServiceSwitchAttemptFailureText(props.event);
        } else if (outcome === 'scheduled_retry') {
            iconName = 'time-outline';
            const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(props.event.diagnostic);
            text = diagnosticPresentation
                ? t(diagnosticPresentation.statusKey)
                : t('connectedServices.diagnostics.status.recovery_retry_scheduled');
        } else if (isObservedOnlyConnectedServiceSwitchAttempt(props.event, outcome)) {
            iconName = 'information-circle-outline';
            text = formatConnectedServiceSwitchAttemptSuccessText(props.event);
        } else {
            iconName = 'checkmark-circle-outline';
            text = formatConnectedServiceSwitchAttemptSuccessText(props.event);
        }
    } else if (props.event.type === 'connected-service-runtime-auth-recovery') {
        testID = 'transcript-event-connected-service-runtime-auth-recovery';
        if (props.event.status === 'retry_scheduled') {
            iconName = 'time-outline';
        } else if (props.event.status === 'dead_lettered') {
            iconName = 'warning-outline';
        } else if (props.event.status === 'cancelled') {
            iconName = 'close-circle-outline';
        } else {
            iconName = 'checkmark-circle-outline';
        }
        text = formatRuntimeAuthRecoveryText(props.event);
    } else if (props.event.type === 'connected-service-account-switch-deferral') {
        testID = 'transcript-event-connected-service-account-switch-deferral';
        iconName = 'time-outline';
        text = props.event.policy === 'defer_until_idle'
            ? t('message.connectedServiceSwitchDeferredIdle')
            : t('message.connectedServiceSwitchDeferred');
    } else if (props.event.type === 'connected-service-account-switch-deferral-completed') {
        testID = 'transcript-event-connected-service-account-switch-deferral-completed';
        const cancellationReasons = new Set(['aborted_after_timeout', 'switch_cancelled', 'session_terminated', 'daemon_shutdown']);
        if (cancellationReasons.has(props.event.reason)) {
            iconName = 'close-circle-outline';
            text = t('message.connectedServiceSwitchDeferralCancelled');
        } else {
            iconName = 'checkmark-circle-outline';
            text = t('message.connectedServiceSwitchDeferralCompleted');
        }
    } else if (props.event.type === 'connected-service-account-switch-deferral-superseded') {
        testID = 'transcript-event-connected-service-account-switch-deferral-superseded';
        iconName = 'swap-horizontal-outline';
        text = t('message.connectedServiceSwitchDeferralSuperseded');
    } else if (props.event.type === 'provider-state-sharing-degraded') {
        testID = 'transcript-event-provider-state-sharing-degraded';
        iconName = 'warning-outline';
        text = t('message.providerStateSharingDegraded');
    }

    const content = (
        <>
            <View style={styles.row}>
                <View style={styles.iconContainer}>
                    {isLoading ? (
                        <ActivitySpinner size={EVENT_SPINNER_SIZE} color={theme.colors.text.secondary} />
                    ) : (
                        <Ionicons name={iconName} size={EVENT_ICON_SIZE} color={theme.colors.text.secondary} />
                    )}
                </View>
                <View style={styles.textColumn} testID={testID ? `${testID}-body` : undefined}>
                    <Text selectable style={styles.text}>
                        {text}
                    </Text>
                    {detailText ? (
                        <Text selectable style={styles.detailText} testID={testID ? `${testID}-detail` : undefined}>
                            {detailText}
                        </Text>
                    ) : null}
                    {props.sessionId && isTerminalComposerDraftBlocked ? (
                        <View style={styles.actionRow}>
                            <TerminalComposerSubmitActionButton
                                sessionId={props.sessionId}
                                expectedStateAtMs={terminalComposerDraftBlockedStateAtMs}
                            />
                            <TerminalComposerClearActionButton
                                sessionId={props.sessionId}
                                expectedStateAtMs={terminalComposerDraftBlockedStateAtMs}
                            />
                        </View>
                    ) : null}
                </View>
            </View>
        </>
    );

    return (
        <View style={styles.container} testID={testID}>
            {testID === 'transcript-event-connected-service-account-switch' ? (
                <View testID="session-event-connected-service-account-switch">
                    {content}
                </View>
            ) : content}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        paddingBottom: 22,
        alignSelf: 'stretch',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    iconContainer: {
        width: EVENT_ICON_CONTAINER_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    textColumn: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
        flexShrink: 1,
    },
    detailText: {
        color: theme.colors.text.tertiary,
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '500',
        flexShrink: 1,
    },
    action: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 7,
        paddingVertical: 3,
        marginTop: 5,
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    actionText: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
    },
}));
