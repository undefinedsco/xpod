#!/usr/bin/env node
'use strict';
// Smallest safe helper for comparing a freshly packed workspace tarball against the
// immutable registry tarball of an already published version. It deliberately supports
// only the entry types and layouts `npm pack` produces, and fails closed on anything
// else instead of guessing. It is not a general tar framework.
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MANIFEST_PATH = 'package/package.json';
const BLOCK = 512;
const MANIFEST_MAX_BYTES = 16 * 1024 ** 2;
// Fixed invariant: the only manifest field npm rewrites between accepted SHAs is the
// provenance commit. There is deliberately no caller-supplied override surface; any
// other field difference is real content and must fail closed.
const PROVENANCE_FIELDS = Object.freeze(['gitHead']);
// The deployment-owned material collector embeds the accepted commit into its own
// provenance, so a re-pack under a NEW accepted SHA changes exactly one field in
// these files while the package source, snapshot and runtime bytes are identical.
// They are content files, not manifest fields, so they need their own narrow rule.
const MATERIAL_MANIFEST = 'package/dist/materials/build-provenance.json';
const MATERIAL_INDEX = 'package/dist/materials/index.json';
const MATERIAL_INVENTORY = 'package/dist/materials/source-inventory.json';
const MATERIAL_MEMBERS = Object.freeze([MATERIAL_MANIFEST, MATERIAL_INDEX, MATERIAL_INVENTORY]);
const MATERIAL_SCHEMA_VERSION = 1;
// The only field that may differ across accepted commits, plus the two index child
// digests whose value is a pure function of it.
const MATERIAL_COMMIT_FIELD = 'sourceCommit';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha512Integrity(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function assertIntegrity(buffer, expected, label) {
  if (typeof expected !== 'string' || !expected.startsWith('sha512-')) {
    throw new Error(`${label} is missing sha512 integrity`);
  }
  const actual = sha512Integrity(buffer);
  if (actual !== expected) throw new Error(`${label} integrity mismatch: expected ${expected} got ${actual}`);
  return actual;
}

function decodeName(field) {
  const value = field.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(field)) throw new Error('Invalid UTF-8 tar name or prefix');
  return value;
}

function readString(block, offset, length, trimSpaces = true) {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  const field = block.subarray(offset, end), value = trimSpaces ? field.toString('utf8') : decodeName(field);
  return trimSpaces ? value.replace(/ +$/u, '') : value;
}

