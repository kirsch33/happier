import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  fetch: vi.fn(),
  listPending: vi.fn(),
  promotePending: vi.fn(),
  decrypt: vi.fn(),
  build: vi.fn(),
  send: vi.fn(),
  inferAgentId: vi.fn(),
  resolveVendorResumeId: vi.fn(),
}));

vi.mock('./activatePendingInactiveSession', () => ({
  activatePendingInactiveSession: mocks.activate,
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetch,
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  listPendingQueueV2LocalIdsFromServer: mocks.listPending,
  updatePendingQueueV2RequestedActionViaHttp: mocks.promotePending,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: mocks.decrypt,
}));
vi.mock('@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions', () => ({
  buildInactiveSessionResumeSpawnOptions: mocks.build,
}));
vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage: mocks.send,
}));
vi.mock('@happier-dev/agents', () => ({
  inferAgentIdFromSessionMetadata: mocks.inferAgentId,
  resolveVendorResumeIdFromSessionMetadata: mocks.resolveVendorResumeId,
}));

import { awaitFreshProviderCompletion, resumeFreshProviderContext } from './resumeFreshProviderContext';
import { createFreshProviderRecoveryReservationStore } from './freshProviderRecoveryReservation';

const reservationDirs: string[] = [];
afterEach(async () => await Promise.all(reservationDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }))));

function reservationToken(sub: string, jti: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub, jti })).toString('base64url'),
    'signature',
  ].join('.');
}

