import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { createStackArchiveFixture } from './testkit/stack_archive_command_testkit.mjs';

test('hstack stack archive protects referenced worktrees by default', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const fixture = await createStackArchiveFixture(t, { stackName: 'exp-test', worktreeSlug: 'archived-by-stack' });

  const date = '2000-01-04';
  const nodeEnv = { ...fixture.baseEnv, PATH: '' };
  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'archive', fixture.stackName, `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected stack archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);

  const archivedStackDir = join(fixture.storageDir, '.archived', date, fixture.stackName);
  assert.equal(parsed.archivedStackDir, archivedStackDir, `expected archivedStackDir in JSON output\n${res.stdout}`);
  await stat(join(archivedStackDir, 'env'));

  const archivedWorktreeDir = join(fixture.workspaceDir, 'archive', 'worktrees', date, 'pr', 'archived-by-stack');
  await assert.rejects(() => stat(archivedWorktreeDir), /ENOENT/, 'expected default stack archive to leave worktree out of archive');
  const gitStat = await stat(join(fixture.worktreeDir, '.git'));
  assert.ok(gitStat.isFile(), 'expected referenced worktree to remain in place');
  assert.deepEqual(parsed.archivedWorktrees, [], `expected no archived worktrees by default\n${res.stdout}`);
  assert.equal(parsed.archiveWorktrees, false, `expected archiveWorktrees=false in JSON output\n${res.stdout}`);
  assert.equal(parsed.protectedWorktrees?.[0]?.dir, fixture.worktreeDir, `expected protected worktree in JSON output\n${res.stdout}`);
});

test('hstack stack archive --archive-worktrees archives referenced worktrees explicitly', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const fixture = await createStackArchiveFixture(t, { stackName: 'exp-test', worktreeSlug: 'archived-by-stack-opt-in' });

  const date = '2000-01-05';
  const nodeEnv = { ...fixture.baseEnv, PATH: '' };
  const res = await runNodeCapture(
    [join(rootDir, 'scripts', 'stack.mjs'), 'archive', fixture.stackName, `--date=${date}`, '--archive-worktrees', '--json'],
    {
      cwd: rootDir,
      env: nodeEnv,
    },
  );
  assert.equal(res.code, 0, `expected stack archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);
  assert.equal(parsed.archiveWorktrees, true, `expected archiveWorktrees=true in JSON output\n${res.stdout}`);

  const archivedStackDir = join(fixture.storageDir, '.archived', date, fixture.stackName);
  await stat(join(archivedStackDir, 'env'));

  const archivedWorktreeDir = join(fixture.workspaceDir, 'archive', 'worktrees', date, 'pr', 'archived-by-stack-opt-in');
  const gitStat = await stat(join(archivedWorktreeDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived worktree to be detached (standalone .git dir)');
  assert.equal(parsed.archivedWorktrees?.[0]?.destDir, archivedWorktreeDir, `expected archived worktree in JSON output\n${res.stdout}`);
  assert.deepEqual(parsed.protectedWorktrees, [], `expected no protected worktrees with explicit opt-in\n${res.stdout}`);
});

test('hstack stack archive --dry-run reports protected worktrees without mutating', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const fixture = await createStackArchiveFixture(t, { stackName: 'exp-test', worktreeSlug: 'archived-by-stack-dry-run' });

  const date = '2000-01-06';
  const nodeEnv = { ...fixture.baseEnv, PATH: '' };
  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'archive', fixture.stackName, `--date=${date}`, '--dry-run', '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected stack archive dry-run exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);
  assert.equal(parsed.dryRun, true, `expected dryRun=true JSON output\n${res.stdout}`);
  assert.equal(parsed.plannedMoves?.stack?.dir, join(fixture.storageDir, fixture.stackName), `expected stack planned move\n${res.stdout}`);
  assert.equal(parsed.protectedWorktrees?.[0]?.dir, fixture.worktreeDir, `expected protected worktree in dry-run output\n${res.stdout}`);

  await stat(join(fixture.storageDir, fixture.stackName, 'env'));
  await stat(join(fixture.worktreeDir, '.git'));
});
