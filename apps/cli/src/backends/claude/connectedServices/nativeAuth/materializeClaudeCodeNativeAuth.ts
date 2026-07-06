import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';

import {
  backfillPreviousClaudeHomeSessionFiles,
  resolveClaudeHomeSharingSettings,
  syncClaudeConnectedServiceHome,
} from '../syncClaudeConnectedServiceHome';
import {
  buildClaudeConnectedServiceHomeProvenance,
  resolveClaudeConnectedServiceHomeProvenancePath,
  writeClaudeConnectedServiceHomeProvenance,
} from '../claudeConnectedServiceHomeProvenance';
import { sanitizeClaudeRootConfigFile } from '../claudeRootConfig';
import { materializeClaudeWorkspaceTrust } from '../materializeClaudeWorkspaceTrust';
import {
  buildClaudeCodeCredentialPayload,
  parseClaudeCodeCredentialFile,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './claudeCodeCredentialFile';
import { writeClaudeCodeMacOsKeychainCredential } from './claudeCodeMacOsKeychain';
import {
  classifyClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealthStatus,
} from './claudeCodeCredentialHealth';
import { findMissingClaudeCodeCredentialScopes } from './claudeCodeCredentialScopes';

export type ClaudeCodeNativeAuthMaterializationResult =
  | Readonly<{
      status: 'materialized';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
      credentialPath: string;
    }>
  | Readonly<{
      status: 'diagnostic';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    }>;

export type ClaudeSubscriptionNativeAuthSelectionDescriptor =
  | Readonly<{
      kind: 'profile';
      serviceId: 'claude-subscription';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'claude-subscription';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }>;

export type ClaudeSubscriptionNativeAuthIdentityDiagnostic = Readonly<{
  serviceId: 'claude-subscription';
  selectionKind: 'profile' | 'group';
  profileId?: string;
  groupId?: string;
  activeProfileId?: string;
  targetRootKind: 'profile_home' | 'group_home';
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
  hasProviderAccountId: boolean;
  hasProviderEmail: boolean;
}>;

export type ClaudeSubscriptionNativeAuthHomeMaterializationResult =
  ClaudeCodeNativeAuthMaterializationResult & Readonly<{
    identityDiagnostic: ClaudeSubscriptionNativeAuthIdentityDiagnostic;
  }>;

function diagnosticCodeForHealth(health: ClaudeCodeCredentialHealth): string {
  switch (health.status) {
    case 'missing_required_scope':
      return 'claude_subscription_missing_claude_code_scope';
    case 'unsupported_credential_kind':
      return 'claude_subscription_setup_token_not_supported_for_unified';
    case 'missing_access_token':
    case 'missing_refresh_token':
    case 'unsupported_service':
    case 'ok':
      return 'claude_subscription_native_auth_materialization_failed';
  }
}

function credentialRefreshFailureForHealth(
  health: ClaudeCodeCredentialHealth,
): ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'] {
  switch (health.status) {
    case 'missing_required_scope':
      return {
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      };
    case 'unsupported_credential_kind':
      return {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_setup_token_not_supported_for_unified',
      };
    case 'missing_access_token':
      return {
        category: 'missing_access_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      };
    case 'missing_refresh_token':
      return {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      };
    case 'unsupported_service':
    case 'ok':
      return undefined;
  }
}

function diagnosticForHealth(health: ClaudeCodeCredentialHealth): ConnectedServicesMaterializationDiagnostic {
  const credentialRefreshFailure = credentialRefreshFailureForHealth(health);
  return {
    code: diagnosticCodeForHealth(health),
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: health.status,
    ...(credentialRefreshFailure ? { credentialRefreshFailure } : {}),
    ...(health.missingScopes.length > 0 ? { entryName: health.missingScopes.join(' ') } : {}),
  };
}

function diagnosticForCredentialFileWriteFailure(): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_materialization_failed',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: 'credential_file_write_failed',
  };
}

function diagnosticForKeychainWriteFailure(): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_keychain_write_failed',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: 'keychain_write_failed',
  };
}

