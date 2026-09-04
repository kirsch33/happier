import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFreshProviderRecoveryReservationStore } from './freshProviderRecoveryReservation';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(async (dir) => await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true })))); });

async function store() {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-reservation-'));
  dirs.push(homeDir);
  return createFreshProviderRecoveryReservationStore({ happyHomeDir: homeDir, serverId: 'server_a', token: tokenForSub('account-default', 'issued-default') });
}

function tokenForSub(sub: string, jti: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub, jti })).toString('base64url'),
    'signature',
  ].join('.');
}

describe('fresh provider recovery reservation', () => {
  it('arms an atomic private exact reservation, binds one Pending snapshot, and clears only its matching proven claim', async () => {
    const reservations = await store();
    await expect(reservations.arm('sess_exact')).resolves.toEqual({ ok: true });
    expect(await reservations.isReserved('sess_exact')).toBe(true);
    await expect(reservations.claim('sess_exact', 'pending_1', 7)).resolves.toEqual({ ok: true });
    await expect(reservations.claim('sess_exact', 'pending_2', 7)).resolves.toEqual({ ok: false, code: 'reservation_claim_mismatch' });
    await expect(reservations.clearProven('sess_exact', 'pending_1', 7)).resolves.toEqual({ ok: true });
    expect(await reservations.isReserved('sess_exact')).toBe(false);
    expect(await reservations.isReserved('sess_other')).toBe(false);
    const path = reservations.filePathFor('sess_exact');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an armed claim across a fresh store/load and fails closed for corruption only at that exact reservation', async () => {
    const reservations = await store();
    await reservations.arm('sess_exact');
    await reservations.claim('sess_exact', 'pending_1', 7);
    const reloaded = createFreshProviderRecoveryReservationStore({ happyHomeDir: reservations.happyHomeDir, serverId: 'server_a', token: tokenForSub('account-default', 'issued-reload') });
    expect(await reloaded.isReserved('sess_exact')).toBe(true);
    await writeFile(reloaded.filePathFor('sess_exact'), '{bad json', { mode: 0o600 });
    expect(await reloaded.isReserved('sess_exact')).toBe(true);
    expect(await reloaded.isReserved('sess_other')).toBe(false);
  });

  it('scopes durable reservations to the stable authenticated subject rather than each issued token', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-fresh-reservation-sub-'));
    dirs.push(homeDir);
    const firstToken = tokenForSub('account-a', 'issued-one');
    const refreshedToken = tokenForSub('account-a', 'issued-two');
    const otherAccountToken = tokenForSub('account-b', 'issued-one');
    const first = createFreshProviderRecoveryReservationStore({ happyHomeDir: homeDir, serverId: 'server_a', token: firstToken });

    await expect(first.arm('sess_exact')).resolves.toEqual({ ok: true });
    expect(await createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir, serverId: 'server_a', token: refreshedToken,
    }).isReserved('sess_exact')).toBe(true);
    expect(await createFreshProviderRecoveryReservationStore({
      happyHomeDir: homeDir, serverId: 'server_a', token: otherAccountToken,
    }).isReserved('sess_exact')).toBe(false);
  });

  it('creates one durable local admission id under concurrent attempts, with private modes and no atomic residue', async () => {
    const reservations = await store();
    await reservations.arm('sess_exact');

    const attempts = await Promise.all(Array.from({ length: 8 }, async () => await reservations.prepareAdmission('sess_exact')));
    const localIds = attempts.flatMap((attempt) => attempt.ok && attempt.localId ? [attempt.localId] : []);
    expect(new Set(localIds).size).toBe(1);
    expect(localIds[0]).toMatch(/^[0-9a-f-]{36}$/);

    const filePath = reservations.filePathFor('sess_exact');
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(filePath))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('serializes generic lifecycle entry against arm and retains every failed completion across reload', async () => {
    const reservations = await store();
    let releaseGeneric: (() => void) | null = null;
    let markGenericEntered: (() => void) | null = null;
    const genericEntered = new Promise<void>((resolve) => { markGenericEntered = resolve; });
    const generic = reservations.withLifecycle('sess_race', async () => await new Promise<void>((resolve) => {
      releaseGeneric = resolve;
      markGenericEntered?.();
    }));
    await genericEntered;
    let armSettled = false;
    const arm = reservations.arm('sess_race').finally(() => { armSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(armSettled).toBe(false);
    releaseGeneric!();
    await generic;
    await expect(arm).resolves.toEqual({ ok: true });

    const attempt = await reservations.prepareAdmission('sess_race');
    expect(attempt).toMatchObject({ ok: true });
    const localId = attempt.ok ? attempt.localId! : '';
    await reservations.claim('sess_race', localId, 7);
    await expect(reservations.clearProven('sess_race', 'wrong_pending', 7)).resolves.toEqual({ ok: false, code: 'reservation_claim_mismatch' });
    const reloaded = createFreshProviderRecoveryReservationStore({
      happyHomeDir: reservations.happyHomeDir,
      serverId: 'server_a',
      token: tokenForSub('account-default', 'issued-reload-after-failure'),
    });
    expect(await reloaded.isReserved('sess_race')).toBe(true);
    await expect(reloaded.clearProven('sess_race', localId, 7)).resolves.toEqual({ ok: true });
    expect(await reloaded.isReserved('sess_race')).toBe(false);
  });

  it('retains an admission id across reload and refuses a different sole Pending claim', async () => {
    const reservations = await store();
    await reservations.arm('sess_exact');
    await reservations.prepareAdmission('sess_exact');
    const reloaded = createFreshProviderRecoveryReservationStore({
      happyHomeDir: reservations.happyHomeDir, serverId: 'server_a', token: tokenForSub('account-default', 'issued-retry'),
    });
    await expect(reloaded.claim('sess_exact', 'different_pending', 7)).resolves.toEqual({
      ok: false, code: 'reservation_claim_mismatch',
    });
    expect(await reloaded.isReserved('sess_exact')).toBe(true);
  });

  it('fails closed with reservation_corrupt when a persisted admission local id is malformed', async () => {
    const reservations = await store();
    await reservations.arm('sess_exact');
    const path = reservations.filePathFor('sess_exact');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...persisted, admissionLocalId: { invalid: true } }), { mode: 0o600 });

    await expect(reservations.prepareAdmission('sess_exact')).resolves.toEqual({
      ok: false, code: 'reservation_corrupt',
    });
  });
});
