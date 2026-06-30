import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import type { ActionId } from '@happier-dev/protocol';

const SESSION_TERMINAL_COMPOSER_SUBMIT_ACTION_ID = 'session.terminalComposer.submit' as ActionId;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isApprovalRequestCreated(value: unknown): boolean {
    return readRecord(value)?.kind === 'approval_request_created';
}

function resolveSubmitTerminalComposerFailureMessage(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) {
        return t('session.pendingMessages.errors.submitTerminalComposerFailed');
    }
    if (record.ok === true) {
        return null;
    }

    const status = typeof record.status === 'string' ? record.status : '';
    const errorCode = typeof record.errorCode === 'string' ? record.errorCode : '';
    if (status === 'unsupported' || errorCode === 'unsupported_action') {
        return t('session.pendingMessages.errors.submitTerminalComposerUnsupported');
    }
    if (status === 'not_safe' || status === 'generating' || status === 'dialog_open') {
        return t('session.pendingMessages.errors.submitTerminalComposerUnsafe');
    }
    if (typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0) {
        return record.errorMessage;
    }
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
        return record.error;
    }
    return t('session.pendingMessages.errors.submitTerminalComposerFailed');
}

export function useTerminalComposerSubmitAction(sessionId: string): Readonly<{
    busy: boolean;
    submitTerminalComposer: (options?: Readonly<{ expectedStateAtMs?: number | null }>) => Promise<void>;
}> {
    const [busy, setBusy] = React.useState(false);
    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
        [],
    );

    const submitTerminalComposer = React.useCallback(async (options?: Readonly<{ expectedStateAtMs?: number | null }>) => {
        if (busy) return;
        setBusy(true);
        try {
            const confirmed = await Modal.confirm(
                t('session.pendingMessages.submitTerminalComposer.confirmTitle'),
                t('session.pendingMessages.submitTerminalComposer.confirmBody'),
                { confirmText: t('session.pendingMessages.submitTerminalComposer.confirmButton') },
            );
            if (!confirmed) return;

            const expectedStateAtMs = options?.expectedStateAtMs;
            const result = await actionExecutor.execute(
                SESSION_TERMINAL_COMPOSER_SUBMIT_ACTION_ID,
                {
                    sessionId,
                    ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
                },
                {
                    defaultSessionId: sessionId,
                    surface: 'ui_button',
                },
            );
            if (result.ok !== true) {
                Modal.alert(t('common.error'), result.error ?? t('session.pendingMessages.errors.submitTerminalComposerFailed'));
                return;
            }
            if (isApprovalRequestCreated(result.result)) {
                return;
            }
            const failureMessage = resolveSubmitTerminalComposerFailureMessage(result.result);
            if (failureMessage) {
                Modal.alert(t('common.error'), failureMessage);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.submitTerminalComposerFailed'));
        } finally {
            setBusy(false);
        }
    }, [actionExecutor, busy, sessionId]);

    return { busy, submitTerminalComposer };
}
