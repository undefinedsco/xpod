'use strict';

/**
 * Stage the installed dependency closure of the canonical public runtime
 * packages while preserving Node's package-relative resolution.
 *
 * The installed tree is a real Node scope tree: the SAME package name may be
 * installed at different versions for different parents (for example one
 * version hoisted for the service and an older one nested under a transitive
 * dependency). Flattening the whole closure into a single
 * `stageRoot/node_modules/<name>` slot would either overwrite one copy or
 * wrongly require the versions to match. Neither is correct: each parent's
 * `require(name)` must keep resolving to the copy it actually resolved to at
 * install time.
 *
 * So the closure is walked with Node's own resolution (never a second global
 * map that overwrites objects). A dependency is placed where the installed tree
 * actually keeps it: the hoisted root slot when that is the copy Node resolves,
 * otherwise that parent's own nested `node_modules`. An ancestor copy of the
 * same installed object is reused instead of duplicated, which also terminates
 * cyclic dependency graphs without an arbitrary cap.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');

/**
 * Resolve an installed dependency to a physical package directory.
 *
 * This walks ancestor `node_modules` directories from the requesting package and
 * returns the FIRST one that actually contains the package. That is precisely
 * Node's installed-tree contract (nearest physical copy wins), so the same answer
 * is produced on every host.
 *
 * It is implemented directly rather than via `createRequire().resolve.paths()`
 * because Bun returns an empty path list for some real installed packages
 * (measured: `node-fetch`, `undici`), which made the Bun-run production builder
 * report "Installed runtime dependency is missing" for packages that are both
 * installed and loadable. The lookup is deliberately physical and scoped: it
 * never hoists, never merges content, and never guesses among ambiguous nested
 * copies - it only reports the copy the requester would really load.
 */
function resolveInstalledDependency(parentDir, name) {
  let directory = parentDir;
  for (;;) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'));
    const manifestPath = path.join(candidate, 'package.json');
    if (fs.existsSync(manifestPath)) {
      return { directory: candidate, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Identity of an installed object: its real path plus manifest identity. Two
 * distinct installed copies are never interchangeable, even at equal versions,
 * because their remaining payload can differ.
 */
function installedIdentity(realDirectory, manifest) {
  return `${realDirectory}\n${manifest.name}\n${manifest.version}`;
}

/** `stageRoot/node_modules/<name>` for a hoisted package. */
function rootSlot(stageRoot, name) {
  return path.join(stageRoot, 'node_modules', ...name.split('/'));
}

/**
 * Copy one installed package, asking `shouldCopy(packageRoot, sourcePath)` about
 * every entry. The callback is package-root relative (it reads that package's
 * manifest), so the root is carried through the recursion rather than inferred
 * from whichever subdirectory is being walked.
 */
function copyInstalledPackage(packageRoot, sourceDirectory, destination, shouldCopy) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    if (!shouldCopy(packageRoot, sourcePath)) continue;
    const target = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyInstalledPackage(packageRoot, sourcePath, target, shouldCopy);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sourcePath, target);
    }
  }
}

/**
 * A declaration-only package exists purely for TypeScript: it declares `types`
 * and exposes no runtime entry at all. Node can never load it, so copying tens
 * of megabytes of `.d.ts` into the runtime payload (and into the single-binary
 * manifest) is pure waste; the runtime keeps working from the real JS packages.
 * This is a general check, not a special case for one package name.
 */
function isDeclarationOnlyPackage(manifest) {
  const hasTypes = typeof manifest.types === 'string' || typeof manifest.typings === 'string';
  // An empty string is how DefinitelyTyped declares "no entry point", so only a
  // non-empty value counts as a loadable runtime entry.
  const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
  const hasRuntimeEntry = nonEmpty(manifest.main) || nonEmpty(manifest.module)
    || manifest.exports !== undefined
    || (manifest.bin !== undefined && typeof manifest.bin === 'object' && Object.keys(manifest.bin).length > 0)
    || nonEmpty(manifest.bin);
  return hasTypes && !hasRuntimeEntry;
}
/**
 * @param {object} options
 * @param {string} options.stageRoot Stage root (`.../package`).
 * @param {string} options.repoRoot Repository root; its `node_modules` is the hoist root.
 * @param {string} options.rootPackageJson Parsed root manifest.
 * @param {string[]} options.canonicalPackages Names ALREADY staged at the root slot.
 * @param {(packageName: string) => string} options.resolvePackageDir Installed
 *   directory for an already-staged canonical package name.
 * @param {(sourceRoot: string, sourcePath: string) => boolean} options.shouldCopy
 * @param {(packageName: string) => boolean} [options.isExternallyKept] Staged but
 *   never expanded through the closure (kept for external/ESM loading).
 * @returns {{ stagedNames: Set<string> }}
 */
