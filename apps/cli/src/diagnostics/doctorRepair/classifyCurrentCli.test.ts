import { describe, expect, it } from 'vitest';

import { shouldOfferCliUpdate } from './classifyCurrentCli';

describe('shouldOfferCliUpdate', () => {
  it('rejects the preview candidate exposed by the shared next tag for a dev CLI', () => {
    expect(shouldOfferCliUpdate({
      channel: 'dev',
      currentVersion: '0.2.11-dev.1788554100.2f319d7bec',
      candidateVersion: '0.2.11-preview.3',
    })).toBe(false);
  });

  it('offers a genuinely newer candidate on the same channel', () => {
    expect(shouldOfferCliUpdate({
      channel: 'dev',
      currentVersion: '0.2.11-dev.82',
      candidateVersion: '0.2.11-dev.83',
    })).toBe(true);
  });
});
