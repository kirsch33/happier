import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { openConnectedServiceCredentialCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from './descriptors/connectedAccountDescriptors';
import {
  ConnectedServiceSpawnCredentialRefreshError,
  ConnectedServiceSpawnMaterializationError,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';
import { resolveClaudeCodeCredentialsFilePath } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import { normalizeMaterializationKeyForPath } from './materialize/normalizeMaterializationKeyForPath';

function resolveCodexHomeForMaterialization(baseDir: string, materializationKey: string): string {
  return join(baseDir, normalizeMaterializationKeyForPath(materializationKey), 'codex', 'codex-home');
}

async function readClaudeCodeNativeCredential(claudeConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8')) as Record<string, unknown>;
}

async function createIsolatedClaudeSourceEnv(): Promise<NodeJS.ProcessEnv> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-home-'));
  const claudeConfigDir = join(homeDir, '.claude');
  await mkdir(join(claudeConfigDir, 'projects'), { recursive: true });
  return {
    HOME: homeDir,
    USER: 'happier-test-user',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

describe('resolveConnectedServiceAuthForSpawn', () => {
  it('uses a preflight-refreshed expired Claude OAuth credential for materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const expiredExpiresAt = now - 1_000;
    const refreshedExpiresAt = now + 3_600_000;
    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: expiredExpiresAt,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: refreshedExpiresAt,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: refreshedRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: refreshedExpiresAt,
        expiryAgeMs: now - refreshedExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: expiredExpiresAt },
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'fresh-access',
        refreshToken: 'rotated-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('adopts a fresher managed Claude native credential into the relay before materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;
    const relayExpiresAt = now + 60_000;
    const nativeExpiresAt = now + 3_600_000;

    const relayRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: relayExpiresAt,
      oauth: {
        accessToken: 'relay-stale-access',
        refreshToken: 'relay-stale-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'greatwhitelab@gmail.com',
        raw: { claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } },
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: relayRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const stableClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    await mkdir(stableClaudeConfigDir, { recursive: true });
    await writeFile(
      resolveClaudeCodeCredentialsFilePath(stableClaudeConfigDir),
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'native-fresh-access',
          refreshToken: 'native-fresh-refresh',
          expiresAt: nativeExpiresAt,
          scopes: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE.split(' '),
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      })}\n`,
      { mode: 0o600 },
    );

    const registerConnectedServiceCredentialSealed = vi.fn(async (_params: unknown) => {});
    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'greatwhitelab@gmail.com',
          providerAccountId: 'acct',
          expiresAt: relayExpiresAt,
        },
      }),
      registerConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
    });

    expect(registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
    const firstRegisterCall = registerConnectedServiceCredentialSealed.mock.calls[0];
    expect(firstRegisterCall).toBeDefined();
    const registered = firstRegisterCall![0] as unknown as {
      sealed: { ciphertext: string };
      metadata: { expiresAt: number | null; providerEmail?: string | null; providerAccountId?: string | null };
    };
    expect(registered.metadata).toMatchObject({
      expiresAt: nativeExpiresAt,
      providerEmail: 'greatwhitelab@gmail.com',
      providerAccountId: 'acct',
    });
    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: registered.sealed.ciphertext,
    });
    expect(opened?.value).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: nativeExpiresAt,
      oauth: {
        accessToken: 'native-fresh-access',
        refreshToken: 'native-fresh-refresh',
        providerEmail: 'greatwhitelab@gmail.com',
        providerAccountId: 'acct',
      },
    });

    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBe(stableClaudeConfigDir);
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'native-fresh-access',
        refreshToken: 'native-fresh-refresh',
        expiresAt: nativeExpiresAt,
      },
    });
  });

  it('fails before spawning when materialized Claude native OAuth is expired and cannot be refreshed', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now - 1_000 },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
      diagnostic: expect.objectContaining({
        status: 'refresh_failed',
        category: 'provider_401',
        serviceId: 'claude-subscription',
        profileId: 'work',
      }),
    } satisfies Partial<ConnectedServiceSpawnCredentialRefreshError>);
  });

  it('uses a preflight-refreshed near-expiry OAuth credential for materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const nearExpiryExpiresAt = now + 30_000;
    const refreshedExpiresAt = now + 3_600_000;
    const nearExpiryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: nearExpiryExpiresAt,
      oauth: {
        accessToken: 'near-expiry-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: refreshedExpiresAt,
      oauth: {
        accessToken: 'near-expiry-fresh-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: nearExpiryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: refreshedRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: refreshedExpiresAt,
        expiryAgeMs: now - refreshedExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: nearExpiryExpiresAt },
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'near-expiry-fresh-access',
        refreshToken: 'rotated-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('forces spawn preflight refresh for future-dated Claude OAuth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const futureExpiresAt = now + 10 * 60_000;
    const futureRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: futureExpiresAt,
      oauth: {
        accessToken: 'future-access',
        refreshToken: 'future-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'forced-fresh-access',
        refreshToken: 'forced-fresh-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: futureRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: refreshedRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: refreshedRecord.expiresAt,
        expiryAgeMs: now - (refreshedRecord.expiresAt ?? now),
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: futureExpiresAt },
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'forced-fresh-access',
        refreshToken: 'forced-fresh-refresh',
      },
    });
  });

  it('blocks known reconnect-required credentials before spawn preflight expiry shortcuts', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const futureRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'stale-but-not-expiring-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: futureRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: futureRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: futureRecord.expiresAt,
        expiryAgeMs: now - (futureRecord.expiresAt ?? now),
        refreshWindowMs: 60_000,
      },
    }));
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
      })),
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: futureRecord.expiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
      diagnostic: {
        status: 'refresh_failed',
        category: 'invalid_grant',
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).not.toHaveBeenCalled();
  });

  it('fails closed before spawning Claude when OAuth materialization cannot write native credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const missingScopeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: missingScopeRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: missingScopeRecord.expiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnMaterializationError',
      agentId: 'claude',
      diagnostics: [
        expect.objectContaining({
          code: 'claude_subscription_missing_claude_code_scope',
          severity: 'blocking',
          serviceId: 'claude-subscription',
        }),
      ],
    });
  });

  it('switches a group binding when credential health marks the active profile reconnect-required', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'primary-stale-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'openai-codex' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: now + 3_600_000,
        },
      };
    });
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'not_needed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'backup',
        reason: 'spawn_preflight' as const,
        status: 'not_needed' as const,
        expiresAt: backupRecord.expiresAt,
        expiryAgeMs: now - (backupRecord.expiresAt ?? now),
        refreshWindowMs: 60_000,
      },
    }));
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      })),
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'not_needed' })),
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const authWithIdentitySelections = connectedServiceAuth as typeof connectedServiceAuth & Readonly<{
      runtimeAccountIdentitySelections?: ReadonlyArray<unknown>;
    }>;
    expect(authWithIdentitySelections.runtimeAccountIdentitySelections).toEqual([
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
        groupGeneration: 8,
        source: 'spawn_selection',
        record: backupRecord,
      }),
    ]);
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('returns a typed reconnect-required preflight error when central refresh cannot recover an expired credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const expiredExpiresAt = now - 1_000;
    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: expiredExpiresAt,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: expiredExpiresAt,
        expiryAgeMs: now - expiredExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: expiredExpiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
  });

  it('switches a group binding after the active profile permanently fails spawn preflight refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-expired-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;

    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'provider_401' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'primary',
      generation: 7,
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'openai-codex' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn, switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('surfaces the group fallback status when active credential refresh fails but the group cannot switch', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'leeroy-acct',
        providerEmail: null,
      },
    });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: activeRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'leeroy',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switch_reason_disabled' as const,
      generation: 3,
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'claude-subscription',
        groupId: 'claude',
        displayName: null,
        activeProfileId: 'leeroy',
        generation: 3,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: false,
            accountChanged: true,
            refreshFailure: false,
          },
        },
        state: { v: 1 },
        members: [{
          v: 1,
          serviceId: 'claude-subscription',
          groupId: 'claude',
          profileId: 'leeroy',
          enabled: true,
          priority: 100,
          state: { v: 1 },
          createdAt: 1,
          updatedAt: 1,
        }],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'leeroy-acct', expiresAt: now - 1_000 },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(),
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnGroupSwitchUnavailableError',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'leeroy',
      status: 'switch_reason_disabled',
    });
  });

  it('observes a newer group active profile when spawn fallback reports no eligible member from stale state', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const limitedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'limited',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'limited-expired-access',
        refreshToken: 'limited-refresh',
        idToken: 'limited-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'limited-acct',
        providerEmail: null,
      },
    });
    const exhaustedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'already-exhausted',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'exhausted-access',
        refreshToken: 'exhausted-refresh',
        idToken: 'exhausted-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'exhausted-acct',
        providerEmail: null,
      },
    });
    const eligibleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'eligible',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'eligible-access',
        refreshToken: 'eligible-refresh',
        idToken: 'eligible-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'eligible-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof limitedRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const recordsByProfileId = new Map([
      ['limited', limitedRecord],
      ['already-exhausted', exhaustedRecord],
      ['eligible', eligibleRecord],
    ]);
    const ciphertextByProfileId = new Map([
      ['limited', seal(limitedRecord)],
      ['already-exhausted', seal(exhaustedRecord)],
      ['eligible', seal(eligibleRecord)],
    ]);

    let activeProfileId = 'limited';
    let generation = 7;
    const groupPolicy = {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
      switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: true,
      },
    };
    const groupMembers = () => [
      {
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-divergence',
        profileId: 'limited',
        enabled: true,
        priority: 1,
        state: { v: 1 as const },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-divergence',
        profileId: 'already-exhausted',
        enabled: true,
        priority: 2,
        state: { v: 1 as const, quotaExhaustedUntilMs: now + 60_000 },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-divergence',
        profileId: 'eligible',
        enabled: true,
        priority: 3,
        state: { v: 1 as const },
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-divergence',
      displayName: null,
      activeProfileId,
      generation,
      policy: groupPolicy,
      state: { v: 1 as const },
      members: groupMembers(),
      createdAt: 1,
      updatedAt: 1,
    }));
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      const record = recordsByProfileId.get(params.profileId);
      if (params.serviceId !== 'openai-codex' || !ciphertext || !record) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: record.expiresAt,
        },
      };
    });
    const switchBeforeTurn = vi.fn(async () => ({ status: 'session_not_found' as const }));
    const switchAfterClassifiedFailure = vi.fn(async () => {
      activeProfileId = 'eligible';
      generation = 8;
      return {
        status: 'no_eligible_member' as const,
        generation,
        retryAtMs: null,
        excluded: [
          { profileId: 'already-exhausted', reason: 'quota_exhausted', retryAtMs: now + 60_000 },
        ],
      };
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async (
      params: { serviceId: 'openai-codex'; profileId: string },
    ) => {
      const record = recordsByProfileId.get(params.profileId) ?? null;
      if (params.profileId === 'limited') {
        return {
          status: 'refresh_failed' as const,
          credential: null,
          diagnostic: {
            serviceId: 'openai-codex' as const,
            profileId: 'limited',
            reason: 'spawn_preflight' as const,
            status: 'refresh_failed' as const,
            category: 'provider_401' as const,
            expiresAt: limitedRecord.expiresAt,
            expiryAgeMs: now - (limitedRecord.expiresAt ?? now),
            refreshWindowMs: 60_000,
          },
        };
      }
      return {
        status: 'not_needed' as const,
        credential: null,
        diagnostic: {
          serviceId: 'openai-codex' as const,
          profileId: params.profileId,
          reason: 'spawn_preflight' as const,
          status: 'not_needed' as const,
          expiresAt: record?.expiresAt ?? null,
          expiryAgeMs: typeof record?.expiresAt === 'number' ? now - record.expiresAt : null,
          refreshWindowMs: 60_000,
        },
      };
    });
    const api = {
      getConnectedServiceAuthGroup,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-divergence',
            profileId: 'limited',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn,
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-divergence',
      reason: 'soft_threshold',
    });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-divergence',
      reason: 'refresh_failed',
      observedProfileId: 'limited',
    }));
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledTimes(2);
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'eligible',
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'eligible',
    });
    expect(connectedServiceAuth?.connectedServicesBindings.bindingsByServiceId['openai-codex']).toMatchObject({
      source: 'connected',
      selection: 'group',
      groupId: 'codex-divergence',
      profileId: 'eligible',
    });
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('eligible-access');
  });

  it('keeps the real group switch coordinator bound when default auto fallback handles spawn preflight refresh failure', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    let activeProfileId = 'primary';
    let generation = 7;
    const groupMembers = () => [
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: { v: 1 as const },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'backup',
        enabled: true,
        priority: 2,
        state: { v: 1 as const },
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const groupPolicy = {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
    };
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      displayName: null,
      activeProfileId,
      generation,
      policy: groupPolicy,
      state: { v: 1 as const },
      members: groupMembers(),
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => await getConnectedServiceAuthGroup());
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'primary',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'backup',
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('continues group fallback when the first switched Claude profile cannot materialize native auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const narrowRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'narrow-acct',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'healthy-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof narrowRecord | typeof healthyRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['narrow', seal(narrowRecord)],
      ['healthy', seal(healthyRecord)],
    ]);

    let activeProfileId = 'primary';
    let generation = 7;
    const credentialHealthByProfileId = new Map<string, 'connected' | 'needs_reauth'>([
      ['primary', 'connected'],
      ['narrow', 'connected'],
      ['healthy', 'connected'],
    ]);
    const memberStatesByProfileId = new Map<string, unknown>([
      ['primary', { v: 1 as const }],
      ['narrow', { v: 1 as const }],
      ['healthy', { v: 1 as const }],
    ]);
    const groupMembers = () => [
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: memberStatesByProfileId.get('primary') as { v: 1 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'narrow',
        enabled: true,
        priority: 2,
        state: memberStatesByProfileId.get('narrow') as { v: 1 },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'healthy',
        enabled: true,
        priority: 3,
        state: memberStatesByProfileId.get('healthy') as { v: 1 },
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const groupPolicy = {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
      switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: true,
      },
    };
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      displayName: null,
      activeProfileId,
      generation,
      policy: groupPolicy,
      state: { v: 1 as const },
      members: groupMembers(),
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async (params: {
      memberStates: ReadonlyArray<Readonly<{ profileId: string; state: unknown }>>;
    }) => {
      for (const memberState of params.memberStates) {
        memberStatesByProfileId.set(memberState.profileId, memberState.state);
      }
      return await getConnectedServiceAuthGroup();
    });
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async (params: {
      profileId: string;
      health: { status: 'connected' | 'needs_reauth' };
    }) => {
      credentialHealthByProfileId.set(params.profileId, params.health.status);
    });
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'claude-subscription' as const,
      profiles: [
        { profileId: 'primary', status: credentialHealthByProfileId.get('primary') ?? 'connected' },
        { profileId: 'narrow', status: credentialHealthByProfileId.get('narrow') ?? 'connected' },
        { profileId: 'healthy', status: credentialHealthByProfileId.get('healthy') ?? 'connected' },
      ],
    }));
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      updateConnectedServiceCredentialHealth,
      listConnectedServiceProfiles,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId === 'primary') {
        credentialHealthByProfileId.set('primary', 'needs_reauth');
      }
      return {
        status: params.profileId === 'primary' ? 'refresh_failed' as const : 'not_needed' as const,
        credential: null,
        diagnostic: {
          serviceId: 'claude-subscription' as const,
          profileId: params.profileId,
          reason: 'spawn_preflight' as const,
          status: params.profileId === 'primary' ? 'refresh_failed' as const : 'not_needed' as const,
          ...(params.profileId === 'primary' ? { category: 'invalid_grant' as const } : {}),
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
          expiryAgeMs: params.profileId === 'primary' ? 1_000 : null,
          refreshWindowMs: 60_000,
        },
      };
    });

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'narrow',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenNthCalledWith(2, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'healthy',
    }));
    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      memberStates: [expect.objectContaining({ profileId: 'narrow' })],
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('continues materialization-failure group fallback through multiple unusable Claude profiles', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const narrowRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:profile',
        tokenType: 'Bearer',
        providerAccountId: 'narrow-acct',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'healthy-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacySecret = credentials.encryption.secret;
    const seal = (payload: typeof primaryRecord | typeof narrowRecord | typeof healthyRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['narrow', seal(narrowRecord)],
      ['healthy', seal(healthyRecord)],
    ]);

    const activeProfiles = ['narrow', 'healthy'];
    const switchAfterClassifiedFailure = vi.fn(async () => {
      const next = activeProfiles.shift();
      return {
        status: next ? 'switched' as const : 'no_candidate' as const,
        activeProfileId: next ?? null,
        generation: next === 'narrow' ? 8 : 9,
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1 as const,
          strategy: 'priority' as const,
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 as const },
        members: [
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 as const },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'narrow',
            enabled: true,
            priority: 2,
            state: { v: 1 as const },
            createdAt: 2,
            updatedAt: 2,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'healthy',
            enabled: true,
            priority: 3,
            state: { v: 1 as const },
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      })),
      updateConnectedServiceCredentialHealth,
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = ciphertextByProfileId.get(params.profileId);
        if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth' as const,
            providerEmail: null,
            providerAccountId: `${params.profileId}-acct`,
            expiresAt: null,
          },
        };
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchAfterClassifiedFailure,
        switchBeforeTurn: vi.fn(async () => ({ status: 'no_candidate', activeProfileId: null })),
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'narrow',
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'primary',
      health: expect.objectContaining({
        status: 'needs_reauth',
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      health: expect.objectContaining({
        status: 'needs_reauth',
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('switches a Claude group when the active middle-priority member has a permanent preflight refresh failure', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'leeroy-expired-access',
        refreshToken: 'leeroy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'leeroy-acct',
        providerEmail: null,
      },
    });
    const fallbackRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'batiplus',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'batiplus-access',
        refreshToken: 'batiplus-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'batiplus-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof activeRecord | typeof fallbackRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['leeroy', seal(activeRecord)],
      ['batiplus', seal(fallbackRecord)],
    ]);

    let activeProfileId = 'leeroy';
    let generation = 3;
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'claude',
      displayName: null,
      activeProfileId,
      generation,
      policy: {
        v: 1 as const,
        strategy: 'priority' as const,
        autoSwitch: true,
        switchOn: {
          usageLimit: true,
          authExpired: true,
          accountChanged: true,
          refreshFailure: false,
        },
      },
      state: { v: 1 as const },
      members: [
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'batiplus',
          enabled: true,
          priority: 100,
          state: { v: 1 as const },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'leeroy',
          enabled: true,
          priority: 100,
          state: {
            v: 1 as const,
            lastFailureKind: 'refresh_failed',
            lastObservedAtMs: now - 500,
          },
          createdAt: 2,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'leeroy_batiplus',
          enabled: true,
          priority: 100,
          state: { v: 1 as const },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => await getConnectedServiceAuthGroup());
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'leeroy' ? now - 1_000 : null,
        },
      };
    });
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'leeroy',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'claude',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'batiplus',
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'batiplus-access',
        refreshToken: 'batiplus-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('fetches, decrypts, and materializes auth for a spawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'work') return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      resolveCodexHomeForMaterialization(baseDir, 'session-1'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('access');
  });

  it('resolves group bindings through the server active profile and materializes the group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceAuthGroup: async (params: { serviceId: string; groupId: string }) => {
        expect(params).toEqual({ serviceId: 'openai-codex', groupId: 'main' });
        return {
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          generation: 7,
          policy: { v: 1, strategy: 'priority' },
        };
      },
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'backup') return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'backup-acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'fallback',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      resolveCodexHomeForMaterialization(baseDir, 'session-1'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('rejects group bindings when the current server group has no active profile instead of using the UI fallback', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: null,
        generation: 7,
        policy: { v: 1, strategy: 'priority' },
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'stale-ui-fallback',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    })).rejects.toThrow(/active profile/i);

    expect((api as unknown as { getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn> }).getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('switches exhausted group active profile before materializing spawn auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      activeProfileId: 'backup',
      generation: 8,
      policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
      state: { v: 1 },
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'primary',
          enabled: true,
          priority: 1,
          state: { v: 1, quotaExhaustedUntilMs: 5_000 },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'backup',
          enabled: true,
          priority: 2,
          state: { v: 1 },
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }));
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1, quotaExhaustedUntilMs: 5_000 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      updateConnectedServiceAuthGroupActiveProfile,
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    const connectedServiceAuth = await resolveWithCoordinator({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    });

    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('delegates stale group quota probing to the pre-turn coordinator before materializing spawn auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(18) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          probeIfSnapshotOlderThanMs: 60_000,
          preTurnProbeMode: 'when_stale',
          preTurnProbeOrder: 'current_first_then_candidates',
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    const connectedServiceAuth = await resolveWithCoordinator({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000_000,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    });

    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('suppresses spawn-time group switching while matching runtime-auth recovery is still pending', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(18) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const softSwitchRecoveryGuard = vi.fn(async () => ({
      status: 'suppress' as const,
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          probeIfSnapshotOlderThanMs: 60_000,
          preTurnProbeMode: 'when_stale',
          preTurnProbeOrder: 'current_first_then_candidates',
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        softSwitchRecoveryGuard: typeof softSwitchRecoveryGuard;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    const connectedServiceAuth = await resolveWithCoordinator({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000_000,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn },
      softSwitchRecoveryGuard,
    });

    expect(softSwitchRecoveryGuard).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      reason: 'soft_threshold',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('primary-access');
  });

  it('allows spawn-time soft-threshold group switching for Claude sessions before any live runtime exists (RD-QUO-10)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();
    const now = 1_000_000;
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: 'primary',
        fetchedAt: now,
        staleAfterMs: 60_000,
        planLabel: 'Pro',
        accountLabel: 'primary@example.com',
        meters: [
          {
            meterId: 'monthly',
            label: 'Monthly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      },
    });
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: 'backup',
        fetchedAt: now,
        staleAfterMs: 60_000,
        planLabel: 'Pro',
        accountLabel: 'backup@example.com',
        meters: [
          {
            meterId: 'monthly',
            label: 'Monthly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 40,
            remainingPct: 60,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'claude-subscription',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          probeIfSnapshotOlderThanMs: 60_000,
          preTurnProbeMode: 'when_stale',
          preTurnProbeOrder: 'current_first_then_candidates',
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'claude-subscription') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    let connectedServiceAuth: Awaited<ReturnType<typeof resolveWithCoordinator>>;
    try {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
      }
      connectedServiceAuth = await resolveWithCoordinator({
        agentId: 'claude',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'group',
              groupId: 'main',
              profileId: 'primary',
            },
          },
        },
        materializationKey: 'session-1',
        activeServerDir,
        baseDir,
        credentials,
        api,
        runtimeQuotaSnapshots,
        quotaFreshnessMs: 60_000,
        nowMs: () => now,
        processEnv,
        sessionId: 'session-1',
        authGroupSwitchCoordinator: { switchBeforeTurn },
      });
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      reason: 'soft_threshold',
      sessionId: 'session-1',
    }));
    expect(connectedServiceAuth).not.toBeNull();
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
      },
    });
  });

  it('performs no pre-spawn group switch when no switch coordinator is injected (RD-SW-4: switches only go through the coordinator FSM)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(10) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });

    class NoCoordinatorApi {
      readonly credential = { token: 'happy-token' };
      updateRequest: Readonly<{
        serviceId: string;
        groupId: string;
        activeProfileId: string;
        expectedGeneration?: number;
      }> | null = null;

      async getConnectedServiceAuthGroup() {
        return {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          displayName: null,
          activeProfileId: 'primary',
          generation: 7,
          policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
          state: { v: 1 },
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'primary',
              enabled: true,
              priority: 1,
              state: { v: 1, quotaExhaustedUntilMs: 5_000 },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'backup',
              enabled: true,
              priority: 2,
              state: { v: 1 },
              createdAt: 2,
              updatedAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        };
      }

      async updateConnectedServiceAuthGroupActiveProfile(params: Readonly<{
        serviceId: string;
        groupId: string;
        activeProfileId: string;
        expectedGeneration?: number;
      }>) {
        this.updateRequest = params;
        throw new Error('direct active-profile writes must not happen without the switch coordinator (RD-SW-4)');
      }

      async getConnectedServiceCredentialSealed(params: { serviceId: string; profileId: string }) {
        if (params.serviceId !== 'openai-codex' || params.profileId !== 'primary') return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: { kind: 'oauth' as const, providerEmail: null, providerAccountId: 'primary-acct', expiresAt: null },
        };
      }
    }

    const api = new NoCoordinatorApi();
    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api: api as unknown as ApiClient,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
    });

    // Without an injected coordinator there is no sanctioned switching mechanism: the spawn keeps
    // the server-side active member even when it looks exhausted, instead of running a lease-less,
    // event-less parallel switch through the raw API (RD-SW-4).
    expect(api.updateRequest).toBeNull();
    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth?.connectedServicesBindings).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'main',
          profileId: 'primary',
        },
      },
    });
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('primary-access');
  });
});
