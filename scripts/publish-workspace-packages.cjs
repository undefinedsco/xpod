#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { PACKAGES, consume } = require('./workspace-package-consumer.cjs');
const { packWorkspacePackages } = require('./workspace-package-pack.cjs');
const { sha512Integrity, assertIntegrity, comparePackagePayloads } = require('./workspace-package-payload.cjs');
const root = path.resolve(__dirname, '..');
const registry = 'https://registry.npmjs.org';
// Provenance only: `npm pack` injects the accepted SHA as `gitHead`, so a re-run under a
// new accepted SHA can never reproduce byte-identical tarballs for a content-identical,
// already published version. Everything else must still match exactly (enforced in
// workspace-package-payload.cjs, which has no override surface).
// Bounded registry access so a stalled or oversized response cannot hang CI.
const LIMITS = {
  metadataTimeoutMs: 30_000,
  metadataBytes: 32 * 1024 * 1024,
  tarballTimeoutMs: 120_000,
  tarballBytes: 64 * 1024 * 1024,
};
function run(command, args, cwd = root, options = {}) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
}
function assertSource(sha, actual) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || sha !== actual) throw new Error('Shared packages require the exact accepted release SHA');
}
function compareStable(left, right) {
  const parse = (value) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid stable version ${value}`);
    return value.split('.').map(Number);
  };
  const a = parse(left); const b = parse(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
// Reads at most `maxBytes` from a fetch body and aborts as soon as the cap is exceeded.
async function readBoundedBody(response, maxBytes, label) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`${label} failed: missing body stream`);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeded the ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
// fetch does not honor proxy environment variables on every Node version, so registry
// reads fall back to the npm CLI, which does. Either transport is bounded and the raw
// integrity of any downloaded tarball is verified by the caller.
function npmView(spec) {
  try {
    return run('npm', ['view', spec, '--json', '--registry', registry], root, { stdio: ['ignore', 'pipe', 'pipe'], timeout: LIMITS.metadataTimeoutMs });
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? '';
    if (/\bE404\b|\bETARGET\b|404 Not Found|No match found|is not in this registry/u.test(stderr)) return null;
    throw new Error(`Registry verification failed: ${stderr.trim() || error.message}`);
  }
}
async function metadata(name, version) {
  const spec = version ? `${name}@${version}` : name;
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}${version ? `/${version}` : ''}`, { signal: AbortSignal.timeout(LIMITS.metadataTimeoutMs) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await readBoundedBody(response, LIMITS.metadataBytes, `${spec} metadata`));
  } catch (error) {
    if (error instanceof Error && /^Registry verification failed/u.test(error.message)) throw error;
    const output = npmView(spec);
    if (output === null) return null;
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`Registry verification failed for ${spec}: invalid JSON`);
    }
  }
}
function tarballIntegrity(file) {
  return sha512Integrity(fs.readFileSync(file));
}
function readManifests() {
  return PACKAGES.map((name) => ({
    directory: path.join(root, 'packages', name),
    ...JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')),
  }));
}
async function downloadPublishedTarball(published, destination) {
  const label = `${published.name}@${published.version}`;
  const target = path.join(destination, `${published.name.replace(/[^a-z0-9.]+/giu, '-')}-${published.version}.tgz`);
  try {
    const response = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(LIMITS.tarballTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fs.writeFileSync(target, await readBoundedBody(response, LIMITS.tarballBytes, `${label} tarball`));
  } catch {
    const packed = JSON.parse(run('npm', ['pack', label, '--ignore-scripts', '--json', '--registry', registry, '--pack-destination', destination], root, { timeout: LIMITS.tarballTimeoutMs }));
    fs.copyFileSync(path.join(destination, packed[0].filename), target);
  }
  return target;
}
function assertSelectedIntegrity(published, tarballPath, label) {
  const expected = tarballIntegrity(tarballPath);
  if (published?.dist?.integrity !== expected) throw new Error(`Registry integrity mismatch for ${label}`);
  return expected;
}
// Pure decision function. It verifies immutable existing versions and selects the exact
// consumer tarballs, but never publishes or mutates a dist-tag; callers own registry
// mutation. Injected lookup/materialize keep it unit-testable without network access.
async function planSharedPublication({ manifests, packed, lookup, materialize }) {
  const mixed = {};
  const reuse = [];
  const publish = [];
  for (const manifest of manifests) {
    compareStable(manifest.version, manifest.version);
    const packedTarball = packed[manifest.name];
    if (!packedTarball) throw new Error(`Missing packed tarball: ${manifest.name}`);
    const existing = await lookup(manifest.name, manifest.version);
    if (!existing) {
      mixed[manifest.name] = packedTarball;
      publish.push({ manifest, tarball: packedTarball });
      continue;
    }
    const publishedTarball = await materialize(existing);
    const publishedBytes = fs.readFileSync(publishedTarball);
    assertIntegrity(publishedBytes, existing.dist?.integrity, `Published ${manifest.name}@${manifest.version}`);
    const comparison = comparePackagePayloads(publishedBytes, fs.readFileSync(packedTarball));
    if (!comparison.ok) {
      throw new Error(`Existing shared version ${manifest.name}@${manifest.version} is immutable and diverges from the packed payload (${comparison.reasons.join('; ')}); bump the shared package version instead of overwriting it`);
    }
    mixed[manifest.name] = publishedTarball;
    reuse.push(manifest.name);
  }
  return { mixed, reuse, publish };
}
async function prepareSharedPackages() {
  const sha = process.env.XPOD_ACCEPTED_SHA;
  assertSource(sha, run('git', ['rev-parse', 'HEAD']));
  const manifests = readManifests();
  // Reject prerelease/malformed versions before packing or any registry access.
  for (const manifest of manifests) compareStable(manifest.version, manifest.version);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-shared-release-'));
  try {
    const tarballs = packWorkspacePackages(root, PACKAGES, temp, sha);
    const plan = await planSharedPublication({
      manifests,
      packed: tarballs,
      lookup: (name, version) => metadata(name, version),
      materialize: (existing) => downloadPublishedTarball(existing, temp),
    });
    return { manifests, tarballs, plan, temp };
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
// Read-only preflight: verifies reuse/integrity/payload and runs the exact mixed-tarball
// consumer checks, but never publishes and never mutates a dist-tag.
async function verifyOnly() {
  const { manifests, plan, temp } = await prepareSharedPackages();
  try {
    consume(root, { tarballs: plan.mixed });
    console.log(`Verified ${manifests.length} shared packages in reuse preflight (reused ${plan.reuse.length}, new ${plan.publish.length}); no publication performed`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
async function publish() {
  const { manifests, plan, temp } = await prepareSharedPackages();
  try {
    // Prove these exact tarballs (published bytes for reused versions, packed bytes for
    // new versions) are consumable before occupying any npm version.
    consume(root, { tarballs: plan.mixed });
    for (const { manifest, tarball } of plan.publish) {
      run('npm', ['publish', tarball, '--access', 'public', '--tag', 'stable-staging', '--registry', registry]);
      run('node', ['scripts/wait-for-npm-package.cjs', `${manifest.name}@${manifest.version}`, '180', '1000']);
    }
    // After staging, re-fetch metadata and bind the registry's full raw integrity to the
    // selected mixed tarball for EVERY package (reused and freshly published) before the
    // registry consumer or any latest mutation.
    for (const manifest of manifests) {
      const selected = plan.mixed[manifest.name];
      const remote = await metadata(manifest.name, manifest.version);
      if (!remote) throw new Error(`Staged package missing from registry: ${manifest.name}@${manifest.version}`);
      assertSelectedIntegrity(remote, selected, `${manifest.name}@${manifest.version}`);
    }
    // No latest mutation is allowed until every package imports and typechecks.
    consume(root);
    for (const manifest of manifests) {
      const latest = (await metadata(manifest.name))?.['dist-tags']?.latest;
      if (latest && !latest.includes('-') && compareStable(latest, manifest.version) > 0) throw new Error(`Refusing latest downgrade: ${manifest.name}`);
    }
    for (const manifest of manifests) run('npm', ['dist-tag', 'add', `${manifest.name}@${manifest.version}`, 'latest', '--registry', registry]);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const versions = await Promise.all(manifests.map(async (manifest) => (await metadata(manifest.name))?.['dist-tags']?.latest));
      if (versions.every((version, index) => version === manifests[index].version)) return;
      if (attempt === 29) throw new Error('Shared package latest propagation timed out');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function selectMode(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return 'publish';
  if (args.length === 1 && args[0] === '--verify-only') return 'verify';
  throw new Error('Only --verify-only is supported');
}
module.exports = { assertSource, compareStable, tarballIntegrity, readBoundedBody, planSharedPublication, assertSelectedIntegrity, selectMode };
if (require.main === module) {
  const mode = selectMode(process.argv);
  (mode === 'verify' ? verifyOnly() : publish()).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
