'use strict';

/**
 * Lossless archive codec for the embedded Bun single-binary payload.
 *
 * A payload is a set of staged files (path, POSIX permission mode, exact bytes).
 * The previous representation JSON-encoded every file as a base64 string and only
 * then Brotli-compressed the JSON. Base64 inflates each file by 33% BEFORE
 * compression and hides long-range repetition from the compressor, so it both
 * wastes space and slows compression down.
 *
 * This container keeps per-file metadata small and JSON-readable, then
 * concatenates the RAW bytes, so Brotli sees the actual payload.
 *
 * Layout (integers little-endian), before Brotli:
 *   offset 0   : 8-byte magic "XPODAR01"
 *   offset 8   : uint32 metadataLength
 *   offset 12  : metadataLength bytes of UTF-8 JSON:
 *                [{ "path": string, "mode": number, "length": number }, ...]
 *                in strict JS string order of `path`
 *   offset 12+metadataLength : concatenated raw file bytes, in metadata order
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * `assertCanonicalArchivePath` and `decodeArchive` are deliberately
 * self-contained (only Buffer/JSON globals), so the compiled bootstrap embeds
 * them by serialising their ACTUAL source with Function.prototype.toString().
 * There is no second hand-copied reader: editing these functions changes the
 * compiled path automatically, and the unit tests and the real compiled
 * bootstrap therefore exercise the same code.
 */

/** 8-byte container magic; the reader keeps its own literal so it stays self-contained. */
const MAGIC = 'XPODAR01';
const HEADER_BYTES = 12;

/**
 * Reject any path that is not already canonical relative POSIX form.
 *
 * Non-canonical input is REFUSED rather than normalised: silently rewriting
 * `a\b` or `a//b` would map two distinct strings onto one filesystem location and
 * could let a caller extract outside the cache root.
 *
 * Self-contained: no external references, safe to inline into generated source.
 */
function assertCanonicalArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Archive entry path must be a non-empty string');
  if (value.includes('\u0000')) throw new Error('Archive entry path must not contain NUL');
  if (value.includes('\\')) throw new Error('Archive entry path must use POSIX separators, not backslashes');
  if (value.charCodeAt(0) === 47) throw new Error('Archive entry path must be relative');
  if (/^[A-Za-z]:/u.test(value)) throw new Error('Archive entry path must not be a drive path');
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new Error('Archive entry path must not contain empty segments');
    if (segment === '.' || segment === '..') throw new Error('Archive entry path must not contain dot segments');
  }
  return value;
}

/**
 * Decode a container back to entries, validating the whole structure.
 *
 * Self-contained on purpose: only Buffer and JSON are referenced, so the
 * compiled bootstrap embeds this exact source. Magic, metadata bounds, canonical
 * paths, strict ordering, every mode, every declared length and the exact total
 * container length must all agree, so a truncated or malformed archive is
 * rejected instead of silently producing short files.
 *
 * Bounds come from the format itself: metadataLength is a uint32, so it can never
 * exceed 0xFFFFFFFF, and it must additionally fit inside the actual buffer.
 */
