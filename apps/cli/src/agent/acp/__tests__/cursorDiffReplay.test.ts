import { describe, expect, it } from 'vitest';

import type { HandlerContext, SessionUpdate } from '../sessionUpdateHandlers';
import { handleToolCallUpdate } from '../sessionUpdateHandlers';
import { DefaultTransport } from '../../transport';
import { CursorTransport } from '@/backends/cursor/acp/transport';

type EmittedAgentMessage = Parameters<HandlerContext['emit']>[0];

function createCtx(transport: HandlerContext['transport']): HandlerContext & { emitted: EmittedAgentMessage[] } {
  const emitted: EmittedAgentMessage[] = [];
  return {
    transport,
    activeToolCalls: new Set(),
    finalizedToolCalls: new Set(),
    toolCallLifecycleStates: new Map(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallIdToInputMap: new Map(),
    idleTimeout: null,
    recentPromptHadChangeTitle: false,
    toolCallCountSincePrompt: 0,
    emit: (msg: EmittedAgentMessage) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
    emitted,
  } as unknown as HandlerContext & { emitted: any[] };
}

// Replay of the REAL captured cursor 2026.05.28 edit flow (.project/tmp/cursor-toolmap-probe/wire.ndjson):
// an `edit` tool_call with empty rawInput, then a completion carrying a `diff` content block whose
// oldText/newText are corrupted with unified-diff header lines. Asserts the generic pipeline + the
// CursorTransport sanitizer seam produce a clean diff the UI EditView can render.
describe('Cursor edit diff replay (transport sanitizer seam, end-to-end CLI)', () => {
  const TOOL_CALL_ID = 'call_wCWkbifCe5Vg7dEsnVdtxgR7\nctc_05fdc42ec7020894016a1931d941d08199866390afa57246cb';
  const FILE = '/Users/leeroy/Documents/Development/happier/remote-dev/.project/tmp/cursor-toolmap-probe/workspace/hello.py';

  function findDiffBlock(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value) && (value as Record<string, unknown>).type === 'diff') {
      return value as Record<string, unknown>;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
      const found = findDiffBlock(child);
      if (found) return found;
    }
    return null;
  }

  it('emits a clean diff (no -- /dev/null or ++ b/ header noise) under CursorTransport', () => {
    const ctx = createCtx(new CursorTransport());

    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: TOOL_CALL_ID,
        status: 'completed',
        kind: 'edit',
        title: 'Edit File',
        content: [
          {
            type: 'diff',
            path: FILE,
            oldText: '-- /dev/null\n',
            newText: `++ b/${FILE}\nprint("hello world")`,
          },
        ],
      } as SessionUpdate,
      ctx,
    );

    const diff = findDiffBlock(ctx.emitted);
    expect(diff).toMatchObject({ type: 'diff', path: FILE, oldText: '', newText: 'print("hello world")' });
    // Core gate: the sanitizer ran inside the real handler path, so no header noise leaked anywhere.
    expect(JSON.stringify(ctx.emitted)).not.toContain('/dev/null');
    expect(JSON.stringify(ctx.emitted)).not.toContain('++ b/');
  });

  it('leaves the diff untouched (with noise) under the generic DefaultTransport — proving the seam is provider-scoped', () => {
    const ctx = createCtx(new DefaultTransport('generic'));
    handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'generic-1',
        status: 'completed',
        kind: 'edit',
        content: [{ type: 'diff', path: FILE, oldText: '-- /dev/null\n', newText: '++ b/x\nhi' }],
      } as SessionUpdate,
      ctx,
    );
    // Generic transport does not repair the payload; the cursor fix stays provider-scoped.
    expect(JSON.stringify(ctx.emitted)).toContain('/dev/null');
  });
});
