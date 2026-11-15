/**
 * Immutable CLI17 catalog metadata for HISTORICAL / SYNTHETIC contract tests.
 *
 * `scripts/lib/independent-admission/source-rules.ts` (and the sibling policies)
 * freeze the CLI17 tuple at the accepted 0.4.31 source bytes. The authoritative
 * hashes live in that catalogue and in PROVENANCE.md; they are deliberately NOT
 * repeated here, so this helper cannot drift into a second operative list.
 *
 * These THREE version-bearing manifests are the only catalog rows that move on
 * an ordinary version bump, so a test that hashes the live checkout for them
 * stops describing the frozen generation the moment the package version changes.
 * The captured bytes beside this file are the EXACT accepted source bytes
 * (see PROVENANCE.md); they are not published release assets.
 *
 * SCOPE - deliberately narrow:
 *  - only the three version-bearing package manifests are redirected;
 *  - every other path is read from the real checkout, unchanged;
 *  - these bytes grant NO current-source qualification: an unreviewed CURRENT
 *    package version still fails the production trust checks, because the
 *    production code compares against its own frozen catalog, not this fixture.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The frozen capture, addressed relative to this fixture.
 * `fileURLToPath` decodes percent-escapes and handles the Windows drive letter,
 * so a checkout path containing a space, '#' or non-ASCII character resolves.
 */
const FROZEN_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Paths whose live bytes are mutable version metadata, not test subject. */
const FROZEN_PATHS: ReadonlySet<string> = new Set(['package.json', 'bun.lock', 'desktop/package.json'])

/**
 * Read `name` from the repository root, except the three frozen version-metadata
 * paths which resolve to the immutable capture.
 *
 * Callers keep their existing `readFileSync`-based helpers by routing through
 * this function: `readFrozenTracked(repoRoot, name)`.
 */
export function readFrozenTracked(repoRoot: string, name: string): Buffer {
  // `desktop/package.json` keeps its directory so the fixture layout mirrors the repo.
  if (FROZEN_PATHS.has(name)) return readFileSync(path.join(FROZEN_DIR, name))
  return readFileSync(path.join(repoRoot, name))
}

/** sha256 of the same resolution. */
export function shaFrozenTracked(repoRoot: string, name: string): string {
  return createHash('sha256').update(readFrozenTracked(repoRoot, name)).digest('hex')
}
