export type ClaudeUnifiedRuntimeAuthFailureDisposition =
  | Readonly<{ action: 'surface' }>
  | Readonly<{ action: 'restart_host'; reason: 'native_auth_healthy' }>;

export class ClaudeUnifiedTerminalRuntimeAuthRestartError extends Error {
  readonly code = 'claude_unified_terminal_runtime_auth_restart';
  readonly causeError: unknown;

  constructor(causeError: unknown) {
    super('Claude unified terminal runtime auth failed, but native Claude auth is healthy; restart the terminal host.');
    this.name = 'ClaudeUnifiedTerminalRuntimeAuthRestartError';
    this.causeError = causeError;
  }
}

export function isClaudeUnifiedTerminalRuntimeAuthRestartError(
  error: unknown,
): error is ClaudeUnifiedTerminalRuntimeAuthRestartError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_runtime_auth_restart';
}
