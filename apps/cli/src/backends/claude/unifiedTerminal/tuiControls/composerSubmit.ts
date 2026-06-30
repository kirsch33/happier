import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
} from './controlRuntime';
import type { ClaudeScreenState } from './screenState';

const DEFAULT_USER_AUTHORIZED_COMPOSER_SUBMIT_SETTLE_MS = 250;

export type ClaudeComposerSubmitRefusalReason =
  | 'generating'
  | 'permission_prompt'
  | 'permission_editor'
  | 'trust_prompt'
  | 'switch_model_dialog'
  | 'resume_choice_dialog'
  | 'effort_change_dialog'
  | 'unrecognized_confirmation_dialog'
  | 'slash_picker'
  | 'selection_list';

export type ClaudeUserAuthorizedComposerSubmitResult =
  | Readonly<{ status: 'already_empty'; screen: ClaudeScreenState }>
  | Readonly<{ status: 'submitted'; screen: ClaudeScreenState }>
  | Readonly<{ status: 'refused'; reason: ClaudeComposerSubmitRefusalReason; screen: ClaudeScreenState }>
  | Readonly<{ status: 'unsupported'; reason?: string | undefined }>
  | Readonly<{ status: 'failed'; reason: string; screen?: ClaudeScreenState | undefined }>;

type ComposerSubmitScreenClassification =
  | Readonly<{ kind: 'empty'; screen: ClaudeScreenState }>
  | Readonly<{ kind: 'submittable_draft'; screen: ClaudeScreenState }>
  | Readonly<{ kind: 'refused'; reason: ClaudeComposerSubmitRefusalReason; screen: ClaudeScreenState }>;

function toComposerSubmitFailure(
  result: ReturnType<typeof captureFailureToResult> | NonNullable<ReturnType<typeof sendResultToFailure>>,
): ClaudeUserAuthorizedComposerSubmitResult {
  if (result.kind === 'unsupported') return { status: 'unsupported', reason: result.reason };
  if (result.kind === 'failed') return { status: 'failed', reason: result.reason };
  return { status: 'failed', reason: result.kind };
}

function classifyComposerSubmitScreen(state: ClaudeScreenState): ComposerSubmitScreenClassification {
  if (state.generating || state.queuedMessageBannerVisible) {
    return { kind: 'refused', reason: 'generating', screen: state };
  }
  if (state.permissionPromptVisible) {
    return { kind: 'refused', reason: 'permission_prompt', screen: state };
  }
  if (state.permissionEditorOpen) {
    return { kind: 'refused', reason: 'permission_editor', screen: state };
  }
  if (state.trustFolderPromptVisible) {
    return { kind: 'refused', reason: 'trust_prompt', screen: state };
  }
  if (state.switchModelDialogVisible) {
    return { kind: 'refused', reason: 'switch_model_dialog', screen: state };
  }
  if (state.resumeChoiceDialogVisible) {
    return { kind: 'refused', reason: 'resume_choice_dialog', screen: state };
  }
  if (state.effortChangeDialogVisible) {
    return { kind: 'refused', reason: 'effort_change_dialog', screen: state };
  }
  if (state.unrecognizedConfirmationDialogVisible) {
    return { kind: 'refused', reason: 'unrecognized_confirmation_dialog', screen: state };
  }
  if (state.slashPickerOpen) {
    return { kind: 'refused', reason: 'slash_picker', screen: state };
  }
  if (state.selectionListVisible) {
    return { kind: 'refused', reason: 'selection_list', screen: state };
  }
  if ((state.composerContent ?? '').length === 0) {
    return { kind: 'empty', screen: state };
  }
  return { kind: 'submittable_draft', screen: state };
}

function composerStillContainsDraft(state: ClaudeScreenState, draft: string): boolean {
  const current = state.composerContent ?? '';
  return draft.length > 0 && current.includes(draft);
}

export async function submitUserAuthorizedClaudeComposerDraft(params: Readonly<{
  port: TerminalControlPort;
  wait?: ((ms: number) => Promise<void>) | undefined;
  settleMs?: number | undefined;
}>): Promise<ClaudeUserAuthorizedComposerSubmitResult> {
  const settleMs = Math.max(
    0,
    Math.trunc(params.settleMs ?? DEFAULT_USER_AUTHORIZED_COMPOSER_SUBMIT_SETTLE_MS),
  );
  const wait = params.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  const initial = await captureScreenState(params.port);
  if (initial.kind !== 'state') return toComposerSubmitFailure(captureFailureToResult(initial));

  const initialClassification = classifyComposerSubmitScreen(initial.state);
  switch (initialClassification.kind) {
    case 'empty':
      return { status: 'already_empty', screen: initialClassification.screen };
    case 'refused':
      return {
        status: 'refused',
        reason: initialClassification.reason,
        screen: initialClassification.screen,
      };
    case 'submittable_draft':
      break;
  }

  const draft = initialClassification.screen.composerContent ?? '';

  const sendFailure = sendResultToFailure(await params.port.sendSpecialKey('Enter'));
  if (sendFailure) return toComposerSubmitFailure(sendFailure);

  await wait(settleMs);
  const afterEnter = await captureScreenState(params.port);
  if (afterEnter.kind !== 'state') return { status: 'submitted', screen: initialClassification.screen };
  if (!composerStillContainsDraft(afterEnter.state, draft)) {
    return { status: 'submitted', screen: initialClassification.screen };
  }

  const fallbackFailure = sendResultToFailure(await params.port.sendSpecialKey('CtrlJ'));
  if (fallbackFailure) return toComposerSubmitFailure(fallbackFailure);

  await wait(settleMs);
  const afterCtrlJ = await captureScreenState(params.port);
  if (afterCtrlJ.kind !== 'state') return { status: 'submitted', screen: initialClassification.screen };
  if (!composerStillContainsDraft(afterCtrlJ.state, draft)) {
    return { status: 'submitted', screen: initialClassification.screen };
  }

  const finalEnterFailure = sendResultToFailure(await params.port.sendSpecialKey('Enter'));
  if (finalEnterFailure) return toComposerSubmitFailure(finalEnterFailure);

  await wait(settleMs);
  const afterFinalEnter = await captureScreenState(params.port);
  if (afterFinalEnter.kind !== 'state') return { status: 'submitted', screen: initialClassification.screen };
  if (composerStillContainsDraft(afterFinalEnter.state, draft)) {
    return { status: 'failed', reason: 'submit_failed', screen: afterFinalEnter.state };
  }
  return { status: 'submitted', screen: initialClassification.screen };
}
