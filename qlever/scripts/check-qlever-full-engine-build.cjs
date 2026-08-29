#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
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

function defaultHomebrewPrefixPath() {
  if (process.env.XPOD_QLEVER_CMAKE_PREFIX_PATH) {
    return process.env.XPOD_QLEVER_CMAKE_PREFIX_PATH;
  }
  if (process.platform !== 'darwin' || !fileExists('/opt/homebrew')) {
    return undefined;
  }
  return [
    '/opt/homebrew',
    '/opt/homebrew/opt/icu4c',
    '/opt/homebrew/opt/openssl@3',
    '/opt/homebrew/opt/boost',
  ].filter(fileExists).join(';') || undefined;
}

function defaultIcuRoot() {
  if (process.env.XPOD_QLEVER_ICU_ROOT) {
    return process.env.XPOD_QLEVER_ICU_ROOT;
  }
  const homebrewIcu = '/opt/homebrew/opt/icu4c';
  return process.platform === 'darwin' && fileExists(homebrewIcu)
    ? homebrewIcu
    : undefined;
}

function hostArchitectureToken() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x86_64';
  return process.arch;
}

function pkgConfigOutput(args) {
  return execFileSync('pkg-config', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function pkgConfigJemalloc() {
  try {
    const flags = pkgConfigOutput(['--libs-only-L', 'jemalloc']);
    const libdir = pkgConfigOutput(['--variable=libdir', 'jemalloc']);
    const dylib = path.join(libdir, 'libjemalloc.dylib');
    if (process.platform === 'darwin' && fileExists(dylib)) {
      const info = execFileSync('file', [dylib], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!info.includes(hostArchitectureToken())) {
        return { flags: undefined, compatible: false };
      }
    }
    return { flags: flags || undefined, compatible: true };
  } catch {
    return { flags: undefined, compatible: true };
  }
}

function defaultExecutableLinkerFlags(jemalloc) {
  if (process.env.XPOD_QLEVER_CMAKE_EXE_LINKER_FLAGS) {
    return process.env.XPOD_QLEVER_CMAKE_EXE_LINKER_FLAGS;
  }
  return jemalloc.flags;
}

function defaultPkgConfigLibdir(jemalloc) {
  if (process.env.PKG_CONFIG_LIBDIR || jemalloc.compatible) {
    return undefined;
  }
  if (process.platform === 'darwin' && fileExists('/opt/homebrew')) {
    return [
      '/opt/homebrew/lib/pkgconfig',
      '/opt/homebrew/share/pkgconfig',
    ].join(':');
  }
  return undefined;
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

function readCmakeCacheHomeDirectory(cachePath) {
  if (!fileExists(cachePath)) {
    return undefined;
  }
  const content = fs.readFileSync(cachePath, 'utf8');
  const match = content.match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m);
  return match?.[1] ? path.resolve(match[1]) : undefined;
}

function hasStaleCmakeBuildCache(buildPath, sourcePath) {
  const homeDirectory = readCmakeCacheHomeDirectory(
    path.join(buildPath, 'CMakeCache.txt'),
  );
  return homeDirectory !== undefined && homeDirectory !== path.resolve(sourcePath);
}

function isSameOrAncestor(candidatePath, protectedPath) {
  const relative = path.relative(candidatePath, protectedPath);
  return relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeStaleBuildRemoval(buildPath, sourcePath) {
  const resolvedBuild = path.resolve(buildPath);
  const protectedPaths = [
    path.parse(resolvedBuild).root,
    path.resolve(os.homedir()),
    path.resolve(repoRoot, '..'),
    repoRoot,
    path.resolve(sourcePath),
  ];
  if (protectedPaths.some((protectedPath) =>
    isSameOrAncestor(resolvedBuild, protectedPath))) {
    fail(`refusing to remove unsafe stale CMake build directory: ${resolvedBuild}`);
  }
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
const jemalloc = pkgConfigJemalloc();
const pkgConfigLibdir = defaultPkgConfigLibdir(jemalloc);
const cmakeEnv = pkgConfigLibdir
  ? { ...process.env, PKG_CONFIG_LIBDIR: pkgConfigLibdir }
  : process.env;

const patchCheckArgs = [
  process.execPath,
  path.join('scripts', 'check-qlever-upstream-patches.cjs'),
  '--qlever-source',
  qleverSource,
  '--apply',
];

const xpodIncludeFlags = [
  '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
  `-I${path.join(repoRoot, 'qlever_adapter/src')}`,
  `-I${path.join(repoRoot, 'qlever_adapter/include')}`,
  `-I${path.join(repoRoot, 'rdf_protocol/include')}`,
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
maybeAdd(configureArgs, 'DCMAKE_PREFIX_PATH', defaultHomebrewPrefixPath());
maybeAdd(configureArgs, 'DCMAKE_EXE_LINKER_FLAGS', defaultExecutableLinkerFlags(jemalloc));
maybeAdd(configureArgs, 'DICU_ROOT', defaultIcuRoot());
maybeAdd(configureArgs, 'DBoost_DIR', process.env.XPOD_QLEVER_BOOST_DIR);

const buildArgs = ['--build', buildDir, '--target', target, `-j${jobs}`];
const staleBuildCache = hasStaleCmakeBuildCache(buildDir, qleverSource);

if (dryRun) {
  const payload = {
    patchCheckArgs: patchCheckArgs.slice(1),
    configureArgs,
    buildArgs,
    configureEnv: pkgConfigLibdir ? { PKG_CONFIG_LIBDIR: pkgConfigLibdir } : {},
    staleBuildCache,
  };
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
    if (staleBuildCache) {
      assertSafeStaleBuildRemoval(buildDir, qleverSource);
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
    execFileSync('cmake', configureArgs, { cwd: repoRoot, stdio: 'inherit', env: cmakeEnv });
  }
  if (!configureOnly) {
    execFileSync('cmake', buildArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
} catch (error) {
  fail('full upstream QLever engine build failed', error);
}

console.log(`[qlever-full-engine] OK: built ${target} in ${buildDir}`);
