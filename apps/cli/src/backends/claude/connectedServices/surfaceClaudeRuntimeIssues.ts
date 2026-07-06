import {
    readConnectedServiceLimitCategoryV1,
    type ConnectedServiceQuotaSnapshotV1,
    type ConnectedServiceLimitCategoryV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import {
    connectedServiceRuntimeAuthRecoveryCanOwnTurnFailure,
    projectConnectedServiceRuntimeAuthRecoveryReport,
} from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildNativeQuotaProfileId } from '@/daemon/connectedServices/quotas/nativeQuotaProfileId';
import { createConnectedServiceQuotaSnapshotDeliveryOutbox } from '@/daemon/connectedServices/quotas/connectedServiceQuotaSnapshotDeliveryOutbox';
import { notifyDaemonConnectedServiceQuotaSnapshot } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';

import { resolveClaudeRuntimeAuthRetryDecision } from './claudeRuntimeAuthRetryDecision';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import type { NormalizedProviderUsageLimitDetailsV1 } from './mapClaudeRateLimitEventToUsageDetails';

type RuntimeIssueSession = Readonly<{
    client: {
        sessionId: string;
        sendSessionEvent?: (event: SessionEventMessage) => void;
        updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
        sessionTurnLifecycle?: {
            failTurn?: (params: { provider: 'claude'; issue: SessionRuntimeIssueV1 }) => Promise<void> | void;
        };
    };
}>;

type RuntimeIssueUsageLimitDetails = NonNullable<SessionRuntimeIssueV1['usageLimit']>;
type RuntimeIssueConnectedService = NonNullable<RuntimeIssueUsageLimitDetails['connectedService']>;
type RuntimeIssueRecoveryProjectionDeduperState = Readonly<{
    key: string;
    surfacedAtMs: number;
}>;

const CLAUDE_RUNTIME_ISSUE_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS = 15_000;
const recentRecoveryProjectionByClient = new WeakMap<
    RuntimeIssueSession['client'],
    RuntimeIssueRecoveryProjectionDeduperState
>();

const claudeQuotaSnapshotDeliveryOutbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
    deliver: async ({ sessionId, serviceId, snapshot }) => await notifyDaemonConnectedServiceQuotaSnapshot({
        sessionId,
        serviceId,
        snapshot,
    }),
    retryDelayMs: 1_000,
    onDiagnostic: (diagnostic) => {
        logger.debug('[claude] Connected-service quota snapshot delivery diagnostic', diagnostic);
    },
});

function normalizeClaudePublicLimitCategory(
    value: NormalizedProviderUsageLimitDetailsV1['limitCategory'] | null | undefined,
): ConnectedServiceLimitCategoryV1 {
    return readConnectedServiceLimitCategoryV1(value) ?? 'usage_limit';
}

function commitRuntimeAuthUsageLimitRecoveryMetadata(
    session: RuntimeIssueSession,
    logPrefix: string,
): ((updater: (metadata: Metadata) => Metadata) => boolean) | undefined {
    if (!session.client.updateMetadata) return undefined;
    return (updater) => {
        updateMetadataBestEffort(
            session.client as Readonly<{
                updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
            }>,
            updater,
            logPrefix,
            'runtime_auth_usage_limit_recovery',
        );
        return true;
    };
}

function buildRuntimeAuthRecoveryProjectionDeduperKey(input: Readonly<{
    classification: ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>;
    recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
}>): string {
    const transcriptEvent = input.recoveryReport.projection?.transcriptEvent as
        | Readonly<Record<string, unknown>>
        | undefined;
    // Stable identity only (incident Jun-11 H-C): `retryAfterMs`/`nextRetryAtMs`/`statusMessage`
    // are recomputed from Date.now() per trigger, so embedding them made every key unique and
    // the deduper never matched.
    return JSON.stringify({
        statusCode: input.recoveryReport.statusCode ?? null,
        serviceId: input.classification?.serviceId ?? null,
        profileId: input.classification?.profileId ?? null,
        groupId: input.classification?.groupId ?? null,
        kind: input.classification?.kind ?? null,
        limitCategory: input.classification?.limitCategory ?? null,
        resetsAtMs: input.classification?.resetsAtMs ?? null,
        transcriptStatus: typeof transcriptEvent?.status === 'string' ? transcriptEvent.status : null,
    });
}

