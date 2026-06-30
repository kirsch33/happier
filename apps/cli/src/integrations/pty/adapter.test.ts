import { describe, expect, it } from 'vitest';

import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from '@/integrations/pty/ptyProvider';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '../terminalHost/controlTypes';
import { createPtyTerminalHostAdapter } from './adapter';
import { createVirtualTerminalScreen } from './virtualTerminalScreen';

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(private readonly onWrite?: ((process: FakePtyProcess, data: string) => void) | undefined) {}

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(this, data);
  }

  resize(): void {}

  kill(): void {
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

function createFakeProvider() {
  const processes: FakePtyProcess[] = [];
  const spawnCalls: PtySpawnParams[] = [];
  const provider: PtyProvider = {
    spawn: (params) => {
      spawnCalls.push(params);
      const process = new FakePtyProcess();
      processes.push(process);
      return process;
    },
  };
  return { provider, processes, spawnCalls };
}

function createFakeProviderWithProcess(factory: () => FakePtyProcess) {
  const processes: FakePtyProcess[] = [];
  const spawnCalls: PtySpawnParams[] = [];
  const provider: PtyProvider = {
    spawn: (params) => {
      spawnCalls.push(params);
      const process = factory();
      processes.push(process);
      return process;
    },
  };
  return { provider, processes, spawnCalls };
}

describe('createVirtualTerminalScreen', () => {
  it('tracks clear-screen and cursor-position terminal writes', () => {
    const screen = createVirtualTerminalScreen({ cols: 20, rows: 4 });

    screen.write('old line');
    screen.write('\u001b[2J\u001b[H> ready');
    screen.write('\u001b[2;3Hbox');

    expect(screen.capture()).toBe('> ready\n  box');
  });
});

describe('createPtyTerminalHostAdapter', () => {
  it('spawns a PTY process and captures the virtual terminal screen', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      cols: 80,
      rows: 4,
      inputStabilityDelayMs: 0,
      now: () => 123,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe', 'runner.cjs', 'launch.json'],
      spawnEnv: { HAPPIER_SECRET: 'secret', TERM: 'xterm-256color' },
      isolatedEnv: true,
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[HWhat would you like to work on?\r\n> ');

    expect(handle).toMatchObject({
      kind: 'windows_console',
      sessionName: 'happier-claude-windows',
      paneId: 'happier-claude-windows',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        requiresLocalAttachmentInfo: false,
      },
    });
    expect(fake.spawnCalls[0]).toMatchObject({
      file: 'node.exe',
      args: ['runner.cjs', 'launch.json'],
      options: {
        cwd: 'C:\\repo',
        cols: 80,
        rows: 4,
      },
    });
    expect(fake.spawnCalls[0]?.options.env?.HAPPIER_SECRET).toBe('secret');
    await expect(adapter.captureInputState?.(handle)).resolves.toMatchObject({
      stable: true,
      currentInput: 'What would you like to work on?\n>',
      observedAt: 123,
    });
    await expect(adapter.createControlPort?.(handle)?.captureScreen()).resolves.toMatchObject({
      status: 'captured',
      capture: {
        text: 'What would you like to work on?\n>',
        hostKind: 'windows_console',
      },
    });
  });

  it('injects prompts and terminal control keys through the PTY', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      now: () => 456,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    const result = await adapter.injectUserPrompt(handle, {
      text: 'line one\nline two',
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'n1' },
      scheduling: {},
    });
    const port = adapter.createControlPort?.(handle);
    await port?.sendSpecialKey('ShiftTab');
    await port?.sendSpecialKey('CtrlJ');
    await port?.sendSpecialKey('CtrlU');
    await port?.sendSpecialKey('CtrlC');

    expect(result).toEqual({ status: 'injected', at: 456, bytesWritten: 17 });
    expect(fake.processes[0]?.writes).toEqual([
      'line one\nline two\r',
      TERMINAL_SHIFT_TAB_SEQUENCE,
      '\n',
      '\u0015',
      '\u0003',
    ]);
  });

  it('reports pane death after the PTY exits', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({ ptyProvider: fake.provider });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    fake.processes[0]?.emitExit({ exitCode: 9 });

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneExitStatus: 9,
    });
    await expect(adapter.injectUserPrompt(handle, {
      text: 'hello',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n2' },
      scheduling: {},
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'pane_dead',
      recoverable: false,
    });
  });

  it('does not report a prompt as injected when the PTY closes immediately after the write', async () => {
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process) => {
      queueMicrotask(() => process.emitExit({ exitCode: 1 }));
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(handle, {
      text: 'hello',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n3' },
      scheduling: {},
    })).resolves.toEqual({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
    });
  });
});
