/**
 * Shared HERMETIC fixture root for the reviewed phase planner.
 *
 * `reviewedModulePhasePlan` hash-checks its OWN source through its own module URL
 * and reads the controlled tuple from that same root, so `repositoryRoot` alone
 * cannot inject anything: pointing the planner at historical bytes requires those
 * bytes to LIVE in the fixture root. This factory materialises only TRACKED public
 * inputs, then the caller dynamically imports the COPIED module so its
 * `import.meta.url` resolves inside the fixture.
 *
 * Used by both the Bun historical suites and the Vitest controlled-plan suite, so
 * the copy list exists ONCE. Nothing here is a global mock or preload, no live file
 * is overwritten, and no product/policy/catalogue source is modified.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { API_SERVICE_BUILD_SOURCE_BINDINGS } from '../../../../scripts/lib/independent-admission/github-origin'
import type * as ModuleSourcePhases from '../../../../scripts/lib/independent-admission/module-source-phases'
import { readTrackedSource } from './frozen-metadata'

/** Repository root derived from THIS module's URL, never from the CWD.
 * <repo>/tests/fixtures/independent-admission/cli17-accepted-419 -> <repo>. */
const REPO_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))))

/**
 * Non-`scripts/` modules the copied planner's STATIC import closure reaches.
 * Enumerated (17 files), not a whole-repo copy.
 */
const STATIC_DEPENDENCIES = [
  'packages/xpod-api/scripts/bun-build-api.ts',
  'packages/xpod-api/scripts/bundle-products.ts',
  'packages/xpod-api/scripts/bundle-runtime.ts',
  'packages/xpod-api/scripts/bundle-stage.ts',
  'packages/xpod-api/scripts/closure.ts',
  'packages/xpod-api/scripts/inngest-controlled-build-policy.json',
  'packages/xpod-api/scripts/inngest-controlled-materials-contract.json',
  'packages/xpod-api/scripts/inngest-input-pins.json',
  'packages/xpod-api/scripts/node-builtins.ts',
  'packages/xpod-api/scripts/sourcekit-producer.ts',
  'packages/xpod-api/scripts/sourcekit.ts',
  'packages/xpod-api/scripts/static-material.ts',
  'packages/xpod-cli/scripts/canonical-host-sources.json',
  'packages/xpod-cli/src/launcher.ts',
  'packages/xpod-cli/src/manifest.ts',
  'packages/xpod-cli/src/module-catalog.ts',
  'packages/xpod-cli/src/source-materials.ts',
]

export interface PhasePlanFixture {
  /** Absolute fixture root the copied planner treats as its own repository root. */
  root: string
  /** The COPIED, unchanged planner module; its own URL resolves inside `root`. */
  planner: typeof ModuleSourcePhases
  /** Removes the fixture tree; safe to call more than once. */
  cleanup: () => void
}

/**
 * Materialise the fixture and import the copied planner.
 *
 * `repoRoot` must be the verified repository root (callers derive it from their
 * own module location, not the CWD). Only tracked public inputs are copied, and the
 * temp tree is always removed if copying or importing fails.
 */
export async function createPhasePlanFixture(repoRoot: string = REPO_ROOT): Promise<PhasePlanFixture> {
  mkdirSync(path.join(repoRoot, '.test-data'), { recursive: true })
  const root = mkdtempSync(path.join(repoRoot, '.test-data/phase-plan-fixture-'))
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    rmSync(root, { recursive: true, force: true })
  }
  const copy = (name: string, bytes?: Buffer): void => {
    const target = path.join(root, name)
    mkdirSync(path.dirname(target), { recursive: true })
    if (bytes) writeFileSync(target, bytes)
    else copyFileSync(path.join(repoRoot, name), target)
  }
  try {
    // 1) tracked `scripts/` closure, copied BY BYTES so the planner's own module URL
    //    resolves inside the fixture instead of back to the live tree.
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'scripts'],
      { cwd: repoRoot, encoding: 'buffer' }).toString('utf8').split('\0').filter(Boolean)
    for (const name of tracked) copy(name)
    // 2) the enumerated non-`scripts/` static dependencies.
    for (const name of STATIC_DEPENDENCIES) copy(name)
    // 3) the declared API build inputs, read through the captured-metadata reader so
    //    frozen rows see the accepted bytes rather than the moved live versions.
    for (const row of API_SERVICE_BUILD_SOURCE_BINDINGS) copy(row.path, readTrackedSource(row.path))
    const planner = await import(
      pathToFileURL(path.join(root, 'scripts/lib/independent-admission/module-source-phases.ts')).href
    ) as typeof ModuleSourcePhases
    return { root, planner, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
