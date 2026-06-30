#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function fail(message, error) {
  console.error(`[qlever-full-engine] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function maybeAdd(args, cmakeName, value) {
  if (value) {
    args.push(`-${cmakeName}=${value}`);
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function defaultCompiler(name) {
  const envName = name === 'C' ? 'XPOD_QLEVER_CMAKE_C_COMPILER' : 'XPOD_QLEVER_CMAKE_CXX_COMPILER';
  if (process.env[envName]) return process.env[envName];
  const homebrew = name === 'C'
    ? '/opt/homebrew/opt/llvm/bin/clang'
    : '/opt/homebrew/opt/llvm/bin/clang++';
  if (process.platform === 'darwin' && fileExists(homebrew)) return homebrew;
  return undefined;
}

const sourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
if (!sourceInput) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}

const qleverSource = path.resolve(sourceInput);
const buildDir = path.resolve(
  readArg('--build-dir') || process.env.XPOD_QLEVER_FULL_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-full-build'),
);
const target = readArg('--target') || process.env.XPOD_QLEVER_FULL_ENGINE_TARGET || 'engine';
const jobs = readArg('--jobs') || process.env.XPOD_QLEVER_FULL_ENGINE_JOBS || '2';
const dryRun = hasFlag('--dry-run');
const json = hasFlag('--json');
const configureOnly = hasFlag('--configure-only');
const buildOnly = hasFlag('--build-only');

const patchCheckArgs = [
  process.execPath,
  path.join('scripts', 'check-qlever-upstream-patches.cjs'),
  '--qlever-source',
  qleverSource,
];

const xpodIncludeFlags = [
  '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
  `-I${path.join(repoRoot, 'native/postgres/qlever_adapter/src')}`,
  `-I${path.join(repoRoot, 'native/postgres/qlever_adapter/include')}`,
  `-I${path.join(repoRoot, 'native/postgres/rdf_protocol/include')}`,
].join(' ');

const configureArgs = [
  '-S', qleverSource,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCHEAPER_COMPILATION=ON',
  '-DUSE_PRECOMPILED_HEADERS=OFF',
  '-DUSE_IO_URING=OFF',
  `-DCMAKE_CXX_FLAGS=${xpodIncludeFlags}`,
];
maybeAdd(configureArgs, 'DCMAKE_C_COMPILER', defaultCompiler('C'));
maybeAdd(configureArgs, 'DCMAKE_CXX_COMPILER', defaultCompiler('CXX'));
maybeAdd(configureArgs, 'DCMAKE_PREFIX_PATH', process.env.XPOD_QLEVER_CMAKE_PREFIX_PATH);
maybeAdd(configureArgs, 'DICU_ROOT', process.env.XPOD_QLEVER_ICU_ROOT);
maybeAdd(configureArgs, 'DBoost_DIR', process.env.XPOD_QLEVER_BOOST_DIR);

const buildArgs = ['--build', buildDir, '--target', target, `-j${jobs}`];

if (dryRun) {
  const payload = { patchCheckArgs: patchCheckArgs.slice(1), configureArgs, buildArgs };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log('[qlever-full-engine] patch:', patchCheckArgs.join(' '));
    console.log('[qlever-full-engine] configure:', ['cmake', ...configureArgs].join(' '));
    console.log('[qlever-full-engine] build:', ['cmake', ...buildArgs].join(' '));
  }
  process.exit(0);
}

if (!fs.existsSync(qleverSource)) {
  fail(`QLever source tree does not exist: ${qleverSource}`);
}

try {
  execFileSync(patchCheckArgs[0], patchCheckArgs.slice(1), { cwd: repoRoot, stdio: 'inherit' });
  if (!buildOnly) {
    execFileSync('cmake', configureArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!configureOnly) {
    execFileSync('cmake', buildArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
} catch (error) {
  fail('full upstream QLever engine build failed', error);
}

console.log(`[qlever-full-engine] OK: built ${target} in ${buildDir}`);
