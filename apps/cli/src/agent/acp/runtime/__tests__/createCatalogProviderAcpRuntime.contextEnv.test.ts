import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCatalogProviderAcpRuntime } from '../createCatalogProviderAcpRuntime';
import type { CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createCatalogAcpBackendSpy } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

const configurationMock = vi.hoisted(() => ({
  configuration: {
    happyHomeDir: '/tmp/happier-acp-runtime-home',
    activeServerId: 'stack-preview',
    serverUrl: 'https://public.happier.example',
    apiServerUrl: 'http://127.0.0.1:48999',
    webappUrl: 'https://app.happier.example',
  },
}));

vi.mock('@/configuration', () => configurationMock);
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCatalogProviderAcpRuntime context env', () => {
  it('passes the resolved Happier runtime context to catalog ACP backends', async () => {
    const createSpy = createCatalogAcpBackendSpy([]);

    const runtime = createCatalogProviderAcpRuntime<CatalogDefinedAcpBackendOptions>({
      provider: 'kimi',
      loggerLabel: 'test',
      directory: '/tmp/project',
      session: createApiSessionClientFixture(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      backendOptions: {
        env: {
          CUSTOM_PROVIDER_ENV: 'kept',
          HAPPIER_HOME_DIR: '/tmp/stale-home',
          HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        },
      },
    });

    await runtime.startOrLoad({});

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [, options] = createSpy.mock.calls[0] ?? [];
    const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    expect(env?.CUSTOM_PROVIDER_ENV).toBe('kept');
    expect(env?.HAPPIER_HOME_DIR).toBe('/tmp/happier-acp-runtime-home');
    expect(env?.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:48999');
    expect(env?.HAPPIER_PUBLIC_SERVER_URL).toBe('https://public.happier.example');
    expect(env?.HAPPIER_WEBAPP_URL).toBe('https://app.happier.example');
  });
});
