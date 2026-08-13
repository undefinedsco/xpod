#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');

const QLEVER_LOCAL_RUNTIME_ENV = 'XPOD_QLEVER_LOCAL_RUNTIME_COMMAND';

function detectLinuxLibc() {
  if (process.platform !== 'linux') {
    return undefined;
  }

  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return 'glibc';
  }

  return 'musl';
}

function getBinaryPackageCandidates() {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64' || process.arch === 'x64') {
      return [ `@undefineds.co/xpod-darwin-${process.arch}` ];
    }
    return [];
  }

  if (process.platform === 'linux') {
    const libc = detectLinuxLibc() === 'musl' ? 'musl' : 'gnu';
    if (process.arch === 'arm64' || process.arch === 'x64') {
      return [ `@undefineds.co/xpod-linux-${process.arch}-${libc}` ];
    }
  }

  return [];
}

function resolvePlatformPackage() {
  for (const packageName of getBinaryPackageCandidates()) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`);
      const packageRoot = path.dirname(packageJsonPath);
      const packageJson = require(packageJsonPath);
      const binaryRelativePath = packageJson.xpodBinary || './xpod';
      const runtimeRelativePath = packageJson.xpodQleverLocalRuntime;
      return {
        binaryPath: path.join(packageRoot, binaryRelativePath),
        qleverLocalRuntimePath: typeof runtimeRelativePath === 'string'
          ? path.join(packageRoot, runtimeRelativePath)
          : undefined,
      };
    } catch {
      // Try next candidate.
    }
  }

  return undefined;
}

function resolveBinary() {
  return resolvePlatformPackage()?.binaryPath;
}

function createPlatformEnvForPackage(platformPackage, baseEnv = process.env) {
  if (!platformPackage?.qleverLocalRuntimePath || baseEnv[QLEVER_LOCAL_RUNTIME_ENV]) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    [QLEVER_LOCAL_RUNTIME_ENV]: platformPackage.qleverLocalRuntimePath,
  };
}

function createPlatformEnv(baseEnv = process.env) {
  return createPlatformEnvForPackage(resolvePlatformPackage(), baseEnv);
}

function runJsCli() {
  const env = createPlatformEnv();
  if (env !== process.env) {
    process.env[QLEVER_LOCAL_RUNTIME_ENV] = env[QLEVER_LOCAL_RUNTIME_ENV];
  }
  require('../dist/cli/index.js');
}

function main() {
  if (process.env.XPOD_PREFER_JS_CLI === 'true') {
    runJsCli();
    return;
  }

  const platformPackage = resolvePlatformPackage();
  if (!platformPackage?.binaryPath) {
    runJsCli();
    return;
  }

  const child = spawn(platformPackage.binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: createPlatformEnv(),
  });

  child.once('error', () => runJsCli());
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  detectLinuxLibc,
  createPlatformEnv,
  createPlatformEnvForPackage,
  getBinaryPackageCandidates,
  resolveBinary,
  resolvePlatformPackage,
};
