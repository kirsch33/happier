import { beforeEach, describe, expect, it, vi } from 'vitest';

const resumeFreshDaemonSession = vi.fn();
const armFreshRecoveryReservation = vi.fn();
const printJsonEnvelope = vi.fn(async () => {});
const readCredentials = vi.fn<() => Promise<{ token: string } | null>>(async () => ({ token: 'arm-token' }));

vi.mock('@/daemon/controlClient', () => ({
  resumeFreshDaemonSession,
}));
vi.mock('@/persistence', () => ({
  readCredentials,
}));
vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-arm-test',
    activeServerId: 'server-arm-test',
  },
}));
vi.mock('@/daemon/sessions/freshProviderRecoveryReservation', () => ({
  createFreshProviderRecoveryReservationStore: vi.fn(() => ({ arm: armFreshRecoveryReservation })),
}));
vi.mock('@/cli/output/jsonEnvelope', () => ({
  wantsJson: (argv: readonly string[]) => argv.includes('--json'),
  printJsonEnvelope,
}));

describe('happier session resume-fresh', () => {
  beforeEach(() => {
    resumeFreshDaemonSession.mockReset();
    armFreshRecoveryReservation.mockReset();
    printJsonEnvelope.mockReset();
    readCredentials.mockReset();
    readCredentials.mockResolvedValue({ token: 'arm-token' });
    armFreshRecoveryReservation.mockResolvedValue({ ok: true });
  });

  it('posts an opaque real Happier session id to the authenticated local daemon and prints its completion', async () => {
    resumeFreshDaemonSession.mockResolvedValueOnce({
      ok: true,
      sessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
      providerSessionId: 'thread_new_456',
    });
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh(['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--json'])).resolves.toBeUndefined();
    expect(resumeFreshDaemonSession).toHaveBeenCalledWith('cm8q7dqx00001k0n1s5v6z2ab');
  });

  it('forwards an optional recovery message without weakening the exact session id', async () => {
    resumeFreshDaemonSession.mockResolvedValueOnce({
      ok: true,
      sessionId: 'cm8q7dqx00001k0n1s5v6z2ab',
      providerSessionId: 'thread_new_456',
    });
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh([
      'resume-fresh',
      'cm8q7dqx00001k0n1s5v6z2ab',
      '--message',
      'Start fresh from this recovery instruction.',
      '--json',
    ])).resolves.toBeUndefined();

    expect(resumeFreshDaemonSession).toHaveBeenCalledWith(
      'cm8q7dqx00001k0n1s5v6z2ab',
      'Start fresh from this recovery instruction.',
    );
  });

  it('leaves unknown or prefix-shaped ids for the exact daemon lookup', async () => {
    resumeFreshDaemonSession.mockResolvedValueOnce({
      ok: false,
      errorCode: 'session_not_inactive',
      errorMessage: 'The exact session must be unarchived and inactive.',
    });
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh(['resume-fresh', 'cm8q7', '--json'])).resolves.toBeUndefined();
    expect(resumeFreshDaemonSession).toHaveBeenCalledWith('cm8q7');
  });

  it.each([
    'reservation_claim_mismatch',
    'reservation_missing',
    'reservation_corrupt',
    'pending_shape_mismatch',
    'seed_admission_unconfirmed',
    'post_seed_snapshot_drift',
  ])('writes exact %s daemon failures as a CLI JSON error code', async (errorCode) => {
    resumeFreshDaemonSession.mockResolvedValueOnce({ ok: false, errorCode, errorMessage: `failed: ${errorCode}` });
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await cmdSessionResumeFresh(['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--json']);

    expect(printJsonEnvelope).toHaveBeenCalledWith({
      ok: false, kind: 'session_resume_fresh', error: { code: errorCode, message: `failed: ${errorCode}` },
    });
  });

  it.each(['reservation_already_armed', 'reservation_scope_invalid'])('writes exact %s arm failures as a CLI JSON error code', async (code) => {
    armFreshRecoveryReservation.mockResolvedValueOnce({ ok: false, code });
    const { cmdSessionResumeFresh } = await import('./resumeFresh');
    await cmdSessionResumeFresh(['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--arm', '--json']);
    expect(printJsonEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, kind: 'session_resume_fresh', error: expect.objectContaining({ code }),
    }));
  });

  it('writes not_authenticated when local arm credentials are unavailable', async () => {
    readCredentials.mockResolvedValueOnce(null);
    const { cmdSessionResumeFresh } = await import('./resumeFresh');
    await cmdSessionResumeFresh(['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--arm', '--json']);
    expect(printJsonEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, kind: 'session_resume_fresh', error: expect.objectContaining({ code: 'not_authenticated' }),
    }));
  });

  it('arms the exact local recovery reservation without contacting the running daemon', async () => {
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh(['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--arm', '--json'])).resolves.toBeUndefined();

    expect(armFreshRecoveryReservation).toHaveBeenCalledWith('cm8q7dqx00001k0n1s5v6z2ab');
    expect(resumeFreshDaemonSession).not.toHaveBeenCalled();
  });

  it('rejects an armed request carrying a recovery message before mutating either path', async () => {
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh([
      'resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', '--arm', '--message', 'not valid', '--json',
    ])).rejects.toThrow('Usage: happier session resume-fresh <exact-Happier-session-id> [--arm] [--message <text>] [--json]');

    expect(armFreshRecoveryReservation).not.toHaveBeenCalled();
    expect(resumeFreshDaemonSession).not.toHaveBeenCalled();
  });

  it.each([
    ['missing id', ['resume-fresh', '--json']],
    ['blank id', ['resume-fresh', '   ', '--json']],
    ['extra positional is refused', ['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', 'extra', '--json']],
  ])('rejects %s before contacting the daemon', async (_label, argv) => {
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh([...argv])).rejects.toThrow('Usage: happier session resume-fresh <exact-Happier-session-id> [--arm] [--message <text>] [--json]');
    expect(resumeFreshDaemonSession).not.toHaveBeenCalled();
  });
});
