import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';
import { verifyResumeReachableClaude } from './verifyResumeReachableClaude';

const PROJECT_DIR_NAME = '-Users-leeroy-Documents-Development-happier-remote-dev';
const VENDOR_RESUME_ID = '4b9434a8-b115-4363-851a-f39fff76a94b';

async function makeSelfSourceHome(): Promise<Readonly<{ homeDir: string; targetDir: string; ambientDir: string }>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-home-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-target-'));
  const ambientDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-ambient-'));
  return { homeDir, targetDir, ambientDir };
}

async function setFileMtime(path: string, atMs: number): Promise<void> {
  const seconds = atMs / 1000;
  await utimes(path, seconds, seconds);
}

describe('syncClaudeConnectedServiceHome self-source sharing-policy reconciliation', () => {
  it('converts an isolated self-source projects dir into a shared-store link when sharing is toggled on', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const isolatedProjectDir = join(targetDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(isolatedProjectDir, { recursive: true });
    await writeFile(join(isolatedProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"isolated era session"}\n');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('shared');
    expect(result.effectiveStateMode).toBe('shared');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(true);
    await expect(realpath(join(targetDir, 'projects'))).resolves.toBe(await realpath(join(ambientDir, 'projects')));

    // The isolated-era session file is preserved into the shared store and stays reachable through the link.
    await expect(
      readFile(join(ambientDir, 'projects', PROJECT_DIR_NAME, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('isolated era session');
    await expect(verifyResumeReachableClaude({
      vendorResumeId: VENDOR_RESUME_ID,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
    })).resolves.toMatchObject({ ok: true });

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('shared');
    expect(manifest.stateEntries).toContain('projects');
  });

  it('keeps an isolated projects dir when the shared Claude projects store is unusable', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const isolatedProjectDir = join(targetDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(isolatedProjectDir, { recursive: true });
    await writeFile(join(isolatedProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"kept isolated"}\n');
    await writeFile(join(ambientDir, 'projects'), 'not a directory');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('shared');
    expect(result.effectiveStateMode).toBe('isolated');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_shared_projects_store_unwritable',
      severity: 'warning',
      effectiveStateMode: 'isolated',
    }));

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(false);
    expect(projectsStat.isDirectory()).toBe(true);
    await expect(
      readFile(join(isolatedProjectDir, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('kept isolated');

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('isolated');
    expect(manifest.stateEntries).toEqual([]);
    expect(manifest.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_shared_projects_store_unwritable',
    }));
  });

  it('detaches the shared projects link into an isolated dir when sharing is toggled off', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    await writeFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"shared era session"}\n');
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('isolated');
    expect(result.effectiveStateMode).toBe('isolated');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(false);
    expect(projectsStat.isDirectory()).toBe(true);
    await expect(readdir(join(targetDir, 'projects'))).resolves.toEqual([]);

    // Ambient sessions stay in the ambient store untouched — nothing is deleted by the detach.
    await expect(
      readFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('shared era session');

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('isolated');
    expect(manifest.effectiveStateMode).toBe('isolated');
    expect(manifest.stateEntries).toEqual([]);
  });
});

describe('syncClaudeConnectedServiceHome candidate session import reconciliation', () => {
  it('keeps the newest canonical jsonl and removes stale conflict copies instead of leaving divergent imports', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"canonical newest content"}\n');
    const staleConflictPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.happier-import-deadbeef0000.jsonl`);
    await writeFile(staleConflictPath, '{"type":"assistant","text":"frozen import"}\n');
    await setFileMtime(staleConflictPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"older divergent source"}\n');
    await setFileMtime(candidatePath, Date.now() - 30 * 60 * 1000);

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    // Canonical newest content wins; no conflict copy remains for the resume id.
    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('canonical newest content');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath.endsWith(`${VENDOR_RESUME_ID}.jsonl`)).toBe(true);
    expect(mapping?.destinationPath.includes('.happier-import-')).toBe(false);
  });

  it('promotes a newer candidate session file over a stale canonical copy', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"stale canonical"}\n');
    await setFileMtime(canonicalPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"newer real session"}\n');

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('newer real session');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath).toBe(canonicalPath);
  });

  it('imports the candidate session into isolated target state when the shared source store is unusable', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-source-'));
    await writeFile(join(sourceDir, 'projects'), 'not a directory');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"candidate imported isolated"}\n');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    expect(result.requestedStateMode).toBe('shared');
    expect(result.effectiveStateMode).toBe('isolated');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_shared_projects_store_unwritable',
      severity: 'warning',
    }));

    const importedPath = join(targetDir, 'projects', PROJECT_DIR_NAME, `${VENDOR_RESUME_ID}.jsonl`);
    await expect(readFile(importedPath, 'utf8')).resolves.toContain('candidate imported isolated');

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.effectiveStateMode).toBe('isolated');
    expect(manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID)?.destinationPath)
      .toBe(importedPath);
  });
});