// Strict octal: the whole field (NUL/space trimmed) must be octal digits. parseInt alone
// would silently accept a valid prefix followed by invalid suffix.
function readOctal(block, offset, length) {
  const raw = readString(block, offset, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new Error('Corrupted tar header: invalid numeric field');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Corrupted tar header: invalid numeric field');
  return value;
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function assertSafePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Unsafe tar path: ${JSON.stringify(name)}`);
  }
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!trimmed) throw new Error(`Unsafe tar path: ${JSON.stringify(name)}`);
  for (const segment of trimmed.split('/')) {
    if (segment === '..') throw new Error(`Unsafe tar path traversal: ${JSON.stringify(name)}`);
    if (segment === '' || segment === '.') throw new Error(`Unsafe tar path: ${JSON.stringify(name)}`);
  }
}

function validateHeader(block, seen, { gnuLongNames = false, longName, gitArchiveCommit } = {}) {
  const storedChecksum = readOctal(block, 148, 8);
  const checksumBlock = Buffer.from(block);
  checksumBlock.fill(0x20, 148, 156);
  let computed = 0;
  for (const byte of checksumBlock) computed += byte;
  if (computed !== storedChecksum) throw new Error('Corrupted tar header checksum');
  const name = readString(block, 0, 100, false);
  const prefix = readString(block, 345, 155, false);
  const fullName = prefix ? `${prefix}/${name}` : name;
  const typeflag = String.fromCharCode(block[156]);
  const mode = readOctal(block, 100, 8) & 0o7777;
  const size = readOctal(block, 124, 12);
  if (gitArchiveCommit !== undefined && typeflag === 'g') {
    if (prefix || fullName !== 'pax_global_header' || size !== 52 || longName !== undefined) throw new Error('Invalid Git global PAX metadata');
    return { path: fullName, type: 'git-global', mode, size };
  }
  if (gnuLongNames && typeflag === 'L') {
    if (longName !== undefined) throw new Error('Repeated GNU long name metadata');
    if (prefix || fullName !== '././@LongLink' || size < 2 || size > 4096) throw new Error('Invalid GNU long name metadata');
    return { path: fullName, type: 'long-name', mode, size };
  }
  assertSafePath(fullName);
  if (longName !== undefined && /[\u0000-\u001f\u007f]/u.test(fullName)) throw new Error('Unsafe GNU short header name');
  const effectiveName = longName ?? fullName;
  assertSafePath(effectiveName);
  let type;
  if (typeflag === '0' || typeflag === '\0' || typeflag === '') type = 'file';
  else if (typeflag === '5') type = 'directory';
  else throw new Error(`Unsupported tar entry type ${JSON.stringify(typeflag)} for ${fullName}`);
  if (seen.has(effectiveName)) throw new Error(`Duplicate tar entry: ${effectiveName}`);
  seen.add(effectiveName);
  return { path: effectiveName, type, mode, size };
}

// `buffer` is an uncompressed tar archive. Returns validated entries in archive order and
// rejects partial final blocks, a missing end-of-archive marker, truncated padding, and
// any nonzero byte after the end-of-archive marker.
function parseTar(buffer, limits) {
  if (limits && (!Number.isSafeInteger(limits.members) || limits.members < 1 || limits.members > 100000
    || limits.gnuLongNames !== undefined && typeof limits.gnuLongNames !== 'boolean'
    || limits.gitArchiveCommit !== undefined && (typeof limits.gitArchiveCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(limits.gitArchiveCommit)))) throw new Error('Invalid tar member budget');
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let terminated = false, headers = 0, longName;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) {
      terminated = true;
      offset += BLOCK;
      break;
    }
    if (limits && ++headers > limits.members) throw new Error('Tar member budget exceeded');
    const { path: fullName, type, mode, size } = validateHeader(block, seen, { gnuLongNames: limits?.gnuLongNames, longName, gitArchiveCommit: limits?.gitArchiveCommit });
    offset += BLOCK;
    const content = buffer.subarray(offset, offset + size);
    if (content.length < size) throw new Error(`Corrupted tar entry content: ${fullName}`);
    const paddingEnd = offset + Math.ceil(size / BLOCK) * BLOCK;
    if (paddingEnd > buffer.length) throw new Error('Corrupted tar entry padding');
    if (type === 'git-global') {
      // Git archives use one non-overriding comment record. No path, size or
      // link overrides, unknown records, alternate encodings or late globals.
      if (offset !== BLOCK || !content.equals(Buffer.from('52 comment=' + limits.gitArchiveCommit + '\n'))
        || !isZeroBlock(buffer.subarray(offset + size, paddingEnd))) throw new Error('Git global PAX exact commit/position/padding differs');
      offset = paddingEnd;
      continue;
    }
    offset = paddingEnd;
    if (type === 'long-name') {
      if (content[content.length - 1] !== 0 || content.indexOf(0) !== content.length - 1) throw new Error('Invalid GNU long name terminator');
      longName = decodeName(content.subarray(0, -1));
      assertSafePath(longName);
      if (/[\u0000-\u001f\u007f]/u.test(longName)) throw new Error('Unsafe GNU long name');
      continue;
    }
    longName = undefined;
    entries.push({ path: fullName, type, mode, size, sha256: sha256(content), content });
  }
  if (longName !== undefined) throw new Error('Dangling GNU long name metadata');
  if (!terminated) throw new Error('Corrupted tar payload: missing end-of-archive marker');
  if (entries.length === 0) throw new Error('Empty or corrupted tar payload');
  if ((buffer.length - offset) % BLOCK !== 0) throw new Error('Corrupted tar payload: partial final block');
  for (let index = offset; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) throw new Error('Corrupted tar payload: nonzero data after end-of-archive marker');
  }
  return entries;
}

function inspectTarballBuffer(compressed, limits) {
  if (limits && (!Number.isSafeInteger(limits.expandedBytes) || limits.expandedBytes < 1 || limits.expandedBytes > 4 * 1024 ** 3
    || !Number.isSafeInteger(limits.members) || limits.members < 1 || limits.members > 100000
    || limits.gnuLongNames !== undefined && typeof limits.gnuLongNames !== 'boolean')) throw new Error('Invalid tar inspection budget');
  let raw;
  try {
    raw = zlib.gunzipSync(compressed, limits ? { maxOutputLength: limits.expandedBytes } : undefined);
  } catch (error) {
    if (limits && error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Tar expanded byte budget exceeded');
    throw new Error('Corrupted tar payload: not valid gzip');
  }
  const entries = parseTar(raw, limits);
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
  if (!manifestEntry || manifestEntry.type !== 'file') {
    throw new Error(`Corrupted tar payload: missing ${MANIFEST_PATH}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString('utf8'));
  } catch {
    throw new Error(`Corrupted tar payload: invalid ${MANIFEST_PATH}`);
  }
  return { entries, manifest };
}

