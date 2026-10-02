#!/usr/bin/env node
'use strict';

/**
 * Stage native CLI binaries that the single-file runtime spawns by path.
 *
 * Components.js reference walking only discovers packages that appear in
 * configuration, so path-spawned helpers (e.g. the Inngest CLI) never enter the
 * bundle on their own. This module embeds the already-installed native binary
 * for the matching build target. It never substitutes a host binary for a cross
 * target: a mismatch fails the build instead of silently shipping a runtime
 * that cannot spawn durable delivery.
 *
 * License/notice text and package.json are release-required material: a package
 * that drops them fails the build rather than shipping without them.
 *
 * The native-binary header check mirrors the authority in
 * packages/xpod-cli/src/native-target.ts (Mach-O/ELF magic + CPU type). It is
 * the only way to prove the *actual* binary architecture, because `--help` can
 * succeed through Rosetta for a wrong-architecture x64 binary.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The installed package is the single authority for file names and the license
// text; do not mirror the license here.
const EMBEDDED_NATIVE_CLI_PACKAGES = [
  {
    name: 'inngest-cli',
    files: [
      { relativePath: 'bin/inngest', executable: true, required: true },
      { relativePath: 'bin/LICENSE.md', required: true },
      { relativePath: 'package.json', required: true },
      { relativePath: 'README.md' },
    ],
  },
];

// Same supported native target set as packages/xpod-cli/src/native-target.ts.
// ABI-qualified targets (musl/gnu) and other platforms are rejected explicitly
// rather than silently ignored.
const NATIVE_TARGET_PLATFORMS = new Set([ 'darwin', 'linux' ]);
const NATIVE_TARGET_ARCHES = new Set([ 'x64', 'arm64' ]);

const MACHO_64_MAGIC_LE = 0xfeedfacf;
const MACHO_CPU_TYPE_X86_64 = 0x01000007;
const MACHO_CPU_TYPE_ARM64 = 0x0100000c;
const ELF_MAGIC = [ 0x7f, 0x45, 0x4c, 0x46 ];
const ELF_MACHINE_X86_64 = 62;
const ELF_MACHINE_ARM64 = 183;

function parseBunCompileTarget(target) {
  if (typeof target !== 'string' || target.trim().length === 0) {
    return undefined;
  }
  const match = /^(?:bun-)?([a-z0-9]+)-([a-z0-9_]+)(?:-([a-z0-9]+))?$/i.exec(target.trim());
  if (!match) {
    return undefined;
  }
  const platform = match[1].toLowerCase();
  const arch = match[2].toLowerCase();
  if (!NATIVE_TARGET_PLATFORMS.has(platform) || !NATIVE_TARGET_ARCHES.has(arch)) {
    return undefined;
  }
  return {
    platform,
    arch,
    abi: match[3] ? match[3].toLowerCase() : undefined,
  };
}

function parseNativeTargetId(target) {
  const match = /^([a-z0-9]+)-([a-z0-9_]+)$/i.exec(String(target ?? '').trim());
  if (!match) {
    return undefined;
  }
  const platform = match[1].toLowerCase();
  const arch = match[2].toLowerCase();
  if (!NATIVE_TARGET_PLATFORMS.has(platform) || !NATIVE_TARGET_ARCHES.has(arch)) {
    return undefined;
  }
  return { platform, arch, abi: undefined };
}

/**
 * Resolve the native target the embedded CLI must match. An untargeted build is
 * a host build. Cross targets and ABI-qualified targets fail here: the only
 * installed CLI binary is the host one, so there is nothing correct to embed.
 */
function resolveNativeTarget(compileTarget, host = { platform: process.platform, arch: process.arch }) {
  if (!compileTarget) {
    const hostTarget = `${host.platform}-${host.arch}`;
    if (!parseNativeTargetId(hostTarget)) {
      throw new Error(`Unsupported host native target for embedded CLI: ${hostTarget}`);
    }
    return hostTarget;
  }

  const requested = parseBunCompileTarget(compileTarget);
  if (!requested) {
    throw new Error(`Unrecognized or unsupported Bun compile target: ${compileTarget}`);
  }
  if (requested.abi) {
    throw new Error(
      `Unsupported ABI "${requested.abi}" in compile target ${compileTarget}; `
      + 'the installed CLI is the host binary only (no libc-qualified embed).',
    );
  }
  if (requested.platform !== host.platform || requested.arch !== host.arch) {
    throw new Error(
      `Cannot embed the native CLI for cross target ${compileTarget} on host ${host.platform}-${host.arch}. `
      + 'Build on a matching native runner.',
    );
  }
  return `${requested.platform}-${requested.arch}`;
}

function assertNativeTarget(compileTarget, host) {
  return resolveNativeTarget(compileTarget, host);
}

