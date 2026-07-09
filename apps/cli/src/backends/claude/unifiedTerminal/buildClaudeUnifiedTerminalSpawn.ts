import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandInvocation } from '@happier-dev/cli-common/process';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { HAPPIER_BASE_SYSTEM_PROMPT_V1 } from '@happier-dev/protocol';

import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '../utils/permissionMode';
import { getClaudeSystemPrompt } from '../utils/systemPrompt';
import { isClaudeCliJavaScriptFile, resolveClaudeCliPath } from '../utils/resolveClaudeCliPath';
import { ensureClaudeJsRuntimeExecutable } from '../utils/ensureClaudeJsRuntimeExecutable';
import { buildClaudeSubprocessEnv } from '../spawn/buildClaudeSubprocessEnv';
import {
  buildClaudeStatuslineOverlaySettings,
  resolveClaudeStatuslineOriginalCommand,
  type ClaudeStatuslineOverlaySettings,
} from '../statusline/buildClaudeStatuslineOverlay';
import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';
import {
  readConnectedServiceMaterializedEnvKeysFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { EnhancedMode } from '../loop';
import {
  resolveClaudeTerminalCliOptions,
  type ClaudeTerminalCliOptionsDiagnostic,
} from '../cli/terminalOptions';
import { claudeCliFlagCanConsumeValue } from '../cli/flagArity';

export type ClaudeUnifiedTerminalSpawn = Readonly<{
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  launchSpecPath?: string | undefined;
}>;

export class ClaudeUnifiedTerminalUnsupportedOptionError extends Error {
  readonly code = 'claude_unified_terminal_unsupported_option';
  readonly diagnostics: readonly ClaudeTerminalCliOptionsDiagnostic[];

  constructor(diagnostics: readonly ClaudeTerminalCliOptionsDiagnostic[]) {
    super('Claude unified terminal options include values that cannot be mapped safely to the terminal runtime.');
    this.name = 'ClaudeUnifiedTerminalUnsupportedOptionError';
    this.diagnostics = diagnostics;
  }
}

type ClaudeUnifiedTerminalManagedSettingsDiagnostic = Readonly<{
  code: 'managed_settings_option';
  option: '--settings';
}>;

export class ClaudeUnifiedTerminalManagedSettingsOptionError extends Error {
  readonly code = 'claude_unified_terminal_managed_settings_option';
  readonly diagnostics: readonly ClaudeUnifiedTerminalManagedSettingsDiagnostic[];

  constructor(diagnostics: readonly ClaudeUnifiedTerminalManagedSettingsDiagnostic[]) {
    super('Claude unified terminal owns --settings so managed hooks, statusline, and ultracode cannot be shadowed.');
    this.name = 'ClaudeUnifiedTerminalManagedSettingsOptionError';
    this.diagnostics = diagnostics;
  }
}

export class ClaudeUnifiedTerminalRootBypassRequiresSandboxError extends Error {
  readonly code = 'claude_unified_terminal_root_bypass_requires_sandbox';
  readonly permissionMode: string;

  constructor(permissionMode: string) {
    super('Claude Code bypass permissions cannot be used as root unless IS_SANDBOX=1 is present in the Claude environment.');
    this.name = 'ClaudeUnifiedTerminalRootBypassRequiresSandboxError';
    this.permissionMode = permissionMode;
  }
}

export function isClaudeUnifiedTerminalManagedSettingsOptionError(
  error: unknown,
): error is ClaudeUnifiedTerminalManagedSettingsOptionError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_managed_settings_option';
}

export function isClaudeUnifiedTerminalRootBypassRequiresSandboxError(
  error: unknown,
): error is ClaudeUnifiedTerminalRootBypassRequiresSandboxError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_root_bypass_requires_sandbox';
}

function chmodPrivateFileIfSupported(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort hardening; write mode still applies on first creation.
  }
}

type ClaudeUnifiedTerminalSpawnDeps = Readonly<{
  resolveClaudeCliPath: (env?: NodeJS.ProcessEnv) => string;
  isClaudeCliJavaScriptFile: (path: string) => boolean;
  ensureClaudeJsRuntimeExecutable: () => Promise<string | null>;
  claudeLocalLauncherPath: string;
  terminalLaunchSpecRunnerPath: string;
  statuslineForwarderScriptPath: string;
  /** Same node-binary resolution as the hook artifacts (`generateHookSettings`). */
  resolveStatuslineNodeExecutable: () => string | null;
  resolveCommandInvocation: (params: Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>) => CommandInvocation;
  isRootUser: () => boolean;
}>;

