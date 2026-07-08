import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import {
  buildConnectedServiceCredentialRecord,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { resolveClaudeConnectedServiceStableConfigDir } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceStableAuthDir';
import {
  parseClaudeCodeNativeCredentialPayload,
  resolveClaudeCodeCredentialsFilePath,
} from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import { findMissingClaudeCodeCredentialScopes } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialScopes';

import type { ConnectedServiceResolvedSelection } from './materialize/materializeConnectedServicesForSpawn';

type RegisterConnectedServiceCredentialSealedApi = Readonly<{
  registerConnectedServiceCredentialSealed?: ApiClient['registerConnectedServiceCredentialSealed'];
}>;

type LocalNativeCredentialCandidate = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  mtimeMs: number;
}>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveOauthScope(scopes: readonly string[]): string | null {
  return scopes.length > 0 ? scopes.join(' ') : null;
}

function credentialsMaterial(credentials: Credentials) {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy' as const, secret: credentials.encryption.secret }
    : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
}

function readClaudeSubscriptionProfileId(selection: ConnectedServiceResolvedSelection): string | null {
  if (selection.serviceId !== 'claude-subscription') return null;
  return selection.kind === 'group' ? selection.activeProfileId : selection.profileId;
}

async function readLocalNativeCredentialCandidate(params: Readonly<{
  activeServerDir: string;
  selection: ConnectedServiceResolvedSelection;
  currentRecord: ConnectedServiceCredentialRecordV1;
  nowMs: number;
}>): Promise<LocalNativeCredentialCandidate | null> {
  const profileId = readClaudeSubscriptionProfileId(params.selection);
  if (!profileId || params.currentRecord.serviceId !== 'claude-subscription' || params.currentRecord.kind !== 'oauth') {
    return null;
  }
  const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: profileId,
    selection: params.selection,
  });
  if (!claudeConfigDir) return null;

  const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
  let raw: unknown;
  let mtimeMs: number;
  try {
    const [contents, stats] = await Promise.all([readFile(credentialPath, 'utf8'), stat(credentialPath)]);
    raw = JSON.parse(contents);
    mtimeMs = stats.mtimeMs;
  } catch {
    return null;
  }

  const parsed = parseClaudeCodeNativeCredentialPayload(raw);
  if (parsed.status !== 'ok') return null;
  if (findMissingClaudeCodeCredentialScopes(parsed.scopes).length > 0) return null;
  if (isFiniteNumber(parsed.expiresAt) && parsed.expiresAt <= params.nowMs) return null;

  return {
    mtimeMs,
    record: buildConnectedServiceCredentialRecord({
      now: params.nowMs,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: parsed.expiresAt,
      oauth: {
        accessToken: parsed.payload.claudeAiOauth.accessToken,
        refreshToken: parsed.payload.claudeAiOauth.refreshToken,
        idToken: params.currentRecord.oauth.idToken ?? null,
        scope: resolveOauthScope(parsed.payload.claudeAiOauth.scopes),
        tokenType: params.currentRecord.oauth.tokenType ?? 'Bearer',
        providerAccountId: params.currentRecord.oauth.providerAccountId ?? null,
        providerEmail: params.currentRecord.oauth.providerEmail ?? null,
        raw: {
          claudeAiOauth: {
            ...(parsed.payload.claudeAiOauth.subscriptionType
              ? { subscriptionType: parsed.payload.claudeAiOauth.subscriptionType }
              : {}),
            ...(parsed.payload.claudeAiOauth.rateLimitTier
              ? { rateLimitTier: parsed.payload.claudeAiOauth.rateLimitTier }
              : {}),
          },
        },
      },
    }),
  };
}

function shouldAdoptLocalNativeCredential(params: Readonly<{
  currentRecord: ConnectedServiceCredentialRecordV1;
  candidate: LocalNativeCredentialCandidate;
}>): boolean {
  if (params.currentRecord.serviceId !== 'claude-subscription' || params.currentRecord.kind !== 'oauth') {
    return false;
  }
  if (params.candidate.record.kind !== 'oauth') return false;

  const currentAccessToken = params.currentRecord.oauth.accessToken?.trim() ?? '';
  const currentRefreshToken = params.currentRecord.oauth.refreshToken?.trim() ?? '';
  if (!currentAccessToken || !currentRefreshToken) return true;

  const candidateExpiresAt = params.candidate.record.expiresAt;
  const currentExpiresAt = params.currentRecord.expiresAt;
  if (
    isFiniteNumber(candidateExpiresAt)
    && (!isFiniteNumber(currentExpiresAt) || candidateExpiresAt > currentExpiresAt)
  ) {
    return true;
  }

  const tokenDiffers =
    params.candidate.record.oauth.accessToken !== params.currentRecord.oauth.accessToken
    || params.candidate.record.oauth.refreshToken !== params.currentRecord.oauth.refreshToken;
  return tokenDiffers && params.candidate.mtimeMs > params.currentRecord.updatedAt + 1000;
}

export async function adoptFresherClaudeSubscriptionNativeCredentialForSpawn(params: Readonly<{
  activeServerDir: string;
  credentials: Credentials;
  api: ApiClient;
  nowMs: number;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
}>): Promise<boolean> {
  const selection = params.selectionsByServiceId.get('claude-subscription');
  const currentRecord = params.recordsByServiceId.get('claude-subscription');
  if (!selection || !currentRecord) return false;

  const candidate = await readLocalNativeCredentialCandidate({
    activeServerDir: params.activeServerDir,
    selection,
    currentRecord,
    nowMs: params.nowMs,
  });
  if (!candidate || !shouldAdoptLocalNativeCredential({ currentRecord, candidate })) return false;

  const registerSealed = (params.api as RegisterConnectedServiceCredentialSealedApi)
    .registerConnectedServiceCredentialSealed;
  if (typeof registerSealed !== 'function') return false;
  if (candidate.record.kind !== 'oauth' || !candidate.record.oauth) return false;
  const candidateRecord = candidate.record;
  const candidateOauth = candidate.record.oauth;

  const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
    material: credentialsMaterial(params.credentials),
    payload: candidateRecord,
    randomBytes: (length) => randomBytes(length),
  });
  await registerSealed.call(params.api, {
    serviceId: 'claude-subscription',
    profileId: candidateRecord.profileId,
    sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
    metadata: {
      kind: candidateRecord.kind,
      providerEmail: candidateOauth.providerEmail ?? null,
      providerAccountId: candidateOauth.providerAccountId ?? null,
      expiresAt: candidateRecord.expiresAt,
    },
  });
  params.recordsByServiceId.set('claude-subscription', candidateRecord);
  return true;
}
