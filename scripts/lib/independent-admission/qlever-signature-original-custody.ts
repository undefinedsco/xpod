import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureLegalFileIdentity, assertLegalFileIdentity, type LegalFileIdentity} from './legal-file-custody';
type Ref = Readonly<{bytes: number; sha256: string}>;
function need(value: unknown, reason: string): asserts value {if (!value) throw Error('Signature original custody: ' + reason);}
function assertFd(fd: number, identity: LegalFileIdentity) {
  const actual = fs.fstatSync(fd, {bigint: true});
  for (const key of ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'nlink'] as const) need(actual[key] === identity[key], 'original fd identity changed');
}
/** Bounded mechanics only. No registration or trust capability is issued. */
export function hashSignatureControllerFile(file: string, check: () => void) {
  const identity = captureLegalFileIdentity(file);
  need(identity.size <= 16n * 1024n ** 2n, 'controller executable byte bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), digest = createHash('sha256'), block = Buffer.alloc(65536);
  let total = 0;
  try {
    assertFd(fd, identity);
    for (;;) {
      check(); const count = fs.readSync(fd, block, 0, Math.min(block.length, Number(identity.size) - total + 1), null);
      if (!count) break;
      total += count; need(total <= Number(identity.size), 'controller executable grew beyond initial byte budget');
      digest.update(block.subarray(0, count));
    }
    need(BigInt(total) === identity.size, 'controller executable truncated'); assertFd(fd, identity);
  } finally {fs.closeSync(fd);}
  assertLegalFileIdentity(identity); return {identity, sha256: digest.digest('hex')};
}
export function readSignatureOriginal(file: string, reference: Ref, maximum: number, check: () => void) {
  const identity = captureLegalFileIdentity(file);
  need(Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= maximum
    && identity.size === BigInt(reference.bytes), 'registered original actual size differs or exceeds bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), bytes = Buffer.alloc(reference.bytes);
  try {
    assertFd(fd, identity);
    for (let at = 0; at < bytes.length;) {check(); const count = fs.readSync(fd, bytes, at, Math.min(65536, bytes.length - at), null); need(count > 0, 'original truncated'); at += count;}
    assertFd(fd, identity);
  } finally {fs.closeSync(fd);}
  check(); assertLegalFileIdentity(identity);
  need(createHash('sha256').update(bytes).digest('hex') === reference.sha256, 'registered original bytes differ');
  return {bytes, identity};
}
/** Preserve FIRST verified identities; final enumeration can never adopt new
 * bytes. The directory is owned by one observation; only empty-home is allowed. */
export function assertSignatureOriginalSet(directory: string, identities: readonly LegalFileIdentity[]) {
  const expected = new Map(identities.map(identity => [path.basename(identity.path), identity]));
  need(expected.size === identities.length && identities.every(identity => path.dirname(identity.path) === directory), 'unique owned original roles required');
  const actual = fs.readdirSync(directory);
  need(actual.length === expected.size + 1 && actual.every(name => expected.has(name) || name === 'empty-home'), 'retained original role set changed');
  const home = path.join(directory, 'empty-home'), stat = fs.lstatSync(home);
  need(stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(home).length === 0, 'owned empty home changed');
  for (const identity of identities) assertLegalFileIdentity(identity);
}
