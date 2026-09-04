import { describe, expect, it } from 'vitest';

import { doesVersionMatchReleaseChannel } from './index';

describe('doesVersionMatchReleaseChannel', () => {
  it('keeps preview releases out of the dev update channel', () => {
    expect(doesVersionMatchReleaseChannel('0.2.11-preview.3', 'dev')).toBe(false);
    expect(doesVersionMatchReleaseChannel('0.2.11-dev.82', 'dev')).toBe(true);
  });

  it('matches stable and preview releases only to their own channels', () => {
    expect(doesVersionMatchReleaseChannel('0.2.11', 'stable')).toBe(true);
    expect(doesVersionMatchReleaseChannel('0.2.11-dev.82', 'stable')).toBe(false);
    expect(doesVersionMatchReleaseChannel('0.2.11-preview.3', 'preview')).toBe(true);
    expect(doesVersionMatchReleaseChannel('0.2.11-dev.82', 'preview')).toBe(false);
  });
});
