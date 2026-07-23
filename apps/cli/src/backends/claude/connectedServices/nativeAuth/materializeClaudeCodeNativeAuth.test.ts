import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { verifyResumeReachableClaude } from '../verifyResumeReachableClaude';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import {
  materializeClaudeCodeNativeAuth,
  materializeClaudeSubscriptionNativeAuthHome,
} from './materializeClaudeCodeNativeAuth';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function buildHealthyClaudeSubscriptionRecord(profileId: string, accessToken: string, refreshToken: string) {
  return buildConnectedServiceCredentialRecord({
    now: REALISTIC_ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'oauth',
    expiresAt: REALISTIC_EXPIRES_AT_MS,
    oauth: {
      accessToken,
      refreshToken,
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: `${profileId}@example.test`,
    },
  });
}

describe('materializeClaudeCodeNativeAuth', () => {
  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('materializes direct and group Claude subscription homes through one helper with equivalent required auth artifacts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const profileClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-profile-'));
    const groupClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-group-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'work-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account-id',
        providerEmail: 'user@example.test',
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
          },
        },
      },
    });

    const profile = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: profileClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work-profile',
      },
    });
    const group = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: groupClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'work-profile',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
      },
    });

    expect(profile.env).toEqual({
      CLAUDE_CONFIG_DIR: profileClaudeConfigDir,
    });
    expect(group.env).toEqual({
      CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
    });

    const profileCredential = JSON.parse(await readFile(join(profileClaudeConfigDir, '.credentials.json'), 'utf8'));
    const groupCredential = JSON.parse(await readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'));
    expect(groupCredential).toEqual(profileCredential);
    expect(groupCredential.claudeAiOauth).toMatchObject({
      accessToken: 'selected-access-placeholder',
      refreshToken: 'selected-refresh-placeholder',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      subscriptionType: 'max',
      rateLimitTier: 'max_20x',
    });
    await expect(readFile(join(profileClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
    await expect(readFile(join(groupClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');

    const profileRootConfig = JSON.parse(await readFile(join(profileClaudeConfigDir, '.claude.json'), 'utf8'));
    const groupRootConfig = JSON.parse(await readFile(join(groupClaudeConfigDir, '.claude.json'), 'utf8'));
    expect(profileRootConfig).toMatchObject({ hasCompletedOnboarding: true });
    expect(groupRootConfig).toMatchObject({ hasCompletedOnboarding: true });

    expect(profile.identityDiagnostic).toMatchObject({
      serviceId: 'claude-subscription',
      selectionKind: 'profile',
      profileId: 'work-profile',
      targetRootKind: 'profile_home',
      credentialHealthStatus: 'ok',
      hasProviderAccountId: true,
      hasProviderEmail: true,
    });
    expect(group.identityDiagnostic).toMatchObject({
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude-team',
      activeProfileId: 'work-profile',
      targetRootKind: 'group_home',
      credentialHealthStatus: 'ok',
      hasProviderAccountId: true,
      hasProviderEmail: true,
    });
    expect(JSON.stringify(profile.identityDiagnostic)).not.toContain('selected-access-placeholder');
    expect(JSON.stringify(group.identityDiagnostic)).not.toContain('selected-refresh-placeholder');
  });

  it('writes native credentials and returns only CLAUDE_CONFIG_DIR for healthy OAuth records', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result).toEqual({
      status: 'materialized',
      env: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
      diagnostics: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
    const credentialFile = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credentialFile.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    expect(credentialFile.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(credentialFile.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
  });

  it('keeps isolated Claude subscription homes fail-closed instead of importing source session files', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    const sourceSettingsDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-settings-'));
    const sourceProjectsDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-projects-'));
    await writeFile(join(sourceSettingsDir, 'settings.json'), '{"theme":"source"}\n');
    await mkdir(join(sourceProjectsDir, 'repo-a'), { recursive: true });
    await writeFile(join(sourceProjectsDir, 'repo-a', 'resume-123.jsonl'), '{"type":"session"}\n');
    await symlink(join(sourceSettingsDir, 'settings.json'), join(sourceClaudeConfigDir, 'settings.json'));
    await symlink(sourceProjectsDir, join(sourceClaudeConfigDir, 'projects'));

    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: claudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'isolated' },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'oauth',
        fallbackProfileId: 'fallback',
        generation: 3,
      },
    });

    expect(result.status).toBe('materialized');
    await expect(readFile(join(claudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
    expect((await lstat(join(claudeConfigDir, 'settings.json'))).isSymbolicLink()).toBe(false);
    await expect(readFile(join(claudeConfigDir, 'projects', 'repo-a', 'resume-123.jsonl'), 'utf8')).rejects.toThrow();
    expect(result.identityDiagnostic).toMatchObject({
      selectionKind: 'group',
      groupId: 'claude-team',
      activeProfileId: 'oauth',
      targetRootKind: 'group_home',
    });
    const manifest = await readConnectedServiceStateSharingManifest(claudeConfigDir);
    expect(manifest.requestedStateMode).toBe('isolated');
    expect(manifest.sessionFileMappings).toEqual([]);
  });

  it('preserves sibling session files of a replaced isolated home across a staged rebuild', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const siblingSessionPath = join(
      targetClaudeConfigDir,
      'projects',
      '-Users-leeroy-Documents-Development-sibling-repo',
      'aaaa1111-2222-3333-4444-555566667777.jsonl',
    );
    await mkdir(dirname(siblingSessionPath), { recursive: true });
    await writeFile(siblingSessionPath, '{"type":"assistant","message":"sibling isolated session"}\n');
    const record = buildHealthyClaudeSubscriptionRecord('oauth', 'access-placeholder', 'refresh-placeholder');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'isolated' },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth',
      },
    });

    expect(result.status).toBe('materialized');
    // The staged replacement must not destroy the only copy of sessions resting in the old home.
    await expect(readFile(siblingSessionPath, 'utf8')).resolves.toContain('sibling isolated session');
    const manifest = await readConnectedServiceStateSharingManifest(targetClaudeConfigDir);
    expect(manifest.requestedStateMode).toBe('isolated');
  });

  it('backfills sibling session files of a replaced home into the shared store on a shared staged rebuild', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const ambientClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-ambient-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    await mkdir(join(ambientClaudeConfigDir, 'projects'), { recursive: true });
    const siblingRelativePath = join(
      '-Users-leeroy-Documents-Development-sibling-repo',
      'bbbb1111-2222-3333-4444-555566667777.jsonl',
    );
    await mkdir(dirname(join(targetClaudeConfigDir, 'projects', siblingRelativePath)), { recursive: true });
    await writeFile(
      join(targetClaudeConfigDir, 'projects', siblingRelativePath),
      '{"type":"assistant","message":"sibling pre-shared session"}\n',
    );
    const record = buildHealthyClaudeSubscriptionRecord('oauth', 'access-placeholder', 'refresh-placeholder');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: ambientClaudeConfigDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'shared' },
          },
          acknowledgedRisksByAgentId: {
            claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
          },
        },
      },
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth',
      },
    });

    expect(result.status).toBe('materialized');
    // Backfilled into the shared store and reachable through the rebuilt home's projects link.
    await expect(
      readFile(join(ambientClaudeConfigDir, 'projects', siblingRelativePath), 'utf8'),
    ).resolves.toContain('sibling pre-shared session');
    await expect(
      readFile(join(targetClaudeConfigDir, 'projects', siblingRelativePath), 'utf8'),
    ).resolves.toContain('sibling pre-shared session');
  });

  it('carries a previous connected-service Claude session file into shared-state subscription materialization', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const ambientClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-ambient-'));
    const previousClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-previous-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const vendorResumeId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const previousSessionPath = join(
      previousClaudeConfigDir,
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${vendorResumeId}.jsonl`,
    );
    await mkdir(join(ambientClaudeConfigDir, 'projects'), { recursive: true });
    await mkdir(join(previousClaudeConfigDir, 'projects', '-Users-leeroy-Documents-Development-happier-remote-dev'), { recursive: true });
    await writeFile(previousSessionPath, '{"type":"assistant","message":"previous profile session"}\n');
    await writeFile(join(previousClaudeConfigDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"previous-token"}}\n');
    const record = buildHealthyClaudeSubscriptionRecord(
      'target-profile',
      'target-access-placeholder',
      'target-refresh-placeholder',
    );

    for (let iteration = 0; iteration < 2; iteration += 1) {
      const result = await materializeClaudeSubscriptionNativeAuthHome({
        record,
        targetClaudeConfigDir,
        sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: ambientClaudeConfigDir },
        accountSettings: {
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1,
            defaults: { configMode: 'linked', stateMode: 'shared' },
            byAgentId: {
              claude: { configMode: 'copied', stateMode: 'shared' },
            },
            acknowledgedRisksByAgentId: {
              claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
            },
          },
        },
        sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
        vendorResumeId,
        candidatePersistedSessionFile: previousSessionPath,
        selectionDescriptor: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'target-profile',
        },
      });

      expect(result.status).toBe('materialized');
      await expect(verifyResumeReachableClaude({
        vendorResumeId,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
      })).resolves.toEqual({
        ok: true,
        resolvedPath: join(
          targetClaudeConfigDir,
          'projects',
          '-Users-leeroy-Documents-Development-happier-remote-dev',
          `${vendorResumeId}.jsonl`,
        ),
      });
      const targetCredential = JSON.parse(await readFile(join(targetClaudeConfigDir, '.credentials.json'), 'utf8'));
      expect(targetCredential.claudeAiOauth.accessToken).toBe('target-access-placeholder');
      expect(targetCredential.claudeAiOauth.refreshToken).toBe('target-refresh-placeholder');
      expect(JSON.stringify(targetCredential)).not.toContain('previous-token');
    }

    const manifest = await readConnectedServiceStateSharingManifest(targetClaudeConfigDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('shared');
    expect(manifest.sessionFileMappings).toEqual([
      expect.objectContaining({
        vendorResumeId,
        sourcePath: previousSessionPath,
      }),
    ]);
  });

  it('carries a previous connected-service Claude session file into a canonical shared-state home even when source env already points at the target home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const previousClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-previous-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const vendorResumeId = '4b9434a8-b115-4363-851a-f39fff76a94b';
    const previousSessionPath = join(
      previousClaudeConfigDir,
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${vendorResumeId}.jsonl`,
    );
    await mkdir(join(previousClaudeConfigDir, 'projects', '-Users-leeroy-Documents-Development-happier-remote-dev'), { recursive: true });
    await writeFile(previousSessionPath, '{"type":"assistant","message":"previous profile session"}\n');
    const record = buildHealthyClaudeSubscriptionRecord(
      'leeroy_batiplus',
      'target-access-placeholder',
      'target-refresh-placeholder',
    );

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'shared' },
          },
          acknowledgedRisksByAgentId: {
            claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
          },
        },
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      vendorResumeId,
      candidatePersistedSessionFile: previousSessionPath,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_batiplus',
      },
    });

    expect(result.status).toBe('materialized');
    await expect(verifyResumeReachableClaude({
      vendorResumeId,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
    })).resolves.toEqual({
      ok: true,
      resolvedPath: join(
        targetClaudeConfigDir,
        'projects',
        '-Users-leeroy-Documents-Development-happier-remote-dev',
        `${vendorResumeId}.jsonl`,
      ),
    });
    const manifest = await readConnectedServiceStateSharingManifest(targetClaudeConfigDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('shared');
    expect(manifest.sessionFileMappings).toEqual([
      expect.objectContaining({
        vendorResumeId,
        sourcePath: previousSessionPath,
      }),
    ]);
  });

  it('keeps isolated Claude subscription materialization fail-closed when the target lacks the resume session', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const vendorResumeId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const record = buildHealthyClaudeSubscriptionRecord(
      'isolated-profile',
      'isolated-access-placeholder',
      'isolated-refresh-placeholder',
    );

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'isolated' },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      vendorResumeId,
      candidatePersistedSessionFile: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'isolated-profile',
      },
    });

    expect(result.status).toBe('materialized');
    await expect(verifyResumeReachableClaude({
      vendorResumeId,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
    })).resolves.toEqual({
      ok: false,
      reason: 'claude_native_store_unreachable',
    });
    const manifest = await readConnectedServiceStateSharingManifest(targetClaudeConfigDir);
    expect(manifest.requestedStateMode).toBe('isolated');
    expect(manifest.sessionFileMappings).toEqual([]);
  });

  it('ignores relative previous Claude session candidates and keeps resume reachability fail-closed', async () => {
    const originalCwd = process.cwd();
    const workDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-cwd-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const ambientClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-ambient-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const vendorResumeId = 'f55b3644-befc-406a-90ac-b8fbcc33cbf6';
    const relativeSessionPath = join(
      'previous-profile',
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${vendorResumeId}.jsonl`,
    );
    await mkdir(dirname(join(workDir, relativeSessionPath)), { recursive: true });
    await writeFile(join(workDir, relativeSessionPath), '{"type":"assistant","message":"relative candidate"}\n');

    try {
      process.chdir(workDir);
      const result = await materializeClaudeSubscriptionNativeAuthHome({
        record: buildHealthyClaudeSubscriptionRecord(
          'target-profile',
          'target-access-placeholder',
          'target-refresh-placeholder',
        ),
        targetClaudeConfigDir,
        sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: ambientClaudeConfigDir },
        accountSettings: {
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1,
            defaults: { configMode: 'linked', stateMode: 'shared' },
            byAgentId: {
              claude: { configMode: 'copied', stateMode: 'shared' },
            },
            acknowledgedRisksByAgentId: {
              claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
            },
          },
        },
        sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
        vendorResumeId,
        candidatePersistedSessionFile: relativeSessionPath,
        selectionDescriptor: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'target-profile',
        },
      });

      expect(result.status).toBe('materialized');
      await expect(verifyResumeReachableClaude({
        vendorResumeId,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetClaudeConfigDir },
      })).resolves.toEqual({
        ok: false,
        reason: 'claude_native_store_unreachable',
      });
      const manifest = await readConnectedServiceStateSharingManifest(targetClaudeConfigDir);
      expect(manifest.sessionFileMappings).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('returns a safe reconnect diagnostic and does not write partial credentials when scopes are insufficient', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-secret-placeholder',
        refreshToken: 'refresh-secret-placeholder',
        idToken: null,
        scope: 'user:profile user:inference',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'missing_required_scope',
        credentialRefreshFailure: {
          category: 'provider_403',
          providerStatus: 403,
          providerErrorCode: 'claude_subscription_missing_claude_code_scope',
        },
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
    await expect(lstat(join(claudeConfigDir, '.credentials.json'))).rejects.toThrow();
  });

  it('returns a safe blocking diagnostic when credential file materialization fails', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const blockingPath = join(parentDir, 'not-a-directory');
    await writeFile(blockingPath, 'file blocks nested config dir');
    const claudeConfigDir = join(blockingPath, 'claude-config');
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-secret-placeholder',
        refreshToken: 'refresh-secret-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_native_auth_materialization_failed',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'credential_file_write_failed',
        severity: 'blocking',
      }),
    ]);
    expect(result.diagnostics[0]).not.toHaveProperty('credentialRefreshFailure');
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
  });
});
