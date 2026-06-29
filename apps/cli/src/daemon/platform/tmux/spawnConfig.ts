import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import {
  HAPPIER_RUNTIME_CONTEXT_ENV_KEYS,
  resolveHappierRuntimeContextEnv,
  type HappierRuntimeServerContext,
} from '@/utils/env/resolveHappierRuntimeContextEnv';
import type { CatalogAgentId } from '@/backends/types';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';
type TmuxServerSelectionEnv = HappierRuntimeServerContext;

function buildTmuxRuntimeContextEnv(params: {
  homeDir?: string;
  serverSelectionEnv?: TmuxServerSelectionEnv;
}): Record<string, string> {
  if (!params.homeDir && !params.serverSelectionEnv) return {};

  const cleared = Object.fromEntries(
    HAPPIER_RUNTIME_CONTEXT_ENV_KEYS.map((key) => [key, ''] as const),
  ) as Record<string, string>;

  return {
    ...cleared,
    ...resolveHappierRuntimeContextEnv({
      homeDir: params.homeDir ?? null,
      server: params.serverSelectionEnv ?? null,
    }),
  };
}

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const essentialKeys = [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TSX_TSCONFIG_PATH',
    'USER',
    'LOGNAME',
  ] as const;

  const filteredDaemonEnv = Object.fromEntries(
    essentialKeys
      .map((key) => [key, daemonEnv[key]] as const)
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export function buildTmuxSpawnConfig(params: {
  agent: TmuxSpawnAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  homeDir?: string;
  serverSelectionEnv?: TmuxServerSelectionEnv;
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
}): {
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
} {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args);
  const commandTokens = [launchSpec.filePath, ...launchSpec.args];

  const tmuxEnv = buildTmuxWindowEnv(process.env, {
    ...params.extraEnv,
    ...(launchSpec.env ?? {}),
    ...buildTmuxRuntimeContextEnv({
      homeDir: params.homeDir,
      serverSelectionEnv: params.serverSelectionEnv,
    }),
  });

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv,
    tmuxCommandEnv,
    directory: params.directory,
  };
}