function validateTarInspectionLimits(limits) {
  for (const [key, maximum] of Object.entries({ expandedBytes: 4 * 1024 ** 3, members: 100000, manifestBytes: MANIFEST_MAX_BYTES })) {
    if (!limits || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error('Invalid tar inspection budget');
  }
  // GNU long-name metadata is opt-in per inspection; the default stays strict.
  if (limits.gnuLongNames !== undefined && typeof limits.gnuLongNames !== 'boolean') throw new Error('Invalid tar inspection budget');
}
// The same parser accepts a file stream or private-custody range stream. No
// extracted body or second archive parser is created by a transport adapter.
async function inspectTarballFile(file, limits, signal) {
  validateTarInspectionLimits(limits);
  signal?.throwIfAborted();

  return inspectTarballStream(require('node:fs').createReadStream(file, { highWaterMark: 65536 }), limits, signal);
}
// Single gunzip pass, bounded header/name set and manifest only; never materializes payloads.
async function inspectTarballStream(source, limits, signal, memberRange, visitMemberRange) {
  validateTarInspectionLimits(limits);
  signal?.throwIfAborted();
  if (memberRange !== undefined && (!memberRange || typeof memberRange.path !== 'string'
    || !Number.isSafeInteger(memberRange.offset) || memberRange.offset < 0
    || !Number.isSafeInteger(memberRange.length) || memberRange.length < 0 || memberRange.length > 65536)) throw new Error('Bounded member range required');
  if (memberRange) memberRange = Object.freeze({ path: memberRange.path, offset: memberRange.offset, length: memberRange.length });
  if (visitMemberRange !== undefined && typeof visitMemberRange !== 'function') throw new Error('Member range visitor must be a function');
  const rangeOutput = memberRange ? Buffer.alloc(memberRange.length) : undefined;
  let rangeFound = false, rangeCopied = 0;
  if (limits.memberDigests !== undefined && limits.memberDigests !== true) throw new Error('Explicit member digest mode required');
  if (limits.memberDigests ? !Number.isSafeInteger(limits.memberMetadataBytes) || limits.memberMetadataBytes < 1 || limits.memberMetadataBytes > 4 * 1024 ** 2 : limits.memberMetadataBytes !== undefined) throw new Error('Invalid member metadata budget');
  if (!source || typeof source.pipe !== 'function' || typeof source.destroy !== 'function' || typeof source.on !== 'function') throw new Error('Readable actual tarball stream required');
  const gunzip = zlib.createGunzip({ chunkSize: 65536 });
  source.on('error', error => gunzip.destroy(error));
  const abort = () => gunzip.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  source.pipe(gunzip);
  const seen = new Set();
  let header = Buffer.alloc(BLOCK), used = 0, remaining = 0, padding = 0;
  let ended = false, expanded = 0, members = 0, manifestParts = [], manifestBytes = 0, current;
  let longName, longNameParts = [];
  const memberDigests = limits.memberDigests ? [] : undefined;let memberMetadataBytes = 2, currentHash;
  function memberComplete() {
    if (current.type === 'long-name') {
      const content = Buffer.concat(longNameParts, current.size);
      longNameParts = [];
      if (content.length !== current.size || content[content.length - 1] !== 0 || content.indexOf(0) !== content.length - 1) throw new Error('Invalid GNU long name terminator');
      const decoded = decodeName(content.subarray(0, -1));
      assertSafePath(decoded);
      if (/[\u0000-\u001f\u007f]/u.test(decoded)) throw new Error('Unsafe GNU long name');
      longName = decoded;
      return;
    }
    if (!memberDigests) return;
    const row = { path: current.path, type: current.type, mode: current.mode, bytes: current.size, ...(currentHash ? { sha256: currentHash.digest('hex') } : {}) };
    memberDigests.push(row);currentHash = undefined;
  }
  try {
    for await (const chunk of gunzip) {
      signal?.throwIfAborted();
      expanded += chunk.length;
      if (expanded > limits.expandedBytes) throw new Error('Tar expanded byte budget exceeded');
      let offset = 0;
      while (offset < chunk.length) {
        if (ended) {
          if (!isZeroBlock(chunk.subarray(offset))) throw new Error('Corrupted tar payload: nonzero data after end-of-archive marker');
          offset = chunk.length;
        } else if (remaining) {
          const count = Math.min(remaining, chunk.length - offset, 65536);
          if (current.type === 'long-name') longNameParts.push(Buffer.from(chunk.subarray(offset, offset + count)));
          if (current.path === MANIFEST_PATH) manifestParts.push(Buffer.from(chunk.subarray(offset, offset + count)));
          if (currentHash) currentHash.update(chunk.subarray(offset, offset + count));
          if (visitMemberRange && current.type !== 'long-name') {
            const result = visitMemberRange(Object.freeze({path:current.path,type:current.type,mode:current.mode,bytes:current.size}), current.size-remaining, Buffer.from(chunk.subarray(offset,offset+count)));
            // The visitor is synchronous: never issue a completed parse while validation is pending.
            if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
              Promise.resolve(result).catch(() => {});
              throw new Error('Member range visitor must complete synchronously');
            }
          }
          if (memberRange && current.path === memberRange.path) {
            const position = current.size - remaining, start = Math.max(position, memberRange.offset), end = Math.min(position + count, memberRange.offset + memberRange.length);
            if (end > start) { chunk.copy(rangeOutput, start - memberRange.offset, offset + start - position, offset + end - position); rangeCopied += end - start; }
          }

          remaining -= count; offset += count;if (!remaining) memberComplete();
        } else if (padding) {
          const count = Math.min(padding, chunk.length - offset);
          padding -= count; offset += count;
        } else {
          const count = Math.min(BLOCK - used, chunk.length - offset);
          chunk.copy(header, used, offset, offset + count); used += count; offset += count;
          if (used === BLOCK) {
            used = 0;
            if (isZeroBlock(header)) { ended = true; continue; }
            if (++members > limits.members) throw new Error('Tar member budget exceeded');
            current = validateHeader(header, seen, { gnuLongNames: limits.gnuLongNames, longName });
            // The pending GNU name applies to exactly one ordinary entry.
            if (current.type !== 'long-name') longName = undefined;
            if (memberRange && current.path === memberRange.path) {
              if (current.type !== 'file' || memberRange.offset > current.size - memberRange.length) throw new Error('Regular member range outside original');
              rangeFound = true;
            }

            if (memberDigests && current.type !== 'long-name') {
              if (current.type === 'directory' && current.size !== 0) throw new Error('Source directory member has data');
              const reserved = { path: current.path, type: current.type, mode: current.mode, bytes: current.size, ...(current.type === 'file' ? { sha256: '0'.repeat(64) } : {}) };
              const amount = Buffer.byteLength(JSON.stringify(reserved)) + (memberDigests.length ? 1 : 0);
              if (memberMetadataBytes + amount > limits.memberMetadataBytes) throw new Error('Tar member metadata budget exceeded');
              memberMetadataBytes += amount;currentHash = current.type === 'file' ? crypto.createHash('sha256') : undefined;
            }
            remaining = current.size;if (!remaining) memberComplete();
            padding = (BLOCK - remaining % BLOCK) % BLOCK;
            if (current.path === MANIFEST_PATH) {
              if (current.type !== 'file' || current.size > limits.manifestBytes) throw new Error('Tar manifest byte budget/type exceeded');
              manifestBytes = current.size;
            }
          }
        }
      }
    }
    if (longName !== undefined) throw new Error('Dangling GNU long name metadata');
    if (!ended || remaining || padding || used || expanded % BLOCK) throw new Error('Corrupted tar payload: truncated or missing end-of-archive marker');
    if (!members || !seen.has(MANIFEST_PATH)) throw new Error(`Corrupted tar payload: missing ${MANIFEST_PATH}`);
    const manifestOriginal = Buffer.concat(manifestParts, manifestBytes);
    const manifest = JSON.parse(manifestOriginal.toString('utf8'));
    if (memberRange && (!rangeFound || rangeCopied !== memberRange.length)) throw new Error('Requested original member missing or shortened');
    return { manifest, manifestOriginal, members, expandedBytes: expanded, ...(memberDigests ? { memberDigests } : {}), ...(memberRange ? { memberRange: rangeOutput } : {}) };
  } finally { signal?.removeEventListener('abort', abort); source.destroy(); gunzip.destroy(); }
}

