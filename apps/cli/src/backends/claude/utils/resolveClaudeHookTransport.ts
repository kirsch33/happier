import { probeClaudeHelpText } from '@/backends/claude/sessionControls/probeClaudeHelpText';
import { logger } from '@/ui/logger';

export type ClaudeHookTransport = 'plugin-dir' | 'settings';

export function resolveClaudeHookTransportFromHelpText(helpText: string | null | undefined): ClaudeHookTransport {
  if (typeof helpText !== 'string' || helpText.trim().length === 0) {
    return 'settings';
  }
  return /(?:^|[\s,])--plugin-dir(?:\b|=)/i.test(helpText) ? 'plugin-dir' : 'settings';
}

export async function resolveClaudeHookTransport(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  probeHelpText?: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<ClaudeHookTransport> {
  try {
    const probeHelpTextFn = params.probeHelpText ?? probeClaudeHelpText;
    const helpText = await probeHelpTextFn({
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    });
    const transport = resolveClaudeHookTransportFromHelpText(helpText);
    if (transport === 'settings') {
      logger.debug('[ClaudeHooks] Claude CLI help does not expose --plugin-dir; using settings hook fallback');
    }
    return transport;
  } catch (error) {
    logger.debug(`[ClaudeHooks] Failed to probe Claude CLI hook support; using settings hook fallback: ${error}`);
    return 'settings';
  }
}