type ClaudeUnifiedTerminalSpawnInput<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  path: string;
  first: Readonly<{ message: string; mode: Mode }>;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  envOverlay?: Readonly<Record<string, string>> | undefined;
  systemPromptText?: string | null | undefined;
  /**
   * Session hook-server coordinates for the statusline forwarder wrapper. When present, a
   * `statusLine` command pointing at `statusline_forwarder.cjs` is merged into the single
   * `--settings` overlay (the user's original statusline command is exec-chained by the wrapper).
   */
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  deps?: Partial<ClaudeUnifiedTerminalSpawnDeps> | undefined;
}>;

function resolveFallbackSystemPrompt(): string {
  const providerBlocks = getClaudeSystemPrompt();
  return providerBlocks.trim().length > 0
    ? `${HAPPIER_BASE_SYSTEM_PROMPT_V1}\n\n${providerBlocks}`
    : HAPPIER_BASE_SYSTEM_PROMPT_V1;
}

const managedClaudeArgFlagsWithValue = new Set([
  '--model',
  '--effort',
  '--fallback-model',
  '--system-prompt',
  '--append-system-prompt',
  '--settings',
]);

const managedClaudeArgFlagsWithoutValue = new Set([
  '--strict-mcp-config',
  '--allow-dangerously-skip-permissions',
]);