function stageInstalledDependencyClosure(options) {
  const {
    stageRoot, repoRoot, rootPackageJson, canonicalPackages,
    resolvePackageDir, shouldCopy, isExternallyKept = () => false,
  } = options;
  const hoistRoot = fs.realpathSync(path.join(repoRoot, 'node_modules'));

  /** stage destination -> installed identity occupying it. */
  const occupied = new Map();
  const stagedNames = new Set();
  /**
   * Names occupying the HOIST slot. Only these are public specifiers resolved
   * from the stage root; a nested copy is reachable only through its own parent
   * and must not be advertised as a root-resolvable package.
   */
  const rootNames = new Set();

  // Seed the already-staged canonical roots so the closure reuses them instead
  // of copying a second object over the reviewed payload.
  const queue = [];
  for (const name of canonicalPackages) {
    const directory = resolvePackageDir(name);
    const manifestPath = path.join(directory, 'package.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Canonical runtime package is missing: ${name}`);
    const realDirectory = fs.realpathSync(directory);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    occupied.set(rootSlot(stageRoot, name), installedIdentity(realDirectory, manifest));
    stagedNames.add(name);
    rootNames.add(name);
    queue.push({ name, directory: realDirectory, ownerSlot: stageRoot });
  }

  // Pair identity (installed object + destination) already expanded; re-entering
  // an ancestor object terminates cyclic graphs without an arbitrary depth cap.
  const expanded = new Set();

  while (queue.length) {
    const { name, directory, ownerSlot } = queue.shift();
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const identity = installedIdentity(fs.realpathSync(directory), manifest);

    const destination = path.join(ownerSlot, 'node_modules', ...name.split('/'));
    const pair = `${identity}\n${destination}`;
    if (expanded.has(pair)) continue;
    expanded.add(pair);

    const occupant = occupied.get(destination);
    if (occupant !== undefined && occupant !== identity) {
      throw new Error(`Conflicting staged runtime dependency: ${name}`);
    }
    if (occupant === undefined) occupied.set(destination, identity);

    const dependencyNames = new Set(Object.keys(manifest.dependencies || {}));
    for (const peer of Object.keys(manifest.peerDependencies || {})) {
      // Only peers the root manifest explicitly selects join the closure;
      // unselected optional adapters stay absent.
      if (rootPackageJson.dependencies?.[peer] || rootPackageJson.optionalDependencies?.[peer]) dependencyNames.add(peer);
    }

    for (const dependencyName of dependencyNames) {
      // Node builtins are provided by the runtime itself. Node's resolver
      // short-circuits them (`resolve.paths` returns nothing), and a package may
      // still list one such as `buffer` for browser compatibility, so this is
      // normal resolution semantics rather than a missing dependency.
      if (isBuiltin(dependencyName)) continue;
      const resolved = resolveInstalledDependency(directory, dependencyName);
      if (!resolved) {
        throw new Error(`Installed runtime dependency is missing: ${manifest.name} -> ${dependencyName}`);
      }
      const resolvedReal = fs.realpathSync(resolved.directory);
      const identityOfDependency = installedIdentity(resolvedReal, resolved.manifest);
      // Reuse an ancestor copy ONLY when it is the SAME installed object (same
      // real path + manifest). Payload equality is deliberately NOT sufficient:
      // two byte-identical copies can still resolve different transitive/peer
      // dependency contexts, so merging them would change what a parent loads.
      // Preserving Node's physical install scope means each distinct installed
      // object is staged where Node would actually find it. Walking ancestors
      // also terminates cyclic graphs without an arbitrary depth cap.
      let reused = false;
      for (let cursor = destination; ; cursor = path.dirname(cursor)) {
        const candidate = path.join(cursor, 'node_modules', ...dependencyName.split('/'));
        if (occupied.get(candidate) === identityOfDependency) {
          reused = true;
          break;
        }
        if (cursor === stageRoot) break;
        const parent = path.dirname(cursor);
        if (parent === cursor || !cursor.startsWith(stageRoot)) break;
      }
      if (reused) continue;

      // Mirror the installed layout exactly, so each parent keeps resolving the
      // copy it actually resolved at install time: a copy installed at the hoist
      // root belongs in the stage hoist slot; a copy nested under a parent stays
      // nested under that parent. Hoisting a nested copy would steal the slot from
      // the genuinely hoisted one and silently change what other parents load.
      // The hoist test uses the resolver-provided package directory (scoped names
      // live two levels deep), never the package's own basename.
      const hoisted = path.dirname(path.dirname(resolved.directory)) === hoistRoot
        || path.dirname(resolved.directory) === hoistRoot;
      const dependencyOwner = hoisted ? stageRoot : destination;
      const target = path.join(dependencyOwner, 'node_modules', ...dependencyName.split('/'));
      const existing = occupied.get(target);
      if (existing !== undefined) {
        if (existing !== identityOfDependency) {
          throw new Error(`Conflicting staged runtime dependency: ${dependencyName} (owner=${path.relative(stageRoot, dependencyOwner) || '.'} parent=${manifest.name} version=${manifest.version})`);
        }
        continue;
      }
      occupied.set(target, identityOfDependency);
      // Declaration-only packages exist purely for TypeScript and expose no
      // runtime entry, so they are neither copied, traversed, nor advertised as
      // public specifiers. This is decided by the package's own contract, never
      // used to merge packages that DO have runtime payload.
      if (isDeclarationOnlyPackage(resolved.manifest)) {
        continue;
      }
      copyInstalledPackage(resolvedReal, resolvedReal, target, shouldCopy);
      stagedNames.add(dependencyName);
      // Only packages sitting in the hoist slot are root-resolvable specifiers.
      if (dependencyOwner === stageRoot) rootNames.add(dependencyName);
      if (!isExternallyKept(dependencyName)) {
        queue.push({ name: dependencyName, directory: resolvedReal, ownerSlot: dependencyOwner });
      }
    }
  }

  return { stagedNames, rootNames };
}

module.exports = {
  stageInstalledDependencyClosure,
  resolveInstalledDependency,
  installedIdentity,
  rootSlot,
};
