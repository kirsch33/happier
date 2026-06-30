import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
} from './controlRuntime';
import type { ClaudeScreenState } from './screenState';

const DEFAULT_USER_AUTHORIZED_COMPOSER_CLEAR_SETTLE_MS = 250;
// Same bounded keyboard behavior as the automatic own-leftover clear path. Do not use Escape here:
// live Claude Code 2.1.193 can interpret Escape as Rewind rather than line clear.
const MAX_USER_AUTHORIZED_COMPOSER_CLEAR_ATTEMPTS = 2;

export type ClaudeComposerClearRefusalReason =
  | 'generating'
  | 'permission_prompt'
  | 'permission_editor'
  | 'trust_prompt'
  | 'switch_model_dialog'
  | 'resume_choice_dialog'
  | 'effort_change_dialog'
  | 'unrecognized_confirmation_dialog'
  | 'slash_picker'
  | 'selection_list'
  | 'no_interactive_composer';

export type ClaudeUserAuthorizedComposerClearResult =
  | Readonly<{ status: 'already_empty'; screen: ClaudeScreenState }>
  | Readonly<{ status: 'cleared'; screen: ClaudeScreenState; attempts: number }>
  | Readonly<{ status: 'refused'; reason: ClaudeComposerClearRefusalReason; screen: ClaudeScreenState }>
  | Readonly<{ status: 'unsupported'; reason?: string | undefined }>
  | Readonly<{ status: 'failed'; reason: string; screen?: ClaudeScreenState | undefined }>;

type ComposerClearScreenClassification =
  | Readonly<{ kind: 'empty'; screen: ClaudeScreenState }>
  | Readonly<{ kind: 'clearable_draft'; screen: ClaudeScreenState }>
  | Readonly<{ kind: 'refused'; reason: ClaudeComposerClearRefusalReason; screen: ClaudeScreenState }>;

function toComposerClearFailure(
  result: ReturnType<typeof captureFailureToResult> | NonNullable<ReturnType<typeof sendResultToFailure>>,
): ClaudeUserAuthorizedComposerClearResult {
  if (result.kind === 'unsupported') return { status: 'unsupported', reason: result.reason };
  if (result.kind === 'failed') return { status: 'failed', reason: result.reason };
  return { status: 'failed', reason: result.kind };
}

function classifyComposerClearScreen(state: ClaudeScreenState): ComposerClearScreenClassification {
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
  if (!state.inputBoxInteractive || state.composerContent === null) {
    return { kind: 'refused', reason: 'no_interactive_composer', screen: state };
  }
  if (state.composerContent.length === 0) {
    return { kind: 'empty', screen: state };
  }
  return { kind: 'clearable_draft', screen: state };
}

function looksLikeUneditableCursorStartSuggestion(params: Readonly<{
  before: ClaudeScreenState;
  afterMoveToEnd: ClaudeScreenState;
  draft: string;
}>): boolean {
  return (
    params.draft.length > 0
    && !params.draft.includes('\n')
    && params.before.composerCursorRelation === 'at_content_start'
    && params.afterMoveToEnd.composerContent === params.draft
    && params.afterMoveToEnd.composerCursorRelation === 'at_content_start'
  );
}

export async function clearUserAuthorizedClaudeComposerDraft(params: Readonly<{
  port: TerminalControlPort;
  wait?: ((ms: number) => Promise<void>) | undefined;
  settleMs?: number | undefined;
}>): Promise<ClaudeUserAuthorizedComposerClearResult> {
  const settleMs = Math.max(
    0,
    Math.trunc(params.settleMs ?? DEFAULT_USER_AUTHORIZED_COMPOSER_CLEAR_SETTLE_MS),
  );
  const wait = params.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  const initial = await captureScreenState(params.port);
  if (initial.kind !== 'state') return toComposerClearFailure(captureFailureToResult(initial));

  const initialClassification = classifyComposerClearScreen(initial.state);
  switch (initialClassification.kind) {
    case 'empty':
      return { status: 'already_empty', screen: initialClassification.screen };
    case 'refused':
      return {
        status: 'refused',
        reason: initialClassification.reason,
        screen: initialClassification.screen,
      };
    case 'clearable_draft':
      break;
  }

  const draft = initialClassification.screen.composerContent ?? '';
  let lastScreen = initialClassification.screen;
  for (let attempt = 1; attempt <= MAX_USER_AUTHORIZED_COMPOSER_CLEAR_ATTEMPTS; attempt += 1) {
    const moveFailure = sendResultToFailure(await params.port.sendSpecialKey('CtrlE'));
    if (moveFailure && moveFailure.kind !== 'unsupported') return toComposerClearFailure(moveFailure);

    await wait(settleMs);
    const afterMoveToEnd = await captureScreenState(params.port);
    if (afterMoveToEnd.kind !== 'state') return toComposerClearFailure(captureFailureToResult(afterMoveToEnd));
    if (looksLikeUneditableCursorStartSuggestion({
      before: initialClassification.screen,
      afterMoveToEnd: afterMoveToEnd.state,
      draft,
    })) {
      return { status: 'already_empty', screen: afterMoveToEnd.state };
    }
    lastScreen = afterMoveToEnd.state;

    const clearFailure = sendResultToFailure(await params.port.sendSpecialKey('CtrlU'));
    if (clearFailure) return toComposerClearFailure(clearFailure);

    await wait(settleMs);

    const recaptured = await captureScreenState(params.port);
    if (recaptured.kind !== 'state') return toComposerClearFailure(captureFailureToResult(recaptured));

    const classification = classifyComposerClearScreen(recaptured.state);
    lastScreen = recaptured.state;
    switch (classification.kind) {
      case 'empty':
        return { status: 'cleared', screen: classification.screen, attempts: attempt };
      case 'refused':
        return { status: 'refused', reason: classification.reason, screen: classification.screen };
      case 'clearable_draft':
        break;
    }
  }

  return { status: 'failed', reason: 'clear_failed', screen: lastScreen };
}
