import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isClaudeCliJavaScriptFile,
  resolveClaudeCliPath,
} from '../../utils/resolveClaudeCliPath';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';

import {
  verifyClaudeCodeNativeAuth,
  type ClaudeCodeNativeAuthVerificationResult,
} from './verifyClaudeCodeNativeAuth';

const execFileAsync = promisify(execFileCallback);
const DEFAULT_CLAUDE_NATIVE_AUTH_STATUS_TIMEOUT_MS = 5_000;

export type ClaudeCodeNativeAuthStatusVerificationResult =
  | ClaudeCodeNativeAuthVerificationResult
  | Readonly<{
      status:
        | 'native_cli_logged_out'
        | 'native_cli_status_unavailable'
        | 'native_cli_status_timeout'
        | 'native_cli_status_malformed';
      missingScopes: readonly string[];
      credentialPath: string;
      stdoutPreview?: string;
      stderrPreview?: string;
    }>;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: Readonly<{
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
  }>,
) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

function truncatePreview(value: unknown): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  const normalized = text.trim();
  if (!normalized) return undefined;
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseClaudeAuthStatusLoggedIn(stdout: string, stderr: string): boolean | null {
  const text = `${stdout}\n${stderr}`.trim();
  const candidates = [stdout.trim(), stderr.trim(), text].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
      const loggedIn = readBoolean(record?.loggedIn);
      if (loggedIn !== null) return loggedIn;
    } catch {
      // Fall through to text evidence below.
    }
  }

  const lowered = text.toLowerCase();
  if (
    /\bnot logged in\b/u.test(lowered)
    || /\bplease run \/login\b/u.test(lowered)
    || /"loggedin"\s*:\s*false/u.test(lowered)
  ) {
    return false;
  }
  if (/\blogged in\b/u.test(lowered) || /"loggedin"\s*:\s*true/u.test(lowered)) {
    return true;
  }
  return null;
}

function resolveClaudeAuthStatusInvocation(params: Readonly<{
  env: NodeJS.ProcessEnv;
  resolveCliPath: (env: NodeJS.ProcessEnv) => string;
  resolveRuntimeExecutable: () => string | null;
}>): Readonly<{ command: string; args: readonly string[] }> | null {
  const cliPath = params.resolveCliPath(params.env);
  if (!isClaudeCliJavaScriptFile(cliPath)) {
    return { command: cliPath, args: ['auth', 'status'] };
  }
  const runtimeExecutable = params.resolveRuntimeExecutable();
  if (!runtimeExecutable) return null;
  return { command: runtimeExecutable, args: [cliPath, 'auth', 'status'] };
}

function isTimeoutError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  return record?.killed === true
    || record?.signal === 'SIGTERM'
    || record?.code === 'ETIMEDOUT';
}

export async function verifyClaudeCodeNativeAuthStatus(params: Readonly<{
  claudeConfigDir: string;
  now?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<Readonly<{
    verifyStructuralAuth: typeof verifyClaudeCodeNativeAuth;
    execFile: ExecFileLike;
    resolveClaudeCliPath: (env: NodeJS.ProcessEnv) => string;
    resolveRuntimeExecutable: () => string | null;
  }>>;
}>): Promise<ClaudeCodeNativeAuthStatusVerificationResult> {
  const verifyStructuralAuth = params.deps?.verifyStructuralAuth ?? verifyClaudeCodeNativeAuth;
  const structural = await verifyStructuralAuth({
    claudeConfigDir: params.claudeConfigDir,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  if (structural.status !== 'ok') return structural;

  let invocation: Readonly<{ command: string; args: readonly string[] }> | null;
  try {
    invocation = resolveClaudeAuthStatusInvocation({
      env: params.env ?? process.env,
      resolveCliPath: params.deps?.resolveClaudeCliPath ?? ((env) => resolveClaudeCliPath({ processEnv: env })),
      resolveRuntimeExecutable: params.deps?.resolveRuntimeExecutable ?? (() =>
        resolveJavaScriptRuntimeExecutable({
          isBunRuntime: isBun(),
          processEnv: params.env ?? process.env,
          currentExecPath: process.execPath,
        })),
    });
  } catch (error) {
    return {
      status: 'native_cli_status_unavailable',
      missingScopes: [],
      credentialPath: structural.credentialPath,
      ...(truncatePreview(error instanceof Error ? error.message : String(error)) ? {
        stderrPreview: truncatePreview(error instanceof Error ? error.message : String(error)),
      } : {}),
    };
  }
  if (!invocation) {
    return {
      status: 'native_cli_status_unavailable',
      missingScopes: [],
      credentialPath: structural.credentialPath,
    };
  }

  const execFile = params.deps?.execFile ?? execFileAsync;
  const env = {
    ...(params.env ?? process.env),
    CLAUDE_CONFIG_DIR: params.claudeConfigDir,
  };
  const timeout = Math.max(1_000, Math.trunc(params.timeoutMs ?? DEFAULT_CLAUDE_NATIVE_AUTH_STATUS_TIMEOUT_MS));

  try {
    const { stdout, stderr } = await execFile(invocation.command, invocation.args, {
      env,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '');
    const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
    const loggedIn = parseClaudeAuthStatusLoggedIn(stdoutText, stderrText);
    if (loggedIn === true) return structural;
    if (loggedIn === false) {
      return {
        status: 'native_cli_logged_out',
        missingScopes: [],
        credentialPath: structural.credentialPath,
        ...(truncatePreview(stdoutText) ? { stdoutPreview: truncatePreview(stdoutText) } : {}),
        ...(truncatePreview(stderrText) ? { stderrPreview: truncatePreview(stderrText) } : {}),
      };
    }
    return {
      status: 'native_cli_status_malformed',
      missingScopes: [],
      credentialPath: structural.credentialPath,
      ...(truncatePreview(stdoutText) ? { stdoutPreview: truncatePreview(stdoutText) } : {}),
      ...(truncatePreview(stderrText) ? { stderrPreview: truncatePreview(stderrText) } : {}),
    };
  } catch (error) {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
    const stdoutText = Buffer.isBuffer(record?.stdout)
      ? record.stdout.toString('utf8')
      : String(record?.stdout ?? '');
    const stderrText = Buffer.isBuffer(record?.stderr)
      ? record.stderr.toString('utf8')
      : String(record?.stderr ?? '');
    const loggedIn = parseClaudeAuthStatusLoggedIn(stdoutText, stderrText);
    if (loggedIn === true) return structural;
    return {
      status: loggedIn === false
        ? 'native_cli_logged_out'
        : isTimeoutError(error)
          ? 'native_cli_status_timeout'
          : 'native_cli_status_unavailable',
      missingScopes: [],
      credentialPath: structural.credentialPath,
      ...(truncatePreview(stdoutText) ? { stdoutPreview: truncatePreview(stdoutText) } : {}),
      ...(truncatePreview(stderrText) ? { stderrPreview: truncatePreview(stderrText) } : {}),
    };
  }
}
