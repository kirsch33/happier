import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  fetch: vi.fn(),
  listPending: vi.fn(),
  decrypt: vi.fn(),
  build: vi.fn(),
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
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: mocks.decrypt,
}));
vi.mock('@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions', () => ({
  buildInactiveSessionResumeSpawnOptions: mocks.build,
}));
vi.mock('@happier-dev/agents', () => ({
  inferAgentIdFromSessionMetadata: mocks.inferAgentId,
  resolveVendorResumeIdFromSessionMetadata: mocks.resolveVendorResumeId,
}));

import { awaitFreshProviderCompletion, resumeFreshProviderContext } from './resumeFreshProviderContext';

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
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(rawSession);
    mocks.listPending.mockResolvedValue(['pending_exact']);
    mocks.decrypt.mockReturnValue({ metadata: 'decrypted' });
    mocks.build.mockReturnValue(spawnOptions);
    mocks.inferAgentId.mockReturnValue('codex');
    mocks.resolveVendorResumeId.mockReturnValue('provider_old');
    mocks.activate.mockResolvedValue({ status: 'activated', runnerAcceptance: 'newly_accepted', pid: 777 });
  });

  function validParams(overrides: Record<string, unknown> = {}) {
    return {
      credentials,
      machineId: 'machine_local',
      sessionId: 'sess_exact_123',
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
    expect(params.awaitCompletion).toHaveBeenCalledWith({
      sessionId: 'sess_exact_123',
      requestId: 'pending_exact',
      previousProviderId: 'provider_old',
      pid: 777,
    });
  });

  it.each([
    { raw: null, expected: 'session_not_inactive' },
    { raw: { ...rawSession, archivedAt: '2026-08-21' }, expected: 'session_not_inactive' },
    { raw: { ...rawSession, active: true }, expected: 'session_not_inactive' },
    { raw: { ...rawSession, pendingCount: 2 }, expected: 'pending_not_exact' },
    { raw: { ...rawSession, pendingVersion: undefined }, expected: 'pending_not_exact' },
  ])('rejects inactive/Pending preflight failure $expected without mutation', async ({ raw, expected }) => {
    mocks.fetch.mockResolvedValue(raw);
    const params = validParams();
    await expect(resumeFreshProviderContext(params)).resolves.toMatchObject({ ok: false, errorCode: expected });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(params.spawnSession).not.toHaveBeenCalled();
  });

  it.each([
    { pendingIds: [], expected: 'pending_not_exact' },
    { pendingIds: ['pending_exact', 'pending_other'], expected: 'pending_not_exact' },
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
    marker: validMarker({ pid: 888 }),
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
    ['a live but Pending-control-unservable accepted PID', { pendingControlState: 'recoverable_unservable' }],
    ['a reused PID with a mismatched process identity', { sessionLock: { pid: 777, processInstanceFingerprint: 'linux-proc:reused-777' } }],
    ['a current session lock held by another PID', { sessionLock: { pid: 778, processInstanceFingerprint: 'linux-proc:accepted-777' } }],
    ['a hosted wrapper whose lock remains on the launch PID', hostedCustody({
      sessionLock: { pid: 777, processInstanceFingerprint: 'linux-proc:runner-888' },
    })],
    ['a hosted effective runner with a mismatched lock fingerprint', hostedCustody({
      sessionLock: { pid: 888, processInstanceFingerprint: 'linux-proc:reused-888' },
    })],
    ['an inactive raw session despite a live accepted PID', { rawActive: false }],
    ['the old provider id on the accepted PID', {
      daemonChildren: [validChild({ vendorResumeId: 'provider-old' })],
      marker: validMarker({ vendorResumeId: 'provider-old' }),
    }],
    ['a missing provider id on the accepted PID', {
      daemonChildren: [validChild({ vendorResumeId: '' })],
      marker: validMarker({ vendorResumeId: '' }),
    }],
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
