import { chmodSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
import { configuration } from '@/configuration';

import { resolveMemoryIndexPaths } from './memoryIndexPaths';
import { openSummaryShardIndexDb, type SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { openDeepIndexDb, type DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { logger } from '@/ui/logger';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import { commitMemorySystemRecords } from '@/session/systemRecords/memory/commitMemorySystemRecords';
import { fetchMemorySummaryShardSystemRecords } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
import { syncDeepIndexForSessionsOnce } from './deepIndex/syncDeepIndexForSessionsOnce';
import { resolveEmbeddingsProvider } from './deepIndex/embeddings/resolveEmbeddingsProvider';
import {
  buildUnavailableMemoryEmbeddingsDiagnostics,
  resolveOperationalMemoryEmbeddingsSettings,
  type OperationalMemoryEmbeddingsDiagnostics,
} from './resolveOperationalMemoryEmbeddingsSettings';
import { selectSessionsForBackfill } from './inventory/selectSessionsForBackfill';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import type { EmbeddingsProviderResolution } from './deepIndex/embeddings/embeddingsProviderTypes';
import { isLegacyUnclassifiedTranscriptRow } from './semanticTranscript/legacyUnclassifiedTranscriptRows';
import { extractMemoryIndexableTranscriptItemFromDecryptedRow } from './semanticTranscript/extractMemoryIndexableTranscriptItem';

export type MemoryWorkerHandle = Readonly<{
  stop: () => void;
  reloadSettings: () => Promise<void>;
  ensureUpToDate: (sessionId?: string) => Promise<void>;
  getSettings: () => MemorySettingsV1;
  getEmbeddingsDiagnostics: () => OperationalMemoryEmbeddingsDiagnostics;
  getWorkerStatus?: () => Readonly<{
    state: 'disabled' | 'idle' | 'inventorying' | 'indexing' | 'waiting' | 'backoff' | 'error';
    lastTickAtMs: number | null;
    lastInventoryAtMs: number | null;
    currentSessionId: string | null;
    currentPhase: string | null;
  }>;
  getTier1DbPath: () => string | null;
  getDeepDbPath: () => string | null;
}>;

function bestEffortChmod700(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
}

function readSessionCreatedAtMs(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const createdAt = (raw as Record<string, unknown>).createdAt;
  const n = typeof createdAt === 'number' ? createdAt : Number(createdAt);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function dedupeAndOrderDecryptedRows(rows: readonly DecryptedTranscriptRow[]): DecryptedTranscriptRow[] {
  const bySeq = new Map<number, DecryptedTranscriptRow>();
  for (const row of rows) bySeq.set(row.seq, row);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function filterRowsByCoveragePolicy(params: Readonly<{
  sessionId: string;
  rows: readonly DecryptedTranscriptRow[];
  settings: MemorySettingsV1;
  nowMs: number;
}>): DecryptedTranscriptRow[] {
  const policy = params.settings.coveragePolicy ?? { type: 'full' as const };
  let rows = [...params.rows];

  if (policy.type === 'latest_days') {
    const minCreatedAtMs = params.nowMs - Math.max(1, Math.trunc(policy.days)) * 24 * 60 * 60 * 1000;
    rows = rows.filter((row) => row.createdAtMs >= minCreatedAtMs);
  } else if (policy.type === 'since_enabled') {
    const enabledAtMs = Math.max(0, Math.trunc(params.settings.enabledAtMs ?? 0));
    if (enabledAtMs > 0) rows = rows.filter((row) => row.createdAtMs >= enabledAtMs);
  } else if (policy.type === 'latest_messages') {
    const maxSemanticMessages = Math.max(1, Math.trunc(policy.maxSemanticMessagesPerSession));
    let semanticCount = 0;
    const selectedReversed: DecryptedTranscriptRow[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      selectedReversed.push(row);
      if (extractMemoryIndexableTranscriptItemFromDecryptedRow({
        sessionId: params.sessionId,
        row,
        index: i,
        contentPolicy: params.settings.contentPolicy,
      })) {
        semanticCount += 1;
      }
      if (semanticCount >= maxSemanticMessages) break;
    }
    rows = selectedReversed.reverse();
  }

  return rows;
}

export async function startMemoryWorker(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>) => Promise<DecryptedTranscriptRow[]>;
    fetchCommittedSummaryShards?: (sessionId: string) => Promise<import('@happier-dev/protocol').SessionSummaryShardV1[]>;
  }>;
}>): Promise<MemoryWorkerHandle> {
  let stopped = false;
  const paths = resolveMemoryIndexPaths();
  let settings: MemorySettingsV1 = DEFAULT_MEMORY_SETTINGS;
  let tier1: SummaryShardIndexDbHandle | null = null;
  let deep: DeepIndexDbHandle | null = null;
  let inventoryLoop: SingleFlightIntervalLoopHandle | null = null;
  let inventoryLoopIntervalMs: number | null = null;
  let workLoop: SingleFlightIntervalLoopHandle | null = null;
  let workLoopIntervalMs: number | null = null;
  let candidateSessionIds: string[] = [];
  let candidateCursor = 0;
  const candidateAllowInitialBackfillSessionIds = new Set<string>();
  let inventoryCursor: string | null = null;
  let inventoryHasNext = true;
  let inventoryBackfillPolicy: MemorySettingsV1['backfillPolicy'] = 'new_only';
  const inventorySeenSessionIds = new Set<string>();
  const candidateObservedSeqBySessionId = new Map<string, number>();
  const sessionCtxCache = new Map<string, SessionEncryptionContext>();
  const sessionModeCache = new Map<string, SessionStoredContentEncryptionMode>();
  let workerState: 'disabled' | 'idle' | 'inventorying' | 'indexing' | 'waiting' | 'backoff' | 'error' = 'idle';
  let lastTickAtMs: number | null = null;
  let lastInventoryAtMs: number | null = null;
  let currentSessionId: string | null = null;
  let currentPhase: string | null = null;
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  let embeddingsDiagnostics: OperationalMemoryEmbeddingsDiagnostics =
    buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings);

  const refreshEmbeddingsDiagnostics = async (): Promise<EmbeddingsProviderResolution | null> => {
    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    if (!embeddings?.enabled || !embeddings.providerConfig || !embeddings.providerKind || !embeddings.modelId) {
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
      return null;
    }

    const cacheDir = join(paths.modelsDir, 'transformers');
    try {
      mkdirSync(cacheDir, { recursive: true });
      bestEffortChmod700(cacheDir);
    } catch {
      // best-effort
    }

    const resolution = await resolveEmbeddingsProvider({
      settings: embeddings,
      cacheDir,
      settingsSecretsReadKeys,
    });
    embeddingsDiagnostics = {
      mode: resolution.mode,
      presetId: resolution.presetId,
      providerKind: resolution.providerKind,
      modelId: resolution.modelId,
      runtimeState: resolution.runtimeState,
      usingFallback: resolution.usingFallback,
    };
    return resolution;
  };

  const refreshEmbeddingsDiagnosticsForSettingsLoad = async (): Promise<void> => {
    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);
    if (embeddings?.providerKind !== 'local_transformers') {
      await refreshEmbeddingsDiagnostics();
      return;
    }

    // Local Transformers initializes a native model runtime and can retain gigabytes on small hosts.
    // Keep status/config visible, but defer loading until indexing actually has chunks to embed.
    embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
  };

  const hasCustomDeps = Boolean(params.deps);
  const deps =
    params.deps ??
    ({
      fetchDecryptedTranscriptPageAfterSeq: async (
        args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>,
      ): Promise<DecryptedTranscriptRow[]> => {
        try {
          let ctx = sessionCtxCache.get(args.sessionId);
          if (!ctx) {
            const raw = await fetchSessionById({ token: params.credentials.token, sessionId: args.sessionId });
            if (!raw) return [];
            ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
            sessionCtxCache.set(args.sessionId, ctx);
            sessionModeCache.set(args.sessionId, resolveSessionStoredContentEncryptionMode(raw));
          }

          const encrypted = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            roles: ['user', 'agent'],
            scope: 'main',
          });

          const legacy = await fetchEncryptedTranscriptMessagesPage({
            token: params.credentials.token,
            sessionId: args.sessionId,
            afterSeq: args.afterSeq,
            limit: args.limit,
            scope: 'main',
          });
          const decrypted = decryptTranscriptRows({
            ctx,
            rows: [
              ...encrypted.messages,
              ...legacy.messages.filter(isLegacyUnclassifiedTranscriptRow),
            ],
          });
          return decrypted;
        } catch (error) {
          logger.debug('[memoryWorker] Failed to fetch/decrypt transcript page (best-effort)', {
            message: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      },
    } as const);

  const fetchSelectedDecryptedRowsForLightIndex = async (sessionId: string): Promise<DecryptedTranscriptRow[]> => {
    try {
      let ctx = sessionCtxCache.get(sessionId);
      if (!ctx) {
        const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
        if (!raw) return [];
        ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
        sessionCtxCache.set(sessionId, ctx);
        sessionModeCache.set(sessionId, resolveSessionStoredContentEncryptionMode(raw));
      }

      const pageLimit = Math.max(1, Math.min(500, Math.trunc(configuration.memoryMaxTranscriptWindowMessages)));
      const policy = settings.coveragePolicy ?? { type: 'full' as const };
      const maxRoleRows = policy.type === 'latest_messages'
        ? Math.max(pageLimit, Math.trunc(policy.maxSemanticMessagesPerSession) * 4)
        : 100_000;
      type EncryptedTranscriptMessageRow = Awaited<ReturnType<typeof fetchEncryptedTranscriptMessagesPage>>['messages'][number];
      const rows: EncryptedTranscriptMessageRow[] = [];
      let beforeSeq: number | undefined;

      while (rows.length < maxRoleRows) {
        const page = await fetchEncryptedTranscriptMessagesPage({
          token: params.credentials.token,
          sessionId,
          limit: Math.min(pageLimit, maxRoleRows - rows.length),
          ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
          roles: ['user', 'agent'],
          scope: 'main',
        });
        rows.push(...page.messages);
        if (!page.hasMore || typeof page.nextBeforeSeq !== 'number') break;
        beforeSeq = page.nextBeforeSeq;
      }

      const legacy = await fetchEncryptedTranscriptMessagesPage({
        token: params.credentials.token,
        sessionId,
        limit: pageLimit,
        scope: 'main',
      });
      rows.push(...legacy.messages.filter(isLegacyUnclassifiedTranscriptRow));

      const decrypted = dedupeAndOrderDecryptedRows(decryptTranscriptRows({ ctx, rows }));
      return filterRowsByCoveragePolicy({
        sessionId,
        rows: decrypted,
        settings,
        nowMs: Date.now(),
      });
    } catch (error) {
      logger.debug('[memoryWorker] Failed to fetch/decrypt selected transcript rows (best-effort)', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const stopLoop = (): void => {
    inventoryLoop?.stop();
    inventoryLoop = null;
    inventoryLoopIntervalMs = null;
    workLoop?.stop();
    workLoop = null;
    workLoopIntervalMs = null;
    candidateSessionIds = [];
    candidateCursor = 0;
    candidateAllowInitialBackfillSessionIds.clear();
    inventoryCursor = null;
    inventoryHasNext = true;
    inventoryBackfillPolicy = 'new_only';
    inventorySeenSessionIds.clear();
    candidateObservedSeqBySessionId.clear();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopLoop();
    try {
      tier1?.close();
    } catch {
      // best-effort
    }
    tier1 = null;
    try {
      deep?.close();
    } catch {
      // best-effort
    }
    deep = null;
  };

  const syncHintsForSessions = async (
    sessionIds: readonly string[],
    options?: Readonly<{ allowInitialBackfillWhenUninitializedSessionIds?: readonly string[] }>,
  ): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    if (sessionIds.length === 0) return;

    await syncMemoryHintsForSessionsOnce({
      sessionIds,
      ...(options?.allowInitialBackfillWhenUninitializedSessionIds
        ? { allowInitialBackfillWhenUninitializedSessionIds: options.allowInitialBackfillWhenUninitializedSessionIds }
        : {}),
      initialCursorSeqBySessionId: candidateObservedSeqBySessionId,
      tier1,
      settings: {
        enabled: settings.enabled,
        indexMode: settings.indexMode,
        backfillPolicy: settings.backfillPolicy,
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.contentPolicy,
        hints: {
          updateMode: settings.hints.updateMode,
          idleDelayMs: settings.hints.idleDelayMs,
          windowSizeMessages: settings.hints.windowSizeMessages,
          targetShardMessages: settings.hints.targetShardMessages,
          minShardMessages: settings.hints.minShardMessages,
          targetShardChars: settings.hints.targetShardChars,
          maxShardChars: settings.hints.maxShardChars,
          maxSummaryChars: settings.hints.maxSummaryChars,
          maxKeywords: settings.hints.maxKeywords,
          maxEntities: settings.hints.maxEntities,
          maxDecisions: settings.hints.maxDecisions,
          maxRunsPerHour: settings.hints.maxRunsPerHour,
          maxShardsPerSession: settings.hints.maxShardsPerSession,
          failureBackoffBaseMs: settings.hints.failureBackoffBaseMs,
          failureBackoffMaxMs: settings.hints.failureBackoffMaxMs,
        },
      },
      now: () => Date.now(),
      fetchRecentDecryptedRows: async (sessionId) => hasCustomDeps
        ? await deps.fetchDecryptedTranscriptPageAfterSeq({
          sessionId,
          afterSeq: 0,
          limit: configuration.memoryMaxTranscriptWindowMessages,
        })
        : await fetchSelectedDecryptedRowsForLightIndex(sessionId),
      fetchCommittedSummaryShards: async (sessionId) => {
        if (deps.fetchCommittedSummaryShards) {
          return await deps.fetchCommittedSummaryShards(sessionId);
        }
        try {
          let ctx = sessionCtxCache.get(sessionId);
          let mode = sessionModeCache.get(sessionId);
          if (!ctx || !mode) {
            const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
            if (!raw) return [];
            ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
            mode = resolveSessionStoredContentEncryptionMode(raw);
            sessionCtxCache.set(sessionId, ctx);
            sessionModeCache.set(sessionId, mode);
          }
          return await fetchMemorySummaryShardSystemRecords({
            token: params.credentials.token,
            sessionId,
            mode,
            ctx,
          });
        } catch (error) {
          logger.debug('[memoryWorker] Failed to fetch memory summary system records (best-effort)', {
            message: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      },
      runSummarizer: async (prompt, sessionId) => {
        return await runMemoryHintsExecutionRun({
          cwd: configuration.activeServerDir,
          sessionId,
          backendId: settings.hints.summarizerBackendId,
          modelId: settings.hints.summarizerModelId,
          permissionMode: settings.hints.summarizerPermissionMode,
          prompt,
        });
      },
      commitArtifacts: async ({ sessionId, shardPayload, synopsisPayload }) => {
        let ctx = sessionCtxCache.get(sessionId);
        if (!ctx) {
          const raw = await fetchSessionById({ token: params.credentials.token, sessionId });
          if (!raw) return;
          ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
          sessionCtxCache.set(sessionId, ctx);
        }
        const mode = sessionModeCache.get(sessionId) ?? 'e2ee';
        await commitMemorySystemRecords({
          credentials: params.credentials,
          sessionId,
          mode,
          ctx,
          shard: { sessionId, payload: shardPayload },
          synopsis: synopsisPayload ? { sessionId, payload: synopsisPayload } : null,
        });
      },
    });
  };

  const syncDeepForSessions = async (sessionIds: readonly string[]): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (settings.indexMode !== 'deep') return;
    if (!tier1) return;
    if (!deep) return;
    if (sessionIds.length === 0) return;

    const embeddings = resolveOperationalMemoryEmbeddingsSettings(settings.embeddings);

    await syncDeepIndexForSessionsOnce({
      sessionIds,
      tier1,
      deep,
      settings: {
        enabled: settings.enabled,
        indexMode: 'deep',
        coveragePolicy: settings.coveragePolicy,
        contentPolicy: settings.contentPolicy,
        deep: {
          maxChunkChars: settings.deep.maxChunkChars,
          maxChunkMessages: settings.deep.maxChunkMessages,
          minChunkMessages: settings.deep.minChunkMessages,
          includeAssistantAcpMessage: settings.deep.includeAssistantAcpMessage,
          failureBackoffBaseMs: settings.deep.failureBackoffBaseMs,
          failureBackoffMaxMs: settings.deep.failureBackoffMaxMs,
        },
        ...(embeddings ? { embeddings } : {}),
      },
      now: () => Date.now(),
      fetchDecryptedTranscriptPageAfterSeq: deps.fetchDecryptedTranscriptPageAfterSeq,
      resolveEmbedDocuments: async () => {
        const embeddingsResolution = await refreshEmbeddingsDiagnostics();
        return embeddingsResolution?.provider?.embedDocuments ?? null;
      },
    });
  };

  const applySettings = async (next: MemorySettingsV1): Promise<void> => {
    settings = next;
    if (stopped) return;

    if (!settings.enabled) {
      workerState = 'disabled';
      currentSessionId = null;
      currentPhase = null;
      embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);
      stopLoop();
      if (tier1) {
        try {
          tier1.close();
        } catch {
          // best-effort
        }
        tier1 = null;
      }
      if (deep) {
        try {
          deep.close();
        } catch {
          // best-effort
        }
        deep = null;
      }
      if (settings.deleteOnDisable) {
        await rm(paths.memoryDir, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }

    workerState = 'idle';
    embeddingsDiagnostics = buildUnavailableMemoryEmbeddingsDiagnostics(settings.embeddings);

    mkdirSync(paths.memoryDir, { recursive: true });
    bestEffortChmod700(paths.memoryDir);
    mkdirSync(paths.modelsDir, { recursive: true });
    bestEffortChmod700(paths.modelsDir);

    if (inventoryBackfillPolicy !== settings.backfillPolicy) {
      inventoryBackfillPolicy = settings.backfillPolicy;
      inventoryCursor = null;
      inventoryHasNext = true;
      inventorySeenSessionIds.clear();
      candidateSessionIds = [];
      candidateCursor = 0;
      candidateAllowInitialBackfillSessionIds.clear();
      candidateObservedSeqBySessionId.clear();
    }

    if (!tier1) {
      tier1 = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      tier1.init();
    }

    if (settings.indexMode === 'deep') {
      if (!deep) {
        deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
        deep.init();
      }
    } else if (deep) {
      try {
        deep.close();
      } catch {
        // best-effort
      }
      deep = null;
    }

    await refreshEmbeddingsDiagnosticsForSettingsLoad();

    // Background indexing runs only in daemon mode.
    if (configuration.isDaemonProcess) {
      const inventoryIntervalMs = Math.max(5_000, Math.trunc(settings.worker.inventoryRefreshIntervalMs));
      if (!inventoryLoop || inventoryLoopIntervalMs !== inventoryIntervalMs) {
        inventoryLoop?.stop();
        inventoryLoopIntervalMs = inventoryIntervalMs;
        inventoryLoop = startSingleFlightIntervalLoop({
          intervalMs: inventoryIntervalMs,
          task: async () => {
            if (stopped) return;
            if (!settings.enabled) return;
            workerState = 'inventorying';
            lastInventoryAtMs = Date.now();
            currentPhase = 'inventory';
            if (settings.backfillPolicy === 'new_only') {
              const page = await fetchSessionsPage({
                token: params.credentials.token,
                activeOnly: false,
                limit: settings.worker.sessionListPageLimit,
              });
              const enabledAtMs = Math.max(0, Math.trunc(settings.enabledAtMs ?? 0));
              candidateAllowInitialBackfillSessionIds.clear();
              candidateObservedSeqBySessionId.clear();
              candidateSessionIds = page.sessions
                .map((session) => {
                  const id = typeof session.id === 'string' ? String(session.id).trim() : '';
                  if (!id) return null;
                  const seq = typeof session.seq === 'number' && Number.isFinite(session.seq)
                    ? Math.max(0, Math.trunc(session.seq))
                    : 0;
                  candidateObservedSeqBySessionId.set(id, seq);
                  if (enabledAtMs > 0 && readSessionCreatedAtMs(session) >= enabledAtMs) {
                    candidateAllowInitialBackfillSessionIds.add(id);
                  }
                  return id;
                })
                .filter((id): id is string => Boolean(id));
              candidateCursor = 0;
              inventoryCursor = null;
              inventoryHasNext = true;
              inventorySeenSessionIds.clear();
              inventoryBackfillPolicy = settings.backfillPolicy;
              workerState = 'idle';
              currentPhase = null;
              return;
            }

            candidateAllowInitialBackfillSessionIds.clear();
            const cursor = inventoryHasNext ? inventoryCursor ?? undefined : undefined;
            const page = await fetchSessionsPage({
              token: params.credentials.token,
              cursor,
              activeOnly: false,
              limit: settings.worker.sessionListPageLimit,
            });

            const selected = selectSessionsForBackfill({
              sessions: page.sessions,
              backfillPolicy: settings.backfillPolicy,
              nowMs: Date.now(),
            });

            for (const id of selected.sessionIds) {
              if (inventorySeenSessionIds.has(id)) continue;
              inventorySeenSessionIds.add(id);
              const row = page.sessions.find((session) => session.id === id);
              const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq)
                ? Math.max(0, Math.trunc(row.seq))
                : 0;
              candidateObservedSeqBySessionId.set(id, seq);
              candidateSessionIds.push(id);
            }

            if (inventoryHasNext) {
              if (selected.shouldStopPaging) {
                inventoryCursor = null;
                inventoryHasNext = false;
              } else {
                inventoryCursor = page.nextCursor;
                inventoryHasNext = Boolean(page.hasNext);
              }
            } else {
              inventoryCursor = null;
            }
            workerState = 'idle';
            currentPhase = null;
          },
          onError: (error) => {
            workerState = 'error';
            logger.debug('[memoryWorker] Inventory refresh failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        inventoryLoop.trigger();
      }

      const tickIntervalMs = Math.max(500, Math.trunc(settings.worker.tickIntervalMs));
      if (!workLoop || workLoopIntervalMs !== tickIntervalMs) {
        workLoop?.stop();
        workLoopIntervalMs = tickIntervalMs;
        workLoop = startSingleFlightIntervalLoop({
          intervalMs: tickIntervalMs,
          task: async () => {
            if (stopped) return;
            if (!settings.enabled) return;
            if (!tier1) return;
            if (candidateSessionIds.length === 0) return;
            workerState = 'indexing';
            lastTickAtMs = Date.now();
            currentPhase = 'tick';

            const maxSessions = Math.max(1, Math.trunc(settings.worker.maxSessionsPerTick));
            const sessionIds: string[] = [];
            const allowInitialBackfillWhenUninitializedSessionIds: string[] = [];
            for (let i = 0; i < maxSessions; i += 1) {
              if (candidateSessionIds.length === 0) break;
              const idx = candidateCursor % candidateSessionIds.length;
              const id = candidateSessionIds[idx];
              candidateCursor = (candidateCursor + 1) % candidateSessionIds.length;
              if (!id) continue;
              sessionIds.push(id);
              currentSessionId = id;
              if (candidateAllowInitialBackfillSessionIds.has(id)) {
                allowInitialBackfillWhenUninitializedSessionIds.push(id);
              }
            }
            currentSessionId = null;

            if (sessionIds.length === 0) {
              currentSessionId = null;
              currentPhase = null;
              workerState = 'idle';
              return;
            }
            await syncHintsForSessions(sessionIds, { allowInitialBackfillWhenUninitializedSessionIds });
            await syncDeepForSessions(sessionIds);

            if (tier1) {
              const mbToBytes = (mb: number): number => Math.max(0, Math.trunc(mb)) * 1024 * 1024;
              await enforceMemoryDiskBudgets({
                tier1,
                deep,
                tier1DbPath: paths.tier1DbPath,
                deepDbPath: paths.deepDbPath,
                budgets: {
                  tier1Bytes: mbToBytes(settings.budgets.maxDiskMbLight),
                  deepBytes: mbToBytes(settings.budgets.maxDiskMbDeep),
                },
              });
            }
            workerState = 'idle';
            currentPhase = null;
          },
          onError: (error) => {
            workerState = 'error';
            logger.debug('[memoryWorker] Tick failed (best-effort)', {
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        workLoop.trigger();
      }
    }
  };

  const reloadSettings = async (): Promise<void> => {
    if (stopped) return;
    const next = await readMemorySettingsFromDisk();
    await applySettings(next);
  };

  const ensureSessionsUpToDate = async (sessionIds: readonly string[]): Promise<void> => {
    if (stopped) return;
    if (!settings.enabled) return;
    if (!tier1) return;
    const normalizedSessionIds = sessionIds
      .map((sessionId) => String(sessionId ?? '').trim())
      .filter((sessionId) => sessionId.length > 0);
    if (normalizedSessionIds.length === 0) return;

    await syncDeepForSessions(normalizedSessionIds);

    if (settings.indexMode === 'hints') {
      const allowInitialBackfillWhenUninitializedSessionIds: string[] = [];
      for (const sessionId of normalizedSessionIds) {
        if (settings.backfillPolicy === 'new_only' && settings.enabledAtMs > 0) {
          const raw = await fetchSessionById({ token: params.credentials.token, sessionId }).catch(() => null);
          if (raw && readSessionCreatedAtMs(raw) >= settings.enabledAtMs) {
            allowInitialBackfillWhenUninitializedSessionIds.push(sessionId);
          }
        }
      }
      await syncHintsForSessions(normalizedSessionIds, { allowInitialBackfillWhenUninitializedSessionIds });
    }
  };

  const ensureUpToDate = async (_sessionId?: string): Promise<void> => {
    if (stopped) return;
    await reloadSettings();
    if (!settings.enabled) return;
    if (!tier1) return;

    const sessionId = String(_sessionId ?? '').trim();
    if (sessionId) {
      await ensureSessionsUpToDate([sessionId]);
      return;
    }

    const page = await fetchSessionsPage({
      token: params.credentials.token,
      activeOnly: false,
      limit: settings.worker.sessionListPageLimit,
    });
    const selected = selectSessionsForBackfill({
      sessions: page.sessions,
      backfillPolicy: settings.backfillPolicy,
      nowMs: Date.now(),
    });
    await ensureSessionsUpToDate(selected.sessionIds);
  };

  await reloadSettings();

  return {
    stop,
    reloadSettings,
    ensureUpToDate,
    getSettings: () => settings,
    getEmbeddingsDiagnostics: () => embeddingsDiagnostics,
    getWorkerStatus: () => ({
      state: settings.enabled ? workerState : 'disabled',
      lastTickAtMs,
      lastInventoryAtMs,
      currentSessionId,
      currentPhase,
    }),
    getTier1DbPath: () => (tier1 ? paths.tier1DbPath : null),
    getDeepDbPath: () => (deep ? paths.deepDbPath : null),
  };
}
