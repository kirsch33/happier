import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { isTerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { logger } from '@/ui/logger';

import {
  isClaudeUnifiedTerminalManagedSettingsOptionError,
  isClaudeUnifiedTerminalRootBypassRequiresSandboxError,
} from './buildClaudeUnifiedTerminalSpawn';
import { isClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import { isClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import { isClaudeUnifiedTerminalTerminalInjectionFailureError } from './terminalInjectionFailureError';

type RuntimeIssueSessionClient = Parameters<typeof surfacePrimarySessionRuntimeIssue>[0]['session'];

export function isClaudeUnifiedTerminalRuntimeIssueError(error: unknown): boolean {
  return isClaudeUnifiedTerminalHostDeadError(error)
    || isClaudeUnifiedTerminalTerminalInjectionFailureError(error)
    || isClaudeUnifiedTerminalReadinessTimeoutError(error)
    || isTerminalHostStartupError(error)
    || isClaudeUnifiedTerminalManagedSettingsOptionError(error)
    || isClaudeUnifiedTerminalRootBypassRequiresSandboxError(error);
}

export async function surfaceClaudeUnifiedTerminalRuntimeIssue(params: Readonly<{
  error: unknown;
  session: RuntimeIssueSessionClient;
  onSurfaceError?: ((error: unknown) => void) | undefined;
}>): Promise<boolean> {
  if (!isClaudeUnifiedTerminalRuntimeIssueError(params.error)) return false;
  // Log readiness-timeout diagnostics (D16) so a live-host startup failure is actionable in the daemon
  // log instead of disappearing as a generic fatal command error. The screen tail is already sanitized.
  if (isClaudeUnifiedTerminalReadinessTimeoutError(params.error) && params.error.diagnostics) {
    logger.debug('[unified]: Claude unified terminal startup readiness timed out before injection', {
      timeoutMs: params.error.timeoutMs,
      ...params.error.diagnostics,
    });
  }
  try {
    await surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'session_error',
      error: params.error,
      session: params.session,
      // Host death, readiness timeout, and injection failure are session-scoped
      // and routinely occur with no active turn; allocate one so the failure is
      // surfaced instead of silently dropped (incident cmq8y3nlx / QA A-F4).
      allocateTurnWhenIdle: true,
    });
  } catch (error) {
    params.onSurfaceError?.(error);
  }
  return true;
}
