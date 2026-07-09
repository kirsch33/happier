import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers';

let cachedResolvedClaudeCliPath: string | null = null;

export function resolveClaudeCliPath(opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {}): string {
  const processEnv = opts.processEnv ?? process.env;
  const canUseGlobalCache = opts.processEnv === undefined || opts.processEnv === process.env;
  if (canUseGlobalCache && cachedResolvedClaudeCliPath) {
    return cachedResolvedClaudeCliPath;
  }

  const resolved = resolveProviderCliCommand('claude', {
    processEnv,
    currentExecPath: process.execPath,
  });
  if (!resolved) {
    throw new ReferenceError(
      'Claude CLI (claude) is not available from any configured source. Install Claude Code or set HAPPIER_CLAUDE_PATH, then restart the daemon.',
    );
  }

  if (canUseGlobalCache) {
    cachedResolvedClaudeCliPath = resolved.command;
  }
  return resolved.command;
}

export function isClaudeCliJavaScriptFile(cliPath: string): boolean {
  const normalized = typeof cliPath === 'string' ? cliPath.trim() : '';
  return normalized.endsWith('.js') || normalized.endsWith('.cjs') || normalized.endsWith('.mjs');
}
