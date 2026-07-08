import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceCandidatePersistedSessionFile } from '@/backends/catalog';
import { getProjectPath } from '@/backends/claude/utils/path';

describe('resolveClaudeConnectedServiceCandidatePersistedSessionFile', () => {
  it('returns the persisted Claude transcript path when metadata proves the provider session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-candidate-'));
    const sessionId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const sessionPath = join(
      root,
      'claude-subscription',
      'leeroy_new',
      'claude',
      'claude-config',
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, '{"type":"assistant"}\n');

    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {
      claudeSessionId: sessionId,
      claudeTranscriptPath: sessionPath,
    })).toBe(sessionPath);
  });

  it('rejects stale or unsafe Claude transcript metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-candidate-'));
    const sessionId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const otherPath = join(root, 'projects', 'worktree', 'other-session.jsonl');
    await mkdir(dirname(otherPath), { recursive: true });
    await writeFile(otherPath, '{"type":"assistant"}\n');

    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {
      claudeSessionId: sessionId,
      claudeTranscriptPath: otherPath,
    })).toBeNull();
    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {
      claudeSessionId: sessionId,
      claudeTranscriptPath: 'relative/projects/worktree/f55b3644-befc-406a-90ac-b8fbcc33cbf6.jsonl',
    })).toBeNull();
    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {
      claudeSessionId: '../escape',
      claudeTranscriptPath: join(root, 'projects', 'worktree', '../escape.jsonl'),
    })).toBeNull();
  });

  it('falls back to the ambient Claude transcript store when resume metadata omits the transcript path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-candidate-'));
    const ambientHome = join(root, 'ambient-home');
    const managedConfigDir = join(root, 'managed', 'claude-config');
    const sessionDirectory = join(root, 'worktrees', 'dbtools');
    const sessionId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const ambientTranscriptPath = join(
      getProjectPath(sessionDirectory, join(ambientHome, '.claude')),
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(ambientTranscriptPath), { recursive: true });
    await mkdir(managedConfigDir, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(ambientTranscriptPath, '{"type":"assistant"}\n');

    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {}, {
      vendorResumeId: sessionId,
      sessionDirectory,
      processEnv: {
        HOME: ambientHome,
        CLAUDE_CONFIG_DIR: managedConfigDir,
      },
    })).toBe(ambientTranscriptPath);
  });

  it('does not treat the isolated connected-service Claude config as the ambient resume store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-candidate-'));
    const ambientHome = join(root, 'ambient-home');
    const managedConfigDir = join(root, 'managed', 'claude-config');
    const sessionDirectory = join(root, 'worktrees', 'dbtools');
    const sessionId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const managedTranscriptPath = join(
      getProjectPath(sessionDirectory, managedConfigDir),
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(managedTranscriptPath), { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(managedTranscriptPath, '{"type":"assistant"}\n');

    expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {}, {
      vendorResumeId: sessionId,
      sessionDirectory,
      processEnv: {
        HOME: ambientHome,
        CLAUDE_CONFIG_DIR: managedConfigDir,
      },
    })).toBeNull();
  });
});
