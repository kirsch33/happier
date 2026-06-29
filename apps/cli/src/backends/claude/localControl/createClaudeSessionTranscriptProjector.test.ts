import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';

import type { Session } from '../session';
import type { RawJSONLines } from '../types';
import { createClaudeSessionTranscriptProjector } from './createClaudeSessionTranscriptProjector';

// Boundary mock: ApiSessionClient is the server transport. updateMetadata applies the updater to
// an in-memory metadata object so assertions target resulting state, not call wiring.
function createSessionFixture(): Readonly<{
  session: Session;
  getMetadata: () => Metadata;
  getUpdateMetadataCallCount: () => number;
}> {
  let metadata: Metadata = {} as Metadata;
  let updateMetadataCallCount = 0;
  const session = {
    sessionId: 'claude-session-id',
    client: {
      sessionId: 'happy-session-id',
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        updateMetadataCallCount += 1;
        metadata = updater(metadata);
      },
    },
  } as unknown as Session;
  return {
    session,
    getMetadata: () => metadata,
    getUpdateMetadataCallCount: () => updateMetadataCallCount,
  };
}

function buildAssistantRow(params: Readonly<{
  uuid: string;
  model?: string;
  isSidechain?: boolean;
}>): RawJSONLines {
  return {
    uuid: params.uuid,
    type: 'assistant',
    ...(params.isSidechain !== undefined ? { isSidechain: params.isSidechain } : {}),
    message: {
      id: `msg_${params.uuid}`,
      role: 'assistant',
      ...(params.model !== undefined ? { model: params.model } : {}),
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  } as RawJSONLines;
}

describe('createClaudeSessionTranscriptProjector model adoption', () => {
  it('adopts the effective model from non-sidechain assistant transcript rows into session models metadata', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-fable-5',
    });
    expect(fixture.getMetadata().acpSessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-fable-5',
    });
  });

  it('does not rewrite metadata for repeated rows with the same model', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-fable-5' }));

    expect(fixture.getUpdateMetadataCallCount()).toBe(1);
  });

  it('adopts a model change mid-session', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-sonnet-4-6' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-sonnet-4-6',
    });
  });

  it('ignores sidechain assistant rows (subagents may run a different model)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-haiku-4-5', isSidechain: true }));

    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
  });

  it('ignores synthetic and empty model values', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: '<synthetic>' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: '  ' }));
    projector.observe(buildAssistantRow({ uuid: 'a-3' }));

    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
  });
});

describe('createClaudeSessionTranscriptProjector Stop hook fallback', () => {
  it('projects Stop hook last_assistant_message when no assistant transcript row arrives', () => {
    vi.useFakeTimers();
    try {
      const fixture = createSessionFixture();
      const projector = createClaudeSessionTranscriptProjector({
        session: fixture.session,
        logPrefix: '[test]',
      });
      const sendClaudeSessionMessage = fixture.session.client.sendClaudeSessionMessage as ReturnType<typeof vi.fn>;

      projector.observeHook({ hook_event_name: 'UserPromptSubmit' } as any);
      projector.observeHook({
        hook_event_name: 'Stop',
        last_assistant_message: 'DEBIAN_CLAUDE_SPAWN_OK',
      } as any);

      expect(sendClaudeSessionMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);

      expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
      expect(sendClaudeSessionMessage.mock.calls[0]?.[0]).toMatchObject({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'DEBIAN_CLAUDE_SPAWN_OK' }],
          stop_reason: 'end_turn',
        },
      });
      expect(sendClaudeSessionMessage.mock.calls[0]?.[1]).toEqual({
        importedFrom: 'claude-stop-hook-last-assistant-message',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the Stop hook fallback when the transcript assistant row arrives', () => {
    vi.useFakeTimers();
    try {
      const fixture = createSessionFixture();
      const projector = createClaudeSessionTranscriptProjector({
        session: fixture.session,
        logPrefix: '[test]',
      });
      const sendClaudeSessionMessage = fixture.session.client.sendClaudeSessionMessage as ReturnType<typeof vi.fn>;

      projector.observeHook({ hook_event_name: 'UserPromptSubmit' } as any);
      projector.observeHook({
        hook_event_name: 'Stop',
        last_assistant_message: 'fallback text',
      } as any);
      projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));

      vi.advanceTimersByTime(2_000);

      expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
      expect(sendClaudeSessionMessage.mock.calls[0]?.[0]).toMatchObject({
        type: 'assistant',
        uuid: 'a-1',
        message: {
          content: [{ type: 'text', text: 'hello' }],
        },
      });
      expect(sendClaudeSessionMessage.mock.calls[0]?.[1]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
