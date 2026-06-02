import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { createStackHappierCliCommandFixture } from './testkit/stack_happier_cli_command_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

function buildStubHappyCliScript() {
  return [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    'const args = process.argv.slice(2);',
    "const home = process.env.HAPPIER_STACK_CLI_HOME_DIR || process.env.HAPPIER_HOME_DIR || process.cwd();",
    "const statePath = join(home, 'fleet-supervisor-stub-state.json');",
    "const logPath = join(home, 'fleet-supervisor-invocations.log');",
    '',
    'function readState() {',
    "  if (!existsSync(statePath)) return { lastProbeBySession: {}, activeBySession: {}, activeAtBySession: {}, sendFailuresBySession: {} };",
    "  return JSON.parse(readFileSync(statePath, 'utf-8'));",
    '}',
    '',
    'function writeState(state) {',
    "  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');",
    '}',
    '',
    'function printJson(payload) {',
    '  console.log(JSON.stringify(payload));',
    '}',
    '',
    'function valueAfter(flag) {',
    '  const idx = args.indexOf(flag);',
    '  return idx >= 0 ? String(args[idx + 1] || "") : "";',
    '}',
    '',
    'function probeFromMessage(message) {',
    '  return String(message).match(/HSTACK_SUPERVISOR_PROBE\\s+([A-Za-z0-9._-]+)/)?.[1] || "";',
    '}',
    '',
    "if (args[0] === 'session' && args[1] === 'list') {",
    '  printJson({ v: 1, ok: true, kind: "session_list", data: { sessions: [{ id: "session-1", active: false, archivedAt: null }], nextCursor: null, hasNext: false } });',
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'session' && args[1] === 'status') {",
    '  const id = args[2];',
    '  const state = readState();',
    '  if (id === "archived-1") {',
    '    printJson({ v: 1, ok: true, kind: "session_status", data: { session: { id, active: false, archivedAt: 123 } } });',
    '    process.exit(0);',
    '  }',
    '  const active = state.activeBySession?.[id] === true;',
    '  printJson({ v: 1, ok: true, kind: "session_status", data: { session: { id, active, activeAt: state.activeAtBySession?.[id] || (active ? 100 : 0), archivedAt: null } } });',
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'resume' && args[1] === '--help') {",
    "  console.log('happier resume');",
    "  console.log('happier resume <session-id-or-prefix>');",
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'resume') {",
    '  const id = args.find((arg, index) => index > 0 && !String(arg).startsWith("--")) || "";',
    '  const state = readState();',
    '  state.activeBySession = state.activeBySession || {};',
    '  state.activeAtBySession = state.activeAtBySession || {};',
    '  state.activeBySession[id] = true;',
    '  state.activeAtBySession[id] = (state.activeAtBySession[id] || 100) + 100;',
    '  if (args.includes("--repair-active")) {',
    '    state.sendFailuresBySession = state.sendFailuresBySession || {};',
    '    state.sendFailuresBySession[id] = 0;',
    '  }',
    '  writeState(state);',
    "  appendFileSync(logPath, `resume ${args.slice(1).join(' ')}\\n`, 'utf-8');",
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'session' && args[1] === 'send') {",
    '  const id = args[2];',
    '  const message = args[3] || "";',
    '  const state = readState();',
    '  const probe = probeFromMessage(message);',
    '  const remainingFailures = Number(state.sendFailuresBySession?.[id] || 0);',
    '  if (remainingFailures > 0) {',
    '    state.sendFailuresBySession[id] = remainingFailures - 1;',
    '    writeState(state);',
    "    appendFileSync(logPath, `send-fail ${id} ${probe}\\n`, 'utf-8');",
    '    printJson({ v: 1, ok: false, kind: "session_send", error: { code: "session_rpc_failed" } });',
    '    process.exit(0);',
    '  }',
    '  state.lastProbeBySession = state.lastProbeBySession || {};',
    '  state.lastProbeBySession[id] = probe;',
    '  writeState(state);',
    "  appendFileSync(logPath, `send ${id} ${probe}\\n`, 'utf-8');",
    '  printJson({ v: 1, ok: true, kind: "session_send", data: { sessionId: id, localId: `local-${probe}`, waited: false } });',
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'session' && args[1] === 'create') {",
    '  const prompt = valueAfter("--prompt") || valueAfter("--message");',
    '  const probe = probeFromMessage(prompt);',
    '  const state = readState();',
    '  state.lastProbeBySession = state.lastProbeBySession || {};',
    '  state.lastProbeBySession["session-replacement"] = probe;',
    '  writeState(state);',
    "  appendFileSync(logPath, `create session-replacement ${probe}\\n`, 'utf-8');",
    '  printJson({ v: 1, ok: true, kind: "session_create", data: { created: true, session: { id: "session-replacement", active: true, archivedAt: null } } });',
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'session' && args[1] === 'actions' && args[2] === 'execute' && args[4] === 'session.transcript.get') {",
    '  const id = args[3];',
    '  const state = readState();',
    '  const probe = state.lastProbeBySession?.[id] || "";',
    '  const items = probe ? [{ id: `m-${probe}`, seq: 2, createdAt: Date.now(), role: "assistant", kind: "assistant_message", provider: "codex", text: `HSTACK_SUPERVISOR_PROBE_ACK ${probe}` }] : [];',
    '  printJson({ v: 1, ok: true, kind: "session_actions_execute", data: { sessionId: id, actionId: "session.transcript.get", result: { ok: true, sessionId: id, items, nextCursor: null, hasMore: false } } });',
    '  process.exit(0);',
    '}',
    '',
    "appendFileSync(logPath, `unexpected ${args.join(' ')}\\n`, 'utf-8');",
    'process.exit(1);',
    '',
  ].join('\n');
}

