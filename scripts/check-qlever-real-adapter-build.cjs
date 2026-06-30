#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const adapterRoot = path.join(repoRoot, 'native/postgres/qlever_adapter');

function fail(message, error) {
  console.error(`[qlever-real-adapter] ${message}`);
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

function splitCommand(command) {
  const result = [];
  let token = '';
  let quote = '';
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        result.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (token) {
    result.push(token);
  }
  return result;
}

function addExistingDir(dirs, value, baseDir) {
  if (!value) return;
  const resolved = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
  if (fileExists(resolved) && fs.statSync(resolved).isDirectory()) {
    dirs.add(resolved);
  }
}

function dependencyIncludeDirsFromCompileCommands(compileCommandsPath) {
  if (!fileExists(compileCommandsPath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(compileCommandsPath, 'utf8'));
  const dirs = new Set();
  for (const entry of parsed) {
    const baseDir = entry.directory || path.dirname(compileCommandsPath);
    const tokens = Array.isArray(entry.arguments)
      ? entry.arguments
      : splitCommand(String(entry.command || ''));
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === '-I' || token === '-isystem' || token === '-iquote' || token === '-idirafter') {
        addExistingDir(dirs, tokens[i + 1], baseDir);
        i += 1;
      } else if (token.startsWith('-I') && token.length > 2) {
        addExistingDir(dirs, token.slice(2), baseDir);
      } else if (token.startsWith('-isystem') && token.length > '-isystem'.length) {
        addExistingDir(dirs, token.slice('-isystem'.length), baseDir);
      }
    }
  }
  return [...dirs];
}

const sourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
if (!sourceInput) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}

const qleverSource = path.resolve(sourceInput);
const qleverBuildDir = path.resolve(
  readArg('--qlever-build-dir') || process.env.XPOD_QLEVER_FULL_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-full-build'),
);
const adapterBuildDir = path.resolve(
  readArg('--adapter-build-dir') || process.env.XPOD_QLEVER_REAL_ADAPTER_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
);
const compileCommandsPath = path.resolve(
  readArg('--compile-commands') || path.join(qleverBuildDir, 'compile_commands.json'),
);
const jobs = readArg('--jobs') || process.env.XPOD_QLEVER_FULL_ENGINE_JOBS || '2';
const dryRun = hasFlag('--dry-run');
const json = hasFlag('--json');
const skipUpstreamConfigure = hasFlag('--skip-upstream-configure');
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
];

const xpodIncludeFlags = [
  '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
  `-I${path.join(repoRoot, 'native/postgres/qlever_adapter/src')}`,
  `-I${path.join(repoRoot, 'native/postgres/qlever_adapter/include')}`,
  `-I${path.join(repoRoot, 'native/postgres/rdf_protocol/include')}`,
].join(' ');

const upstreamConfigureArgs = [
  '-S', qleverSource,
  '-B', qleverBuildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  '-DCHEAPER_COMPILATION=ON',
  '-DUSE_PRECOMPILED_HEADERS=OFF',
  '-DUSE_IO_URING=OFF',
  `-DCMAKE_CXX_FLAGS=${xpodIncludeFlags}`,
];
maybeAdd(upstreamConfigureArgs, 'DCMAKE_C_COMPILER', defaultCompiler('C'));
maybeAdd(upstreamConfigureArgs, 'DCMAKE_CXX_COMPILER', defaultCompiler('CXX'));
maybeAdd(upstreamConfigureArgs, 'DCMAKE_PREFIX_PATH', defaultHomebrewPrefixPath());
maybeAdd(upstreamConfigureArgs, 'DCMAKE_EXE_LINKER_FLAGS', defaultExecutableLinkerFlags(jemalloc));
maybeAdd(upstreamConfigureArgs, 'DICU_ROOT', defaultIcuRoot());
maybeAdd(upstreamConfigureArgs, 'DBoost_DIR', process.env.XPOD_QLEVER_BOOST_DIR);

function adapterConfigureArgs() {
  const dependencyIncludeDirs = dependencyIncludeDirsFromCompileCommands(compileCommandsPath);
  const args = [
    '-S', adapterRoot,
    '-B', adapterBuildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
    `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
  ];
  if (dependencyIncludeDirs.length > 0) {
    args.push(`-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=${dependencyIncludeDirs.join(';')}`);
  }
  maybeAdd(args, 'DCMAKE_CXX_COMPILER', defaultCompiler('CXX'));
  return { args, dependencyIncludeDirs };
}

const initialAdapter = adapterConfigureArgs();
const adapterBuildArgs = [
  '--build',
  adapterBuildDir,
  '--target',
  'xpod_qlever_adapter',
  `-j${jobs}`,
];

if (dryRun) {
  const payload = {
    patchCheckArgs: patchCheckArgs.slice(1),
    upstreamConfigureArgs,
    adapterConfigureArgs: initialAdapter.args,
    adapterBuildArgs,
    compileCommandsPath,
    dependencyIncludeDirs: initialAdapter.dependencyIncludeDirs,
    configureEnv: pkgConfigLibdir ? { PKG_CONFIG_LIBDIR: pkgConfigLibdir } : {},
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log('[qlever-real-adapter] patch:', patchCheckArgs.join(' '));
    if (!skipUpstreamConfigure) {
      console.log('[qlever-real-adapter] upstream configure:', ['cmake', ...upstreamConfigureArgs].join(' '));
    }
    console.log('[qlever-real-adapter] adapter configure:', ['cmake', ...initialAdapter.args].join(' '));
    console.log('[qlever-real-adapter] adapter build:', ['cmake', ...adapterBuildArgs].join(' '));
  }
  process.exit(0);
}

if (!fileExists(qleverSource)) {
  fail(`QLever source tree does not exist: ${qleverSource}`);
}

try {
  execFileSync(patchCheckArgs[0], patchCheckArgs.slice(1), { cwd: repoRoot, stdio: 'inherit' });
  if (!skipUpstreamConfigure && !buildOnly) {
    execFileSync('cmake', upstreamConfigureArgs, { cwd: repoRoot, stdio: 'inherit', env: cmakeEnv });
  }
  const adapter = adapterConfigureArgs();
  if (!buildOnly) {
    execFileSync('cmake', adapter.args, { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!configureOnly) {
    execFileSync('cmake', adapterBuildArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
} catch (error) {
  fail('real upstream QLever adapter build failed', error);
}

console.log(`[qlever-real-adapter] OK: built xpod_qlever_adapter in ${adapterBuildDir}`);