describe('resumeFreshProviderContext', () => {
  const credentials = { token: 'token' } as any;
  const rawSession = {
    id: 'sess_exact_123',
    archivedAt: null,
    active: false,
    pendingCount: 1,
    pendingVersion: 7,
    seq: 12,
  };
  const spawnOptions = {
    existingSessionId: 'sess_exact_123',
    machineId: 'machine_local',
    resume: 'provider_old',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetch.mockResolvedValue(rawSession);
    mocks.listPending.mockResolvedValue(['pending_exact']);
    mocks.promotePending.mockResolvedValue({ ok: true });
    mocks.decrypt.mockReturnValue({ metadata: 'decrypted' });
    mocks.build.mockReturnValue(spawnOptions);
    mocks.inferAgentId.mockReturnValue('codex');
    mocks.resolveVendorResumeId.mockReturnValue('provider_old');
    mocks.activate.mockResolvedValue({ status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 });
    mocks.send.mockResolvedValue({ ok: true, sessionId: 'sess_exact_123', localId: 'pending_seed', waited: false });
  });

  function validParams(overrides: Record<string, unknown> = {}) {
    return {
      credentials,
      machineId: 'machine_local',
      sessionId: 'sess_exact_123',
      reservation: {
        prepareAdmission: vi.fn(async () => ({ ok: true, localId: 'pending_seed' })),
        claim: vi.fn(async () => ({ ok: true })),
        clearProven: vi.fn(async () => ({ ok: true })),
      },
      probeSessionRunnerServiceability: async () => ({ state: 'runner_absent' }),
      spawnSession: vi.fn(async () => ({
        type: 'success' as const,
        sessionId: 'sess_exact_123',
        runnerAcceptance: 'newly_accepted' as const,
      })),
      awaitCompletion: vi.fn(async () => 'provider_new'),
      ...overrides,
    } as any;
  }

  it('refuses a servable existing runner before activating Pending custody', async () => {
    const params = validParams({
      probeSessionRunnerServiceability: async () => ({ state: 'runner_present', control: { state: 'servable' } }),
    });
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({
      ok: false,
      errorCode: 'runner_not_absent',
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each(['runner_present', 'runner_unknown', 'runner_terminating'])('does not mutate %s runner state', async (state) => {
    const params = validParams({ probeSessionRunnerServiceability: async () => ({ state }) });
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'runner_not_absent' });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('activates the exact Pending version through the existing owner before proving the complete fresh-provider transition', async () => {
    const params = validParams();
    await expect(resumeFreshProviderContext(params)).resolves.toEqual({
      ok: true,
      sessionId: 'sess_exact_123',
      providerSessionId: 'provider_new',
    });
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      machineId: 'machine_local',
      sessionId: 'sess_exact_123',
      requestId: 'pending_exact',
      pendingVersion: 7,
      expectedPendingSnapshot: { pendingVersion: 7, requestId: 'pending_exact' },
    }));
    expect(mocks.promotePending).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'sess_exact_123',
      localId: 'pending_exact',
      requestedAction: { v: 1, kind: 'send_now' },
    });
    expect(params.awaitCompletion).toHaveBeenCalledWith({
      sessionId: 'sess_exact_123',
      requestId: 'pending_exact',
      previousProviderId: 'provider_old',
      pid: 777,
    });
  });

  it('carries the durable paused primary goal into the fresh provider context', async () => {
    mocks.decrypt.mockReturnValue({
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 10,
        primaryItemId: 'goal:provider_old',
        items: [{
          id: 'goal:provider_old',
          kind: 'goal',
          origin: 'vendor',
          status: 'paused',
          title: 'Complete the durable platform goal.',
          tokenBudget: null,
          updatedAt: 10,
        }],
      },
    });
    mocks.activate.mockImplementationOnce(async (input: any) => {
      await input.spawnSession(spawnOptions);
      return { status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 };
    });
    const params = validParams();

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: true });

    expect(params.spawnSession).toHaveBeenCalledWith({
      existingSessionId: 'sess_exact_123',
      machineId: 'machine_local',
      freshProviderContextOnce: true,
      initialGoal: {
        objective: 'Complete the durable platform goal.',
        status: 'paused',
        tokenBudget: null,
      },
    });
  });

  it.each(['blocked', 'usageLimited', 'budgetLimited'] as const)(
    'restores a durable blocked primary goal paused while preserving its %s reason',
    async (statusReason) => {
      mocks.decrypt.mockReturnValue({
        sessionWorkStateV1: {
          v: 1,
          backendId: 'codex',
          updatedAt: 10,
          primaryItemId: 'goal:provider_old',
          items: [{
            id: 'goal:provider_old',
            kind: 'goal',
            origin: 'vendor',
            status: 'blocked',
            statusReason,
            title: 'Recover the blocked durable goal safely.',
            updatedAt: 10,
          }],
        },
      });
      mocks.activate.mockImplementationOnce(async (input: any) => {
        await input.spawnSession(spawnOptions);
        return { status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 };
      });
      const params = validParams();

      await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: true });

      expect(params.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        initialGoal: {
          objective: 'Recover the blocked durable goal safely.',
          status: 'paused',
          statusReason,
        },
      }));
    },
  );

  it('does not revive a non-primary historical goal when another work item is primary', async () => {
    mocks.decrypt.mockReturnValue({
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 11,
        primaryItemId: 'todo:current',
        items: [
          {
            id: 'goal:historical',
            kind: 'goal',
            origin: 'vendor',
            status: 'paused',
            title: 'Do not revive this historical goal.',
            updatedAt: 10,
          },
          {
            id: 'todo:current',
            kind: 'todo',
            origin: 'vendor',
            status: 'active',
            title: 'Current provider work.',
            updatedAt: 11,
          },
        ],
      },
    });
    mocks.activate.mockImplementationOnce(async (input: any) => {
      await input.spawnSession(spawnOptions);
      return { status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 };
    });
    const params = validParams();

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: true });

    expect(params.spawnSession).toHaveBeenCalledWith({
      existingSessionId: 'sess_exact_123',
      machineId: 'machine_local',
      freshProviderContextOnce: true,
    });
  });

  it('requires a matching durable reservation claim before it can activate the exact Pending row', async () => {
    const params = validParams({
      reservation: { claim: vi.fn(async () => ({ ok: false, code: 'reservation_claim_mismatch' })), clearProven: vi.fn(async () => ({ ok: true })) },
    });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'reservation_claim_mismatch' });

    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('retains the reservation when provider completion succeeds but durable clear proof fails', async () => {
    const clearProven = vi.fn(async () => ({ ok: false }));
    const params = validParams({
      reservation: { claim: vi.fn(async () => ({ ok: true })), clearProven },
    });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'completion_unproven' });

    expect(clearProven).toHaveBeenCalledWith('sess_exact_123', 'pending_exact', 7);
  });

  it('seeds exactly one queue-only Pending instruction before fresh activation when the exact inactive session has none', async () => {
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    const seededPending = { ...rawSession, pendingCount: 1, pendingVersion: 7 };
    mocks.fetch.mockResolvedValueOnce(zeroPending).mockResolvedValueOnce(seededPending);
    mocks.listPending.mockResolvedValueOnce([]).mockResolvedValueOnce(['pending_seed']);
    const params = validParams({ message: 'Start fresh from this recovery instruction.' });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: true });

    expect(mocks.send).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_exact_123',
      message: 'Start fresh from this recovery instruction.',
      wait: false,
      timeoutMs: 5_000,
      requestedAction: { v: 1, kind: 'send_now' },
      resumeInactiveSession: false,
      localId: 'pending_seed',
    });
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'pending_seed',
      pendingVersion: 7,
      expectedPendingSnapshot: { pendingVersion: 7, requestId: 'pending_seed' },
    }));
    expect(mocks.promotePending).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('does not activate when an existing Pending request cannot be promoted to durable send-now authority', async () => {
    mocks.promotePending.mockRejectedValueOnce(new Error('action-conflict'));
    const params = validParams();

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({
      ok: false,
      errorCode: 'pending_action_promotion_failed',
    });

    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    { raw: { ...rawSession, pendingCount: 0, pendingVersion: 6 }, pendingIds: [], message: undefined },
    { raw: { ...rawSession, pendingCount: 2 }, pendingIds: ['pending_exact', 'pending_other'], message: 'Start fresh.' },
  ])('rejects unsafe zero-or-many Pending recovery without admission or spawn', async ({ raw, pendingIds, message }) => {
    mocks.fetch.mockResolvedValue(raw);
    mocks.listPending.mockResolvedValue(pendingIds);
    const params = validParams({ message });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'admission is unconfirmed',
      send: { ok: false, code: 'timeout' },
      postSeedIds: ['pending_seed'],
    },
    {
      label: 'the re-fetched durable Pending row differs from the seeded local id',
      send: { ok: true, sessionId: 'sess_exact_123', localId: 'pending_seed', waited: false },
      postSeedIds: ['pending_other'],
    },
  ])('fails closed when $label', async ({ send, postSeedIds }) => {
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    const seededPending = { ...rawSession, pendingCount: 1, pendingVersion: 7 };
    mocks.fetch.mockResolvedValueOnce(zeroPending).mockResolvedValueOnce(seededPending);
    mocks.listPending.mockResolvedValueOnce([]).mockResolvedValueOnce(postSeedIds);
    mocks.send.mockResolvedValue(send);
    const params = validParams({ message: 'Start fresh from this recovery instruction.' });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({
      ok: false,
      errorCode: send.ok ? 'post_seed_snapshot_drift' : 'seed_admission_unconfirmed',
    });

    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('refuses an unarmed zero-Pending recovery before it can admit or spawn work', async () => {
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    mocks.fetch.mockResolvedValue(zeroPending);
    mocks.listPending.mockResolvedValue([]);
    const params = validParams({
      message: 'Start fresh from this recovery instruction.',
      reservation: {
        prepareAdmission: vi.fn(async () => ({ ok: false, code: 'reservation_missing' })),
        claim: vi.fn(async () => ({ ok: true })),
        clearProven: vi.fn(async () => ({ ok: true })),
      },
    });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'reservation_missing' });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('reuses one durable admission id across concurrent zero-Pending recovery and a reload retry, admitting one row and accepting at most one fresh spawn', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-context-'));
    reservationDirs.push(homeDir);
    const token = reservationToken('account-a', 'issued-one');
    const reservation = createFreshProviderRecoveryReservationStore({ happyHomeDir: homeDir, serverId: 'server-a', token });
    await reservation.arm('sess_exact_123');
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    const seededPending = { ...rawSession, pendingCount: 1, pendingVersion: 7 };
    const serverRows = new Set<string>();
    let admitted = false;
    let acceptedSpawns = 0;
    mocks.fetch.mockImplementation(async () => admitted ? seededPending : zeroPending);
    mocks.listPending.mockImplementation(async () => admitted ? [...serverRows] : []);
    mocks.send.mockImplementation(async (input: { localId: string }) => {
      serverRows.add(input.localId);
      admitted = true;
      return { ok: true, sessionId: 'sess_exact_123', localId: input.localId, waited: false };
    });
    mocks.activate.mockImplementation(async () => {
      acceptedSpawns += 1;
      return acceptedSpawns === 1
        ? { status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 }
        : { status: 'rejected', reason: 'already_active' };
    });
    const first = validParams({ message: 'Start fresh from this recovery instruction.', reservation });
    const second = validParams({ message: 'Start fresh from this recovery instruction.', reservation });

    const concurrent = await Promise.all([resumeFreshProviderContext(first), resumeFreshProviderContext(second)]);
    expect(serverRows.size).toBe(1);
    expect(new Set(mocks.send.mock.calls.map(([input]) => input.localId))).toEqual(serverRows);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);

    const reloaded = createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir,
      serverId: 'server-a',
      token: reservationToken('account-a', 'issued-two'),
    });
    const retry = validParams({ message: 'Start fresh from this recovery instruction.', reservation: reloaded });
    await expect(resumeFreshProviderContext(retry)).resolves.toMatchObject({ ok: false });
    expect(serverRows.size).toBe(1);
  });

  it('retains a durably seeded but unconfirmed admission across reload and retries with the same local id without another row', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-context-retry-'));
    reservationDirs.push(homeDir);
    const token = reservationToken('account-a', 'issued-one');
    const reservation = createFreshProviderRecoveryReservationStore({ happyHomeDir: homeDir, serverId: 'server-a', token });
    await reservation.arm('sess_exact_123');
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    const seededPending = { ...rawSession, pendingCount: 1, pendingVersion: 7 };
    const serverRows = new Set<string>();
    const sentLocalIds: string[] = [];
    let visiblePending = false;
    mocks.fetch.mockImplementation(async () => visiblePending ? seededPending : zeroPending);
    mocks.listPending.mockImplementation(async () => visiblePending ? [...serverRows] : []);
    mocks.send.mockImplementation(async (input: { localId: string }) => {
      sentLocalIds.push(input.localId);
      serverRows.add(input.localId);
      if (sentLocalIds.length === 1) return { ok: false, code: 'timeout' };
      visiblePending = true;
      return { ok: true, sessionId: 'sess_exact_123', localId: input.localId, waited: false };
    });
    const first = validParams({ message: 'Start fresh from this recovery instruction.', reservation });

    await expect(resumeFreshProviderContext(first)).resolves.toMatchObject({ ok: false });
    const reloaded = createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir,
      serverId: 'server-a',
      token: reservationToken('account-a', 'issued-two'),
    });
    const retry = validParams({ message: 'Start fresh from this recovery instruction.', reservation: reloaded });
    await expect(resumeFreshProviderContext(retry)).resolves.toMatchObject({ ok: true });

    expect(new Set(sentLocalIds).size).toBe(1);
    expect(serverRows.size).toBe(1);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });

  it('refuses a different sole Pending row after reloading a persisted admission id without send, activation, or spawn', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-context-wrong-row-'));
    reservationDirs.push(homeDir);
    const reservation = createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir, serverId: 'server-a', token: reservationToken('account-a', 'issued-one'),
    });
    await reservation.arm('sess_exact_123');
    await reservation.prepareAdmission('sess_exact_123');
    const reloaded = createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir, serverId: 'server-a', token: reservationToken('account-a', 'issued-two'),
    });
    mocks.listPending.mockResolvedValue(['pending-different']);
    const params = validParams({ reservation: reloaded });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({
      ok: false, errorCode: 'reservation_claim_mismatch',
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed persisted admission id before any zero-Pending send or activation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-context-corrupt-admission-'));
    reservationDirs.push(homeDir);
    const reservation = createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir, serverId: 'server-a', token: reservationToken('account-a', 'issued-one'),
    });
    await reservation.arm('sess_exact_123');
    const path = reservation.filePathFor('sess_exact_123');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...persisted, admissionLocalId: ['not-a-string'] }), { mode: 0o600 });
    mocks.fetch.mockResolvedValue({ ...rawSession, pendingCount: 0, pendingVersion: 6 });
    mocks.listPending.mockResolvedValue([]);
    const params = validParams({ message: 'Start fresh from this recovery instruction.', reservation });

    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'reservation_corrupt' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it('does not enqueue a second recovery row when a retry sees the durable seeded Pending row', async () => {
    const zeroPending = { ...rawSession, pendingCount: 0, pendingVersion: 6 };
    const seededPending = { ...rawSession, pendingCount: 1, pendingVersion: 7 };
    mocks.fetch
      .mockResolvedValueOnce(zeroPending)
      .mockResolvedValueOnce(seededPending)
      .mockResolvedValueOnce(seededPending);
    mocks.listPending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['pending_seed'])
      .mockResolvedValueOnce(['pending_seed']);
    const first = validParams({ message: 'Start fresh from this recovery instruction.' });
    const retry = validParams({
      message: 'Start fresh from this recovery instruction.',
      probeSessionRunnerServiceability: async () => ({ state: 'runner_present' }),
    });

    await expect(resumeFreshProviderContext(first)).resolves.toMatchObject({ ok: true });
    await expect(resumeFreshProviderContext(retry)).resolves.toMatchObject({ ok: false, errorCode: 'runner_not_absent' });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { raw: null, expected: 'session_not_inactive' },
    { raw: { ...rawSession, archivedAt: '2026-08-21' }, expected: 'session_not_inactive' },
    { raw: { ...rawSession, active: true }, expected: 'session_not_inactive' },
    { raw: { ...rawSession, pendingCount: 2 }, expected: 'pending_shape_mismatch' },
    { raw: { ...rawSession, pendingVersion: undefined }, expected: 'pending_shape_mismatch' },
  ])('rejects inactive/Pending preflight failure $expected without mutation', async ({ raw, expected }) => {
    mocks.fetch.mockResolvedValue(raw);
    const params = validParams();
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: expected });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    { pendingIds: [], expected: 'pending_shape_mismatch' },
    { pendingIds: ['pending_exact', 'pending_other'], expected: 'pending_shape_mismatch' },
    { decrypt: null, expected: 'identity_unavailable' },
    { build: null, expected: 'identity_unavailable' },
    { build: { ...spawnOptions, machineId: 'other_machine' }, expected: 'identity_unavailable' },
  ])('rejects identity/Pending preflight failure $expected without mutation', async ({ pendingIds, decrypt, build, expected }) => {
    if (pendingIds) mocks.listPending.mockResolvedValue(pendingIds);
    if (decrypt !== undefined) mocks.decrypt.mockReturnValue(decrypt);
    if (build !== undefined) mocks.build.mockReturnValue(build);
    const params = validParams();
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: expected });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    { activation: { status: 'not-needed', reason: 'active' }, expected: 'completion_unproven' },
    { activation: { status: 'rejected', reason: 'spawn-rejected' }, expected: 'completion_unproven' },
    { activation: { status: 'activated', runnerAcceptance: 'adopted' }, expected: 'completion_unproven' },
    { activation: { status: 'activated', runnerAcceptance: 'in_flight' }, expected: 'completion_unproven' },
  ])('refuses partial activation $expected', async ({ activation, expected }) => {
    mocks.activate.mockResolvedValue(activation);
    const params = validParams();
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: expected });
    expect(params.awaitCompletion).not.toHaveBeenCalled();
  });

  it('returns completion_unproven on timeout without killing the possibly working runner', async () => {
    const params = validParams({ awaitCompletion: vi.fn(async () => null) });
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: 'completion_unproven' });
    expect(params.spawnSession).not.toHaveBeenCalled();
  });
});

