import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ClaudeRootConfigJson = Record<string, unknown>;

function readObject(value: unknown): ClaudeRootConfigJson | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as ClaudeRootConfigJson
    : null;
}

export async function readClaudeRootConfigFile(path: string): Promise<ClaudeRootConfigJson | null> {
  try {
    return readObject(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export function sanitizeClaudeOauthAccountProjection(value: unknown): ClaudeRootConfigJson | null {
  const oauthAccount = readObject(value);
  if (!oauthAccount) return null;
  const sanitizedEntries = Object.entries(oauthAccount).filter(([key]) => !key.toLowerCase().includes('token'));
  if (sanitizedEntries.length === 0) return null;
  return Object.fromEntries(sanitizedEntries);
}

export function sanitizeClaudeRootConfig(
  rootConfig: ClaudeRootConfigJson,
): ClaudeRootConfigJson {
  const sanitizedOauthAccount = sanitizeClaudeOauthAccountProjection(rootConfig.oauthAccount);
  if (sanitizedOauthAccount) {
    return {
      ...rootConfig,
      oauthAccount: sanitizedOauthAccount,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(rootConfig, 'oauthAccount')) {
    return rootConfig;
  }
  const { oauthAccount: _ignoredOauthAccount, ...rest } = rootConfig;
  return rest;
}

export async function sanitizeClaudeRootConfigFile(path: string): Promise<void> {
  const rootConfig = await readClaudeRootConfigFile(path) ?? {};
  await writeJsonAtomic(path, {
    ...sanitizeClaudeRootConfig(rootConfig),
    hasCompletedOnboarding: true,
  });
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeOauthAccountIdentity(value: unknown): Readonly<{
  email: string | null;
  accountId: string | null;
}> {
  const oauthAccount = readObject(value);
  if (!oauthAccount) {
    return {
      email: null,
      accountId: null,
    };
  }
  return {
    email: readNonBlankString(oauthAccount.emailAddress) ?? readNonBlankString(oauthAccount.email),
    accountId: readNonBlankString(oauthAccount.id) ?? readNonBlankString(oauthAccount.uuid),
  };
}
