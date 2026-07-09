export type ClaudeUnifiedRuntimeAuthFailureDisposition =
  | Readonly<{ action: 'surface' }>
  | Readonly<{ action: 'restart_host'; reason: 'native_auth_healthy' }>
  | Readonly<{ action: 'terminate_host'; reason: 'runtime_auth_surface' | 'native_auth_unavailable' }>;

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

export class ClaudeUnifiedTerminalRuntimeAuthUnavailableError extends Error {
  readonly code = 'claude_unified_terminal_runtime_auth_unavailable';
  readonly causeError: unknown;
  readonly reason: string;

  constructor(causeError: unknown, reason: string) {
    super('Claude unified terminal runtime auth is unavailable; reconnect Claude auth before accepting more prompts.');
    this.name = 'ClaudeUnifiedTerminalRuntimeAuthUnavailableError';
    this.causeError = causeError;
    this.reason = reason;
  }
}

export function isClaudeUnifiedTerminalRuntimeAuthUnavailableError(
  error: unknown,
): error is ClaudeUnifiedTerminalRuntimeAuthUnavailableError {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_runtime_auth_unavailable';
}
