#!/usr/bin/env node
/**
 * Patch @comunica/actor-http-fetch so its undici import reaches the INSTALLED package
 * instead of Bun's builtin `undici` shim.
 *
 * Bun 1.4.2 resolves a bare `require('undici')` to its own builtin shim, which exposes
 * `fetch` but NOT `cacheStores`. The actor's FetchInitPreprocessor needs
 * `require('undici').cacheStores.MemoryCacheStore`, so on Bun it throws
 * "undefined is not an object (evaluating 'new cacheStores.MemoryCacheStore')".
 * Requiring the package's explicit entry (`undici/index.js`) reaches the real installed
 * package and provides the class. Node is unaffected: with no builtin shadowing,
 * `undici/index.js` resolves to the same module as the bare name.
 */

const fs = require('fs');
const path = require('path');

const ACTOR = path.join('@comunica', 'actor-http-fetch');
const TARGET = path.join('lib', 'FetchInitPreprocessor.js');
// The two bare-name forms this module uses. `require("undici")` passes the module object
// to `.Agent()`/`.interceptors`; `require('undici').cacheStores` reads the cache classes.
const BARE = /require\((['"])undici\1\)/g;
const EXPLICIT = "require($1undici/index.js$1)";

function findActorPackages(nodeModulesPath) {
  const results = [];
  const queue = [nodeModulesPath];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.cache' || entry.name === '.vite') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.name === '@comunica' || entry.name === 'node_modules') {
        queue.push(entryPath);
        continue;
      }
      if (entry.name === 'actor-http-fetch' && path.basename(path.dirname(entryPath)) === '@comunica') {
        const target = path.join(entryPath, TARGET);
        if (fs.existsSync(target)) results.push(target);
        continue;
      }
      queue.push(entryPath);
    }
  }
  return results;
}

function patchSource(content) {
  return content.replace(BARE, EXPLICIT);
}

function patchInstalledPackage(repositoryRoot = path.join(__dirname, '..')) {
  const nodeModulesPath = path.join(repositoryRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) throw new Error('node_modules not found');
  let patched = 0;
  let alreadyPatched = 0;

  for (const target of findActorPackages(nodeModulesPath)) {
    const original = fs.readFileSync(target, 'utf8');
    const updated = patchSource(original);
    if (updated === original) {
      alreadyPatched++;
      continue;
    }
    fs.writeFileSync(target, updated);
    patched++;
  }

  console.log(`[patch-comunica-undici-entry] Patched ${patched} actor(s); ${alreadyPatched} already patched`);
  return { patched, alreadyPatched };
}

/** True when this file still contains a bare `undici` specifier (i.e. unpatched). */
function hasBareUndiciSpecifier(content) {
  return /require\((['"])undici\1\)/.test(content);
}

/** Read-only inspection of one repository root.
 * Returns every discovered actor file with its state; never writes anything.
 * `bareUndici` actors are missing the patch, `explicitEntryOnly` actors are valid,
 * and actors with no undici usage at all are valid by definition. */
function inspectInstalledPackage(repositoryRoot = path.join(__dirname, '..'), actorDirectories) {
  const nodeModulesPath = path.join(repositoryRoot, 'node_modules');
  if (!actorDirectories && !fs.existsSync(nodeModulesPath)) throw new Error('node_modules not found');
  const targets = actorDirectories
    ? actorDirectories.map(directory => path.join(directory, TARGET)).filter(target => fs.existsSync(target))
    : findActorPackages(nodeModulesPath);
  return targets.map(target => {
    const content = fs.readFileSync(target, 'utf8');
    const bare = hasBareUndiciSpecifier(content);
    return {
      path: target,
      usesUndici: /undici/.test(content),
      bareUndici: bare,
      explicitEntry: /require\((['"])undici\/index\.js\1\)/.test(content),
      valid: !bare,
    };
  });
}

module.exports = { patchSource, patchInstalledPackage, hasBareUndiciSpecifier, inspectInstalledPackage };
if (require.main === module) {
  try {
    if (!fs.existsSync(path.join(__dirname, '..', 'node_modules'))) {
      console.log('[patch-comunica-undici-entry] node_modules not found, skipping');
    } else {
      patchInstalledPackage();
    }
  } catch (err) {
    console.error('[patch-comunica-undici-entry] Failed:', err.message);
    process.exit(1);
  }
}
