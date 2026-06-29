import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { logger } from '@/ui/logger';
import { startHookServer } from './startHookServer';

async function postSessionHook(params: {
  port: number;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function postPermissionHook(params: {
  port: number;
  secret?: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${params.port}/hook/permission-request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.secret ? { 'x-happier-hook-secret': params.secret } : {}),
    },
    body: JSON.stringify(params.body),
  });
  return { status: res.status, text: await res.text() };
}

async function runPermissionForwarder(params: {
  port: number;
  hookEventName: string;
  secret: string;
  body: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), 'scripts', 'permission_hook_forwarder.cjs');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      scriptPath,
      String(params.port),
      params.hookEventName,
      params.secret,
    ], {
      cwd: join(process.cwd()),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(JSON.stringify(params.body));
  });
}

describe('startHookServer (session hook)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('routes PostToolUse session hooks through the generic session hook endpoint', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({
      onSessionHook,
    });
    servers.push(server);

    const res = await postSessionHook({
      port: server.port,
      body: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess_1',
        tool_use_id: 'toolu_1',
      },
    });

    expect(res).toEqual({ status: 200, text: 'ok' });
    expect(onSessionHook).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'toolu_1',
    }));
  });

  it('rejects oversized hook bodies with 413 instead of buffering them in memory', async () => {
    const onSessionHook = vi.fn();
    const server = await startHookServer({ onSessionHook });
    servers.push(server);

    const oversized = 'x'.repeat(11 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess_big', payload: oversized }),
    }).then(
      async (response) => ({ status: response.status, text: await response.text() }),
      // The server may also abort the socket mid-stream, which fetch reports as a network error.
      () => ({ status: 413, text: 'aborted' }),
    );

    expect(res.status).toBe(413);
    expect(onSessionHook).not.toHaveBeenCalled();

    // The server stays healthy for well-formed requests afterwards.
    const ok = await postSessionHook({ port: server.port, body: { session_id: 'sess_after', hook_event_name: 'PostToolUse' } });
    expect(ok).toEqual({ status: 200, text: 'ok' });
  });
});

describe('startHookServer (permission hook)', () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0, servers.length)) {
      server.stop();
    }
  });

  it('returns 403 when the secret header is missing or mismatched', async () => {
    const onPermissionHook = vi.fn(() => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest' as const,
        decision: { behavior: 'allow' as const },
      },
    }));

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-1',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      body: { tool_use_id: 'toolu_1', tool_name: 'Bash' },
    });

    expect(res.status).toBe(403);
    expect(onPermissionHook).not.toHaveBeenCalled();
  });

  it('times out permission hook requests using permissionRequestTimeoutMs', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const onPermissionHook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: { behavior: 'allow' as const },
        },
      };
    });

    try {
      const server = await startHookServer({
        onSessionHook: () => {},
        onPermissionHook,
        permissionHookSecret: 'secret-2',
        permissionRequestTimeoutMs: 20,
      });
      servers.push(server);

      const res = await postPermissionHook({
        port: server.port,
        secret: 'secret-2',
        body: { tool_use_id: 'toolu_2', tool_name: 'Bash' },
      });

      expect(res.status).toBe(408);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(debugSpy.mock.calls.some((call) => String(call[0]).includes('Error handling permission hook'))).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('returns the onPermissionHook response when it completes before timeout', async () => {
    const onPermissionHook = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: { behavior: 'deny' as const },
        },
      };
    });

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-3',
    });
    servers.push(server);

    const res = await postPermissionHook({
      port: server.port,
      secret: 'secret-3',
      body: { tool_use_id: 'toolu_3', tool_name: 'Write' },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as any;
    expect(parsed.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(onPermissionHook).toHaveBeenCalledTimes(1);
  });

  it('forwards PreToolUse hook requests with the hook event name preserved', async () => {
    const onPermissionHook = vi.fn(() => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        updatedInput: {
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    }));

    const server = await startHookServer({
      onSessionHook: () => {},
      onPermissionHook,
      permissionHookSecret: 'secret-pre-tool-use',
    });
    servers.push(server);

    const result = await runPermissionForwarder({
      port: server.port,
      hookEventName: 'PreToolUse',
      secret: 'secret-pre-tool-use',
      body: {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [] },
        tool_use_id: 'toolu_ask_pre_forwarder_1',
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(onPermissionHook).toHaveBeenCalledWith(expect.objectContaining({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_ask_pre_forwarder_1',
    }));
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          answers: { 'Remove the scratch files?': 'Keep for inspection' },
        },
      },
    });
  });
});
