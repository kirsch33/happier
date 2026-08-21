import chalk from 'chalk';

import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { resumeFreshDaemonSession } from '@/daemon/controlClient';
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { createFreshProviderRecoveryReservationStore } from '@/daemon/sessions/freshProviderRecoveryReservation';

export const SESSION_RESUME_FRESH_USAGE = 'Usage: happier session resume-fresh <exact-Happier-session-id> [--arm] [--message <text>] [--json]';

export async function cmdSessionResumeFresh(argv: string[]): Promise<void> {
  const json = wantsJson(argv);
  const positionals = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--message'] });
  const sessionId = positionals[0]?.trim() ?? '';
  const message = readFlagValue(argv, '--message');
  if (positionals.length !== 1 || !sessionId || (hasFlag(argv, '--message') && !message)) {
    throw new Error(SESSION_RESUME_FRESH_USAGE);
  }
  if (hasFlag(argv, '--arm')) {
    if (message) throw new Error(SESSION_RESUME_FRESH_USAGE);
    const credentials = await readCredentials();
    if (!credentials) {
      const error = { code: 'not_authenticated', message: 'Not authenticated. Run happier auth login first.' };
      if (json) { await printJsonEnvelope({ ok: false, kind: 'session_resume_fresh', error }); return; }
      throw new Error(error.message);
    }
    const armed = await createFreshProviderRecoveryReservationStore({
      happyHomeDir: configuration.happyHomeDir, serverId: configuration.activeServerId, token: credentials.token,
    }).arm(sessionId);
    if (!armed.ok) {
      const error = {
        code: armed.code,
        message: armed.code === 'reservation_already_armed'
          ? 'A fresh recovery reservation is already armed for this exact session.'
          : 'Fresh recovery reservation could not be armed for this account and session.',
      };
      if (json) { await printJsonEnvelope({ ok: false, kind: 'session_resume_fresh', error }); return; }
      throw new Error(error.message);
    }
    if (json) { await printJsonEnvelope({ ok: true, kind: 'session_resume_fresh', data: { sessionId, armed: true } }); return; }
    console.log(chalk.green('✓'), `armed fresh recovery for ${sessionId}`);
    return;
  }

  const result = message
    ? await resumeFreshDaemonSession(sessionId, message)
    : await resumeFreshDaemonSession(sessionId);
  if (!result.ok) {
    const error = new Error(result.errorMessage || 'Fresh provider context completion could not be proven');
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_resume_fresh', error: { code: result.errorCode, message: error.message } });
      return;
    }
    throw error;
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_resume_fresh',
      data: { sessionId: result.sessionId, providerSessionId: result.providerSessionId },
    });
    return;
  }
  console.log(chalk.green('✓'), `started a fresh provider context for ${result.sessionId}`);
}
