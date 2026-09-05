import { commandExistsOnPath, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

export function commandExistsInPath(params: Readonly<{
  cmd: string;
  envPath: string | undefined;
  platform: NodeJS.Platform;
  pathext?: string | undefined;
}>): boolean {
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) return false;

  if (params.platform === 'win32') {
    return (
      resolveWindowsCommandOnPath(cmd, {
        PATH: params.envPath,
        PATHEXT: params.pathext,
      }) !== null
    );
  }

  return commandExistsOnPath(cmd, { path: params.envPath });
}
