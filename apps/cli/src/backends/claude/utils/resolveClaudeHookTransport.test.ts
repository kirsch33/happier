import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import {
  resolveClaudeHookTransport,
  resolveClaudeHookTransportFromHelpText,
} from './resolveClaudeHookTransport';

function writeFakeClaudeBinary(dir: string, helpText: string): string {
  const isWindows = process.platform === 'win32';
  const fileName = isWindows ? 'claude.cmd' : 'claude';
  const contents = isWindows
    ? [
        '@echo off',
        'set args=%*',
        'echo %args% | findstr /c:"--help" >nul',
        'if %errorlevel%==0 (',
        ...helpText.split(/\r?\n/).map((line) => `  echo ${line}`),
        '  exit /b 0',
        ')',
        'exit /b 0',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--help" ]; then',
        '    cat <<\'EOF\'',
        helpText,
        'EOF',
        '    exit 0',
        '  fi',
        'done',
        'exit 0',
      ].join('\n');
  return writeExecutableShimSync({ dir, fileName, contents });
}

describe('resolveClaudeHookTransport', () => {
  const envKeys = ['HAPPIER_CLAUDE_PATH', 'PATH'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('uses plugin-dir transport when Claude help advertises --plugin-dir', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-hook-transport-'));
    const fakeClaude = writeFakeClaudeBinary(tempDir, '  --plugin-dir <path>  Load hooks from plugin dir');
    envScope.patch({ HAPPIER_CLAUDE_PATH: fakeClaude, PATH: '/usr/bin:/bin' });

    await expect(resolveClaudeHookTransport({ cwd: tempDir, timeoutMs: 1_500 })).resolves.toBe('plugin-dir');
  });

  it('falls back to settings transport when Claude help does not advertise --plugin-dir', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-hook-transport-'));
    const fakeClaude = writeFakeClaudeBinary(tempDir, 'Claude Code help without plugin dirs');
    envScope.patch({ HAPPIER_CLAUDE_PATH: fakeClaude, PATH: '/usr/bin:/bin' });

    await expect(resolveClaudeHookTransport({ cwd: tempDir, timeoutMs: 1_500 })).resolves.toBe('settings');
  });

  it('passes through cwd and timeout to the help probe', async () => {
    const probeCalls: Array<Readonly<{ cwd: string; timeoutMs: number }>> = [];
    const transport = await resolveClaudeHookTransport({
      cwd: '/workspace',
      timeoutMs: 1234,
      probeHelpText: async (params) => {
        probeCalls.push(params);
        return '  --plugin-dir <path>';
      },
    });

    expect(transport).toBe('plugin-dir');
    expect(probeCalls).toEqual([{ cwd: '/workspace', timeoutMs: 1234 }]);
  });

  it('falls back to settings if the help probe fails', async () => {
    await expect(resolveClaudeHookTransport({
      cwd: '/workspace',
      timeoutMs: 1234,
      probeHelpText: async () => {
        throw new Error('probe failed');
      },
    })).resolves.toBe('settings');
  });
});

describe('resolveClaudeHookTransportFromHelpText', () => {
  it('detects both spaced and equals plugin-dir flag forms', () => {
    expect(resolveClaudeHookTransportFromHelpText('  --plugin-dir <path>')).toBe('plugin-dir');
    expect(resolveClaudeHookTransportFromHelpText('  --plugin-dir=/tmp/plugin')).toBe('plugin-dir');
  });

  it('falls back to settings when plugin-dir is absent', () => {
    expect(resolveClaudeHookTransportFromHelpText('  --settings <file>')).toBe('settings');
    expect(resolveClaudeHookTransportFromHelpText(null)).toBe('settings');
  });
});
