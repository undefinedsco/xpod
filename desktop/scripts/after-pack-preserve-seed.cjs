/**
 * Preserve the packaged capability SEED bytes through electron-builder's pack.
 *
 * PROBLEM: electron-builder copies `extraResources` with `builder-util`'s
 * directory walker, which unconditionally skips the literal names `.DS_Store`
 * and `.gitkeep` BEFORE any include/exclude filter runs. A capability manifest
 * may legitimately list such a member (upstream packages ship them, and they are
 * not necessarily empty), so the packed `Resources/runtime/modules` can end up
 * missing files its own `package.json` inventory still declares. ModuleStore then
 * fails verification and the packaged gateway never becomes ready.
 *
 * FIX: re-copy the SEED SUBTREE ONLY (`runtime/modules`) from the build's staged
 * runtime to the packed resources with plain Node `fs` copy semantics - no
 * builder-util walker, no name list, no content heuristics. Every dotfile, every
 * empty file, every mode and each `package.json` is reproduced byte-for-byte, so
 * the shipped inventory and the shipped bytes always agree.
 *
 * Runs in `afterPack`, i.e. BEFORE the existing ad-hoc signing in the same hook
 * chain, so the signature seals exactly the corrected bytes.
 */

const { cpSync, existsSync, lstatSync } = require('node:fs')
const path = require('node:path')

/** Where this build staged the runtime (authoritative: packager.projectDir). */
function stagedRuntime(projectDir) {
  // `projectDir` for this package IS the desktop directory, so the staged
  // runtime sits directly beneath it. Deriving from the context (never cwd)
  // keeps the hook correct for every build entry point.
  return path.join(projectDir, 'runtime')
}

/**
 * Standard-recursive copy that does NOT reproduce builder-util's skip list.
 *
 * `dereference: false` keeps symlinks as-is so a link can never be silently
 * turned into a copy; `preserveTimestamps` keeps the packed tree faithful.
 */
function copySeed(source, target) {
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
    errorOnExist: false,
  })
}

async function afterPackPreserveSeed(context) {
  const packager = context && context.packager
  if (!packager || typeof packager.getResourcesDir !== 'function' || !packager.projectDir) {
    throw new Error('[xpod-desktop] afterPack context lacks packager.getResourcesDir/projectDir')
  }
  const source = path.join(stagedRuntime(packager.projectDir), 'modules')
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    // Never manufacture a seed: the pack MUST fail loudly if packaging forgot it.
    throw new Error(`[xpod-desktop] staged capability seed missing: ${source}`)
  }
  const resources = packager.getResourcesDir(context.appOutDir)
  const target = path.join(resources, 'runtime', 'modules')
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error('[xpod-desktop] seed source and target are the same path')
  }
  copySeed(source, target)
  console.log(`[xpod-desktop] preserved capability seed -> ${target}`)
}

module.exports = afterPackPreserveSeed
module.exports.default = afterPackPreserveSeed
module.exports.copySeed = copySeed