function walkDifference(published, local, pointer, reasons) {
  if (published === local) return;
  const publishedObject = published !== null && typeof published === 'object';
  const localObject = local !== null && typeof local === 'object';
  if (!publishedObject || !localObject) {
    if (JSON.stringify(published) !== JSON.stringify(local)) {
      reasons.push(`${pointer}: published ${JSON.stringify(published)} != local ${JSON.stringify(local)}`);
    }
    return;
  }
  if (Array.isArray(published) || Array.isArray(local)) {
    if (!Array.isArray(published) || !Array.isArray(local) || published.length !== local.length) {
      reasons.push(`${pointer}: array differs`);
      return;
    }
    for (let index = 0; index < published.length; index += 1) {
      walkDifference(published[index], local[index], `${pointer}[${index}]`, reasons);
    }
    return;
  }
  const keys = new Set([...Object.keys(published), ...Object.keys(local)]);
  for (const key of keys) walkDifference(published[key], local[key], `${pointer}.${key}`, reasons);
}

function collectManifestDifferences(published, local) {
  const reasons = [];
  const keys = new Set([...Object.keys(published || {}), ...Object.keys(local || {})]);
  for (const key of keys) {
    if (PROVENANCE_FIELDS.includes(key)) continue;
    walkDifference(published?.[key], local?.[key], key, reasons);
  }
  return reasons;
}

