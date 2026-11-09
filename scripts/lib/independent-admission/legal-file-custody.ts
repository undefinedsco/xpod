import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const sharedExecutablePath = createRequire(import.meta.url)('../executable-identity-path.cjs') as {
  resolveExecutableIdentityPath(filename: string): string;
  executableIdentityMatches(requested: string, candidate: string): boolean;
};
/** A structural file identity, not a capability or a grant. Only private
 * original issuers retain these across their verified full-byte observations. */
export interface LegalFileIdentity {
  readonly path: string; readonly realPath: string;
  readonly dev: bigint; readonly ino: bigint; readonly size: bigint;
  readonly ctimeNs: bigint; readonly mtimeNs: bigint;
  readonly mode: bigint; readonly nlink: bigint;
}
/** Canonical-parent + explicit requested-leaf executable resolution. Delegates
 * to the single shared CJS primitive so this resolver and the AFS selector can
 * never drift; hardlink siblings are never substituted. Leaf-symlink targets
 * must remain in the canonical parent directory. */
export function resolveExecutableIdentityPath(filename: string): string {
  return sharedExecutablePath.resolveExecutableIdentityPath(filename);
}
/** True only when `candidate` is the executable selected by the fixed
 * `requested` path (identical leaf or its bounded leaf-symlink target). */
export function executableIdentityMatches(requested: string, candidate: string): boolean {
  return sharedExecutablePath.executableIdentityMatches(requested, candidate);
}
/** Canonical-parent + requested-leaf path and its ONE validating lstat.
 *
 * The leaf name is NEVER resolved through the host realpath: a hardlink sibling
 * of the same inode is not a different path, and some runtimes return such a
 * sibling for `realpathSync`. Only the parent directory is canonicalised, by the
 * single shared resolver, so the retained path is a pure function of the
 * requested path. The requested path itself is inspected with the same `lstat`
 * whose fields become the identity, so regularity is fail-closed at the exact
 * stat that is issued: a leaf symlink, a directory, a device or a replaced file
 * is refused before any identity exists, with no second unguarded read.
 */
function canonicalOriginal(filename: string): {realPath: string, stat: import('node:fs').BigIntStats} {
  const absolute = path.resolve(filename);
  const realPath = sharedExecutablePath.resolveExecutableIdentityPath(absolute);
  const stat = lstatSync(absolute, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Legal original custody: regular original file required');
  return {realPath, stat};
}
export function captureLegalFileIdentity(filename: string): LegalFileIdentity {
  const {realPath, stat} = canonicalOriginal(filename);
  return Object.freeze({ path: filename, realPath, dev: stat.dev, ino: stat.ino, size: stat.size,
    ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, mode: stat.mode, nlink: stat.nlink });
}
export function assertLegalFileIdentity(expected: LegalFileIdentity): void {
  const actual = captureLegalFileIdentity(expected.path);
  for (const key of ['realPath', 'dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'nlink'] as const) {
    if (actual[key] !== expected[key]) throw Error('Legal original custody changed: ' + expected.path + ' (' + key + ')');
  }
}
