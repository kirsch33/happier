import { describe, expect, it } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /session/resume-fresh', () => {
  it('requires daemon auth and forwards an optional recovery message with the exact session id', async () => {
    const resumeFreshProviderContext = async ({ sessionId, message }: { sessionId: string; message?: string }) => ({
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
        payload: { sessionId: 'sess_exact_123', message: 'Start fresh from this recovery instruction.' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        sessionId: 'sess_exact_123',
        providerSessionId: 'thread_new',
      });
      const existingPendingResponse = await app.inject({
        method: 'POST',
        url: '/session/resume-fresh',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: 'sess_exact_123' },
      });
      expect(existingPendingResponse.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each([
    'reservation_claim_mismatch',
    'reservation_missing',
    'reservation_corrupt',
    'pending_shape_mismatch',
    'seed_admission_unconfirmed',
    'post_seed_snapshot_drift',
  ])('preserves the exact %s failure code through the authenticated control response', async (errorCode) => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine_local', stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), requestShutdown: () => {},
      onHappySessionWebhook: () => {}, controlToken: 'test-token',
      resumeFreshProviderContext: async () => ({ ok: false as const, errorCode, errorMessage: `failed: ${errorCode}` }),
    } as any);
    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST', url: '/session/resume-fresh', headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: 'sess_exact_123' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, errorCode, errorMessage: `failed: ${errorCode}` });
    } finally {
      await app.close();
    }
  });
});
