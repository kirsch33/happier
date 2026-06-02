import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import {
  HAPPIER_RUNTIME_CONTEXT_ENV_KEYS,
  resolveHappierRuntimeContextEnv,
  type HappierRuntimeServerContext,
} from '@/utils/env/resolveHappierRuntimeContextEnv';

type ChildServerSelectionEnv = HappierRuntimeServerContext;

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  happyHomeDir?: string;
  serverSelectionEnv?: ChildServerSelectionEnv;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;

  if (String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service') {
    env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY] = '1';
  } else {
    delete env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY];
  }

  if (params.happyHomeDir || params.serverSelectionEnv) {
    // Clear stale inherited context, then apply the authoritative daemon
    // selection via the shared runtime-context resolver.
    for (const key of HAPPIER_RUNTIME_CONTEXT_ENV_KEYS) {
      delete env[key];
    }
    Object.assign(env, resolveHappierRuntimeContextEnv({
      homeDir: params.happyHomeDir,
      server: params.serverSelectionEnv,
    }));
  }

  return env;
}