describe('awaitFreshProviderCompletion', () => {
  const validChild = (overrides: Record<string, unknown> = {}) => ({
    happySessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
    startedBy: 'daemon',
    pid: 777,
    vendorResumeId: 'provider-new',
    processInstanceFingerprint: 'linux-proc:accepted-777',
    ...overrides,
  });
  const validMarker = (overrides: Record<string, unknown> = {}) => ({
    pid: 777,
    happySessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
    vendorResumeId: 'provider-new',
    processInstanceFingerprint: 'linux-proc:accepted-777',
    hasResume: false,
    hasFreshProviderContextOnce: false,
    ...overrides,
  });
  const observation = (overrides: Record<string, unknown> = {}) => ({
    daemonChildren: [validChild()],
    sessionLock: { pid: 777, processInstanceFingerprint: 'linux-proc:accepted-777' },
    pendingControlState: 'servable',
    exactPidRunState: 'servable',
    rawActive: true,
    pendingIds: [],
    marker: validMarker(),
    ...overrides,
  });
  const hostedCustody = (overrides: Record<string, unknown> = {}) => ({
    daemonChildren: [validChild({
      sessionRunnerPid: 888,
      processInstanceFingerprint: 'linux-proc:runner-888',
    })],
    sessionLock: { pid: 888, processInstanceFingerprint: 'linux-proc:runner-888' },
    marker: validMarker({
      pid: 888,
      processInstanceFingerprint: 'linux-proc:runner-888',
    }),
    ...overrides,
  });

  async function resolveObserved(value: Record<string, unknown>) {
    return await awaitFreshProviderCompletion({
      sessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
      requestId: 'pending-exact',
      previousProviderId: 'provider-old',
      pid: 777,
      timeoutMs: 1,
      observe: async () => observation(value) as any,
      nowMs: (() => { let calls = 0; return () => calls++ < 2 ? 0 : 2; })(),
      wait: async () => {},
    });
  }

  it('completes only for the newly accepted exact daemon PID with matching custody', async () => {
    await expect(resolveObserved({})).resolves.toBe('provider-new');
  });

  it('completes a hosted wrapper only when its correlated effective runner owns all custody', async () => {
    await expect(resolveObserved(hostedCustody())).resolves.toBe('provider-new');
  });

  it('does not require a Pending-control observation after the exact request has already drained', async () => {
    await expect(resolveObserved({ pendingControlState: undefined })).resolves.toBe('provider-new');
  });

  it('uses the exact PID-bound durable marker when the daemon child provider projection is stale', async () => {
    await expect(resolveObserved({
      daemonChildren: [validChild({ vendorResumeId: 'provider-old' })],
    })).resolves.toBe('provider-new');
  });

  it('keeps the sole-child gate load-bearing when a plausible find would select valid accepted custody', async () => {
    const duplicate = {
      daemonChildren: [
        validChild(),
        validChild({ pid: 778, processInstanceFingerprint: 'linux-proc:competing-778' }),
      ],
    };
    const plausibleFindSelection = duplicate.daemonChildren.find((child) => child.pid === 777);
    expect(plausibleFindSelection).toEqual(validChild());
    expect(observation(duplicate).sessionLock).toEqual({ pid: 777, processInstanceFingerprint: 'linux-proc:accepted-777' });
    expect(observation(duplicate).marker).toEqual(validMarker());
    await expect(resolveObserved(duplicate)).resolves.toBeNull();
  });

  it.each([
    ['a duplicate daemon child', { daemonChildren: [
      validChild(),
      validChild({ pid: 778, processInstanceFingerprint: 'linux-proc:competing-778' }),
    ] }],
    ['another runner instead of the accepted PID', { daemonChildren: [
      validChild({ pid: 778, processInstanceFingerprint: 'linux-proc:competing-778' }),
    ],
      sessionLock: { pid: 778, processInstanceFingerprint: 'linux-proc:competing-778' },
      marker: validMarker({ pid: 778 }),
    }],
    ['a reused PID with a mismatched process identity', { sessionLock: { pid: 777, processInstanceFingerprint: 'linux-proc:reused-777' } }],
    ['a current session lock held by another PID', { sessionLock: { pid: 778, processInstanceFingerprint: 'linux-proc:accepted-777' } }],
    ['a hosted wrapper whose lock remains on the launch PID', hostedCustody({
      sessionLock: { pid: 777, processInstanceFingerprint: 'linux-proc:runner-888' },
    })],
    ['a hosted effective runner with a mismatched lock fingerprint', hostedCustody({
      sessionLock: { pid: 888, processInstanceFingerprint: 'linux-proc:reused-888' },
    })],
    ['an inactive raw session despite a live accepted PID', { rawActive: false }],
    ['a marker with a reused process identity', {
      marker: validMarker({ processInstanceFingerprint: 'linux-proc:reused-777' }),
    }],
    ['a marker without a provider id', { marker: validMarker({ vendorResumeId: '' }) }],
    ['a stale marker provider id', { marker: validMarker({ vendorResumeId: 'provider-old' }) }],
    ['a marker that retained fresh state', { marker: validMarker({ hasFreshProviderContextOnce: true }) }],
    ['a partial Pending drain', { pendingIds: ['pending-exact'] }],
  ])('refuses completion for %s', async (_label, incomplete) => {
    await expect(resolveObserved(incomplete)).resolves.toBeNull();
  });

  it('returns null when no full conjunction arrives before the completion timeout', async () => {
    let now = 0;
    await expect(awaitFreshProviderCompletion({
      sessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
      requestId: 'pending-exact',
      previousProviderId: 'provider-old',
      pid: 777,
      timeoutMs: 10,
      observe: async () => observation({ pendingIds: ['pending-exact'] }) as any,
      nowMs: () => now,
      wait: async () => { now = 10; },
    })).resolves.toBeNull();
  });
});
