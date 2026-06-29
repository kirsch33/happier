import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { openSummaryShardIndexDb } from '../summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndexDb';
import { syncDeepIndexForSessionsOnce } from './syncDeepIndexForSessionsOnce';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';

describe('syncDeepIndexForSessionsOnce', () => {
  it('indexes provider semantic assistant messages and excludes tool and usage events', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-provider-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'agent' as const, content: { type: 'codex', data: { type: 'token_count' } }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', input: { command: 'echo forbidden-tool-text' } } }, meta: null },
        { seq: 3, createdAtMs: 1002, role: 'agent' as const, content: { type: 'codex', data: { type: 'message', message: 'codex assistant described sapphire indexing' } }, meta: null },
        { seq: 4, createdAtMs: 1003, role: 'agent' as const, content: { type: 'output', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'claude output described orchard retrieval' }] } } }, meta: null },
      ];

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      expect(deep.search({ query: 'sapphire', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      expect(deep.search({ query: 'orchard', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      expect(deep.search({ query: 'forbidden-tool-text', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: 10_000 }).lastDeepIndexedSeq).toBe(4);

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips ACP and Codex assistant payload content when includeAssistantAcpMessage is false', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-provider-gated-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'agent' as const, content: { type: 'acp', data: { type: 'message', message: 'hidden acp answer' } }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'codex', data: { type: 'message', message: 'hidden codex answer' } }, meta: null },
        { seq: 3, createdAtMs: 1002, role: 'agent' as const, content: { type: 'acp', data: { type: 'reasoning', message: 'hidden acp reasoning trace' } }, meta: null },
        { seq: 4, createdAtMs: 1003, role: 'agent' as const, content: { type: 'codex', data: { type: 'reasoning', message: 'hidden codex reasoning trace' } }, meta: null },
        { seq: 5, createdAtMs: 1004, role: 'agent' as const, content: { type: 'text', text: 'plain assistant answer stays indexed' }, meta: null },
        { seq: 6, createdAtMs: 1005, role: 'user' as const, content: { type: 'text', text: 'user memory stays indexed' }, meta: null },
      ] satisfies DecryptedTranscriptRow[];

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-gated'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          contentPolicy: {
            includeUserMessages: true,
            includeAssistantMessages: true,
            includeReasoning: true,
            includeToolSummaries: false,
            includeToolOutputs: false,
          },
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: false,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((row) => row.seq > afterSeq),
      });

      expect(deep.search({ query: 'hidden', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'reasoning trace', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'plain assistant', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      expect(deep.search({ query: 'user memory', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('indexes new transcript rows into the deep index and advances the cursor', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        {
          seq: 2,
          createdAtMs: 1001,
          role: 'agent' as const,
          content: { type: 'text', text: '[memory]' },
          meta: { happier: { kind: 'session_summary_shard.v1', payload: {} } },
        },
        { seq: 3, createdAtMs: 1002, role: 'user' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      const hits = deep.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe('sess-1');

      const cursors = tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: 10_000 });
      expect(cursors.lastDeepIndexedSeq).toBe(3);

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records queue telemetry for indexed deep sessions', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-telemetry-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'deep telemetry openclaw' }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'text', text: 'deep queue metrics' }, meta: null },
      ] satisfies DecryptedTranscriptRow[];

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-telemetry'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((row) => row.seq > afterSeq),
      });

      expect(tier1.getMemoryIndexQueueTelemetry()).toMatchObject({
        selectedSessionCount: 1,
        indexedSessionCount: 1,
        rawRowsFetched: 2,
        semanticRowsFound: 2,
        semanticRowsIndexedDeep: 2,
        deepChunkCount: 1,
        lastRun: expect.objectContaining({
          indexMode: 'deep',
          sessionsConsidered: 1,
          sessionsProcessed: 1,
          sessionsIndexed: 1,
          rawRowsFetched: 2,
          semanticRowsFound: 2,
          deepChunksCreated: 1,
        }),
      });

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores embeddings for newly indexed chunks when enabled', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-emb-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
          embeddings: {
            enabled: true,
            mode: 'custom',
            presetId: null,
            providerKind: 'test',
            modelId: 'm1',
            blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
            providerConfig: null,
          },
        },
        embedDocuments: async () => [new Float32Array([0.25, 0.5])],
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      const embeddingMap = deep.loadEmbeddings({
        provider: 'test',
        modelId: 'm1',
        keys: [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 2 }],
      });
      expect(embeddingMap.get('sess-1:1-2')).toBeTruthy();

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not resolve an embeddings provider when no chunks need embeddings', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-no-emb-work-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();
      const resolveEmbedDocuments = vi.fn(async () => {
        throw new Error('embedding provider should not be resolved without embedding work');
      });

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
          embeddings: {
            enabled: true,
            mode: 'custom',
            presetId: null,
            providerKind: 'test',
            modelId: 'm1',
            blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
            providerConfig: null,
          },
        },
        resolveEmbedDocuments,
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      });

      expect(resolveEmbedDocuments).not.toHaveBeenCalled();

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills embeddings for existing chunks when embeddings become available later', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-backfill-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 20_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
          embeddings: {
            enabled: true,
            mode: 'custom',
            presetId: null,
            providerKind: 'test',
            modelId: 'm1',
            blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
            providerConfig: null,
          },
        },
        embedDocuments: async () => [new Float32Array([0.25, 0.5])],
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      });

      const embeddingMap = deep.loadEmbeddings({
        provider: 'test',
        modelId: 'm1',
        keys: [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 2 }],
      });
      expect(embeddingMap.get('sess-1:1-2')).toBeTruthy();

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
