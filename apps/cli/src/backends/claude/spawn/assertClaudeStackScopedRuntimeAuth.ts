import { basename, join } from 'node:path';

import { getAgentAuthProbeConfig } from '@happier-dev/agents';
import { readJsonFileSafe, readStringField } from '@/capabilities/cliAuth/shared';
import {
  findConnectedServiceChildSelection,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

const FALLBACK_CLAUDE_CREDENTIAL_FILES = ['.credentials.json', '.claude.json'] as const;

function readNonBlankEnvValue(env: EnvLike, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasStackRuntimeMarker(env: EnvLike): boolean {
  return (
    readNonBlankEnvValue(env, 'HAPPIER_STACK_ENV_FILE') !== null
    || readNonBlankEnvValue(env, 'HAPPIER_STACK_STACK') !== null
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const asDate = Date.parse(trimmed);
  return Number.isFinite(asDate) ? asDate : null;
}

function hasUsableClaudeCredentialsRecord(record: Record<string, unknown>): boolean {
  const accessToken = readStringField(record, 'accessToken');
  if (!accessToken) return false;

  const expiryMs = readExpiryMs(record.expiresAt);
  if (expiryMs !== null && expiryMs <= Date.now()) return false;

  return true;
}

function hasUsableCredentialsFile(claudeConfigDir: string): boolean {
  const credentialFiles =
    getAgentAuthProbeConfig('claude').credentialPaths?.map((credentialPath) => basename(credentialPath))
    ?? FALLBACK_CLAUDE_CREDENTIAL_FILES;

  for (const credentialFile of credentialFiles) {
    const parsed = readJsonFileSafe(join(claudeConfigDir, credentialFile));
    const record = asRecord(parsed);
    if (!record) continue;

    if (hasUsableClaudeCredentialsRecord(record)) return true;

    const claudeAiOauth = asRecord(record.claudeAiOauth);
    if (claudeAiOauth && hasUsableClaudeCredentialsRecord(claudeAiOauth)) return true;
  }

  return false;
}

function hasConnectedServiceMaterializedAuth(params: Readonly<{
  runnerEnv: EnvLike;
  childEnv: EnvLike;
}>): boolean {
  const selection =
    findConnectedServiceChildSelection(params.runnerEnv, 'claude-subscription')
    ?? findConnectedServiceChildSelection(params.runnerEnv, 'anthropic');
  if (!selection) return false;

  const expectedKeys =
    selection.serviceId === 'anthropic'
      ? ['ANTHROPIC_API_KEY']
      : ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SETUP_TOKEN'];

  return expectedKeys.some((key) => readNonBlankEnvValue(params.childEnv, key) !== null);
}

function resolveStackName(env: EnvLike): string | null {
  return readNonBlankEnvValue(env, 'HAPPIER_STACK_STACK');
}

function buildMissingStackClaudeAuthMessage(params: Readonly<{
  stackName: string | null;
  hasClaudeConfigDir: boolean;
}>): string {
  const stackLabel = params.stackName ? ` for stack "${params.stackName}"` : '';
  const configState = params.hasClaudeConfigDir
    ? 'CLAUDE_CONFIG_DIR is set, but it does not contain a usable Claude credentials file.'
    : 'CLAUDE_CONFIG_DIR is not set, so Claude would fall back to the live default Claude home.';

  return [
    `Missing stack-scoped Claude auth${stackLabel}.`,
    configState,
    'Copy or materialize Claude auth into the stack-scoped Claude config before launch; do not rely on live ~/.claude or ambient provider auth env.',
  ].join(' ');
}

export function assertClaudeStackScopedRuntimeAuth(params: Readonly<{
  runnerEnv: EnvLike;
  childEnv: EnvLike;
}>): void {
  if (!hasStackRuntimeMarker(params.runnerEnv) && !hasStackRuntimeMarker(params.childEnv)) {
    return;
  }

  if (hasConnectedServiceMaterializedAuth(params)) {
    return;
  }

  const claudeConfigDir = readNonBlankEnvValue(params.childEnv, 'CLAUDE_CONFIG_DIR');
  if (claudeConfigDir && hasUsableCredentialsFile(claudeConfigDir)) {
    return;
  }

  throw new Error(buildMissingStackClaudeAuthMessage({
    stackName: resolveStackName(params.runnerEnv) ?? resolveStackName(params.childEnv),
    hasClaudeConfigDir: claudeConfigDir !== null,
  }));
}
