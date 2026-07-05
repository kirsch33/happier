import { describe, expect, it } from 'vitest';

import { createClaudeOwnComposerTextLog } from './ownComposerTextLog';

describe('createClaudeOwnComposerTextLog (lane X, incident cmq8y3nlx user_draft starvation)', () => {
  it('matches a draft EXACTLY equal to a recorded injected prompt', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('please continue with the refactor');
    expect(log.matches('please continue with the refactor')).toBe(true);
    expect(log.matches('  please continue with the refactor \n')).toBe(true);
  });

  it('matches any single line of a recorded multiline injection (the composer shows the bottom line)', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('first instruction line\nsecond instruction line\r\nthird line');
    expect(log.matches('third line')).toBe(true);
    expect(log.matches('second instruction line')).toBe(true);
  });

  it('NEVER matches genuine user text, partial overlaps, or empty drafts', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('/effort medium');
    log.record('please continue');
    expect(log.matches('medium/effort medium')).toBe(false);
    expect(log.matches('please continue!')).toBe(false);
    expect(log.matches('please')).toBe(false);
    expect(log.matches('')).toBe(false);
    expect(log.matches('   ')).toBe(false);
  });

  it('matches a recent long prefix residue from a truncated own injection but not stale or short prefixes', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `please continue with the full implementation ${'x'.repeat(320)}`;
    log.record(longPrompt);

    expect(log.matches(longPrompt.slice(0, 280))).toBe(true);
    expect(log.matches(longPrompt.slice(0, 80))).toBe(false);

    nowMs += 5_001;
    expect(log.matches(longPrompt.slice(0, 280))).toBe(false);
  });

  it('matches a recent long visible fragment from an interrupted own injection', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `intro ${'alpha '.repeat(40)}middle ${'bravo '.repeat(40)}tail`;
    const visibleFragment = longPrompt.slice(120, 430);
    log.record(longPrompt);

    expect(log.matches(visibleFragment)).toBe(true);

    nowMs += 5_001;
    expect(log.matches(visibleFragment)).toBe(false);
  });

  it('matches a guarded medium fragment only for the current ambiguous batch', () => {
    const log = createClaudeOwnComposerTextLog();
    const prompt = [
      'CAPTAIN_DIRECT_UPDATE continue the DBTools App folder cleanup from the latest transcript',
      'preserve the Goal exactly and do not start unrelated architecture changes',
      'focus on the active pending message before asking for new direction',
    ].join(' ');
    const fragment = 'continue the DBTools App folder cleanup from the latest transcript preserve the Goal exactly';

    log.record(prompt);
    expect(fragment.length).toBeGreaterThanOrEqual(60);
    expect(fragment.length).toBeLessThan(200);
    expect(log.matches(fragment)).toBe(false);
    expect(log.matches(fragment, { currentBatchText: prompt })).toBe(true);
  });

  it('does not match short or low-token current-batch fragments', () => {
    const log = createClaudeOwnComposerTextLog();
    const prompt = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';
    log.record(prompt);

    expect(log.matches('alpha beta gamma delta epsilon', { currentBatchText: prompt })).toBe(false);
    expect(log.matches('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', {
      currentBatchText: `prefix xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx suffix`,
    })).toBe(false);
  });

  it('is bounded: oldest entries are evicted beyond the limit', () => {
    const log = createClaudeOwnComposerTextLog({ limit: 2 });
    log.record('one');
    log.record('two');
    log.record('three');
    expect(log.matches('one')).toBe(false);
    expect(log.matches('two')).toBe(true);
    expect(log.matches('three')).toBe(true);
  });
});

describe('createClaudeOwnComposerTextLog — soft-wrapped drafts (C11 live, runner pid 20327)', () => {
  it('matches a recorded single-line text whose draft rendering soft-wrapped across lines', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('QA-C11 M1: reply with exactly the word ALPHA and nothing else');
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA\nand nothing else')).toBe(true);
  });

  it('still never matches a wrapped draft whose words differ from any recorded text', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('QA-C11 M1: reply with exactly the word ALPHA and nothing else');
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA\nand nothing more')).toBe(false);
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA')).toBe(false);
  });
});
