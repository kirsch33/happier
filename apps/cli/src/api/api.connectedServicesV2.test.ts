import { describe, expect, it, vi, beforeEach } from 'vitest';

import axios from 'axios';
import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('ApiClient connected services v2', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockPost.mockReset();
    mockGet.mockReset();
    vi.clearAllMocks();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('posts sealed quota snapshots to the v2 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
      metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('cXVvdGEtY2lwaGVydGV4dA==');
  });

  it('uses the connected-service credential timeout default for sealed credential reads', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
        metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toMatchObject({
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
    });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
        timeout: 20_000,
      }),
    );
  });

  it('uses the connected-service HTTP timeout override for sealed credential reads', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICE_HTTP_TIMEOUT_MS', '45000');
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
        metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toMatchObject({
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
    });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        timeout: 45_000,
      }),
    );
  });

  it('gets sealed quota snapshots from the v2 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res?.sealed?.ciphertext).toBe('cXVvdGEtY2lwaGVydGV4dA==');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('returns null for missing sealed quota snapshots', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'connect_quota_snapshot_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toBeNull();
  });

  it.each([401, 403] as const)('classifies auth quota write failures by status %i', async (status) => {
    mockPost.mockRejectedValue(createAxiosResponseError({
      status,
      data: { error: 'not_authenticated' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGE=' },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'auth',
      status,
      retryable: false,
      quotaFetchErrorCode: 'auth_failure',
    });
  });

  it('preserves retry-after timing for quota rate limits', async () => {
    const cause = createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '7' },
    });
    mockPost.mockRejectedValue(cause);

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.registerConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGE=' },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: 429,
      retryable: true,
      retryAfterMs: 7_000,
      cause,
    });
  });

  it('classifies server quota failures as retryable while preserving status', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: 503,
      retryable: true,
    });
  });

  it('resolves machine SCM credentials from the primary connected profile when multiple profiles are available', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'github-work-access-token',
        refreshToken: 'github-work-refresh-token',
        idToken: null,
        scope: 'repo read:user',
        tokenType: 'Bearer',
        providerAccountId: '42',
        providerEmail: 'work@example.com',
      },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: createTestCredentials().encryption,
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });

    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v2/connect/github/profiles/work/credential')) {
        return {
          status: 200,
          data: {
            sealed: { format: 'account_scoped_v1', ciphertext },
            metadata: {
              kind: 'oauth',
              providerEmail: 'work@example.com',
              providerAccountId: '42',
            },
          },
        };
      }

      if (url.includes('/v2/connect/github/profiles')) {
        return {
          status: 200,
          data: {
            serviceId: 'github',
            profiles: [
              { profileId: 'work', status: 'connected', kind: 'oauth' },
              { profileId: 'personal', status: 'connected', kind: 'token' },
            ],
          },
        };
      }

      return {
        status: 404,
        data: { error: 'connect_credential_not_found' },
      };
    });

    const api = await ApiClient.create(createTestCredentials());
    const resolver = (
      api as unknown as { createConnectedAccountCredentialResolver(): ScmConnectedAccountCredentialResolver }
    ).createConnectedAccountCredentialResolver();

    await expect(resolver.resolveCredential('github')).resolves.toMatchObject({
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
    });
    const requestedUrls = mockGet.mock.calls.map((call) => String(call[0]));
    expect(requestedUrls).toEqual(expect.arrayContaining([
      expect.stringContaining('/v1/account/encryption'),
      expect.stringContaining('/v2/connect/github/profiles'),
      expect.stringContaining('/v2/connect/github/profiles/work/credential'),
    ]));
  });

  it('accepts all connected-service profile health statuses from the server', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'connected', status: 'connected', kind: 'oauth' },
          { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
          { profileId: 'refreshing', status: 'refreshing', kind: 'oauth' },
          { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
        ],
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toEqual({
      serviceId: 'openai-codex',
      profiles: [
        expect.objectContaining({ profileId: 'connected', status: 'connected' }),
        expect.objectContaining({ profileId: 'reauth', status: 'needs_reauth' }),
        expect.objectContaining({ profileId: 'refreshing', status: 'refreshing' }),
        expect.objectContaining({ profileId: 'retryable', status: 'refresh_failed_retryable' }),
      ],
    });
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles'),
      expect.objectContaining({
        timeout: 20_000,
      }),
    );
  });

  it('shares concurrent and fresh connected-service profile list requests', async () => {
    let resolveProfiles: ((value: unknown) => void) | undefined;
    mockGet.mockReturnValueOnce(new Promise((resolve) => {
      resolveProfiles = resolve;
    }));

    const api = await ApiClient.create(createTestCredentials());

    const first = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });
    const second = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });

    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveProfiles?.({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'connected', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(first).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    await expect(second).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'fresh', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('invalidates connected-service profile list cache after sealed credential writes', async () => {
    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'old', status: 'connected', kind: 'oauth' }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new', status: 'connected', kind: 'oauth' }],
        },
      });
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'old' })],
    });

    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'new',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'new' })],
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
