import { describe, expect, it } from 'vitest';

import { createClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { clearOwnLeftoverComposerDraft } from './ownComposerDraftGuard';

const OWN_TEXT = 'Reply with exactly: C11-baseline-ok';

function idleScreen(draft: string): string {
  return [
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
}

function generatingScreen(draft: string): string {
  return [
    '● Working…',
    '✶ Forging… (12s · esc to interrupt)',
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
  ].join('\n');
}

function plainSuggestionScreen(suggestion: string): string {
  return [
    '────────────────────────────────────────────────',
    `❯ ${suggestion}`,
    '────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
}

function ownLog(...texts: string[]) {
  const log = createClaudeOwnComposerTextLog();
  for (const text of texts) log.record(text);
  return log;
}

describe('clearOwnLeftoverComposerDraft (C11: idle pre-injection own-leftover guard)', () => {
  it('reports no_draft for an empty composer', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen('') }),
      sendClearKey: async () => {
        throw new Error('must not clear an empty composer');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('no_draft');
  });

  it('clears an own leftover draft (seeded/recorded text) and reports cleared', async () => {
    const captures = [idleScreen(OWN_TEXT), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('retries the bounded second clear when the first key leaves the draft behind', async () => {
    const captures = [idleScreen(OWN_TEXT), idleScreen(OWN_TEXT), idleScreen('')];
    let clears = 0;
    const attempts: number[] = [];
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
      onClearAttempt: (info) => attempts.push(info.attempt),
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 2 });
    expect(clears).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  it('gives up after the bounded attempts and reports clear_failed', async () => {
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('clear_failed');
    expect(clears).toBe(2);
  });

  it('NEVER touches a genuine user draft (no recorded match) and reports foreign_draft', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen('my half-typed genuine thought'),
        cursor: { x: 33, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a genuine user draft');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it('reports capture_style_unavailable when a plain capture has visible unowned composer text', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen('check the output') }),
      sendClearKey: async () => {
        throw new Error('must not clear unverified composer content');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_style_unavailable');
  });

  it('does not let unrelated chrome styling suppress the plain-capture placeholder fallback', async () => {
    const esc = String.fromCharCode(0x1b);
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: [
          `${esc}[38;2;136;136;136m────────────────────────────────────────────────${esc}[m`,
          '❯ check the output',
          `${esc}[38;2;136;136;136m────────────────────────────────────────────────${esc}[m`,
        ].join('\n'),
      }),
      sendClearKey: async () => {
        throw new Error('must not clear unverified composer content');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_style_unavailable');
  });

  it('reports capture_style_unavailable for arbitrary plain suggestion text even when the cursor is at the text start', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: plainSuggestionScreen('what can you help me with'),
        cursor: { x: 2, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear unverified composer content');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_style_unavailable');
  });

  it('reports no_draft for a known Try placeholder when tmux cursor proves the composer is empty', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: plainSuggestionScreen('Try "refactor <filepath>"'),
        cursor: { x: 2, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a known placeholder suggestion');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('no_draft');
  });

  it('never sends the clear key while the screen is generating (Escape would interrupt the turn)', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: generatingScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        throw new Error('must not press Escape while generating');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('generating');
  });

  it('stops clearing when the draft mutates into foreign text mid-episode (user started typing)', async () => {
    const captures = [
      { currentInput: idleScreen(OWN_TEXT) },
      { currentInput: idleScreen(`${OWN_TEXT} plus my new words`), cursor: { x: 63, y: 1 } },
    ];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => captures.shift() ?? { currentInput: idleScreen('') },
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
    expect(clears).toBe(1);
  });

  it('clears controller-vocabulary slash residue even when the registry cannot match it (RESUME2 respawn gap)', async () => {
    // Controller-typed slash commands are echo-suppressed out of the persisted transcript, so a
    // RESPAWNED runner's seeded registry can never contain them. The residue is still OUR OWN
    // (finite controller vocabulary: /model, /effort) and must clear instead of deadlocking idle
    // injection behind a foreign_draft classification forever.
    const captures = [idleScreen('/effort medium'), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      // Respawn-seeded registry: only persisted user prompts, no controller command texts.
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('clears concatenated controller slash residue (/effort medium/effort medium, U1 class) after respawn', async () => {
    const captures = [idleScreen('/effort medium/effort medium'), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('still treats non-controller slash drafts as foreign (user-typed /compact must never be cleared)', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen('/compact focus on the tests'),
        cursor: { x: 31, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a user-typed slash draft outside the controller vocabulary');
      },
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it('reports capture_failed when the screen capture throws', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => {
        throw new Error('pane gone');
      },
      sendClearKey: async () => undefined,
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_failed');
  });

  it('reports clear_failed when the clear key send throws', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        throw new Error('control port closed');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('clear_failed');
  });
});
