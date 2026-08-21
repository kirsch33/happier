import chalk from 'chalk';

import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { resumeFreshDaemonSession } from '@/daemon/controlClient';

export const SESSION_RESUME_FRESH_USAGE = 'Usage: happier session resume-fresh <exact-Happier-session-id> [--json]';

export async function cmdSessionResumeFresh(argv: string[]): Promise<void> {
  const json = wantsJson(argv);
  const positionals = readCommandPositionals(argv, { startIndex: 1 });
  const sessionId = positionals[0]?.trim() ?? '';
  if (positionals.length !== 1 || !sessionId) {
    throw new Error(SESSION_RESUME_FRESH_USAGE);
  }

  const result = await resumeFreshDaemonSession(sessionId);
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