/**
 * Validates ONE side's material provenance and returns the ONLY facts that may
 * legitimately differ between accepted commits.
 *
 * Fails closed on anything unexpected: a missing/malformed JSON file, a schema
 * other than the known one, a sourceAuthority whose commit is not a 40-hex sha,
 * a commit that disagrees between the three files, an index whose recorded child
 * digests do not match the ACTUAL member bytes it claims to summarise, or an
 * inventory/manifest whose file list disagrees with the real tarball.
 *
 * Nothing here is package-name specific and no payload buffer is modified.
 */
function readMaterialFacts(entries, side) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const fail = (message) => { throw new Error(`${side} material provenance invalid: ${message}`); };
  const parse = (member, label) => {
    const entry = byPath.get(member);
    if (!entry || entry.type !== 'file') fail(`${label} is not a regular file`);
    const raw = entry.content.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail(`${label} is not valid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} is not an object`);
    // The collector emits exactly `JSON.stringify(value, null, 2) + "\n"`. Requiring
    // that form means duplicate keys (which JSON.parse silently collapses) and
    // unrelated whitespace/formatting deltas are refused rather than normalized away.
    if (raw !== `${JSON.stringify(parsed, null, 2)}\n`) fail(`${label} is not in the collector's canonical form`);
    if (parsed.schemaVersion !== MATERIAL_SCHEMA_VERSION) fail(`${label} has an unknown schemaVersion`);
    const authority = parsed.sourceAuthority;
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) fail(`${label} has no sourceAuthority`);
    const commit = authority[MATERIAL_COMMIT_FIELD];
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) fail(`${label} has an invalid ${MATERIAL_COMMIT_FIELD}`);
    for (const key of ['tracked', 'dirty', 'missingTrackedSourceCount', 'snapshotSHA256', 'scope']) {
      if (!(key in authority)) fail(`${label} is missing sourceAuthority.${key}`);
    }
    if (typeof authority.tracked !== 'boolean' || typeof authority.dirty !== 'boolean') fail(`${label} has a malformed boolean authority field`);
    if (!Number.isInteger(authority.missingTrackedSourceCount) || authority.missingTrackedSourceCount < 0) fail(`${label} has a malformed missingTrackedSourceCount`);
    if (typeof authority.snapshotSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(authority.snapshotSHA256)) fail(`${label} has a malformed snapshotSHA256`);
    if (typeof authority.scope !== 'string' || !authority.scope) fail(`${label} has a malformed scope`);
    return parsed;
  };

  const manifest = parse(MATERIAL_MANIFEST, 'build-provenance.json');
  const index = parse(MATERIAL_INDEX, 'index.json');
  const inventory = parse(MATERIAL_INVENTORY, 'source-inventory.json');

  // The commit must be ONE fact, not three independently moving ones.
  const commits = new Set([manifest.sourceAuthority[MATERIAL_COMMIT_FIELD],
    index.sourceAuthority[MATERIAL_COMMIT_FIELD], inventory.sourceAuthority[MATERIAL_COMMIT_FIELD]]);
  if (commits.size !== 1) fail(`the three files disagree about ${MATERIAL_COMMIT_FIELD}`);

  // Every index row must describe the ACTUAL bytes present in this tarball, except
  // the two rows whose digests are derived from the commit field itself.
  if (!Array.isArray(index.files)) fail('index.json has no files list');
  const indexRows = new Map();
  for (const row of index.files) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string') fail('index.json has a malformed row');
    if (indexRows.has(row.path)) fail(`index.json repeats ${row.path}`);
    indexRows.set(row.path, row);
  }
  // The index is a SUMMARY of the material payload, not a complete member list, so
  // only the rows it DECLARES are cross-checked. Every declared row must bind the
  // ACTUAL bytes with no exception — including the two commit-derived children, whose
  // digests are validated HERE before the comparison is allowed to normalize them.
  for (const [relative, row] of indexRows) {
    // Index rows are relative to the material directory itself.
    const member = `package/dist/materials/${relative}`;
    const entry = byPath.get(member);
    if (!entry) fail(`index.json declares a missing member ${relative}`);
    if (row.bytes !== entry.size) fail(`index.json has a stale size for ${relative}`);
    if (row.sha256 !== entry.sha256) fail(`index.json has a stale digest for ${relative}`);
  }

  // source-inventory must list the real source files, and its own rows must match them.
  if (!Array.isArray(inventory.files)) fail('source-inventory.json has no files list');
  const inventoryPaths = new Set();
  for (const row of inventory.files) {
    if (!row || typeof row.path !== 'string' || typeof row.sha256 !== 'string') fail('source-inventory.json has a malformed row');
    if (inventoryPaths.has(row.path)) fail(`source-inventory.json repeats ${row.path}`);
    inventoryPaths.add(row.path);
    const entry = byPath.get(`package/dist/materials/source/${row.path}`);
    if (!entry) fail(`source-inventory.json lists a missing source file ${row.path}`);
    if (entry.sha256 !== row.sha256 || entry.size !== row.bytes) fail(`source-inventory.json disagrees with source/${row.path}`);
    if (typeof row.tracked !== 'boolean') fail(`source-inventory.json row ${row.path} is missing tracked`);
  }

  const manifestFiles = Array.isArray(manifest.bundles) ? manifest.bundles : null;
  if (manifest.bundles !== undefined && !manifestFiles) fail('build-provenance.json has a malformed bundles list');

  return { commit: manifest.sourceAuthority[MATERIAL_COMMIT_FIELD], manifest, index, inventory };
}