function diagnosticForSourceCredentialFallback(
  health: ClaudeCodeCredentialHealth,
): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_source_credentials_used',
    providerId: 'claude',
    severity: 'warning',
    serviceId: 'claude-subscription',
    reason: health.status,
  };
}

export function diagnoseClaudeCodeNativeAuthMaterialization(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): readonly ConnectedServicesMaterializationDiagnostic[] {
  const built = buildClaudeCodeCredentialPayload(params.record);
  return built.status === 'ok' ? [] : [diagnosticForHealth(built.health)];
}

export async function materializeClaudeCodeNativeAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  claudeConfigDir: string;
}>): Promise<ClaudeCodeNativeAuthMaterializationResult> {
  const built = buildClaudeCodeCredentialPayload(params.record);
  if (built.status !== 'ok') {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForHealth(built.health)],
    };
  }
  let credentialPath: string;
  try {
    credentialPath = await writeClaudeCodeCredentialsFile({
      claudeConfigDir: params.claudeConfigDir,
      payload: built.payload,
    });
  } catch {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForCredentialFileWriteFailure()],
    };
  }
  return {
    status: 'materialized',
    env: {
      CLAUDE_CONFIG_DIR: params.claudeConfigDir,
    },
    diagnostics: [],
    credentialPath,
  };
}

function hasNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSourceCredentialFallbackEligible(health: ClaudeCodeCredentialHealth): boolean {
  return health.status === 'missing_access_token' || health.status === 'missing_refresh_token';
}

type SourceNativeCredentialFile = Readonly<{
  contents: string;
}>;

async function readValidSourceNativeCredentialFile(
  sourceEnv: NodeJS.ProcessEnv,
): Promise<SourceNativeCredentialFile | null> {
  const sourceClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: sourceEnv });
  const credentialPath = resolveClaudeCodeCredentialsFilePath(sourceClaudeConfigDir);
  let contents: string;
  try {
    contents = await readFile(credentialPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }

  const credential = parseClaudeCodeCredentialFile(parsed);
  if (credential.status !== 'ok') return null;
  if (!credential.hasAccessToken || !credential.hasRefreshToken) return null;
  if (findMissingClaudeCodeCredentialScopes(credential.scopes).length > 0) return null;
  return { contents: contents.endsWith('\n') ? contents : `${contents}\n` };
}

async function writeSourceNativeCredentialFile(params: Readonly<{
  targetClaudeConfigDir: string;
  sourceCredential: SourceNativeCredentialFile;
}>): Promise<string> {
  await mkdir(params.targetClaudeConfigDir, { recursive: true });
  const credentialPath = resolveClaudeCodeCredentialsFilePath(params.targetClaudeConfigDir);
  await writeFile(credentialPath, params.sourceCredential.contents, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(credentialPath, 0o600).catch(() => {});
  }
  return credentialPath;
}

type FileRollbackSnapshot = Readonly<{
  path: string;
  existed: boolean;
  contents?: Buffer | undefined;
  mode?: number | undefined;
}>;

async function snapshotFileForRollback(path: string): Promise<FileRollbackSnapshot> {
  try {
    const [contents, stats] = await Promise.all([readFile(path), lstat(path)]);
    return { path, existed: true, contents, mode: stats.mode & 0o777 };
  } catch {
    return { path, existed: false };
  }
}

async function restoreFileSnapshot(snapshot: FileRollbackSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.path, { force: true }).catch(() => {});
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true });
  await writeFile(snapshot.path, snapshot.contents ?? Buffer.alloc(0), { mode: snapshot.mode ?? 0o600 });
  if (process.platform !== 'win32') {
    await chmod(snapshot.path, snapshot.mode ?? 0o600).catch(() => {});
  }
}

async function restoreFileSnapshots(snapshots: readonly FileRollbackSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map((snapshot) => restoreFileSnapshot(snapshot)));
}

