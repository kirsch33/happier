import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { createClaudeConnectedServicesMaterializer } from './createClaudeConnectedServicesMaterializer';
import { buildClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

describe('createClaudeConnectedServicesMaterializer', () => {
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

  it('strips ambient Claude credentials and writes selected OAuth as native Claude Code credentials', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await writeFile(
      join(sourceClaudeConfigDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'ambient-access-placeholder',
          refreshToken: 'ambient-refresh-placeholder',
          expiresAt: 1000,
          scopes: ['user:inference'],
        },
      }),
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const expectedProfileClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedProfileClaudeConfigDir);
    expect(result!.targetMaterializedRoot).toBe(expectedProfileClaudeConfigDir);
    expect(result!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result!.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]).toBeUndefined();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBeUndefined();
    expect(result!.diagnostics ?? []).toEqual([]);

    const credential = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    expect(credential.claudeAiOauth.refreshToken).toBe('selected-refresh-placeholder');
    expect(credential.claudeAiOauth.accessToken).not.toBe('ambient-access-placeholder');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    expect(credential.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(credential.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('repairs blank Claude subscription records from a valid native Claude credential file', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(
      join(existingTargetDir, '.credentials.json'),
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: '',
          refreshToken: '',
          expiresAt: 0,
          scopes: ['user:sessions:claude_code'],
        },
      })}\n`,
    );
    await writeFile(
      join(sourceClaudeConfigDir, '.credentials.json'),
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'native-access-placeholder',
          refreshToken: 'native-refresh-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
          subscriptionType: 'max',
        },
      })}\n`,
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const validRecord = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'will-be-blanked',
        refreshToken: 'will-be-blanked',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const blankRecord = {
      ...validRecord,
      expiresAt: 0,
      oauth: {
        ...validRecord.oauth,
        accessToken: '',
        refreshToken: '',
      },
    } as typeof validRecord;

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', blankRecord]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(existingTargetDir);
    expect(result!.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_subscription_native_auth_source_credentials_used',
      severity: 'warning',
      reason: 'missing_access_token',
    }));
    expect(result!.diagnostics).not.toContainEqual(expect.objectContaining({
      severity: 'blocking',
    }));

    const credential = JSON.parse(await readFile(join(existingTargetDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('native-access-placeholder');
    expect(credential.claudeAiOauth.refreshToken).toBe('native-refresh-placeholder');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('projects user-accepted Claude workspace trust without copying credentials or per-project approvals', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-claude-trusted-project-'));
    const projectDir = join(projectRoot, 'repo');
    const otherProjectDir = join(projectRoot, 'other');
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await mkdir(projectDir, { recursive: true });
    await mkdir(otherProjectDir, { recursive: true });
    await writeFile(
      join(homeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: { accessToken: 'ambient-root-access-must-not-copy' },
        projects: {
          [projectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            hasClaudeMdExternalIncludesApproved: true,
            allowedTools: ['Bash(*)'],
            mcpServers: {
              local: { command: 'secret-local-command' },
            },
            enabledMcpjsonServers: ['local'],
            lastCost: 123,
          },
          [otherProjectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })}\n`,
    );
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toBeUndefined();
    expect(targetConfig.projects).toEqual({
      [projectDir]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
  });

  it('materializes a Claude subscription group selection into the shared group home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      selectionsByServiceId: new Map([['claude-subscription', {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'oauth-profile',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
        record,
        policy: null,
      }]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const expectedGroupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'claude-team',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedGroupClaudeConfigDir);
    expect(result!.targetMaterializedRoot).toBe(expectedGroupClaudeConfigDir);
    const credential = JSON.parse(await readFile(join(expectedGroupClaudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
  });

  it('preserves the previous stable native credential file when rematerialization fails closed', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const materializer = createClaudeConnectedServicesMaterializer();
    const validRecord = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'stable-access-placeholder',
        refreshToken: 'stable-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const invalidRecord = buildConnectedServiceCredentialRecord({
      now: 1100,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2100,
      oauth: {
        accessToken: 'invalid-access-placeholder',
        refreshToken: 'invalid-refresh-placeholder',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const first = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', validRecord]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });
    expect(first).not.toBeNull();
    const credentialPath = join(first!.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
    expect(await readFile(credentialPath, 'utf8')).toContain('stable-access-placeholder');

    const second = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', invalidRecord]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(second).not.toBeNull();
    expect(second!.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_subscription_missing_claude_code_scope',
      severity: 'blocking',
    }));
    const preservedCredential = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(preservedCredential.claudeAiOauth.accessToken).toBe('stable-access-placeholder');
    expect(preservedCredential.claudeAiOauth.refreshToken).toBe('stable-refresh-placeholder');
  });

  it('re-materializes an existing stable profile home from the real Claude source env instead of self-sourcing stale target state', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'probe@example.test',
        displayName: 'Probe User',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toEqual({
      emailAddress: 'probe@example.test',
      displayName: 'Probe User',
    });
    expect(targetConfig.projects).toEqual({
      '/Users/leeroy/Documents/Development/happier/remote-dev': {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('reuses an existing stable profile home as the authoritative Claude source when Happier-owned provenance matches', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'target@example.test',
        displayName: 'Target Home',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"target"}\n');
    await writeFile(join(existingTargetDir, 'provider-state-marker.txt'), 'keep-provider-owned-state\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'source@example.test',
        displayName: 'Source Home',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    await writeFile(join(existingTargetDir, '.happier-claude-connected-service-home.json'), `${JSON.stringify(
      buildClaudeConnectedServiceHomeProvenance({
        record,
        selectionDescriptor: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'oauth-profile',
        },
      }),
    )}\n`);

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"target"}\n');
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toEqual({
      emailAddress: 'target@example.test',
      displayName: 'Target Home',
    });
    const credential = JSON.parse(await readFile(join(existingTargetDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    await expect(readFile(join(existingTargetDir, 'provider-state-marker.txt'), 'utf8')).resolves.toBe(
      'keep-provider-owned-state\n',
    );
  });

  it('does not trust an existing target oauthAccount when the selected Claude record has no stable identity', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'stale@example.test',
        displayName: 'Stale Target',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'fresh@example.test',
        displayName: 'Fresh Source',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toEqual({
      emailAddress: 'fresh@example.test',
      displayName: 'Fresh Source',
    });
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('falls back to the real HOME-based Claude source when the ambient CLAUDE_CONFIG_DIR already points at the managed target home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const homeClaudeConfigDir = join(homeDir, '.claude');
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(homeClaudeConfigDir, { recursive: true });
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(homeClaudeConfigDir, 'settings.json'), '{"theme":"home-source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'home@example.test',
        displayName: 'Home Source',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'stale-target@example.test',
        displayName: 'Stale Managed Target',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');

    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: existingTargetDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"home-source"}\n');
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toEqual({
      emailAddress: 'home@example.test',
      displayName: 'Home Source',
    });
  });

  it('preserves credentials when the source and target Claude config dirs are the same', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-same-config-'));
    await writeFile(
      join(claudeConfigDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'same-dir-access-placeholder',
          refreshToken: 'same-dir-refresh-placeholder',
          expiresAt: 1000,
          scopes: ['user:inference'],
        },
      }),
    );

    await expect(syncClaudeConnectedServiceHome({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        HOME: tmpdir(),
      },
      targetDir: claudeConfigDir,
    })).resolves.toEqual({
      providerId: 'claude',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      diagnostics: [],
    });

    const credential = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('same-dir-access-placeholder');
    expect(credential.claudeAiOauth.refreshToken).toBe('same-dir-refresh-placeholder');
  });
});
