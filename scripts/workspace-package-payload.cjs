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

function readString(block, offset, length) {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  return block.toString('utf8', offset, end).replace(/ +$/u, '');
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

function validateHeader(block, seen) {
  const storedChecksum = readOctal(block, 148, 8);
  const checksumBlock = Buffer.from(block);
  checksumBlock.fill(0x20, 148, 156);
  let computed = 0;
  for (const byte of checksumBlock) computed += byte;
  if (computed !== storedChecksum) throw new Error('Corrupted tar header checksum');
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  assertSafePath(fullName);
  const typeflag = String.fromCharCode(block[156]);
  const mode = readOctal(block, 100, 8) & 0o7777;
  const size = readOctal(block, 124, 12);
  let type;
  if (typeflag === '0' || typeflag === '\0' || typeflag === '') type = 'file';
  else if (typeflag === '5') type = 'directory';
  else throw new Error(`Unsupported tar entry type ${JSON.stringify(typeflag)} for ${fullName}`);
  if (seen.has(fullName)) throw new Error(`Duplicate tar entry: ${fullName}`);
  seen.add(fullName);
  return { path: fullName, type, mode, size };
}

// `buffer` is an uncompressed tar archive. Returns validated entries in archive order and
// rejects partial final blocks, a missing end-of-archive marker, truncated padding, and
// any nonzero byte after the end-of-archive marker.
function parseTar(buffer) {
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) {
      terminated = true;
      offset += BLOCK;
      break;
    }
    const { path: fullName, type, mode, size } = validateHeader(block, seen);
    offset += BLOCK;
    const content = buffer.subarray(offset, offset + size);
    if (content.length < size) throw new Error(`Corrupted tar entry content: ${fullName}`);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    entries.push({ path: fullName, type, mode, size, sha256: sha256(content), content });
  }
  if (!terminated) throw new Error('Corrupted tar payload: missing end-of-archive marker');
  if (entries.length === 0) throw new Error('Empty or corrupted tar payload');
  if ((buffer.length - offset) % BLOCK !== 0) throw new Error('Corrupted tar payload: partial final block');
  for (let index = offset; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) throw new Error('Corrupted tar payload: nonzero data after end-of-archive marker');
  }
  return entries;
}

function inspectTarballBuffer(compressed) {
  let raw;
  try {
    raw = zlib.gunzipSync(compressed);
  } catch {
    throw new Error('Corrupted tar payload: not valid gzip');
  }
  const entries = parseTar(raw);
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

// Single gunzip pass, bounded header/name set and manifest only; never materializes payloads.
async function inspectTarballFile(file, limits, signal) {
  for (const [key, maximum] of Object.entries({ expandedBytes: 4 * 1024 ** 3, members: 100000, manifestBytes: MANIFEST_MAX_BYTES })) {
    if (!limits || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error('Invalid tar inspection budget');
  }
  signal?.throwIfAborted();
  const source = require('node:fs').createReadStream(file, { highWaterMark: 65536 });
  const gunzip = zlib.createGunzip({ chunkSize: 65536 });
  source.on('error', error => gunzip.destroy(error));
  const abort = () => gunzip.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  source.pipe(gunzip);
  const seen = new Set();
  let header = Buffer.alloc(BLOCK), used = 0, remaining = 0, padding = 0;
  let ended = false, expanded = 0, members = 0, manifestParts = [], manifestBytes = 0, current;
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
          const count = Math.min(remaining, chunk.length - offset);
          if (current.path === MANIFEST_PATH) manifestParts.push(Buffer.from(chunk.subarray(offset, offset + count)));
          remaining -= count; offset += count;
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
            current = validateHeader(header, seen);
            remaining = current.size;
            padding = (BLOCK - remaining % BLOCK) % BLOCK;
            if (current.path === MANIFEST_PATH) {
              if (current.type !== 'file' || current.size > limits.manifestBytes) throw new Error('Tar manifest byte budget/type exceeded');
              manifestBytes = current.size;
            }
          }
        }
      }
    }
    if (!ended || remaining || padding || used || expanded % BLOCK) throw new Error('Corrupted tar payload: truncated or missing end-of-archive marker');
    if (!members || !seen.has(MANIFEST_PATH)) throw new Error(`Corrupted tar payload: missing ${MANIFEST_PATH}`);
    const manifest = JSON.parse(Buffer.concat(manifestParts, manifestBytes).toString('utf8'));
    return { manifest, members, expandedBytes: expanded };
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
  for (const member of publishedByPath.keys()) if (!localByPath.has(member)) reasons.push(`only in published: ${member}`);
  for (const member of localByPath.keys()) if (!publishedByPath.has(member)) reasons.push(`only in local: ${member}`);
  for (const [member, publishedEntry] of publishedByPath) {
    const localEntry = localByPath.get(member);
    if (!localEntry) continue;
    if (publishedEntry.type !== localEntry.type) reasons.push(`${member}: type ${publishedEntry.type} != ${localEntry.type}`);
    if (publishedEntry.mode !== localEntry.mode) reasons.push(`${member}: mode ${publishedEntry.mode.toString(8)} != ${localEntry.mode.toString(8)}`);
    if (member === MANIFEST_PATH) continue;
    if (publishedEntry.sha256 !== localEntry.sha256) reasons.push(`${member}: content changed`);
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
  comparePackagePayloads,
};