function appendClaudeArgsWithoutManagedPromptAndSpawnMode(
  target: string[],
  claudeArgs: readonly string[] | undefined,
): void {
  const input = claudeArgs ?? [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (typeof arg !== 'string') continue;
    if (arg === '--dangerously-skip-permissions') continue;
    if (arg === '--print' || arg === '-p') {
      const next = index + 1 < input.length ? input[index + 1] : undefined;
      if (typeof next === 'string' && !next.startsWith('-')) index += 1;
      continue;
    }
    if (arg.startsWith('--print=') || arg.startsWith('-p=')) continue;
    if (arg === '--permission-mode') {
      if (index + 1 < input.length) index += 1;
      continue;
    }
    if (arg.startsWith('--permission-mode=')) continue;
    if (managedClaudeArgFlagsWithoutValue.has(arg)) continue;
    if ([...managedClaudeArgFlagsWithValue].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (managedClaudeArgFlagsWithValue.has(arg)) {
      if (index + 1 < input.length) index += 1;
      continue;
    }
    if (!arg.startsWith('-')) continue;
    target.push(arg);
    if (claudeCliFlagCanConsumeValue(arg) && index + 1 < input.length) {
      const value = input[index + 1];
      if (typeof value === 'string') {
        target.push(value);
        index += 1;
      }
    }
  }
}

function assertNoUserSettingsArg(claudeArgs: readonly string[] | undefined): void {
  for (const arg of claudeArgs ?? []) {
    if (arg === '--settings' || arg.startsWith('--settings=')) {
      throw new ClaudeUnifiedTerminalManagedSettingsOptionError([
        { code: 'managed_settings_option', option: '--settings' },
      ]);
    }
  }
}

/**
 * Resolve the single `--settings` overlay value for the spawned Claude CLI.
 *
 * Claude Code keeps only the FIRST `--settings` overlay, so ultracode and the statusline
 * forwarder cannot ride a second flag next to the hook settings file: when either is needed,
 * the hook settings content is merged with `{"ultracode":true}` / `{"statusLine":{...}}` and
 * passed as one inline JSON overlay (`--settings` accepts a file path or a JSON string).
 * Otherwise the file path is passed through untouched.
 *
 * Merged overlays are written to a 0600 SIBLING FILE of the hook settings file and passed as a
 * path. The statusline forwarder secret rides in a separate 0600 sibling file; the command string
 * contains only that path, never the secret itself. If the sibling cannot be written, the
 * statusline overlay is dropped fail-open and the secret-free remainder is passed inline.
 */
function resolveSettingsOverlayArg(params: Readonly<{
  hookSettingsPath: string | undefined;
  ultracodeEnabled: boolean;
  statuslineSettings: ClaudeStatuslineOverlaySettings | undefined;
}>): string | undefined {
  if (!params.ultracodeEnabled && !params.statuslineSettings) return params.hookSettingsPath;

  let base: Record<string, unknown> = {};
  if (params.hookSettingsPath) {
    try {
      const parsed = JSON.parse(readFileSync(params.hookSettingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable hook settings: fall through to the merged-only overlay — passing the
      // broken file path would lose the merged keys AND the hook settings alike.
    }
  }
  const merged = {
    ...base,
    ...(params.ultracodeEnabled ? { ultracode: true } : {}),
    ...(params.statuslineSettings ? { statusLine: params.statuslineSettings } : {}),
  };
  if (params.hookSettingsPath) {
    const overlayPath = params.hookSettingsPath.replace(/\.json$/, '.overlay.json');
    try {
      writeFileSync(overlayPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      chmodPrivateFileIfSupported(overlayPath);
      return overlayPath;
    } catch {
      // Cannot write the 0600 sibling: never put the secret-bearing statusline command into
      // argv — drop it (the user's own statusline stays in charge) and inline the remainder.
      const { statusLine: _dropped, ...withoutStatusline } = merged;
      return JSON.stringify(withoutStatusline);
    }
  }
  // No hook settings file (hooks disabled) also means no hook server, hence no statusline
  // forwarder/secret — the remaining ultracode-only overlay is safe inline.
  return JSON.stringify(merged);
}

function writePrivateStatuslineSecretFile(params: Readonly<{
  hookSettingsPath: string;
  secret: string;
}>): string | null {
  const secretPath = params.hookSettingsPath.replace(/\.json$/, '.statusline-secret');
  if (secretPath === params.hookSettingsPath) return null;
  try {
    writeFileSync(secretPath, params.secret, { mode: 0o600 });
    chmodPrivateFileIfSupported(secretPath);
    return secretPath;
  } catch {
    return null;
  }
}

/**
 * Build the statusline forwarder `statusLine` overlay value, or undefined when forwarding is
 * not requested or cannot be honored. STRICTLY fail-open: any miss (no wrapper runtime, missing
 * script asset) leaves the user's own statusline configuration in charge.
 */
function resolveStatuslineOverlaySettings<Mode extends EnhancedMode>(params: Readonly<{
  input: ClaudeUnifiedTerminalSpawnInput<Mode>;
  deps: ClaudeUnifiedTerminalSpawnDeps;
  env: Readonly<Record<string, string>>;
}>): ClaudeStatuslineOverlaySettings | undefined {
  const forwarder = params.input.statuslineForwarder;
  if (!forwarder) return undefined;
  const scriptPath = params.deps.statuslineForwarderScriptPath;
  if (
    !existsSync(scriptPath)
    && !isEmbeddedBunBundlePath(scriptPath)
    && !params.input.deps?.statuslineForwarderScriptPath
  ) {
    return undefined;
  }
  const nodeExecutable = params.deps.resolveStatuslineNodeExecutable();
  if (!nodeExecutable) return undefined;
  const hookSettingsPath = params.input.hookSettingsPath;
  if (!hookSettingsPath) return undefined;
  const secretFilePath = writePrivateStatuslineSecretFile({
    hookSettingsPath,
    secret: forwarder.secret,
  });
  if (!secretFilePath) return undefined;
  return buildClaudeStatuslineOverlaySettings({
    nodeExecutable,
    forwarderScriptPath: scriptPath,
    port: forwarder.port,
    secretFilePath,
    original: resolveClaudeStatuslineOriginalCommand({ env: { ...params.env } }),
  });
}

function buildClaudeArgs<Mode extends EnhancedMode>(
  input: ClaudeUnifiedTerminalSpawnInput<Mode>,
  statuslineSettings: ClaudeStatuslineOverlaySettings | undefined,
  runtime: Readonly<{
    env: Readonly<Record<string, string>>;
    isRootUser: boolean;
  }>,
): string[] {
  const args: string[] = [];
  const terminalOptions = resolveClaudeTerminalCliOptions({
    mode: input.first.mode,
    claudeArgs: input.claudeArgs,
  });
  if (terminalOptions.diagnostics.length > 0) {
    throw new ClaudeUnifiedTerminalUnsupportedOptionError(terminalOptions.diagnostics);
  }
  const systemPromptText = typeof input.systemPromptText === 'string' ? input.systemPromptText.trim() : '';
  const appendSystemPrompt = terminalOptions.appendSystemPrompt.trim();
  if (terminalOptions.customSystemPrompt.trim()) {
    args.push('--system-prompt', terminalOptions.customSystemPrompt.trim());
  }
  args.push(
    '--append-system-prompt',
    [systemPromptText || resolveFallbackSystemPrompt(), appendSystemPrompt].filter(Boolean).join('\n\n'),
  );
  appendClaudeArgsWithoutManagedPromptAndSpawnMode(args, input.claudeArgs);
  args.push(...terminalOptions.extraArgs);

  if (input.hookPluginDir) {
    args.push('--plugin-dir', input.hookPluginDir);
  }
  const settingsOverlay = resolveSettingsOverlayArg({
    hookSettingsPath: input.hookSettingsPath,
    ultracodeEnabled: terminalOptions.ultracodeEnabled,
    statuslineSettings,
  });
  if (settingsOverlay) {
    args.push('--settings', settingsOverlay);
  }
  if (typeof input.happierMcpConfigJson === 'string' && input.happierMcpConfigJson.trim().length > 0) {
    args.push('--mcp-config', input.happierMcpConfigJson.trim());
  }

  const permissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(input.first.mode);
  const sandboxEnabled = runtime.env.IS_SANDBOX === '1';
  const canUseDangerousPermissionBypass = !runtime.isRootUser || sandboxEnabled;
  if (canUseDangerousPermissionBypass) {
    args.push('--allow-dangerously-skip-permissions');
  }
  if (permissionMode === 'bypassPermissions' && !canUseDangerousPermissionBypass) {
    throw new ClaudeUnifiedTerminalRootBypassRequiresSandboxError(permissionMode);
  }
  if (permissionMode !== 'default') {
    args.push('--permission-mode', permissionMode);
  }
  return args;
}

function readMaterializedEnvKeySet(env: Pick<NodeJS.ProcessEnv, string>): Set<string> {
  return new Set(readConnectedServiceMaterializedEnvKeysFromEnv(env));
}

function buildClaudeEnv(envOverlay: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env = stripNestedSessionDetectionEnv(buildClaudeSubprocessEnv({
    envOverlay: {
      DISABLE_AUTOUPDATER: '1',
      IS_DEMO: '1',
      ...(envOverlay ?? {}),
    },
  }));
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function buildTerminalLauncherProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowExact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'FORCE_COLOR',
    'NO_COLOR',
    'COLORTERM',
    '__CF_USER_TEXT_ENCODING',
  ]);
  if (process.platform === 'win32') {
    for (const key of ['USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
      allowExact.add(key);
    }
  }

  const allowPrefixes = ['LC_', 'TERM_', 'XDG_', 'HAPPIER_E2E_', 'HAPPY_E2E_'];
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    if (isAllowedExactEnvKey(key, allowExact) || allowPrefixes.some((prefix) => key.startsWith(prefix))) {
      out[key] = value;
    }
  }
  return out;
}

type TerminalLaunchSpec = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  envPassthroughKeys?: readonly string[] | undefined;
}>;

type SplitTerminalLaunchEnv = Readonly<{
  persistedEnv: Record<string, string>;
  passthroughEnv: Record<string, string>;
  passthroughKeys: string[];
}>;

const terminalLaunchSpecSecretEnvKeyPattern =
  /(?:^ANTHROPIC_|^CLAUDE_CODE_|(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTHORIZATION|BEARER|CREDENTIAL)(?:_|$))/i;

function splitTerminalLaunchSpecEnv(env: Readonly<Record<string, string>>): SplitTerminalLaunchEnv {
  const persistedEnv: Record<string, string> = Object.create(null);
  const passthroughEnv: Record<string, string> = Object.create(null);
  const passthroughKeys: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (terminalLaunchSpecSecretEnvKeyPattern.test(key)) {
      passthroughEnv[key] = value;
      passthroughKeys.push(key);
      continue;
    }
    persistedEnv[key] = value;
  }

  return { persistedEnv, passthroughEnv, passthroughKeys };
}

