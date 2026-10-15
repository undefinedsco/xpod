'use strict';
// Diagnostic projections from actual archive bytes, never installation authority.
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const MANIFEST_LIMIT = 128 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
function fail(reason) { const error = new Error(reason); error.evidenceReason = reason; throw error; }
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
function archiveManifests(file, limits = {}) {
  const compressedLimit = limits.compressed ?? 64 * 1024 * 1024;
  const expandedLimit = limits.expanded ?? 128 * 1024 * 1024;
  const manifestLimit = limits.manifests ?? TOTAL_LIMIT;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('archive-not-regular');
  if (stat.size > compressedLimit) fail('archive-compressed-bound');
  // Read a bounded owned byte snapshot once. Tar never reopens this path.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const chunks = []; let length = 0;
  try {
    const started = fs.fstatSync(fd, { bigint: true });
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('archive-identity-changed');
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, compressedLimit - length + 1));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count;
      if (length > compressedLimit) fail('archive-compressed-bound');
      chunks.push(buffer.subarray(0, count));
    }
    const ended = fs.fstatSync(fd, { bigint: true });
    if (ended.size !== started.size || ended.mtimeNs !== started.mtimeNs || ended.ctimeNs !== started.ctimeNs) fail('archive-changed-during-read');
  } finally { fs.closeSync(fd); }
  const bytes = Buffer.concat(chunks, length);
  let expandedBytes;
  try {
    if (expandedLimit <= 0) fail('archive-expanded-bound');
    expandedBytes = zlib.gunzipSync(bytes, { maxOutputLength: expandedLimit }).length;
  } catch (error) {
    fail(error.evidenceReason ?? (error.code === 'ERR_BUFFER_TOO_LARGE' ? 'archive-expanded-bound' : 'archive-gzip-invalid'));
  }
  // Compat archives are repacked by platform tar (including long-name/PAX
  // metadata). Reuse that reader, without weakening the module tar parser.
  const deadline = Date.now() + 30_000;
  const tar = (flags, member) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('tar-read-deadline');
    try {
      return execFileSync('tar', [flags, '-', member], { input: bytes, maxBuffer: MANIFEST_LIMIT + 1,
        timeout: Math.min(10_000, remaining), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      if (error.code === 'ENOBUFS') fail(flags === '-xzOf' ? 'manifest-size-bound' : 'member-output-bound');
      if (error.signal) fail('tar-read-deadline');
      throw error;
    }
  };
  let total = 0;
  const read = member => {
    let listing;
    try { listing = tar('-tvzf', member).toString('utf8').trim().split('\n'); }
    catch (error) {
      if (error.evidenceReason) throw error;
      if (error.code === 'ENOBUFS') fail('member-output-bound');
      if (error.signal) fail('tar-read-deadline');
      if (Number.isInteger(error.status) && error.status !== 0) return { path: member, status: 'unresolved', reason: 'member-unresolved' };
      fail('archive-tar-read-failed');
    }
    if (listing.length !== 1 || !listing[0].startsWith('-') || !listing[0].endsWith(' ' + member)) fail('member-not-unique-regular');
    const content = tar('-xzOf', member);
    if (content.length > MANIFEST_LIMIT) fail('manifest-size-bound');
    total += content.length;
    if (total > manifestLimit) fail('manifest-total-bound');
    let manifest;
    try { manifest = JSON.parse(content.toString('utf8')); } catch { fail('manifest-json-invalid'); }
    try { manifest = projection(manifest); } catch { fail('manifest-projection-invalid'); }
    return { path: member, status: 'present', bytes: content.length, sha256: sha256(content), manifest };
  };
  const root = read('package/package.json');
  if (root.status !== 'present') fail('root-manifest-unresolved');
  // The actual root declaration is the sole bundle registry. No nine-package copy.
  const bundled = new Set();
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    const value = root.manifest[field];
    for (const item of value === true ? Object.keys(root.manifest.dependencies ?? {}) : Array.isArray(value) ? value : []) bundled.add(item);
  }
  const manifests = [root, ...[...bundled].sort().map(item => read('package/node_modules/' + name(item) + '/package.json'))];
  return { archive: { bytes: bytes.length, sha256: sha256(bytes) }, expandedBytes, manifestBytes: total, manifests };
}
function captureManifestEvidence(output, original, actual = original, runtime = null) {
  // Diagnostic failure must never replace the original build/install outcome.
  let result;
  try {
    const source = archiveManifests(original);
    const consumed = actual === original ? source : archiveManifests(actual, {
      compressed: 64 * 1024 * 1024 - source.archive.bytes,
      expanded: 128 * 1024 * 1024 - source.expandedBytes, manifests: TOTAL_LIMIT - source.manifestBytes });
    if (source.manifestBytes + (actual === original ? 0 : consumed.manifestBytes) > TOTAL_LIMIT) fail('manifest-total-bound');
    result = { schemaVersion: 1, kind: 'legacy-package-manifest-evidence', status: 'captured', runtime,
      transformation: actual === original ? 'none' : 'existing-npm-optional-dependency-smoke', original: source, selectedInput: consumed,
      installationOutcome: 'not-attested',
      sourceQualified: false, releaseQualified: false };
    if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n') > TOTAL_LIMIT) fail('evidence-output-bound');
  } catch (error) {
    result = { schemaVersion: 1, kind: 'legacy-package-manifest-evidence', status: 'unavailable',
      reason: error.evidenceReason ?? 'archive-read-failed', sourceQualified: false, releaseQualified: false };
  }
  try {
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
    return { status: result.status, bytes: bytes.length, sha256: sha256(bytes) };
  } catch { return { status: 'unavailable', reason: 'evidence-write-failed' }; }
}
module.exports = { archiveManifests, captureManifestEvidence };
