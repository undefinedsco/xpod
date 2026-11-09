'use strict';
// One shared executable-path identity primitive for TS and CJS callers.
//
// Bun 1.4.2 `realpathSync` can return a sibling hardlink basename for the same
// inode (macOS multicall: /usr/bin/python3 and /usr/bin/git share dev/ino).
// A hardlink is NOT evidence of command identity, so this module NEVER calls
// realpath on the leaf: it canonicalizes the parent directory only and keeps
// the requested leaf. A genuine leaf symlink (Linux /usr/bin/python3 ->
// python3.11) is resolved explicitly, bounded, and must stay inside the
// canonical parent's real directory (intermediate directory links rejected).
const fs = require('node:fs');
const path = require('node:path');
const MAXIMUM_LEAF_LINKS = 40;

function canonicalParent(filename) {
  if (typeof filename !== 'string' || !filename || !path.isAbsolute(filename)) throw new Error('Legal executable custody: absolute executable path required');
  return fs.realpathSync(path.dirname(filename));
}
function canonicalLeaf(filename) {
  const leaf = path.basename(filename);
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('Legal executable custody: canonical leaf required');
  return leaf;
}
function inside(parent, candidate) {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}
/** Canonical-parent + explicit requested-leaf resolution. Returns a path whose
 * leaf name is either the requested non-symlink leaf or the final target of a
 * bounded leaf-symlink chain; intermediate directory links are refused. */
function resolveExecutableIdentityPath(filename) {
  const parent = canonicalParent(filename);
  let candidate = path.join(parent, canonicalLeaf(filename));
  for (let depth = 0; depth < MAXIMUM_LEAF_LINKS; depth++) {
    const value = fs.lstatSync(candidate);
    if (!value.isSymbolicLink()) {
      if (!value.isFile()) throw new Error('Legal executable custody: regular executable required');
      // The candidate's own directory must really be the canonical parent;
      // otherwise an intermediate directory link escaped the parent.
      if (fs.realpathSync(path.dirname(candidate)) !== parent) throw new Error('Legal executable custody: contained executable directory required');
      return candidate;
    }
    const target = fs.readlinkSync(candidate);
    if (!target || target.includes('\0')) throw new Error('Legal executable custody: canonical leaf link required');
    const next = path.resolve(path.dirname(candidate), target);
    if (!inside(parent, next) || next === parent) throw new Error('Legal executable custody: contained leaf link required');
    candidate = next;
  }
  throw new Error('Legal executable custody: leaf link depth bound exceeded');
}
/** True only when `candidate` is the executable selected by the fixed
 * `requested` path: same canonical parent and either the identical leaf or the
 * explicit bounded leaf-symlink target of `requested`. Never compares inodes. */
function executableIdentityMatches(requested, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  let parent, resolved;
  try { parent = canonicalParent(requested); } catch { return false; }
  if (fs.realpathSync(path.dirname(candidate)) !== parent) return false;
  if (path.basename(candidate) === path.basename(requested)) {
    try { return resolveExecutableIdentityPath(candidate) === candidate; } catch { return false; }
  }
  try { resolved = resolveExecutableIdentityPath(requested); } catch { return false; }
  return canonicalParent(resolved) === parent && resolved === path.join(parent, path.basename(candidate))
    && (() => { try { return resolveExecutableIdentityPath(candidate) === candidate; } catch { return false; } })();
}
module.exports = {resolveExecutableIdentityPath, executableIdentityMatches, MAXIMUM_LEAF_LINKS};