function buildClaudeSubscriptionNativeAuthIdentityDiagnostic(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
}>): ClaudeSubscriptionNativeAuthIdentityDiagnostic {
  const recordOauth = params.record.kind === 'oauth' ? params.record.oauth : null;
  const base = {
    serviceId: 'claude-subscription' as const,
    credentialHealthStatus: params.credentialHealthStatus,
    hasProviderAccountId: hasNonBlankString(recordOauth?.providerAccountId),
    hasProviderEmail: hasNonBlankString(recordOauth?.providerEmail),
  };
  if (params.selectionDescriptor.kind === 'group') {
    return {
      ...base,
      selectionKind: 'group',
      groupId: params.selectionDescriptor.groupId,
      activeProfileId: params.selectionDescriptor.activeProfileId,
      targetRootKind: 'group_home',
    };
  }
  return {
    ...base,
    selectionKind: 'profile',
    profileId: params.selectionDescriptor.profileId,
    targetRootKind: 'profile_home',
  };
}

export async function writeClaudeSubscriptionNativeAuthMacOsKeychainCredential(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  claudeConfigDir: string;
  sourceEnv: NodeJS.ProcessEnv;
}>): Promise<readonly ConnectedServicesMaterializationDiagnostic[]> {
  if (process.platform !== 'darwin') return [];
  const builtCredentialPayload = buildClaudeCodeCredentialPayload(params.record);
  if (builtCredentialPayload.status !== 'ok') {
    return [diagnosticForHealth(builtCredentialPayload.health)];
  }
  try {
    await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: params.claudeConfigDir,
      homeDir: params.sourceEnv.HOME,
      username: params.sourceEnv.USER,
      payload: builtCredentialPayload.payload,
    });
    return [];
  } catch {
    return [diagnosticForKeychainWriteFailure()];
  }
}

async function materializeClaudeSubscriptionNativeAuthHomeFromSourceCredential(params: Readonly<{
  targetClaudeConfigDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  ambientStateSourceDir?: string | null;
  health: ClaudeCodeCredentialHealth;
}>): Promise<ClaudeCodeNativeAuthMaterializationResult | null> {
  const sourceCredential = await readValidSourceNativeCredentialFile(params.sourceEnv);
  if (!sourceCredential) return null;

  const sharingPolicy = resolveClaudeHomeSharingSettings(params.accountSettings ?? null);
  const sourceClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
  const fallbackDiagnostic = diagnosticForSourceCredentialFallback(params.health);

  if (resolve(sourceClaudeConfigDir) === resolve(params.targetClaudeConfigDir)) {
    const syncResult = await syncClaudeConnectedServiceHome({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetClaudeConfigDir,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      preserveNativeCredentialFile: true,
      sharingPolicyOverride: {
        configMode: 'copied',
        stateMode: sharingPolicy.stateMode,
      },
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      ambientStateSourceDir: params.ambientStateSourceDir ?? null,
    });
    await mkdir(params.targetClaudeConfigDir, { recursive: true });
    await materializeClaudeWorkspaceTrust({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetClaudeConfigDir,
      sessionDirectory: params.sessionDirectory ?? null,
      preserveExistingOauthAccountProjection: true,
    });
    await sanitizeClaudeRootConfigFile(join(params.targetClaudeConfigDir, '.claude.json'));
    const credentialPath = await writeSourceNativeCredentialFile({
      targetClaudeConfigDir: params.targetClaudeConfigDir,
      sourceCredential,
    });
    return {
      status: 'materialized',
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      diagnostics: [...syncResult.diagnostics, fallbackDiagnostic],
      credentialPath,
    };
  }

  await mkdir(dirname(params.targetClaudeConfigDir), { recursive: true });
  return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
    const stagedClaudeConfigDir = await mkdtemp(join(dirname(params.targetClaudeConfigDir), '.happier-claude-config-'));
    try {
      const syncResult = await syncClaudeConnectedServiceHome({
        sourceEnv: params.sourceEnv,
        targetDir: stagedClaudeConfigDir,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveNativeCredentialFile: true,
        sharingPolicyOverride: {
          configMode: 'copied',
          stateMode: sharingPolicy.stateMode,
        },
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      });
      await sanitizeClaudeRootConfigFile(join(stagedClaudeConfigDir, '.claude.json'));
      await writeSourceNativeCredentialFile({
        targetClaudeConfigDir: stagedClaudeConfigDir,
        sourceCredential,
      });
      await backfillPreviousClaudeHomeSessionFiles({
        previousClaudeConfigDir: params.targetClaudeConfigDir,
        stagedClaudeConfigDir,
        effectiveStateMode: syncResult.effectiveStateMode,
        sharedSourceProjectsRoot: join(sourceClaudeConfigDir, 'projects'),
      });
      await replaceDirectoryAtomically({
        stagedDir: stagedClaudeConfigDir,
        targetDir: params.targetClaudeConfigDir,
      });
      return {
        status: 'materialized',
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        diagnostics: [...syncResult.diagnostics, fallbackDiagnostic],
        credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
      };
    } finally {
      await rm(stagedClaudeConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }, { providerId: 'claude' });
}