function shouldSuppressDuplicateRuntimeAuthRecoveryProjection(input: Readonly<{
    client: RuntimeIssueSession['client'];
    key: string;
    nowMs: number;
}>): boolean {
    const current = recentRecoveryProjectionByClient.get(input.client);
    if (!current) return false;
    if (current.key !== input.key) return false;
    return input.nowMs - current.surfacedAtMs <= CLAUDE_RUNTIME_ISSUE_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS;
}

function rememberRuntimeAuthRecoveryProjection(input: Readonly<{
    client: RuntimeIssueSession['client'];
    key: string;
    surfacedAtMs: number;
}>): void {
    recentRecoveryProjectionByClient.set(input.client, {
        key: input.key,
        surfacedAtMs: input.surfacedAtMs,
    });
}

function projectClaudeRuntimeAuthRecoveryReport(input: Readonly<{
    session: RuntimeIssueSession;
    recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
    classification: NonNullable<ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>>;
    logPrefix: string;
}>): void {
    const projectionKey = buildRuntimeAuthRecoveryProjectionDeduperKey({
        classification: input.classification,
        recoveryReport: input.recoveryReport,
    });
    const nowMs = Date.now();
    if (shouldSuppressDuplicateRuntimeAuthRecoveryProjection({
        client: input.session.client,
        key: projectionKey,
        nowMs,
    })) {
        return;
    }
    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
        report: input.recoveryReport,
        classification: input.classification,
        sendGenericStatusMessage: (message) => {
            if (!input.session.client.sendSessionEvent) return false;
            input.session.client.sendSessionEvent({ type: 'message', message });
            return true;
        },
        commitTypedProjection: (projection) => {
            if (!projection.transcriptEvent) return false;
            input.session.client.sendSessionEvent?.(projection.transcriptEvent);
            return Boolean(input.session.client.sendSessionEvent);
        },
        commitUsageLimitRecoveryMetadata: commitRuntimeAuthUsageLimitRecoveryMetadata(input.session, input.logPrefix),
    });
    if (result.emitted) {
        rememberRuntimeAuthRecoveryProjection({
            client: input.session.client,
            key: projectionKey,
            surfacedAtMs: nowMs,
        });
    }
}

function buildNativeClaudeQuotaProfileId(): string {
    return buildNativeQuotaProfileId({
        kind: 'native',
        providerId: 'claude',
        material: resolveConfiguredClaudeConfigDir({ env: process.env }),
    });
}

function buildClaudeRuntimeQuotaSnapshot(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    fetchedAt: number;
    serviceId: RuntimeIssueConnectedService['serviceId'];
    profileId: string;
}>): ConnectedServiceQuotaSnapshotV1 {
    const providerLimitId = params.details.providerLimitId ?? params.details.limitCategory ?? 'account';
    const resetAtMs = params.details.resetAtMs ?? params.details.overage?.resetAtMs ?? null;
    const utilizationPct = params.details.utilization;
    return {
        v: 1,
        serviceId: params.serviceId,
        profileId: params.profileId,
        providerId: 'claude',
        fetchedAt: params.fetchedAt,
        fetchedAtMs: params.fetchedAt,
        staleAfterMs: 300_000,
        staleAtMs: params.fetchedAt + 300_000,
        planLabel: params.details.planType,
        accountLabel: null,
        source: 'runtime_event',
        confidence: utilizationPct === null ? 'derived' : 'exact',
        evidence: {
            kind: 'claude_runtime_usage_limit',
            providerLimitId,
            observedAtMs: params.fetchedAt,
        },
        meters: [{
            meterId: providerLimitId,
            label: 'Usage limit',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct,
            usedPct: utilizationPct,
            remainingPct: utilizationPct === null ? null : Math.max(0, 100 - utilizationPct),
            resetsAt: resetAtMs,
            resetAtMs: resetAtMs,
            resetSource: resetAtMs === null ? 'unknown' : 'provider_event',
            status: 'ok',
            source: 'runtime_event',
            scope: 'unknown',
            limitScope: params.details.quotaScope,
            confidence: utilizationPct === null ? 'derived' : 'exact',
            providerLimitId,
            details: {
                providerLimitId,
                limitCategory: normalizeClaudePublicLimitCategory(params.details.limitCategory),
            },
        }],
    };
}

