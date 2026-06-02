import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv kills only this stack session markers when daemon control is unavailable', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-session-marker-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'exp-session-marker';
  const otherStackName = 'exp-other-session-marker';
  const baseDir = join(storageDir, stackName);
  const otherBaseDir = join(storageDir, otherStackName);
  const envPath = join(baseDir, 'env');
  const otherEnvPath = join(otherBaseDir, 'env');
  const cliHomeDir = join(baseDir, 'cli');
  const repoDir = join(tmp, 'repo');

  await mkdir(cliHomeDir, { recursive: true });
  await mkdir(otherBaseDir, { recursive: true });
  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_ENV_FILE=${envPath}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    otherEnvPath,
    [
      `HAPPIER_STACK_STACK=${otherStackName}`,
      `HAPPIER_STACK_ENV_FILE=${otherEnvPath}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  const children = [];
  t.after(async () => {
    for (const child of children) {
      const pid = child?.pid;
      if (!pid || !isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const stackSession = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    },
  });
  children.push(stackSession);
  await waitForProcessAlive({ pid: stackSession.pid, label: 'stack session marker' });

  const otherStackSession = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: otherStackName,
      HAPPIER_STACK_ENV_FILE: otherEnvPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });
  children.push(otherStackSession);
  await waitForProcessAlive({ pid: otherStackSession.pid, label: 'other stack session marker' });

  const actions = await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: true,
  });

  await waitForProcessExit({
    pid: stackSession.pid,
    timeoutMs: 20_000,
    intervalMs: 50,
    label: 'stack session marker after stop',
  });
  assert.ok(!isAlive(stackSession.pid), `expected stack session pid ${stackSession.pid} to be stopped`);
  assert.ok(isAlive(otherStackSession.pid), `expected other stack session pid ${otherStackSession.pid} to stay alive`);
  assert.equal(actions.sessionRunners?.fallback, true);
});
