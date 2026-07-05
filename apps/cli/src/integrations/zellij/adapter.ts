import { basename } from 'node:path';

import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostLiveness,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '../terminalHost/_types';
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import { TerminalHostStartupError, isTerminalHostStartupError } from '../terminalHost/errors';
import {
  defaultZellijActions,
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  isZellijActionTimeoutError,
  type ZellijCommandResult,
  type ZellijActions,
  type ZellijDetachedCommandHandle,
  type ZellijPane,
} from './actions';
import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import { resolvePromptSubmitTimeoutMs } from '../terminalHost/promptSubmitTimeout';
import { createZellijTerminalControlPort } from './control';
import { prepareZellijSocketDir, resolveZellijSocketDir } from './socketDir';

const DEFAULT_INPUT_STABILITY_DELAY_MS = 50;
/**
 * R-E2: freshness window for reusing a `listPanes`-backed liveness inspection across the
 * readiness/liveness bridges' back-to-back `evaluateLiveness` + `captureInputState` calls within one
 * poll tick. Short enough that injection/control paths still observe near-current pane state.
 */
const LIVENESS_INSPECTION_FRESHNESS_MS = 100;
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS = 50;
const DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS = 1_000;
const MAX_LIVENESS_SCREEN_DUMP_CHARS = 2_000;

export type ZellijForegroundClientLaunchParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  cwd?: string;
  defaultShell?: string;
  timeoutMs: number;
}>;

export type ZellijLaunchStrategy =
  | Readonly<{ type: 'background' }>
  | Readonly<{
    type: 'foregroundAttached';
    launchClient(params: ZellijForegroundClientLaunchParams): Promise<void>;
  }>;

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sessionEnv(baseEnv: Readonly<Record<string, string>>, sessionName: string): Readonly<Record<string, string>> {
  return {
    ...baseEnv,
    ZELLIJ_SESSION_NAME: sessionName,
  };
}

function resolvePaneId(pane: ZellijPane): string | null {
  const value = pane.pane_id ?? pane.id;
  if (value === undefined || value === null) return null;
  return String(value);
}

function resolvePaneIdFromRunOutput(stdout: string): string | null {
  const value = stdout.trim();
  return /^(?:terminal_)?\d+$/.test(value) ? value : null;
}

function resolveLaunchedTerminalPaneId(params: Readonly<{
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  panes: readonly ZellijPane[];
}>): string | null {
  const paneIdFromRun = params.paneIdFromRun;
  if (paneIdFromRun !== null) {
    const matchingPane = params.panes.find((pane) => terminalPaneMatches(pane, paneIdFromRun));
    const normalizedPaneId = normalizePaneActionId(paneIdFromRun);
    if (
      matchingPane
      && isTerminalPaneAlive(matchingPane)
      && !isBootstrapTerminalPane(matchingPane, normalizedPaneId, params.preExistingPaneIds)
    ) {
      return normalizedPaneId;
    }
  }

  const liveTerminalPanes = params.panes.filter((pane) => {
    const paneId = resolveTerminalPaneActionId(pane);
    return paneId !== null && isTerminalPaneAlive(pane) && !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds);
  });
  if (liveTerminalPanes.length === 1) {
    const paneId = resolveTerminalPaneActionId(liveTerminalPanes[0]);
    if (paneId !== null) return paneId;
  }

  return null;
}

function normalizePaneActionId(paneId: string): string {
  return paneId.startsWith('terminal_') ? paneId : `terminal_${paneId}`;
}

function resolveTerminalPaneActionId(pane: ZellijPane): string | null {
  if (pane.is_plugin) return null;
  const paneId = resolvePaneId(pane);
  return paneId === null ? null : normalizePaneActionId(paneId);
}

function isBootstrapTerminalPane(pane: ZellijPane, paneId: string, preExistingPaneIds: ReadonlySet<string>): boolean {
  return preExistingPaneIds.has(paneId) || pane.terminal_command === null;
}

function paneMatches(pane: ZellijPane, paneId: string): boolean {
  const resolvedPaneId = resolvePaneId(pane);
  return resolvedPaneId === paneId || (resolvedPaneId !== null && `terminal_${resolvedPaneId}` === paneId);
}

function terminalPaneMatches(pane: ZellijPane, paneId: string): boolean {
  return !pane.is_plugin && paneMatches(pane, paneId);
}

