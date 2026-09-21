#!/usr/bin/env node
// Exercise registry-spec installation semantics before publishing. A file
// tarball install does not reify undeclared bundles the same way as a registry.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { verifyInstalledBundles } = require('./verify-installed-bundles.cjs');
const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');
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
  if (getPlatformDependencyMismatches(manifest, manifest.version).length) {
    throw new Error('Release artifact platform optional dependencies must match its exact version');
  }
  return { tarball, bytes, manifest, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

function createRegistry(artifact, publishToken) {
  let published;
  let tarballPath;
  let publishing = false;
  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method === 'PUT') {
      if (pathname !== '/@undefineds.co/xpod' || !publishToken || req.headers.authorization !== `Bearer ${publishToken}`) {
        res.writeHead(403); res.end(); return;
      }
      if (published || publishing) { res.writeHead(409); res.end(); return; }
      publishing = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > artifact.bytes.length * 2 + 1024 * 1024) throw new Error('Publication too large');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const version = payload.versions?.[artifact.manifest.version];
        const attachments = Object.values(payload._attachments || {});
        if (payload.name !== artifact.manifest.name || Object.keys(payload.versions || {}).length !== 1
          || version?.name !== artifact.manifest.name || version.version !== artifact.manifest.version || attachments.length !== 1) throw new Error('Unexpected publication');
        const bytes = Buffer.from(attachments[0].data, 'base64');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const target = new URL(version.dist.tarball);
        if (target.origin !== origin || target.username || target.password || target.search || target.hash
          || !target.pathname.startsWith('/@undefineds.co/xpod/-/') || attachments[0].length !== artifact.bytes.length
          || !bytes.equals(artifact.bytes) || version.dist.integrity !== artifact.integrity
          || version.dist.shasum !== crypto.createHash('sha1').update(bytes).digest('hex')) throw new Error('Publication artifact mismatch');
        // Keep exactly npm's publication metadata, including its dependency
        // normalization. Never rebuild a packument from the tar manifest.
        const { _attachments, ...metadata } = payload;
        published = metadata;
        tarballPath = decodeURIComponent(target.pathname);
        res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
      finally { publishing = false; }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (published && pathname === tarballPath) {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', artifact.bytes.length);
      res.end(req.method === 'HEAD' ? undefined : artifact.bytes); return;
    }
    if (pathname === '/@undefineds.co/xpod') {
      if (!published) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(published)); return;
    }
    // Only GET/HEAD for public program dependencies may leave the fixture.
    // No publisher headers or query string are forwarded.
    res.writeHead(302, { location: `https://registry.npmjs.org${new URL(req.url, 'http://localhost').pathname}` });
    res.end();
  });
  server.publishedMetadata = () => published;
  return server;
}

function isolatedEnvironment(userConfig, globalConfig, publication = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key) || /^(?:NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)$/i.test(key)) delete env[key];
  }
  if (publication) {
    for (const key of Object.keys(env)) if (/^(?:(?:https?|all)_)?proxy$/i.test(key)) delete env[key];
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  }
  return { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    NPM_CONFIG_USERCONFIG: userConfig, npm_config_userconfig: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_globalconfig: globalConfig };
}

async function publishArtifact(artifact, registry, token, evidenceRoot) {
  // npm publishConfig may override command-line registry settings. Refuse it
  // before invoking npm, rather than risk an unintended external publication.
  const targetRegistry = new URL(registry);
  if (targetRegistry.protocol !== 'http:' || targetRegistry.hostname !== '127.0.0.1' || !targetRegistry.port
    || targetRegistry.username || targetRegistry.password || targetRegistry.pathname !== '/' || targetRegistry.search || targetRegistry.hash) throw new Error('Publisher requires an explicit loopback registry');
  if (artifact.manifest.publishConfig && Object.keys(artifact.manifest.publishConfig).length) throw new Error('Registry fixture refuses publishConfig overrides');
  const projectManifest = path.join(evidenceRoot, 'package.json');
  const userConfig = path.join(evidenceRoot, 'publish.npmrc');
  const globalConfig = path.join(evidenceRoot, 'publish-global.npmrc');
  const created = [];
  const createPrivateFile = (file, contents) => {
    fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
    created.push(file);
  };
  createPrivateFile(userConfig, `//${new URL(registry).host}/:_authToken=${token}\n`);
  try {
    createPrivateFile(globalConfig, '');
    // Anchor npm project discovery here so an ancestor .npmrc is never loaded.
    createPrivateFile(projectManifest, JSON.stringify({ name: 'xpod-loopback-registry-fixture', private: true }));
    const env = isolatedEnvironment(userConfig, globalConfig, true);
    const args = ['publish', artifact.tarball, '--registry', registry, '--userconfig', userConfig,
      '--globalconfig', globalConfig, '--ignore-scripts', '--provenance=false', '--access=public', '--tag=fixture',
      '--fetch-retries=0', '--cache', path.join(evidenceRoot, 'publish-cache'), '--loglevel=error'];
    if (process.platform === 'win32') {
      await run(['/d', '/s', '/c', 'npm.cmd', ...args], env, process.env.ComSpec || 'cmd.exe', evidenceRoot);
    } else {
      await run(args, env, 'npm', evidenceRoot);
    }
  } finally {
    for (const file of created) fs.rmSync(file, { force: true });
  }
}

