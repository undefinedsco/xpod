#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createRegistry, publishArtifact, run } = require('./check-package-registry-consumer.cjs');

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

// Async so a same-process loopback registry can answer requests while the
// installer runs; the shared bounded `run` owns the 10-minute deadline and the
// detached process-group SIGTERM/SIGKILL cleanup.
async function runCommand(packageManager, args, cwd, cacheDir, baseEnv) {
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
    env.npm_config_maxsockets = env.npm_config_maxsockets || '8';
    env.npm_config_fetch_retries = env.npm_config_fetch_retries || '2';
    env.npm_config_fetch_timeout = env.npm_config_fetch_timeout || '15000';
    env.npm_config_fetch_retry_maxtimeout = env.npm_config_fetch_retry_maxtimeout || '30000';
    if (installRegistry) {
      env.npm_config_registry = installRegistry;
    }
  }
  const invocation = getCommandInvocation(packageManager, args);
  await run(invocation.args, env, invocation.command, cwd);
}

// Bun 1.4.2 cannot resolve a package-local `file:` edge for a bundled dependency
// when a tarball is installed by path (`bun add file://…`): it resolves the edge
// against its extraction cache and reports the bundled package.json missing even
// though it is present (oven-sh/bun#27418 / #43125). The registry-spec install
// materialises the package first, so the same untouched tarball resolves its
// bundled `file:` edges. Uses npm's real publication capture (no hand-written
// packument) and pins the loopback registry so an inherited override cannot
// redirect the install elsewhere.
async function installLocalTarballViaRegistry(tarballPath, targetDir, cacheDir, baseEnv) {
  // Fail closed rather than let the installer walk up to an ancestor project and
  // write outside the target (a consumer manifest must exist in the target).
  if (!fs.existsSync(path.join(targetDir, 'package.json'))) {
    throw new Error(`Refusing to install without a consumer manifest at ${targetDir}`);
  }
  const bytes = fs.readFileSync(tarballPath);
  const manifest = JSON.parse(execFileSync('tar', [ 'xOf', tarballPath, 'package/package.json' ], { encoding: 'utf8' }));
  const artifact = {
    tarball: tarballPath,
    bytes,
    manifest,
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
  };
  const token = crypto.randomBytes(24).toString('hex');
  // Transitive public deps must still resolve through the configured mirror
  // (docs/RELEASE.md XPOD_INSTALL_REGISTRY); only the Xpod metadata is pinned
  // to the loopback. Capture the upstream before overriding the install env.
  const upstreamRegistry = resolveInstallRegistry(baseEnv);
  const server = createRegistry(artifact, token, upstreamRegistry);
  // Acquire the evidence root before listening so a failure here cannot leave an
  // open server behind; the finally closes only a listening server and always
  // removes the evidence, even if close reports an error.
  const evidenceRoot = fs.mkdtempSync(path.join(cacheDir, 'registry-publish-'));
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { listening = true; resolve(); });
    });
    const registry = `http://127.0.0.1:${server.address().port}`;
    await publishArtifact(artifact, registry, token, evidenceRoot);
    // The shared resolver reads XPOD_INSTALL_REGISTRY; pinning it is the single
    // source of truth and prevents an inherited override redirecting the install.
    await runCommand('bun', [ 'add', `${manifest.name}@${manifest.version}` ], targetDir, cacheDir, {
      ...baseEnv,
      XPOD_INSTALL_REGISTRY: registry,
    });
    return registry;
  } finally {
    if (listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
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
  // The npm local smoke strips optionalDependencies; the Bun registry route must
  // consume the untouched original artifact bytes with all metadata retained.
  const installSpec = packageManager === 'npm' ? createSmokeTarball(resolvedInstallSpec) : resolvedInstallSpec;
  const installerSpec = toInstallerSpec(installSpec, packageManager);
  const installEnv = await sanitizeProxyEnv(process.env);
  const installRegistry = resolveInstallRegistry(installEnv);
  let usedRegistry = installRegistry;
  let installedLabel = installerSpec;

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (packageManager === 'bun') {
    await runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir, installEnv);
    if (fs.existsSync(resolvedInstallSpec) && resolvedInstallSpec.endsWith('.tgz')) {
      usedRegistry = await installLocalTarballViaRegistry(resolvedInstallSpec, targetDir, cacheDir, installEnv);
      installedLabel = resolvedInstallSpec;
    } else {
      await runCommand(packageManager, [ 'add', installerSpec ], targetDir, cacheDir, installEnv);
    }
  } else {
    await runCommand(packageManager, [ 'init', '-y' ], targetDir, cacheDir, installEnv);
    const optionalArgs = installEnv.XPOD_PACKAGE_SMOKE_INCLUDE_OPTIONAL === 'true'
      ? []
      : [ '--omit=optional' ];
    await runCommand(packageManager, [ 'install', ...optionalArgs, '--prefer-offline', '--no-audit', '--no-fund', installerSpec ], targetDir, cacheDir, installEnv);
  }

  const probe = path.join(__dirname, '..', 'tests', 'scripts', 'packaged-auth-probe.cjs');
  const runtime = packageManager === 'bun' ? (process.platform === 'win32' ? 'bun.exe' : 'bun') : (process.platform === 'win32' ? 'node.exe' : 'node');
  const probeArgs = [probe, path.join(targetDir, 'node_modules', '@undefineds.co', 'xpod')];
  if (packageManager === 'bun') probeArgs.unshift('--no-install');
  execFileSync(runtime, probeArgs, {
    cwd: targetDir, stdio: 'inherit', env: { ...installEnv, NODE_PATH: '' },
  });

  console.log(`[package-install] manager=${packageManager}`);
  console.log(`[package-install] installed ${installedLabel}`);
  console.log(`[package-install] registry=${usedRegistry ?? 'package-manager-default'}`);
  if (packageManager === 'npm' && resolvedInstallSpec !== installSpec) {
    console.log(`[package-install] sanitized optionalDependencies for local tarball smoke`);
  }
  console.log(`[package-install] target ${targetDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { installLocalTarballViaRegistry, createSmokeTarball, resolveInstallSpec };
