'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const limits = require('./lib/module-artifact-limits.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function need(value, reason) { if (!value) throw new Error('Service pack originals: ' + reason); }
function identity(value) { return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** An optional recorder for the actual pack invocation, not an authority issuer.
 * The caller supplies its existing absolute deadline and retained-byte ledger.
 * Returned read buffers are the exact bytes used by the production packer. */
function createServicePackOriginals({ directory, bodyDirectory, sourceSha, check, reserveBytes, remainingBytes, metadataStart = () => {}, execFileSync }) {
  need(typeof check === 'function' && typeof reserveBytes === 'function', 'existing deadline and retained ledger required');
  need(typeof sourceSha === 'string' && /^[a-f0-9]{40}$/u.test(sourceSha), 'exact source SHA required');
  check();
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'objects'), { mode: 0o700 });
  const objects = new Map(), bodies = new Map(), records = [];
  if (bodyDirectory) { bodyDirectory = path.resolve(bodyDirectory); fs.mkdirSync(bodyDirectory, { mode: 0o700 }); fs.mkdirSync(path.join(bodyDirectory, 'objects'), { mode: 0o700 }); }
  let metadataBytes = 0, finished = false;
  function metadataTransportBytes(objectRows, actualRecords, extraIndexBytes = 98304) {
    const sample = { schemaVersion: 1, kind: 'actual-service-pack-manifest-inputs', sourceSha, scope: 'same-invocation byte and resolution observations only', authorityVerified: false, originals: objectRows, bodyOriginals: [...bodies.values()], records: actualRecords, details: {} };
    const padded = size => Math.ceil(size / 512) * 512;
    return 2560 + padded(Buffer.byteLength(JSON.stringify(sample, null, 2)) + 1 + extraIndexBytes) + objectRows.reduce((sum, row) => sum + 512 + padded(row.bytes), 0);
  }
  function active() { check(); need(!finished, 'recording already sealed'); }
  function append(row) {
    active(); need(records.length < limits.sourceMaterialFiles, 'bounded original record count');
    const encoded = JSON.stringify(row);
    need(Buffer.byteLength(encoded) <= 16384 && metadataBytes + Buffer.byteLength(encoded) + 1 <= limits.metadataBytes - 1024, 'bounded original metadata');
    need(metadataTransportBytes([...objects.values()], [...records, row]) <= limits.metadataBytes, 'metadata transport aggregate bound');
    metadataBytes += Buffer.byteLength(encoded) + 1; records.push(JSON.parse(encoded));
  }
  function role(value) { need(typeof value === 'string' && /^[a-zA-Z0-9/:._-]{1,128}$/u.test(value), 'fixed bounded original role'); return value; }
  function filePath(value) { need(typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value), 'bounded absolute input path'); return value; }
  function objectBuffer(data) {
    active(); const digest = sha(data), reference = { path: 'objects/' + digest + '.original', bytes: data.length, sha256: digest };
    if (objects.has(digest)) { need(objects.get(digest).bytes === data.length, 'object identity collision'); return reference; }
    need(objects.size < limits.sourceMaterialFiles, 'bounded retained object count');
    need(metadataTransportBytes([...objects.values(), reference], records) <= limits.metadataBytes, 'metadata transport aggregate bound');
    const fd = fs.openSync(path.join(directory, reference.path), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      for (let offset = 0; offset < data.length; offset += limits.rangeBytes) {
        active(); const block = data.subarray(offset, offset + limits.rangeBytes); reserveBytes(block.length); let written = 0;
        while (written < block.length) { active(); const size = fs.writeSync(fd, block, written, block.length - written); need(size > 0, 'original write made no progress'); written += size; }
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    objects.set(digest, reference); return reference;
  }
  function readOriginal(file, inputRole, maximum = limits.metadataBytes) {
    active(); filePath(file); role(inputRole);
    need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= limits.metadataBytes, 'bounded manifest original read');
    const canonical = fs.realpathSync(file); filePath(canonical);
    const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let data, first;
    try {
      first = fs.fstatSync(fd, { bigint: true });
      need(first.isFile() && first.size > 0n && first.size <= BigInt(maximum), 'bounded regular manifest original');
      data = Buffer.alloc(Number(first.size)); let offset = 0;
      while (offset < data.length) { active(); const count = fs.readSync(fd, data, offset, Math.min(limits.rangeBytes, data.length - offset), offset); need(count > 0, 'original truncated during read'); offset += count; }
      active(); need(same(identity(first), identity(fs.fstatSync(fd, { bigint: true }))) && fs.realpathSync(file) === canonical && same(identity(first), identity(fs.statSync(canonical, { bigint: true }))), 'input identity drift during actual read');
    } finally { fs.closeSync(fd); }
    const reference = objectBuffer(data);
    append({ kind: 'actual-manifest-read', role: inputRole, path: file, canonicalPath: canonical, identity: identity(first), reference });
    return data;
  }
  function readManifest(file, inputRole) { return JSON.parse(readOriginal(file, inputRole).toString('utf8')); }
  function retainBuffer(data, inputRole) {
    active(); role(inputRole); need(Buffer.isBuffer(data) && data.length >= 0 && data.length <= limits.metadataBytes, 'bounded actual manifest buffer');
    const reference = objectBuffer(data); append({ kind: 'actual-buffer', role: inputRole, reference }); return reference;
  }
  function event(value) {
    active(); need(value && typeof value === 'object' && !Array.isArray(value), 'actual resolution event required');
    // This records resolution mechanics; reader replay must rejoin actual
    // manifest references and source roots, never trust edge booleans as proof.
    append({ kind: 'actual-resolution-event', ...value });
  }
  function retainBody(file, inputRole, name) {
    active(); filePath(file); need(['seed-npm-pack', 'public-package-tar', 'final-service-pack'].includes(inputRole), 'fixed actual body role');
    need(bodyDirectory && typeof remainingBytes === 'function', 'actual body directory and parent remaining ledger required');
    if (inputRole === 'public-package-tar') need(typeof name === 'string' && name.length <= 256, 'actual public package identity required');
    const canonical = fs.realpathSync(file), fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let first, target, temporary, count = 0; const digests = ['sha256', 'sha1', 'sha512'].map(algorithm => crypto.createHash(algorithm));
    try {
      first = fs.fstatSync(fd, { bigint: true });
      need(first.isFile() && first.size > 0n && first.size <= BigInt(limits.packedBytes), 'bounded actual pack body');
      append({ kind: 'actual-pack-body-stat', role: inputRole, name: name || null, path: file, canonicalPath: canonical, identity: identity(first), bytes: Number(first.size) });
      const actualRemaining = remainingBytes();
      if (first.size > BigInt(actualRemaining)) {
        const error = new Error('Service pack originals: pending actual pack-body-retention-budget-exhausted:' + inputRole);
        // The actual FD stat is already held, and no body byte has been read.
        // Parent raw retention preserves finite capacity evidence even when no
        // complete collection can be sealed. Never print the candidate path.
        const diagnostic = {kind:'actual-service-pack-body-budget-refused',role:inputRole,ordinal:bodies.size+1,bytes:Number(first.size),remainingBytes:actualRemaining,authorityVerified:false,bodyRetained:false};
        try { process.stderr.write('SERVICE_PACK_BODY_BUDGET '+JSON.stringify(diagnostic)+'\n'); } catch (_) { /* Preserve the original budget refusal. */ }
        throw error;
      }
      temporary = path.join(bodyDirectory, 'objects', '.pending-' + records.length);
      target = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const buffer = Buffer.alloc(limits.rangeBytes);
      while (true) {
        active(); const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break;
        count += size; need(count <= Number(first.size), 'actual body grew'); const block = buffer.subarray(0, size); reserveBytes(size);
        let written = 0; while (written < size) { active(); const n = fs.writeSync(target, block, written, size - written); need(n > 0, 'body write made no progress'); written += n; }
        digests.forEach(digest => digest.update(block));
      }
      fs.fsyncSync(target); active();
      need(count === Number(first.size) && same(identity(first), identity(fs.fstatSync(fd, { bigint: true }))) && fs.realpathSync(file) === canonical && same(identity(first), identity(fs.statSync(canonical, { bigint: true }))), 'actual body input identity changed');
    } finally { if (target !== undefined) fs.closeSync(target); fs.closeSync(fd); }
    const digest = digests[0].digest('hex'), filename = String(bodies.size + 1).padStart(4, '0') + '-' + digest + '.original';
    const reference = { path: 'service-pack-bodies/objects/' + filename, bytes: count, sha256: digest };
    const destination = path.join(bodyDirectory, 'objects', filename);
    // Each actual role has its own physical copy, even if the bytes happen to
    // match another stage. Every copy has already been charged before writing.
    fs.renameSync(temporary, destination); bodies.set(reference.path, reference);
    const value = { kind: 'actual-pack-body', role: inputRole, name: name || null, path: file, canonicalPath: canonical, identity: identity(first), reference, shasum: digests[1].digest('hex'), integrity: 'sha512-' + digests[2].digest('base64') };
    append(value); return value;
  }
  function seal(value = {}) {
    active(); need(Buffer.byteLength(JSON.stringify(value)) <= 65536, 'bounded original collection details'); const collection = { schemaVersion: 1, kind: 'actual-service-pack-manifest-inputs', sourceSha, scope: 'same-invocation byte and resolution observations only', authorityVerified: false, originals: [...objects.values()], bodyOriginals: [...bodies.values()], records, details: value };
    const data = Buffer.from(JSON.stringify(collection, null, 2) + '\n'); need(data.length <= limits.metadataBytes, 'bounded final original collection');
    const padded = size => Math.ceil(size / 512) * 512;
    const metadataTarBound = 2048 + 512 + padded(data.length) + [...objects.values()].reduce((sum, row) => sum + 512 + padded(row.bytes), 0);
    need(metadataTarBound <= limits.metadataBytes, 'metadata transport aggregate bound');
    metadataStart();
    const fd = fs.openSync(path.join(directory, 'materials.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { for (let at = 0; at < data.length; at += limits.rangeBytes) { active(); const block = data.subarray(at, at + limits.rangeBytes); reserveBytes(block.length); let written = 0; while (written < block.length) { active(); const count = fs.writeSync(fd, block, written, block.length - written); need(count > 0, 'collection write made no progress'); written += count; } } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    finished = true; return Object.freeze({ path: 'materials.json', bytes: data.length, sha256: sha(data) });
  }
  return Object.freeze({ readOriginal, readManifest, retainBuffer, retainBody, event, seal, execFileSync });
}
module.exports = { createServicePackOriginals };
