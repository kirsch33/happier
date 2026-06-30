import axios from 'axios';
import { z } from 'zod';

import {
  AccountEncryptionModeResponseSchema,
  ConnectedServiceAuthGroupErrorResponseV1Schema,
  ConnectedServiceAuthGroupResponseV1Schema,
  ConnectedServiceCredentialRecordV1Schema,
  SealedConnectedServiceCredentialV1Schema,
  StoredJsonContentEnvelopeSchema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

import { createHttpStatusError } from '../client/httpStatusError';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';

const DEFAULT_CONNECTED_SERVICE_HTTP_TIMEOUT_MS = 20_000;
const CONNECTED_SERVICE_HTTP_TIMEOUT_ENV = 'HAPPIER_CONNECTED_SERVICE_HTTP_TIMEOUT_MS';

export function readConnectedServiceHttpTimeoutMs(): number {
  const raw = process.env[CONNECTED_SERVICE_HTTP_TIMEOUT_ENV]?.trim()
    ?? process.env.HAPPIER_CONNECTED_SERVICE_CREDENTIAL_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CONNECTED_SERVICE_HTTP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONNECTED_SERVICE_HTTP_TIMEOUT_MS;
  }
  return Math.trunc(parsed);
}

export class ConnectedServiceAuthGroupGenerationConflictError extends Error {
  constructor(public readonly generation: number) {
    super('connected_service_auth_group_generation_conflict');
  }
}

export class ConnectedServiceCredentialUnsupportedFormatError extends Error {
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(serviceId: ConnectedServiceId, profileId: string) {
    super(`Connected service credential is in an unsupported legacy format (${serviceId}/${profileId}). Reconnect it in Happier.`);
    this.name = 'ConnectedServiceCredentialUnsupportedFormatError';
    this.serviceId = serviceId;
    this.profileId = profileId;
  }
}

export type ConnectedServiceCredentialSealedResponse = Readonly<{
  sealed: SealedConnectedServiceCredentialV1;
  metadata: {
    kind: 'oauth' | 'token';
    providerEmail?: string | null;
    providerAccountId?: string | null;
    expiresAt?: number | null;
  };
}>;

export type ConnectedServiceCredentialPlainResponse = Readonly<{
  content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
}>;

export type ConnectedServiceCredentialApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<'e2ee' | 'plain' | 'unknown'>;
  getConnectedServiceCredentialSealed: (params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }) => Promise<ConnectedServiceCredentialSealedResponse | null>;
  getConnectedServiceCredentialPlain?: (params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }) => Promise<ConnectedServiceCredentialPlainResponse | null>;
}>;

export type ConnectedServiceAuthGroupApi = Readonly<{
  getConnectedServiceAuthGroup: (params: {
    serviceId: ConnectedServiceId;
    groupId: string;
  }) => Promise<ConnectedServiceAuthGroupV1 | null>;
}>;

function authHeaders(token: string): Readonly<Record<string, string>> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function readAxiosStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

function readAxiosErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  return typeof rec.error === 'string' ? rec.error : undefined;
}

function throwConnectedServiceGroupGenerationConflictIfPresent(error: unknown): void {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return;
  const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
  if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
    throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
  }
}

function createCausePreservingError(message: string, cause: unknown): Error {
  const wrapped = new Error(message, { cause }) as Error & { code?: string };
  const causeRecord = typeof cause === 'object' && cause !== null ? cause as Record<string, unknown> : null;
  const code = causeRecord?.code;
  if (typeof code === 'string' && code.length > 0) {
    wrapped.code = code;
  }
  return wrapped;
}

export function createConnectedServiceCredentialApi(
  credentials: Credentials,
): ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi {
  const token = credentials.token;

  return {
    getAccountEncryptionMode: async () => getAccountEncryptionMode({ token }),
    getConnectedServiceCredentialSealed: async (params) => getConnectedServiceCredentialSealed({ token, ...params }),
    getConnectedServiceCredentialPlain: async (params) => getConnectedServiceCredentialPlain({ token, ...params }),
    getConnectedServiceAuthGroup: async (params) => getConnectedServiceAuthGroup({ token, ...params }),
  };
}

