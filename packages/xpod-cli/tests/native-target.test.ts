import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativeTarget, bunBundleArguments, bunBundleEnvironment, bunCompileTarget } from '../src/native-target';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('bundles portable ESM without embedding or downloading a platform runtime', () => {
  const options = { target: 'darwin-arm64', hostTarget: 'darwin-arm64', entry: 'main.ts', outfile: 'cli', metafile: 'meta.json' };
  expect(bunBundleArguments(options)).toEqual(['build', '--target=node', '--format=esm', '--outfile', 'cli', '--metafile=meta.json', 'main.ts']);
  expect(bunBundleArguments({ ...options, target: 'linux-arm64' })).toEqual(bunBundleArguments(options));
  expect(() => bunBundleArguments({ ...options, target: '../../escape' })).toThrow('Unsupported');
  const environment = bunBundleEnvironment({ PATH: '/bin', NODE_ENV: 'production', BUN_OPTIONS: '--conditions=private', NODE_OPTIONS: '--loader=custom' });
  expect(environment.PATH).toBe('/bin');
  expect(environment.NODE_ENV).toBeUndefined();
  expect(environment.BUN_OPTIONS).toBeUndefined();
  expect(environment.NODE_OPTIONS).toBeUndefined();
});

test('checks binary architecture and OS even when a cross artifact cannot run', () => {
  const root = path.join(repo, '.test-data/xpod-cli/native-target');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'headers-'));
  const file = path.join(directory, 'helper');
  try {
    const elf = Buffer.alloc(32);
    Buffer.from([ 0x7f, 0x45, 0x4c, 0x46, 2, 1 ]).copy(elf);
    elf.writeUInt16LE(183, 18);
    writeFileSync(file, elf);
    expect(() => assertNativeTarget(file, 'linux-arm64')).not.toThrow();
    expect(() => assertNativeTarget(file, 'linux-x64')).toThrow('does not match');
    expect(() => assertNativeTarget(file, 'darwin-arm64')).toThrow('does not match');
    const macho = Buffer.alloc(32);
    macho.writeUInt32LE(0xfeedfacf, 0);
    macho.writeUInt32LE(0x0100000c, 4);
    writeFileSync(file, macho);
    expect(() => assertNativeTarget(file, 'darwin-arm64')).not.toThrow();
    expect(() => assertNativeTarget(file, 'linux-arm64')).toThrow('does not match');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    expect(() => assertNativeTarget(file, 'darwin-arm64')).toThrow('does not match');
    expect(bunCompileTarget('linux-x64')).toBe('bun-linux-x64');
    expect(() => bunCompileTarget('windows-arm64')).toThrow('Unsupported');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an explicit missing helper fails instead of falling back to a checkout helper', () => {
  const root = path.join(repo, '.test-data/xpod-cli/native-target');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'missing-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(repo, 'packages/xpod-cli/scripts/build.ts'), '--target', `${process.platform}-${process.arch}`,
      '--helper', path.join(directory, 'missing-helper'), '--out', directory,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('native helper unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