export async function materializeClaudeSubscriptionNativeAuthHome(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  targetClaudeConfigDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  /** Ambient native store root for self-source sharing-policy reconciliation (RD-MAT-2). */
  ambientStateSourceDir?: string | null;
  writeMacOsKeychainCredential?: boolean;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
}>): Promise<ClaudeSubscriptionNativeAuthHomeMaterializationResult> {
  const health = classifyClaudeCodeCredentialHealth(params.record);
  const builtCredentialPayload = buildClaudeCodeCredentialPayload(params.record);
  const identityDiagnostic = buildClaudeSubscriptionNativeAuthIdentityDiagnostic({
    record: params.record,
    selectionDescriptor: params.selectionDescriptor,
    credentialHealthStatus: health.status,
  });
  if (health.status !== 'ok') {
    if (isSourceCredentialFallbackEligible(health)) {
      const sourceCredentialMaterialized = await materializeClaudeSubscriptionNativeAuthHomeFromSourceCredential({
        targetClaudeConfigDir: params.targetClaudeConfigDir,
        sourceEnv: params.sourceEnv,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        ambientStateSourceDir: params.ambientStateSourceDir ?? null,
        health,
      });
      if (sourceCredentialMaterialized) {
        return {
          ...sourceCredentialMaterialized,
          identityDiagnostic,
        };
      }
    }
    const materialized = await materializeClaudeCodeNativeAuth({
      record: params.record,
      claudeConfigDir: params.targetClaudeConfigDir,
    });
    return {
      ...materialized,
      identityDiagnostic,
    };
  }
  if (builtCredentialPayload.status !== 'ok') {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      diagnostics: [diagnosticForHealth(builtCredentialPayload.health)],
      identityDiagnostic,
    };
  }

  const sharingPolicy = resolveClaudeHomeSharingSettings(params.accountSettings ?? null);
  const sourceClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
  if (resolve(sourceClaudeConfigDir) === resolve(params.targetClaudeConfigDir)) {
    const credentialSnapshot = await snapshotFileForRollback(
      resolveClaudeCodeCredentialsFilePath(params.targetClaudeConfigDir),
    );
    const provenanceSnapshot = await snapshotFileForRollback(
      resolveClaudeConnectedServiceHomeProvenancePath(params.targetClaudeConfigDir),
    );
    const syncResult = await syncClaudeConnectedServiceHome({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetClaudeConfigDir,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      preserveNativeCredentialFile: true,
      sharingPolicyOverride: {
        configMode: 'copied',
        stateMode: sharingPolicy.stateMode,
      },
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      ambientStateSourceDir: params.ambientStateSourceDir ?? null,
    });
    await mkdir(params.targetClaudeConfigDir, { recursive: true });
    await materializeClaudeWorkspaceTrust({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetClaudeConfigDir,
      sessionDirectory: params.sessionDirectory ?? null,
      preserveExistingOauthAccountProjection: true,
    });
    await sanitizeClaudeRootConfigFile(join(params.targetClaudeConfigDir, '.claude.json'));
    const materialized = await materializeClaudeCodeNativeAuth({
      record: params.record,
      claudeConfigDir: params.targetClaudeConfigDir,
    });
    if (materialized.status !== 'materialized') {
      return {
        ...materialized,
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    }
    await writeClaudeConnectedServiceHomeProvenance({
      claudeConfigDir: params.targetClaudeConfigDir,
      provenance: buildClaudeConnectedServiceHomeProvenance({
        record: params.record,
        selectionDescriptor: params.selectionDescriptor,
      }),
    });
    if (params.writeMacOsKeychainCredential !== false) {
      const keychainDiagnostics = await writeClaudeSubscriptionNativeAuthMacOsKeychainCredential({
        record: params.record,
        claudeConfigDir: params.targetClaudeConfigDir,
        sourceEnv: params.sourceEnv,
      });
      if (keychainDiagnostics.some((diagnostic) => diagnostic.code === 'claude_subscription_native_auth_keychain_write_failed')) {
        await restoreFileSnapshots([credentialSnapshot, provenanceSnapshot]);
        return {
          status: 'diagnostic',
          env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
          diagnostics: keychainDiagnostics,
          identityDiagnostic,
        };
      }
    }
    return {
      ...materialized,
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
      diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
      identityDiagnostic,
    };
  }

  await mkdir(dirname(params.targetClaudeConfigDir), { recursive: true });
  // RD-MAT-8: hold the destination lock on the REAL target home across stage-build + swap so a
  // concurrent self-source materialization of the same profile home cannot interleave in-place
  // writes with the staged replacement. The inner sync locks only the staged dir (distinct key).
  return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
    const stagedClaudeConfigDir = await mkdtemp(join(dirname(params.targetClaudeConfigDir), '.happier-claude-config-'));
    try {
      const syncResult = await syncClaudeConnectedServiceHome({
        sourceEnv: params.sourceEnv,
        targetDir: stagedClaudeConfigDir,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveNativeCredentialFile: true,
        sharingPolicyOverride: {
          configMode: 'copied',
          stateMode: sharingPolicy.stateMode,
        },
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      });
      await sanitizeClaudeRootConfigFile(join(stagedClaudeConfigDir, '.claude.json'));
      const materialized = await materializeClaudeCodeNativeAuth({
        record: params.record,
        claudeConfigDir: stagedClaudeConfigDir,
      });
      if (materialized.status !== 'materialized') {
        return {
          ...materialized,
          env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
          diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
          identityDiagnostic,
        };
      }
      await writeClaudeConnectedServiceHomeProvenance({
        claudeConfigDir: stagedClaudeConfigDir,
        provenance: buildClaudeConnectedServiceHomeProvenance({
          record: params.record,
          selectionDescriptor: params.selectionDescriptor,
        }),
      });
      // RD-CLD-2: preserve the previous home's physical session files before the staged swap
      // destroys them — sibling sessions resting in that home are NOT covered by the candidate
      // session-file import of the session being resumed.
      await backfillPreviousClaudeHomeSessionFiles({
        previousClaudeConfigDir: params.targetClaudeConfigDir,
        stagedClaudeConfigDir,
        effectiveStateMode: syncResult.effectiveStateMode,
        sharedSourceProjectsRoot: join(sourceClaudeConfigDir, 'projects'),
      });
      if (params.writeMacOsKeychainCredential !== false && process.platform === 'darwin') {
        let keychainWriteFailed = false;
        try {
          await replaceDirectoryAtomically({
            stagedDir: stagedClaudeConfigDir,
            targetDir: params.targetClaudeConfigDir,
            afterPromote: async () => {
              const keychainDiagnostics = await writeClaudeSubscriptionNativeAuthMacOsKeychainCredential({
                record: params.record,
                claudeConfigDir: params.targetClaudeConfigDir,
                sourceEnv: params.sourceEnv,
              });
              if (keychainDiagnostics.some((diagnostic) => diagnostic.code === 'claude_subscription_native_auth_keychain_write_failed')) {
                keychainWriteFailed = true;
                throw new Error('claude_subscription_native_auth_keychain_write_failed');
              }
            },
          });
        } catch (error) {
          if (!keychainWriteFailed) throw error;
          return {
            status: 'diagnostic',
            env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
            diagnostics: [...syncResult.diagnostics, diagnosticForKeychainWriteFailure()],
            identityDiagnostic,
          };
        }
      } else {
        await replaceDirectoryAtomically({
          stagedDir: stagedClaudeConfigDir,
          targetDir: params.targetClaudeConfigDir,
        });
      }
      return {
        ...materialized,
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    } finally {
      await rm(stagedClaudeConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }, { providerId: 'claude' });
}
