import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);
const embeddedNativeCli = requireFromHere('../../scripts/lib/embedded-native-cli.cjs') as {
  assertNativeBinaryTarget(binaryPath: string, target: string): void;
  assertNativeTarget(compileTarget: string | undefined, host?: { platform: string; arch: string }): string;
  assertSpawnableBinary(binaryPath: string): void;
  parseBunCompileTarget(target: string): { platform: string; arch: string; abi?: string } | undefined;
  readNativeBinaryTarget(binaryPath: string): { format: string; platform: string; arch: string } | undefined;
  resolveEmbeddedNativeCliFiles(options: {
    nodeModulesRoot: string;
    target?: string;
    packages?: { name: string; files: { relativePath: string; executable?: boolean; required?: boolean }[] }[];
  }): { relativePath: string; sourcePath: string; executable: boolean }[];
  resolveNativeTarget(
    compileTarget: string | undefined,
    host?: { platform: string; arch: string },
  ): string;
  stageEmbeddedNativeCli(stageRoot: string, options: {
    nodeModulesRoot: string;
    compileTarget?: string;
    host?: { platform: string; arch: string };
    packages?: { name: string; files: { relativePath: string; executable?: boolean; required?: boolean }[] }[];
  }): string[];
};

const repoRoot = process.cwd();
const testRoot = path.join(repoRoot, '.test-data', 'embedded-native-cli');
const realInngestBinary = path.join(repoRoot, 'node_modules', 'inngest-cli', 'bin', 'inngest');
const realInngestDir = path.dirname(path.dirname(realInngestBinary));
const hasRealInngest = existsSync(realInngestBinary);
const HOST = { platform: process.platform, arch: process.arch };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = path.join(testRoot, `case-${roots.length}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function writeMachOHeader(file: string, cpuType: number): void {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  writeFileSync(file, bytes);
}

function writeElfHeader(file: string, machine: number): void {
  const bytes = Buffer.alloc(32);
  [ 0x7f, 0x45, 0x4c, 0x46 ].forEach((value, index) => {
    bytes[index] = value;
  });
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  writeFileSync(file, bytes);
}

function fixture(binaryContents = '#!/bin/sh\nexit 0\n'): { nodeModulesRoot: string; stageRoot: string } {
  const root = newRoot();
  const nodeModulesRoot = path.join(root, 'node_modules');
  const stageRoot = path.join(root, 'stage');
  const binDir = path.join(nodeModulesRoot, 'inngest-cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'inngest');
  writeFileSync(binary, binaryContents);
  chmodSync(binary, 0o755);
  writeFileSync(path.join(binDir, 'LICENSE.md'), 'license text\n');
  writeFileSync(path.join(nodeModulesRoot, 'inngest-cli', 'package.json'), JSON.stringify({ name: 'inngest-cli', version: '1.40.0' }));
  writeFileSync(path.join(nodeModulesRoot, 'inngest-cli', 'README.md'), 'readme\n');
  return { nodeModulesRoot, stageRoot };
}

function fixtureWithRealBinary(): { nodeModulesRoot: string; stageRoot: string } {
  const root = newRoot();
  const nodeModulesRoot = path.join(root, 'node_modules');
  const stageRoot = path.join(root, 'stage');
  const binDir = path.join(nodeModulesRoot, 'inngest-cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(realInngestBinary, path.join(binDir, 'inngest'));
  for (const relative of [ 'bin/LICENSE.md', 'package.json', 'README.md' ]) {
    const source = path.join(realInngestDir, relative);
    if (existsSync(source)) {
      copyFileSync(source, path.join(nodeModulesRoot, 'inngest-cli', relative));
    }
  }
  return { nodeModulesRoot, stageRoot };
}

describe('embedded native CLI staging', () => {
  it('parses supported Bun compile targets, captures ABI, and rejects unsupported ones', () => {
    expect(embeddedNativeCli.parseBunCompileTarget('bun-darwin-arm64')).toMatchObject({ platform: 'darwin', arch: 'arm64' });
    expect(embeddedNativeCli.parseBunCompileTarget('bun-linux-x64-musl')).toMatchObject({ platform: 'linux', arch: 'x64', abi: 'musl' });
    expect(embeddedNativeCli.parseBunCompileTarget('bun-windows-x64')).toBeUndefined();
    expect(embeddedNativeCli.parseBunCompileTarget('not-a-target')).toBeUndefined();
  });

  it('resolves host target and explicitly refuses cross targets and ABI-qualified targets', () => {
    const host = { platform: 'darwin', arch: 'arm64' };
    expect(embeddedNativeCli.resolveNativeTarget(undefined, host)).toBe('darwin-arm64');
    expect(embeddedNativeCli.resolveNativeTarget('bun-darwin-arm64', host)).toBe('darwin-arm64');
    expect(() => embeddedNativeCli.resolveNativeTarget('bun-linux-x64', host)).toThrow(/cross target/);
    expect(() => embeddedNativeCli.resolveNativeTarget('bun-linux-x64-musl', host)).toThrow(/Unsupported ABI/);
    expect(() => embeddedNativeCli.resolveNativeTarget('bun-windows-x64', host)).toThrow(/Unrecognized/);
    expect(() => embeddedNativeCli.resolveNativeTarget(undefined, { platform: 'sunos', arch: 'sparc' })).toThrow(/Unsupported host native target/);
  });

  it('reads the real architecture from Mach-O and ELF headers', () => {
    const root = newRoot();
    const machoArm = path.join(root, 'macho-arm'); writeMachOHeader(machoArm, 0x0100000c);
    const machoX64 = path.join(root, 'macho-x64'); writeMachOHeader(machoX64, 0x01000007);
    const elfArm = path.join(root, 'elf-arm'); writeElfHeader(elfArm, 183);
    const elfX64 = path.join(root, 'elf-x64'); writeElfHeader(elfX64, 62);
    const truncated = path.join(root, 'truncated'); writeFileSync(truncated, 'not a binary');

    expect(embeddedNativeCli.readNativeBinaryTarget(machoArm)).toMatchObject({ format: 'macho', platform: 'darwin', arch: 'arm64' });
    expect(embeddedNativeCli.readNativeBinaryTarget(machoX64)).toMatchObject({ format: 'macho', platform: 'darwin', arch: 'x64' });
    expect(embeddedNativeCli.readNativeBinaryTarget(elfArm)).toMatchObject({ format: 'elf', platform: 'linux', arch: 'arm64' });
    expect(embeddedNativeCli.readNativeBinaryTarget(elfX64)).toMatchObject({ format: 'elf', platform: 'linux', arch: 'x64' });
    expect(embeddedNativeCli.readNativeBinaryTarget(truncated)).toBeUndefined();

    // Wrong architecture (the Rosetta case) must be rejected even though it runs.
    expect(() => embeddedNativeCli.assertNativeBinaryTarget(machoArm, 'darwin-x64')).toThrow(/does not match requested target/);
    expect(() => embeddedNativeCli.assertNativeBinaryTarget(machoX64, 'darwin-arm64')).toThrow(/does not match requested target/);
  });

  it('fails the build when release-required license or package.json is missing', () => {
    const a = fixture();
    rmSync(path.join(a.nodeModulesRoot, 'inngest-cli', 'bin', 'LICENSE.md'));
    expect(() => embeddedNativeCli.stageEmbeddedNativeCli(a.stageRoot, {
      nodeModulesRoot: a.nodeModulesRoot,
      host: HOST,
    })).toThrow(/Required embedded native CLI file is missing: .*LICENSE\.md/);

    const b = fixture();
    rmSync(path.join(b.nodeModulesRoot, 'inngest-cli', 'package.json'));
    expect(() => embeddedNativeCli.stageEmbeddedNativeCli(b.stageRoot, {
      nodeModulesRoot: b.nodeModulesRoot,
      host: HOST,
    })).toThrow(/Required embedded native CLI file is missing: .*package\.json/);

    const c = fixture();
    rmSync(path.join(c.nodeModulesRoot, 'inngest-cli', 'bin', 'inngest'));
    expect(() => embeddedNativeCli.stageEmbeddedNativeCli(c.stageRoot, {
      nodeModulesRoot: c.nodeModulesRoot,
      host: HOST,
    })).toThrow(/Required embedded native CLI file is missing: .*bin\/inngest/);
  });

  it('rejects a non-native executable before it can be staged, and rejects an unspawnable binary', () => {
    const { nodeModulesRoot, stageRoot } = fixture();
    expect(() => embeddedNativeCli.stageEmbeddedNativeCli(stageRoot, {
      nodeModulesRoot,
      host: HOST,
    })).toThrow(/Unrecognized native binary format/);

    const broken = [...roots].at(-1)!;
    const brokenBinary = path.join(broken, 'broken.sh');
    writeFileSync(brokenBinary, '#!/bin/sh\nexit 1\n');
    chmodSync(brokenBinary, 0o755);
    expect(() => embeddedNativeCli.assertSpawnableBinary(brokenBinary)).toThrow(/not spawnable/);
  });

  it.skipIf(!hasRealInngest)('stages the installed CLI for the host target with its executable mode and license files', () => {
    const { nodeModulesRoot, stageRoot } = fixtureWithRealBinary();
    const staged = embeddedNativeCli.stageEmbeddedNativeCli(stageRoot, {
      nodeModulesRoot,
      host: HOST,
    });

    const binaryRelative = 'node_modules/inngest-cli/bin/inngest';
    expect(staged).toContain(binaryRelative);
    const stagedBinary = path.join(stageRoot, binaryRelative);
    expect(statSync(stagedBinary).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(stageRoot, 'node_modules/inngest-cli/bin/LICENSE.md'), 'utf8')).toContain('Server Side Public License');
    expect(existsSync(path.join(stageRoot, 'node_modules/inngest-cli/package.json'))).toBe(true);

    const detected = embeddedNativeCli.readNativeBinaryTarget(stagedBinary);
    expect(detected).toMatchObject({ platform: HOST.platform, arch: HOST.arch });
    expect(spawnSync(stagedBinary, ['--help'], { stdio: 'ignore' }).status).toBe(0);
  });

  it.skipIf(!(hasRealInngest && process.platform === 'darwin' && process.arch === 'arm64'))(
    'proves the promised release target is Mach-O arm64',
    () => {
      expect(embeddedNativeCli.readNativeBinaryTarget(realInngestBinary)).toMatchObject({ format: 'macho', platform: 'darwin', arch: 'arm64' });
      expect(() => embeddedNativeCli.assertNativeBinaryTarget(realInngestBinary, 'darwin-arm64')).not.toThrow();
    },
  );
});