export async function getAccountEncryptionMode(params: Readonly<{
  token: string;
}>): Promise<'e2ee' | 'plain' | 'unknown'> {
  const serverUrl = resolveServerHttpBaseUrl();
  try {
    const response = await axios.get(
      `${serverUrl}/v1/account/encryption`,
      {
        headers: authHeaders(params.token),
        timeout: readConnectedServiceHttpTimeoutMs(),
      },
    );
    if (response.status === 404) return 'e2ee';
    if (response.status !== 200) return 'unknown';
    const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
    if (!parsed.success) return 'unknown';
    return parsed.data.mode === 'plain' ? 'plain' : 'e2ee';
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    if (status === 404) return 'e2ee';
    logger.debug(`[API] [ERROR] Failed to get account encryption mode:`, serializeAxiosErrorForLog(error));
    return 'unknown';
  }
}

export async function getConnectedServiceCredentialSealed(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<ConnectedServiceCredentialSealedResponse | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const profileId = encodeURIComponent(params.profileId);

  try {
    const response = await axios.get(
      `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
      {
        headers: authHeaders(params.token),
        timeout: readConnectedServiceHttpTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }

    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service credential response');
    }

    const sealedParsed = SealedConnectedServiceCredentialV1Schema.safeParse((raw as Record<string, unknown>).sealed);
    if (!sealedParsed.success) {
      throw new Error('Invalid connected service credential response');
    }

    const metadataParsed = z.object({
      kind: z.enum(['oauth', 'token']),
      providerEmail: z.string().nullable().optional(),
      providerAccountId: z.string().nullable().optional(),
      expiresAt: z.number().nullable().optional(),
    }).safeParse((raw as Record<string, unknown>).metadata);

    if (!metadataParsed.success) {
      throw new Error('Invalid connected service credential response');
    }

    return { sealed: sealedParsed.data, metadata: metadataParsed.data };
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    const code = readAxiosErrorCode(error);
    if (status === 404) {
      return null;
    }
    if (status === 409 && code === 'connect_credential_unsupported_format') {
      throw new ConnectedServiceCredentialUnsupportedFormatError(params.serviceId, params.profileId);
    }
    logger.debug(`[API] [ERROR] Failed to get connected service credential:`, serializeAxiosErrorForLog(error));
    throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getConnectedServiceCredentialPlain(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<ConnectedServiceCredentialPlainResponse | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const profileId = encodeURIComponent(params.profileId);

  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
      {
        headers: authHeaders(params.token),
        timeout: readConnectedServiceHttpTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service credential response');
    }

    const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as Record<string, unknown>).content);
    if (!contentParsed.success || contentParsed.data.t !== 'plain') {
      throw new Error('Invalid connected service credential response');
    }

    const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(contentParsed.data.v);
    if (!recordParsed.success) {
      throw new Error('Invalid connected service credential response');
    }

    return { content: { t: 'plain', v: recordParsed.data } };
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    const code = readAxiosErrorCode(error);
    if (status === 404) {
      return null;
    }
    if (status === 409 && code === 'connect_credential_unsupported_format') {
      return null;
    }
    logger.debug(`[API] [ERROR] Failed to get connected service credential (v3):`, serializeAxiosErrorForLog(error));
    throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getConnectedServiceAuthGroup(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>): Promise<ConnectedServiceAuthGroupV1 | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const groupId = encodeURIComponent(params.groupId);

  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}`,
      {
        headers: authHeaders(params.token),
        timeout: readConnectedServiceHttpTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service auth group response');
    }
    return parsed.data.group;
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    if (status === 404) return null;
    logger.debug(`[API] [ERROR] Failed to get connected service auth group:`, serializeAxiosErrorForLog(error));
    if (typeof status === 'number' && Number.isFinite(status)) {
      throw createHttpStatusError(
        status,
        `Failed to get connected service auth group (${status})`,
      );
    }
    throw createCausePreservingError(
      `Failed to get connected service auth group: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error,
    );
  }
}
