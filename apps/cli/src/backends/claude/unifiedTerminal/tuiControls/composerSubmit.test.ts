import { describe, expect, it } from 'vitest';

import { submitUserAuthorizedClaudeComposerDraft } from './composerSubmit';
import { createFakeControlPort } from './fakeControlPort';

const EMPTY_COMPOSER = [
  '╭───────────────────────────────────────────────╮',
  '│ >                                               │',
  '╰───────────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n');

function idleDraft(draft: string): string {
  return [
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n');
}

function generatingDraft(draft: string): string {
  return [
    '● Working…',
    '✶ Forging… (12s · esc to interrupt)',
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
  ].join('\n');
}

const GENERATING_WITHOUT_COMPOSER = [
  '● Working…',
  '✶ Forging… (12s · esc to interrupt)',
].join('\n');

const ASSISTANT_OPTIONS_WITH_PLAIN_CAPTURE_DRAFT = [
  'How do you want to proceed?',
  '',
  '<options>',
  '<option>2 — pure v2, concept-local Shell/ only</option>',
  '<option>3 — reconciliation: Shell/ everywhere, top-level + concept-local</option>',
  '</options>',
  '',
  '────────────────────────────────────────────────',
  '❯ 3 — reconciliation: Shell/ everywhere, top-level + concept-local',
  '────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const LIVE_FOLLOWUP_PLAIN_CAPTURE_DRAFT = [
  '  Want me to map this skeleton onto the actual current src/ layout next?',
  '',
  '✻ Worked for 1m 1s',
  '                         control this session from your phone · /remote-control',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ map it onto the actual current src/ layout',
  '────────────────────────────────────────────────────────────────────────────────',
  '  akirsch@debian-dev:/home/akirsch/dbtools',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const LIVE_UNEDITABLE_CONTEXTUAL_SUGGESTION = [
  "  One edge to decide: GM's Converters/Behaviors/ — do those go to a GM-local UI/",
  "  or get hoisted to a shared/core UI/ if other tools reuse them? That's the",
  '  next fork.',
  '',
  '✻ Baked for 24s',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ GM converters local or shared?',
  '────────────────────────────────────────────────────────────────────────────────',
  '  akirsch@debian-dev:/home/akirsch/dbtools',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const PERMISSION_PROMPT = [
  'Bash(rm -rf tmp)',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, tell Claude what to do differently',
].join('\n');

describe('submitUserAuthorizedClaudeComposerDraft', () => {
  it('submits a safe visible boxed composer draft with Enter', async () => {
    const port = createFakeControlPort({ captures: [idleDraft('send this draft'), idleDraft('send this draft'), EMPTY_COMPOSER] });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
    expect(port.log.map((entry) => entry.type)).toEqual(['capture', 'key', 'capture', 'key', 'capture']);
  });

  it('submits a visible draft with Enter when tmux reports the cursor after the content', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('Reply only SUBMITTED.'), idleDraft('Reply only SUBMITTED.'), EMPTY_COMPOSER],
      cursor: { x: 24, y: 1 },
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
  });

  it('submits a plain capture draft below assistant options without requiring clear-style evidence', async () => {
    const port = createFakeControlPort({
      captures: [ASSISTANT_OPTIONS_WITH_PLAIN_CAPTURE_DRAFT, ASSISTANT_OPTIONS_WITH_PLAIN_CAPTURE_DRAFT, EMPTY_COMPOSER],
      cursors: [{ x: 2, y: 8 }, { x: 70, y: 8 }, { x: 2, y: 8 }],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
  });

  it('submits a live-shaped plain follow-up draft even when tmux reports the cursor at the text start', async () => {
    const port = createFakeControlPort({
      captures: [LIVE_FOLLOWUP_PLAIN_CAPTURE_DRAFT, LIVE_FOLLOWUP_PLAIN_CAPTURE_DRAFT, EMPTY_COMPOSER],
      cursors: [{ x: 2, y: 5 }, { x: 45, y: 5 }, { x: 2, y: 5 }],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
  });

  it('does not submit an uneditable contextual suggestion that ignores CtrlE', async () => {
    const port = createFakeControlPort({
      captures: [LIVE_UNEDITABLE_CONTEXTUAL_SUGGESTION, LIVE_UNEDITABLE_CONTEXTUAL_SUGGESTION],
      cursors: [{ x: 2, y: 7 }, { x: 2, y: 7 }],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('already_empty');
    expect(port.sentKeys).toEqual(['CtrlE']);
  });

  it('submits after CtrlJ inserts a continuation line by sending a final Enter', async () => {
    const draft = 'Reply only STARTSUBMIT.';
    const afterCtrlJ = [
      '────────────────────────────────────────────────',
      '❯ ',
      `  ${draft}`,
      '────────────────────────────────────────────────',
    ].join('\n');
    const port = createFakeControlPort({
      captures: [idleDraft(draft), idleDraft(draft), idleDraft(draft), afterCtrlJ, EMPTY_COMPOSER],
      cursors: [{ x: 2, y: 1 }, { x: 27, y: 1 }, { x: 27, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 1 }],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter', 'CtrlJ', 'Enter']);
  });

  it('reports already_empty without pressing Enter when the composer has no draft', async () => {
    const port = createFakeControlPort({ captures: [EMPTY_COMPOSER] });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('already_empty');
    expect(port.sentKeys).toEqual([]);
  });

  it('submits a visible draft while Claude is generating so the user can unblock the pending queue', async () => {
    const port = createFakeControlPort({
      captures: [generatingDraft('queued words'), generatingDraft('queued words'), EMPTY_COMPOSER],
      cursors: [{ x: 4, y: 3 }, { x: 16, y: 3 }, { x: 4, y: 1 }],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('submitted');
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
  });

  it('refuses while Claude is generating without an interactive composer draft', async () => {
    const port = createFakeControlPort({ captures: [GENERATING_WITHOUT_COMPOSER] });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'refused', reason: 'generating' });
    expect(port.sentKeys).toEqual([]);
  });

  it('refuses while a dialog owns input', async () => {
    const port = createFakeControlPort({ captures: [PERMISSION_PROMPT] });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'refused', reason: 'permission_prompt' });
    expect(port.sentKeys).toEqual([]);
  });

  it('reports host_dead when recapture fails after cursor movement', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('draft to submit'), idleDraft('draft to submit')],
      failCaptureAtIndexes: [1],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(port.sentKeys).toEqual(['CtrlE']);
  });

  it('reports host_dead when the selected submit key cannot be sent', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('draft to submit'), idleDraft('draft to submit')],
      failSendKeys: ['Enter'],
    });

    const result = await submitUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(port.sentKeys).toEqual(['CtrlE', 'Enter']);
  });
});
