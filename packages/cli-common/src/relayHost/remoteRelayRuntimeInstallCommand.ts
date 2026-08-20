function quoteShellArg(value: string): string {
  const raw = String(value ?? '');
  return raw === '' ? "''" : `'${raw.replaceAll("'", `'"'"'`)}'`;
}

function quoteRemotePathWithHomeExpansion(path: string): string {
  if (path === '$HOME') return '"$HOME"';
  if (path.startsWith('$HOME/')) {
    return `"$HOME"/${quoteShellArg(path.slice('$HOME/'.length))}`;
  }
  return quoteShellArg(path);
}

export function buildRemoteRelayRuntimeInstallCommand(params: Readonly<{
  cliBinaryPath: string;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  profile?: 'light' | 'full';
  env?: Readonly<Record<string, unknown>>;
  serverBinaryPath?: string;
}>): string {
  const envArgs = Object.entries(params.env ?? {}).flatMap(([key, value]) => {
    const normalizedKey = key.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalizedKey)) return [];
    return [`--env ${quoteShellArg(`${normalizedKey}=${String(value ?? '')}`)}`];
  });
  const serverBinaryPath = String(params.serverBinaryPath ?? '').trim();
  return [
    `${params.cliBinaryPath} relay host install`,
    `--channel ${quoteShellArg(params.channel)}`,
    `--mode ${params.mode}`,
    `--profile ${params.profile === 'full' ? 'full' : 'light'}`,
    ...envArgs,
    ...(serverBinaryPath ? [`--server-binary ${quoteRemotePathWithHomeExpansion(serverBinaryPath)}`] : []),
    '--preserve-active-server',
    '--yes',
    '--json',
  ].join(' ');
}
