export const HAPPIER_FRESH_PROVIDER_CONTEXT_ONCE = 'HAPPIER_FRESH_PROVIDER_CONTEXT_ONCE';

export function consumeFreshProviderContextOnce(env: NodeJS.ProcessEnv = process.env): boolean {
  const fresh = env[HAPPIER_FRESH_PROVIDER_CONTEXT_ONCE] === '1';
  delete env[HAPPIER_FRESH_PROVIDER_CONTEXT_ONCE];
  return fresh;
}
