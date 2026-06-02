import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { printResult } from '../utils/cli/cli.mjs';
import { randomToken } from '../utils/crypto/tokens.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { runCapture, runCaptureResult } from '../utils/proc/proc.mjs';

import { withStackEnv } from './stack_environment.mjs';

const SUPERVISOR_DIR = 'fleet-supervisor';
const PROBE_PREFIX = 'HSTACK_SUPERVISOR_PROBE';
const PROBE_ACK_PREFIX = 'HSTACK_SUPERVISOR_PROBE_ACK';

function usage() {
  return [
    '[stack] usage:',
    '  hstack stack fleet-supervisor <name> register --member-id <id> --role <role> --repo <path> --backend <backend> --recovery-prompt <text> [--session-id <id>] [--model <model>] [--json]',
    '  hstack stack fleet-supervisor <name> recover [--member-id <id>] [--timeout-seconds <n>] [--json]',
    '  hstack stack fleet-supervisor <name> watch [--interval-seconds <n>] [--recover-on-start] [--timeout-seconds <n>]',
    '  hstack stack fleet-supervisor <name> status [--json]',
  ].join('\n');
}

function readFlagValue(argv, flag) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (arg === flag) return String(argv[index + 1] ?? '').trim();
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1).trim();
  }
  return '';
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readPositiveIntFlag(argv, flag, fallback) {
  const raw = readFlagValue(argv, flag);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sanitizeDescriptorFileToken(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || '';
}

function stackSupervisorPaths(stackName, env) {
  const baseDir = resolveStackEnvPath(stackName, env).baseDir;
  const rootDir = join(baseDir, SUPERVISOR_DIR);
  return {
    rootDir,
    descriptorsDir: join(rootDir, 'descriptors'),
    eventsPath: join(rootDir, 'events.jsonl'),
    statePath: join(rootDir, 'state.json'),
  };
}

function descriptorPathFor(paths, memberId) {
  const token = sanitizeDescriptorFileToken(memberId);
  if (!token) throw new Error('invalid_member_id');
  return join(paths.descriptorsDir, `${token}.json`);
}

async function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function appendEvent(paths, event) {
  await mkdir(paths.rootDir, { recursive: true });
  await appendFile(paths.eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf-8');
}

function parseJsonEnvelope(output) {
  const trimmed = String(output ?? '').trim();
  if (!trimmed) throw new Error('empty_json_output');
  return JSON.parse(trimmed);
}

async function runHappierJson({ rootDir, env, args, timeoutMs = 60_000 }) {
  const out = await runCapture(process.execPath, [join(rootDir, 'scripts', 'happier.mjs'), ...args], {
    cwd: rootDir,
    env,
    timeoutMs,
  });
  return parseJsonEnvelope(out);
}

async function runHappierJsonResult({ rootDir, env, args, timeoutMs = 60_000 }) {
  const result = await runCaptureResult(process.execPath, [join(rootDir, 'scripts', 'happier.mjs'), ...args], {
    cwd: rootDir,
    env,
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.err.trim() || result.out.trim() || `exit_${result.exitCode ?? 'unknown'}`,
      out: result.out,
      err: result.err,
    };
  }
  try {
    return { ok: true, envelope: parseJsonEnvelope(result.out), out: result.out, err: result.err };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      out: result.out,
      err: result.err,
    };
  }
}

function readFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function waitForSessionActive({ rootDir, env, sessionId, timeoutSeconds, previousActiveAt = null }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const status = await runHappierJsonResult({
      rootDir,
      env,
      args: ['session', 'status', sessionId, '--json'],
      timeoutMs: 30_000,
    });
    const session = status.ok && status.envelope?.ok ? envelopeSession(status.envelope) : null;
    if (session?.active === true) {
      const activeAt = readFiniteNumber(session.activeAt);
      const previous = readFiniteNumber(previousActiveAt);
      if (previous === null || (activeAt !== null && activeAt > previous)) {
        return session;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('resume_active_timeout');
}

async function runStackResume({ rootDir, stackName, env, sessionId, timeoutSeconds, repairActive = false, previousActiveAt = null }) {
  const child = spawn(process.execPath, [
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack',
    'resume',
    stackName,
    ...(repairActive ? ['--repair-active'] : []),
    sessionId,
    '--json',
  ], {
    cwd: rootDir,
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  child.unref?.();
  await waitForSessionActive({
    rootDir,
    env,
    sessionId,
    timeoutSeconds,
    previousActiveAt: repairActive ? previousActiveAt : null,
  });
  return { pid: child.pid ?? null };
}

function envelopeSession(envelope) {
  return envelope?.data?.session && typeof envelope.data.session === 'object' ? envelope.data.session : null;
}

function messageText(message) {
  if (!message || typeof message !== 'object') return String(message ?? '');
  const direct = message.text ?? message.summary ?? message.content;
  if (typeof direct === 'string') return direct;
  return JSON.stringify(message);
}

function isAgentProbeAckRow(message, probe) {
  if (!message || typeof message !== 'object') return false;
  const role = String(message.role ?? message.raw?.role ?? '').toLowerCase();
  if (role === 'user') return false;
  if (role && !role.includes('assistant') && !role.includes('agent') && !role.includes('model')) return false;
  return messageText(message).includes(`${PROBE_ACK_PREFIX} ${probe}`);
}

async function waitForProbeAck({ rootDir, env, sessionId, probe, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = '';
  while (Date.now() <= deadline) {
    const result = await runHappierJsonResult({
      rootDir,
      env,
      args: [
        'session',
        'actions',
        'execute',
        sessionId,
        'session.transcript.get',
        '--input-json',
        JSON.stringify({
          sessionId,
          limit: 50,
          roles: ['assistant'],
          includeMeta: true,
          maxCharsPerMessage: 2000,
        }),
        '--json',
      ],
      timeoutMs: 30_000,
    });
    if (result.ok && result.envelope?.ok) {
      const items = Array.isArray(result.envelope.data?.result?.items) ? result.envelope.data.result.items : [];
      const row = items.find((message) => isAgentProbeAckRow(message, probe));
      if (row) return row;
    } else {
      lastError = result.error || result.envelope?.error?.code || '';
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(lastError ? `probe_ack_timeout:${lastError}` : 'probe_ack_timeout');
}

function buildProbeMessage(descriptor, probe, intro) {
  return [
    intro,
    descriptor.recoveryPrompt,
    '',
    `${PROBE_PREFIX} ${probe}`,
    `Reply with exactly: ${PROBE_ACK_PREFIX} ${probe}`,
  ].filter((line) => String(line ?? '').length > 0).join('\n');
}

async function loadDescriptors(paths, memberId = '') {
  await mkdir(paths.descriptorsDir, { recursive: true });
  if (memberId) {
    const descriptor = await readJsonFile(descriptorPathFor(paths, memberId), null);
    return descriptor ? [descriptor] : [];
  }

  const names = await readdir(paths.descriptorsDir);
  const descriptors = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    descriptors.push(await readJsonFile(join(paths.descriptorsDir, name)));
  }
  return descriptors.filter(Boolean);
}

async function saveDescriptor(paths, descriptor) {
  await mkdir(paths.descriptorsDir, { recursive: true });
  await writeJsonFile(descriptorPathFor(paths, descriptor.memberId), descriptor);
}

async function assertSupervisorStackGate({ rootDir, stackName, env }) {
  const port = Number(env.HAPPIER_STACK_SERVER_PORT);
  if (Number.isFinite(port) && port === 3005) {
    throw new Error(`[fleet-supervisor] refusing to use live relay port 3005 for stack ${stackName}`);
  }
  const list = await runHappierJson({
    rootDir,
    env,
    args: ['session', 'list', '--limit', '1', '--json'],
    timeoutMs: 60_000,
  });
  if (!list?.ok) {
    throw new Error(list?.error?.code ? `session_list_failed:${list.error.code}` : 'session_list_failed');
  }
  return {
    port: Number.isFinite(port) ? port : null,
    listed: true,
  };
}

async function recoverExistingMember({ rootDir, stackName, env, descriptor, timeoutSeconds }) {
  const status = await runHappierJsonResult({
    rootDir,
    env,
    args: ['session', 'status', descriptor.sessionId, '--json'],
    timeoutMs: 60_000,
  });
  const session = status.ok && status.envelope?.ok ? envelopeSession(status.envelope) : null;
  if (!session) return null;
  if (session.archivedAt != null) return null;

  let action = 'sent';
  let resume = null;
  if (session.active !== true) {
    resume = await runStackResume({ rootDir, stackName, env, sessionId: descriptor.sessionId, timeoutSeconds });
    action = 'resumed';
  }

  const sendProbe = async () => {
    const probe = randomToken(12);
    const message = buildProbeMessage(
      descriptor,
      probe,
      `Supervisor recovery probe for member ${descriptor.memberId}.`,
    );
    const sendArgs = ['session', 'send', descriptor.sessionId, message, '--json'];
    if (descriptor.model) sendArgs.splice(sendArgs.length - 1, 0, '--model', descriptor.model);
    const send = await runHappierJson({ rootDir, env, args: sendArgs, timeoutMs: 60_000 });
    if (!send?.ok) {
      throw new Error(send?.error?.code ? `session_send_failed:${send.error.code}` : 'session_send_failed');
    }
    const row = await waitForProbeAck({ rootDir, env, sessionId: descriptor.sessionId, probe, timeoutSeconds });
    return { probe, row };
  };

  let sent;
  try {
    sent = await sendProbe();
  } catch (error) {
    if (session.active !== true) {
      throw error;
    }
    resume = await runStackResume({
      rootDir,
      stackName,
      env,
      sessionId: descriptor.sessionId,
      timeoutSeconds,
      repairActive: true,
      previousActiveAt: session.activeAt ?? null,
    });
    action = 'repaired';
    sent = await sendProbe();
  }

  return {
    memberId: descriptor.memberId,
    sessionId: descriptor.sessionId,
    action,
    verified: true,
    probe: sent.probe,
    resume,
    transcriptRow: sent.row,
  };
}

async function replaceMember({ rootDir, env, paths, descriptor, timeoutSeconds }) {
  const previousSessionId = descriptor.sessionId || '';
  const probe = randomToken(12);
  const prompt = buildProbeMessage(
    descriptor,
    probe,
    previousSessionId
      ? `Supervisor is replacing archived or non-resumable member ${descriptor.memberId}; prior session ${previousSessionId}.`
      : `Supervisor is launching member ${descriptor.memberId}.`,
  );
  const create = await runHappierJson({
    rootDir,
    env,
    args: [
      'session',
      'create',
      '--path',
      descriptor.repo,
      '--backend',
      descriptor.backend,
      '--title',
      descriptor.role,
      '--tag',
      descriptor.memberId,
      '--prompt',
      prompt,
      '--json',
    ],
    timeoutMs: 120_000,
  });
  if (!create?.ok) {
    throw new Error(create?.error?.code ? `session_create_failed:${create.error.code}` : 'session_create_failed');
  }
  const nextSessionId = String(create.data?.session?.id ?? '').trim();
  if (!nextSessionId) throw new Error('session_create_missing_id');

  const previousSessionIds = Array.isArray(descriptor.previousSessionIds) ? [...descriptor.previousSessionIds] : [];
  if (previousSessionId && !previousSessionIds.includes(previousSessionId)) previousSessionIds.push(previousSessionId);
  const nextDescriptor = {
    ...descriptor,
    sessionId: nextSessionId,
    previousSessionIds,
    updatedAt: new Date().toISOString(),
  };
  await saveDescriptor(paths, nextDescriptor);

  const row = await waitForProbeAck({ rootDir, env, sessionId: nextSessionId, probe, timeoutSeconds });
  return {
    memberId: descriptor.memberId,
    previousSessionId: previousSessionId || null,
    sessionId: nextSessionId,
    action: 'replaced',
    verified: true,
    probe,
    transcriptRow: row,
  };
}

async function recoverMember({ rootDir, stackName, env, paths, descriptor, timeoutSeconds }) {
  if (descriptor.sessionId) {
    const existing = await recoverExistingMember({ rootDir, stackName, env, descriptor, timeoutSeconds });
    if (existing) return existing;
  }
  return await replaceMember({ rootDir, env, paths, descriptor, timeoutSeconds });
}

async function registerDescriptor({ paths, argv }) {
  const memberId = readFlagValue(argv, '--member-id');
  const role = readFlagValue(argv, '--role');
  const repo = readFlagValue(argv, '--repo');
  const backend = readFlagValue(argv, '--backend');
  const recoveryPrompt = readFlagValue(argv, '--recovery-prompt');
  const sessionId = readFlagValue(argv, '--session-id');
  const model = readFlagValue(argv, '--model');
  if (!memberId || !role || !repo || !backend || !recoveryPrompt) {
    throw new Error('missing_required_descriptor_fields');
  }
  const now = new Date().toISOString();
  const existing = await readJsonFile(descriptorPathFor(paths, memberId), null);
  const descriptor = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    memberId,
    role,
    repo,
    backend,
    recoveryPrompt,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveDescriptor(paths, descriptor);
  return descriptor;
}

async function recoverDescriptors({ rootDir, stackName, env, paths, argv }) {
  const timeoutSeconds = readPositiveIntFlag(argv, '--timeout-seconds', 300);
  const memberId = readFlagValue(argv, '--member-id');
  const gate = await assertSupervisorStackGate({ rootDir, stackName, env });
  const descriptors = await loadDescriptors(paths, memberId);
  if (!descriptors.length) {
    throw new Error(memberId ? `descriptor_not_found:${memberId}` : 'no_descriptors_registered');
  }
  const results = [];
  for (const descriptor of descriptors) {
    const result = await recoverMember({ rootDir, stackName, env, paths, descriptor, timeoutSeconds });
    results.push(result);
    await appendEvent(paths, { type: 'member_recovered', stackName, ...result });
  }
  await writeJsonFile(paths.statePath, {
    lastRecoverAt: new Date().toISOString(),
    gate,
    results: results.map((result) => ({
      memberId: result.memberId,
      sessionId: result.sessionId,
      action: result.action,
      verified: result.verified,
      probe: result.probe,
    })),
  });
  return { ok: true, stackName, gate, results };
}

async function isStackGateHealthy({ rootDir, stackName, env }) {
  try {
    await assertSupervisorStackGate({ rootDir, stackName, env });
    return true;
  } catch {
    return false;
  }
}

async function readRuntimeOwnerPid(env) {
  const runtimeStatePath = String(env.HAPPIER_STACK_RUNTIME_STATE_PATH ?? '').trim();
  if (!runtimeStatePath) return null;
  const state = await readJsonFile(runtimeStatePath, null).catch(() => null);
  const pid = Number(state?.ownerPid);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

async function watchDescriptors({ rootDir, stackName, env, paths, argv }) {
  const intervalSeconds = readPositiveIntFlag(argv, '--interval-seconds', 30);
  const recoverOnStart = hasFlag(argv, '--recover-on-start');
  let wasHealthy = false;
  let lastOwnerPid = null;
  let first = true;
  for (;;) {
    const healthy = await isStackGateHealthy({ rootDir, stackName, env });
    const ownerPid = healthy ? await readRuntimeOwnerPid(env) : null;
    const ownerChanged = Boolean(healthy && lastOwnerPid && ownerPid && ownerPid !== lastOwnerPid);
    if (healthy && (!wasHealthy || (first && recoverOnStart) || ownerChanged)) {
      try {
        const result = await recoverDescriptors({ rootDir, stackName, env, paths, argv });
        process.stdout.write(`${JSON.stringify({ type: 'recover', ok: true, at: new Date().toISOString(), trigger: ownerChanged ? 'runtime_owner_changed' : first && recoverOnStart ? 'recover_on_start' : 'health_restored', ownerPid, previousOwnerPid: lastOwnerPid, result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ type: 'recover', ok: false, at: new Date().toISOString(), trigger: ownerChanged ? 'runtime_owner_changed' : first && recoverOnStart ? 'recover_on_start' : 'health_restored', ownerPid, previousOwnerPid: lastOwnerPid, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
    if (ownerPid) lastOwnerPid = ownerPid;
    wasHealthy = healthy;
    first = false;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

export async function runStackFleetSupervisorCommand({ rootDir, stackName, passthrough, json }) {
  const subcommand = String(passthrough[0] ?? '').trim();
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printResult({ json, data: { ok: false, error: 'missing_fleet_supervisor_subcommand' }, text: usage() });
    if (!subcommand || subcommand === 'help') process.exit(1);
    return;
  }

  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const paths = stackSupervisorPaths(stackName, env);
      const argv = passthrough.slice(1);

      if (subcommand === 'register') {
        const descriptor = await registerDescriptor({ paths, argv });
        await appendEvent(paths, { type: 'descriptor_registered', stackName, memberId: descriptor.memberId, sessionId: descriptor.sessionId ?? null });
        printResult({ json, data: { ok: true, stackName, descriptor }, text: `[fleet-supervisor] registered ${descriptor.memberId}` });
        return;
      }

      if (subcommand === 'recover') {
        const result = await recoverDescriptors({ rootDir, stackName, env, paths, argv });
        printResult({ json, data: result, text: `[fleet-supervisor] recovered ${result.results.length} member(s)` });
        return;
      }

      if (subcommand === 'watch') {
        await watchDescriptors({ rootDir, stackName, env, paths, argv });
        return;
      }

      if (subcommand === 'status') {
        const descriptors = await loadDescriptors(paths, readFlagValue(argv, '--member-id'));
        const state = await readJsonFile(paths.statePath, null);
        printResult({
          json,
          data: { ok: true, stackName, descriptors, state, paths },
          text: JSON.stringify({ stackName, descriptors, state, paths }, null, 2),
        });
        return;
      }

      printResult({ json, data: { ok: false, error: 'unknown_fleet_supervisor_subcommand', subcommand }, text: usage() });
      process.exit(1);
    },
  });
}
