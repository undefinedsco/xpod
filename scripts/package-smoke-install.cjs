#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

function getCommand(packageManager) {
  if (packageManager === 'bun') {
    return process.platform === 'win32' ? 'bun.exe' : 'bun';
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizeInstallSpec(rawSpec) {
  return rawSpec.replace(/@v(\d+\.\d+\.\d+(?:[-+][^@/]+)?)$/, '@$1');
}

function resolveInstallSpec(input) {
  const absoluteInput = path.resolve(input);
  if (fs.existsSync(absoluteInput) && absoluteInput.endsWith('.json')) {
    const pack = JSON.parse(fs.readFileSync(absoluteInput, 'utf8'))[0];
    if (!pack?.filename) {
      throw new Error(`Invalid pack metadata: ${absoluteInput}`);
    }
    return path.join(path.dirname(absoluteInput), pack.filename);
  }
  if (fs.existsSync(absoluteInput)) {
    return absoluteInput;
  }
  return normalizeInstallSpec(input);
}

function toInstallerSpec(installSpec, packageManager) {
  if (packageManager === 'bun' && fs.existsSync(installSpec)) {
    return pathToFileURL(installSpec).href;
  }
  return installSpec;
}

function runCommand(packageManager, args, cwd, cacheDir) {
  const env = {
    ...process.env,
  };
  if (packageManager === 'bun') {
    env.BUN_INSTALL_CACHE_DIR = cacheDir;
  } else {
    env.npm_config_cache = cacheDir;
  }
  execFileSync(getCommand(packageManager), args, {
    cwd,
    stdio: 'inherit',
    env,
  });
}

function main() {
  const rawInstallSpec = process.argv[2];
  const targetDirArg = process.argv[3];
  const cacheDirArg = process.argv[4] || '.test-data/npm-cache';
  const packageManager = (process.argv[5] || 'npm').toLowerCase();

  if (!rawInstallSpec || !targetDirArg) {
    throw new Error('Usage: node scripts/package-smoke-install.cjs <pack-json|tarball|package-spec> <target-dir> [cache-dir] [npm|bun]');
  }
  if (packageManager !== 'npm' && packageManager !== 'bun') {
    throw new Error(`Unsupported package manager: ${packageManager}`);
  }

  const repoRoot = process.cwd();
  const targetDir = path.resolve(repoRoot, targetDirArg);
  const cacheDir = path.resolve(repoRoot, cacheDirArg);
  const installSpec = resolveInstallSpec(rawInstallSpec);
  const installerSpec = toInstallerSpec(installSpec, packageManager);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (packageManager === 'bun') {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir);
    runCommand(packageManager, [ 'add', installerSpec ], targetDir, cacheDir);
  } else {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir);
    runCommand(packageManager, [ 'install', installerSpec ], targetDir, cacheDir);
  }

  console.log(`[package-install] manager=${packageManager}`);
  console.log(`[package-install] installed ${installerSpec}`);
  console.log(`[package-install] target ${targetDir}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