function buildClaudeRuntimeIssueUsageLimit(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    connectedService: RuntimeIssueConnectedService;
}>): RuntimeIssueUsageLimitDetails {
    const providerLimitId = params.details.providerLimitId ?? params.details.limitCategory ?? 'account';
    const resetAtMs = params.details.resetAtMs ?? params.details.overage?.resetAtMs ?? null;
    const remainingPct = params.details.utilization === null
        ? null
        : Math.max(0, 100 - params.details.utilization);
    return {
        ...params.details,
        limitCategory: normalizeClaudePublicLimitCategory(params.details.limitCategory),
        connectedService: params.connectedService,
        ...(remainingPct === null
            ? {}
            : {
                effectiveMeterId: providerLimitId,
                effectiveRemainingPct: remainingPct,
                allWindows: [{
                    meterId: providerLimitId,
                    scope: params.details.quotaScope,
                    remainingPct,
                    ...(resetAtMs === null ? {} : { resetAtMs }),
                    status: 'ok',
                }],
            }),
    };
}

function buildClaudeRateLimitRuntimeIssue(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    classification: NonNullable<ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>>;
    connectedService: RuntimeIssueConnectedService;
    occurredAt: number;
}>): SessionRuntimeIssueV1 {
    if (params.classification.kind === 'temporary_throttle') {
        return {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'provider_temporary_throttle',
            source: 'provider_status_error',
            occurredAt: params.occurredAt,
            provider: 'claude',
            sanitizedPreview: 'Provider is temporarily limiting requests',
            temporaryThrottle: {
                v: 1,
                retryAfterMs: params.classification.retryAfterMs ?? params.details.retryAfterMs ?? null,
                recoverability: 'retry',
            },
        };
    }
    const isProviderCapacity =
        params.classification.kind === 'capacity'
        || params.classification.limitCategory === 'capacity';
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        source: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        occurredAt: params.occurredAt,
        provider: 'claude',
        sanitizedPreview: isProviderCapacity ? 'Provider reported an error' : 'Usage limit reached',
        usageLimit: buildClaudeRuntimeIssueUsageLimit({
            details: params.details,
            connectedService: params.connectedService,
        }),
    };
}

