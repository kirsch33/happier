import {
  type TerminalControlCaptureResult,
  type TerminalControlPort,
  type TerminalControlSendFailureReason,
  type TerminalControlSendResult,
  type TerminalControlUnsupportedReason,
} from '@happier-dev/agents';

import { buildTerminalControlCapture } from '../terminalHost/controlCapture';
import { TERMINAL_SPECIAL_KEY_RAW_SEQUENCES } from '../terminalHost/controlTypes';
import { isZellijActionTimeoutError, type ZellijActions } from './actions';

export type ZellijControlActions = Pick<
  ZellijActions,
  'writeBytesChunked' | 'sendEnter' | 'sendEscape' | 'dumpScreen'
>;

/** The non-success states are shared between send and capture results, so map errors once. */
type ZellijControlFailureResult =
  | Readonly<{ status: 'unsupported'; reason: TerminalControlUnsupportedReason }>
  | Readonly<{ status: 'host_dead'; recoverable: boolean }>
  | Readonly<{ status: 'failed'; reason: TerminalControlSendFailureReason; detail?: string }>;

function isZellijHostDeadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /There is no active session/i.test(message)
    || /EXITED[\s\S]*attach to resurrect/i.test(message)
    || /no session named/i.test(message)
    || /(?:pane[^]*not found|no pane)/i.test(message);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function createZellijTerminalControlPort(params: Readonly<{
  actions: ZellijControlActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  paneId?: string;
  resolvePaneId?: () => Promise<string | null | undefined>;
  chunkSize?: number;
  timeoutMs?: number;
  nowMs?: () => number;
}>): TerminalControlPort {
  const nowMs = params.nowMs ?? Date.now;
  const paneId = params.paneId !== undefined && params.paneId.trim().length > 0 ? params.paneId : undefined;
  const sessionEnv: Readonly<Record<string, string>> = { ...params.env, ZELLIJ_SESSION_NAME: params.sessionName };
  const noTarget: ZellijControlFailureResult = { status: 'unsupported', reason: 'no_target' };

  function mapError(error: unknown): ZellijControlFailureResult {
    if (isZellijActionTimeoutError(error)) return { status: 'failed', reason: 'timeout' };
    if (isZellijHostDeadError(error)) return { status: 'host_dead', recoverable: false };
    const detail = sanitizeError(error);
    return detail.length > 0
      ? { status: 'failed', reason: 'host_unreachable', detail }
      : { status: 'failed', reason: 'host_unreachable' };
  }

  async function resolveTargetPaneId(): Promise<string | ZellijControlFailureResult> {
    try {
      const resolved = params.resolvePaneId
        ? await params.resolvePaneId()
        : paneId;
      const trimmed = typeof resolved === 'string' ? resolved.trim() : '';
      return trimmed.length > 0 ? trimmed : noTarget;
    } catch (error) {
      return mapError(error);
    }
  }

  async function write(text: string): Promise<TerminalControlSendResult> {
    const targetPaneId = await resolveTargetPaneId();
    if (typeof targetPaneId !== 'string') return targetPaneId;
    if (text.length === 0) return { status: 'sent', at: nowMs() };
    try {
      await params.actions.writeBytesChunked({
        zellijBinary: params.zellijBinary,
        env: sessionEnv,
        paneId: targetPaneId,
        text,
        ...(params.chunkSize !== undefined ? { chunkSize: params.chunkSize } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      });
      return { status: 'sent', at: nowMs() };
    } catch (error) {
      return mapError(error);
    }
  }

  async function sendNamedKey(send: (targetPaneId: string) => Promise<void>): Promise<TerminalControlSendResult> {
    const targetPaneId = await resolveTargetPaneId();
    if (typeof targetPaneId !== 'string') return targetPaneId;
    try {
      await send(targetPaneId);
      return { status: 'sent', at: nowMs() };
    } catch (error) {
      return mapError(error);
    }
  }

  function paneActionParams(targetPaneId: string): Readonly<{ zellijBinary: string; env: Readonly<Record<string, string>>; paneId: string; timeoutMs?: number }> {
    return {
      zellijBinary: params.zellijBinary,
      env: sessionEnv,
      paneId: targetPaneId,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    };
  }

  return {
    hostKind: 'zellij',
    sendLiteralText(text) {
      return write(text);
    },
    sendRawSequence(sequence) {
      return write(sequence);
    },
    async sendSpecialKey(key) {
      if (key === 'Enter') return sendNamedKey((targetPaneId) => params.actions.sendEnter(paneActionParams(targetPaneId)));
      if (key === 'Escape') return sendNamedKey((targetPaneId) => params.actions.sendEscape(paneActionParams(targetPaneId)));
      const raw = TERMINAL_SPECIAL_KEY_RAW_SEQUENCES[key];
      if (raw === undefined) return { status: 'unsupported', reason: 'special_key_unsupported' };
      return write(raw);
    },
    async captureScreen(): Promise<TerminalControlCaptureResult> {
      const targetPaneId = await resolveTargetPaneId();
      if (typeof targetPaneId !== 'string') return targetPaneId;
      try {
        const rawText = await params.actions.dumpScreen(paneActionParams(targetPaneId));
        return {
          status: 'captured',
          capture: buildTerminalControlCapture({ rawText, hostKind: 'zellij', capturedAtMs: nowMs() }),
        };
      } catch (error) {
        return mapError(error);
      }
    },
  };
}
