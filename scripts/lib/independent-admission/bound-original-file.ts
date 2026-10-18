import type {OriginalReadBudget} from './artifact-contract';
import limits from '../module-artifact-limits.json';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export interface BoundOriginalReference { readonly path: string; readonly bytes: number; readonly sha256: string }
/** Byte custody helper only. The central collector supplies a registered,
 * owned readonly projection. This helper cannot issue admission capabilities. */
export function openBoundOriginalFile(file: string, reference: BoundOriginalReference,budget?:OriginalReadBudget) {
  const fail = (reason: string): never => { throw Error('Bound original file: ' + reason); };
  const checkBudget=()=>{const value=budget?.remainingMilliseconds();if(value!==undefined&&(!Number.isFinite(value)||value<=0))fail('observer original deadline');};
  checkBudget();
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > limits.shardBytes
    || !/^[a-f0-9]{64}$/u.test(reference.sha256)) fail('fixed original identity required');
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked original ancestor');
    if (path.dirname(current) === current) break;
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size !== reference.bytes) fail('single-link exact ordinary original required');
  const same = (stat: fs.Stats) => before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
    && before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs && before.mode === stat.mode && before.nlink === stat.nlink;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let closed = false, readBytes = 0, readCalls = 0;
  try {
    if (!same(fs.fstatSync(fd))) fail('original changed before full hash');
    const scratch = Buffer.alloc(limits.rangeBytes), hash = createHash('sha256'), deadline = Date.now() + limits.timeoutMs;
    for (let offset = 0; offset < before.size;) {
      checkBudget();
      if (Date.now() >= deadline) fail('full original hash deadline exceeded');
      const count = fs.readSync(fd, scratch, 0, Math.min(scratch.length, before.size - offset), offset);
      if (!count) fail('original truncated'); hash.update(scratch.subarray(0, count)); offset += count;
    }
    checkBudget();
    if (hash.digest('hex') !== reference.sha256 || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) fail('full original identity changed');
  } catch (error) { fs.closeSync(fd); throw error; }
  const check = () => { if (closed || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) fail('original revoked or changed'); };
  return Object.freeze({
    readRange(offset: number, length: number): Buffer {
      check();
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > limits.rangeBytes
        || offset > before.size || length > before.size - offset) fail('fixed 64KiB original range required');
      if (++readCalls > Math.max(1024, Math.ceil(before.size / limits.rangeBytes) * 8)
        || (readBytes += length) > before.size * 4 + 1024 * 1024) fail('cumulative original range budget exceeded');
      const bytes = Buffer.alloc(length); let used = 0;
      while (used < length) { const count = fs.readSync(fd, bytes, used, length - used, offset + used); if (!count) fail('original range truncated'); used += count; }
      check(); return bytes;
    },
    close(): void { if (!closed) { closed = true; fs.closeSync(fd); } },
  });
}
