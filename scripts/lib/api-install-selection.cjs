'use strict';
/** Preinstall selection only. Full lock ranges/import/build checks remain postinstall. */
const { createHash } = require('node:crypto');
const { resolveCatalogManifest } = require('../prepare-package-manifest.cjs');
const LIMITS = require('./module-artifact-limits.json');
const PACKAGE_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu;
const packageName = name => typeof name === 'string' && name !== '.' && name !== '..' && PACKAGE_NAME.test(name);
const GROUPS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
const fail = message => { throw Error('API install selection: ' + message); };
const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
const safe = name => typeof name === 'string' && !!name && !name.startsWith('/') && !/[\\\x00-\x1f\x7f]/u.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
const dictionary = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function scopeNames(key) {
  if (!key) return [];
  const names = key.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [];
  if (names.join('/') !== key || names.some(name => !packageName(name))) return fail('invalid lock scope');
  return names;
}
/** Sole exact lock ancestry implementation, shared with the full graph. */
function resolveLock(packages, owner, name) {
  const ancestors = scopeNames(owner);
  for (let count = ancestors.length; count >= 0; count--) {
    const key = [...ancestors.slice(0, count), name].join('/');
    if (own(packages, key)) return key;
  }
  return undefined;
}
function readApiWorkspaceDeclarations({ read, trackedPaths }) {
  const root = JSON.parse(read('package.json').toString());
  // Bun's own JSONC parser is the existing lock authority, not another parser.
  const lock = require('bun').JSONC.parse(read('bun.lock').toString());
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || !dictionary(lock.workspaces) || !dictionary(lock.packages)) return fail('immutable Bun lock v1 required');
  const sorted = value => JSON.stringify(Object.entries(value).sort());
  if (sorted(lock.overrides ?? {}) !== sorted({ ...root.resolutions, ...root.overrides })) return fail('immutable root override/lock drift');
  const declared = root.workspaces?.packages ?? root.workspaces;
  if (!Array.isArray(declared) || declared.some(pattern => !safe(pattern) || pattern.includes('*') && !/^[^*]+\/\*$/u.test(pattern))) return fail('explicit supported workspace patterns required');
  const matches = directory => declared.some(pattern => pattern.endsWith('/*') ? directory.startsWith(pattern.slice(0, -1)) && !directory.slice(pattern.length - 1).includes('/') : directory === pattern);
  for (const path of trackedPaths) if (path.endsWith('/package.json')) {
    const directory = path.slice(0, -13);
    if (matches(directory) && !own(lock.workspaces, directory)) return fail('source workspace absent from lock');
  }
  if (Object.keys(lock.workspaces).length > LIMITS.sourceMaterialFiles) return fail('workspace declaration count bound');
  const workspaces = new Map();
  for (const [directory, binding] of Object.entries(lock.workspaces)) {
    if (directory && (!safe(directory) || !matches(directory))) return fail('lock workspace not declared by source');
    const manifest = directory ? JSON.parse(read(directory + '/package.json').toString()) : root;
    if (!dictionary(binding) || !packageName(manifest.name) || manifest.name !== binding.name || workspaces.has(manifest.name)) return fail('workspace identity differs');
    for (const kind of GROUPS) {
      if (!dictionary(manifest[kind] ?? {}) || !dictionary(binding[kind] ?? {}) || sorted(manifest[kind] ?? {}) !== sorted(binding[kind] ?? {})) return fail('workspace/lock declaration drift');
      for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
        if (!packageName(name)) return fail('canonical dependency package name required');
        if (typeof range !== 'string' || !range) return fail('dependency declaration type');
      }
    }
    workspaces.set(manifest.name, { path: directory, manifest });
  }
  if (workspaces.get(root.name)?.path !== '') return fail('canonical root workspace required');
  const api = workspaces.get('@undefineds.co/xpod-api'), ui = workspaces.get('ui');
  if (api?.path !== 'packages/xpod-api' || ui?.path !== 'ui') return fail('canonical API/static roots required');
  return { root, lock, workspaces, api, ui };
}
function installFilterArguments(workspaces, selectedNames, mode, rootName) {
  const selected = new Set(selectedNames);
  const filters = [...selected].filter(name => mode !== 'api-ui-root-minimal-v2' || name !== rootName).sort().map(name => '--filter=' + name);
  if (mode !== 'conservative-all-v1') for (const name of [...workspaces.keys()].filter(name => !selected.has(name) || mode === 'api-ui-root-minimal-v2' && name === rootName).sort()) filters.push('--filter=!' + name);
  return filters;
}
function selectApiInstallWorkspaces({ root, lock, workspaces, api, ui }) {
  if (!root.catalogs?.['api-producer'] || !api.manifest.devDependencies?.semver) return fail('package-owned API build declarations and catalog required before root-minimal recipe');
  const selected = new Set([root.name]), visited = new Set();
  const workspace = name => {
    const row = workspaces.get(name);
    if (!row) return fail('workspace edge unavailable');
    if (selected.has(name)) return;
    selected.add(name); declarations(name, row.manifest, true);
  };
  const node = key => {
    if (visited.has(key)) return;
    visited.add(key);
    const row = lock.packages[key];
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !dictionary(row[2] ?? {})) return fail('lock node malformed');
    const linked = /^(.+)@workspace:(.*)$/u.exec(row[0]);
    if (linked) {
      if (workspaces.get(linked[1])?.path !== linked[2]) return fail('workspace lock target differs');
      workspace(linked[1]);
    } else declarations(key, row[2] ?? {}, false);
  };
  const declarations = (owner, manifest, includeDev) => {
    for (const kind of GROUPS) {
      if (kind === 'devDependencies' && !includeDev) continue;
      if (!dictionary(manifest[kind] ?? {})) return fail('dependency declaration map');
      // Reuse the source-owned resolver. No catalog/semver/version table here.
      const resolved = resolveCatalogManifest({ [kind]: manifest[kind] ?? {} }, root)[kind] ?? {};
      for (const [name, range] of Object.entries(resolved)) {
        if (!packageName(name)) return fail('canonical dependency package name required');
        if (typeof range !== 'string' || !range) return fail('dependency declaration type');
        if (range.startsWith('workspace:')) { workspace(name); continue; }
        const key = resolveLock(lock.packages, owner, name);
        const optional = kind === 'optionalDependencies' || kind === 'peerDependencies' && (manifest.peerDependenciesMeta?.[name]?.optional === true || manifest.optionalPeers?.includes(name));
        if (key === undefined) { if (!optional) return fail('required lock edge absent: ' + owner + ' -> ' + name); continue; }
        node(key);
      }
    }
  };
  workspace(api.manifest.name); workspace(ui.manifest.name);
  return selected;
}
function deriveApiInstallSelection(input) {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha) || !['linux-arm64', 'linux-x64', 'darwin-arm64', 'darwin-x64'].includes(input.target)) return fail('immutable source/target required');
  if (!Array.isArray(input.trackedPaths) || input.trackedPaths.length > LIMITS.sourceMembers || input.trackedPaths.some(name => !safe(name))) return fail('bounded canonical tracked universe required');
  const originals = new Map(); let sourceBytes = 0;
  const read = name => {
    if (!safe(name)) return fail('unsafe Git path');
    const row = input.readGitObject(name);
    if (!row || !['100644', '100755'].includes(row.mode) || !Buffer.isBuffer(row.bytes) || row.bytes.length > LIMITS.metadataBytes) return fail('ordinary bounded Git original required');
    if (!originals.has(name)) sourceBytes += row.bytes.length;
    if (sourceBytes > LIMITS.sourceBytes) return fail('source declaration aggregate bound');
    originals.set(name, { path: name, bytes: row.bytes.length, sha256: createHash('sha256').update(row.bytes).digest('hex') });
    return row.bytes;
  };
  const declarations = readApiWorkspaceDeclarations({ read, trackedPaths: input.trackedPaths });
  const selected = selectApiInstallWorkspaces(declarations);
  const filters = installFilterArguments(declarations.workspaces, selected, 'api-ui-root-minimal-v2', declarations.root.name);
  return Object.freeze({ schemaVersion: 1, kind: 'api-preinstall-selection-draft', sourceSha: input.sourceSha, target: input.target, workspaceMode: 'api-ui-root-minimal-v2', rootName: declarations.root.name, install: Object.freeze(['bun', 'install', '--frozen-lockfile', ...filters]), workspaces: Object.freeze([...selected].sort().map(name => Object.freeze({ name, path: declarations.workspaces.get(name).path }))), originals: Object.freeze([...originals.values()].sort((a, b) => a.path.localeCompare(b.path))), requiresPostInstallGraphComparison: true, semverAndBuildGraphVerified: false, executable: false, sourceVerified: false });
}
module.exports = { GROUPS, resolveLock, readApiWorkspaceDeclarations, installFilterArguments, selectApiInstallWorkspaces, deriveApiInstallSelection };
