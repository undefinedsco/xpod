#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORM_PACKAGE_PREFIX } = require('./platform-binaries.cjs');

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const backupPath = path.join(repoRoot, '.test-data', 'package.json.pack.backup');

// One declaration resolver for source-owned catalogs and Node distribution.
// This is a pure transformation; callers still bind the original source bytes.
function resolveCatalogManifest(pkg, root = pkg) {
  const result = { ...pkg };
  const dictionary = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const workspaces = root.workspaces && !Array.isArray(root.workspaces) ? root.workspaces : {};
  if (root.catalog && workspaces.catalog || root.catalogs && workspaces.catalogs) throw new Error('Ambiguous package catalog authority');
  const unnamed = root.catalog || workspaces.catalog || {};
  const named = root.catalogs || workspaces.catalogs || {};
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    result[field] = { ...pkg[field] };
    for (const [name, range] of Object.entries(pkg[field])) {
      if (typeof range !== 'string') throw new Error('Dependency range must be a string');
      if (!range.startsWith('catalog:')) continue;
      const catalogName = range.slice('catalog:'.length);
      if (!dictionary(named) || !dictionary(unnamed)) throw new Error('Package catalog map must be an object');
      if (catalogName && !Object.prototype.hasOwnProperty.call(named, catalogName)) throw new Error('Unknown own package catalog: ' + catalogName);
      const catalog = catalogName ? named[catalogName] : unnamed;
      if (!dictionary(catalog)) throw new Error('Selected package catalog must be an object');
      const resolved = catalog && Object.prototype.hasOwnProperty.call(catalog, name) ? catalog[name] : undefined;
      if (typeof resolved !== 'string' || !resolved || resolved.startsWith('catalog:')) throw new Error('Exact nonrecursive package catalog declaration required: ' + name);
      result[field][name] = resolved;
    }
  }
  return result;
}

function sanitizeManifest(pkg, options = { includePlatformPackages: process.env.XPOD_INCLUDE_PLATFORM_PACKAGES === 'true' }) {
  if (!options || typeof options.includePlatformPackages !== 'boolean' || Object.keys(options).length !== 1) throw new Error('Exact platform package projection policy required');
  const nextPkg = resolveCatalogManifest(pkg);
  delete nextPkg.catalog;
  delete nextPkg.catalogs;
  if (nextPkg.workspaces && !Array.isArray(nextPkg.workspaces)) {
    nextPkg.workspaces = { ...nextPkg.workspaces };
    delete nextPkg.workspaces.catalog; delete nextPkg.workspaces.catalogs;
  }
  if (nextPkg.scripts) {
    const nextScripts = { ...nextPkg.scripts };
    delete nextScripts.postinstall;
    delete nextScripts.prepack;
    delete nextScripts.postpack;
    nextPkg.scripts = nextScripts;
  }

  // run-npm-pack reconstructs a controlled bundle from the installed patched
  // runtime. Consumers must never need Bun-only patch metadata or repo hooks.
  delete nextPkg.bundleDependencies;
  delete nextPkg.bundledDependencies;
  delete nextPkg.patchedDependencies;

  if (!options.includePlatformPackages && nextPkg.optionalDependencies) {
    const nextOptionalDependencies = { ...nextPkg.optionalDependencies };
    for (const dependencyName of Object.keys(nextOptionalDependencies)) {
      if (dependencyName.startsWith(PLATFORM_PACKAGE_PREFIX)) {
        delete nextOptionalDependencies[dependencyName];
      }
    }

    if (Object.keys(nextOptionalDependencies).length === 0) {
      delete nextPkg.optionalDependencies;
    } else {
      nextPkg.optionalDependencies = nextOptionalDependencies;
    }
  }

  return nextPkg;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'pack' && mode !== 'restore') {
    throw new Error('Usage: node scripts/prepare-package-manifest.cjs <pack|restore>');
  }

  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  if (mode === 'pack') {
    const originalRaw = fs.readFileSync(packageJsonPath, 'utf8');
    fs.writeFileSync(backupPath, originalRaw);
    const pkg = JSON.parse(originalRaw);
    writeJson(packageJsonPath, sanitizeManifest(pkg));
    return;
  }

  if (!fs.existsSync(backupPath)) {
    return;
  }

  const backupRaw = fs.readFileSync(backupPath, 'utf8');
  fs.writeFileSync(packageJsonPath, backupRaw);
  fs.rmSync(backupPath, { force: true });
}

module.exports = { resolveCatalogManifest, sanitizeManifest };

if (require.main === module) try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