/** Read the actual architecture from a Mach-O/ELF header. */
function readNativeBinaryTarget(binaryPath) {
  const bytes = Buffer.alloc(32);
  const descriptor = fs.openSync(binaryPath, 'r');
  let count;
  try {
    count = fs.readSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
  if (count < 20) {
    return undefined;
  }

  const isElf = ELF_MAGIC.every((byte, index) => bytes[index] === byte)
    && bytes[4] === 2 && bytes[5] === 1;
  if (isElf) {
    const machine = bytes.readUInt16LE(18);
    if (machine === ELF_MACHINE_ARM64) {
      return { format: 'elf', platform: 'linux', arch: 'arm64' };
    }
    if (machine === ELF_MACHINE_X86_64) {
      return { format: 'elf', platform: 'linux', arch: 'x64' };
    }
    return { format: 'elf', platform: 'linux', arch: `unknown:${machine}` };
  }

  if (count >= 8 && bytes.readUInt32LE(0) === MACHO_64_MAGIC_LE) {
    const cpuType = bytes.readUInt32LE(4);
    if (cpuType === MACHO_CPU_TYPE_ARM64) {
      return { format: 'macho', platform: 'darwin', arch: 'arm64' };
    }
    if (cpuType === MACHO_CPU_TYPE_X86_64) {
      return { format: 'macho', platform: 'darwin', arch: 'x64' };
    }
    return { format: 'macho', platform: 'darwin', arch: `unknown:${cpuType}` };
  }

  return undefined;
}

function assertNativeBinaryTarget(binaryPath, target) {
  const expected = parseNativeTargetId(target);
  if (!expected) {
    throw new Error(`Invalid native target: ${target}`);
  }
  const actual = readNativeBinaryTarget(binaryPath);
  if (!actual) {
    throw new Error(`Unrecognized native binary format; cannot verify ${target}: ${binaryPath}`);
  }
  if (actual.platform !== expected.platform || actual.arch !== expected.arch) {
    throw new Error(
      `Native executable ${actual.platform}-${actual.arch} does not match requested target ${target}: ${binaryPath}`,
    );
  }
}

function assertSpawnableBinary(binaryPath, run = spawnSync) {
  const result = run(binaryPath, ['--help'], { stdio: 'ignore', timeout: 15_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`Embedded native CLI is not spawnable: ${binaryPath} (${detail})`);
  }
}

function resolveEmbeddedNativeCliFiles(options) {
  const nodeModulesRoot = options?.nodeModulesRoot;
  if (typeof nodeModulesRoot !== 'string' || nodeModulesRoot.length === 0) {
    throw new Error('nodeModulesRoot is required to resolve embedded native CLI files');
  }
  const target = options?.target;
  const packages = options.packages ?? EMBEDDED_NATIVE_CLI_PACKAGES;
  const entries = [];

  for (const packageSpec of packages) {
    const packageDir = path.join(nodeModulesRoot, packageSpec.name);
    const packageEntries = [];
    for (const file of packageSpec.files) {
      const sourcePath = path.join(packageDir, file.relativePath);
      if (!fs.existsSync(sourcePath)) {
        if (file.required) {
          throw new Error(`Required embedded native CLI file is missing: ${sourcePath}`);
        }
        continue;
      }
      packageEntries.push({
        relativePath: path.posix.join('node_modules', packageSpec.name, ...file.relativePath.split(path.sep)),
        sourcePath,
        executable: Boolean(file.executable),
      });
    }

    for (const entry of packageEntries) {
      if (!entry.executable) {
        continue;
      }
      if (!target) {
        throw new Error('A native target is required to validate an embedded native CLI executable');
      }
      assertNativeBinaryTarget(entry.sourcePath, target);
      assertSpawnableBinary(entry.sourcePath);
    }
    entries.push(...packageEntries);
  }

  return entries;
}

function stageEmbeddedNativeCli(stageRoot, options) {
  const target = resolveNativeTarget(options?.compileTarget, options?.host);
  const entries = resolveEmbeddedNativeCliFiles({ ...options, target });
  for (const entry of entries) {
    const destination = path.join(stageRoot, entry.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.sourcePath, destination);
    if (entry.executable) {
      fs.chmodSync(destination, 0o755);
    }
  }
  return entries.map((entry) => entry.relativePath);
}

module.exports = {
  EMBEDDED_NATIVE_CLI_PACKAGES,
  assertNativeBinaryTarget,
  assertNativeTarget,
  assertSpawnableBinary,
  parseBunCompileTarget,
  readNativeBinaryTarget,
  resolveEmbeddedNativeCliFiles,
  resolveNativeTarget,
  stageEmbeddedNativeCli,
};
