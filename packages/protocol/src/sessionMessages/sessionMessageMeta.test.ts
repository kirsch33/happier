import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('sessionMessages meta', () => {
  it('parses unknown sentFrom/permissionMode without throwing', () => {
    const parsed = (protocol as any).SessionMessageMetaSchema.parse({
      source: 'cli',
      sentFrom: '__future__',
      permissionMode: '__future__',
      extra: 'x',
    });

    expect(parsed.sentFrom).toBe('unknown');
    expect(parsed.permissionMode).toBe('default');
    expect((parsed as any).extra).toBe('x');
  });

  it('reads and writes the user-message delivery intent metadata', () => {
    const meta = protocol.withSessionUserMessageDeliveryIntentMeta(
      { source: 'ui', happierDeliveryIntentV1: 'caller-spoof' },
      'explicit_pending',
    );

    expect(protocol.readSessionUserMessageDeliveryIntentMeta(meta)).toBe('explicit_pending');
    expect((meta as any).happierDeliveryIntentV1).toBe('explicit_pending');
    expect(protocol.readSessionUserMessageDeliveryIntentMeta({
      happierDeliveryIntentV1: 'transcript_only',
    })).toBe('transcript_only');
    expect(protocol.readSessionUserMessageDeliveryIntentMeta({
      happierDeliveryIntentV1: '__future__',
    })).toBeNull();
  });
});