/**
 * Permits ONLY: sourceAuthority.sourceCommit differing between the two sides, and
 * the two index child digests that are a pure function of it.
 *
 * Everything else - snapshotSHA256, inventory paths/digests, compiled bundles,
 * schema, extra keys, runtime bytes, manifest content - must still match exactly.
 */
function compareMaterialProvenance(publishedEntries, localEntries, reasons) {
  const published = readMaterialFacts(publishedEntries, 'published');
  const local = readMaterialFacts(localEntries, 'packed');
  const strip = (value) => {
    const clone = JSON.parse(JSON.stringify(value));
    clone.sourceAuthority[MATERIAL_COMMIT_FIELD] = null;
    return clone;
  };
  for (const [label, left, right] of [['build-provenance.json', published.manifest, local.manifest],
    ['source-inventory.json', published.inventory, local.inventory]]) {
    if (JSON.stringify(strip(left)) !== JSON.stringify(strip(right))) reasons.push(`${label}: content changed beyond ${MATERIAL_COMMIT_FIELD}`);
  }
  const stripIndex = (value) => {
    const clone = JSON.parse(JSON.stringify(value));
    clone.sourceAuthority[MATERIAL_COMMIT_FIELD] = null;
    for (const row of clone.files ?? []) {
      // Index rows are relative to the material directory.
      if (row.path === 'build-provenance.json' || row.path === 'source-inventory.json') row.sha256 = null;
    }
    return clone;
  };
  if (JSON.stringify(stripIndex(published.index)) !== JSON.stringify(stripIndex(local.index))) {
    reasons.push('index.json: content changed beyond the commit-derived child digests');
  }
}