export async function surfaceClaudeRateLimitRuntimeIssue(
    session: RuntimeIssueSession,
    details: NormalizedProviderUsageLimitDetailsV1,
    logPrefix: string,
): Promise<void> {
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? undefined;
    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection,
    });
    if (!classification) return;
    const connectedServiceId: RuntimeIssueConnectedService['serviceId'] =
        classification.serviceId === 'anthropic' ? 'anthropic' : 'claude-subscription';
    const profileId = classification.profileId ?? (selection ? null : buildNativeClaudeQuotaProfileId());
    const connectedService: RuntimeIssueConnectedService = {
        serviceId: connectedServiceId,
        profileId,
        groupId: classification.groupId,
    };
    // Incident Jun-11 H-B (trigger half) / FIX-3: rows imported from `subagents/agent-*.jsonl`
    // (isSidechain) describe a SUBAGENT request, not the parent turn. They must not fail the
    // parent turn and must not drive runtime-auth recovery. A sidechain LIMIT is still real
    // account-level evidence, so quota-snapshot recording below keeps consuming it — only the
    // turn-failure + recovery triggering is parent-turn-only.
    const sidechainSourced = details.sourcedFromSidechain === true;
    const occurredAt = Date.now();
    if (!sidechainSourced) {
        const issue = buildClaudeRateLimitRuntimeIssue({
            details,
            classification,
            connectedService,
            occurredAt,
        });
        await session.client.sessionTurnLifecycle?.failTurn?.({
            provider: 'claude',
            issue,
        });
    }
    // RD-QUO-2: in-band rate-limit evidence is the freshest usage signal for the real quota
    // subject. Record it for BOTH the native identity and the selected member (mirroring Codex)
    // so the canonical quota row does not lag behind the background fetcher for group sessions.
    if (profileId) {
        await claudeQuotaSnapshotDeliveryOutbox.enqueueAndFlush({
            sessionId: session.client.sessionId,
            serviceId: connectedServiceId,
            groupId: classification.groupId ?? (selection?.kind === 'group' ? selection.groupId : null),
            snapshot: buildClaudeRuntimeQuotaSnapshot({
                details,
                fetchedAt: occurredAt,
                serviceId: connectedServiceId,
                profileId,
            }),
        }).catch(() => undefined);
    }
    if (sidechainSourced) return;
    if (!selection) return;
    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        logPrefix,
    });
    projectClaudeRuntimeAuthRecoveryReport({
        session,
        recoveryReport,
        classification,
        logPrefix,
    });
}

function isSubagentScopedRuntimeAuthEvidence(error: unknown): boolean {
    // Incident 2026-06-12 cmq8y3nlx: a SUBAGENT transcript row ("Please run /login · API Error:
    // 401 Invalid authentication credentials", transient — auth was actually fine) was classified
    // as a session-level auth failure and the daemon restarted the healthy parent session,
    // killing all in-flight work. Subagent-scoped evidence describes a SUBAGENT request, not the
    // parent session's credentials: it must not fail the parent turn and must not drive
    // runtime-auth recovery. A REAL persistent auth failure also hits the parent's own requests
    // (shared credentials), which still routes to recovery. Mirrors the sidechain gating for
    // usage-limit evidence (Jun-11 H-B / FIX-3 in surfaceClaudeRateLimitRuntimeIssue).
    const record = error && typeof error === 'object' && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
    if (!record) return false;
    if (record.isSidechain === true) return true;
    const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
    return typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0;
}

export async function surfaceClaudeRuntimeAuthFailure(
    session: RuntimeIssueSession,
    error: unknown,
    logPrefix: string,
    opts: Readonly<{ reportTimeoutMs?: number }> = {},
): Promise<boolean> {
    if (isSubagentScopedRuntimeAuthEvidence(error)) return false;
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? null;

    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        error,
        selection: selection ?? undefined,
    });
    if (!classification) return false;

    const retryDecision = resolveClaudeRuntimeAuthRetryDecision(error);
    if (retryDecision.action === 'await_provider_retry') {
        return false;
    }

    const issue = classifyPrimarySessionRuntimeIssue({
        provider: 'claude',
        cause: 'auth_error',
        error,
    });
    if (!selection) {
        await session.client.sessionTurnLifecycle?.failTurn?.({
            provider: 'claude',
            issue,
        });
        return true;
    }

    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        ...(opts.reportTimeoutMs === undefined ? {} : { timeoutMs: opts.reportTimeoutMs }),
        logPrefix,
    });
    projectClaudeRuntimeAuthRecoveryReport({
        session,
        recoveryReport,
        classification,
        logPrefix,
    });
    if (connectedServiceRuntimeAuthRecoveryCanOwnTurnFailure(recoveryReport)) {
        return true;
    }
    await session.client.sessionTurnLifecycle?.failTurn?.({
        provider: 'claude',
        issue,
    });
    return true;
}