async function writeTerminalLaunchSpec(spec: TerminalLaunchSpec): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
  const path = join(dir, 'launch.json');
  await writeFile(path, JSON.stringify(spec), { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
  return path;
}

function defaultDeps(inputDeps: Partial<ClaudeUnifiedTerminalSpawnDeps> | undefined): ClaudeUnifiedTerminalSpawnDeps {
  return {
    resolveClaudeCliPath: inputDeps?.resolveClaudeCliPath ?? ((env) => resolveClaudeCliPath({ processEnv: env })),
    isClaudeCliJavaScriptFile: inputDeps?.isClaudeCliJavaScriptFile ?? isClaudeCliJavaScriptFile,
    ensureClaudeJsRuntimeExecutable:
      inputDeps?.ensureClaudeJsRuntimeExecutable
      ?? (async () => (await ensureClaudeJsRuntimeExecutable()) ?? null),
    claudeLocalLauncherPath:
      inputDeps?.claudeLocalLauncherPath ?? resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs'),
    terminalLaunchSpecRunnerPath:
      inputDeps?.terminalLaunchSpecRunnerPath ?? resolveCliRuntimeAssetPath('scripts', 'terminal_launch_spec_runner.cjs'),
    statuslineForwarderScriptPath:
      inputDeps?.statuslineForwarderScriptPath ?? resolveCliRuntimeAssetPath('scripts', 'statusline_forwarder.cjs'),
    resolveStatuslineNodeExecutable:
      inputDeps?.resolveStatuslineNodeExecutable
      ?? (() => resolveJavaScriptRuntimeExecutable({ isBunRuntime: isBun() })),
    resolveCommandInvocation:
      inputDeps?.resolveCommandInvocation
      ?? ((params) => resolveWindowsCommandInvocation({
        command: params.command,
        args: [...params.args],
        env: params.env,
      })),
    isRootUser:
      inputDeps?.isRootUser
      ?? (() => typeof process.getuid === 'function' && process.getuid() === 0),
  };
}

export async function buildClaudeUnifiedTerminalSpawn<Mode extends EnhancedMode = EnhancedMode>(
  input: ClaudeUnifiedTerminalSpawnInput<Mode>,
): Promise<ClaudeUnifiedTerminalSpawn> {
  assertNoUserSettingsArg(input.claudeArgs);
  const deps = defaultDeps(input.deps);
  // Env first: the statusline overlay resolves the user's original statusline command from the
  // EFFECTIVE config root of the spawned process (CLAUDE_CONFIG_DIR / HOME in the child env).
  const env = buildClaudeEnv(input.envOverlay);
  const resolvedClaudeCliPath = deps.resolveClaudeCliPath(env);
  const statuslineSettings = resolveStatuslineOverlaySettings({ input, deps, env });
  const args = buildClaudeArgs(input, statuslineSettings, { env, isRootUser: deps.isRootUser() });

  const nodeExecutable = await deps.ensureClaudeJsRuntimeExecutable();
  if (!nodeExecutable) {
    throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Claude unified terminal launcher'));
  }
  if (
    !existsSync(deps.terminalLaunchSpecRunnerPath)
    && !isEmbeddedBunBundlePath(deps.terminalLaunchSpecRunnerPath)
    && !input.deps?.terminalLaunchSpecRunnerPath
  ) {
    throw new Error('Claude unified terminal launch-spec runner not found. Please ensure HAPPIER_PROJECT_ROOT is set correctly for development.');
  }

  let childCommand: string;
  let childArgs: readonly string[];
  if (deps.isClaudeCliJavaScriptFile(resolvedClaudeCliPath)) {
    if (
      !existsSync(deps.claudeLocalLauncherPath)
      && !isEmbeddedBunBundlePath(deps.claudeLocalLauncherPath)
      && !input.deps?.claudeLocalLauncherPath
    ) {
      throw new Error('Claude local launcher not found. Please ensure HAPPIER_PROJECT_ROOT is set correctly for development.');
    }
    if (!env.HAPPIER_CLAUDE_PATH && !env.HAPPY_CLAUDE_PATH) {
      env.HAPPIER_CLAUDE_PATH = resolvedClaudeCliPath;
    }
    childCommand = nodeExecutable;
    childArgs = [deps.claudeLocalLauncherPath, ...args];
  } else {
    const invocation = deps.resolveCommandInvocation({
      command: resolvedClaudeCliPath,
      args,
      env,
    });
    childCommand = invocation.command;
    childArgs = invocation.args;
  }

  const splitEnv = splitTerminalLaunchSpecEnv(env);
  const specPath = await writeTerminalLaunchSpec({
    command: childCommand,
    args: childArgs,
    cwd: input.path,
    env: splitEnv.persistedEnv,
    ...(splitEnv.passthroughKeys.length > 0 ? { envPassthroughKeys: splitEnv.passthroughKeys } : {}),
  });

  return {
    spawnArgv: [nodeExecutable, deps.terminalLaunchSpecRunnerPath, specPath],
    spawnEnv: {
      ...buildTerminalLauncherProcessEnv(),
      ...splitEnv.passthroughEnv,
    },
    launchSpecPath: specPath,
  };
}
