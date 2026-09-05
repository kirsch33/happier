import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accessSync: vi.fn(),
    statSync: vi.fn(),
    spawnSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    accessSync: mocks.accessSync,
    statSync: mocks.statSync,
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawnSync: mocks.spawnSync,
}));

import { commandExistsOnPath, resolveCommandOnPath } from './commandExists';

describe('commandExistsOnPath packaged-runtime fallback', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.statSync.mockImplementation(() => { throw new Error('packaged fs probe unavailable'); });
        mocks.spawnSync.mockReturnValue({ status: 0 });
    });

    it('uses a side-effect-free shell file probe when the packaged fs probe false-negatives', () => {
        expect(commandExistsOnPath('systemctl', { path: '/usr/bin:/bin' })).toBe(true);
        expect(resolveCommandOnPath('systemctl', { path: '/usr/bin:/bin' })).toBe('/usr/bin/systemctl');
        expect(mocks.spawnSync).toHaveBeenCalledWith(
            '/bin/sh',
            ['-c', '[ -f "$1" ] && [ -x "$1" ]', 'happier-command-probe', '/usr/bin/systemctl'],
            expect.objectContaining({ stdio: 'ignore' }),
        );
    });
});
