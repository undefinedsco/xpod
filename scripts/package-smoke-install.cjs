#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
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

function createSmokeTarball(installSpec) {
  if (!fs.existsSync(installSpec) || !installSpec.endsWith('.tgz')) {
    return installSpec;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-package-smoke-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const smokeTarballPath = path.join(tempRoot, `${path.basename(installSpec, '.tgz')}.smoke.tgz`);

  fs.mkdirSync(unpackDir, { recursive: true });
  execFileSync('tar', [ '-xzf', installSpec, '-C', unpackDir ]);

  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    delete packageJson.optionalDependencies;
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  execFileSync('tar', [ '-czf', smokeTarballPath, '-C', unpackDir, 'package' ]);
  return smokeTarballPath;
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
    env.npm_config_prefer_offline = env.npm_config_prefer_offline || 'true';
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_maxsockets = env.npm_config_maxsockets || '1';
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
  const resolvedInstallSpec = resolveInstallSpec(rawInstallSpec);
  const installSpec = createSmokeTarball(resolvedInstallSpec);
  const installerSpec = toInstallerSpec(installSpec, packageManager);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (packageManager === 'bun') {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir);
    runCommand(packageManager, [ 'add', installerSpec ], targetDir, cacheDir);
  } else {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir);
    runCommand(packageManager, [ 'install', '--omit=optional', '--prefer-offline', '--no-audit', '--no-fund', installerSpec ], targetDir, cacheDir);
  }

  console.log(`[package-install] manager=${packageManager}`);
  console.log(`[package-install] installed ${installerSpec}`);
  if (resolvedInstallSpec !== installSpec) {
    console.log(`[package-install] sanitized optionalDependencies for local tarball smoke`);
  }
  console.log(`[package-install] target ${targetDir}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