function isTerminalPaneAlive(pane: ZellijPane): boolean {
  if (pane.exited === true) return false;
  if (pane.is_held === true) return false;
  return true;
}

function isLaunchedCommandPane(pane: ZellijPane): boolean {
  return !pane.is_plugin
    && isTerminalPaneAlive(pane)
    && typeof pane.terminal_command === 'string'
    && pane.terminal_command.trim().length > 0;
}

function isProvenReplacementCommandPane(params: Readonly<{
  pane: ZellijPane;
  paneId: string;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
}>): boolean {
  return params.replacementPaneIds.has(params.paneId)
    && commandPaneMatchesExpectedFragments(params.pane, params.expectedCommandFragments);
}

function resolvePostCleanupCommandPaneId(params: Readonly<{
  previousPaneId: string;
  panes: readonly ZellijPane[];
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
}>): string | null {
  const previousPane = params.panes.find((pane) => terminalPaneMatches(pane, params.previousPaneId));
  if (previousPane) {
    return isTerminalPaneAlive(previousPane) ? resolveTerminalPaneActionId(previousPane) : null;
  }

  const commandPanes = params.panes.filter((pane) => {
    const paneId = resolveTerminalPaneActionId(pane);
    return paneId !== null
      && params.replacementPaneIds.has(paneId)
      && commandPaneMatchesExpectedFragments(pane, params.expectedCommandFragments);
  });
  if (commandPanes.length !== 1) return null;
  return resolveTerminalPaneActionId(commandPanes[0]);
}

type ResolvedZellijPaneTarget = Readonly<{
  pane: ZellijPane;
  paneId: string;
}>;

function isUniqueCommandProofFragment(value: string): boolean {
  return !value.startsWith('-') && (value.includes('/') || value.includes('\\'));
}

function buildExpectedCommandFragments(command: readonly string[]): readonly string[] {
  const primaryExecutable = typeof command[0] === 'string' ? command[0].trim() : '';
  const launcher = typeof command[1] === 'string' ? basename(command[1].trim()) : '';
  const uniqueProof = typeof command[2] === 'string' && isUniqueCommandProofFragment(command[2].trim())
    ? command[2].trim()
    : '';
  const fragments = [primaryExecutable, launcher, uniqueProof].filter((value) => value.length > 0);
  return [...new Set(fragments)];
}

function readExpectedCommandFragments(handle: TerminalHostHandle): readonly string[] {
  const value = handle.expectedCommandFragments;
  if (!Array.isArray(value)) return [];
  return value.filter((fragment) => typeof fragment === 'string' && fragment.trim().length > 0);
}

function commandIncludesExpectedFragment(command: string, fragment: string): boolean {
  return command.includes(fragment);
}

function commandHasExpectedProofFragment(command: string, expectedCommandFragments: readonly string[]): boolean {
  const proofFragments = expectedCommandFragments.length > 2
    ? expectedCommandFragments.slice(2)
    : expectedCommandFragments.length > 1
      ? expectedCommandFragments.slice(1)
      : expectedCommandFragments;
  return proofFragments.some((fragment) => commandIncludesExpectedFragment(command, fragment));
}

function commandIsExecutableOnlyMatch(command: string, expectedCommandFragments: readonly string[]): boolean {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length !== 1) return false;
  return expectedCommandFragments.some((fragment) => commandIncludesExpectedFragment(tokens[0], fragment));
}

function paneCommandIsCompatibleWithExpectedFragments(
  pane: ZellijPane,
  expectedCommandFragments: readonly string[],
): boolean {
  if (expectedCommandFragments.length === 0) return true;
  const command = pane.terminal_command;
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  const normalizedCommand = command.trim();
  return commandHasExpectedProofFragment(normalizedCommand, expectedCommandFragments)
    || commandIsExecutableOnlyMatch(normalizedCommand, expectedCommandFragments);
}

function commandPaneMatchesExpectedFragments(
  pane: ZellijPane,
  expectedCommandFragments: readonly string[],
): boolean {
  const command = pane.terminal_command;
  return isLaunchedCommandPane(pane)
    && expectedCommandFragments.length > 0
    && typeof command === 'string'
    && commandHasExpectedProofFragment(command.trim(), expectedCommandFragments);
}

