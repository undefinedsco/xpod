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

function isCurrentRuntimeBun() {
  return typeof globalThis.Bun !== 'undefined';
}

function findBunExecutable() {
  return new Promise((resolve) => {
    let settled = false;
    const probe = spawn('bun', ['--no-env-file', '-e', 'process.stdout.write(process.execPath)'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      probe.kill('SIGTERM');
      finish(undefined);
    }, 5_000);
    let stdout = '';
    probe.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    probe.once('error', () => finish(undefined));
    probe.once('exit', (code) => {
      finish(code === 0 ? stdout.trim() || undefined : undefined);
    });
  });
}

async function resolveJsCliLaunch(options = {}) {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
  const execPath = options.execPath || process.execPath;
  const currentRuntimeIsBun = options.isBun ?? isCurrentRuntimeBun();
  if (currentRuntimeIsBun) {
    return { command: execPath, args: [cliPath], isBun: true };
  }
  const bun = await (options.findBunExecutable || findBunExecutable)();
  return bun
    ? { command: bun, args: [cliPath], isBun: true }
    : { command: execPath, args: [cliPath], isBun: false };
}

async function runJsCli() {
  const launch = await resolveJsCliLaunch();
  return runChild(launch.command, launch.args.concat(process.argv.slice(2)));
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  if (process.env.XPOD_PREFER_JS_CLI === 'true') {
    process.exit(await runJsCli());
    return;
  }

  const binaryPath = resolveBinary();
  if (!binaryPath) {
    process.exit(await runJsCli());
    return;
  }

  try {
    process.exit(await runChild(binaryPath, process.argv.slice(2)));
  } catch {
    process.exit(await runJsCli());
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  detectLinuxLibc,
  findBunExecutable,
  getBinaryPackageCandidates,
  resolveBinary,
  resolveJsCliLaunch,
};
