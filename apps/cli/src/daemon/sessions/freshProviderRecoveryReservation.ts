import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { readAccountIdFromToken } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';

type Reservation = Readonly<{
  v: 1;
  serverId: string;
  accountFingerprint: string;
  sessionId: string;
  admissionLocalId?: string;
  requestId?: string;
  pendingVersion?: number;
}>;
type ReservationFailureCode = 'reservation_scope_invalid' | 'reservation_missing' | 'reservation_corrupt' | 'reservation_already_armed' | 'reservation_claim_mismatch';
type ReservationResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: ReservationFailureCode }>;

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function valid(value: unknown, serverId: string, accountFingerprint: string, sessionId: string): value is Reservation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.v === 1 && item.serverId === serverId && item.accountFingerprint === accountFingerprint && item.sessionId === sessionId
    && (item.requestId === undefined || typeof item.requestId === 'string')
    && (item.admissionLocalId === undefined || (typeof item.admissionLocalId === 'string' && item.admissionLocalId.trim().length > 0))
    && (item.pendingVersion === undefined || (typeof item.pendingVersion === 'number' && Number.isSafeInteger(item.pendingVersion)));
}

export function createFreshProviderRecoveryReservationStore(params: Readonly<{ happyHomeDir: string; serverId: string; token: string }>) {
  const serverId = params.serverId.trim().toLowerCase();
  const accountId = readAccountIdFromToken(params.token);
  const accountFingerprint = accountId ? digest(accountId) : null;
  const root = join(params.happyHomeDir, 'fresh-provider-recovery-reservations', digest(`${serverId}:${accountFingerprint ?? 'invalid-scope'}`));
  const filePathFor = (sessionId: string) => join(root, `${digest(sessionId)}.json`);
  const withLock = async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => await withJsonOwnerFileLock({
    lockPath: `${filePathFor(sessionId)}.lock`, timeoutMs: 10_000, staleAfterMs: 30_000, errorCode: 'fresh_provider_recovery_reservation_lock_timeout',
  }, action);
  const read = (sessionId: string): Reservation | 'corrupt' | null => {
    const path = filePathFor(sessionId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return accountFingerprint && valid(parsed, serverId, accountFingerprint, sessionId) ? parsed : 'corrupt';
    } catch { return 'corrupt'; }
  };
  const write = async (sessionId: string, value: Reservation): Promise<void> => {
    const path = filePathFor(sessionId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => {});
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, path); await chmod(path, 0o600).catch(() => {}); }
    finally { await unlink(tmp).catch(() => {}); }
  };
  return {
    happyHomeDir: params.happyHomeDir,
    filePathFor,
    isReserved: async (sessionId: string): Promise<boolean> => accountFingerprint !== null && read(sessionId) !== null,
    withLifecycle: async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => await withLock(sessionId, action),
    arm: async (sessionId: string): Promise<ReservationResult> => await withLock(sessionId, async () => {
      if (!accountFingerprint) return { ok: false, code: 'reservation_scope_invalid' };
      if (read(sessionId) !== null) return { ok: false, code: 'reservation_already_armed' };
      await write(sessionId, { v: 1, serverId, accountFingerprint, sessionId });
      return { ok: true };
    }),
    prepareAdmission: async (sessionId: string): Promise<ReservationResult & Readonly<{ localId?: string }>> => await withLock(sessionId, async () => {
      if (!accountFingerprint) return { ok: false, code: 'reservation_scope_invalid' };
      const current = read(sessionId);
      if (current === null) return { ok: false, code: 'reservation_missing' };
      if (current === 'corrupt') return { ok: false, code: 'reservation_corrupt' };
      if (current.requestId !== undefined || current.pendingVersion !== undefined) return { ok: false, code: 'reservation_claim_mismatch' };
      if (current.admissionLocalId) return { ok: true, localId: current.admissionLocalId };
      const localId = randomUUID();
      await write(sessionId, { ...current, admissionLocalId: localId });
      return { ok: true, localId };
    }),
    claim: async (sessionId: string, requestId: string, pendingVersion: number): Promise<ReservationResult> => await withLock(sessionId, async () => {
      const current = read(sessionId);
      if (current === null) return { ok: false, code: 'reservation_missing' };
      if (current === 'corrupt') return { ok: false, code: 'reservation_corrupt' };
      if (current.requestId !== undefined || current.pendingVersion !== undefined) {
        return current.requestId === requestId && current.pendingVersion === pendingVersion
          ? { ok: true }
          : { ok: false, code: 'reservation_claim_mismatch' };
      }
      if (current.admissionLocalId !== undefined && current.admissionLocalId !== requestId) {
        return { ok: false, code: 'reservation_claim_mismatch' };
      }
      await write(sessionId, { ...current, requestId, pendingVersion });
      return { ok: true };
    }),
    clearProven: async (sessionId: string, requestId: string, pendingVersion: number): Promise<ReservationResult> => await withLock(sessionId, async () => {
      const current = read(sessionId);
      if (current === null) return { ok: false, code: 'reservation_missing' };
      if (current === 'corrupt') return { ok: false, code: 'reservation_corrupt' };
      if (current.requestId !== requestId || current.pendingVersion !== pendingVersion) return { ok: false, code: 'reservation_claim_mismatch' };
      await unlink(filePathFor(sessionId));
      return { ok: true };
    }),
  };
}