function decodeArchive(container) {
  const HEADER = 12;
  if (!Buffer.isBuffer(container)) throw new Error('Archive payload must be a Buffer');
  if (container.length < HEADER) throw new Error('Archive is shorter than its header');
  if (container.subarray(0, 8).toString('latin1') !== 'XPODAR01') throw new Error('Archive magic does not match');
  const metadataLength = container.readUInt32LE(8);
  if (metadataLength === 0) throw new Error('Archive metadata length must be positive');
  if (HEADER + metadataLength > container.length) throw new Error('Archive metadata is truncated');
  let metadata;
  try {
    metadata = JSON.parse(container.subarray(HEADER, HEADER + metadataLength).toString('utf8'));
  } catch {
    throw new Error('Archive metadata is not valid JSON');
  }
  if (!Array.isArray(metadata) || metadata.length === 0) throw new Error('Archive metadata must be a non-empty array');
  const entries = [];
  const seen = new Set();
  let offset = HEADER + metadataLength;
  let previousPath;
  for (const item of metadata) {
    if (!item || typeof item.path !== 'string' || item.path.length === 0) throw new Error('Archive entry path must be a non-empty string');
    if (item.path.includes('\u0000')) throw new Error('Archive entry path must not contain NUL');
    if (item.path.includes('\\')) throw new Error('Archive entry path must use POSIX separators, not backslashes');
    if (item.path.charCodeAt(0) === 47) throw new Error('Archive entry path must be relative');
    if (/^[A-Za-z]:/u.test(item.path)) throw new Error('Archive entry path must not be a drive path');
    const segments = item.path.split('/');
    for (const segment of segments) {
      if (segment.length === 0) throw new Error('Archive entry path must not contain empty segments');
      if (segment === '.' || segment === '..') throw new Error('Archive entry path must not contain dot segments');
    }
    // Strict JS string (UTF-16 code unit) order, matching the encoder's sort.
    if (previousPath !== undefined && !(previousPath < item.path)) throw new Error('Archive entries must be in strict path order');
    previousPath = item.path;
    if (seen.has(item.path)) throw new Error('Archive entry path is duplicated');
    seen.add(item.path);
    if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error('Archive entry mode is invalid');
    if (!Number.isSafeInteger(item.length) || item.length < 0) throw new Error('Archive entry length is invalid');
    if (offset + item.length > container.length) throw new Error('Archive entry content is truncated');
    entries.push({ path: item.path, mode: item.mode, content: container.subarray(offset, offset + item.length) });
    offset += item.length;
  }
  if (offset !== container.length) throw new Error('Archive has trailing bytes');
  return entries;
}

function compareArchivePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build the uncompressed container. Only the Node producer encodes; the
 * bootstrap only ever decodes.
 * @param {Array<{path: string, mode: number, content: Buffer}>} entries
 * @returns {{container: Buffer, metadataLength: number}}
 */
function encodeArchive(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Archive requires at least one entry');
  const seen = new Set();
  const sorted = entries.map((entry) => {
    if (!entry) throw new Error('Archive entry must be an object');
    const archivePath = assertCanonicalArchivePath(entry.path);
    if (seen.has(archivePath)) throw new Error(`Duplicate archive entry path: ${archivePath}`);
    seen.add(archivePath);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error(`Archive entry mode out of range: ${archivePath}`);
    }
    if (!Buffer.isBuffer(entry.content)) throw new Error(`Archive entry content must be a Buffer: ${archivePath}`);
    return { path: archivePath, mode: entry.mode, content: entry.content };
  }).sort((left, right) => compareArchivePaths(left.path, right.path));

  const metadata = sorted.map((entry) => ({ path: entry.path, mode: entry.mode, length: entry.content.length }));
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  // uint32 metadata length is the format's own capacity; no extra policy cap.
  if (metadataBytes.length === 0 || metadataBytes.length > 0xFFFFFFFF) {
    throw new Error('Archive metadata length does not fit the container format');
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32LE(metadataBytes.length, 8);
  return {
    container: Buffer.concat([header, metadataBytes, ...sorted.map((entry) => entry.content)]),
    metadataLength: metadataBytes.length,
  };
}

/**
 * Bootstrap reader source generated from the real functions above. Both are
 * dependency-free, so the generated text needs no imports and cannot drift from
 * the implementation these tests exercise.
 */
const BOOTSTRAP_READER_SOURCE = [
  '/** Canonical relative POSIX path check (generated from the shared codec). */',
  assertCanonicalArchivePath.toString(),
  '',
  '/** Strict archive reader (generated from the shared codec). */',
  decodeArchive.toString(),
].join('\n');

module.exports = {
  encodeArchive,
  decodeArchive,
  assertCanonicalArchivePath,
  MAGIC,
  HEADER_BYTES,
  BOOTSTRAP_READER_SOURCE,
};
