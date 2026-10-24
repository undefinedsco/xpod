import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * never drift; hardlink siblings are never substituted and intermediate
 * directory symlinks are refused. */
export function resolveExecutableIdentityPath(filename: string): string {
  return sharedExecutablePath.resolveExecutableIdentityPath(filename);
}
/** True only when `candidate` is the executable selected by the fixed
 * `requested` path (identical leaf or its bounded leaf-symlink target). */
export function executableIdentityMatches(requested: string, candidate: string): boolean {
  return sharedExecutablePath.executableIdentityMatches(requested, candidate);
}
export function captureLegalFileIdentity(filename: string): LegalFileIdentity {
  const realPath = realpathSync(filename), stat = lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Legal original custody: regular original file required');
  return Object.freeze({ path: filename, realPath, dev: stat.dev, ino: stat.ino, size: stat.size,
    ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, mode: stat.mode, nlink: stat.nlink });
}
export function assertLegalFileIdentity(expected: LegalFileIdentity): void {
  const actual = captureLegalFileIdentity(expected.path);
  for (const key of ['realPath', 'dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'nlink'] as const) {
    if (actual[key] !== expected[key]) throw Error('Legal original custody changed: ' + expected.path + ' (' + key + ')');
  }
}
