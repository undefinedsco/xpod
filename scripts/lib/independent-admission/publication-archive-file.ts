import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
export interface PublicationArchiveIdentity { readonly archiveBytes: number; readonly archiveSha256: string; readonly integrity: string }
export type PublicationArchiveSource = { kind: 'buffer'; bytes: Buffer } | { kind: 'file'; path: string };
const PACKED_LIMIT = 768 * 1024 ** 2, BUFFER_LIMIT = 8 * 1024 ** 2, CHUNK = 65536;
const FLOOR = 1024 ** 3, QUEUE = 1024 ** 2, TIMEOUT = 120000;
const fail = (message: string): never => { throw new Error('Bound publication archive: ' + message); };
function regular(file: string): fs.Stats {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked path rejected');
    if (path.dirname(current) === current) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail('single-link regular file required');
  return stat;
}
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.mode === b.mode && a.nlink === b.nlink;
function space(root: string, bytes: number): void {
  const stat = fs.statfsSync(root, { bigint: true });
  if (stat.bavail < 0n || stat.bsize <= 0n || stat.bavail * stat.bsize < BigInt(FLOOR + QUEUE + bytes)) fail('snapshot filesystem floor insufficient');
}
function matches(hashes: { sha256: string; integrity: string }, identity: PublicationArchiveIdentity) {
  if (hashes.sha256 !== identity.archiveSha256 || hashes.integrity !== identity.integrity) fail('archive digest mismatch');
}
/** Read-only whole-group check before the first publication mutation. Sequential
 * snapshots need only the largest extra copy at peak; reserve that size again
 * conservatively for custody/consumer overlap. Existing source packages already
 * consume free space and are never counted as available capacity. */
export function preflightBoundPublicationArchiveFiles(rows: readonly { source: PublicationArchiveSource; identity: PublicationArchiveIdentity }[]): void {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) fail('bounded archive group required');
  const deadline = Date.now() + TIMEOUT; const scratch = Buffer.alloc(CHUNK); let largest = 0;
  for (const { source, identity } of rows) {
    if (!identity || !Number.isSafeInteger(identity.archiveBytes) || identity.archiveBytes < 1 || identity.archiveBytes > PACKED_LIMIT
      || !/^[a-f0-9]{64}$/u.test(identity.archiveSha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(identity.integrity)) fail('invalid bounded archive identity');
    if (!source || !['buffer', 'file'].includes(source.kind)) fail('invalid archive source');
    largest = Math.max(largest, identity.archiveBytes);
    const sha256 = createHash('sha256'), sha512 = createHash('sha512');
    if (source.kind === 'buffer') {
      if (!Buffer.isBuffer(source.bytes) || source.bytes.length !== identity.archiveBytes || source.bytes.length > BUFFER_LIMIT) fail('bounded buffer required');
      for (let offset = 0; offset < source.bytes.length; offset += CHUNK) {
        if (Date.now() > deadline) fail('group preflight deadline exceeded');
        const bytes = source.bytes.subarray(offset, offset + CHUNK); sha256.update(bytes); sha512.update(bytes);
      }
    } else {
      const before = regular(source.path);
      if (before.size !== identity.archiveBytes) fail('input size mismatch');
      const fd = fs.openSync(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!same(before, fs.fstatSync(fd))) fail('input changed before preflight');
        let total = 0;
        for (;;) {
          if (Date.now() > deadline) fail('group preflight deadline exceeded');
          const count = fs.readSync(fd, scratch, 0, CHUNK, null); if (!count) break;
          total += count; if (total > identity.archiveBytes) fail('input expanded during preflight');
          sha256.update(scratch.subarray(0, count)); sha512.update(scratch.subarray(0, count));
        }
        if (total !== identity.archiveBytes || !same(before, fs.fstatSync(fd)) || !same(before, regular(source.path))) fail('input changed during preflight');
      } finally { fs.closeSync(fd); }
    }
    matches({ sha256: sha256.digest('hex'), integrity: 'sha512-' + sha512.digest('base64') }, identity);
  }
  // No mkdir, snapshot or evidence writes occur anywhere in this preflight.
  space(fs.realpathSync(os.tmpdir()), largest * 2);
}
/** Byte custody helper only. A central private issuer must establish authority
 * before calling it. No caller transport or budget controls are accepted. */
