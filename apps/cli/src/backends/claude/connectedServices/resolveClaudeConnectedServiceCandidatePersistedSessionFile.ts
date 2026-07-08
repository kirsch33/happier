import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';
import { getProjectPath } from '../utils/path';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeClaudeSessionId(value: unknown): string | null {
  const sessionId = readNonEmptyString(value);
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\')) return null;
  return sessionId;
}

function resolveClaudeProjectsRootForTranscriptPath(path: string): string | null {
  let current = dirname(path);
  while (true) {
    if (basename(current) === 'projects') return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  if (rel.length === 0) return true;
  return !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

function pathExistsAsRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveClaudeConnectedServiceCandidatePersistedSessionFile(input: Readonly<{
  metadata: unknown;
  vendorResumeId?: string | null;
  sessionDirectory?: string | null;
  processEnv?: Readonly<Record<string, string | undefined>> | null;
}>): string | null {
  const metadata = readRecord(input.metadata);
  const metadataCandidate = metadata ? resolveClaudeCandidateFromMetadata(metadata) : null;
  if (metadataCandidate) return metadataCandidate;

  return resolveClaudeCandidateFromAmbientStore({
    vendorResumeId: input.vendorResumeId ?? null,
    sessionDirectory: input.sessionDirectory ?? null,
    processEnv: input.processEnv ?? null,
  });
}

function resolveClaudeCandidateFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
): string | null {

  const sessionId = normalizeClaudeSessionId(metadata.claudeSessionId);
  const transcriptPath = readNonEmptyString(metadata.claudeTranscriptPath);
  if (!sessionId || !transcriptPath || !isAbsolute(transcriptPath)) return null;
  if (basename(transcriptPath) !== `${sessionId}.jsonl`) return null;

  const projectsRoot = resolveClaudeProjectsRootForTranscriptPath(transcriptPath);
  if (!projectsRoot || !isPathWithin(transcriptPath, projectsRoot)) return null;

  const relativeTranscriptPath = relative(projectsRoot, transcriptPath);
  const [projectId] = relativeTranscriptPath.split(/[\\/]/);
  if (!projectId || projectId === '..' || projectId.includes('/') || projectId.includes('\\')) return null;

  if (!existsSync(transcriptPath) || !pathExistsAsRegularFile(transcriptPath)) return null;
  return transcriptPath;
}

function resolveClaudeAmbientConfigDir(
  processEnv: Readonly<Record<string, string | undefined>> | null,
): string {
  const envWithoutOverrides: NodeJS.ProcessEnv = { ...(processEnv ?? process.env) };
  delete envWithoutOverrides.CLAUDE_CONFIG_DIR;
  delete envWithoutOverrides.HAPPIER_CLAUDE_CONFIG_DIR;
  return resolveConfiguredClaudeConfigDir({ env: envWithoutOverrides });
}

function resolveClaudeCandidateFromAmbientStore(params: Readonly<{
  vendorResumeId: string | null;
  sessionDirectory: string | null;
  processEnv: Readonly<Record<string, string | undefined>> | null;
}>): string | null {
  const sessionId = normalizeClaudeSessionId(params.vendorResumeId);
  const sessionDirectory = readNonEmptyString(params.sessionDirectory);
  if (!sessionId || !sessionDirectory || !isAbsolute(sessionDirectory)) return null;

  const ambientConfigDir = resolveClaudeAmbientConfigDir(params.processEnv);
  const transcriptPath = join(
    getProjectPath(sessionDirectory, ambientConfigDir),
    `${sessionId}.jsonl`,
  );
  return pathExistsAsRegularFile(transcriptPath) ? transcriptPath : null;
}
