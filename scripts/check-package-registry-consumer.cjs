#!/usr/bin/env node
// Exercise registry-spec installation semantics before publishing. A file
// tarball install does not reify undeclared bundles the same way as a registry.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

function readArtifact(input) {
  const absolute = path.resolve(input);
  const tarball = absolute.endsWith('.json')
    ? path.join(path.dirname(absolute), JSON.parse(fs.readFileSync(absolute, 'utf8'))[0].filename)
    : absolute;
  const bytes = fs.readFileSync(tarball);
  const manifest = JSON.parse(execFileSync('tar', ['xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  if (manifest.name !== '@undefineds.co/xpod' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) {
    throw new Error('Expected a versioned Xpod artifact');
  }
  return { bytes, manifest, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

function createRegistry(artifact) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === '/xpod.tgz') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', artifact.bytes.length);
      res.end(req.method === 'HEAD' ? undefined : artifact.bytes); return;
    }
    if (pathname === '/@undefineds.co/xpod') {
      const version = { ...artifact.manifest, dist: {
        tarball: `http://127.0.0.1:${server.address().port}/xpod.tgz`, integrity: artifact.integrity,
      } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: version.name, 'dist-tags': { latest: version.version }, versions: { [version.version]: version } }));
      return;
    }
    // Only public program dependencies are resolved here; no user registry or
    // credentials are needed. Preserve the path, never forward request headers.
    res.writeHead(302, { location: `https://registry.npmjs.org${new URL(req.url, 'http://localhost').pathname}` });
    res.end();
  });
  return server;
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit', detached: process.platform !== 'win32' });
    let interrupted;
    let killTimer;
    const kill = (signal) => {
      if (!child.pid) return;
      if (process.platform === 'win32') child.kill(signal);
      else { try { process.kill(-child.pid, signal); } catch {} }
    };
    const stop = (reason) => {
      interrupted ??= reason;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 5_000);
    };
    const onInterrupt = () => stop('Registry consumer interrupted');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    const timer = setTimeout(() => stop('Registry consumer exceeded its 10 minute deadline'), 600_000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(interrupted || `Registry consumer child failed (${signal || code})`));
    });
  });
}

async function main(input, output, cache, packageManager = 'npm') {
  if (!input || !output || !cache) throw new Error('Usage: node scripts/check-package-registry-consumer.cjs <pack-json|tgz> <new-evidence-dir> <package-cache> [npm|bun]');
  if (!['npm', 'bun'].includes(packageManager)) throw new Error('Expected npm or bun consumer');
  const artifact = readArtifact(input);
  const evidenceRoot = path.resolve(output);
  // Never allow the install helper's recursive cleanup to touch existing data.
  fs.mkdirSync(evidenceRoot, { recursive: false, mode: 0o700 });
  const consumer = path.join(evidenceRoot, 'consumer');
  const userConfig = path.join(evidenceRoot, 'empty.npmrc');
  fs.writeFileSync(userConfig, '', { mode: 0o600 });
  const server = createRegistry(artifact);
  const result = { name: artifact.manifest.name, version: artifact.manifest.version, integrity: artifact.integrity, node: process.version, packageManager, passed: false };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const registry = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      NPM_CONFIG_USERCONFIG: userConfig, npm_config_userconfig: userConfig,
      XPOD_INSTALL_REGISTRY: registry, XPOD_SMOKE_NODE: packageManager === 'bun' ? 'bun' : process.execPath,
      XPOD_PACKAGE_SMOKE_INCLUDE_OPTIONAL: 'true' };
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    await run([path.join(__dirname, 'package-smoke-install.cjs'), `${artifact.manifest.name}@${artifact.manifest.version}`, consumer, path.resolve(cache), packageManager], env);
    const installedRoot = path.join(consumer, 'node_modules', '@undefineds.co', 'xpod');
    const exportsProbe = path.join(installedRoot, '.xpod-registry-exports-probe.mjs');
    fs.writeFileSync(exportsProbe, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const expectedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '@undefineds.co', 'ai-connections') + path.sep;
for (const subpath of ['provider-catalog', 'client-config']) {
  const specifier = '@undefineds.co/ai-connections/' + subpath;
  const cjsPath = require.resolve(specifier);
  const esmUrl = import.meta.resolve(specifier);
  assert(cjsPath.startsWith(expectedRoot), 'CommonJS escaped the installed bundle: ' + cjsPath);
  assert(fileURLToPath(esmUrl).startsWith(expectedRoot), 'ESM escaped the installed bundle: ' + esmUrl);
  const cjs = require(specifier);
  const esm = await import(specifier);
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort(), 'ESM/CommonJS export mismatch for ' + subpath);
  console.log('[registry-exports] ' + subpath + ' CJS and ESM resolve inside the installed bundle');
}
`, { flag: 'wx', mode: 0o600 });
    try { await run([exportsProbe], env); }
    finally { fs.rmSync(exportsProbe, { force: true }); }
    await run([path.join(__dirname, 'package-consumer-smoke.cjs'), consumer, '--package-only'], env);
    result.passed = true;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userConfig, { force: true });
    fs.writeFileSync(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
}
if (require.main === module) main(...process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { readArtifact, createRegistry };
