import { describe, expect, it } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /session/resume-fresh', () => {
  it('requires daemon auth and accepts only the exact session id body', async () => {
    const resumeFreshProviderContext = async ({ sessionId }: { sessionId: string }) => ({
      ok: true as const,
      sessionId,
      providerSessionId: 'thread_new',
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      resumeFreshProviderContext,
    } as any);
    try {
      await app.ready();
      await expect(app.inject({
        method: 'POST',
        url: '/session/resume-fresh',
        payload: { sessionId: 'sess_exact_123' },
      })).resolves.toMatchObject({ statusCode: 401 });
      const response = await app.inject({
        method: 'POST',
        url: '/session/resume-fresh',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: 'sess_exact_123' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        sessionId: 'sess_exact_123',
        providerSessionId: 'thread_new',
      });
    } finally {
      await app.close();
    }
  });
});
