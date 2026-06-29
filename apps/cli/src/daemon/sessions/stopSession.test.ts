import { describe, expect, it, vi } from 'vitest';

import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

const readTerminalAttachmentInfo = vi.fn<(_: {
  happyHomeDir: string;
  sessionId: string;
}) => Promise<TerminalAttachmentInfo | null>>(async () => null);
vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
  readTerminalAttachmentInfo,
}));

const resolveZellijRuntimeBinary = vi.fn<(params?: { expectedVersion?: string }) => Promise<string | null>>(
  async () => null,
);
vi.mock('@/integrations/zellij/runtimeBinary', () => ({
  resolveZellijRuntimeBinary,
}));

const prepareZellijSocketDir = vi.fn(async () => {});
const resolveZellijSocketDir = vi.fn(() => '/happy-home/terminal/zellij');
vi.mock('@/integrations/zellij/socketDir', () => ({
  prepareZellijSocketDir,
  resolveZellijSocketDir,
}));

const zellijKillSession = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
vi.mock('@/integrations/zellij/actions', () => ({
  defaultZellijActions: {
    killSession: zellijKillSession,
  },
}));

const tmuxKillWindow = vi.fn(async (_sessionIdentifier: string) => true);
type TmuxExecuteArgs = [cmd: string[], session?: string, window?: string, pane?: string, socketPath?: string];
const tmuxExecuteTmuxCommand = vi.fn(async (..._args: TmuxExecuteArgs) => ({
  returncode: 0,
  stdout: '',
  stderr: '',
  command: [],
}));
const tmuxCtorCalls: Array<{ sessionName?: string; env?: Record<string, string>; socketPath?: string }> = [];
vi.mock('@/integrations/tmux/TmuxUtilities', () => ({
  TmuxUtilities: class {
    constructor(sessionName?: string, env?: Record<string, string>, socketPath?: string) {
      tmuxCtorCalls.push({ sessionName, env, socketPath });
    }
    killWindow(sessionIdentifier: string) {
      return tmuxKillWindow(sessionIdentifier);
    }
    executeTmuxCommand(
      cmd: string[],
      session?: string,
      window?: string,
      pane?: string,
      socketPath?: string,
    ) {
      return tmuxExecuteTmuxCommand(cmd, session, window, pane, socketPath);
    }
  },
}));

