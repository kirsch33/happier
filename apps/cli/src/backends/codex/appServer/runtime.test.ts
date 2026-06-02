import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import {
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    type AccountSettings,
    type SessionMediaItemV1,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Metadata } from '@/api/types';
import type { AgentMessage } from '@/agent';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { runScmCommand } from '@/scm/runtime';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

import { createCodexAppServerRuntime } from './runtime';
import { createCodexAppServerProcessEnv, createCodexAppServerTestEnvScope } from './testkit/fakeCodexAppServer';

type CommittedSnapshotBody = Readonly<{
    type?: string;
    message?: string;
    text?: string;
    sidechainId?: string | null;
}>;

type TestCommittedMessageOptions = Readonly<{
    localId?: string;
    meta?: Readonly<{
        happierStreamSegmentV1?: Readonly<{
            segmentState?: string;
        }>;
    }>;
}>;

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;

function createSessionTurnLifecycleTestDouble(overrides: Partial<SessionTurnLifecycle> = {}): SessionTurnLifecycle {
    return {
        beginTurn: vi.fn(async () => ({ turnId: 'session-turn-1' })),
        attachProviderTurnId: vi.fn(async () => {}),
        appendTranscriptAnchors: vi.fn(async () => {}),
        completeTurn: vi.fn(async () => {}),
        failTurn: vi.fn(async () => {}),
        cancelTurn: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        markRollbackEligible: vi.fn(async () => {}),
        markRolledBack: vi.fn(async () => {}),
        ...overrides,
    };
}

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    requestLogPath: string;
    rateLimitReadResult?: unknown;
    rollbackError?: Readonly<{
        code: number;
        message: string;
    }>;
    rejectInterruptAsNoActiveTurn?: boolean;
    rejectSteerAsNoActiveTurn?: boolean;
    rejectPermissionsProfile?: boolean;
    rejectGoalMethods?: boolean;
    rejectGoalMethodsAsInvalidRequest?: boolean;
    emitGoalContinuationTurn?: boolean;
    emitGoalContinuationItemsBeforeStarted?: boolean;
    rejectReviewStartMethodUnavailable?: boolean;
    rejectStructuredTurnInput?: boolean;
    rejectStructuredTurnInputAsStringShape?: boolean;
    rejectStructuredSteerInput?: boolean;
    rejectStructuredSteerInputAsStringShape?: boolean;
    emitResumeContinuationUserInputRequest?: boolean;
    emitResumeTurnStartedBeforeResponse?: boolean;
    rejectPermissionsProfileAsStringShape?: boolean;
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
        'import readline from "node:readline";',
        `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'for await (const line of rl) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null, result: msg.result ?? null, error: msg.error ?? null }) + "\\n");',
        '    if (msg.method === "initialize") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "initialized") continue;',
        '    if (msg.method === "thread/start") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectPermissionsProfileAsStringShape === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        if (msg.params?.persistExtendedHistory !== true || msg.params?.experimentalRawEvents !== true) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/start flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null, activePermissionProfile: msg.params?.permissions ?? null } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/resume") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectPermissionsProfileAsStringShape === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        if (msg.params?.persistExtendedHistory !== true) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/resume flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const adoptsOverrideThread = Object.prototype.hasOwnProperty.call(msg.params ?? {}, "model") || Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier");',
        '        const resumedThreadId = adoptsOverrideThread ? "thread-overrides" : (msg.params?.threadId ?? null);',
        `        if (${JSON.stringify(params.emitResumeTurnStartedBeforeResponse === true)}) {`,
        '            const resumeTurnId = "turn-resume-start-before-response";',
        '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: resumedThreadId, turn: { id: resumeTurnId } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: resumedThreadId, turnId: resumeTurnId, itemId: "resume_msg_1", delta: "Still working" } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: resumedThreadId, model: msg.params?.model ?? (adoptsOverrideThread ? "gpt-5.4-mini" : "gpt-5.4"), serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null, activePermissionProfile: msg.params?.permissions ?? null } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: resumedThreadId, model: msg.params?.model ?? (adoptsOverrideThread ? "gpt-5.4-mini" : "gpt-5.4"), serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null, activePermissionProfile: msg.params?.permissions ?? null } }) + "\\n");',
        `        if (${JSON.stringify(params.emitResumeContinuationUserInputRequest === true)}) {`,
        '            const resumeTurnId = "turn-resume-request";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "resume-request-input", method: "item/tool/requestUserInput", params: { threadId: resumedThreadId, turnId: resumeTurnId, itemId: "resume_tool_input", item: { id: "resume_tool_input", type: "mcpToolCall", server: "happier", tool: "confirm", arguments: { prompt: "continue" } }, questions: [{ id: "resume_question", question: "Continue?" }] } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: resumedThreadId, turn: { id: resumeTurnId } } }) + "\\n");',
        '            }, 30);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "account/rateLimits/read") {',
        `        process.stdout.write(JSON.stringify({ id: msg.id, result: ${JSON.stringify(params.rateLimitReadResult ?? { plan_type: 'pro', primary: { used_percent: 12, resets_at: '2026-05-17T12:00:00.000Z' } })} }) + "\\n");`,
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/get") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/get" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params?.threadId ?? "thread-started", objective: "Ship the Codex app-server lane", status: "active", updatedAt: "2026-05-13T10:00:00.000Z" } } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/set") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/set" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params?.threadId ?? "thread-started", objective: msg.params?.objective ?? "Current objective", status: msg.params?.status ?? "active", tokenBudget: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "tokenBudget") ? msg.params.tokenBudget : undefined, updatedAt: "2026-05-13T10:05:00.000Z" } } }) + "\\n");',
        '        process.stdout.write(JSON.stringify({ method: "thread/goal/updated", params: { threadId: msg.params?.threadId ?? "thread-started", goal: { threadId: msg.params?.threadId ?? "thread-started", objective: msg.params?.objective ?? "Current objective", status: msg.params?.status ?? "active", tokenBudget: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "tokenBudget") ? msg.params.tokenBudget : undefined, updatedAt: "2026-05-13T10:05:00.000Z" } } }) + "\\n");',
        `        if (${JSON.stringify(params.emitGoalContinuationTurn === true)}) {`,
        '            const goalThreadId = msg.params?.threadId ?? "thread-started";',
        '            const goalTurnId = "turn-goal-continuation";',
        `            if (${JSON.stringify(params.emitGoalContinuationItemsBeforeStarted === true)}) {`,
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "Goal continuation" } }) + "\\n");',
        '                }, 5);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_msg_1", type: "agentMessage", text: "Goal continuation" } } }) + "\\n");',
        '                }, 6);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '                }, 9);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '                }, 15);',
        '                continue;',
        '            }',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "Goal " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_cmd_1", type: "commandExecution", command: "git status", cwd: "/repo" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_cmd_1", type: "commandExecution", stdout: "clean", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "continuation" } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_msg_1", type: "agentMessage", text: "Goal continuation" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '            }, 15);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/clear") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/clear" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        process.stdout.write(JSON.stringify({ method: "thread/goal/cleared", params: { threadId: msg.params?.threadId ?? "thread-started" } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "plugin/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { marketplaces: [{ name: "codex", path: null, interface: null, plugins: [{ id: "reviewer@codex", name: "reviewer", source: { type: "remote" }, interface: { displayName: "Reviewer", shortDescription: "Review session context" }, enabled: true, installed: true }] }] } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "skills/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ cwd: msg.params?.cwds?.[0] ?? null, skills: [{ name: "debugger", description: "Debug code", interface: { displayName: "Debugger", shortDescription: "Debug code" }, path: "/skills/debugger/SKILL.md", scope: "repo", enabled: true }], errors: [] }] } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/name/set") {',
        '        if (msg.params?.name === "fail-native-title-sync") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "native title sync failed" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "collaborationMode/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }, { name: "Plan", mode: "plan", reasoning_effort: "medium" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "model/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" }, { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/compact/start") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "manual_compact_1", type: "contextCompaction" } } }) + "\\n");',
        '        }, 8);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "manual_compact_1", type: "contextCompaction" } } }) + "\\n");',
        '        }, 12);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: "turn-manual-compact" } } }) + "\\n");',
        '        }, 16);',
        '        continue;',
        '    }',
        '    if (msg.method === "review/start") {',
        `        if (${JSON.stringify(params.rejectReviewStartMethodUnavailable === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: review/start" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const turnId = "turn-review-native";',
        '        if (typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("invalid-review-input")) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: review target is invalid" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const reviewText = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("different-final") ? "Native review body" : "Native review text";',
        '        const finalText = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("different-final") ? "Different final assistant text" : reviewText;',
        '        const completionDelayMs = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("delayed-review") ? 50 : 15;',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, reviewThreadId: msg.params?.threadId ?? null } }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_entered_1", type: "enteredReviewMode", review: "current changes" } } }) + "\\n");',
        '        }, 5);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_entered_1", type: "enteredReviewMode", review: "current changes" } } }) + "\\n");',
        '        }, 6);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_exited_1", type: "exitedReviewMode", review: reviewText } } }) + "\\n");',
        '        }, 7);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_exited_1", type: "exitedReviewMode", review: reviewText } } }) + "\\n");',
        '        }, 8);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_msg_1", type: "agentMessage", text: finalText } } }) + "\\n");',
        '        }, 9);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, completionDelayMs);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/start") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectStructuredTurnInput === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: structured turn input unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectStructuredTurnInputAsStringShape === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const text = Array.isArray(msg.params?.input) ? String(msg.params.input[0]?.text ?? "unknown") : "unknown";',
        '        const matchingTurnStartCount = (await readFile(requestLogPath, "utf8").catch(() => "")).split("\\n").filter((line) => { try { const entry = JSON.parse(line); return entry.method === "turn/start" && Array.isArray(entry.params?.input) && String(entry.params.input[0]?.text ?? "") === text; } catch { return false; } }).length;',
        '        const turnId = matchingTurnStartCount > 1 ? `turn-${text}-${matchingTurnStartCount}` : `turn-${text}`;',
        '        const completionDelayMs = text === "cancel-me" ? 50 : 15;',
        '        if (text === "usage-limit-before-turn-response") {',
        '            process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, 15);',
        '            continue;',
        '        }',
        '        const respondDelayMs = text === "steer-delay" ? 60 : 0;',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '        }, respondDelayMs);',
        '        setTimeout(() => {',
            '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, respondDelayMs + 5);',
        '        if (text === "bridge-streams") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "Hello " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_1", delta: "thinking" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "cmd_1", type: "commandExecution", command: "ls -la", cwd: "/repo" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "cmd_1", type: "commandExecution", stdout: "done", exitCode: 0 } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_1", type: "mcpToolCall", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_1", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "patch_1", type: "fileChange", auto_approved: true, changes: [{ path: "src/file.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1,2 @@\\n-old line\\n+old line\\n+new line\\n" }] } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "patch_1", type: "fileChange", stdout: "patched", success: true } } }) + "\\n");',
        '            }, 13);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_1", type: "reasoning", content: ["thinking hard"] } } }) + "\\n");',
        '            }, 14);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_1", type: "agentMessage", text: "Hello world" } } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "mcp-elicitation-request", method: "mcpServer/elicitation/request", params: { toolUseId: "mcp_tool_1", invocation: { server: "happier", tool: "change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-callid") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "mcp-elicitation-request-callid", method: "mcpServer/elicitation/request", params: { callId: "call_test_1", invocation: { tool: "mcp__happier__change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-meta") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_params: { title: "New Title" } }, message: "Allow the happier MCP server to run tool \\"change_title\\"?", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-meta-tool-title") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_title: "change_title", tool_params: { title: "New Title" } }, requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-display-title-with-message-tool") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_title: "Change Chat Title", tool_description: "Change the title of the current chat session", tool_params: { title: "New Title" } }, message: "Allow the happier MCP server to run tool \\"change_title\\"?", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-unidentified") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_1", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_1", type: "mcpToolCall", result: { Ok: { success: true, title: "New Title" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-completed-content-envelope") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_content_1", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "Content Envelope Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_content_1", type: "mcpToolCall", result: { Ok: { content: [{ type: "text", text: "{\\"success\\":true,\\"title\\":\\"Content Envelope Title\\"}" }], isError: false } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-blank-title") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_blank", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "   " } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_blank", type: "mcpToolCall", result: { Ok: { success: true, title: "   " } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-failed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_failed", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "Failed Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_failed", type: "mcpToolCall", result: { Ok: { success: false, title: "Failed Title" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-native-sync-fails") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_native_fail", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "fail-native-title-sync" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_native_fail", type: "mcpToolCall", result: { Ok: { success: true, title: "fail-native-title-sync" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-streams-divergent-final") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_diverge", delta: "READY " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_diverge", type: "agentMessage", text: "READY_FOR_FOLLOWUP" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-generated-image") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_img", delta: "Generated image:" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_1", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-generated-image-duplicate") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_img_dup", delta: "Generated image:" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_dup", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_dup", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-streams-multi-item") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_a", delta: "Alpha" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_a", delta: "think-a" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_a", type: "agentMessage", text: "Alpha done" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_a", type: "reasoning", content: ["think-a done"] } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_b", delta: "Beta" } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_b", delta: "think-b" } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_b", type: "agentMessage", text: "Beta done" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_b", type: "reasoning", content: ["think-b done"] } } }) + "\\n");',
        '            }, 13);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-plan-and-agent-message") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/plan/delta", params: { itemId: "plan_1", delta: "Plan draft" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "plan_1", type: "Plan", text: "Plan final" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_after_plan", delta: "Answer draft" } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_after_plan", type: "agentMessage", text: "Answer final" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-final-after-turn-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_late", type: "agentMessage", text: "Late final answer" } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-final-only") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw final answer" }] } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-and-normalized-final") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw fallback answer" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_raw_normalized", delta: "Normalized " } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_raw_normalized", type: "agentMessage", text: "Normalized final answer" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-and-normalized-different-items") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { id: "raw_msg_a", type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw item answer" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_b", delta: "Normalized " } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_b", type: "agentMessage", text: "Normalized item answer" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-item-raw-final-before-tool-call") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { id: "raw_before_tool", type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw item before tool" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_after_raw", type: "commandExecution", command: "pwd", cwd: process.cwd() } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-turn-diff") {',
            '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/diff/updated", params: { threadId: msg.params?.threadId ?? null, turnId, unifiedDiff: "diff --git a/src/diffed.ts b/src/diffed.ts\\n--- a/src/diffed.ts\\n+++ b/src/diffed.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-command-only-git-diff") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_git_diff_1", type: "commandExecution", command: "mkdir -p src && printf generated > src/command-only.ts", cwd: process.cwd() } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(async () => {',
        '                await mkdir("src", { recursive: true });',
        '                await writeFile("src/command-only.ts", "generated by shell\\n", "utf8");',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_git_diff_1", type: "commandExecution", command: "mkdir -p src && printf generated > src/command-only.ts", cwd: process.cwd(), aggregatedOutput: "", exitCode: 0, status: "completed" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 24);',
        '            continue;',
        '        }',
        '        if (text === "bridge-token-usage") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: msg.params?.threadId ?? null, turnId, tokenUsage: { total: { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 200, outputTokens: 250, reasoningOutputTokens: 50 }, last: { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 200, outputTokens: 250, reasoningOutputTokens: 50 }, modelContextWindow: 1000000 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-context-compaction") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "compact_1", type: "contextCompaction" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "compact_1", type: "contextCompaction" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "failed-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-structured") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: "2026-05-17T12:00:00.000Z", planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-then-late-raw-item") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: "2026-05-17T12:00:00.000Z", additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { threadId: msg.params?.threadId ?? null, id: "auto-compact-1", item: { id: "auto-compact-1", type: "context_compaction" } } }) + "\\n");',
        '            }, 30);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, itemId: "late_msg_1", delta: "late output" } }) + "\\n");',
        '            }, 35);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-stable-message") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:37 PM.", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "refresh-token-was-already-used") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Failed to refresh token: 401 Unauthorized: Your refresh token was already used to generate a new access token.", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-retry-after-only") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", retryAfterMs: 120000, planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "rate-limit-update") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 1779098400 }, secondary: null, credits: null, planType: "pro", rateLimitReachedType: null } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "bridge-chatgpt-refresh") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "refresh-chatgpt-tokens", method: "account/chatgptAuthTokens/refresh", params: { chatgptPlanType: "plus" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "retry-then-failed-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: true, error: { message: "temporary upstream overload", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "account-mismatch-once" && matchingTurnStartCount === 1) {',
        '            const authAccountChangedMessage = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: authAccountChangedMessage, codexErrorInfo: "unauthorized", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: authAccountChangedMessage, codexErrorInfo: "unauthorized", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-once" && matchingTurnStartCount === 1) {',
        '            const contextWindowError = { message: "upstream provider rejected the request", codexErrorInfo: "ContextWindowExceeded", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: contextWindowError } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: contextWindowError } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-after-activity" && matchingTurnStartCount === 1) {',
        '            const contextWindowError = { message: "upstream provider rejected the request", codexErrorInfo: "ContextWindowExceeded", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "mid_turn_msg", delta: "I changed " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "mid_turn_cmd", type: "commandExecution", command: "touch changed.txt", cwd: "/repo" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "mid_turn_cmd", type: "commandExecution", stdout: "done", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: contextWindowError } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: contextWindowError } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-twice" && matchingTurnStartCount <= 2) {',
        '            const contextWindowMessage = matchingTurnStartCount === 1',
        '                ? "Codex ran out of room in the model\'s context window. ORIGINAL_CONTEXT_WINDOW_FAILURE before retrying."',
        '                : "Codex ran out of room in the model\'s context window. RETRY_CONTEXT_WINDOW_FAILURE before retrying.";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: contextWindowMessage, codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: contextWindowMessage, codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-completed-only-command-result") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "call_failed_1", type: "commandExecution", command: "mkdir -p /tmp/demo", cwd: "/repo", stderr: "Rejected(\\\\\\"rejected by user\\\\\\")", exitCode: 1 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-foreign-thread-streams") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-child", turnId: "turn-child", itemId: "child_msg", delta: "Child " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_cmd", type: "commandExecution", command: "pwd", cwd: "/child" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_cmd", type: "commandExecution", stdout: "/child", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_msg", type: "agentMessage", text: "Child final" } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-child", turn: { id: "turn-child" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "parent_msg", delta: "Parent " } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "parent_msg", type: "agentMessage", text: "Parent final" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-approvals") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "cmd_approval", type: "commandExecution", command: "rm -rf /tmp/demo", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "approval-cmd", method: "item/commandExecution/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "cmd_approval", reason: "Needs approval" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "cmd_approval", type: "commandExecution", stdout: "approved", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "patch_approval", type: "fileChange", changes: { "src/file.ts": { hunks: 1 } } } } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "approval-patch", method: "item/fileChange/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "patch_approval", reason: "Review file edits" } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "patch_approval", type: "fileChange", stdout: "patched", success: true } } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_input", type: "mcpToolCall", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" } } } }) + "\\n");',
        '            }, 16);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-input", method: "item/tool/requestUserInput", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "tool_input", questions: [{ id: "freeform_note", header: "Context", question: "Optional note", isOther: false, isSecret: false, options: [] }, { id: "tool_questions", header: "Approve tool", question: "Allow navigation?", isOther: false, isSecret: false, options: [{ label: "Approve Once", description: "Allow once" }, { label: "Deny", description: "Reject" }] }] } }) + "\\n");',
        '            }, 17);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_input", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 20);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 24);',
        '            continue;',
        '        }',
        '        if (text === "bridge-request-permissions") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-permissions", method: "item/permissions/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "perm_request_1", cwd: "/repo", reason: "Needs network access", permissions: { network: { enabled: true }, fileSystem: { write: ["/repo/generated"] } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-user-action") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_input_general", type: "mcpToolCall", server: "functions", tool: "request_user_input", arguments: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-input-general", method: "item/tool/requestUserInput", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "tool_input_general", questions: [{ id: "export_shape", header: "Export Shape", question: "Which session export behavior should the plan target?", isOther: false, isSecret: false, options: [{ label: "Single JSON", description: "Portable JSON export" }, { label: "Single CSV", description: "Spreadsheet export" }] }] } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_input_general", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "cancel-no-active") {',
        '            continue;',
        '        }',
        '        if (text === "interrupt-notification-before-terminal") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/interrupt", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 60);',
        '            continue;',
        '        }',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, respondDelayMs + completionDelayMs);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/interrupt") {',
        `        if (${JSON.stringify(params.rejectInterruptAsNoActiveTurn === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to interrupt" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const turnId = msg.params?.turnId ?? null;',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: turnId ? { id: turnId } : undefined } }) + "\\n");',
        '        }, 5);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/steer") {',
        `        if (${JSON.stringify(params.rejectSteerAsNoActiveTurn === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const expectedTurnId = typeof msg.params?.expectedTurnId === "string" ? msg.params.expectedTurnId : null;',
        '        const turnId = typeof msg.params?.turnId === "string" ? msg.params.turnId : null;',
        '        const selected = expectedTurnId ?? turnId;',
        `        if (${JSON.stringify(params.rejectStructuredSteerInput === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: structured steer input unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectStructuredSteerInputAsStringShape === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        if (!selected) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "turn/steer requires expectedTurnId" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { turnId: selected } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/rollback") {',
        `        const rollbackError = ${JSON.stringify(params.rollbackError ?? null)};`,
        '        if (rollbackError) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: rollbackError }) + "\\n");',
        '            continue;',
        '        }',
        '        if (typeof msg.params?.numTurns !== "number" || !Number.isFinite(msg.params.numTurns) || msg.params.numTurns < 1 || typeof msg.params?.threadId !== "string" || msg.params.threadId.length === 0) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/rollback requires { threadId, numTurns >= 1 }" } }) + "\\n");',
            '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }) + "\\n");',
        '        continue;',
        '    }',
        '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

describe('createCodexAppServerRuntime', () => {
    let envScope = createCodexAppServerTestEnvScope();
    const tempRoots = new Set<string>();

    afterEach(async () => {
        setActiveAccountSettingsSnapshot({
            source: 'none',
            settings: {} as AccountSettings,
            settingsVersion: 0,
            loadedAtMs: 0,
            settingsSecretsReadKeys: [],
        });
        envScope.restore();
        envScope = createCodexAppServerTestEnvScope();
        await Promise.all([...tempRoots].map(async (dir) => {
            await removeTempDir(dir);
        }));
        tempRoots.clear();
    });

    async function createRuntimeFixture(
        prefix: string,
        options: Readonly<{
            rollbackError?: Readonly<{
                code: number;
                message: string;
            }>;
            rejectInterruptAsNoActiveTurn?: boolean;
            rejectSteerAsNoActiveTurn?: boolean;
            rejectPermissionsProfile?: boolean;
            rejectGoalMethods?: boolean;
            rejectGoalMethodsAsInvalidRequest?: boolean;
            emitGoalContinuationTurn?: boolean;
            emitGoalContinuationItemsBeforeStarted?: boolean;
            rejectReviewStartMethodUnavailable?: boolean;
            rejectStructuredTurnInput?: boolean;
            rejectStructuredTurnInputAsStringShape?: boolean;
            rejectStructuredSteerInput?: boolean;
            rejectStructuredSteerInputAsStringShape?: boolean;
            emitResumeContinuationUserInputRequest?: boolean;
            emitResumeTurnStartedBeforeResponse?: boolean;
            rejectPermissionsProfileAsStringShape?: boolean;
            rateLimitReadResult?: unknown;
        }> = {},
    ): Promise<{
        root: string;
        requestLogPath: string;
        fakeAppServer: string;
    }> {
        const root = await createTempDir(prefix);
        tempRoots.add(root);
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            requestLogPath,
            rollbackError: options.rollbackError,
            rejectInterruptAsNoActiveTurn: options.rejectInterruptAsNoActiveTurn,
            rejectSteerAsNoActiveTurn: options.rejectSteerAsNoActiveTurn,
            rejectPermissionsProfile: options.rejectPermissionsProfile,
            rejectGoalMethods: options.rejectGoalMethods,
            rejectGoalMethodsAsInvalidRequest: options.rejectGoalMethodsAsInvalidRequest,
            emitGoalContinuationTurn: options.emitGoalContinuationTurn,
            emitGoalContinuationItemsBeforeStarted: options.emitGoalContinuationItemsBeforeStarted,
            rejectReviewStartMethodUnavailable: options.rejectReviewStartMethodUnavailable,
            rejectStructuredTurnInput: options.rejectStructuredTurnInput,
            rejectStructuredTurnInputAsStringShape: options.rejectStructuredTurnInputAsStringShape,
            rejectStructuredSteerInput: options.rejectStructuredSteerInput,
            rejectStructuredSteerInputAsStringShape: options.rejectStructuredSteerInputAsStringShape,
            emitResumeContinuationUserInputRequest: options.emitResumeContinuationUserInputRequest,
            emitResumeTurnStartedBeforeResponse: options.emitResumeTurnStartedBeforeResponse,
            rejectPermissionsProfileAsStringShape: options.rejectPermissionsProfileAsStringShape,
            rateLimitReadResult: options.rateLimitReadResult,
        });
        envScope.patch({
            HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            CODEX_API_KEY: undefined,
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
            [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
            [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
        });
        return { root, requestLogPath, fakeAppServer };
    }

    async function readRequestLog(requestLogPath: string): Promise<Array<{ id: unknown; method: string; params: unknown; result: unknown; error: unknown }>> {
        return (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    }

    it('allows app-server startup when Codex credentials are missing so the backend can surface auth errors itself', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-missing-');

        envScope.patch({
            OPENAI_API_KEY: '',
            CODEX_API_KEY: '',
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'acceptEdits',
        });

        await expect(runtime.startOrLoad({})).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ method: 'initialize' }),
                expect.objectContaining({ method: 'thread/start' }),
            ]),
        );
    });

    it('starts a new app-server thread and publishes the thread id to session metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-start-');

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'acceptEdits',
        });

        await runtime.startOrLoad({});

        expect(runtime.getSessionId()).toBe('thread-started');
        expect(updateMetadata).toHaveBeenCalled();
        expect(updateMetadata.mock.results[0]?.value).toMatchObject({
            codexSessionId: 'thread-started',
            codexBackendMode: 'appServer',
        });
        expect(updateMetadata.mock.results.map((result) => result.value)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                [SESSION_MODELS_STATE_KEY]: expect.objectContaining({
                    currentModelId: 'gpt-5.4',
                    availableModels: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'gpt-5.4',
                            modelOptions: expect.arrayContaining([
                                expect.objectContaining({ id: 'reasoning_effort', currentValue: 'medium' }),
                            ]),
                        }),
                    ]),
                }),
            }),
            expect.objectContaining({
                [SESSION_MODES_STATE_KEY]: expect.objectContaining({
                    v: 1,
                    provider: 'codex',
                    currentModeId: 'default',
                    availableModes: expect.arrayContaining([
                        expect.objectContaining({ id: 'default', name: 'Default' }),
                        expect.objectContaining({ id: 'plan', name: 'Plan' }),
                    ]),
                }),
            }),
        ]));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        permissions: {
                            type: 'profile',
                            id: ':workspace',
                        },
                        experimentalRawEvents: true,
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({ method: 'collaborationMode/list' }),
                expect.objectContaining({ method: 'model/list' }),
            ]),
        );
    });

    it('starts safe-yolo app-server threads with auto-reviewer approvals instead of disabling approvals', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-safe-yolo-start-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'safe-yolo',
        });

        await runtime.startOrLoad({});

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        permissions: {
                            type: 'profile',
                            id: ':workspace',
                        },
                    }),
                }),
            ]),
        );
        const startRequest = requestLog.find((entry: { method: string }) => entry.method === 'thread/start') as { params?: Record<string, unknown> } | undefined;
        expect(startRequest?.params).not.toHaveProperty('sandbox');
        expect(startRequest?.params).not.toHaveProperty('approvalPolicy');
        expect(startRequest?.params).not.toHaveProperty('approvalsReviewer');
    });

    it('falls back to legacy app-server permission fields after older Codex rejects permission profiles', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-permission-fallback-', {
            rejectPermissionsProfile: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('legacy-fallback');

        const requestLog = await readRequestLog(requestLogPath);
        const startRequests = requestLog.filter((entry) => entry.method === 'thread/start') as Array<{ params?: Record<string, unknown> }>;
        expect(startRequests).toHaveLength(2);
        expect(startRequests[0]?.params).toMatchObject({
            permissions: {
                type: 'profile',
                id: ':read-only',
            },
        });
        expect(startRequests[0]?.params).not.toHaveProperty('sandbox');
        expect(startRequests[1]?.params).toMatchObject({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        expect(startRequests[1]?.params).not.toHaveProperty('permissions');

        const turnStart = requestLog.find((entry) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).toMatchObject({
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
            },
        });
        expect(turnStart?.params).not.toHaveProperty('permissions');
    });

    it('falls back to legacy app-server permission fields when older Codex expects a string profile id', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-permission-string-fallback-', {
            rejectPermissionsProfileAsStringShape: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});

        const requestLog = await readRequestLog(requestLogPath);
        const startRequests = requestLog.filter((entry) => entry.method === 'thread/start') as Array<{ params?: Record<string, unknown> }>;
        expect(startRequests).toHaveLength(2);
        expect(startRequests[0]?.params).toMatchObject({
            permissions: {
                type: 'profile',
                id: ':read-only',
            },
        });
        expect(startRequests[1]?.params).toMatchObject({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        expect(startRequests[1]?.params).not.toHaveProperty('permissions');
    });

    it('falls back to legacy app-server permission fields when resuming against older Codex string profile shape', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-permission-string-fallback-', {
            rejectPermissionsProfileAsStringShape: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });

        const requestLog = await readRequestLog(requestLogPath);
        const resumeRequests = requestLog.filter((entry) => entry.method === 'thread/resume') as Array<{ params?: Record<string, unknown> }>;
        expect(resumeRequests).toHaveLength(2);
        expect(resumeRequests[0]?.params).toMatchObject({
            threadId: 'resume-123',
            permissions: {
                type: 'profile',
                id: ':read-only',
            },
            persistExtendedHistory: true,
        });
        expect(resumeRequests[1]?.params).toMatchObject({
            threadId: 'resume-123',
            approvalPolicy: 'never',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        });
        expect(resumeRequests[1]?.params).not.toHaveProperty('permissions');
    });

    it('publishes connected-service direct-session metadata when activeServerDir owns CODEX_HOME', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-direct-');
        const scopedEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_TRANSCRIPT_STORAGE: 'direct',
            CODEX_HOME: join(root, 'servers', 'cloud', 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile', 'codex', 'codex-home'),
        });
        const codexHomeDir = scopedEnv.CODEX_HOME;
        if (!codexHomeDir) {
            throw new Error('Expected CODEX_HOME to be set for codex app-server runtime test');
        }
        await mkdir(codexHomeDir, { recursive: true });

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            activeServerDir: join(root, 'servers', 'cloud'),
            processEnv: scopedEnv,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});

        expect(updateMetadata.mock.results[0]?.value).toMatchObject({
            directSessionV1: {
                source: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                    connectedServiceProfileId: 'profile',
                },
            },
        });
    });

    it('resumes an existing app-server thread for resume ids and existing session ids', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });
        await runtime.startOrLoad({ existingSessionId: 'existing-456' });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const resumeRequests = requestLog.filter((entry: { method: string }) => entry.method === 'thread/resume');
        expect(resumeRequests).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ params: expect.objectContaining({ threadId: 'resume-123', persistExtendedHistory: true }) }),
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'resume-123',
                        permissions: {
                            type: 'profile',
                            id: ':read-only',
                        },
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'existing-456',
                        permissions: {
                            type: 'profile',
                            id: ':read-only',
                        },
                        persistExtendedHistory: true,
                    }),
                }),
            ]),
        );
    });

    it('drains accepted pending queue rows after resuming an app-server thread', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-pending-');
        const drainPending = vi.fn(async () => ({ materialized: 1, stoppedReason: 'no_pending' as const }));

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
            pendingQueue: {
                drainAfterStartOrLoad: true,
                drainPending,
            },
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });

        expect(runtime.getSessionId()).toBe('resume-123');
        expect(drainPending).toHaveBeenCalledWith({
            logPrefix: '[CodexAppServer]',
            reason: 'startOrLoad',
        });
    });

    it('sets an initial resume goal before draining pending queue rows', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-initial-goal-');
        const drainPending = vi.fn(async () => ({ materialized: 1, stoppedReason: 'no_pending' as const }));

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
            pendingQueue: {
                drainAfterStartOrLoad: true,
                drainPending,
            },
        });

        await runtime.startOrLoad({
            resumeId: 'resume-123',
            importHistory: false,
            initialGoal: {
                objective: 'Line one\nLine two',
            },
        } as any);

        expect(drainPending).toHaveBeenCalledWith({
            logPrefix: '[CodexAppServer]',
            reason: 'startOrLoad',
        });
        const requestLog = await readRequestLog(requestLogPath);
        const resumeIndex = requestLog.findIndex((entry) => entry.method === 'thread/resume');
        const goalSetIndex = requestLog.findIndex((entry) => entry.method === 'thread/goal/set');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(goalSetIndex).toBeGreaterThan(resumeIndex);
        expect(requestLog[goalSetIndex]).toMatchObject({
            method: 'thread/goal/set',
            params: {
                threadId: 'resume-123',
                objective: 'Line one\nLine two',
            },
        });
    });

    it('sends prompts over the persistent client and waits for turn completion notifications', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('hello-world');

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-hello-world',
        });
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/start')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    input: [{ type: 'text', text: 'hello-world' }],
                    permissions: {
                        type: 'profile',
                        id: ':read-only',
                    },
                }),
            }),
        ]);
        const turnStart = requestLog.find((entry: { method: string }) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).not.toHaveProperty('sandboxPolicy');
        expect(turnStart?.params).not.toHaveProperty('approvalPolicy');
    });

    it('does not report an active provider turn before native Codex starts one', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-preflight-turn-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        runtime.beginTurn();

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.canSteerPrompt()).toBe(false);
        expect(onThinkingChange).not.toHaveBeenCalledWith(true);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
    });

    it('does not fail completed prompts when primary turn status persistence fails', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-status-failure-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                throw new Error('status persistence unavailable');
            }),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});

        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        try {
            await expect(Promise.race([
                runtime.sendPrompt('hello-world'),
                new Promise((_resolve, reject) => {
                    settleTimer = setTimeout(() => reject(new Error('sendPrompt did not settle')), 1000);
                }),
            ])).resolves.toBeUndefined();
        } finally {
            if (settleTimer) {
                clearTimeout(settleTimer);
            }
        }
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-hello-world',
        });
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
    });

    it('does not write a completed projection when flushing after a failed turn already cleared pending state', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-failed-flush-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('failed-turn')).rejects.toThrow(/unauthorized/i);
        await runtime.flushTurn();

        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-failed-turn',
        }));
    });

    it('does not adopt late raw response items as new turns after app-server usage-limit failure', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-raw-after-usage-limit-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('usage-limit-then-late-raw-item')).rejects.toMatchObject({
            runtimeAuthClassification: expect.objectContaining({ kind: 'usage_limit' }),
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-usage-limit-then-late-raw-item',
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-usage-limit-then-late-raw-item',
        }));
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('uses the structured turn input builder for text, mentions, skills, and image attachments', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-structured-input-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });
        const uploadedPath = '.happier/uploads/messages/m1/screenshot.png';
        const uploadedContent = Buffer.from('fake screenshot');
        const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
        await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
        await writeFile(join(root, uploadedPath), uploadedContent);

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            sendPrompt: (prompt: string, options?: { metadata?: Record<string, unknown> }) => Promise<void>;
        }).sendPrompt('structured-input', {
            metadata: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: uploadedPath,
                                mimeType: 'image/png',
                                sizeBytes: uploadedContent.byteLength,
                                sha256,
                            },
                        ],
                    },
                },
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                    skillMentions: [
                        { name: 'debugger', path: '/skills/debugger/SKILL.md' },
                    ],
                    attachments: [
                        {
                            kind: 'image',
                            localPath: uploadedPath,
                            path: uploadedPath,
                            sha256,
                            provenance: { kind: 'sessionAttachmentUpload' },
                        },
                        { mimeType: 'image/png', url: 'https://example.test/image.png' },
                    ],
                },
            },
        });

        const requestLog = await readRequestLog(requestLogPath);
        const turnStart = requestLog.find((entry) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).toMatchObject({
            input: [
                { type: 'text', text: 'structured-input' },
                { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                { type: 'skill', name: 'debugger', path: '/skills/debugger/SKILL.md' },
                { type: 'localImage', path: uploadedPath },
                { type: 'image', url: 'https://example.test/image.png' },
            ],
        });
    });

    it('sends native reviews over review/start and waits for completion', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-review-start-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        });

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(requestLog.filter((entry) => entry.method === 'review/start')).toEqual([
            expect.objectContaining({
                params: {
                    threadId: 'thread-started',
                    target: {
                        type: 'custom',
                        instructions: 'Review current changes',
                    },
                    delivery: 'inline',
                },
            }),
        ]);
    });

    it('rejects prompts while a native review turn is pending', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-pending-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const reviewPromise = (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'delayed-review',
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));

        await expect(runtime.sendPrompt('second prompt')).rejects.toThrow(/turn in flight/);
        await reviewPromise;
    });

    it('clears native review pending state after invalid request failures', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-review-invalid-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'invalid-review-input',
            },
        })).rejects.toThrow(/review target is invalid/);
        await runtime.sendPrompt('after-review-failure');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'review/start')).toHaveLength(1);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
    });

    it('returns an unsupported result when native review/start is unavailable', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-unsupported-', {
            rejectReviewStartMethodUnavailable: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:review/start',
        });
    });

    it('syncs native app-server goals through goal RPCs and sessionWorkStateV1 metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-');

        let metadataSnapshot: Record<string, unknown> = {
            keep: 'yes',
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 1,
                items: [
                    { id: 'todo:other:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Keep me', updatedAt: 1 },
                ],
                primaryItemId: 'todo:other:1',
            },
        };
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string, options?: { status?: string; tokenBudget?: number | null }) => Promise<void>;
        }).setGoal('Finish native goal wiring', { status: 'paused', tokenBudget: 1200 });
        await (runtime as unknown as { clearGoal: () => Promise<void> }).clearGoal();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/get',
                params: { threadId: 'thread-started' },
            }),
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    objective: 'Finish native goal wiring',
                    status: 'paused',
                    tokenBudget: 1200,
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: { threadId: 'thread-started' },
            }),
        ]));
        expect(metadataSnapshot.keep).toBe('yes');
        const workState = metadataSnapshot.sessionWorkStateV1 as { items?: Array<{ id?: string; title?: string }> };
        expect(workState.items).toEqual([
            expect.objectContaining({ id: 'todo:other:1', title: 'Keep me' }),
        ]);
        expect(updateMetadata).toHaveBeenCalledWith(expect.any(Function));
    });

    it('sends live status-only goal mutations without starting a turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-status-only-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { status?: string }) => Promise<void>;
        }).setGoal(undefined, { status: 'paused' });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    status: 'paused',
                },
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    });

    it('rejects unsupported generic goal statuses before calling native goal set', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-invalid-status-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { status?: string }) => Promise<unknown>;
        }).setGoal(undefined, { status: 'blocked' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_goal_status',
            error: 'invalid_goal_status',
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/goal/set')).toEqual([]);
    });

    it('sends live budget-only goal mutations without starting a turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-budget-only-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { tokenBudget?: number | null }) => Promise<void>;
        }).setGoal(undefined, { tokenBudget: null });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    tokenBudget: null,
                },
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    });

    it('adopts native app-server goal continuation turns and bridges their stream events', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-continuation-', {
            emitGoalContinuationTurn: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
            sessionTurnLifecycle,
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');

        await waitForCondition(() => {
            const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
                [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
            >;
            const assistantText = committedCalls
                .filter(([, body]) => body.type === 'message')
                .map(([, body]) => String(body.message ?? ''))
                .join('');
            return assistantText.includes('Goal continuation');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'native Codex goal continuation transcript event',
        });

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ type: 'tool-call', callId: 'goal_cmd_1', name: 'CodexBash', input: { command: 'git status', cwd: '/repo' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'goal_cmd_1', output: { stdout: 'clean', exitCode: 0 } })],
            ]),
        );
        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length > 0, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'native Codex goal continuation lifecycle completion',
        });
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-goal-continuation',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        expect(sessionTurnLifecycle.markRollbackEligible).not.toHaveBeenCalled();
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('adopts native app-server goal continuation turns from same-thread stream events', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-continuation-stream-first-', {
            emitGoalContinuationTurn: true,
            emitGoalContinuationItemsBeforeStarted: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
            sessionTurnLifecycle,
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');

        await waitForCondition(() => {
            const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
                [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
            >;
            const assistantText = committedCalls
                .filter(([, body]) => body.type === 'message')
                .map(([, body]) => String(body.message ?? ''))
                .join('');
            return assistantText.includes('Goal continuation');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'stream-first native Codex goal continuation transcript event',
        });

        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length > 0, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'stream-first native Codex goal continuation lifecycle completion',
        });
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-goal-continuation',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('adopts resumed native app-server turns from server requests before terminal notifications', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-request-continuation-', {
            emitResumeContinuationUserInputRequest: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({
                decision: 'approved',
                answers: { resume_question: 'yes' },
            }),
        };

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionHandler: permissionHandler as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({ resumeId: 'thread-resume-active' });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'resume_tool_input',
            'AskUserQuestion',
            expect.objectContaining({
                questions: [
                    expect.objectContaining({ question: 'Continue?' }),
                ],
            }),
        );
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-resume-request',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'resume-request-input',
                params: null,
                result: {
                    answers: {
                        resume_question: {
                            answers: ['yes'],
                        },
                    },
                },
                error: null,
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('preserves provider-adopted resumed turns that start before thread resume responds', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-start-before-response-', {
            emitResumeTurnStartedBeforeResponse: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const onThinkingChange = vi.fn();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'default',
        });

        try {
            await runtime.startOrLoad({ resumeId: 'thread-resume-active' });

            expect(runtime.hasActiveProviderTurn()).toBe(true);
            expect(runtime.isTurnInFlight()).toBe(true);
            expect(onThinkingChange).toHaveBeenCalledWith(true);
            expect(onThinkingChange).not.toHaveBeenCalledWith(false);
            expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
            expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'codex',
                providerTurnId: 'turn-resume-start-before-response',
            }));
            expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
            expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('returns stable unsupported results when app-server goal methods are unavailable', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-unsupported-', {
            rejectGoalMethods: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const expected = {
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.set',
        };

        await expect((runtime as unknown as {
            setGoal: (objective: string) => Promise<unknown>;
        }).setGoal('Unsupported native goal')).resolves.toEqual(expected);
        await expect((runtime as unknown as {
            clearGoal: () => Promise<unknown>;
        }).clearGoal()).resolves.toEqual({
            ...expected,
            error: 'unsupported_session_runtime_method:session.goal.clear',
        });
        await expect((runtime as unknown as {
            refreshGoal: () => Promise<unknown>;
        }).refreshGoal()).resolves.toEqual({
            ...expected,
            error: 'unsupported_session_runtime_method:session.goal.get',
        });
    });

    it('returns stable unsupported results when app-server goal methods return invalid-request errors', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-invalid-request-', {
            rejectGoalMethodsAsInvalidRequest: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});

        await expect((runtime as unknown as {
            setGoal: (objective: string) => Promise<unknown>;
        }).setGoal('Unsupported native goal')).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.set',
        });
        await expect((runtime as unknown as {
            refreshGoal: () => Promise<unknown>;
        }).refreshGoal()).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.get',
        });
    });

    it('lists Codex vendor plugin and skill catalogs through app-server RPCs', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-catalog-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const vendorPluginCatalog = await (runtime as unknown as {
            listVendorPlugins: (options?: { cwd?: string }) => Promise<unknown>;
        }).listVendorPlugins({ cwd: '/override' });
        const skillCatalog = await (runtime as unknown as {
            listSkills: (options?: { cwd?: string }) => Promise<unknown>;
        }).listSkills({ cwd: '/override' });

        expect(vendorPluginCatalog).toMatchObject({
            supported: true,
            vendorPlugins: [
                expect.objectContaining({
                    name: 'reviewer',
                    vendorPluginRef: 'plugin://reviewer@codex',
                    mentionable: true,
                }),
            ],
        });
        expect(skillCatalog).toMatchObject({
            supported: true,
            skills: [
                expect.objectContaining({
                    name: 'debugger',
                    path: '/skills/debugger/SKILL.md',
                }),
            ],
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({ method: 'plugin/list', params: { cwds: ['/override'] } }),
            expect.objectContaining({ method: 'skills/list', params: { cwds: ['/override'] } }),
        ]));
    });

    it('interrupts an in-flight turn without spawning a replacement app-server process', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.cancel();
        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/interrupt')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-me' }),
            }),
        ]);
    });

    it('clears in-flight state when native interrupt reports no active turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-no-active-', {
            rejectInterruptAsNoActiveTurn: true,
        });

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-no-active');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to enter in-flight state',
        });

        await expect(runtime.cancel()).resolves.toBeUndefined();
        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/interrupt')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-no-active' }),
            }),
        ]);
    });

    it('keeps a Codex turn in flight until the terminal interrupted notification arrives', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-notification-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('interrupt-notification-before-terminal');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to enter in-flight state',
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(runtime.isTurnInFlight()).toBe(true);

        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
    });

    it('advertises in-flight steer support and can call turn/steer while a turn is in flight', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        expect(runtime.supportsInFlightSteer()).toBe(true);

        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge');
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-cancel-me',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toHaveLength(1);
    });

    it('clears stale in-flight state when native steer reports no active turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-no-active-', {
            rejectSteerAsNoActiveTurn: true,
        });

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('stale-steer');
        await waitForCondition(() => runtime.canSteerPrompt() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable',
        });

        expect(runtime.isTurnInFlight()).toBe(true);
        await expect(runtime.steerPrompt('nudge')).rejects.toThrow(/no active turn to steer/i);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(runtime.canSteerPrompt()).toBe(false);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        await expect(sendPromptPromise).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-stale-steer',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
    });

    it('retries turn start with text-only input while keeping native permissions when structured input is unsupported', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-structured-fallback-permissions-', {
            rejectStructuredTurnInput: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('structured-turn-fallback', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });

        const turnStarts = (await readRequestLog(requestLogPath))
            .filter((entry) => entry.method === 'turn/start') as Array<{ params?: Record<string, unknown> }>;
        expect(turnStarts).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [
                        { type: 'text', text: 'structured-turn-fallback' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                    permissions: { type: 'profile', id: ':read-only' },
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [{ type: 'text', text: 'structured-turn-fallback' }],
                    permissions: { type: 'profile', id: ':read-only' },
                }),
            }),
        ]);
        expect(turnStarts[1]?.params).not.toHaveProperty('sandboxPolicy');
        expect(turnStarts[1]?.params).not.toHaveProperty('approvalPolicy');
    });

    it('retries turn start with text-only input when older app-server expects string input items', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-string-shape-fallback-', {
            rejectStructuredTurnInputAsStringShape: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('structured-turn-string-shape-fallback', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });

        const turnStarts = (await readRequestLog(requestLogPath))
            .filter((entry) => entry.method === 'turn/start') as Array<{ params?: Record<string, unknown> }>;
        expect(turnStarts).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [
                        { type: 'text', text: 'structured-turn-string-shape-fallback' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [{ type: 'text', text: 'structured-turn-string-shape-fallback' }],
                }),
            }),
        ]);
    });

    it('retries turn steer with text-only input when structured steer input is unsupported', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-structured-fallback-', {
            rejectStructuredSteerInput: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge with plugin', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-cancel-me',
                    input: [
                        { type: 'text', text: 'nudge with plugin' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-cancel-me',
                    input: [{ type: 'text', text: 'nudge with plugin' }],
                }),
            }),
        ]);
    });

    it('retries turn steer with text-only input when older app-server expects string input items', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-string-shape-fallback-', {
            rejectStructuredSteerInputAsStringShape: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge with old input shape', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-cancel-me',
                    input: [
                        { type: 'text', text: 'nudge with old input shape' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-cancel-me',
                    input: [{ type: 'text', text: 'nudge with old input shape' }],
                }),
            }),
        ]);
    });

    it('records one durable turn-start boundary for a steered turn and rejects the steer user row as a point rollback target', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-session-turn-');

        let metadataSnapshot: Record<string, unknown> = { machineId: 'machine_1' };
        let lastObservedMessageSeq = 10;
        let lastObservedUserMessageSeq = 10;
        const committedUserSeqs = new Map([
            ['prompt-local-1', 10],
            ['steer-local-1', 12],
        ]);
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session_1',
                updateMetadata,
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => committedUserSeqs.get(localId) ?? null),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        const sendPromptPromise = (runtime as any).sendPrompt('cancel-me', {
            localId: 'prompt-local-1',
        });
        await new Promise((resolve) => setTimeout(resolve, 30));

        lastObservedMessageSeq = 12;
        lastObservedUserMessageSeq = 12;
        await (runtime as any).steerPrompt('nudge', {
            localId: 'steer-local-1',
        });
        lastObservedMessageSeq = 15;
        await sendPromptPromise;

        expect(metadataSnapshot).not.toHaveProperty('sessionTurnLedgerV1');

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 12,
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
        });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 10,
            },
        })).resolves.toMatchObject({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/rollback')).toEqual([
            expect.objectContaining({
                params: { threadId: 'thread-started', numTurns: 1 },
            }),
        ]);
    });

    it('marks a completed turn as non-steerable while completion is still settling', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-settle-');

        envScope.patch({
            HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '1000',
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        const steerableRuntime = runtime as typeof runtime & { canSteerPrompt?: () => boolean };

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('settle-after-complete');

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable',
        });

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === false, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become non-steerable after terminal notification',
        });

        expect(runtime.isTurnInFlight()).toBe(true);
        await sendPromptPromise;
    });

    it('marks an active turn as non-steerable when the selected session mode changes', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-mode-change-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        const steerableRuntime = runtime as typeof runtime & { canSteerPrompt?: () => boolean };

        await runtime.startOrLoad({});
        await runtime.setSessionMode('plan');
        const sendPromptPromise = runtime.sendPrompt('cancel-me');

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable with matching session mode',
        });

        await runtime.setSessionMode('default');

        expect(steerableRuntime.canSteerPrompt?.()).toBe(false);
        await sendPromptPromise;
    });

    it('waits for the active turn id before calling turn/steer', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-wait-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});

        const sendPromptPromise = runtime.sendPrompt('steer-delay');
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge-early');
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-steer-delay',
                    input: [{ type: 'text', text: 'nudge-early' }],
                }),
            }),
        ]);
    });

    it('bridges stream notifications into transcript deltas and tool updates during sendPrompt', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-streams-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId)
            .map((call) => String(call.body?.message ?? ''));
        const thinkingMessages = committedCalls
            .map(([, body]) => body)
            .filter((body: any) => body?.type === 'thinking' && !body?.sidechainId)
            .map((body: any) => String(body.text ?? ''));

        expect(assistantMessages.some((msg) => msg.includes('Hello'))).toBe(true);
        expect(assistantMessages.some((msg) => msg.includes('world'))).toBe(true);
        expect(thinkingMessages.some((msg) => msg.includes('thinking'))).toBe(true);
        expect(thinkingMessages.some((msg) => msg.includes('hard'))).toBe(true);
        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ type: 'tool-call', callId: 'cmd_1', name: 'CodexBash', input: { command: 'ls -la', cwd: '/repo' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'cmd_1', output: { stdout: 'done', exitCode: 0 } })],
                [expect.objectContaining({ type: 'tool-call', callId: 'tool_1', name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'tool_1', output: { status: 'ok' } })],
                [expect.objectContaining({
                    type: 'tool-call',
                    callId: 'patch_1',
                    name: 'CodexPatch',
                    input: {
                        auto_approved: true,
                        changes: [
                            {
                                path: 'src/file.ts',
                                kind: { type: 'update', move_path: null },
                                diff: '@@ -1 +1,2 @@\n-old line\n+old line\n+new line\n',
                            },
                        ],
                    },
                })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'patch_1', output: { stdout: 'patched', success: true } })],
                [expect.objectContaining({
                    type: 'tool-call',
                    name: 'Diff',
                    input: expect.objectContaining({
                        files: [
                            expect.objectContaining({
                                file_path: 'src/file.ts',
                                oldText: 'old line\n',
                                newText: 'old line\nnew line\n',
                            }),
                        ],
                    }),
                })],
                [expect.objectContaining({ type: 'tool-call-result', output: { status: 'completed' } })],
            ]),
        );
    });

    it('commits native review completion text without duplicating identical assistant finals', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-dedupe-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body]) => body as CommittedSnapshotBody)
            .filter((body) => body.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        const nativeReviewLocalIds = new Set(committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId && call.body.message === 'Native review text')
            .map((call) => call.opts.localId));
        expect(assistantMessages).toContain('Native review text');
        expect(nativeReviewLocalIds.size).toBe(1);
    });

    it('preserves assistant final text that differs from native review completion text', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-different-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'different-final',
            },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body]) => body as CommittedSnapshotBody)
            .filter((body) => body.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        expect(assistantMessages).toEqual(expect.arrayContaining([
            'Native review body',
            'Different final assistant text',
        ]));
    });

    it('commits inline native review results as structured review findings without duplicating final text', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-');

        const session = {
            sessionId: 'sess-inline-review',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['codex'],
            instructions: 'Review current changes',
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const nativeReviewMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId && call.body.message === 'Native review text');

        expect(nativeReviewMessages).toHaveLength(1);
        expect(nativeReviewMessages[0]?.opts.meta?.happier).toMatchObject({
            kind: 'review_findings.v2',
            payload: {
                runRef: {
                    runId: 'session-review:sess-inline-review:turn-review-native',
                    callId: 'review_exited_1',
                    backendId: 'codex',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                },
                summary: 'Native review text',
                overviewMarkdown: 'Native review text',
                findings: [],
            },
        });
    });

    it('starts an app-server thread before inline native review when none is active', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-start-');

        const session = {
            sessionId: 'sess-inline-review-start',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await (runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['codex'],
            instructions: 'Review current changes',
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('thread/start');
        expect(requestLog.map((entry) => entry.method)).toContain('review/start');
    });

    it('rejects inline native reviews that do not target Codex', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-wrong-engine-');

        const session = {
            sessionId: 'sess-inline-review-wrong-engine',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await expect((runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['claude'],
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'inline_review_not_supported',
            error: 'inline_review_not_supported',
        });

        const requestLogText = await readFile(requestLogPath, 'utf8').catch(() => '');
        expect(requestLogText).not.toContain('"method":"review/start"');
    });

    it('handles /codex.review through the provider-owned user message hook', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-command-');

        const session = {
            sessionId: 'sess-inline-review-command',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        const result = await (runtime as unknown as {
            handleUserMessage: (request: {
                text: string;
                localId?: string;
                meta: Record<string, unknown>;
            }) => Promise<unknown>;
        }).handleUserMessage({
            text: '/codex.review focus on regressions',
            localId: 'local-review-command',
            meta: { source: 'test' },
        });

        expect(result).toEqual({ handled: true, result: { ok: true, reviewTurnId: 'turn-review-native' } });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toContainEqual(expect.objectContaining({
            method: 'review/start',
            params: expect.objectContaining({
                target: expect.objectContaining({
                    type: 'custom',
                    instructions: expect.stringContaining('focus on regressions'),
                }),
            }),
        }));
    });

    it('uses the explicit transcript session port for live and durable transcript snapshots', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-transcript-port-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const transcriptSession = {
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, _body: ACPMessageData, _options?: TestCommittedMessageOptions) => {}),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            transcriptSession: transcriptSession as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        expect(transcriptSession.sendAgentMessageEphemeral).toHaveBeenCalled();
        expect(transcriptSession.sendAgentMessageCommitted).toHaveBeenCalled();
        const committedSegmentStates = transcriptSession.sendAgentMessageCommitted.mock.calls
            .map(([, , opts]) => opts?.meta?.happierStreamSegmentV1?.segmentState);
        expect(committedSegmentStates).toContain('streaming');
        expect(committedSegmentStates).toContain('complete');
        expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    });

    it('does not append the full final assistant text into streaming drafts when the final text diverges from earlier deltas', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-divergent-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams-divergent-final');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId)
            .map((call) => String(call.body?.message ?? ''));
        expect(assistantMessages.some((msg) => msg === 'READY ')).toBe(true);
        expect(assistantMessages.some((msg) => msg === 'READY_FOR_FOLLOWUP')).toBe(true);
        expect(assistantMessages.some((msg) => msg.includes('READY_FOR_FOLLOWUP') && msg !== 'READY_FOR_FOLLOWUP')).toBe(false);
    });

    it('persists final image generation media before committing Codex app-server assistant metadata', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-generated-image-');

        const persistedMediaItem = {
            id: 'media-1',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'generated-image.png',
            path: '.happier/uploads/generated/message-1/media-1.png',
            sizeBytes: 67,
            sha256: 'a'.repeat(64),
            origin: {
                source: 'provider-generated',
                generationId: 'img_1',
            },
        } as const;
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const sessionMediaPersist = vi.fn(
            async (_message: RuntimeSessionMediaMessage): Promise<readonly SessionMediaItemV1[]> => [persistedMediaItem],
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            sessionMedia: { persist: sessionMediaPersist },
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-generated-image');

        expect(sessionMediaPersist).toHaveBeenCalledOnce();
        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistant = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .find((call) =>
                call.body?.type === 'message' &&
                call.body.message === 'Generated image:' &&
                call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete'
            );
        expect(finalAssistant?.opts.meta).toMatchObject({
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [persistedMediaItem],
                },
            },
        });
        expect(JSON.stringify(finalAssistant?.opts.meta)).not.toContain('iVBORw0KGgo=');
        expect(JSON.stringify(finalAssistant?.opts.meta)).not.toContain('attachments.v1');
    });

    it('dedupes repeated Codex app-server media updates before persistence', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-generated-image-dedupe-');

        const persistedMediaItem = {
            id: 'media-1',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'generated-image.png',
            path: '.happier/uploads/generated/message-1/media-1.png',
            sizeBytes: 67,
            sha256: 'a'.repeat(64),
            origin: {
                source: 'provider-generated',
                generationId: 'img_dup',
            },
        } as const;
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const sessionMediaPersist = vi.fn(
            async (_message: RuntimeSessionMediaMessage): Promise<readonly SessionMediaItemV1[]> => [persistedMediaItem],
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            sessionMedia: { persist: sessionMediaPersist },
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-generated-image-duplicate');

        expect(sessionMediaPersist).toHaveBeenCalledOnce();
        const persistedMessage = sessionMediaPersist.mock.calls[0]?.[0];
        expect(persistedMessage?.media).toHaveLength(1);
        expect(JSON.stringify(persistedMessage)).not.toContain('attachments.v1');
    });

    it('keeps multiple assistant and reasoning item streams isolated within one turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-multi-item-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams-multi-item');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistantMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'message' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');
        const finalThinkingMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'thinking' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');

        expect(finalAssistantMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ message: 'Alpha done' }) }),
            expect.objectContaining({ body: expect.objectContaining({ message: 'Beta done' }) }),
        ]));
        expect(new Set(finalAssistantMessages.map((call) => call.opts.localId)).size).toBe(2);

        expect(finalThinkingMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ text: 'think-a done' }) }),
            expect.objectContaining({ body: expect.objectContaining({ text: 'think-b done' }) }),
        ]));
        expect(new Set(finalThinkingMessages.map((call) => call.opts.localId)).size).toBe(2);
    });

    it('keeps Codex plan and agent message assistant items in separate transcript streams', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-plan-agent-message-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-plan-and-agent-message');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistantMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'message' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');

        expect(finalAssistantMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ message: 'Plan final' }) }),
            expect.objectContaining({ body: expect.objectContaining({ message: 'Answer final' }) }),
        ]));
        expect(finalAssistantMessages.some((call) => call.body.message === 'Plan finalAnswer final')).toBe(false);
        expect(new Set(finalAssistantMessages.map((call) => call.opts.localId)).size).toBe(2);
    });

    it('commits a late final assistant item that arrives after turn/completed', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-final-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({
                completeTurn: vi.fn(async () => {
                    eventOrder.push('completed-status');
                }),
            }),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }) => {
                if (body.type === 'message') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn((value: boolean) => {
                eventOrder.push(value ? 'thinking-started' : 'thinking-stopped');
            }),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-final-after-turn-completed');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toContain('Late final answer');
        expect(eventOrder.indexOf('assistant-final')).toBeGreaterThanOrEqual(0);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
        expect(eventOrder.indexOf('thinking-stopped')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
    });

    it('commits a raw assistant final when no normalized assistant final arrives', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-final-only-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({
                completeTurn: vi.fn(async () => {
                    eventOrder.push('completed-status');
                }),
            }),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }) => {
                if (body.type === 'message') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn((value: boolean) => {
                eventOrder.push(value ? 'thinking-started' : 'thinking-stopped');
            }),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-final-only');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(['Raw final answer']);
        expect(eventOrder.indexOf('assistant-final')).toBeGreaterThanOrEqual(0);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
        expect(eventOrder.indexOf('thinking-stopped')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
    });

    it('does not duplicate the assistant message when a raw final and normalized final both arrive', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-and-normalized-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-and-normalized-final');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(['Normalized final answer']);
    });

    it('does not drop an item-scoped raw final when another assistant item has a normalized final', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-normalized-different-items-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-and-normalized-different-items');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(expect.arrayContaining(['Raw item answer', 'Normalized item answer']));
        expect(assistantMessages).not.toContain('Raw item answerNormalized item answer');
    });

    it('commits an item-scoped raw final before a following tool call boundary', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-before-tool-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }, opts: { meta?: Record<string, unknown> }) => {
                const segmentState = opts.meta?.happierStreamSegmentV1 && typeof opts.meta.happierStreamSegmentV1 === 'object'
                    ? (opts.meta.happierStreamSegmentV1 as { segmentState?: unknown }).segmentState
                    : null;
                if (body.type === 'message' && segmentState === 'complete') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn((message: { type?: string }) => {
                if (message.type === 'tool-call') eventOrder.push('tool-call');
            }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-item-raw-final-before-tool-call');

        expect(eventOrder).toContain('assistant-final');
        expect(eventOrder).toContain('tool-call');
        expect(eventOrder.indexOf('assistant-final')).toBeLessThan(eventOrder.indexOf('tool-call'));
    });

    it('emits a canonical Diff tool when the app-server publishes turn diff updates', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-turn-diff-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-turn-diff');

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({
                    type: 'tool-call',
                    name: 'Diff',
                    input: expect.objectContaining({
                        files: [
                            expect.objectContaining({
                                file_path: 'src/diffed.ts',
                                unified_diff: expect.stringContaining('src/diffed.ts'),
                            }),
                        ],
                        _happier: expect.objectContaining({
                            provider: 'codex',
                            rawToolName: 'CodexDiff',
                            sessionChangeScope: 'turn',
                            turnId: 'turn-bridge-turn-diff',
                        }),
                    }),
                })],
            ]),
        );
    });

    it('does not infer a canonical Diff tool from git when command-only app-server turns mutate files without fileChange events', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-command-only-git-diff-');
        for (const args of [
            ['init'],
            ['config', 'user.email', 'test@example.com'],
            ['config', 'user.name', 'Test User'],
            ['commit', '--allow-empty', '-m', 'init'],
        ]) {
            const result = await runScmCommand({ bin: 'git', cwd: root, args });
            expect(result.success, `${args.join(' ')} failed: ${result.stderr}`).toBe(true);
        }
        await writeFile(join(root, 'pre-existing-dirty.txt'), 'already dirty before the turn\n', 'utf8');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-command-only-git-diff');

        const diffCall = session.sendCodexMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'tool-call' && message.name === 'Diff');
        expect(diffCall).toBeUndefined();
    });

    it('does not infer a canonical Diff tool from a filesystem snapshot when command-only app-server turns mutate files outside git', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-command-only-filesystem-diff-');
        await writeFile(join(root, 'pre-existing-dirty.txt'), 'already present before the turn\n', 'utf8');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-command-only-git-diff');

        const diffCall = session.sendCodexMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'tool-call' && message.name === 'Diff');
        expect(diffCall).toBeUndefined();
    });

    it('bridges completed-only command results as a synthetic tool-call plus tool-result', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-completed-only-command-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-completed-only-command-result');

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({
                    type: 'tool-call',
                    callId: 'call_failed_1',
                    name: 'CodexBash',
                    input: { command: 'mkdir -p /tmp/demo', cwd: '/repo' },
                })],
                [expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'call_failed_1',
                    output: expect.objectContaining({
                        stderr: expect.stringContaining('rejected by user'),
                        exitCode: 1,
                    }),
                })],
            ]),
        );
    });

    it('routes child-thread item notifications into a synthetic SubAgent sidechain without leaking them into the parent transcript', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-foreign-thread-streams-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-foreign-thread-streams');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; sidechainId?: string | null }, { localId: string; meta?: Record<string, any> }]
        >;
        const parentAssistantMessages = committedCalls
            .map(([, body]) => body)
            .filter((body) => body?.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        expect(parentAssistantMessages.some((value) => value.includes('Child'))).toBe(false);

        const childAssistantMessages = committedCalls
            .map(([, body]) => body)
            .filter((body) => body?.type === 'message' && body.sidechainId === 'thread-child')
            .map((body) => String(body.message ?? ''));
        expect(childAssistantMessages.some((value) => value.includes('Child'))).toBe(true);
        expect(childAssistantMessages.some((value) => value.includes('final'))).toBe(true);
        expect(session.sendAgentMessageCommitted.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'Parent final' }), expect.any(Object)],
            ]),
        );
        expect(session.sendAgentMessageCommitted.mock.calls).not.toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'Child ' }), expect.any(Object)],
                ['codex', expect.objectContaining({ type: 'message', message: 'Child final' }), expect.any(Object)],
            ]),
        );
        expect(session.sendAgentMessage.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({
                    type: 'tool-call',
                    callId: 'thread-child',
                    name: 'SubAgent',
                    input: expect.objectContaining({
                        threadId: 'thread-child',
                    }),
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-call',
                    callId: 'child_cmd',
                    name: 'CodexBash',
                    sidechainId: 'thread-child',
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'child_cmd',
                    sidechainId: 'thread-child',
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-result',
                    callId: 'thread-child',
                    output: expect.objectContaining({
                        status: 'completed',
                        threadId: 'thread-child',
                    }),
                })],
            ]),
        );
    });

    it('bridges approval and request-user-input server requests through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-approvals-');

        const permissionHandler = {
            handleToolCall: vi
                .fn()
                .mockResolvedValueOnce({ decision: 'approved_for_session' })
                .mockResolvedValueOnce({ decision: 'approved' })
                .mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-approvals');

        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            1,
            'cmd_approval',
            'CodexBash',
            { command: 'rm -rf /tmp/demo', cwd: '/repo' },
        );
        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            2,
            'patch_approval',
            'CodexPatch',
            { changes: { 'src/file.ts': { hunks: 1 } } },
        );
        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            3,
            'tool_input',
            'mcp__playwright__browser_navigate',
            {
                url: 'https://example.com',
                requestUserInput: {
                    questions: [
                        expect.objectContaining({ id: 'freeform_note' }),
                        expect.objectContaining({ id: 'tool_questions' }),
                    ],
                },
            },
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'approval-cmd', params: null, result: { decision: 'acceptForSession' }, error: null }),
                expect.objectContaining({ id: 'approval-patch', params: null, result: { decision: 'accept' }, error: null }),
                expect.objectContaining({
                    id: 'request-input',
                    params: null,
                    result: {
                        answers: {
                            tool_questions: {
                                answers: ['Approve Once'],
                            },
                        },
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('bridges permission escalation server requests through the generic permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-request-permissions-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved_for_session' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-request-permissions');

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'perm_request_1',
            'request_permissions',
            {
                cwd: '/repo',
                reason: 'Needs network access',
                permissions: {
                    network: { enabled: true },
                    fileSystem: { write: ['/repo/generated'] },
                },
            },
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'request-permissions',
                    params: null,
                    result: {
                        permissions: {
                            network: { enabled: true },
                            fileSystem: { write: ['/repo/generated'] },
                        },
                        scope: 'session',
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('bridges MCP elicitation server requests through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'mcp-elicitation-request',
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'mcp_tool_1',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('syncs completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-completed');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'New Title' },
                        error: null,
                    }),
                ]),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('syncs completed Happier title tool calls returned in MCP content envelopes to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-content-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-completed-content-envelope');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'Content Envelope Title' },
                        error: null,
                    }),
                ]),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('does not sync blank completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-blank-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-blank-title');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog.filter((entry) => entry.method === 'thread/name/set')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('does not sync failed completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-failed-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-failed');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog.filter((entry) => entry.method === 'thread/name/set')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('keeps completed Happier title tool calls accepted when Codex native title sync fails', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-fails-');
        const sendCodexMessage = vi.fn();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage,
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-native-sync-fails');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'fail-native-title-sync' },
                    }),
                ]),
            );
            expect(sendCodexMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'mcp_title_native_fail',
                    output: { success: true, title: 'fail-native-title-sync' },
                }),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('bridges MCP elicitation requests that use callId fields through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-callid-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-callid');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'mcp-elicitation-request-callid',
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'call_test_1',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('bridges Codex mcpServer/elicitation requests that only include serverName + message + _meta.tool_params', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-meta-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-meta');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('bridges Codex mcpServer/elicitation requests that identify the tool through _meta.tool_title', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-meta-tool-title-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-meta-tool-title');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('prefers the elicitation message tool id over a display-only _meta.tool_title label', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-display-title-message-tool-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-display-title-with-message-tool');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('declines unidentified Codex mcpServer/elicitation requests with the app-server response shape', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-unidentified-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-unidentified');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'decline' },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    });

    it('bridges non-approval request-user-input prompts as AskUserQuestion and returns structured answers', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-user-action-');

        const permissionHandler = {
            handleToolCall: vi
                .fn()
                .mockResolvedValueOnce({
                    decision: 'approved',
                    answers: {
                        'Which session export behavior should the plan target?': 'Single JSON',
                    },
                }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-user-action');

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'tool_input_general',
            'AskUserQuestion',
            {
                questions: [
                    {
                        header: 'Export Shape',
                        question: 'Which session export behavior should the plan target?',
                        options: [
                            { label: 'Single JSON', description: 'Portable JSON export' },
                            { label: 'Single CSV', description: 'Spreadsheet export' },
                        ],
                        multiSelect: false,
                    },
                ],
            },
        );

        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => entry.id === 'request-input-general');
        }, {
            timeoutMs: 500,
            intervalMs: 10,
            label: 'Codex app-server structured user-input response',
            debug: () => requestLogPath,
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'request-input-general',
                    params: null,
                    result: {
                        answers: {
                            export_shape: {
                                answers: ['Single JSON'],
                            },
                        },
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('applies session mode, model, reasoning, and Fast overrides through app-server requests and republishes metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-controls-');

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});
        await runtime.setSessionMode('plan');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('reasoning_effort', 'high');
        await runtime.sendPrompt('use-overrides');

        const latestMetadata = updateMetadata.mock.results.at(-1)?.value;

        expect(latestMetadata).toMatchObject({
            [SESSION_MODES_STATE_KEY]: expect.objectContaining({ currentModeId: 'plan' }),
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: expect.objectContaining({
                configOptions: [],
            }),
        });
        const modelsState = (latestMetadata as Record<string, unknown>)[SESSION_MODELS_STATE_KEY] as any;
        expect(modelsState).toMatchObject({ currentModelId: 'gpt-5.4' });
        const availableModels = Array.isArray(modelsState?.availableModels) ? modelsState.availableModels : [];
        const gptModel = availableModels.find((model: any) => model && model.id === 'gpt-5.4');
        expect(gptModel).toBeTruthy();
        const modelOptions = Array.isArray(gptModel?.modelOptions) ? gptModel.modelOptions : [];
        const byId = (id: string) => modelOptions.find((opt: any) => opt && opt.id === id);
        expect(byId('reasoning_effort')?.currentValue).toBe('high');
        expect(updateMetadata.mock.results.map((entry) => entry.value)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ codexSessionId: 'thread-started' }),
            ]),
        );

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(
            requestLog
                .filter((entry) => entry.method === 'collaborationMode/list')
                .every((entry) => JSON.stringify(entry.params ?? null) === '{}'),
        ).toBe(true);
        expect(
            requestLog
                .filter((entry) => entry.method === 'model/list')
                .every((entry) => JSON.stringify(entry.params ?? null) === '{}'),
        ).toBe(true);
        expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([]);
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'turn/start',
                    params: expect.objectContaining({
                        threadId: 'thread-started',
                        model: 'gpt-5.4',
                        effort: 'high',
                        serviceTier: 'fast',
                        collaborationMode: {
                            mode: 'plan',
                            settings: {
                                model: 'gpt-5.4',
                                reasoning_effort: 'high',
                                developer_instructions: null,
                            },
                        },
                    }),
                }),
            ]),
        );
    });

    it('includes preselected model, reasoning, and Fast service tier in fresh thread/start requests', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-overrides-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionConfigOption('reasoning_effort', 'high');
        await runtime.startOrLoad({});

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        model: 'gpt-5.4',
                        serviceTier: 'fast',
                        config: {
                            model_reasoning_effort: 'high',
                        },
                        persistExtendedHistory: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps Fast service tier for the first turn even when thread/start responds with serviceTier: null', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-fast-persist-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.startOrLoad({});
        await runtime.sendPrompt('fast-persist');

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const firstTurnStart = requestLog.find((entry) => entry.method === 'turn/start');
        expect(firstTurnStart).toMatchObject({
            params: expect.objectContaining({
                serviceTier: 'fast',
            }),
        });
    });

    it('clears Fast service tier by sending serviceTier: null when switching back to Standard', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-service-tier-clear-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionConfigOption('service_tier', 'standard');
        await runtime.sendPrompt('speed-standard');

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([]);
        const lastTurnStart = [...requestLog].reverse().find((entry) => entry.method === 'turn/start');
        expect(lastTurnStart).toMatchObject({
            params: expect.objectContaining({
                serviceTier: null,
            }),
        });
    });

    for (const authEnvVar of ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const) {
        it(`does not surface Speed controls when Codex is authenticated only by ${authEnvVar}`, async () => {
            const { root, requestLogPath: _requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-');
            const scopedEnv = createCodexAppServerProcessEnv(fakeAppServer, {
                [authEnvVar]: 'sk-test-codex',
            });

            const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
                updater({ machineId: 'machine_1' }),
            );
            const runtime = createCodexAppServerRuntime({
                directory: root,
                processEnv: scopedEnv,
                onThinkingChange: vi.fn(),
                session: { updateMetadata } as any,
            });

            await runtime.startOrLoad({});

            expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
                [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                    configOptions: [],
                },
            });
        });
    }

    it('forwards thread token usage updates and patches the active model context window from runtime telemetry', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-token-usage-');

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                sendCodexMessage,
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-token-usage');

        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'token_count',
            model: 'gpt-5.4',
            size: 1_000_000,
            tokens: expect.objectContaining({
                total: 1200,
                input: 700,
                cache_read: 200,
                output: 250,
                thought: 50,
            }),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.not.objectContaining({
            used: expect.any(Number),
        }));

        const latestMetadata = updateMetadata.mock.results.at(-1)?.value as Record<string, unknown>;
        const modelsState = latestMetadata[SESSION_MODELS_STATE_KEY] as {
            currentModelId?: string;
            availableModels?: Array<Record<string, unknown>>;
        };
        expect(modelsState?.currentModelId).toBe('gpt-5.4');
        expect(modelsState?.availableModels).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'gpt-5.4',
                    contextWindowTokens: 1_000_000,
                }),
            ]),
        );
    });

    it('forwards app-server context compaction lifecycle notifications as session events', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-context-compaction-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('bridge-context-compaction')).resolves.toBeUndefined();

        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'context-compaction',
            phase: 'started',
            lifecycleId: 'compact_1',
            provider: 'codex',
            source: 'provider-event',
            providerEventId: 'compact_1',
        });
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: 'compact_1',
            provider: 'codex',
            source: 'provider-event',
            providerEventId: 'compact_1',
        });
    });

    it('triggers manual app-server compaction through thread/compact/start', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-manual-context-compaction-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});
        await expect(runtime.compactContext('/compact')).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/compact/start',
                params: { threadId: 'thread-started' },
            }),
        ]));
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'context-compaction',
            phase: 'started',
            lifecycleId: 'manual_compact_1',
        }));
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: 'manual_compact_1',
        }));
    });

    it('surfaces failed turns as provider errors and aborts the pending turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-failed-turn-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('failed-turn')).rejects.toThrow(/401 Unauthorized/);

        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('401 Unauthorized'),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
    });

    it('carries structured connected-service usage-limit classification on app-server turn failures', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: null,
                groupId: null,
                resetsAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                planType: 'pro',
                source: 'structured_provider_error',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    recoverability: 'wait',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: null,
                        groupId: null,
                    },
                }),
            }),
        }));
    });

    it('carries selected Codex group context on app-server usage-limit failures', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-group-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'leeroy',
                fallbackProfileId: 'backup',
                generation: 7,
            }]),
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'leeroy',
                groupId: 'happier',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    recoverability: 'switch_account',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: 'leeroy',
                        groupId: 'happier',
                    },
                }),
            }),
        }));
    });

    it('recovers connected-service group context from session metadata when env selection is absent', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-metadata-group-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        (metadata as Record<string, unknown>).connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                    profileId: 'leeroy',
                },
            },
        };

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'leeroy',
                groupId: 'happier',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    recoverability: 'switch_account',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: 'leeroy',
                        groupId: 'happier',
                    },
                }),
            }),
        }));
    });

    it('persists observed stable Codex usage-limit failures through the real session lifecycle', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-stable-usage-limit-');
        const mutations: unknown[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: 'session-stable-usage-limit',
            createId: () => `stable-${mutations.length}`,
            now: () => 1_700_000_000_000 + mutations.length,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        const sendCodexMessage = vi.fn((body: ACPMessageData) => {
            void sessionTurnLifecycle.observeAcpLifecycleMarker({
                provider: 'codex',
                body,
            }).pendingWrite;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-stable-usage-limit',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-stable-message')).rejects.toThrow(/usage limit/i);

        expect(mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: 'begin',
                provider: 'codex',
            }),
            expect.objectContaining({
                action: 'fail',
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        v: 1,
                        recoverability: 'wait',
                    }),
                }),
            }),
        ]));
    });

    it('persists alternate reused refresh-token wording as a connected-service auth failure', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-refresh-reused-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'bot',
                fallbackProfileId: 'leeroy',
                generation: 9,
            }]),
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-refresh-token-reused',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('refresh-token-was-already-used')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'refresh_failed',
                limitCategory: 'auth',
                serviceId: 'openai-codex',
                profileId: 'bot',
                groupId: 'happier',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'auth_error',
                usageLimit: expect.objectContaining({
                    limitCategory: 'auth',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: 'bot',
                        groupId: 'happier',
                    },
                }),
            }),
        }));
    });

    it('persists early app-server usage-limit errors before the turn start response is adopted', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-early-usage-limit-');
        const mutations: unknown[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: 'session-early-usage-limit',
            createId: () => `early-${mutations.length}`,
            now: () => 1_700_000_000_000 + mutations.length,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'bot',
                fallbackProfileId: 'leeroy',
                generation: 9,
            }]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-early-usage-limit',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-before-turn-response')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'bot',
                groupId: 'happier',
            },
        });

        expect(mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: 'fail',
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        recoverability: 'switch_account',
                        connectedService: {
                            serviceId: 'openai-codex',
                            profileId: 'bot',
                            groupId: 'happier',
                        },
                    }),
                }),
            }),
        ]));
    });

    it('arms usage-limit wait/resume from the latest issue and probes Codex rate limits on check-now', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-recovery-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const rememberUsageLimitRecoveryPreference = vi.fn(async () => {});
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'profile',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                },
            ]),
        });
        const session = {
            sessionId: 'session-usage-recovery',
            updateMetadata,
            sessionTurnLifecycle,
            getMetadataSnapshot: () => metadata,
            sendCodexMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
        } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'];
        const runtimeParams: Parameters<typeof createCodexAppServerRuntime>[0] & {
            rememberUsageLimitRecoveryPreference: typeof rememberUsageLimitRecoveryPreference;
        } = {
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session,
            rememberUsageLimitRecoveryPreference,
        };
        const runtime = createCodexAppServerRuntime(runtimeParams);

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                },
            });
            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string; rememberPreference?: boolean }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };

            expect(runtimeControls.enableUsageLimitWaitResume).toBeTypeOf('function');
            await expect(runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-recovery',
                rememberPreference: true,
            })).resolves.toMatchObject({
                ok: true,
                recovery: {
                    status: 'waiting',
                },
            });
            expect(rememberUsageLimitRecoveryPreference).toHaveBeenCalledTimes(1);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    selectedAuth: {
                        kind: 'profile',
                        serviceId: 'openai-codex',
                        profileId: 'work',
                    },
                },
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-recovery' })).resolves.toMatchObject({
                ok: true,
                status: 'resumed',
            });
            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).toContain('account/rateLimits/read');
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'thread-started',
                    }),
                }),
            ]);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'cancelled',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('arms usage-limit recovery from the latest issue before probing on check-now', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-check-now-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-check-now',
                updateMetadata,
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const runtimeControls = runtime as typeof runtime & {
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-check-now' })).resolves.toMatchObject({
                ok: true,
                status: 'resumed',
            });

            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).toContain('account/rateLimits/read');
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'cancelled',
                    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
                },
            });
            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-check-now' })).resolves.toMatchObject({
                ok: true,
                status: 'rate_limited',
                errorCode: 'probe_rate_limited',
                retryAfterMs: expect.any(Number),
            });
        } finally {
            await runtime.reset();
        }
    });

    it('reruns connected-service group fallback when check-now finds the active Codex member still exhausted', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-group-recovery-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            ok: true,
            result: {
                status: 'switch_attempted',
                result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
            },
        }));
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'primary',
                    fallbackProfileId: 'primary',
                    generation: 1,
                },
            ]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-group-recovery',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await expect(runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-group-recovery',
            })).resolves.toMatchObject({
                ok: true,
                recovery: {
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        profileId: 'primary',
                    },
                },
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-group-recovery' })).resolves.toMatchObject({
                ok: true,
                status: 'waiting',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    nextCheckAtMs: expect.any(Number),
                },
            });
            const recovery = (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as { nextCheckAtMs?: number };
            expect(recovery.nextCheckAtMs).toBeLessThanOrEqual(Date.now());
            expect(onUsageLimitGroupRecovery).toHaveBeenCalledWith({
                sessionId: 'session-usage-group-recovery',
                classification: expect.objectContaining({
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    profileId: 'primary',
                    resetsAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    planType: 'pro',
                }),
            });
        } finally {
            await runtime.reset();
        }
    });

    it('surfaces typed group generation apply failures during usage-limit check-now', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-group-apply-failed-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            ok: true,
            result: {
                status: 'switch_attempted',
                result: {
                    status: 'generation_apply_failed',
                    activeProfileId: 'backup',
                    generation: 2,
                    errorCode: 'provider_session_state_unavailable_for_resume',
                },
            },
        }));
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'primary',
                    fallbackProfileId: 'primary',
                    generation: 1,
                },
            ]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-group-apply-failed',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-group-apply-failed',
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-group-apply-failed',
            })).resolves.toMatchObject({
                ok: true,
                status: 'exhausted',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'exhausted',
                    lastProbeError: 'connected_service_generation_apply_failed:provider_session_state_unavailable_for_resume',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('auto-arms usage-limit wait/resume when the account setting is auto-wait', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-auto-wait-');
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: {
                usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
            } as AccountSettings,
            settingsVersion: 1,
            loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [],
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-auto-wait',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    selectedAuth: { kind: 'native' },
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('auto-arms usage-limit recovery with a derived next check when only retry-after timing is available', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-retry-after-auto-wait-');
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: {
                usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
            } as AccountSettings,
            settingsVersion: 1,
            loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [],
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-retry-after-auto-wait',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            const beforeFailureMs = Date.now();
            await expect(runtime.sendPrompt('usage-limit-retry-after-only')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                    resetsAtMs: null,
                    retryAfterMs: 120_000,
                },
            });
            const afterFailureMs = Date.now();

            const recovery = (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as {
                resetAtMs?: number | null;
                nextCheckAtMs?: number | null;
            };
            expect(recovery).toMatchObject({
                status: 'waiting',
                resetAtMs: null,
                selectedAuth: { kind: 'native' },
            });
            expect(recovery.nextCheckAtMs).toBeGreaterThanOrEqual(beforeFailureMs + 120_000);
            expect(recovery.nextCheckAtMs).toBeLessThanOrEqual(afterFailureMs + 120_000);
        } finally {
            await runtime.reset();
        }
    });

    it('restores a persisted usage-limit wait/resume intent after start', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-recovery-restore-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
            ...({
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: 'usage-limit:session-usage-restore:1',
                armedAtMs: Date.now() - 1_000,
                resetAtMs: Date.now(),
                nextCheckAtMs: Date.now(),
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                selectedAuth: { kind: 'native' },
            },
            } satisfies Record<string, unknown>),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-restore',
                updateMetadata,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});

            await expect.poll(async () => (await readRequestLog(requestLogPath)).map((entry) => entry.method)).toContain('thread/resume');
            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).toContain('account/rateLimits/read');
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'thread-started',
                    }),
                }),
            ]);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'cancelled',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('publishes Codex account/rateLimits/updated snapshots to the runtime quota callback', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-rate-limit-update-');

        const onRateLimitSnapshot = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('rate-limit-update');

        expect(onRateLimitSnapshot).toHaveBeenCalledWith({
            rateLimits: {
                limitId: 'codex',
                limitName: null,
                primary: {
                    usedPercent: 88,
                    windowDurationMins: 300,
                    resetsAt: 1_779_098_400,
                },
                secondary: null,
                credits: null,
                planType: 'pro',
                rateLimitReachedType: null,
            },
        });
    });

    it('handles Codex ChatGPT token refresh requests without returning refresh tokens', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-chatgpt-refresh-');

        const onChatGptAuthTokensRefresh = vi.fn(async () => ({
            accessToken: 'fresh-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onChatGptAuthTokensRefresh,
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-chatgpt-refresh');

        expect(onChatGptAuthTokensRefresh).toHaveBeenCalledWith({
            chatgptPlanType: 'plus',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'refresh-chatgpt-tokens',
                result: {
                    accessToken: 'fresh-access',
                    chatgptAccountId: 'acct_123',
                    chatgptPlanType: 'plus',
                },
            }),
        ]));
        const refreshResponse = requestLog.find((entry) => entry.id === 'refresh-chatgpt-tokens' && entry.result);
        expect(refreshResponse?.result).not.toHaveProperty('refreshToken');
    });

    it('restarts the app-server process and resumes the same thread when Codex reports the cached auth account changed', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-account-change-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('account-mismatch-once')).resolves.toBeUndefined();

        expect(runtime.getSessionId()).toBe('thread-started');
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(2);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        const retriedTurnStarts = requestLog.filter((entry: { method: string; params?: { input?: Array<{ text?: string }>; threadId?: string } }) =>
            entry.method === 'turn/start' && entry.params?.input?.[0]?.text === 'account-mismatch-once',
        );
        expect(retriedTurnStarts).toHaveLength(2);
        expect(retriedTurnStarts.map((entry: { params?: { threadId?: string } }) => entry.params?.threadId)).toEqual([
            'thread-started',
            'thread-started',
        ]);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('access token could not be refreshed'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
    });

    it('recovers by compacting then resuming before retrying a context-window-exhausted turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-recovery-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-once')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/compact/start',
                params: { threadId: 'thread-started' },
            }),
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        const retriedTurnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-once';
        });
        expect(retriedTurnStarts).toHaveLength(2);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('context window'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
    });

    it('continues instead of replaying the original prompt after context-window exhaustion with turn activity', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-activity-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-after-activity')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(1);
        const turnStarts = requestLog.filter((entry) => entry.method === 'turn/start') as Array<{
            params?: { input?: Array<{ text?: string }>; threadId?: string };
        }>;
        const prompts = turnStarts.map((entry) => entry.params?.input?.[0]?.text ?? '');
        expect(prompts.filter((text) => text === 'context-window-exhausted-after-activity')).toHaveLength(1);
        expect(prompts.some((text) => text.includes('continue') && text.includes('repeat completed work'))).toBe(true);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('context window'),
        }));
    });

    it('surfaces context-window exhaustion without compacting when Codex recovery is disabled', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-disabled-');
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CODEX_CONTEXT_WINDOW_RECOVERY_MODE: 'off',
        });

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-once')).rejects.toThrow(/upstream provider rejected/);

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const turnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }> } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-once';
        });
        expect(turnStarts).toHaveLength(1);
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('upstream provider rejected'),
        }));
    });

    it('surfaces the original context-window failure when retrying after compaction fails again', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-repeat-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-twice')).rejects.toThrow('ORIGINAL_CONTEXT_WINDOW_FAILURE');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(1);
        const retriedTurnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-twice';
        });
        expect(retriedTurnStarts).toHaveLength(2);
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('ORIGINAL_CONTEXT_WINDOW_FAILURE'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('RETRY_CONTEXT_WINDOW_FAILURE'),
        }));
    });

    it('invalidates connected-service auth transports by restarting the app-server and resuming the same thread', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-hot-apply-invalidate-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect((runtime as any).invalidateConnectedServiceAuthTransports?.({})).resolves.toEqual({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(2);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
    });

    it('treats connected-service auth invalidation as a no-op when no active thread is running', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-hot-apply-unsupported-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await expect((runtime as any).invalidateConnectedServiceAuthTransports?.({})).resolves.toEqual({ ok: true });
    });

    it('suppresses retryable Codex errors until a later hard failure aborts the pending turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-retry-then-failed-turn-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('retry-then-failed-turn')).rejects.toThrow(/401 Unauthorized/);

        const surfacedMessages = sendCodexMessage.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'message');
        expect(surfacedMessages).toHaveLength(1);
        expect(surfacedMessages[0]).toEqual(expect.objectContaining({
            message: expect.stringContaining('401 Unauthorized'),
        }));
        expect(surfacedMessages[0]).toEqual(expect.not.objectContaining({
            message: expect.stringContaining('temporary upstream overload'),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
        expect(sendSessionEvent).not.toHaveBeenCalled();
    });

    it('rolls back the latest conversation turn through the app-server thread API and records its transcript seq range', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-');

        let lastObservedMessageSeq = 7;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-latest-local' ? 7 : null),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 11;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-latest-local' });
        await (runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
        expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
            sessionRollbackRangesV1: {
                v: 1,
                ranges: [
                    {
                        target: { type: 'latest_turn' },
                        startSeqInclusive: 7,
                        endSeqInclusive: 11,
                        rolledBackAt: expect.any(Number),
                    },
                ],
                updatedAt: expect.any(Number),
            },
        });
    });

    it('does not fail rollback after app-server success when rollback metadata persistence rejects', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-metadata-reject-');

        let lastObservedMessageSeq = 7;
        let metadataSnapshot: Record<string, unknown> = { machineId: 'machine_1' };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                    const nextMetadata = updater(metadataSnapshot);
                    if (Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionRollbackRangesV1')) {
                        throw new Error('rollback metadata unavailable');
                    }
                    metadataSnapshot = nextMetadata;
                    return metadataSnapshot;
                }),
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-metadata-reject-local' ? 7 : null),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 11;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-metadata-reject-local' });

        await expect((runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toMatchObject({
            ok: true,
            target: { type: 'latest_turn' },
            threadId: 'thread-started',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
    });

    it('rolls back before a user message even when user-message seq increments after the onUserMessage callback fires', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-user-message-seq-order-');

        let lastObservedMessageSeq = 0;
        let lastObservedUserMessageSeq = 0;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-seq-order-local' ? 1 : null),
                // Simulate session client updating the seq counters after the user-message callback begins.
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 3;
                    lastObservedUserMessageSeq = 1;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-seq-order-local' });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 1,
            },
        })).resolves.toMatchObject({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
    });

    it('does not use legacy session turn metadata as rollback evidence after resume', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-resume-session-turn-');

        let metadataSnapshot: Record<string, unknown> = {
            machineId: 'machine_1',
            sessionTurnLedgerV1: {
                v: 1,
                sessionId: 'codex-app-server',
                backendId: 'codex-app-server',
                agentId: 'codex',
                providerThreadId: 'thread-resumed',
                currentTurnId: 'provider-turn-1',
                updatedAt: 10,
                entries: [
                    {
                        turnId: 'provider-turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: {
                            startUserMessageSeq: 21,
                            userMessageSeqs: [21],
                            startSeqInclusive: 21,
                            endSeqInclusive: 25,
                        },
                        rollback: { state: 'eligible', updatedAt: 10 },
                    },
                ],
                recentMutationIds: ['provider-turn-1'],
            },
        };
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => 25),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({ existingSessionId: 'thread-resumed' });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 21,
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/rollback')).toEqual([]);
    });

    it('rolls back multiple turns before a target user message and records the rolled-back seq range', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-before-user-message-');

        let lastObservedMessageSeq = 3;
        let lastObservedUserMessageSeq = 1;
        let nextTurnEndSeq = 5;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => {
                    if (localId === 'rollback-first-local') return 1;
                    if (localId === 'rollback-second-local') return 4;
                    return null;
                }),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = nextTurnEndSeq;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-first-local' });
        lastObservedMessageSeq = 7;
        lastObservedUserMessageSeq = 4;
        nextTurnEndSeq = 9;
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-second-local' });

        await (runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 1,
            },
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 2 },
                }),
            ]),
        );
        expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
            sessionRollbackRangesV1: {
                v: 1,
                ranges: [
                    {
                        target: {
                            type: 'before_user_message',
                            userMessageSeq: 1,
                        },
                        startSeqInclusive: 3,
                        endSeqInclusive: 9,
                        rolledBackAt: expect.any(Number),
                    },
                ],
                updatedAt: expect.any(Number),
            },
        });
    });

    it('returns unsupported_action when rollback is rejected by app-server schema support', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-rollback-unsupported-',
            { rollbackError: { code: -32602, message: 'invalid params: expected { threadId, numTurns }' } },
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => updater({ machineId: 'machine_1' })),
                getLastObservedMessageSeq: vi.fn(() => 11),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-unsupported-local' ? 11 : null),
                sendAgentMessageCommitted: vi.fn(async () => undefined),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-unsupported-local' });

        await expect((runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_action',
            errorMessage: expect.stringContaining('invalid params'),
        });
    });
});