// Compares the full payload (names, types, modes, content) of two gzipped tarballs and
// the manifest semantic fields. Argument order is published first, packed/local second,
// so every reason label reads published vs local. Only the fixed provenance field
// `gitHead` is ignored.
function comparePackagePayloads(publishedBuffer, localBuffer) {
  const published = inspectTarballBuffer(publishedBuffer);
  const local = inspectTarballBuffer(localBuffer);
  const reasons = [];
  const publishedByPath = new Map(published.entries.map((entry) => [entry.path, entry]));
  const localByPath = new Map(local.entries.map((entry) => [entry.path, entry]));
  // The material exemption applies ONLY when BOTH sides carry the complete set of
  // material files and the special comparison below actually runs. A partial set on
  // either side keeps the ORIGINAL strict byte comparison, so a half-material packet
  // can never hide content differences.
  const materialsComplete = MATERIAL_MEMBERS.every((member) => publishedByPath.has(member) && localByPath.has(member));
  for (const member of publishedByPath.keys()) if (!localByPath.has(member)) reasons.push(`only in published: ${member}`);
  for (const member of localByPath.keys()) if (!publishedByPath.has(member)) reasons.push(`only in local: ${member}`);
  for (const [member, publishedEntry] of publishedByPath) {
    const localEntry = localByPath.get(member);
    if (!localEntry) continue;
    if (publishedEntry.type !== localEntry.type) reasons.push(`${member}: type ${publishedEntry.type} != ${localEntry.type}`);
    if (publishedEntry.mode !== localEntry.mode) reasons.push(`${member}: mode ${publishedEntry.mode.toString(8)} != ${localEntry.mode.toString(8)}`);
    if (member === MANIFEST_PATH) continue;
    if (materialsComplete && MATERIAL_MEMBERS.includes(member)) continue;
    if (publishedEntry.sha256 !== localEntry.sha256) reasons.push(`${member}: content changed`);
  }
  if (materialsComplete) {
    try {
      compareMaterialProvenance(published.entries, local.entries, reasons);
    } catch (error) {
      reasons.push(error.message);
    }
  }
  for (const reason of collectManifestDifferences(published.manifest, local.manifest)) {
    reasons.push(`${MANIFEST_PATH}: ${reason}`);
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  MANIFEST_PATH,
  MANIFEST_MAX_BYTES,
  PROVENANCE_FIELDS,
  sha256,
  sha512Integrity,
  assertIntegrity,
  readOctal,
  parseTar,
  inspectTarballBuffer,
  inspectTarballFile,
  inspectTarballStream,
  comparePackagePayloads,
};
