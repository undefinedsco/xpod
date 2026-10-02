#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PACKAGES, consume } = require('./workspace-package-consumer.cjs');
const { packWorkspacePackages } = require('./workspace-package-pack.cjs');
const root = path.resolve(__dirname, '..');
const registry = 'https://registry.npmjs.org';
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
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
async function metadata(name, version) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}${version ? `/${version}` : ''}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry verification failed: HTTP ${response.status}`);
  return response.json();
}
async function publish() {
  const sha = process.env.XPOD_ACCEPTED_SHA;
  assertSource(sha, run('git', ['rev-parse', 'HEAD']));
  const manifests = PACKAGES.map((name) => ({ directory: path.join(root, 'packages', name), ...JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')) }));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-shared-release-'));
  try {
    const tarballs = packWorkspacePackages(root, PACKAGES, temp, sha);
    // Prove these exact tarballs are consumable before occupying npm versions.
    consume(root, { tarballs });
    for (const original of manifests) {
      compareStable(original.version, original.version);
      const tarball = tarballs[original.name];
      const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64');
      const existing = await metadata(original.name, original.version);
      if (existing && existing.dist?.integrity !== integrity) throw new Error(`Published bytes differ: ${original.name}@${original.version}`);
      if (!existing) run('npm', ['publish', tarball, '--access', 'public', '--tag', 'stable-staging', '--registry', registry]);
      run('node', ['scripts/wait-for-npm-package.cjs', `${original.name}@${original.version}`, '180', '1000']);
      const published = await metadata(original.name, original.version);
      if (published?.dist?.integrity !== integrity) throw new Error(`Published integrity mismatch: ${original.name}`);
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
module.exports = { assertSource, compareStable };
if (require.main === module) publish().catch((error) => { console.error(error.message); process.exitCode = 1; });
