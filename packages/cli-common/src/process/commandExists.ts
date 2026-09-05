import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  resolveWindowsCommandInvocation,
  resolveWindowsCommandOnPath,
} from './windows/resolveWindowsCommandInvocation.js';

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, fsConstants.X_OK), true);
  } catch {
    return false;
  }
}

function isExecutableFileViaShell(path: string): boolean {
  const result = spawnSync(
    '/bin/sh',
    ['-c', '[ -f "$1" ] && [ -x "$1" ]', 'happier-command-probe', path],
    { stdio: 'ignore' },
  );
  return !result.error && result.status === 0;
}

export function commandExistsOnPath(
  cmd: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    path?: string | undefined;
  }> = {},
): boolean {
  const name = String(cmd ?? '').trim();
  if (!name) return false;

  const env = options.env ?? process.env;
  const pathEnv = options.path ?? env.PATH ?? process.env.PATH;
  const probeEnv = { ...process.env, ...env, PATH: pathEnv };

  if (process.platform === 'win32') {
    if (/^cmd(?:\.exe)?$/i.test(name)) {
      const invocation = resolveWindowsCommandInvocation({
        command: name,
        args: [],
        env: probeEnv,
      });
      if (invocation.command.toLowerCase() !== name.toLowerCase()) {
        return true;
      }
    }

    return resolveWindowsCommandOnPath(name, probeEnv) !== null;
  }

  if (name.includes('/')) return isExecutableFile(name) || isExecutableFileViaShell(name);

  const candidates = String(pathEnv ?? '')
    .split(delimiter)
    .map((dir) => join(dir || '.', name));
  return candidates.some(isExecutableFile)
    || candidates.some(isExecutableFileViaShell);
}