function resolveRuntimePaneTarget(params: Readonly<{
  panes: readonly ZellijPane[];
  paneId: string;
  expectedCommandFragments: readonly string[];
}>): ResolvedZellijPaneTarget | null {
  const exactPane = params.panes.find((pane) => terminalPaneMatches(pane, params.paneId));
  if (exactPane) {
    if (!paneCommandIsCompatibleWithExpectedFragments(exactPane, params.expectedCommandFragments)) return null;
    const exactPaneId = resolveTerminalPaneActionId(exactPane);
    return exactPaneId === null ? null : { pane: exactPane, paneId: exactPaneId };
  }

  const liveCommandPanes = params.panes.filter((pane) => commandPaneMatchesExpectedFragments(
    pane,
    params.expectedCommandFragments,
  ));
  if (liveCommandPanes.length !== 1) return null;
  const replacementPaneId = resolveTerminalPaneActionId(liveCommandPanes[0]);
  return replacementPaneId === null ? null : { pane: liveCommandPanes[0], paneId: replacementPaneId };
}

function paneDeadInjectionFailureIsRecoverable(params: Readonly<{
  panes: readonly ZellijPane[];
  target: ResolvedZellijPaneTarget | null;
}>): boolean {
  if (params.target !== null) return false;
  return !params.panes.some(isLaunchedCommandPane);
}

function truncateScreenDump(value: string): Readonly<{ text: string; truncated: boolean }> {
  if (value.length <= MAX_LIVENESS_SCREEN_DUMP_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_LIVENESS_SCREEN_DUMP_CHARS), truncated: true };
}

function summarizeDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalHostDiagnosticText(message).replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown_error';
}

function isInactiveZellijSessionError(error: unknown): boolean {
  const message = summarizeDiagnosticError(error);
  return /\bThere is no active session\b/i.test(message)
    || /\bEXITED\b.*\battach to resurrect\b/i.test(message);
}

function resolvePaneExitStatus(pane: ZellijPane | undefined): number | undefined {
  const value = pane?.exit_status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scheduledDeferral(input: TerminalPromptInput): Extract<TerminalInputInjectionResult, { status: 'deferred' }> | null {
  const reason = input.scheduling.deferReason;
  if (!reason) return null;
  return {
    status: 'deferred',
    reason,
    ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
  };
}

function paneInitializingDeferral(input: TerminalPromptInput): Extract<TerminalInputInjectionResult, { status: 'deferred' }> {
  return {
    status: 'deferred',
    reason: 'pane_initializing',
    ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
  };
}

function failedInjectionResult(params: Readonly<{
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  recoverable: boolean;
}>): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    recoverable: params.recoverable,
  };
}

function createZellijStartupTimeoutError(params: Readonly<{
  action: string;
  sessionName: string;
  actionTimeoutMs: number;
  message: string;
  lastError?: unknown;
}>): TerminalHostStartupError {
  const lastError = params.lastError instanceof Error
    ? params.lastError.message
    : params.lastError === undefined
      ? undefined
      : String(params.lastError);
  return new TerminalHostStartupError({
    hostKind: 'zellij',
    reason: 'startup_action_timeout',
    message: params.message,
    diagnostics: {
      action: params.action,
      sessionName: params.sessionName,
      timeoutMs: params.actionTimeoutMs,
      ...(lastError ? { lastError } : {}),
    },
  });
}

function isZellijMissingSessionOutput(output: string, sessionName: string): boolean {
  const normalizedOutput = output.toLowerCase();
  const normalizedSessionName = sessionName.toLowerCase();
  return normalizedOutput.includes(`no session named "${normalizedSessionName}" found`);
}

