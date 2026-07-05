import type { TerminalHostLiveness } from '@/integrations/terminalHost/_types';

function isReturnedToShellCommand(command: string | undefined): boolean {
  const normalized = (command ?? '').trim().toLowerCase();
  return normalized === 'bash'
    || normalized === 'sh'
    || normalized === 'zsh'
    || normalized === 'fish'
    || normalized === 'pwsh'
    || normalized === 'powershell'
    || normalized === 'powershell.exe'
    || normalized === 'cmd'
    || normalized === 'cmd.exe';
}

export function normalizeClaudeUnifiedHostLiveness(liveness: TerminalHostLiveness): TerminalHostLiveness {
  if (!liveness.paneAlive || !isReturnedToShellCommand(liveness.paneCurrentCommand)) return liveness;
  return {
    ...liveness,
    paneAlive: false,
    paneDead: true,
    paneScreenDumpError: `terminal host returned to shell (${liveness.paneCurrentCommand})`,
  };
}
