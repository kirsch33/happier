import { beforeEach, describe, expect, it, vi } from 'vitest';

const resumeFreshDaemonSession = vi.fn();

vi.mock('@/daemon/controlClient', () => ({
  resumeFreshDaemonSession,
}));

describe('happier session resume-fresh', () => {
  beforeEach(() => {
    resumeFreshDaemonSession.mockReset();
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
    ['missing id', ['resume-fresh', '--json']],
    ['blank id', ['resume-fresh', '   ', '--json']],
    ['extra positional is refused', ['resume-fresh', 'cm8q7dqx00001k0n1s5v6z2ab', 'extra', '--json']],
  ])('rejects %s before contacting the daemon', async (_label, argv) => {
    const { cmdSessionResumeFresh } = await import('./resumeFresh');

    await expect(cmdSessionResumeFresh([...argv])).rejects.toThrow('Usage: happier session resume-fresh <exact-Happier-session-id> [--json]');
    expect(resumeFreshDaemonSession).not.toHaveBeenCalled();
  });
});
