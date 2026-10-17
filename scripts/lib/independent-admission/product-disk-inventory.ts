import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import type { CollectedArtifactMember } from './artifact-contract';
const { readOctal } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');
/** Physical module archives use regular USTAR files (no PAX/GNU extensions).
 * Limits are code-owned; callers cannot enlarge them. Disk use includes one
 * expanded tar, not a second extracted tree. No capability is issued here. */
export const productDiskInventoryLimits = Object.freeze({ packedBytes: 768 * 1024 ** 2,
  expandedBytes: 2 * 1024 ** 3, memberBytes: 256 * 1024 ** 2, members: 50000, timeoutMs: 30000, rangeCalls: 128, rangeHashBytes: 2 * 1024 ** 3 });
const DISK_FLOOR_BYTES = 1024 ** 3;
// Reserve stream buffers and filesystem bookkeeping before forwarding a chunk.
const DISK_QUEUE_RESERVE_BYTES = 1024 ** 2;
/** Pure arithmetic only, not an injectable production filesystem or issuer. */
export function assertProductDiskBudget(stat: { bavail: number | bigint; bsize: number | bigint }, additionalBytes: number): void {
  const integer = (value: number | bigint) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return fail('invalid filesystem capacity');
    const result = BigInt(value); if (result < 0n) return fail('invalid filesystem capacity'); return result;
  };
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) return fail('invalid disk reservation');
  const available = integer(stat.bavail) * integer(stat.bsize);
  if (available < BigInt(additionalBytes) + BigInt(DISK_FLOOR_BYTES + DISK_QUEUE_RESERVE_BYTES))
    fail('snapshot filesystem free-space floor insufficient');
}
export interface ProductDiskInventory {
  readonly archive: Readonly<{ bytes: number; sha256: string; integrity: string }>;
  readonly members: readonly CollectedArtifactMember[];
  readMember(name: string, maximumBytes: number): Buffer;
  /** Fixed <=64KiB range. Full-member SHA is rechecked with bounded scratch
   * on every call; no caller assertion substitutes for immutable byte binding. */
  readMemberRange(name: string, offset: number, length: number): Buffer;
  /** Same fd/stat as the fully hashed initial inventory, with a separate
   * fixed small-range budget for mechanical native header parsers. */
  readBoundMemberRange(name: string, offset: number, length: number): Buffer;
  dispose(): void;
}
const fail = (message: string): never => { throw new Error('Product disk inventory: ' + message); };
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
function ordinary(file: string): fs.Stats {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked archive ancestor');
    if (path.dirname(current) === current) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail('ordinary single-link archive required');
  return stat;
}
function nameField(header: Buffer, offset: number, size: number): string {
  const bytes = header.subarray(offset, offset + size);
  const end = bytes.indexOf(0); const value = bytes.subarray(0, end < 0 ? size : end);
  if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) fail('invalid tar string padding');
  const text = value.toString('utf8');
  if (!Buffer.from(text).equals(value)) fail('invalid UTF-8 member name');
  return text;
}
function safeName(name: string, directory: boolean): string {
  const value = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (!value || value.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || (value !== 'package' && !value.startsWith('package/')) || (!directory && value === 'package')) fail('unsafe product member path');
  return value;
}
/** Index a real tgz into a private, hash-bound disk snapshot. The caller must
 * compare returned archive identity with independently authenticated custody. */
