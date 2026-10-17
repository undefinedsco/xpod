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

function createRegistry(artifact, publishToken, upstreamRegistry, supply = {}) {
  const artifacts = supply.artifacts ?? [];
  if (!Array.isArray(artifacts) || Object.keys(supply).some(key => !['artifacts', 'required'].includes(key))) throw new Error('Invalid exact artifact supply');
  if (artifact.manifest?.name !== '@undefineds.co/xpod') throw new Error('Expected root Xpod artifact');
  return createArtifactRegistry([artifact, ...artifacts], publishToken, upstreamRegistry, supply.required ?? [], artifact);
}

// Transport only: callers must verify normal producer originals before supply.
// A module fixture does not need a synthetic root package or gain admission.
function createExactArtifactRegistry(artifacts, publishToken, upstreamRegistry, required = []) {
  return createArtifactRegistry(artifacts, publishToken, upstreamRegistry, required);
}

// Both public entry points use this single HTTP state and publication path.
function createArtifactRegistry(artifacts, publishToken, upstreamRegistry, required, legacyRootArtifact = null) {
  // Public program dependencies leave the fixture through the caller's upstream
  // (a configured mirror), defaulting to npmjs so existing callers do not drift.
  const upstream = typeof upstreamRegistry === 'string' && upstreamRegistry.trim()
    ? upstreamRegistry.trim().replace(/\/+$/, '')
    : 'https://registry.npmjs.org';
  // Transport facts only. The CLI may pass supply only after its normal producer
  // receipt reader has verified original files; this is not source admission.
  const packages = new Map();
  if (!Array.isArray(artifacts) || artifacts.length === 0 || !Array.isArray(required)
    || artifacts.length > (legacyRootArtifact ? 1001 : 1000) || required.length > 1000) throw new Error('Invalid exact artifact supply');
  for (const row of artifacts) {
    const manifest = JSON.parse(JSON.stringify(row.manifest));
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest?.name)
      || typeof manifest.version !== 'string' || require('semver').valid(manifest.version) !== manifest.version
      || !Buffer.isBuffer(row.bytes) || !row.bytes.length
      || row.integrity !== `sha512-${crypto.createHash('sha512').update(row.bytes).digest('base64')}`) throw new Error('Exact artifact identity/integrity mismatch');
    // Preserve the original root fixture construction path. Its publisher still
    // checks this policy before writing configuration or spawning npm.
    if (row !== legacyRootArtifact) assertSafeFixturePublishConfig(manifest);
    let state = packages.get(manifest.name);
    if (!state) { state = { versions: new Map(), metadata: undefined, publishing: false }; packages.set(manifest.name, state); }
    if (state.versions.has(manifest.version)) throw new Error('Duplicate exact artifact identity');
    state.versions.set(manifest.version, { manifest, bytes: row === legacyRootArtifact ? row.bytes : Buffer.from(row.bytes), integrity: row.integrity, published: false });
  }
  const requiredSeen = new Set();
  for (const row of required) {
    const key = `${row?.name}@${row?.version}`;
    if (requiredSeen.has(key) || !packages.get(row?.name)?.versions.has(row?.version)) throw new Error('Missing or duplicate required local artifact');
    requiredSeen.add(key);
  }
  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method === 'PUT') {
      const state = packages.get(pathname.slice(1));
      if (!state || !publishToken || req.headers.authorization !== `Bearer ${publishToken}`) {
        res.writeHead(403); res.end(); return;
      }
      if (state.publishing || [...state.versions.values()].every(row => row.published)) { res.writeHead(409); res.end(); return; }
      state.publishing = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          const largest = Math.max(...[...state.versions.values()].map(row => row.bytes.length));
          if (size > largest * 2 + 1024 * 1024) throw new Error('Publication too large');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload.versions || typeof payload.versions !== 'object' || Array.isArray(payload.versions)) throw new Error('Unexpected publication');
        const newVersions = Object.keys(payload.versions).filter(version => !state.versions.get(version)?.published);
        if (newVersions.length === 0) { res.writeHead(409); res.end(); return; }
        if (newVersions.length !== 1) throw new Error('Unexpected publication versions');
        const selected = state.versions.get(newVersions[0]);
        if (!selected) throw new Error('Undeclared publication version');
        const version = payload.versions[selected.manifest.version];
        const attachments = Object.values(payload._attachments || {});
        const previous = Object.keys(state.metadata?.versions ?? {});
        if (payload.name !== selected.manifest.name || Object.keys(payload.versions).length !== previous.length + 1
          || previous.some(key => JSON.stringify(payload.versions[key]) !== JSON.stringify(state.metadata.versions[key]))
          || version?.name !== selected.manifest.name || version.version !== selected.manifest.version || attachments.length !== 1) throw new Error('Unexpected publication');
        const bytes = Buffer.from(attachments[0].data, 'base64');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const target = new URL(version.dist.tarball);
        if (target.origin !== origin || target.username || target.password || target.search || target.hash
          || !decodeURIComponent(target.pathname).startsWith(`/${selected.manifest.name}/-/`) || attachments[0].length !== selected.bytes.length
          || !bytes.equals(selected.bytes) || version.dist.integrity !== selected.integrity
          || [...state.versions.values()].some(row => row.published && row.tarballPath === decodeURIComponent(target.pathname))
          || version.dist.shasum !== crypto.createHash('sha1').update(bytes).digest('hex')) throw new Error('Publication artifact mismatch');
        // Keep exactly npm's publication metadata, including its dependency
        // normalization. Never rebuild a packument from the tar manifest.
        const { _attachments, ...metadata } = payload;
        state.metadata = metadata;
        selected.published = true;
        selected.tarballPath = decodeURIComponent(target.pathname);
        res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
      finally { state.publishing = false; }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    for (const [name, state] of packages) {
      if (pathname !== `/${name}` && !pathname.startsWith(`/${name}/`)) continue;
      for (const selected of state.versions.values()) {
        if (selected.published && pathname === selected.tarballPath) {
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-length', selected.bytes.length);
          res.end(req.method === 'HEAD' ? undefined : selected.bytes); return;
        }
      }
      const version = pathname.slice(name.length + 2);
      const declared = state.versions.get(version);
      const metadata = pathname === `/${name}` ? state.metadata
        : declared?.published && Object.prototype.hasOwnProperty.call(state.metadata?.versions ?? {}, version)
          ? state.metadata.versions[version] : undefined;
      if (!metadata) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(metadata)); return;
    }
    // Only GET/HEAD for public program dependencies may leave the fixture.
    // Redirect to the caller's upstream using the path only: no publisher
    // headers, token, query string, hash or credentials are forwarded.
    res.writeHead(302, { location: `${upstream}${new URL(req.url, 'http://localhost').pathname}` });
    res.end();
  });
  const primaryName = artifacts[0].manifest.name;
  server.publishedMetadata = (name = primaryName) => packages.get(name)?.metadata;
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

