import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';

import { activatePendingInactiveSession } from './activatePendingInactiveSession';

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  listPendingQueueV2LocalIdsFromServer: vi.fn(),
}));

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};

describe('activatePendingInactiveSession', () => {
  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset();
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockReset();
  });

  it('starts the exact inactive session from durable Pending custody without any UI process', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
      runnerAcceptance: 'newly_accepted' as const,
      pid: 321,
    }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated', runnerAcceptance: 'newly_accepted', pid: 321 });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      initialTranscriptAfterSeq: 12,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'pending-after-ui-death',
      },
    }));
  });

  it('does not start an active runner or a session whose exact Pending authorization resolved', async () => {
    const baseSession = {
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    };
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(baseSession);
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'active' });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...baseSession, active: false });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['different-pending']);
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'pending-resolved' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('requires the optional resume-fresh Pending snapshot to remain exactly one matching request', async () => {
    const baseSession = {
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...baseSession, pendingVersion: 10 });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death', 'other-pending']);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      expectedPendingSnapshot: { pendingVersion: 9, requestId: 'pending-after-ui-death' },
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'snapshot-stale' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects a concurrent archive at the strict resume-fresh second fetch', async () => {
    const archivedSession = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      archivedAt: 2,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 9,
      dataEncryptionKey: null, machineId: 'machine-1', path: '/repo',
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(archivedSession);
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      expectedPendingSnapshot: { pendingVersion: 9, requestId: 'pending-after-ui-death' },
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'snapshot-stale' });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps ordinary inactive-Pending activation permissive when no strict snapshot is requested', async () => {
    const session = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 2, pendingVersion: 10,
      dataEncryptionKey: null, machineId: 'machine-1', path: '/repo',
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(session);
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death', 'other-pending']);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated' });
    expect(spawnSession).toHaveBeenCalledOnce();
  });

  it('rejects a Pending activation owned by a different exact machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'identity-unavailable' });

    expect(spawnSession).not.toHaveBeenCalled();
  });
});