export async function indexProductArchiveOnDisk(file: string): Promise<ProductDiskInventory> {
  const limits = productDiskInventoryLimits; const deadline = Date.now() + limits.timeoutMs;
  const checkTime = () => { if (Date.now() > deadline) fail('inventory deadline exceeded'); };
  const before = ordinary(file);
  if (before.size > limits.packedBytes) fail('packed byte budget exceeded');
  let input: number | undefined, fd: number | undefined; let root = '';
  try {
    input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-product-inventory-'));
    const snapshot = path.join(root, 'payload.tar');
    // Fresh statfs on the actual snapshot filesystem. Peak new payload is at
    // most expandedBytes; packed source already exists, but reserve its size
    // again conservatively for concurrent custody/evidence retention.
    assertProductDiskBudget(fs.statfsSync(root, { bigint: true }), limits.expandedBytes + before.size);
    if (!same(before, fs.fstatSync(input))) fail('archive changed before open');
    const sha256 = createHash('sha256'), sha512 = createHash('sha512'); let packed = 0, expanded = 0;
    const source = fs.createReadStream(file, { fd: input, autoClose: false, highWaterMark: 65536 });
    await pipeline(source, new Transform({ transform(chunk, _encoding, callback) {
      packed += chunk.length;
      if (packed > limits.packedBytes) { callback(new Error('packed byte budget exceeded')); return; }
      sha256.update(chunk); sha512.update(chunk); callback(null, chunk);
    } }), createGunzip({ chunkSize: 65536 }), new Transform({ transform(chunk, _encoding, callback) {
      expanded += chunk.length;
      if (expanded > limits.expandedBytes) { callback(new Error('expanded byte budget exceeded')); return; }
      try {
        // Check BEFORE this chunk can reach the writable stream. The extra
        // queue reserve covers pending bounded stream writes not yet in statfs.
        assertProductDiskBudget(fs.statfsSync(root, { bigint: true }), chunk.length);
        callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } }), fs.createWriteStream(snapshot, { flags: 'wx', mode: 0o600, highWaterMark: 65536 }), { signal: AbortSignal.timeout(limits.timeoutMs) });
    if (packed !== before.size || !same(before, fs.fstatSync(input)) || !same(before, ordinary(file))) fail('archive changed during indexing');
    fs.chmodSync(snapshot, 0o400); fd = fs.openSync(snapshot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const bound = fs.fstatSync(fd); const header = Buffer.alloc(512); const scratch = Buffer.alloc(65536);
    const rows: CollectedArtifactMember[] = []; const offsets = new Map<string, number>();
    const paths = new Map<string, 'file' | 'directory'>(); const requiredDirectories = new Set<string>(); let offset = 0, ended = false, count = 0;
    const read = (buffer: Buffer, position: number, bytes = buffer.length) => {
      let total = 0;
      while (total < bytes) { const n = fs.readSync(fd!, buffer, total, bytes - total, position + total); if (!n) fail('truncated tar'); total += n; }
    };
    while (offset < expanded) {
      checkTime(); if (expanded - offset < 512) fail('partial tar block'); read(header, offset); offset += 512;
      // Match workspace-package-payload: one zero block terminates, every
      // following complete block must be zero (writer normally pads to 10KiB).
      if (header.every(byte => byte === 0)) { ended = true; break; }
      if (++count > limits.members) fail('member count budget exceeded');
      // writePhysicalModuleArchive explicitly emits Python USTAR_FORMAT.
      if (!header.subarray(257, 263).equals(Buffer.from('ustar\0'))
        || header.subarray(263, 265).toString('ascii') !== '00') fail('physical product requires USTAR magic/version');
      const checksum = readOctal(header, 148, 8); let actual = 0;
      for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== actual) fail('tar checksum mismatch');
      const type = header[156]; if (![0, 48, 53].includes(type)) fail('links and nonordinary tar members rejected');
      const directory = type === 53; const prefix = nameField(header, 345, 155);
      const name = safeName((prefix ? prefix + '/' : '') + nameField(header, 0, 100), directory);
      if (paths.has(name)) fail('duplicate member');
      for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) {
        if (paths.get(parent) === 'file') fail('member beneath ordinary file');
        requiredDirectories.add(parent);
      }
      if (!directory && requiredDirectories.has(name)) fail('ordinary file shadows member directory');
      paths.set(name, directory ? 'directory' : 'file');
      const size = readOctal(header, 124, 12), mode = readOctal(header, 100, 8);
      if (size > limits.memberBytes || (directory && size !== 0) || ![0o644, 0o755].includes(mode)) fail('member size/mode outside product contract');
      if (offset + size > expanded) fail('truncated member content');
      const hash = createHash('sha256');
      for (let used = 0; used < size;) { checkTime(); const bytes = Math.min(scratch.length, size - used); read(scratch, offset + used, bytes); hash.update(scratch.subarray(0, bytes)); used += bytes; }
      if (!directory) { const relative = name.slice(8); offsets.set(relative, offset); rows.push(Object.freeze({ path: relative, bytes: size, mode, sha256: hash.digest('hex') })); }
      offset += Math.ceil(size / 512) * 512;
    }
    if (!ended || expanded % 512) fail('missing tar end marker');
    for (; offset < expanded;) { checkTime(); const size = Math.min(scratch.length, expanded - offset); read(scratch, offset, size); if (scratch.subarray(0, size).some(byte => byte !== 0)) fail('nonzero trailing tar data'); offset += size; }
    if (!offsets.has('package.json')) fail('product manifest missing');
    const byName = new Map(rows.map(row => [row.path, row])); let disposed = false;
    let rangeCalls = 0, rangeHashBytes = 0, originalCalls = 0, originalBytes = 0;
    const result: ProductDiskInventory = Object.freeze({
      archive: Object.freeze({ bytes: packed, sha256: sha256.digest('hex'), integrity: 'sha512-' + sha512.digest('base64') }),
      members: Object.freeze(rows),
      readMember(name: string, maximumBytes: number): Buffer {
        const row = byName.get(name);
        if (disposed || !row || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || row.bytes > maximumBytes
          || !same(bound, fs.fstatSync(fd!))) return fail('unique bounded unchanged member required');
        const bytes = Buffer.alloc(row.bytes); read(bytes, offsets.get(name)!);
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256 || !same(bound, fs.fstatSync(fd!))) fail('snapshot member changed');
        return bytes;
      },
      readMemberRange(name: string, offset: number, length: number): Buffer {
        const row = byName.get(name);
        if (disposed || !row || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
          || offset < 0 || length < 0 || length > 65536 || offset > row.bytes || length > row.bytes - offset
          || !same(bound, fs.fstatSync(fd!))) return fail('bounded unchanged member range required');
        // Reserve before work, including zero-length ranges and failed reads.
        if (rangeCalls >= limits.rangeCalls || row.bytes > limits.rangeHashBytes - rangeHashBytes)
          return fail('cumulative member range budget exceeded');
        rangeCalls++; rangeHashBytes += row.bytes;
        const rangeDeadline = Date.now() + limits.timeoutMs;
        const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
        for (let used = 0; used < row.bytes;) {
          if (Date.now() > rangeDeadline) fail('member range hash deadline exceeded');
          const bytes = Math.min(buffer.length, row.bytes - used);
          read(buffer, offsets.get(name)! + used, bytes); hash.update(buffer.subarray(0, bytes)); used += bytes;
        }
        if (hash.digest('hex') !== row.sha256 || !same(bound, fs.fstatSync(fd!))) fail('snapshot member changed');
        const bytes = Buffer.alloc(length); read(bytes, offsets.get(name)! + offset);
        if (!same(bound, fs.fstatSync(fd!))) fail('snapshot changed during range read');
        return bytes;
      },
      readBoundMemberRange(name: string, offset: number, length: number): Buffer {
        const row = byName.get(name);
        if (disposed || !row || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
          || offset < 0 || length < 0 || length > 65536 || offset > row.bytes || length > row.bytes - offset
          || !same(bound, fs.fstatSync(fd!))) return fail('bounded unchanged original range required');
        // Each member was fully hashed while building this same snapshot fd's
        // inventory. ctime/mtime/size/inode/nlink changes invalidate every range.
        // Rehashing a 33MiB image for each 8-byte load command would consume the
        // ordinary sparse-read hash budget before a real Mach-O can be parsed.
        if (++originalCalls > 32768 || (originalBytes += length) > 16 * 1024 ** 2) fail('native header original range budget exceeded');
        const bytes = Buffer.alloc(length); read(bytes, offsets.get(name)! + offset);
        if (!same(bound, fs.fstatSync(fd!))) fail('snapshot changed during original range read');
        return bytes;
      },
      dispose() { if (!disposed) { disposed = true; fs.closeSync(fd!); fd = undefined; fs.rmSync(root, { recursive: true, force: true }); } },
    });
    return result;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (root) fs.rmSync(root, { recursive: true, force: true }); throw error;
  } finally { if (input !== undefined) fs.closeSync(input); }
}