function assertSafeFixturePublishConfig(manifest) {
  const config = manifest.publishConfig;
  // Keep original metadata. Only public access agrees with the fixed publisher
  // command; registry/tag/auth and every other override remain forbidden.
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.entries(config).some(([key, value]) => key !== 'access' || value !== 'public'))) {
    throw new Error('Registry fixture refuses publishConfig overrides');
  }
}

async function publishArtifact(artifact, registry, token, evidenceRoot) {
  const targetRegistry = new URL(registry);
  if (targetRegistry.protocol !== 'http:' || targetRegistry.hostname !== '127.0.0.1' || !targetRegistry.port
    || targetRegistry.username || targetRegistry.password || targetRegistry.pathname !== '/' || targetRegistry.search || targetRegistry.hash) throw new Error('Publisher requires an explicit loopback registry');
  assertSafeFixturePublishConfig(artifact.manifest);
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
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(interrupted || `Registry consumer child failed (${signal || code})`));
    });
  });
}

// Shared by the existing root CLI checker and the real legacy Bun install seam.
async function publishRootSupply({ artifact, supply, server, registry, token, evidenceRoot, retainedDirectory }) {
  const helper = require('./lib/root-registry-supply.cjs');
  helper.verifyPublicationMetadata(artifact, server.publishedMetadata());
  const publications = [];
  for (const [index, value] of supply.artifacts.entries()) {
    const directory = path.join(evidenceRoot, 'private-' + index); fs.mkdirSync(directory, { mode: 0o700 });
    await publishArtifact(value, registry, token, directory);
    const metadata = server.publishedMetadata(value.manifest.name);
    helper.verifyPublicationMetadata(value, metadata);
    const file = 'publication-' + index + '.original.json';
    fs.writeFileSync(path.join(retainedDirectory, file), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    publications.push({ name: value.manifest.name, version: value.manifest.version, file, ...helper.reference(path.join(retainedDirectory, file)) });
  }
  fs.writeFileSync(path.join(retainedDirectory, 'publication.original.json'), JSON.stringify({ source: supply.receipt, required: supply.required,
    root: server.publishedMetadata(), publications, publicDependencies: 'original-online-upstream', releaseQualified: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

async function verifyRootRegistryInstallation(artifact, consumer, evidenceRoot, env) {
  const installedRoot = path.join(consumer, 'node_modules', '@undefineds.co', 'xpod');
  const bundles = verifyInstalledBundles(artifact.tarball, installedRoot, evidenceRoot);
  fs.writeFileSync(path.join(evidenceRoot, 'bundle-proof.json'), `${JSON.stringify(bundles, null, 2)}\n`, { mode: 0o600 });
  const exportsProbe = path.join(installedRoot, '.xpod-registry-exports-probe.mjs');
  fs.writeFileSync(exportsProbe, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
// The package is bundled under the installed Xpod, so every probe has to
// resolve inside that scope instead of a hoisted registry copy.
const installedScope = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '@undefineds.co') + path.sep;
const insideBundle = (file) => {
assert(file.startsWith(installedScope), 'Resolved outside the installed bundle: ' + file);
};
// The interoperability contract inside the package owns the dual CommonJS/ESM
// builds, and it is free of React, so it can be imported here.
for (const subpath of ['provider-catalog', 'client-config']) {
const specifier = '@undefineds.co/ai-connections/' + subpath;
const cjsPath = require.resolve(specifier);
const esmUrl = import.meta.resolve(specifier);
insideBundle(cjsPath);
insideBundle(fileURLToPath(esmUrl));
const cjs = require(specifier);
const esm = await import(specifier);
assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort(), 'ESM/CommonJS export mismatch for ' + subpath);
console.log('[registry-exports] ' + specifier + ' CJS and ESM resolve inside the installed bundle');
}
for (const specifier of ['@undefineds.co/ai-connections/client', '@undefineds.co/ai-connections/endpoint-urls']) {
const esmUrl = import.meta.resolve(specifier);
insideBundle(fileURLToPath(esmUrl));
await import(specifier);
console.log('[registry-exports] ' + specifier + ' resolves inside the installed bundle');
}
// The applet entries pull in React components, so the probe only proves that
// they still resolve inside the installed bundle.
for (const specifier of ['@undefineds.co/ai-connections', '@undefineds.co/ai-connections/manifest']) {
const esmUrl = import.meta.resolve(specifier);
insideBundle(fileURLToPath(esmUrl));
console.log('[registry-exports] ' + specifier + ' resolves inside the installed bundle');
}
`, { flag: 'wx', mode: 0o600 });
  try { await run([exportsProbe], env); }
  finally { fs.rmSync(exportsProbe, { force: true }); }
  return bundles;
}

async function main(input, output, cache, packageManager = 'npm', supplyRequest) {
  if (!input || !output || !cache) throw new Error('Usage: node scripts/check-package-registry-consumer.cjs <pack-json|tgz> <new-evidence-dir> <package-cache> [npm|bun] [normal-supply-request]');
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
  const supply = supplyRequest ? require('./lib/root-registry-supply.cjs').readRootSupply(supplyRequest, process.cwd(), artifact) : { artifacts: [], required: [] };
  const server = createRegistry(artifact, publishToken, undefined, { artifacts: supply.artifacts, required: supply.required });
  const result = { name: artifact.manifest.name, version: artifact.manifest.version, integrity: artifact.integrity, node: process.version, packageManager, passed: false };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const registry = `http://127.0.0.1:${server.address().port}`;
    await publishArtifact(artifact, registry, publishToken, evidenceRoot);
    if (supplyRequest) await publishRootSupply({ artifact, supply, server, registry, token: publishToken, evidenceRoot, retainedDirectory: evidenceRoot });
    const metadata = server.publishedMetadata();
    if (!metadata) throw new Error('npm did not publish fixture metadata');
    fs.writeFileSync(path.join(evidenceRoot, 'published-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    const env = { ...isolatedEnvironment(userConfig, globalConfig),
      XPOD_INSTALL_REGISTRY: registry, XPOD_SMOKE_NODE: packageManager === 'bun' ? 'bun' : process.execPath,
      XPOD_PACKAGE_SMOKE_INCLUDE_OPTIONAL: 'true' };
    await run([path.join(__dirname, 'package-smoke-install.cjs'), `${artifact.manifest.name}@${artifact.manifest.version}`, consumer, path.resolve(cache), packageManager], env);
    result.bundles = await verifyRootRegistryInstallation(artifact, consumer, evidenceRoot, env);
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
module.exports = { publishRootSupply, verifyRootRegistryInstallation, readArtifact, createRegistry, createExactArtifactRegistry, publishArtifact, isolatedEnvironment, run, assertSafeFixturePublishConfig };