function stripAnsiCodes(input: string): string {
  return input.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function zellijSessionListContains(output: string, sessionName: string): boolean {
  const cleanOutput = stripAnsiCodes(output);
  return cleanOutput.split(/\r?\n/).some((line) => {
    const [listedName] = line.trimStart().split(/\s+/, 1);
    return listedName === sessionName;
  });
}

async function waitForListedZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  if (!params.actions.listSessions) return;

  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  let lastError: unknown;
  while (true) {
    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? `zellij session "${params.sessionName}" was not listed`);
      throw createZellijStartupTimeoutError({
        action: 'session_listing',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: `zellij session was not listed before addressability probing: ${message}`,
        lastError,
      });
    }

    const timeoutMs = remainingMs === undefined
      ? DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS
      : Math.max(1, Math.min(remainingMs, DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS));
    try {
      const result = await params.actions.listSessions({
        zellijBinary: params.zellijBinary,
        env: params.env,
        timeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0 && zellijSessionListContains(output, params.sessionName)) {
        return;
      }
      lastError = new Error(
        result.exitCode === 0
          ? `zellij session "${params.sessionName}" was not listed`
          : `zellij list-sessions failed: ${result.stderr || result.stdout}`,
      );
    } catch (error) {
      lastError = error;
    }

    const nextRemainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (nextRemainingMs !== undefined && nextRemainingMs <= 0) {
      continue;
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, nextRemainingMs ?? DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS));
  }
}

async function killZellijSessionOrThrow(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  const result = await params.actions.killSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  });
  if (result.exitCode === 0) return;

  const output = `${result.stderr}\n${result.stdout}`;
  if (isZellijMissingSessionOutput(output, params.sessionName)) return;

  throw new Error(`zellij kill-session failed: ${result.stderr || result.stdout}`);
}

async function disposeZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  const result = await params.actions.killSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  });
  if (result.exitCode === 0) return;

  const output = `${result.stderr}\n${result.stdout}`;
  if (isZellijMissingSessionOutput(output, params.sessionName)) return;

  throw new Error(`zellij kill-session failed: ${result.stderr || result.stdout}`);
}

function normalizeZellijStartupError(params: Readonly<{
  error: unknown;
  sessionName: string;
  actionTimeoutMs: number;
}>): unknown {
  if (isTerminalHostStartupError(params.error)) return params.error;
  if (!isZellijActionTimeoutError(params.error)) return params.error;
  return new TerminalHostStartupError({
    hostKind: 'zellij',
    reason: 'startup_action_timeout',
    message: `zellij startup action timed out: ${params.error.message}`,
    diagnostics: {
      action: params.error.action,
      sessionName: params.sessionName,
      timeoutMs: params.actionTimeoutMs,
    },
  });
}

async function cleanupZellijSessionAndRethrowStartupError(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
  error: unknown;
}>): Promise<never> {
  const startupError = normalizeZellijStartupError({
    error: params.error,
    sessionName: params.sessionName,
    actionTimeoutMs: params.actionTimeoutMs,
  });
  try {
    await killZellijSessionOrThrow({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      sessionName: params.sessionName,
      actionTimeoutMs: params.actionTimeoutMs,
    });
  } catch (cleanupError) {
    const startupMessage = startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (isTerminalHostStartupError(startupError)) {
      throw new TerminalHostStartupError({
        hostKind: startupError.hostKind,
        reason: startupError.reason,
        message: `zellij startup failed: ${startupMessage}; cleanup failed: ${cleanupMessage}`,
        diagnostics: {
          ...startupError.diagnostics,
          cleanupError: cleanupMessage,
        },
      });
    }
    throw new Error(`zellij startup failed: ${startupMessage}; cleanup failed: ${cleanupMessage}`);
  }
  throw startupError;
}

async function closePaneIfStillPresent(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  try {
    await params.actions.closePane({
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      timeoutMs: params.actionTimeoutMs,
    });
  } catch (error) {
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: params.actionTimeoutMs,
    }).catch(() => null);
    if (panes !== null && !panes.some((pane) => terminalPaneMatches(pane, params.paneId))) {
      return;
    }
    throw error;
  }
}

async function closeBootstrapTerminalPanes(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
  panesAfterLaunch: readonly ZellijPane[];
  actionTimeoutMs: number;
}>): Promise<Set<string>> {
  const activePaneId = params.paneId ? normalizePaneActionId(params.paneId) : null;
  const paneIdsToClose = new Set<string>();
  for (const pane of params.panesAfterLaunch) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId === null
      || paneId === activePaneId
      || isProvenReplacementCommandPane({
        pane,
        paneId,
        replacementPaneIds: params.replacementPaneIds,
        expectedCommandFragments: params.expectedCommandFragments,
      })
      || !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      continue;
    }
    paneIdsToClose.add(paneId);
  }
  for (const paneId of paneIdsToClose) {
    await closePaneIfStillPresent({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId,
      actionTimeoutMs: params.actionTimeoutMs,
    });
  }
  return paneIdsToClose;
}

