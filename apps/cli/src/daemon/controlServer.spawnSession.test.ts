import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorDetail } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_DETAIL_KINDS } from '@happier-dev/protocol';

describe('daemon control server: /spawn-session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a control token at startup', () => {
    expect(() => createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: '' as any,
    })).toThrow(/control token/i);
  });

  it('rejects requests without the control token', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('passes canonical daemon spawn fields through to spawnSession and preserves fresh sessionId', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          sessionId: 'explicit-session',
          spawnNonce: 'spawn-nonce-1',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          profileId: 'profile-greatwhite',
          experimentalCodexAcp: true,
          transcriptStorage: 'direct',
          mcpSelection: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: ['server-disabled'],
          },
          terminal: {
            mode: 'tmux',
            tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: '/tmp/happy-tmux' },
          },
          environmentVariables: {
            FOO: 'bar',
            IS_SANDBOX: '1',
            TMUX_SESSION_NAME: 'legacy-ignored',
          },
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', profileId: 'work' },
            },
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        success: true,
        sessionId: 'happy-test-123',
        approvedNewDirectoryCreation: true,
      });

      expect(observed).toEqual({
        directory: '/tmp',
        sessionId: 'explicit-session',
        spawnNonce: 'spawn-nonce-1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        profileId: 'profile-greatwhite',
        codexBackendMode: 'acp',
        transcriptStorage: 'direct',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['server-portable'],
          forceExcludeServerIds: ['server-disabled'],
        },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: '/tmp/happy-tmux' },
        },
        environmentVariables: {
          FOO: 'bar',
          IS_SANDBOX: '1',
          TMUX_SESSION_NAME: 'legacy-ignored',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', profileId: 'work' },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('prefers explicit existingSessionId for attach spawns', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          sessionId: 'fresh-session-id',
          existingSessionId: 'existing-session-id',
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(observed).toEqual({
        directory: '/tmp',
        existingSessionId: 'existing-session-id',
      });
    } finally {
      await app.close();
    }
  });

  it('expands ~/ in session directories before forwarding control-server spawn requests', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = '/Users/tester';
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '~/Documents',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(observed).toEqual({
        directory: '/Users/tester/Documents',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await app.close();
    }
  });

  it('returns a structured 500 when spawnSession throws', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => {
        throw new Error('boom');
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        success: false,
        error: 'Failed to spawn session: boom',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      });
    } finally {
      await app.close();
    }
  });

  it('preserves structured connected-service spawn error details on /spawn-session errors', async () => {
    const errorDetail: SpawnSessionErrorDetail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: {
        code: 'connected_service_materialization_identity_missing',
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
        },
      },
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_materialization_identity_missing',
        errorDetail,
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        success: false,
        error: 'connected_service_materialization_identity_missing',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorDetail,
      });
    } finally {
      await app.close();
    }
  });

  it('resolves spawn nonce to a canonical session id when the tracked session is ready', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [
        {
          startedBy: 'daemon',
          pid: 123,
          happySessionId: 'sess-ready',
          spawnOptions: { directory: '/tmp', spawnNonce: 'nonce-1' },
        } as any,
      ],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-1' }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-ready',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps deterministic spawn nonce correlation after spawn response even when tracked children are gone', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-from-response' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          spawnNonce: 'nonce-durable-from-response',
        }),
      });
      expect(spawnRes.statusCode).toBe(200);
      expect(spawnRes.json()).toEqual({
        success: true,
        sessionId: 'sess-from-response',
        approvedNewDirectoryCreation: true,
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-durable-from-response' }),
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-from-response',
      });
    } finally {
      await app.close();
    }
  });

  it('returns cached spawn nonce success without starting another session', async () => {
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-original' })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-duplicate' });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const firstRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/one',
          spawnNonce: 'nonce-cached-success',
        }),
      });
      expect(firstRes.statusCode).toBe(200);
      expect(firstRes.json()).toEqual({
        success: true,
        sessionId: 'sess-original',
        approvedNewDirectoryCreation: true,
      });

      const secondRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/two',
          spawnNonce: 'nonce-cached-success',
        }),
      });
      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json()).toEqual({
        success: true,
        sessionId: 'sess-original',
        approvedNewDirectoryCreation: true,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns pending for duplicate in-flight spawn nonce without starting another session', async () => {
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const resolvers: Array<() => void> = [];
    const spawnSession = vi.fn(async () => {
      resolveStarted?.();
      return await new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
        resolvers.push(() => resolve({ type: 'success', sessionId: 'sess-in-flight' }));
      });
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const firstSpawn = app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/one',
          spawnNonce: 'nonce-in-flight',
        }),
      });
      await started;

      const duplicateSpawn = app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/two',
          spawnNonce: 'nonce-in-flight',
        }),
      });
      const duplicateResult = await Promise.race([
        duplicateSpawn,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 25)),
      ]);
      expect(duplicateResult).not.toBe('timed-out');
      if (duplicateResult === 'timed-out') throw new Error('duplicate spawn timed out');
      expect(duplicateResult.statusCode).toBe(202);
      expect(duplicateResult.json()).toEqual({
        success: false,
        status: 'pending',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);

      for (const resolve of resolvers) resolve();
      const firstResult = await firstSpawn;
      expect(firstResult.statusCode).toBe(200);
    } finally {
      for (const resolve of resolvers) resolve();
      await app.close();
    }
  });

  it('clears a pending spawn nonce when spawn reports success without a session id', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: '' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          spawnNonce: 'nonce-missing-session-id',
        }),
      });
      expect(spawnRes.statusCode).toBe(500);

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-missing-session-id' }),
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json()).toEqual({
        success: true,
        status: 'not_found',
      });
    } finally {
      await app.close();
    }
  });

  it('returns pending/not_found states for spawn nonce lookup when webhook is incomplete or absent', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [
        {
          startedBy: 'daemon',
          pid: 321,
          happySessionId: 'PID-321',
          spawnOptions: { directory: '/tmp', spawnNonce: 'nonce-pending' },
        } as any,
      ],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const pendingRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-pending' }),
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json()).toEqual({
        success: true,
        status: 'pending',
      });

      const missingRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-missing' }),
      });
      expect(missingRes.statusCode).toBe(200);
      expect(missingRes.json()).toEqual({
        success: true,
        status: 'not_found',
      });
    } finally {
      await app.close();
    }
  });

  it('does not pass unknown agent ids through to spawnSession', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'unknown-agent' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(observed).toBeNull();
    } finally {
      await app.close();
    }
  });
});
