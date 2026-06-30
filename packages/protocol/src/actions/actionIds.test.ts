import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';

describe('ActionIdSchema', () => {
  it('accepts known action ids', () => {
    expect(ActionIdSchema.parse('review.start')).toBe('review.start');
    expect(ActionIdSchema.parse('subagents.delegate.start')).toBe('subagents.delegate.start');
    expect(ActionIdSchema.parse('session.open')).toBe('session.open');
    expect(ActionIdSchema.parse('execution.run.start')).toBe('execution.run.start');
    expect(ActionIdSchema.parse('execution.run.wait')).toBe('execution.run.wait');
    expect(ActionIdSchema.parse('session.work_state.get')).toBe('session.work_state.get');
    expect(ActionIdSchema.parse('session.goal.get')).toBe('session.goal.get');
    expect(ActionIdSchema.parse('session.goal.set')).toBe('session.goal.set');
    expect(ActionIdSchema.parse('session.goal.clear')).toBe('session.goal.clear');
    expect(ActionIdSchema.parse('session.terminalComposer.clear')).toBe('session.terminalComposer.clear');
    expect(ActionIdSchema.parse('session.terminalComposer.submit')).toBe('session.terminalComposer.submit');
    expect(ActionIdSchema.parse('session.usageLimit.waitResume.enable')).toBe('session.usageLimit.waitResume.enable');
    expect(ActionIdSchema.parse('session.usageLimit.waitResume.cancel')).toBe('session.usageLimit.waitResume.cancel');
    expect(ActionIdSchema.parse('session.usageLimit.checkNow')).toBe('session.usageLimit.checkNow');
    expect(ActionIdSchema.parse('session.usageLimit.consumeResetCredit')).toBe('session.usageLimit.consumeResetCredit');
    expect(ActionIdSchema.parse('session.vendor_plugin_catalog.list')).toBe('session.vendor_plugin_catalog.list');
    expect(ActionIdSchema.parse('session.skill_catalog.list')).toBe('session.skill_catalog.list');
    expect(ActionIdSchema.parse('session.transcript.get')).toBe('session.transcript.get');
    expect(ActionIdSchema.parse('session.events.get')).toBe('session.events.get');
    expect(ActionIdSchema.parse('prompt_asset.export')).toBe('prompt_asset.export');
    expect(ActionIdSchema.parse('prompt_registry.install')).toBe('prompt_registry.install');
  });

  it('does not accept unknown action ids', () => {
    expect(() => ActionIdSchema.parse('execution.run.stream.start' as any)).toThrow();
  });
});