function resolveBootstrapTerminalPaneIds(params: Readonly<{
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
  panes: readonly ZellijPane[];
}>): Set<string> {
  const activePaneId = normalizePaneActionId(params.paneId);
  const bootstrapPaneIds = new Set<string>();
  for (const pane of params.panes) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId !== null
      && paneId !== activePaneId
      && !isProvenReplacementCommandPane({
        pane,
        paneId,
        replacementPaneIds: params.replacementPaneIds,
        expectedCommandFragments: params.expectedCommandFragments,
      })
      && isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      bootstrapPaneIds.add(paneId);
    }
  }
  return bootstrapPaneIds;
}

async function closeBootstrapTerminalPanesUntilStable(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  initialPanes: readonly ZellijPane[];
  expectedCommandFragments: readonly string[];
  actionTimeoutMs: number;
}>): Promise<Readonly<{ panes: readonly ZellijPane[]; closedPaneIds: ReadonlySet<string> }>> {
  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  const closedPaneIds = new Set<string>();
  let panesAfterLaunch = params.initialPanes;

  function throwBootstrapCleanupDidNotConverge(): never {
    throw new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'bootstrap_cleanup_did_not_converge',
      message: 'zellij bootstrap pane cleanup did not converge',
      diagnostics: {
        paneId: params.paneId,
        closedPaneIds: [...closedPaneIds],
        actionTimeoutMs: params.actionTimeoutMs,
      },
    });
  }

  while (true) {
    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    const closedThisPass = await closeBootstrapTerminalPanes({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      replacementPaneIds: closedPaneIds,
      expectedCommandFragments: params.expectedCommandFragments,
      panesAfterLaunch,
      actionTimeoutMs: params.actionTimeoutMs,
    });
    for (const paneId of closedThisPass) closedPaneIds.add(paneId);
    const listTimeoutMs = remainingTerminalHostDeadlineMs(deadline);
    if (listTimeoutMs !== undefined && listTimeoutMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    panesAfterLaunch = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: listTimeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, listTimeoutMs),
    });
    const remainingBootstrapPaneIds = resolveBootstrapTerminalPaneIds({
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      replacementPaneIds: closedPaneIds,
      expectedCommandFragments: params.expectedCommandFragments,
      panes: panesAfterLaunch,
    });
    if (remainingBootstrapPaneIds.size === 0) return { panes: panesAfterLaunch, closedPaneIds };
    const waitMs = remainingTerminalHostDeadlineMs(deadline);
    if (waitMs !== undefined && waitMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, waitMs ?? DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS));
  }
}

async function waitForLaunchedTerminalPane(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  actionTimeoutMs: number;
}>): Promise<{ paneId: string; panes: readonly ZellijPane[] }> {
  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  while (true) {
    const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(params.env, params.sessionName),
      timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
    });
    const paneId = resolveLaunchedTerminalPaneId({
      paneIdFromRun: params.paneIdFromRun,
      panes,
      preExistingPaneIds: params.preExistingPaneIds,
    });
    if (paneId !== null) return { paneId, panes };

    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      throw createZellijStartupTimeoutError({
        action: 'pane_discovery',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: 'zellij launch produced no terminal target pane before startup deadline',
      });
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

