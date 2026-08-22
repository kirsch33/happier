import { describe, expect, it } from 'vitest';

import { buildServiceDefinition } from './manager';

describe('buildServiceDefinition environment files', () => {
  const spec = {
    label: 'dev.happier.relay',
    programArgs: ['/opt/happier/bin/happier-server'],
    environmentFiles: ['/etc/happier/server.env', '/etc/happier/runtime env'],
  } as const;

  it('renders ordered environment files without inlining environment contents', () => {
    const definition = buildServiceDefinition({
      backend: 'systemd-system',
      homeDir: '/root',
      spec,
    });

    expect(definition.mode).toBe(0o644);
    expect(definition.contents).toContain('EnvironmentFile=/etc/happier/server.env\nEnvironmentFile="/etc/happier/runtime env"');
    expect(definition.contents).not.toContain('database-password');
  });

  it.each(['launchd-system', 'schtasks-system'] as const)(
    'rejects environment-file features for %s before a definition can be written or commands planned',
    (backend) => {
      expect(() => buildServiceDefinition({ backend, homeDir: '/root', spec })).toThrow(/only supported by systemd/i);
    },
  );

  it('requires single-line absolute environment file paths', () => {
    expect(() => buildServiceDefinition({
      backend: 'systemd-system',
      homeDir: '/root',
      spec: {
        ...spec,
        environmentFiles: ['relative/server.env'],
      },
    })).toThrow(/absolute/i);

    expect(() => buildServiceDefinition({
      backend: 'systemd-system',
      homeDir: '/root',
      spec: {
        ...spec,
        environmentFiles: ['/etc/happier/server.env\nEnvironment=LEAKED'],
      },
    })).toThrow(/newlines/i);
  });
});
