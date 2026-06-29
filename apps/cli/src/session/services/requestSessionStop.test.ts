import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSessionIdOrPrefix: vi.fn(),
  stopDaemonSession: vi.fn(),
  listSessionMarkers: vi.fn(),
  removeSessionMarker: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  deliverSessionEndMutation: vi.fn(),
  createStopSession: vi.fn(),
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix: mocks.resolveSessionIdOrPrefix,
}));
vi.mock('@/daemon/controlClient', () => ({
  stopDaemonSession: mocks.stopDaemonSession,
}));
vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: mocks.listSessionMarkers,
  removeSessionMarker: mocks.removeSessionMarker,
}));
vi.mock('@/daemon/sessions/stopSession', () => ({
  createStopSession: mocks.createStopSession,
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));
vi.mock('@/api/session/mutations/deliverSessionEndMutation', () => ({
  deliverSessionEndMutation: mocks.deliverSessionEndMutation,
}));
vi.mock('@/session/transport/shared/sessionTimeouts', () => ({
  resolveSessionControlStopTimeoutMs: () => 5,
  resolveSessionControlStopPollIntervalMs: () => 1,
}));
vi.mock('@/utils/time', () => ({
  delay: vi.fn(async () => undefined),
}));

describe('requestSessionStop', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('delivers a session-end mutation when no local runner exists but the relay still reports active', async () => {
    let active = true;
    mocks.resolveSessionIdOrPrefix.mockResolvedValue({ ok: true, sessionId: 'sess-stale-active' });
    mocks.stopDaemonSession.mockResolvedValue(false);
    mocks.listSessionMarkers.mockResolvedValue([]);
    mocks.fetchSessionByIdCompat.mockImplementation(async () => ({ id: 'sess-stale-active', active }));
    mocks.deliverSessionEndMutation.mockImplementation(async () => {
      active = false;
      return { status: 'delivered', path: 'http' };
    });

    const { requestSessionStop } = await import('./requestSessionStop');
    const result = await requestSessionStop({
      credentials: { token: 'token-test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: 'sess-stale-active',
    });

    expect(result).toEqual({ ok: true, sessionId: 'sess-stale-active', stopped: true });
    expect(mocks.stopDaemonSession).toHaveBeenCalledWith('sess-stale-active');
    expect(mocks.listSessionMarkers).toHaveBeenCalled();
    expect(mocks.deliverSessionEndMutation).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-test',
      mutation: expect.objectContaining({
        sessionId: 'sess-stale-active',
        source: 'session_end',
      }),
    }));
    expect(mocks.fetchSessionByIdCompat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
