import { describe, expect, it } from 'vitest';

import { clearUserAuthorizedClaudeComposerDraft } from './composerClear';
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

const PERMISSION_PROMPT = [
  'Bash(rm -rf tmp)',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, tell Claude what to do differently',
].join('\n');

const UNRECOGNIZED_DIALOG = [
  'Archive this conversation?',
  '',
  '❯ 1. Yes, archive',
  '  2. No, go back',
].join('\n');

const ASSISTANT_OPTIONS_WITH_DRAFT = [
  'How do you want to proceed?',
  '',
  '<options>',
  '<option>Re-post the full R1-R5 detail</option>',
  '<option>Go one-by-one, starting fresh at R1</option>',
  '</options>',
  '',
  '────────────────────────────────────────────────',
  '❯ Go one-by-one, starting fresh at R1',
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

const TRANSCRIPT_ONLY = [
  'Claude finished the previous answer.',
  'No composer visible in this capture.',
].join('\n');

describe('clearUserAuthorizedClaudeComposerDraft', () => {
  it('reports already_empty without pressing Escape when the composer has no draft', async () => {
    const port = createFakeControlPort({ captures: [EMPTY_COMPOSER] });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result.status).toBe('already_empty');
    expect(port.sentKeys).toEqual([]);
  });

  it('clears a safe visible user draft with Escape and verifies the composer is empty', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('my half-typed genuine thought'), EMPTY_COMPOSER],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(port.sentKeys).toEqual(['Escape']);
    expect(port.log.map((entry) => entry.type)).toEqual(['capture', 'key', 'capture']);
  });

  it('allows a user-authorized slash draft clear when no slash picker or dialog owns input', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('/compact focus the summary'), EMPTY_COMPOSER],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('retries once when the first Escape leaves the draft behind', async () => {
    const port = createFakeControlPort({
      captures: [
        idleDraft('draft survives once'),
        idleDraft('draft survives once'),
        EMPTY_COMPOSER,
      ],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'cleared', attempts: 2 });
    expect(port.sentKeys).toEqual(['Escape', 'Escape']);
  });

  it('reports clear_failed after bounded clear attempts leave the draft visible', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('stuck draft'), idleDraft('stuck draft'), idleDraft('stuck draft')],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'clear_failed' });
    expect(port.sentKeys).toEqual(['Escape', 'Escape']);
  });

  it('clears a draft below assistant option prose that says "How do you want to proceed?"', async () => {
    const port = createFakeControlPort({
      captures: [ASSISTANT_OPTIONS_WITH_DRAFT, EMPTY_COMPOSER],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('clears a live-shaped plain follow-up draft even when tmux reports the cursor at the text start', async () => {
    const port = createFakeControlPort({
      captures: [LIVE_FOLLOWUP_PLAIN_CAPTURE_DRAFT, EMPTY_COMPOSER],
      cursor: { x: 2, y: 5 },
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('refuses to clear while Claude is generating because Escape would interrupt the turn', async () => {
    const port = createFakeControlPort({ captures: [generatingDraft('queued words')] });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'refused', reason: 'generating' });
    expect(port.sentKeys).toEqual([]);
  });

  it.each([
    ['permission prompt', PERMISSION_PROMPT, 'permission_prompt'],
    ['unrecognized confirmation dialog', UNRECOGNIZED_DIALOG, 'unrecognized_confirmation_dialog'],
    ['unknown screen without composer', TRANSCRIPT_ONLY, 'no_interactive_composer'],
  ])('refuses to clear an unsafe %s', async (_name, capture, reason) => {
    const port = createFakeControlPort({ captures: [capture] });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'refused', reason });
    expect(port.sentKeys).toEqual([]);
  });

  it('reports host_dead when capture fails before any keypress', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('unreachable')],
      failCaptureAtIndexes: [0],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(port.sentKeys).toEqual([]);
  });

  it('reports host_dead when recapture fails after Escape', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('draft to discard'), EMPTY_COMPOSER],
      failCaptureAtIndexes: [1],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('reports host_dead when Escape cannot be sent', async () => {
    const port = createFakeControlPort({
      captures: [idleDraft('draft to discard')],
      failSendKeys: ['Escape'],
    });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      settleMs: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(port.sentKeys).toEqual(['Escape']);
  });
});
