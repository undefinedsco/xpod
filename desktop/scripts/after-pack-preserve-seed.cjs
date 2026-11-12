/**
 * Preserve the packaged capability SEED through electron-builder's pack.
 *
 * builder-util's directory walker unconditionally skips `.DS_Store` and `.gitkeep`
 * BEFORE any include/exclude filter, so a capability manifest can declare members
 * the packed `Resources/runtime/modules` lacks.
 *
 * builder-util MAY publish copied entries as HARD LINKS on CI
 * (`builder-util/out/fs.js`:_isUseHardLink uses is-ci; on some hosts it does not
 * happen). When it does, re-copying onto such a destination fails with
 * `ERR_FS_CP_EINVAL "src and dest cannot be the same"`, because the destination is
 * the same dev+inode under a different path.
 *
 * STRATEGY: copy the complete seed into a fresh, exclusively-created staging
 * directory inside the RESOURCES root, then replace the packed `modules` subtree
 * once that copy fully succeeded. The destination path does not exist beforehand,
 * so no entry there can share an inode with the source. This runs in `afterPack`,
 * before signing: any failure throws, no half-corrected bundle is signed.
 */

const { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } = require('node:fs')
const path = require('node:path')

/** Where this build staged the runtime (authoritative: packager.projectDir). */
function stagedRuntime(projectDir) {
  return path.join(projectDir, 'runtime')
}

/**
 * Resolve `candidate` to a real path even when its tail does not exist yet.
 *
 * The longest existing prefix is resolved with realpathSync and the remaining
 * literal components are appended back, so an absent tail no longer collapses the
 * result to an ancestor. A dangling symlink is reported, never silently treated as
 * a plain missing path, and unexpected resolution errors fail closed.
 */
function resolvedWithTail(candidate) {
  const absolute = path.resolve(candidate)
  const tail = []
  let current = absolute
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    }
    // A dangling link must not be mistaken for an ordinary missing component.
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      stat = undefined
    }
    if (stat && stat.isSymbolicLink()) throw new Error('[xpod-desktop] dangling symlink in seed path')
    const parent = path.dirname(current)
    if (parent === current) return absolute
    tail.push(path.basename(current))
    current = parent
  }
}

/** True when `child` is `parent` or lives beneath it, using resolved paths. */
function isWithin(parent, child) {
  const base = resolvedWithTail(parent)
  const target = resolvedWithTail(child)
  return target === base || target.startsWith(base + path.sep)
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

  if (!lstatSync(resources).isDirectory() || !isWithin(context.appOutDir, resources)) {
    throw new Error('[xpod-desktop] resources must be a directory inside the app output')
  }

  // The RESOURCES root is the ownership boundary: staging and the final target must
  // both live inside it, so a symlinked Resources/runtime pointing at an external
  // directory can never receive our writes or lose its own modules subtree.
  if (!isWithin(resources, target)) {
    throw new Error('[xpod-desktop] seed target resolves outside the owned resources root')
  }

  // Refuse every alias relationship with the staged source, in both directions.
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error('[xpod-desktop] seed source and target overlap')
  }

  mkdirSync(path.dirname(target), { recursive: true })
  if (!isWithin(resources, path.dirname(target))) {
    throw new Error('[xpod-desktop] seed target parent resolves outside the owned resources root')
  }
  if (isWithin(source, path.dirname(target))) {
    throw new Error('[xpod-desktop] seed destination parent resolves inside the staged source')
  }

  // Exclusive creation: mkdtempSync either returns a directory only we own, or
  // fails. Nothing is cleaned unless creation actually succeeded.
  const staging = mkdtempSync(path.join(path.dirname(target), '.modules-restore-'))
  try {
    const building = path.join(staging, 'modules')
    // verbatimSymlinks keeps a RELATIVE link's literal target instead of rewriting
    // it to an absolute path, so the packed tree keeps the seed's own link text.
    cpSync(source, building, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      errorOnExist: true,
      verbatimSymlinks: true,
    })
    if (!existsSync(building) || !lstatSync(building).isDirectory()) {
      throw new Error('[xpod-desktop] seed staging produced no modules directory')
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(building, target)
  } finally {
    // Only the directory mkdtempSync created for this run is removed.
    rmSync(staging, { recursive: true, force: true })
  }

  console.log(`[xpod-desktop] preserved capability seed -> ${target}`)
}

module.exports = afterPackPreserveSeed
module.exports.default = afterPackPreserveSeed
