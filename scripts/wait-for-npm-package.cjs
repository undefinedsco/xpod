#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function getNpmInvocation(args) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMetadata(packageSpec, timeoutMs) {
  const invocation = getNpmInvocation([ 'view', packageSpec, '--json', '--prefer-online' ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ], timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) throw new Error('npm metadata unavailable or timed out');
  return JSON.parse(result.stdout);
}

async function verifyTarball(metadata, timeoutMs) {
  const { tarball, integrity } = metadata?.dist ?? {};
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) throw new Error('Missing or invalid dist.tarball');
  // Use the strongest supported SRI algorithm; never accept a weaker digest
  // when metadata also supplies a stronger one.
  const tokens = typeof integrity === 'string' ? integrity.trim().split(/\s+/) : [];
  const algorithms = [ 'sha512', 'sha384', 'sha256', 'sha1' ];
  const algorithm = algorithms.find((name) => tokens.some((token) => token.startsWith(`${name}-`)));
  if (!algorithm) throw new Error('Missing or unsupported dist.integrity');
  const expected = tokens.filter((token) => token.startsWith(`${algorithm}-`)).map((token) => token.slice(algorithm.length + 1));
  const response = await fetch(tarball, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Tarball HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Empty tarball response');
  const hash = createHash(algorithm);
  for await (const chunk of response.body) hash.update(chunk);
  if (!expected.includes(hash.digest('base64'))) throw new Error('Tarball integrity mismatch');
}

async function waitForPackage(rawSpec, options = {}) {
  const { attempts = 30, intervalMs = 10000, timeoutMs = 30000,
    readMetadata: metadataReader = readMetadata, log = console.log } = options;
  if (!rawSpec || !Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(intervalMs) || intervalMs < 0
    || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid package spec or wait limits');
  const packageSpec = normalizeInstallSpec(rawSpec);
  let lastError;
  for (let index = 1; index <= attempts; index += 1) {
    try {
      const metadata = await metadataReader(packageSpec, timeoutMs);
      await verifyTarball(metadata, timeoutMs);
      log(`[npm-wait] installable with verified tarball: ${packageSpec}`);
      return;
    } catch (error) {
      lastError = error.message;
    }
    if (index < attempts) {
      log(`[npm-wait] waiting for ${packageSpec} (${index}/${attempts}): ${lastError}`);
      await sleep(intervalMs);
    }
  }
  throw new Error(`package not installable on npm in time: ${packageSpec}: ${lastError}`);
}

if (require.main === module) {
  waitForPackage(process.argv[2], {
    attempts: Number(process.argv[3] || '30'), intervalMs: Number(process.argv[4] || '10000'),
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { waitForPackage, verifyTarball, normalizeInstallSpec };