async function createFleetSupervisorFixture(t) {
  return await createStackHappierCliCommandFixture(t, {
    prefix: 'happier-stack-fleet-supervisor-',
    stackName: 'exp-test',
    serverPort: 4101,
    distIndexScript: buildStubHappyCliScript(),
    binHappierScript: "import '../dist/index.mjs';\n",
  });
}

test('hstack stack fleet-supervisor register persists a stack-owned launch descriptor', async (t) => {
  const fixture = await createFleetSupervisorFixture(t);
  const res = await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'register',
      '--member-id',
      'member-a',
      '--role',
      'drill',
      '--repo',
      '/tmp/drill-repo',
      '--backend',
      'agent:codex',
      '--recovery-prompt',
      'Recover this member.',
      '--session-id',
      'session-1',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /"ok":\s*true/);

  const descriptorPath = join(fixture.storageDir, fixture.stackName, 'fleet-supervisor', 'descriptors', 'member-a.json');
  assert.equal(existsSync(descriptorPath), true);
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf-8'));
  assert.equal(descriptor.memberId, 'member-a');
  assert.equal(descriptor.role, 'drill');
  assert.equal(descriptor.repo, '/tmp/drill-repo');
  assert.equal(descriptor.backend, 'agent:codex');
  assert.equal(descriptor.sessionId, 'session-1');
  assert.equal(descriptor.recoveryPrompt, 'Recover this member.');
});

test('hstack stack fleet-supervisor recover resumes inactive sessions and verifies an assistant transcript row', async (t) => {
  const fixture = await createFleetSupervisorFixture(t);
  await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'register',
      '--member-id',
      'member-a',
      '--role',
      'drill',
      '--repo',
      '/tmp/drill-repo',
      '--backend',
      'agent:codex',
      '--recovery-prompt',
      'Recover this member.',
      '--session-id',
      'session-1',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  const res = await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'recover',
      '--member-id',
      'member-a',
      '--timeout-seconds',
      '10',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /"verified":\s*true/);
  assert.match(res.stdout, /"action":\s*"resumed"/);

  const invocationLog = await readFile(join(fixture.stackCliHome, 'fleet-supervisor-invocations.log'), 'utf-8');
  assert.match(invocationLog, /^resume session-1$/m);
  assert.match(invocationLog, /^send session-1 [A-Za-z0-9._-]+$/m);
});

test('hstack stack fleet-supervisor recover repairs active sessions whose probe send fails', async (t) => {
  const fixture = await createFleetSupervisorFixture(t);
  await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'register',
      '--member-id',
      'member-frozen',
      '--role',
      'drill',
      '--repo',
      '/tmp/drill-repo',
      '--backend',
      'agent:codex',
      '--recovery-prompt',
      'Recover this frozen member.',
      '--session-id',
      'session-1',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );
  await writeFile(
    join(fixture.stackCliHome, 'fleet-supervisor-stub-state.json'),
    JSON.stringify({
      lastProbeBySession: {},
      activeBySession: { 'session-1': true },
      activeAtBySession: { 'session-1': 100 },
      sendFailuresBySession: { 'session-1': 1 },
    }, null, 2),
    'utf-8'
  );

  const res = await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'recover',
      '--member-id',
      'member-frozen',
      '--timeout-seconds',
      '10',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /"verified":\s*true/);
  assert.match(res.stdout, /"action":\s*"repaired"/);

  const invocationLog = await readFile(join(fixture.stackCliHome, 'fleet-supervisor-invocations.log'), 'utf-8');
  assert.match(invocationLog, /^send-fail session-1 [A-Za-z0-9._-]+$/m);
  assert.match(invocationLog, /^resume --repair-active session-1$/m);
  assert.match(invocationLog, /^send session-1 [A-Za-z0-9._-]+$/m);
});

test('hstack stack fleet-supervisor recover replaces archived sessions and links continuity state', async (t) => {
  const fixture = await createFleetSupervisorFixture(t);
  await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'register',
      '--member-id',
      'member-archived',
      '--role',
      'drill',
      '--repo',
      '/tmp/drill-repo',
      '--backend',
      'agent:codex',
      '--recovery-prompt',
      'Recover this archived member.',
      '--session-id',
      'archived-1',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  const res = await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'fleet-supervisor',
      fixture.stackName,
      'recover',
      '--member-id',
      'member-archived',
      '--timeout-seconds',
      '3',
      '--json',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );

  assert.equal(res.code, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /"verified":\s*true/);
  assert.match(res.stdout, /"action":\s*"replaced"/);

  const descriptorPath = join(fixture.storageDir, fixture.stackName, 'fleet-supervisor', 'descriptors', 'member-archived.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf-8'));
  assert.equal(descriptor.sessionId, 'session-replacement');
  assert.deepEqual(descriptor.previousSessionIds, ['archived-1']);

  const invocationLog = await readFile(join(fixture.stackCliHome, 'fleet-supervisor-invocations.log'), 'utf-8');
  assert.match(invocationLog, /^create session-replacement [A-Za-z0-9._-]+$/m);
});
