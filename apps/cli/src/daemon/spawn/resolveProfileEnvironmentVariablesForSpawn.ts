import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { Credentials } from '@/persistence';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';

export function readSpawnProfileId(options: SpawnSessionOptions): string | null {
  const raw = options.profileId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveProfileEnvironmentVariablesForSpawn(params: Readonly<{
  options: SpawnSessionOptions;
  providedEnvironmentVariables: Record<string, string>;
  credentials: Credentials;
  processEnv: NodeJS.ProcessEnv;
  accountSettings: Readonly<Record<string, unknown>> | null;
  logDebug: (message: string) => void;
}>): Promise<Record<string, string>> {
  const profileId = readSpawnProfileId(params.options);
  if (!profileId) return params.providedEnvironmentVariables;
  const agentId =
    params.options.backendTarget?.kind === 'builtInAgent'
      ? params.options.backendTarget.agentId
      : null;
  if (!agentId) return params.providedEnvironmentVariables;

  if (!params.accountSettings) {
    params.logDebug(`[DAEMON RUN] Profile ${profileId} could not be resolved because account settings are unavailable`);
    return params.providedEnvironmentVariables;
  }

  const profile = readProfilesFromAccountSettings(params.accountSettings)
    .customProfiles
    .find((candidate) => candidate.id === profileId);
  if (!profile) {
    params.logDebug(`[DAEMON RUN] Profile ${profileId} is not present in account settings; using caller-provided environment only`);
    return params.providedEnvironmentVariables;
  }

  const overlay = await buildProfileEnvOverlay({
    agentId,
    profile,
    accountSettings: params.accountSettings,
    credentials: params.credentials,
    processEnv: params.processEnv,
    promptSecretFn: null,
    startedBy: 'daemon',
  });
  const merged = {
    ...overlay.envOverlayExpanded,
    ...params.providedEnvironmentVariables,
  };
  const addedKeys = Object.keys(overlay.envOverlayExpanded)
    .filter((key) => params.providedEnvironmentVariables[key] === undefined);
  params.logDebug(
    `[DAEMON RUN] Rehydrated profile environment for ${profileId} (${addedKeys.length} added keys)`,
  );
  return merged;
}
