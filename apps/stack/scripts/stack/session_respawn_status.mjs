function parseOptionalBooleanEnv(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return null;
}

export function resolveStackSessionRespawnStatus(env = {}) {
  const explicit = parseOptionalBooleanEnv(env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED);
  if (explicit !== null) {
    return {
      enabled: explicit,
      source: 'explicit_env',
    };
  }
  return {
    enabled: true,
    source: 'stack_default',
  };
}
