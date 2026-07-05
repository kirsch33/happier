import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostLiveness } from '@/integrations/terminalHost/_types';
import { sanitizeTerminalHostDiagnosticText } from '@/integrations/terminalHost/sanitizeTerminalHostDiagnosticText';
import { delayUnrefAbortable } from '@/utils/time';

import { ClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import type { ClaudeUnifiedStartableDisposable } from './_types';
import { emitClaudeUnifiedHostDead, type ClaudeUnifiedTelemetrySink } from './telemetry';
import { normalizeClaudeUnifiedHostLiveness } from './normalizeClaudeUnifiedHostLiveness';

const DEFAULT_HOST_LIVENESS_POLL_MS = 30_000;
const DEFAULT_HOST_LIVENESS_CONFIRM_DEAD_POLL_MS = 1_000;
const DEFAULT_HOST_LIVENESS_MAX_JITTER_MS = 5_000;
// Incident cmq8y3nlx (2026-06-12 11:24): two `zellij list-panes timed out` probe failures ~1s
// apart were escalated to host_dead and the dispose path killed a healthy idle session. Probe
// failures are inconclusive (zellij overloaded ≠ host dead); only a SUSTAINED failure streak may
// escalate. Real deaths stay fast via the conclusive adapter path (paneDead === true).
const DEFAULT_HOST_LIVENESS_PROBE_FAILURE_CONFIRM_DEAD_MS = 60_000;

function mergeDeadLivenessDiagnostics(
  pending: TerminalHostLiveness,
  latest: TerminalHostLiveness,
): TerminalHostLiveness {
  return { ...pending, ...latest };
}

function createProbeFailureLiveness(
  error: unknown,
  observedAt: number,
): TerminalHostLiveness {
  const message = error instanceof Error ? error.message : String(error);
  return {
    paneAlive: false,
    probeInconclusive: true,
    paneScreenDumpError: sanitizeTerminalHostDiagnosticText(message),
    observedAt,
  };
}

function stableJitterOffsetMs(handle: TerminalHostHandle, jitterWindowMs: number): number {
  if (jitterWindowMs <= 0) return 0;
  const key = `${handle.kind}:${handle.sessionName}:${handle.paneId ?? ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % (jitterWindowMs + 1);
}

export function createClaudeUnifiedHostLivenessBridge(opts: Readonly<{
  hostAdapter: Pick<TerminalHostAdapter, 'evaluateLiveness'>;
  handle: TerminalHostHandle;
  onHostDead: (error: ClaudeUnifiedTerminalHostDeadError) => void | Promise<void>;
  onHostExited?: ((liveness: TerminalHostLiveness) => void | Promise<void>) | undefined;
  isExpectedHostExit?: ((liveness: TerminalHostLiveness) => boolean) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  pollIntervalMs?: number | undefined;
  confirmDeadPollIntervalMs?: number | undefined;
  probeFailureConfirmDeadMs?: number | undefined;
  pollJitterMs?: number | undefined;
  startupGraceMs?: number | undefined;
  startupGraceActive?: (() => boolean) | undefined;
  nowMs?: (() => number) | undefined;
}>): ClaudeUnifiedStartableDisposable {
  const pollIntervalMs = Math.max(1, Math.trunc(opts.pollIntervalMs ?? DEFAULT_HOST_LIVENESS_POLL_MS));
  const confirmDeadPollIntervalMs = Math.max(
    1,
    Math.trunc(opts.confirmDeadPollIntervalMs ?? Math.min(DEFAULT_HOST_LIVENESS_CONFIRM_DEAD_POLL_MS, pollIntervalMs)),
  );
  const probeFailureConfirmDeadMs = Math.max(
    1,
    Math.trunc(opts.probeFailureConfirmDeadMs ?? DEFAULT_HOST_LIVENESS_PROBE_FAILURE_CONFIRM_DEAD_MS),
  );
  const defaultJitterMs = pollIntervalMs >= 1_000
    ? Math.min(DEFAULT_HOST_LIVENESS_MAX_JITTER_MS, Math.floor(pollIntervalMs / 5))
    : 0;
  const pollJitterMs = Math.max(0, Math.trunc(opts.pollJitterMs ?? defaultJitterMs));
  const steadyStatePollDelayMs = pollIntervalMs + stableJitterOffsetMs(opts.handle, pollJitterMs);
  const startupGraceMs = Math.max(0, Math.trunc(opts.startupGraceMs ?? 0));
  const nowMs = opts.nowMs ?? Date.now;
  let disposed = false;
  let started = false;
  let reported = false;
  let startedAtMs = 0;
  let pendingDeadLiveness: TerminalHostLiveness | null = null;
  let probeFailureStreakStartedAtMs: number | null = null;
  let startupGracePreviouslyActive = opts.startupGraceActive?.() === true;

  const reportHostExited = async (liveness: TerminalHostLiveness): Promise<void> => {
    if (reported || disposed) return;
    reported = true;
    await opts.onHostExited?.(liveness);
  };

  const reportHostDead = async (liveness?: TerminalHostLiveness | undefined): Promise<void> => {
    if (reported || disposed) return;
    reported = true;
    if (opts.telemetry) {
      try {
        emitClaudeUnifiedHostDead(opts.telemetry, {
          hostKind: opts.handle.kind,
          sessionName: opts.handle.sessionName,
          paneId: opts.handle.paneId,
          liveness,
        });
      } catch {
        // Telemetry is diagnostic-only; host death must still reach the fatal path.
      }
    }
    await opts.onHostDead(new ClaudeUnifiedTerminalHostDeadError(liveness));
  };

  const monitor = async (abortSignal: AbortSignal): Promise<void> => {
    while (!disposed && !abortSignal.aborted) {
      const startupGraceSignalActive = opts.startupGraceActive?.() === true;
      const startupGraceJustEnded = startupGracePreviouslyActive && !startupGraceSignalActive;
      await delayUnrefAbortable(
        pendingDeadLiveness !== null
          || probeFailureStreakStartedAtMs !== null
          || startupGraceSignalActive
          || startupGraceJustEnded
          ? confirmDeadPollIntervalMs
          : steadyStatePollDelayMs,
        abortSignal,
      );
      if (disposed || abortSignal.aborted) return;
      let liveness: TerminalHostLiveness;
      let probeFailed = false;
      try {
        liveness = normalizeClaudeUnifiedHostLiveness(await opts.hostAdapter.evaluateLiveness(opts.handle));
      } catch (error) {
        probeFailed = true;
        liveness = createProbeFailureLiveness(error, nowMs());
      }
      startupGracePreviouslyActive = opts.startupGraceActive?.() === true;
      if (disposed || abortSignal.aborted) return;
      if (!liveness.paneAlive) {
        const graceActive = opts.startupGraceActive?.() ?? true;
        if (graceActive && startupGraceMs > 0 && nowMs() - startedAtMs < startupGraceMs) {
          pendingDeadLiveness = null;
          probeFailureStreakStartedAtMs = null;
          continue;
        }
        if (probeFailed || liveness.probeInconclusive === true) {
          // Inconclusive: the probe itself failed (e.g. zellij CLI timeout under load), so this
          // is not evidence of a dead host. It can neither seed nor confirm the pending-dead
          // escalation; only a sustained, uninterrupted failure streak (a truly unreachable
          // host) escalates, carrying any earlier conclusive diagnostics along.
          probeFailureStreakStartedAtMs ??= nowMs();
          if (nowMs() - probeFailureStreakStartedAtMs >= probeFailureConfirmDeadMs) {
            await reportHostDead(
              pendingDeadLiveness === null
                ? liveness
                : mergeDeadLivenessDiagnostics(pendingDeadLiveness, liveness),
            );
            return;
          }
          continue;
        }
        probeFailureStreakStartedAtMs = null;
        if (opts.isExpectedHostExit?.(liveness) === true) {
          await reportHostExited(liveness);
          return;
        }
        if (pendingDeadLiveness === null) {
          pendingDeadLiveness = liveness;
          continue;
        }
        await reportHostDead(mergeDeadLivenessDiagnostics(pendingDeadLiveness, liveness));
        return;
      }
      pendingDeadLiveness = null;
      probeFailureStreakStartedAtMs = null;
    }
  };

  return {
    start({ abortSignal }) {
      if (disposed || started) return;
      started = true;
      startedAtMs = nowMs();
      return monitor(abortSignal);
    },
    dispose() {
      disposed = true;
    },
  };
}
