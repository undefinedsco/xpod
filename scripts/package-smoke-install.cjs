#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

function getCommandInvocation(packageManager, args) {
  if (packageManager === 'bun') {
    return {
      command: process.platform === 'win32' ? 'bun.exe' : 'bun',
      args,
    };
  }

  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: [ '/d', '/s', '/c', 'npm.cmd', ...args ],
    };
  }

  return {
    command: 'npm',
    args,
  };
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
    if (process.platform === 'win32') {
      return installSpec;
    }
    return pathToFileURL(installSpec).href;
  }
  return installSpec;
}

function readNonEmptyEnv(baseEnv, key) {
  const value = baseEnv[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveInstallRegistry(baseEnv) {
  return readNonEmptyEnv(baseEnv, 'XPOD_INSTALL_REGISTRY')
    ?? readNonEmptyEnv(baseEnv, 'XPOD_NPM_REGISTRY');
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

async function canConnect(hostname, port, timeoutMs = 500) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function sanitizeProxyEnv(baseEnv) {
  const env = { ...baseEnv };
  const proxyKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
  ];

  const unreachableLoopbackOrigins = new Set();

  for (const key of proxyKeys) {
    const raw = env[key];
    if (!raw) {
      continue;
    }

    let proxyUrl;
    try {
      proxyUrl = new URL(raw);
    } catch {
      continue;
    }

    if (!isLoopbackHost(proxyUrl.hostname)) {
      continue;
    }

    const port = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
    if (await canConnect(proxyUrl.hostname, port)) {
      continue;
    }

    unreachableLoopbackOrigins.add(proxyUrl.origin);
  }

  if (unreachableLoopbackOrigins.size === 0) {
    return env;
  }

  for (const key of proxyKeys) {
    const raw = env[key];
    if (!raw) {
      continue;
    }

    try {
      const proxyUrl = new URL(raw);
      if (unreachableLoopbackOrigins.has(proxyUrl.origin)) {
        delete env[key];
      }
    } catch {
    }
  }

  console.warn(`[package-install] disabled unreachable local proxy: ${Array.from(unreachableLoopbackOrigins).join(', ')}`);
  return env;
}

function runCommand(packageManager, args, cwd, cacheDir, baseEnv) {
  const env = {
    ...baseEnv,
  };
  const installRegistry = resolveInstallRegistry(baseEnv);
  if (packageManager === 'bun') {
    env.BUN_INSTALL_CACHE_DIR = cacheDir;
    if (installRegistry) {
      env.npm_config_registry = installRegistry;
    }
  } else {
    env.npm_config_cache = cacheDir;
    env.npm_config_prefer_offline = env.npm_config_prefer_offline || 'true';
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_maxsockets = env.npm_config_maxsockets || '1';
    env.npm_config_fetch_retries = env.npm_config_fetch_retries || '1';
    env.npm_config_fetch_timeout = env.npm_config_fetch_timeout || '15000';
    env.npm_config_fetch_retry_maxtimeout = env.npm_config_fetch_retry_maxtimeout || '15000';
    if (installRegistry) {
      env.npm_config_registry = installRegistry;
    }
  }
  const invocation = getCommandInvocation(packageManager, args);
  execFileSync(invocation.command, invocation.args, {
    cwd,
    stdio: 'inherit',
    env,
  });
}

async function main() {
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
  const installEnv = await sanitizeProxyEnv(process.env);
  const installRegistry = resolveInstallRegistry(installEnv);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (packageManager === 'bun') {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir, installEnv);
    runCommand(packageManager, [ 'add', installerSpec ], targetDir, cacheDir, installEnv);
  } else {
    runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir, installEnv);
    runCommand(packageManager, [ 'install', '--omit=optional', '--prefer-offline', '--no-audit', '--no-fund', installerSpec ], targetDir, cacheDir, installEnv);
  }

  console.log(`[package-install] manager=${packageManager}`);
  console.log(`[package-install] installed ${installerSpec}`);
  console.log(`[package-install] registry=${installRegistry ?? 'package-manager-default'}`);
  if (resolvedInstallSpec !== installSpec) {
    console.log(`[package-install] sanitized optionalDependencies for local tarball smoke`);
  }
  console.log(`[package-install] target ${targetDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
