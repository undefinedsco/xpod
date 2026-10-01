import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertNativeTarget, bunCompileTarget } from '../src/native-target';

test('checks binary architecture and OS even when a cross artifact cannot run', () => {
  const root = path.resolve('.test-data/xpod-cli/native-target');
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
  const root = path.resolve('.test-data/xpod-cli/native-target');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'missing-'));
  try {
    const result = spawnSync(process.execPath, [
      path.resolve('packages/xpod-cli/scripts/build.ts'), '--target', `${process.platform}-${process.arch}`,
      '--helper', path.join(directory, 'missing-helper'), '--out', directory,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('native helper unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