export async function withBoundPublicationArchiveFile<T>(source: PublicationArchiveSource,
  identity: PublicationArchiveIdentity,
  operation: (archive: { readonly path: string; readonly identity: PublicationArchiveIdentity }) => Promise<T>): Promise<T> {
  if (!identity || !Number.isSafeInteger(identity.archiveBytes) || identity.archiveBytes < 1 || identity.archiveBytes > PACKED_LIMIT
    || !/^[a-f0-9]{64}$/u.test(identity.archiveSha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(identity.integrity)) fail('invalid bounded archive identity');
  const boundIdentity = Object.freeze({ archiveBytes: identity.archiveBytes, archiveSha256: identity.archiveSha256, integrity: identity.integrity });
  if (typeof operation !== 'function' || !source || !['buffer', 'file'].includes(source.kind)) fail('invalid archive operation/source');
  let input: number | undefined, output: number | undefined, root = '', retain = false;
  try {
    let inputStat: fs.Stats | undefined;
    if (source.kind === 'buffer') {
      if (!Buffer.isBuffer(source.bytes) || source.bytes.length !== boundIdentity.archiveBytes || source.bytes.length > BUFFER_LIMIT) fail('bounded buffer required');
    } else {
      inputStat = regular(source.path);
      if (inputStat.size !== boundIdentity.archiveBytes) fail('input size mismatch');
      input = fs.openSync(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!same(inputStat, fs.fstatSync(input))) fail('input changed before copy');
    }
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xpod-publication-archive-'));
    space(root, boundIdentity.archiveBytes);
    const target = path.join(root, 'archive.tgz');
    output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const h256 = createHash('sha256'), h512 = createHash('sha512'); const scratch = Buffer.alloc(CHUNK);
    const deadline = Date.now() + TIMEOUT;
    for (let position = 0; position < boundIdentity.archiveBytes;) {
      if (Date.now() > deadline) fail('copy deadline exceeded');
      const size = Math.min(CHUNK, boundIdentity.archiveBytes - position);
      if (source.kind === 'buffer') source.bytes.copy(scratch, 0, position, position + size);
      else {
        let count = 0;
        while (count < size) { const n = fs.readSync(input!, scratch, count, size - count, position + count); if (!n) fail('input truncated'); count += n; }
      }
      space(root, size);
      let written = 0;
      while (written < size) { const n = fs.writeSync(output, scratch, written, size - written); if (!n) fail('short snapshot write'); written += n; }
      h256.update(scratch.subarray(0, size)); h512.update(scratch.subarray(0, size)); position += size;
    }
    matches({ sha256: h256.digest('hex'), integrity: 'sha512-' + h512.digest('base64') }, boundIdentity);
    if (source.kind === 'file' && (!same(inputStat!, fs.fstatSync(input!)) || !same(inputStat!, regular(source.path)))) fail('input changed during copy');
    fs.fsyncSync(output); fs.closeSync(output); output = undefined;
    if (input !== undefined) { fs.closeSync(input); input = undefined; }
    fs.chmodSync(target, 0o400);
    const snapshot = regular(target);
    const reverify = () => {
      if (!same(snapshot, regular(target))) fail('snapshot path changed');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!same(snapshot, fs.fstatSync(fd))) fail('snapshot inode changed');
        const sha256 = createHash('sha256'), sha512 = createHash('sha512'); const deadline = Date.now() + TIMEOUT;
        let total = 0;
        for (;;) {
          if (Date.now() > deadline) fail('rehash deadline exceeded');
          const count = fs.readSync(fd, scratch, 0, CHUNK, null); if (!count) break;
          total += count; if (total > boundIdentity.archiveBytes) fail('snapshot size changed');
          sha256.update(scratch.subarray(0, count)); sha512.update(scratch.subarray(0, count));
        }
        if (total !== boundIdentity.archiveBytes || !same(snapshot, fs.fstatSync(fd)) || !same(snapshot, regular(target))) fail('snapshot changed during rehash');
        matches({ sha256: sha256.digest('hex'), integrity: 'sha512-' + sha512.digest('base64') }, boundIdentity);
      } finally { fs.closeSync(fd); }
    };
    reverify();
    let result: T | undefined, operationError: unknown; let rejected = false;
    try { result = await operation(Object.freeze({ path: target, identity: boundIdentity })); }
    catch (error) {
      rejected = true; operationError = error;
      // This flag can only retain bytes; it grants no admission authority. The
      // owned publisher sets it when process wait/close/group absence is unknown.
      retain = !!error && typeof error === 'object' && Reflect.get(error, 'retainArchiveSnapshot') === true;
      if (retain) {
        const locator = Object.freeze({ path: target, identity: boundIdentity,
          reason: 'publisher-process-closure-unconfirmed' });
        fs.writeFileSync(path.join(root, 'retained-archive.json'), JSON.stringify(locator) + '\n', { flag: 'wx', mode: 0o400 });
        operationError = Object.assign(new Error('Publication process closure unconfirmed; readonly archive retained', { cause: error }),
          { retainArchiveSnapshot: true, retainedArchive: locator, retainedArchiveSnapshotDirectory: root });
      }
    }
    try { reverify(); }
    catch (error) { if (rejected) throw new AggregateError([operationError, error], 'Operation failed and archive custody changed'); throw error; }
    if (rejected) throw operationError;
    return result as T;
  } finally {
    try { if (output !== undefined) fs.closeSync(output); }
    finally { try { if (input !== undefined) fs.closeSync(input); } finally { if (root && !retain) fs.rmSync(root, { recursive: true, force: true }); } }
  }
}
