import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { commandExistsOnPath } from './commandExists.js';

describe('commandExistsOnPath', () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('finds a Unix executable when PATH has no shell', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-command-exists-'));
    tempDirs.add(root);
    const executable = join(root, 'relay-probe');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(commandExistsOnPath('relay-probe', { path: root })).toBe(true);
  });

  it('accepts executable absolute and relative slash paths', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-command-exists-'));
    tempDirs.add(root);
    const executable = join(root, 'bin', 'relay-probe');
    mkdirSync(join(root, 'bin'));
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(commandExistsOnPath(executable, { path: '' })).toBe(true);
    expect(commandExistsOnPath(relative(process.cwd(), executable), { path: '' })).toBe(true);
  });

  it('treats an empty PATH segment as the current directory', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-command-exists-'));
    tempDirs.add(root);
    const originalCwd = process.cwd();
    const executable = join(root, 'relay-probe');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    try {
      process.chdir(root);
      expect(commandExistsOnPath('relay-probe', { path: '' })).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('follows executable symlink targets', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-command-exists-'));
    tempDirs.add(root);
    const executable = join(root, 'relay-probe-target');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    symlinkSync(executable, join(root, 'relay-probe'));

    expect(commandExistsOnPath('relay-probe', { path: root })).toBe(true);
  });

  it('rejects non-executable files, directories, and missing paths', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-command-exists-'));
    tempDirs.add(root);
    writeFileSync(join(root, 'not-executable'), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(root, 'directory'));

    expect(commandExistsOnPath('not-executable', { path: root })).toBe(false);
    expect(commandExistsOnPath('directory', { path: root })).toBe(false);
    expect(commandExistsOnPath('missing/path', { path: root })).toBe(false);
  });
});
