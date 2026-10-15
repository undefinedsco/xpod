'use strict';
// Diagnostic projections from actual archive bytes, never installation authority.
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { parseTar } = require('../workspace-package-payload.cjs');
const MANIFEST_LIMIT = 128 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function name(value) {
  if (typeof value !== 'string' || !packageName.test(value) || value.length > 214) throw Error('Invalid package identity');
  return value;
}
function spec(value) {
  // Do not retain credentials, arbitrary URLs or unrecognized manifest contents.
  if (typeof value !== 'string' || value.length > 1024) throw Error('Invalid dependency specifier');
  if (/^[0-9a-z.*+~^<>=| -]+$/i.test(value) || /^(?:workspace:|npm:)[@a-z0-9/._*+~^<>=| -]+$/i.test(value)
    || /^github:[a-z0-9_.-]+\/[a-z0-9_.-]+#[a-f0-9]{40}$/i.test(value)) return value;
  return { redacted: true, bytes: Buffer.byteLength(value), sha256: sha256(Buffer.from(value)) };
}
function projection(manifest) {
  const result = { name: name(manifest.name), version: spec(manifest.version) };
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] === undefined) continue;
    if (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field])) throw Error('Invalid dependency map');
    result[field] = Object.fromEntries(Object.entries(manifest[field]).map(([key, value]) => [name(key), spec(value)]));
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (manifest[field] === undefined) continue;
    if (typeof manifest[field] === 'boolean') result[field] = manifest[field];
    else if (Array.isArray(manifest[field])) result[field] = manifest[field].map(name);
    else throw Error('Invalid bundle declaration');
  }
  if (manifest.peerDependenciesMeta !== undefined) {
    result.peerDependenciesMeta = Object.fromEntries(Object.entries(manifest.peerDependenciesMeta).map(([key, value]) =>
      [name(key), { optional: value?.optional === true }]));
  }
  return result;
}
function archiveManifests(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('Archive evidence bound');
  const bytes = fs.readFileSync(file);
  const entries = parseTar(zlib.gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }));
  let total = 0;
  const read = member => {
    const entry = entries.find(row => row.path === member);
    if (!entry) return { path: member, status: 'missing' };
    if (entry.type !== 'file' || entry.content.length > MANIFEST_LIMIT) throw Error('Manifest evidence bound');
    total += entry.content.length;
    if (total > TOTAL_LIMIT) throw Error('Manifest total bound');
    return { path: member, status: 'present', bytes: entry.content.length, sha256: sha256(entry.content),
      manifest: projection(JSON.parse(entry.content.toString('utf8'))) };
  };
  const root = read('package/package.json');
  if (root.status !== 'present') throw Error('Root manifest missing');
  // The actual root declaration is the sole bundle registry. No nine-package copy.
  const bundled = new Set();
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    const value = root.manifest[field];
    for (const item of value === true ? Object.keys(root.manifest.dependencies ?? {}) : Array.isArray(value) ? value : []) bundled.add(item);
  }
  const manifests = [root, ...[...bundled].sort().map(item => read('package/node_modules/' + name(item) + '/package.json'))];
  return { archive: { bytes: bytes.length, sha256: sha256(bytes) }, manifestBytes: total, manifests };
}
function captureManifestEvidence(output, original, actual = original, runtime = null) {
  // Diagnostic failure must never replace the original build/install outcome.
  let result;
  try {
    const source = archiveManifests(original);
    const consumed = actual === original ? source : archiveManifests(actual);
    if (source.manifestBytes + (actual === original ? 0 : consumed.manifestBytes) > TOTAL_LIMIT) throw Error('Manifest total bound');
    result = { schemaVersion: 1, kind: 'legacy-package-manifest-evidence', status: 'captured', runtime,
      transformation: actual === original ? 'none' : 'existing-npm-optional-dependency-smoke', original: source, selectedInput: consumed,
      installationOutcome: 'not-attested',
      sourceQualified: false, releaseQualified: false };
    if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n') > TOTAL_LIMIT) throw Error('Evidence output bound');
  } catch {
    result = { schemaVersion: 1, kind: 'legacy-package-manifest-evidence', status: 'unavailable',
      reason: 'archive-manifest-evidence-unavailable', sourceQualified: false, releaseQualified: false };
  }
  try {
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
    return { status: result.status, bytes: bytes.length, sha256: sha256(bytes) };
  } catch { return { status: 'unavailable' }; }
}
module.exports = { archiveManifests, captureManifestEvidence };