describe('createStopSession', () => {
  it('keeps matched tracked sessions until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
    expect(killDaemonChild).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
    expect(pidToTrackedSession.get(111)?.stopRequestedAtMs).toBe(123456789);
    expect(pidToTrackedSession.get(222)?.stopRequestedAtMs).toBe(123456789);
    nowSpy.mockRestore();
  });

  it('keeps tracked daemon sessions when falling back to child-process SIGTERM', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
  });

  it('keeps daemon-owned tracking when both process-group and child-process termination fail', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killDaemonChild = vi.fn(() => {
      throw new Error('child kill failed');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const trackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      childProcess: { kill: killDaemonChild },
      processCommandHash: 'h1',
    };
    const pidToTrackedSession = new Map<number, any>([
      [111, trackedSession],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(111)).toBe(trackedSession);
  });

  it('keeps tracked in-flight attaches until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, spawnOptions: { existingSessionId: 'sess-2' }, processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-2');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(1);
    expect(pidToTrackedSession.has(333)).toBe(true);
  });

  it('kills the zellij terminal host recorded for a stopped terminal-hosted session', async () => {
    const { createStopSession } = await import('./stopSession');

    readTerminalAttachmentInfo.mockResolvedValueOnce({
      version: 1,
      sessionId: 'sess-zellij',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-123',
          paneId: 'terminal_1',
        },
      },
      updatedAt: 1,
    });
    resolveZellijRuntimeBinary.mockResolvedValueOnce('/tools/zellij');
    zellijKillSession.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, happySessionId: 'sess-zellij', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-zellij');

    expect(ok).toBe(true);
    expect(prepareZellijSocketDir).toHaveBeenCalledWith('/happy-home/terminal/zellij');
    expect(zellijKillSession).toHaveBeenCalledWith({
      zellijBinary: '/tools/zellij',
      env: { ZELLIJ_SOCKET_DIR: '/happy-home/terminal/zellij' },
      sessionName: 'happier-claude-unified-123',
      timeoutMs: expect.any(Number),
    });
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
  });

  it('treats an already-missing recorded zellij terminal host as stopped', async () => {
    const { createStopSession } = await import('./stopSession');

    readTerminalAttachmentInfo.mockResolvedValueOnce({
      version: 1,
      sessionId: 'sess-zellij',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-123',
          paneId: 'terminal_1',
        },
      },
      updatedAt: 1,
    });
    resolveZellijRuntimeBinary.mockResolvedValueOnce('/tools/zellij');
    zellijKillSession.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'No session named "happier-claude-unified-123" found',
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, happySessionId: 'sess-zellij', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-zellij');

    expect(ok).toBe(true);
    expect(zellijKillSession).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
  });

  it('still signals the tracked runner when recorded zellij terminal host cleanup fails', async () => {
    const { createStopSession } = await import('./stopSession');

    readTerminalAttachmentInfo.mockResolvedValueOnce({
      version: 1,
      sessionId: 'sess-zellij',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-123',
          paneId: 'terminal_1',
        },
      },
      updatedAt: 1,
    });
    resolveZellijRuntimeBinary.mockResolvedValueOnce('/tools/zellij');
    zellijKillSession.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'permission denied',
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, happySessionId: 'sess-zellij', processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-zellij');

    expect(ok).toBe(true);
    expect(zellijKillSession).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
  });

  it("kills the recorded tmux terminal host for a reattached terminal-hosted session", async () => {
    const { createStopSession } = await import("./stopSession");

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;

    readTerminalAttachmentInfo.mockResolvedValueOnce({
      version: 1,
      sessionId: "sess-tmux",
      terminal: {
        mode: "tmux",
        tmux: {
          target: "happy-reattached:window-1",
          tmpDir: "/tmp/happy-reattached-tmux",
        },
      },
      updatedAt: 1,
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: "terminal", pid: 333, happySessionId: "sess-tmux", processCommandHash: "h3" }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop("sess-tmux");

    expect(ok).toBe(true);
    expect(tmuxCtorCalls.length).toBe(1);
    expect(tmuxCtorCalls[0]?.env).toEqual({ TMUX_TMPDIR: "/tmp/happy-reattached-tmux" });
    expect(tmuxExecuteTmuxCommand).toHaveBeenCalled();
    const tmuxCall = tmuxExecuteTmuxCommand.mock.calls[0];
    expect(tmuxCall?.[0]).toEqual(["kill-session"]);
    expect(tmuxCall?.[1]).toBe("happy-reattached");
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(333, "SIGTERM");
  });

  it('stops daemon-spawned tmux sessions using a tmux socket derived from the tracked tmpDir', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;
    isPidSafeHappySessionProcess.mockResolvedValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const tmuxTmpDir = '/tmp/happy-e2e-tmux-test';
    const uid = typeof (process as any).getuid === 'function' ? ((process as any).getuid() as number) : null;
    const expectedSocketPath = uid === null ? undefined : `${tmuxTmpDir}/tmux-${uid}/default`;

    const pidToTrackedSession = new Map<number, any>([
      [
        444,
        {
          startedBy: 'daemon',
          pid: 444,
          happySessionId: 'sess-3',
          tmuxSessionId: 'happy-e2e:happy-window',
          tmuxTmpDir,
          processCommandHash: 'h4',
        },
      ],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-3');

    expect(ok).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();

    expect(tmuxCtorCalls.length).toBe(1);
    expect(tmuxCtorCalls[0]?.env).toEqual({ TMUX_TMPDIR: tmuxTmpDir });
    if (expectedSocketPath) {
      expect(tmuxCtorCalls[0]?.socketPath).toBe(expectedSocketPath);
    }
    expect(tmuxKillWindow).toHaveBeenCalledWith('happy-e2e:happy-window');
    expect(pidToTrackedSession.get(444)?.stopRequestedAtMs).toBe(123456789);

    nowSpy.mockRestore();
  });

  it('stops daemon-spawned isolated tmux sessions even before a window target is recorded', async () => {
    const { createStopSession } = await import('./stopSession');

    tmuxKillWindow.mockReset();
    tmuxExecuteTmuxCommand.mockReset();
    tmuxCtorCalls.length = 0;
    isPidSafeHappySessionProcess.mockResolvedValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);

    const tmuxTmpDir = '/tmp/happy-e2e-tmux-test';
    tmuxExecuteTmuxCommand.mockResolvedValueOnce({ returncode: 0, stdout: '', stderr: '', command: [] });

    const pidToTrackedSession = new Map<number, any>([
      [
        555,
        {
          startedBy: 'daemon',
          pid: 555,
          happySessionId: 'sess-4',
          tmuxSessionId: '',
          tmuxTmpDir,
          spawnOptions: {
            terminal: { mode: 'tmux', tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: tmuxTmpDir } },
          },
          processCommandHash: 'h5',
        },
      ],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-4');

    expect(ok).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(tmuxKillWindow).not.toHaveBeenCalled();
    expect(tmuxExecuteTmuxCommand).toHaveBeenCalled();
    const call = tmuxExecuteTmuxCommand.mock.calls[0];
    expect(call?.[0]).toEqual(['kill-session']);
    expect(call?.[1]).toBe('happy-e2e');
    expect(pidToTrackedSession.get(555)?.stopRequestedAtMs).toBe(123456789);

    nowSpy.mockRestore();
  });
});