function run(args, env, executable = process.execPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, stdio: 'inherit', detached: process.platform !== 'win32' });
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
  const globalConfig = path.join(evidenceRoot, 'empty-global.npmrc');
  fs.writeFileSync(globalConfig, '', { flag: 'wx', mode: 0o600 });
  const publishToken = crypto.randomBytes(24).toString('hex');
  const server = createRegistry(artifact, publishToken);
  const result = { name: artifact.manifest.name, version: artifact.manifest.version, integrity: artifact.integrity, node: process.version, packageManager, passed: false };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const registry = `http://127.0.0.1:${server.address().port}`;
    await publishArtifact(artifact, registry, publishToken, evidenceRoot);
    const metadata = server.publishedMetadata();
    if (!metadata) throw new Error('npm did not publish fixture metadata');
    fs.writeFileSync(path.join(evidenceRoot, 'published-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    const env = { ...isolatedEnvironment(userConfig, globalConfig),
      XPOD_INSTALL_REGISTRY: registry, XPOD_SMOKE_NODE: packageManager === 'bun' ? 'bun' : process.execPath,
      XPOD_PACKAGE_SMOKE_INCLUDE_OPTIONAL: 'true' };
    await run([path.join(__dirname, 'package-smoke-install.cjs'), `${artifact.manifest.name}@${artifact.manifest.version}`, consumer, path.resolve(cache), packageManager], env);
    const installedRoot = path.join(consumer, 'node_modules', '@undefineds.co', 'xpod');
    result.bundles = verifyInstalledBundles(artifact.tarball, installedRoot, evidenceRoot);
    fs.writeFileSync(path.join(evidenceRoot, 'bundle-proof.json'), `${JSON.stringify(result.bundles, null, 2)}\n`, { mode: 0o600 });
    const exportsProbe = path.join(installedRoot, '.xpod-registry-exports-probe.mjs');
    fs.writeFileSync(exportsProbe, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
// Both packages are bundled under the installed Xpod, so every probe has to
// resolve inside that scope instead of a hoisted registry copy.
const installedScope = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '@undefineds.co') + path.sep;
const insideBundle = (file) => {
  assert(file.startsWith(installedScope), 'Resolved outside the installed bundle: ' + file);
};
// The shared core owns the dual CommonJS/ESM builds after the product/applet
// split; the product package keeps only its own ESM entry points.
for (const subpath of ['provider-catalog', 'client-config']) {
  const specifier = '@undefineds.co/ai-connections-core/' + subpath;
  const cjsPath = require.resolve(specifier);
  const esmUrl = import.meta.resolve(specifier);
  insideBundle(cjsPath);
  insideBundle(fileURLToPath(esmUrl));
  const cjs = require(specifier);
  const esm = await import(specifier);
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort(), 'ESM/CommonJS export mismatch for ' + subpath);
  console.log('[registry-exports] ' + specifier + ' CJS and ESM resolve inside the installed bundle');
}
// The core is deliberately free of React, so its ESM entry points can be
// imported here; the product entries pull in applet components, so the probe
// only proves that they still resolve inside the installed bundle.
for (const specifier of ['@undefineds.co/ai-connections-core', '@undefineds.co/ai-connections-core/client', '@undefineds.co/ai-connections-core/endpoint-urls']) {
  const esmUrl = import.meta.resolve(specifier);
  insideBundle(fileURLToPath(esmUrl));
  await import(specifier);
  console.log('[registry-exports] ' + specifier + ' resolves inside the installed bundle');
}
for (const specifier of ['@undefineds.co/ai-connections', '@undefineds.co/ai-connections/manifest']) {
  const esmUrl = import.meta.resolve(specifier);
  insideBundle(fileURLToPath(esmUrl));
  console.log('[registry-exports] ' + specifier + ' resolves inside the installed bundle');
}
`, { flag: 'wx', mode: 0o600 });
    try { await run([exportsProbe], env); }
    finally { fs.rmSync(exportsProbe, { force: true }); }
    await run([path.join(__dirname, 'package-consumer-smoke.cjs'), consumer, '--package-only'], env);
    result.passed = true;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userConfig, { force: true });
    fs.rmSync(globalConfig, { force: true });
    fs.writeFileSync(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
}
if (require.main === module) main(...process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { readArtifact, createRegistry, publishArtifact, isolatedEnvironment };
