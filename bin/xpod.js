#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');

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

function resolveBinary() {
  for (const packageName of getBinaryPackageCandidates()) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`);
      const packageRoot = path.dirname(packageJsonPath);
      const packageJson = require(packageJsonPath);
      const binaryRelativePath = packageJson.xpodBinary || './xpod';
      return path.join(packageRoot, binaryRelativePath);
    } catch {
      // Try next candidate.
    }
  }

  return undefined;
}

function runJsCli() {
  require('../dist/cli/index.js');
}

function main() {
  if (process.env.XPOD_PREFER_JS_CLI === 'true') {
    runJsCli();
    return;
  }

  const binaryPath = resolveBinary();
  if (!binaryPath) {
    runJsCli();
    return;
  }

  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
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
  getBinaryPackageCandidates,
  resolveBinary,
};
