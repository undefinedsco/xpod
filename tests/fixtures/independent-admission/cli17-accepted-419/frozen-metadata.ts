/**
 * Immutable accepted-source metadata and historical originals for HISTORICAL /
 * SYNTHETIC contract tests.
 *
 * The CLI17 catalogue (and the sibling policies) freeze their tuples at the
 * accepted 0.4.31 staging bytes. Three version-bearing manifests plus the exact
 * historical TEST-FILE originals captured here are the only paths whose live
 * checkout bytes legitimately differ from those frozen rows, because an ordinary
 * version bump changes the manifests and later commits edit the tests.
 *
 * The capture directory is named for the COMMIT PREFIX it came from
 * (`419...`, the RC425 candidate at 0.4.31-rc.425). See PROVENANCE.md.
 *
 * SCOPE - deliberately narrow:
 *  - only paths captured in this directory are redirected;
 *  - every other path is read from the real checkout unchanged;
 *  - these bytes grant NO current-source qualification. Production admission
 *    still reads real current bytes and its own frozen catalogue, so an
 *    unreviewed CURRENT source is still refused.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The capture directory, derived from this module's own URL so it does not
 * depend on the process CWD. `fileURLToPath` decodes percent-escapes and handles
 * the Windows drive letter, so a checkout path containing a space or '#' works.
 */
const FROZEN_DIR = path.dirname(fileURLToPath(import.meta.url))
/**
 * Repository root derived from the capture location, never from the CWD:
 * <repo>/tests/fixtures/independent-admission/cli17-accepted-419 -> <repo>.
 */
const REPO_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(FROZEN_DIR))))

/** Three version-bearing manifests whose live bytes move on every version bump. */
const FROZEN_MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'bun.lock',
  'desktop/package.json',
])

/**
 * Historical TEST-FILE originals, keyed by their repo-relative path.
 *
 * These are whole-file captures because a frozen catalogue row pins the test's
 * OWN bytes. Without them, editing such a test to use this reader would break the
 * very assertion it needs to keep: the catalogue must still see the historical
 * bytes, while the live file is edited. Captured from `419...`; every entry is
 * verified against the declared row in the catalogue (see PROVENANCE.md).
 */
const FROZEN_TEST_ORIGINALS: ReadonlyMap<string, string> = new Map([
  ['tests/scripts/candidate-producer-attempt-binding.test.ts',
    'candidate-producer-attempt-binding.test.ts.original.txt'],
  ['tests/scripts/controller-helper-admission.test.ts',
    'controller-helper-admission.test.ts.original.txt'],
  ['tests/scripts/candidate-producer-attempt.tiny.test.ts',
    'candidate-producer-attempt.tiny.test.ts.original.txt'],
])

/** A filesystem target -> its captured original, only within this repository. */
function capturedFileFor(target: string | URL): string | undefined {
  // Relative targets retain filesystem CWD semantics. Ownership is compared with
  // the fixed repository root, so a temporary root's manifest is never frozen.
  const absolute = typeof target === 'string'
    ? path.resolve(target)
    : fileURLToPath(target)
  const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
  const original = FROZEN_TEST_ORIGINALS.get(relative)
  if (original) return path.join(FROZEN_DIR, original)
  if (FROZEN_MANIFESTS.has(relative)) return path.join(FROZEN_DIR, relative)
  return undefined
}

/** Text read of a captured original, matching `readFileSync(p, 'utf8')`. */
export function readTrackedSource(target: string | URL, encoding: 'utf8'): string
/** Binary read, matching `readFileSync(p)`. */
export function readTrackedSource(target: string | URL): Buffer
export function readTrackedSource(target: string | URL, encoding?: 'utf8'): string | Buffer {
  const captured = capturedFileFor(target)
  if (captured === undefined) {
    // Uncaptered paths keep the CALLER's own target, so per-test temp roots and
    // URL-relative fixtures behave exactly as before.
    return encoding ? readFileSync(target, encoding) : readFileSync(target)
  }
  return encoding ? readFileSync(captured, encoding) : readFileSync(captured)
}

/** sha256 of the same resolution, for catalogue-row comparisons. */
export function shaTrackedSource(target: string | URL): string {
  return createHash('sha256').update(readTrackedSource(target)).digest('hex')
}

/** Read `name` from `repoRoot`, except captured paths. */
export function readFrozenTracked(repoRoot: string, name: string): Buffer {
  const captured = capturedFileFor(path.join(repoRoot, name))
  if (captured !== undefined) return readFileSync(captured)
  return readFileSync(path.join(repoRoot, name))
}

/** sha256 of the same resolution. */
export function shaFrozenTracked(repoRoot: string, name: string): string {
  return createHash('sha256').update(readFrozenTracked(repoRoot, name)).digest('hex')
}
