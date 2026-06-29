import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import {
  readClaudeRootConfigFile,
  sanitizeClaudeOauthAccountProjection,
} from './claudeRootConfig';

type JsonObject = Record<string, unknown>;

type ClaudeWorkspaceTrustProjection = Readonly<{
  hasTrustDialogAccepted: true;
  hasCompletedProjectOnboarding?: true;
}>;

type ClaudeOauthAccountProjection = Record<string, unknown>;

type ClaudeRootConfigPathCandidate = Readonly<{
  rootDir: string;
  path: string;
}>;

function readObject(value: unknown): JsonObject | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function dedupeRootConfigPathCandidates(
  candidates: readonly ClaudeRootConfigPathCandidate[],
): ClaudeRootConfigPathCandidate[] {
  const seen = new Set<string>();
  const result: ClaudeRootConfigPathCandidate[] = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function resolveClaudeRootConfigPathCandidates(env: NodeJS.ProcessEnv): ClaudeRootConfigPathCandidate[] {
  const explicitConfigDir = resolveClaudeConfigDirOverride(env);
  const homeDir = resolveHomeDirFromEnvironment(env);
  const configuredConfigDir = resolveConfiguredClaudeConfigDir({ env });
  return dedupeRootConfigPathCandidates([
    ...(explicitConfigDir ? [{
      rootDir: explicitConfigDir,
      path: join(explicitConfigDir, '.claude.json'),
    }] : []),
    {
      rootDir: homeDir,
      path: join(homeDir, '.claude.json'),
    },
    {
      rootDir: configuredConfigDir,
      path: join(configuredConfigDir, '.claude.json'),
    },
  ]);
}

function readProjectTrustProjection(
  rootConfig: JsonObject,
  sessionDirectory: string,
): { hasExplicitTrustState: boolean; projection: ClaudeWorkspaceTrustProjection | null } {
  const projectConfig = readObject(readObject(rootConfig.projects)?.[sessionDirectory]);
  if (!projectConfig || typeof projectConfig.hasTrustDialogAccepted !== 'boolean') {
    return { hasExplicitTrustState: false, projection: null };
  }
  if (projectConfig.hasTrustDialogAccepted !== true) {
    return { hasExplicitTrustState: false, projection: null };
  }
  return {
    hasExplicitTrustState: true,
    projection: {
      hasTrustDialogAccepted: true,
      ...(projectConfig.hasCompletedProjectOnboarding === true ? { hasCompletedProjectOnboarding: true } : {}),
    },
  };
}

async function resolveWorkspaceTrustProjection(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  sessionDirectory: string;
  targetDir: string;
}>): Promise<ClaudeWorkspaceTrustProjection | null> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (let index = 0; index < candidates.length; index += 1) {
    const rootConfig = await readClaudeRootConfigFile(candidates[index].path);
    if (!rootConfig) continue;
    const result = readProjectTrustProjection(rootConfig, params.sessionDirectory);
    if (result.projection) return result.projection;
  }
  // QAC-1: no source config carries any trust state for this directory (typical for new
  // directories, worktrees, and scratch workspaces never opened with native claude). Creating a
  // Happier session in a directory IS the user's trust decision, and Claude Code's interactive
  // TUI silently skips EXECUTING all hooks (SessionStart/Stop/PreToolUse/...) in untrusted
  // workspaces — which kills session-id persistence, lifecycle detection, and permission hooks.
  // Claude also persists `hasTrustDialogAccepted: false` as a default/unaccepted project state.
  // Copying that state into a Happier-managed isolated home makes every connected-service session
  // appear healthy in the terminal while silently disabling the hooks Happier needs. Treat only a
  // positive source trust as authoritative and otherwise grant trust for this managed launch.
  return { hasTrustDialogAccepted: true };
}

async function resolveClaudeOauthAccountProjection(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
}>): Promise<ClaudeOauthAccountProjection | null> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (const candidate of candidates) {
    const rootConfig = await readClaudeRootConfigFile(candidate.path);
    if (!rootConfig) continue;
    const sanitized = sanitizeClaudeOauthAccountProjection(rootConfig.oauthAccount);
    if (sanitized) return sanitized;
  }
  return null;
}

async function writeClaudeRootConfig(params: Readonly<{
  targetDir: string;
  rootConfig: JsonObject;
}>): Promise<void> {
  await mkdir(params.targetDir, { recursive: true });
  const targetPath = join(params.targetDir, '.claude.json');
  const tempPath = join(params.targetDir, `.claude.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(params.rootConfig)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, targetPath);
    if (process.platform !== 'win32') {
      await chmod(targetPath, 0o600);
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeClaudeWorkspaceTrust(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  sessionDirectory?: string | null;
  preserveExistingOauthAccountProjection?: boolean | undefined;
}>): Promise<void> {
  const sessionDirectory = typeof params.sessionDirectory === 'string' && params.sessionDirectory.trim().length > 0
    ? resolve(params.sessionDirectory.trim())
    : null;
  if (!sessionDirectory) return;

  const projection = await resolveWorkspaceTrustProjection({
    sourceEnv: params.sourceEnv,
    sessionDirectory,
    targetDir: params.targetDir,
  });
  if (!projection) return;
  const existingRoot = await readClaudeRootConfigFile(join(params.targetDir, '.claude.json')) ?? {};
  const oauthAccount = params.preserveExistingOauthAccountProjection === true
    ? sanitizeClaudeOauthAccountProjection(existingRoot.oauthAccount)
    : await resolveClaudeOauthAccountProjection({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetDir,
      });
  const existingProjects = readObject(existingRoot.projects) ?? {};
  // Merge the trust projection into any claude-written project entry instead of replacing it, so
  // rematerialization does not clobber per-project state (allowedTools, history, ...).
  const existingProjectEntry = readObject(existingProjects[sessionDirectory]) ?? {};
  await writeClaudeRootConfig({
    targetDir: params.targetDir,
    rootConfig: {
      ...existingRoot,
      ...(oauthAccount ? { oauthAccount } : {}),
      projects: {
        ...existingProjects,
        [sessionDirectory]: {
          ...existingProjectEntry,
          ...projection,
        },
      },
    },
  });
}