async function waitForAddressableZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<readonly ZellijPane[]> {
  await waitForListedZellijSession(params);

  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  let lastError: unknown;
  while (true) {
    const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
    try {
      return await params.actions.listPanes({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(params.env, params.sessionName),
        timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
      });
    } catch (error) {
      lastError = error;
    }

    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
      throw createZellijStartupTimeoutError({
        action: 'session_addressability',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: `zellij session did not become addressable before startup deadline: ${message}`,
        lastError,
      });
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

export function createZellijTerminalHostAdapter(params: Readonly<{
  zellijBinary: string;
  happyHomeDir: string;
  defaultShell?: string | undefined;
  actions?: ZellijActions;
  launchStrategy?: ZellijLaunchStrategy;
  chunkSize?: number;
  inputStabilityDelayMs?: number;
  actionTimeoutMs?: number;
  prepareSocketDir?: ((socketDir: string) => Promise<void>) | undefined;
}>): TerminalHostAdapter {
  const actions = params.actions ?? defaultZellijActions;
  const prepareSocketDir = params.prepareSocketDir ?? prepareZellijSocketDir;
  const actionTimeoutMs = Math.max(1, Math.trunc(params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS));
  const env: Readonly<Record<string, string>> = {
    ZELLIJ_SOCKET_DIR: resolveZellijSocketDir(params.happyHomeDir),
  };

  type LivenessInspection = Readonly<{
    liveness: TerminalHostLiveness;
    targetPaneId?: string;
    paneDeadRecoverable?: boolean;
  }>;
  // R-E2: within-tick memo of the last inspection per pane, keyed by session + tracked pane id.
  const livenessInspectionCache = new Map<string, Readonly<{ atMs: number; value: LivenessInspection }>>();

  async function inspectLiveness(handle: TerminalHostHandle): Promise<LivenessInspection> {
    const cacheKey = `${handle.sessionName}\u0000${handle.paneId ?? ''}`;
    const cached = livenessInspectionCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && nowMs - cached.atMs <= LIVENESS_INSPECTION_FRESHNESS_MS) {
      return cached.value;
    }
    const value = await inspectLivenessUncached(handle);
    livenessInspectionCache.set(cacheKey, { atMs: Date.now(), value });
    return value;
  }

  async function inspectLivenessUncached(handle: TerminalHostHandle): Promise<LivenessInspection> {
    const observedAt = Date.now();
    const trackedPaneId = handle.paneId;
    if (!trackedPaneId) return { liveness: { paneAlive: false, paneDead: true, observedAt }, paneDeadRecoverable: true };
    let panes: ZellijPane[];
    try {
      panes = await actions.listPanes({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(env, handle.sessionName),
        timeoutMs: actionTimeoutMs,
      });
    } catch (error) {
      if (isInactiveZellijSessionError(error)) {
        return {
          liveness: {
            paneAlive: false,
            paneDead: true,
            paneScreenDumpError: summarizeDiagnosticError(error),
            observedAt,
          },
          paneDeadRecoverable: false,
        };
      }
      throw error;
    }
    const target = resolveRuntimePaneTarget({
      panes,
      paneId: trackedPaneId,
      expectedCommandFragments: readExpectedCommandFragments(handle),
    });
    const exactPane = panes.find((candidate) => terminalPaneMatches(candidate, trackedPaneId));
    const pane = target?.pane ?? exactPane;
    const paneAlive = Boolean(pane && isTerminalPaneAlive(pane));
    const paneExitStatus = resolvePaneExitStatus(pane);
    const liveness: {
      paneAlive: boolean;
      paneDead: boolean;
      paneCurrentCommand?: string;
      paneExitStatus?: number;
      paneScreenDumpCaptured?: boolean;
      paneScreenDumpTruncated?: boolean;
      paneScreenDumpError?: string;
      observedAt: number;
    } = {
      paneAlive,
      paneDead: !paneAlive,
      ...(pane?.terminal_command ? { paneCurrentCommand: sanitizeTerminalHostDiagnosticText(pane.terminal_command) } : {}),
      ...(paneExitStatus !== undefined ? { paneExitStatus } : {}),
      observedAt,
    };

    if (!paneAlive) {
      const diagnosticPaneId = pane ? (target?.paneId ?? resolveTerminalPaneActionId(pane)) : null;
      if (diagnosticPaneId) {
        try {
          const rawDump = await actions.dumpScreen({
            zellijBinary: params.zellijBinary,
            env: sessionEnv(env, handle.sessionName),
            paneId: diagnosticPaneId,
            timeoutMs: actionTimeoutMs,
          });
          const dump = truncateScreenDump(sanitizeTerminalHostDiagnosticText(rawDump));
          liveness.paneScreenDumpCaptured = true;
          liveness.paneScreenDumpTruncated = dump.truncated;
        } catch (error) {
          liveness.paneScreenDumpError = summarizeDiagnosticError(error);
        }
      }
    }

    return {
      liveness,
      ...(paneAlive && target ? { targetPaneId: target.paneId } : {}),
      ...(!paneAlive || !target ? { paneDeadRecoverable: paneDeadInjectionFailureIsRecoverable({ panes, target: target ?? null }) } : {}),
    };
  }

  async function evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLiveness> {
    return (await inspectLiveness(handle)).liveness;
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    if (!handle.paneId) return { stable: false, currentInput: '', observedAt: Date.now() };
    const inspection = await inspectLiveness(handle);
    if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
      throw new Error('zellij terminal pane is not alive');
    }
    const firstInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    await wait(Math.max(0, Math.trunc(params.inputStabilityDelayMs ?? DEFAULT_INPUT_STABILITY_DELAY_MS)));
    const currentInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    return { stable: firstInput === currentInput, currentInput, observedAt: Date.now() };
  }

  return {
    kind: 'zellij',
    async createOrAttachHost(opts) {
      await prepareSocketDir(env.ZELLIJ_SOCKET_DIR);
      const launchStrategy = params.launchStrategy ?? { type: 'background' };
      try {
        if (launchStrategy.type === 'background') {
          const result = await actions.attachCreateBackground({
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
            timeoutMs: actionTimeoutMs,
          });
          if (result.exitCode !== 0) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error: new Error(`zellij attach failed: ${result.stderr || result.stdout}`),
            });
          }
        } else {
          await launchStrategy.launchClient({
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
            timeoutMs: actionTimeoutMs,
          });
        }
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      let preExistingPaneIds: ReadonlySet<string>;
      try {
        preExistingPaneIds = new Set(
          (await waitForAddressableZellijSession({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            actionTimeoutMs,
          })).flatMap((pane) => {
            const paneId = resolveTerminalPaneActionId(pane);
            return paneId === null ? [] : [paneId];
          }),
        );
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      let paneId: string | null;
      const expectedCommandFragments = buildExpectedCommandFragments(opts.spawnArgv);
      try {
        let paneIdFromRun: string | null = null;
        let detachedCommandHandle: ZellijDetachedCommandHandle | null = null;
        if (launchStrategy.type === 'background') {
          let runResult: ZellijCommandResult;
          try {
            runResult = await actions.runCommand({
              zellijBinary: params.zellijBinary,
              env: {
                ...env,
                ...opts.spawnEnv,
              },
              sessionName: opts.sessionName,
              cwd: opts.workingDirectory,
              command: opts.spawnArgv,
              timeoutMs: actionTimeoutMs,
            });
          } catch (error) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error,
            });
          }
          if (runResult.exitCode !== 0) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error: new Error(`zellij run failed: ${runResult.stderr || runResult.stdout}`),
            });
          }
          paneIdFromRun = resolvePaneIdFromRunOutput(runResult.stdout);
        } else {
          if (!actions.startCommandDetached) {
            throw new Error('zellij detached command launcher is unavailable');
          }
          detachedCommandHandle = await actions.startCommandDetached({
            zellijBinary: params.zellijBinary,
            env: {
              ...env,
              ...opts.spawnEnv,
            },
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            command: opts.spawnArgv,
            timeoutMs: actionTimeoutMs,
          });
        }
        let launchedPane: { paneId: string; panes: readonly ZellijPane[] };
        try {
          launchedPane = await waitForLaunchedTerminalPane({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            paneIdFromRun,
            preExistingPaneIds,
            actionTimeoutMs,
          });
        } finally {
          detachedCommandHandle?.dispose();
        }
        paneId = launchedPane.paneId;
        const bootstrapCleanup = await closeBootstrapTerminalPanesUntilStable({
          actions,
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, opts.sessionName),
          paneId,
          preExistingPaneIds,
          initialPanes: launchedPane.panes,
          expectedCommandFragments,
          actionTimeoutMs,
        });
        const currentPaneId = resolvePostCleanupCommandPaneId({
          previousPaneId: paneId,
          panes: bootstrapCleanup.panes,
          replacementPaneIds: bootstrapCleanup.closedPaneIds,
          expectedCommandFragments,
        });
        if (currentPaneId === null) {
          throw new TerminalHostStartupError({
            hostKind: 'zellij',
            reason: 'pane_disappeared_after_bootstrap_cleanup',
            message: 'zellij launched terminal pane disappeared after bootstrap cleanup',
            diagnostics: {
              previousPaneId: paneId,
              closedPaneIds: [...bootstrapCleanup.closedPaneIds],
              expectedCommandFragments,
            },
          });
        }
        paneId = currentPaneId;
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      return {
        kind: 'zellij',
        sessionName: opts.sessionName,
        ...(paneId ? { paneId } : {}),
        socketDir: env.ZELLIJ_SOCKET_DIR,
        expectedCommandFragments,
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      };
    },
    async injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult> {
      const deferral = scheduledDeferral(input);
      if (deferral) return deferral;

      if (!handle.paneId) {
        return failedInjectionResult({
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }
      let paneId: string;
      let liveness: TerminalHostLiveness;
      let trustedTargetPaneId: string | undefined;
      let paneDeadRecoverable = false;
      try {
        const inspection = await inspectLiveness(handle);
        liveness = inspection.liveness;
        trustedTargetPaneId = inspection.targetPaneId;
        paneDeadRecoverable = inspection.paneDeadRecoverable === true;
        if (trustedTargetPaneId) {
          paneId = trustedTargetPaneId;
        } else {
          paneId = handle.paneId;
        }
      } catch {
        return paneInitializingDeferral(input);
      }
      if (!liveness.paneAlive || !trustedTargetPaneId) {
        if (paneDeadRecoverable) {
          return paneInitializingDeferral(input);
        }
        return failedInjectionResult({
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: paneDeadRecoverable,
        });
      }

      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        let inputState: TerminalInputState;
        try {
          inputState = await captureInputState(handle);
        } catch {
          return failedInjectionResult({
            reason: 'host_unreachable',
            phase: 'readiness',
            duplicateRisk: 'none',
            recoverable: true,
          });
        }
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: 'user_typing',
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
          };
        }
      }

      const injectionTimeoutMs = input.scheduling.timeoutMs ?? actionTimeoutMs;
      const deadline = createTerminalHostDeadline(injectionTimeoutMs);
      const textToWrite = input.text;
      let failurePhase: TerminalInjectionFailurePhase = 'during_write';
      let duplicateRisk: TerminalInjectionDuplicateRisk = 'possible';
      try {
        await actions.writeBytesChunked({
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, handle.sessionName),
          paneId,
          text: textToWrite,
          chunkSize: params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
          timeoutMs: injectionTimeoutMs,
        });
        failurePhase = 'after_write_before_enter';
        const submitTimeoutMs = resolvePromptSubmitTimeoutMs({
          remainingTimeoutMs: remainingTerminalHostDeadlineMs(deadline),
          fallbackTimeoutMs: actionTimeoutMs,
        });
        failurePhase = 'after_enter_unknown';
        duplicateRisk = 'likely';
        await actions.sendEnter({
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, handle.sessionName),
          paneId,
          ...(submitTimeoutMs !== undefined ? { timeoutMs: submitTimeoutMs } : {}),
        });
        return { status: 'injected', at: Date.now(), bytesWritten: Buffer.byteLength(textToWrite) };
      } catch (error) {
        return failedInjectionResult({
          reason: isZellijActionTimeoutError(error) ? 'timeout' : 'host_unreachable',
          phase: failurePhase,
          duplicateRisk,
          recoverable: true,
        });
      }
    },
    async interruptTurn(handle: TerminalHostHandle): Promise<void> {
      if (!handle.paneId) {
        throw new Error('Cannot interrupt zellij terminal host without a pane id');
      }
      const inspection = await inspectLiveness(handle);
      if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
        throw new Error('Cannot interrupt zellij terminal host because the pane is not alive');
      }
      await actions.sendEscape({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(env, handle.sessionName),
        paneId: inspection.targetPaneId,
        timeoutMs: actionTimeoutMs,
      });
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle: TerminalHostHandle) {
      if (!handle.paneId || handle.paneId.trim().length === 0) return null;
      return createZellijTerminalControlPort({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: handle.sessionName,
        paneId: handle.paneId,
        resolvePaneId: async () => {
          const inspection = await inspectLiveness(handle);
          if (!inspection.liveness.paneAlive || !inspection.targetPaneId) return null;
          return inspection.targetPaneId;
        },
        ...(params.chunkSize !== undefined ? { chunkSize: params.chunkSize } : {}),
        timeoutMs: actionTimeoutMs,
      });
    },
    async dispose(handle: TerminalHostHandle): Promise<void> {
      await disposeZellijSession({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: handle.sessionName,
        actionTimeoutMs,
      });
    },
  };
}
