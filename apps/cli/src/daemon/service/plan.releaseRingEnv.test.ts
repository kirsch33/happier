import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './plan';

describe('daemon service plan release ring env', () => {
  it('writes HAPPIER_PUBLIC_RELEASE_CHANNEL=dev into systemd unit env for the public dev lane', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      instanceId: 'cloud',
      userHomeDir: '/home/alice',
      happierHomeDir: '/home/alice/.happier',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://api.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });

    expect(plan.files[0]?.content ?? '').toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
  });

  it('uses current.version for Windows default-following daemon services', () => {
    const plan = planDaemonServiceInstall({
      platform: 'win32',
      instanceId: 'greatwhitelab',
      channel: 'publicdev',
      targetMode: 'default-following',
      userHomeDir: 'C:\\Users\\tester',
      happierHomeDir: 'C:\\Users\\tester\\.happier',
      serverUrl: 'https://happier-web.greatwhitelab.net',
      publicServerUrl: 'https://happier-web.greatwhitelab.net',
      webappUrl: 'https://happier-web.greatwhitelab.net',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      entryPath: 'C:\\Users\\tester\\.happier\\cli-dev\\versions\\0.2.10-dev.8\\package-dist\\index.mjs',
    });

    const wrapper = plan.files[0]?.content ?? '';
    expect(wrapper).toContain('cli-dev\\current.version');
    expect(wrapper).toContain('cli-dev\\versions\\{0}\\package-dist\\index.mjs');
    expect(wrapper).toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL');
    expect(wrapper).toContain("dev");
  });

});
