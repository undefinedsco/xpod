#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DRIZZLE_SOLID_PACKAGE = '@undefineds.co/drizzle-solid';
const EXTENSIONS_PACKAGE = '@undefineds.co/extensions';
const WORKSPACE_PACKAGES = [
  '@undefineds.co/ai-connections',
  '@undefineds.co/ai-connections-runtime',
  '@undefineds.co/extension-host-contracts',
  '@undefineds.co/extension-sdk',
  // `ai-connections` and `extension-sdk` depend on this one, so leaving it out
  // leaks their `workspace:*` specifier into the packed manifest - npm cannot
  // resolve that protocol and dies during the registry-consumer check.
  '@undefineds.co/pod-collections',
  '@undefineds.co/shared-ui',
  '@undefineds.co/solid-sdk',
  // Transitional server CLI adapters import the independent client's public API.
  '@undefineds.co/xpod-cli',
  '@undefineds.co/xpod-client',
  // Server workcopy/storage adapters consume the AFS public client boundary.
  // Bundle its JS library; the optional platform helper remains a separate module.
  '@undefineds.co/xpod-afs',
];
// These runtime patches must survive installation without repository postinstall hooks.
const PATCHED_RUNTIME_PACKAGES = [
  '@solid/community-server', 'oidc-provider', '@undefineds.co/models',
  '@inrupt/solid-client-authn-browser', '@inrupt/solid-client-authn-core', 'jose',
  // Keep callers beside their patched dependencies; external hoisting would
  // make them resolve an unpatched registry copy instead.
  '@inrupt/solid-client-authn-node', '@inrupt/oidc-client-ext',
  '@solid/access-token-verifier', 'openid-client',
];
const BUNDLED_LOCAL_PACKAGES = [ DRIZZLE_SOLID_PACKAGE, EXTENSIONS_PACKAGE, ...WORKSPACE_PACKAGES ];

function getNpmInvocation(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: [ '/d', '/s', '/c', 'npm.cmd', ...args ],
    };
  }

  return {
    command: 'npm',
    args,
  };
}

function readPackManifest(file, role, originals) {
  return originals ? originals.readManifest(file, role) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

function serviceWorkspacePackages(repoRoot, originals) {
  const rootManifest = readPackManifest(path.join(repoRoot, 'package.json'), 'workspace-selection-root', originals);
  const requiredPeers = Object.keys(rootManifest.peerDependencies ?? {})
    .filter(name => !rootManifest.peerDependenciesMeta?.[name]?.optional);
  const queue = [...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.optionalDependencies ?? {}), ...requiredPeers]
    .filter(name => name !== '@undefineds.co/xpod-cli');
  const selected = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (!WORKSPACE_PACKAGES.includes(name) || selected.has(name)) continue;
    selected.add(name);
    const manifest = readPackManifest(path.join(repoRoot, 'packages', name.slice('@undefineds.co/'.length), 'package.json'), 'workspace-selection-member', originals);
    queue.push(...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}));
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) queue.push(peer);
    }
  }
  return WORKSPACE_PACKAGES.filter(name => selected.has(name));
}

function getBundledLocalDependencies(repoRoot, profile = 'compat', originals, resolveRoot) {
  resolveRoot ??= (name, optional) => {
    const lexical = path.join(repoRoot, 'node_modules', ...name.split('/'));
    const observed = originals ? originals.probePath(lexical, 'directory') : undefined;
    const exists = observed ? observed.exists : !optional || fs.existsSync(lexical);
    if (!optional && !exists) throw new Error('Required installed package root absent: ' + name);
    const canonical = exists ? (observed ? observed.canonicalPath : fs.realpathSync(lexical)) : undefined;
    if (originals) {
      originals.event({ role: 'actual-bundled-root-probe', name, optional, path: lexical, exists, canonicalPath: canonical ?? null });
      originals.event({ role: 'actual-bundled-root-input-custody', name, observation: observed.observation });
    }
    return canonical;
  };
  const privatePatchedDependencies = [ DRIZZLE_SOLID_PACKAGE, EXTENSIONS_PACKAGE ].flatMap((name) => {
    const sourcePackageRoot = resolveRoot(name, true);
    return sourcePackageRoot ? [{ name, sourcePackageRoot }] : [];
  });

  const workspaceDependencies = (profile === 'service' ? serviceWorkspacePackages(repoRoot, originals) : WORKSPACE_PACKAGES).map((name) => ({
    name,
    sourcePackageRoot: path.join(repoRoot, 'packages', name.slice('@undefineds.co/'.length)),
  }));

  const patchedRuntimeDependencies = PATCHED_RUNTIME_PACKAGES.map((name) => ({
    name,
    sourcePackageRoot: resolveRoot(name, false),
    patchedRuntime: true,
  }));
  return [ ...privatePatchedDependencies, ...workspaceDependencies, ...patchedRuntimeDependencies ].map((entry) => ({ ...entry, repoRoot }));
}

// Pure stage shared by the actual packer and original-bound verification.
// Its caller must supply genuine pack/input originals; JSON alone is not proof.
function removeWorkspaceDependenciesManifest(manifest) {
  const packageJson = JSON.parse(JSON.stringify(manifest));
  for (const field of [ 'dependencies', 'optionalDependencies', 'peerDependencies' ]) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const [ name, version ] of Object.entries(dependencies)) {
      if (BUNDLED_LOCAL_PACKAGES.includes(name) || (typeof version === 'string' && version.startsWith('workspace:'))) {
        delete dependencies[name];
      }
    }
  }
  return packageJson;
}
function removeWorkspaceDependencies(packageRoot, originals) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = removeWorkspaceDependenciesManifest(readPackManifest(packageJsonPath, 'seed-packed-root-manifest', originals));
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

function isCompilerDiagnostic(filePath) {
  return /(?:\.[cm]?[jt]sx?\.map|\.tsbuildinfo)$/.test(filePath);
}

// Trees that exist to author, browse, build for another platform or test a
// package are never runtime payload - except where a package declares them as
// its entry point (`node-fetch` ships `src/index.js`, `jose` maps a browser
// build through its `browser`/`bun` conditions). The declared entries decide.
const NON_RUNTIME_DIRECTORY_NAMES = new Set([
  'browser', 'src', 'test', 'tests', '__tests__', 'spec', 'specs',
  'benchmark', 'benchmarks', 'example', 'examples', 'doc', 'docs', 'coverage',
]);
// Entry conditions that a Node, Bun or TypeScript resolver selects on its own
// when it loads the packed artifact. Custom conditions (`@zod/source`),
// browser-only targets and foreign platform conditions are never selected by
// runtime resolution, so a target listed under one of them must not keep a
// source or browser tree alive - `jose` maps its `bun` condition into
// `dist/node/esm` while its `browser` condition stays droppable.
const PROTECTED_ENTRY_CONDITIONS = new Set([
  'node', 'node-addons', 'bun', 'import', 'require', 'default', 'types', 'typings', 'module-sync',
]);
const NON_RUNTIME_FILE = /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

function toPackageRelativePath(value) {
  return String(value)
    .replace(/^\.\//u, '')
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

function collectDeclaredEntryPaths(manifest) {
  const entries = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) {
      entries.add(toPackageRelativePath(value));
    }
  };
  const walk = (value) => {
    if (typeof value === 'string') {
      add(value);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [ key, nested ] of Object.entries(value)) {
      // Subpath keys ('.', './mini') are not conditions; every other key is.
      if (!key.startsWith('.') && !PROTECTED_ENTRY_CONDITIONS.has(key)) continue;
      walk(nested);
    }
  };

  for (const field of [ 'main', 'module', 'types', 'typings' ]) {
    add(manifest[field]);
  }
  if (!manifest.main && !manifest.exports) add('index.js');
  if (manifest.bin) {
    // `bin` keys are command names, not conditions.
    if (typeof manifest.bin === 'string') add(manifest.bin);
    else for (const commandPath of Object.values(manifest.bin)) add(commandPath);
  }
  walk(manifest.exports);
  return entries;
}

// A directory that holds a declared entry is runtime payload together with
// everything below it: the entry may import its siblings. The copy filters run
// once per path, so manifest-derived answers are cached per package root instead
// of re-reading `package.json` for every file.
const protectedDirectoryCache = new Map();

function collectProtectedDirectoryPaths(packageRoot, manifest) {
  const cached = protectedDirectoryCache.get(packageRoot);
  if (cached) {
    return cached;
  }
  const protectedPaths = new Set();
  for (const entry of collectDeclaredEntryPaths(manifest)) {
    const segments = entry.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      protectedPaths.add(segments.slice(0, index).join('/'));
    }
  }
  protectedDirectoryCache.set(packageRoot, protectedPaths);
  return protectedPaths;
}

function readPackageManifest(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function isNonRuntimeBundledPath(relativePath, protectedPaths) {
  if (NON_RUNTIME_FILE.test(relativePath)) {
    return true;
  }
  const segments = relativePath.split(/[\\/]/u);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!NON_RUNTIME_DIRECTORY_NAMES.has(segments[index])) continue;
    const directoryPath = segments.slice(0, index + 1).join('/');
    if (!protectedPaths.has(directoryPath)) {
      return true;
    }
  }
  return false;
}

function shouldCopyBundledDependency(sourceRoot, sourcePath, patchedRuntime = false, readManifest = readPackageManifest) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }
  if (isCompilerDiagnostic(relativePath)) {
    return false;
  }

  const topLevelEntry = relativePath.split(path.sep)[0];
  if (topLevelEntry === 'node_modules' || topLevelEntry === '.git' || topLevelEntry === 'tsconfig.json') {
    return false;
  }

  const manifest = readManifest(sourceRoot);
  const protectedPaths = manifest ? collectProtectedDirectoryPaths(sourceRoot, manifest) : undefined;
  if (protectedPaths && isNonRuntimeBundledPath(relativePath, protectedPaths)) {
    return false;
  }
  // A declared entry outside the usual runtime directories (`node-fetch` keeps
  // its entry under `src/`) still has to be packaged with its siblings.
  const declaredTopLevelEntry = protectedPaths
    ? [ ...protectedPaths ].some((entryPath) => entryPath.split('/')[0] === topLevelEntry)
    : false;
  const declaredEntries = manifest ? collectDeclaredEntryPaths(manifest) : new Set();
  const rootRuntimeSibling = declaredEntries.size > 0 &&
    [...declaredEntries].some((entry) => !entry.includes('/')) &&
    // A root entry may load a sibling directory (including computed requires).
    // Keep its published runtime tree; the diagnostic/authoring exclusions above
    // still apply. Restricting siblings to root files silently loses that graph.
    !NON_RUNTIME_DIRECTORY_NAMES.has(topLevelEntry);

  return (
    (patchedRuntime && [ 'bin', 'config', 'templates', 'lib' ].includes(topLevelEntry)) ||
    declaredTopLevelEntry ||
    declaredEntries.has(relativePath.split(path.sep).join('/')) ||
    rootRuntimeSibling ||
    topLevelEntry === 'dist' ||
    topLevelEntry === 'package.json' ||
    topLevelEntry.startsWith('README') ||
    topLevelEntry.startsWith('LICENSE') ||
    topLevelEntry.startsWith('NOTICE')
  );
}

function rewriteRelativeImportSpecifiers(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const resolvePatchedSpecifier = (specifier) => {
    if (/\.(?:[cm]?js|json)$/.test(specifier)) {
      return specifier;
    }

    const resolvedPath = path.resolve(path.dirname(filePath), specifier);
    if (fs.existsSync(`${resolvedPath}.js`)) {
      return `${specifier}.js`;
    }
    if (fs.existsSync(path.join(resolvedPath, 'index.js'))) {
      return `${specifier}/index.js`;
    }
    return `${specifier}.js`;
  };

  const rewritten = source
    .replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolvePatchedSpecifier(specifier)}${suffix}`;
    })
    .replace(/(import\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolvePatchedSpecifier(specifier)}${suffix}`;
    })
    .replace(/(import\(\s*['"])(\.\.?\/[^'"]+?)(['"]\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolvePatchedSpecifier(specifier)}${suffix}`;
    });

  if (rewritten !== source) {
    fs.writeFileSync(filePath, rewritten);
  }
}

function patchBundledDrizzleSolid(destinationDir) {
  const esmDir = path.join(destinationDir, 'dist', 'esm');
  if (!fs.existsSync(esmDir)) {
    return;
  }

  const queue = [ esmDir ];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entryPath.endsWith('.js')) {
        rewriteRelativeImportSpecifiers(entryPath);
      }
    }
  }

  pruneMirroredEsmTypeDeclarations(destinationDir);
  fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
}

// `@undefineds.co/drizzle-solid` compiles its sources twice: `dist/core` for
// CommonJS and `dist/esm` for ESM. Both JavaScript trees are loaded at runtime,
// but the ESM tree also mirrors declaration files that the package's own
// `types` entry (`dist/index.d.ts`, resolved ahead of `import`/`require` for
// every condition) already provides. The mirrors are byte-identical, no export
// subpath reaches them, and declarations are never runtime payload, so they are
// dropped rather than shipped twice.
function pruneMirroredEsmTypeDeclarations(destinationDir) {
  const distDir = path.join(destinationDir, 'dist');
  const esmDir = path.join(distDir, 'esm');
  const queue = [ esmDir ];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entryPath.endsWith('.d.ts')) {
        continue;
      }
      const mirrorPath = path.join(distDir, path.relative(esmDir, entryPath));
      if (!fs.existsSync(mirrorPath)) {
        continue;
      }
      if (fs.readFileSync(mirrorPath).equals(fs.readFileSync(entryPath))) {
        fs.rmSync(entryPath);
      }
    }
  }
}

// Installers do not traverse bundled packages. Declare their external runtime
// edges on the published root; keep only conflicting pure-JS versions nested.
function projectExposedRuntimeDependency(input, edge) {
  const manifest = JSON.parse(JSON.stringify(input));
  if (!edge.optional && !edge.bundled && manifest.optionalDependencies?.[edge.name] && !manifest.dependencies?.[edge.name]) {
    manifest.dependencies ??= {};
    manifest.dependencies[edge.name] = edge.range;
    delete manifest.optionalDependencies[edge.name];
  }
  if (edge.newRoot) {
    const field = edge.optional ? 'optionalDependencies' : 'dependencies';
    manifest[field] ??= {};
    manifest[field][edge.name] = edge.range;
  }
  return manifest;
}

// The actual packer and retained-input replay share this one selection/queue
// implementation. Callbacks supply actual reads/resolution; it issues no fact.
function planExposedRuntimeDependencies({ packageDir, dependencies, manifest: input, readManifest, resolveInstalled, onExposure = () => {}, onNestedConflict = () => {} }) {
  let manifest = JSON.parse(JSON.stringify(input));
  manifest.dependencies ??= {};
  const edges = [];
  const bundledNames = new Set(dependencies.map((entry) => entry.name));
  const roots = new Map(dependencies.map((entry) => [entry.name, entry.sourcePackageRoot]));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (!roots.has(name)) roots.set(name, resolveInstalled(dependencies[0].repoRoot, name));
  }
  const queue = dependencies.map((entry) => ({
    source: entry.sourcePackageRoot,
    destination: path.join(packageDir, 'node_modules', ...entry.name.split('/')),
  }));
  const visited = new Set();
  while (queue.length) {
    const { source, destination } = queue.shift();
    if (visited.has(destination)) continue;
    visited.add(destination);
    const childManifest = readManifest(path.join(source, 'package.json'), 'actual-resolution-parent-manifest');
    const optional = childManifest.optionalDependencies || {};
    for (const [name, range] of Object.entries({ ...childManifest.dependencies, ...optional })) {
      const childSource = resolveInstalled(source, name);
      const existing = roots.get(name);
      if (!childSource && !Object.hasOwn(optional, name)) {
        throw new Error(`Missing installed runtime dependency ${name} required by ${childManifest.name}`);
      }
      if (!roots.has(name) || existing === childSource) {
        const edge = { name, range, optional: Object.hasOwn(optional, name), bundled: bundledNames.has(name), newRoot: !roots.has(name) };
        onExposure({ role: 'actual-manifest-exposure', source, resolvedRoot: childSource ?? null, priorRoot: existing ?? null, edge });
        edges.push(edge);
        manifest = projectExposedRuntimeDependency(manifest, edge);
        if (!roots.has(name)) roots.set(name, childSource);
        continue;
      }
      if (!childSource) throw new Error(`Unresolved optional dependency conflict: ${name}`);
      const nestedManifest = readManifest(path.join(childSource, 'package.json'), 'nested-conflict-manifest');
      if (nestedManifest.os || nestedManifest.cpu || nestedManifest.libc ||
          nestedManifest.scripts?.install || nestedManifest.scripts?.postinstall) {
        throw new Error(`Cannot bundle platform-specific dependency conflict: ${name}`);
      }
      const childDestination = path.join(destination, 'node_modules', ...name.split('/'));
      onNestedConflict(childSource, childDestination, nestedManifest);
      queue.push({ source: childSource, destination: childDestination });
    }
  }
  return { manifest, edges };
}

// One actual Node search-path contract, shared with retained-original replay.
// It does not probe the filesystem or choose a second dependency resolver.
function installedResolutionSearchRoots(source, globalPaths) {
  if (path.sep !== '/' || typeof source !== 'string' || !path.posix.isAbsolute(source) || path.posix.normalize(source) !== source || source.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(source)) throw new Error('Canonical POSIX installed resolution source required');
  if (!Array.isArray(globalPaths) || globalPaths.length > 128 || globalPaths.some(value => typeof value !== 'string' || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(value))) throw new Error('Bounded actual Node global search originals required');
  const roots = [...require('node:module')._nodeModulePaths(source), ...globalPaths];
  if (!roots.length || roots.length > 128 || new Set(roots).size !== roots.length) throw new Error('Bounded unique actual Node search roots required');
  return roots;
}

function inspectInstalledResolutionSearch(row) {
  if (typeof row.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(row.name)) throw new Error('Canonical installed package identity required');
  const expected = installedResolutionSearchRoots(row.source, row.globalPaths);
  if (JSON.stringify(row.searchRoots) !== JSON.stringify(expected)) throw new Error('Complete actual Node search vector required');
  const candidates = expected.map(root => path.posix.join(root, ...row.name.split('/')));
  if (!Array.isArray(row.probes) || !row.probes.length || row.probes.length > candidates.length || row.probes.some((probe, index) => !probe || probe.path !== candidates[index] || typeof probe.exists !== 'boolean' || (probe.exists && index !== row.probes.length - 1)) || (!row.probes[row.probes.length - 1].exists && row.probes.length !== candidates.length)) throw new Error('Complete actual Node first-hit/exhaustive-absence prefix required');
  return Object.freeze({dependencySearchReplayed:true});
}

function exposeBundledRuntimeDependencies(packageDir, dependencies, originals) {
  const { createRequire } = require('node:module');
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = readPackManifest(manifestPath, 'root-after-workspace-removal', originals);
  const resolveInstalled = (source, name) => {
    const resolver = createRequire(path.join(source, 'package.json'));
    const probes = [], observations = [];
    const searchRoots = resolver.resolve.paths('__xpod_runtime_dependency__'), globalPaths = [...require('node:module').globalPaths];
    if (originals && JSON.stringify(searchRoots) !== JSON.stringify(installedResolutionSearchRoots(source, globalPaths))) throw new Error('Actual Node search roots differ from source/global originals');
    const resolved = searchRoots
      .map((root) => path.join(root, ...name.split('/')))
      .find((root) => { const observed = originals ? originals.probePath(path.join(root, 'package.json'), 'manifest') : undefined;const exists = observed ? observed.exists : fs.existsSync(path.join(root, 'package.json'));probes.push({ path: root, exists });if(observed)observations.push(observed.observation);return exists; });
    const selected = originals && resolved ? originals.probePath(resolved, 'directory') : undefined;
    const canonical = resolved && (selected ? selected.canonicalPath : fs.realpathSync(resolved));
    if (originals) {
      inspectInstalledResolutionSearch({source,name,searchRoots,globalPaths,probes});
      originals.event({ role: 'actual-node-resolution', source, name, searchRoots, globalPaths, workerPid:process.pid, probes, resolvedRoot: canonical ?? null });
      originals.event({ role: 'actual-node-input-custody', source, name, observations, selectedRoot: selected?.observation ?? null });
    }
    return canonical;
  };
  const planned = planExposedRuntimeDependencies({ packageDir, dependencies, manifest,
    readManifest: (file, role) => readPackManifest(file, role, originals), resolveInstalled,
    onExposure: row => { if (originals) originals.event(row); },
    onNestedConflict: (childSource, childDestination, nestedManifest) => {
      const childProtectedPaths = collectProtectedDirectoryPaths(childSource, nestedManifest);
      fs.mkdirSync(path.dirname(childDestination), { recursive: true });
      const filter = (file) => {
        const childRelativePath = path.relative(childSource, file);
        if (['node_modules', '.git'].includes(childRelativePath.split(path.sep)[0])) return false;
        if (isCompilerDiagnostic(childRelativePath)) return false;
        if (isNonRuntimeBundledPath(childRelativePath, childProtectedPaths)) return false;
        if (/\.(node|dylib|so|dll|exe)$/.test(file)) throw new Error(`Cannot bundle native dependency file: ${file}`);
        return true;
      };
      if (originals) originals.copyTree(childSource, childDestination, filter, nestedManifest.name);
      else fs.cpSync(childSource, childDestination, { recursive: true, dereference: true, filter });
    },
  });
  fs.writeFileSync(manifestPath, JSON.stringify(planned.manifest, null, 2) + '\n');
}

// Both installed inputs and normalized public packages use the same runtime
// materialization rules. Public transport archives retain their original bytes.
function copyBundledRuntimeDependency(dependency, sourceRoot, destinationDir, originals) {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  const selectedManifest = originals ? readPackManifest(path.join(sourceRoot, 'package.json'), 'actual-copy-selection-manifest', originals) : undefined;
  const filter = sourcePath => shouldCopyBundledDependency(sourceRoot, sourcePath, dependency.patchedRuntime, originals ? () => selectedManifest : readPackageManifest);
  if (originals) originals.copyTree(sourceRoot, destinationDir, filter, dependency.name);
  else fs.cpSync(sourceRoot, destinationDir, { recursive: true, dereference: true, filter });
  if (dependency.name === DRIZZLE_SOLID_PACKAGE) patchBundledDrizzleSolid(destinationDir);
}

function packCommand(originals, command, args, options) {
  return originals?.execFileSync ? originals.execFileSync(command, args, options) : execFileSync(command, args, options);
}

function bundleLocalDependenciesIntoTarball(tarballPath, dependencies, profile = 'compat', originals) {
  if (dependencies.length === 0) {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-pack-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');

  try {
    fs.mkdirSync(unpackDir, { recursive: true });
    packCommand(originals, 'tar', [ 'xf', tarballPath, '-C', unpackDir ]);
    removeWorkspaceDependencies(packageDir, originals);

    for (const dependency of dependencies) {
      const destinationDir = path.join(packageDir, 'node_modules', ...dependency.name.split('/'));
      copyBundledRuntimeDependency(dependency, dependency.sourcePackageRoot, destinationDir, originals);
      console.log(`[npm-pack] bundled local dependency ${dependency.name}`);
    }

    exposeBundledRuntimeDependencies(packageDir, dependencies, originals);

    // Public compatibility packages use complete standard bundles with real
    // version edges. Internal service artifacts instead transport public tarballs
    // for installation after extraction; these are not npm registry package edges.
    // Patched runtime packages remain standard bundles in both profiles.
    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = readPackManifest(manifestPath, 'root-after-actual-resolutions', originals);
    if (profile === 'service') applyServicePayload(packageDir);
    const runtimeArchives = [];
    const manifestInputs = [];
    for (const dependency of dependencies) {
      if (dependency.patchedRuntime) {
        const installed = readPackManifest(path.join(dependency.sourcePackageRoot, 'package.json'), 'selected-installed-bundled-manifest', originals);
        manifestInputs.push({ name: dependency.name, patchedRuntime: true, version: installed.version });
      } else {
        // Bun reinstalls file directories and can delete a self-referential
        // node_modules input. Transport the complete public package as a tarball.
        const archiveDir = path.join(packageDir, 'runtime-packages');
        fs.mkdirSync(archiveDir, { recursive: true });
        const filename = `${dependency.name.replace(/[@/]/g, '-')}.tgz`;
        const archivePath = path.join(archiveDir, filename);
        // Standard publication normalizes workspace protocols to actual
        // package versions; no dependency fields or public exports are removed.
        if (originals) originals.capturePublicPack(dependency.sourcePackageRoot, dependency.name, archivePath);
        else packCommand(originals, 'bun', ['pm', 'pack', '--ignore-scripts', '--filename', archivePath], {
          cwd: dependency.sourcePackageRoot, stdio: 'pipe',
        });
        const body = originals ? originals.retainBody(archivePath, 'public-package-tar', dependency.name) : undefined;
        const bytes = body ? undefined : fs.readFileSync(archivePath);
        const publicManifest = packCommand(originals, 'tar', ['xOf', archivePath, 'package/package.json']);
        if (originals) originals.retainBuffer(publicManifest, 'actual-public-tar-manifest');
        runtimeArchives.push({ name: dependency.name, path: `runtime-packages/${filename}`,
          bytes: body ? body.reference.bytes : bytes.length, sha256: body ? body.reference.sha256 : crypto.createHash('sha256').update(bytes).digest('hex'),
          integrity: body ? body.integrity : `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
          manifestSHA256: crypto.createHash('sha256').update(publicManifest).digest('hex'),
          sourceManifestSHA256: crypto.createHash('sha256').update(originals ? originals.readOriginal(path.join(dependency.sourcePackageRoot, 'package.json'), 'public-package-source-manifest') : fs.readFileSync(path.join(dependency.sourcePackageRoot, 'package.json'))).digest('hex') });
        if (profile === 'compat') {
          // A standard npm consumer resolves dependencies before extracting the
          // outer package. Relative embedded tarball edges are not a registry
          // contract. Carry the normalized public manifest and filtered runtime
          // payload through bundledDependencies with its real version edge.
          const publicPackageDir = fs.mkdtempSync(path.join(tempRoot, 'public-package-'));
          packCommand(originals, 'tar', ['xf', archivePath, '-C', publicPackageDir]);
          const destinationDir = path.join(packageDir, 'node_modules', ...dependency.name.split('/'));
          copyBundledRuntimeDependency(dependency, path.join(publicPackageDir, 'package'), destinationDir, originals);
          manifestInputs.push({ name: dependency.name, patchedRuntime: false, version: JSON.parse(publicManifest).version });
          fs.rmSync(archivePath);
          continue;
        }
        manifestInputs.push({ name: dependency.name, patchedRuntime: false });
        // This complete tarball is the package input. Do not also transport a
        // second uncompressed copy or advertise a missing bundled directory.
        fs.rmSync(path.join(packageDir, 'node_modules', ...dependency.name.split('/')), { recursive: true, force: true });
      }
    }
    const projectedManifest = projectPackedManifest(manifest, manifestInputs, profile);
    if (originals) { originals.event({ role: 'actual-final-selected-inputs', dependencies: manifestInputs }); originals.retainBuffer(Buffer.from(JSON.stringify(projectedManifest, null, 2) + '\n'), 'actual-final-projected-manifest'); }
    if (profile === 'service') fs.writeFileSync(path.join(packageDir, 'runtime-packages', 'inventory.json'), JSON.stringify(runtimeArchives, null, 2) + '\n');
    else fs.rmSync(path.join(packageDir, 'runtime-packages'), { recursive: true, force: true });
    fs.writeFileSync(manifestPath, JSON.stringify(projectedManifest, null, 2) + '\n');
    packCommand(originals, 'tar', [ 'czf', tarballPath, '-C', unpackDir, 'package' ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function projectPackedManifest(preparedManifest, dependencies, profile = 'compat') {
  if (!['compat', 'service'].includes(profile)) throw new Error('Unsupported artifact profile');
  const manifest = JSON.parse(JSON.stringify(preparedManifest));
  if (profile === 'service') applyServiceManifest(manifest);
  delete manifest.workspaces;
  const seen = new Set();
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency.name !== 'string' || seen.has(dependency.name)) throw new Error('Unique actual bundled manifest input required');
    seen.add(dependency.name);
    manifest.dependencies ??= {};
    if (dependency.patchedRuntime || profile === 'compat') {
      if (typeof dependency.version !== 'string' || !dependency.version) throw new Error('Actual installed/public manifest version required');
      manifest.dependencies[dependency.name] = dependency.version;
      manifest.bundledDependencies ??= [];
      if (!manifest.bundledDependencies.includes(dependency.name)) manifest.bundledDependencies.push(dependency.name);
    } else {
      const filename = `${dependency.name.replace(/[@/]/g, '-')}.tgz`;
      manifest.dependencies[dependency.name] = `file:./runtime-packages/${filename}`;
      manifest.overrides ??= {};
      manifest.overrides[dependency.name] = manifest.dependencies[dependency.name];
      manifest.bundledDependencies = (manifest.bundledDependencies ?? []).filter((name) => name !== dependency.name);
    }
  }
  return manifest;
}

// Complete manifest stages after the actual npm prepack/sanitization step.
// Resolution edges and installed/public versions must come from retained inputs;
// this pure function deliberately does not assert their provenance.
function projectServicePackManifest(packedRootManifest, resolutionEdges, dependencies) {
  let manifest = removeWorkspaceDependenciesManifest(packedRootManifest);
  manifest.dependencies ??= {};
  for (const edge of resolutionEdges) manifest = projectExposedRuntimeDependency(manifest, edge);
  return projectPackedManifest(manifest, dependencies, 'service');
}

function applyServiceManifest(manifest) {
  manifest.xpodArtifactProfile = 'service';
  manifest.bin = { 'xpod-service': './dist/runtime/service-entry.js' };
  delete manifest.dependencies?.['@undefineds.co/xpod-cli'];
  delete manifest.devDependencies;
  delete manifest.workspaces;
  delete manifest.scripts;
  manifest.bundledDependencies = (manifest.bundledDependencies ?? []).filter((name) => name !== '@undefineds.co/xpod-cli');
}

function applyServicePayload(packageDir) {
  // This is an internal service artifact, never the complete registry CLI
  // package. Dependency packages retain all their own public exports and bytes.
  if (!fs.existsSync(path.join(packageDir, 'dist/runtime/service-entry.js'))) throw new Error('Service entry build is missing');
  const cliRoot = path.join(packageDir, 'dist', 'cli');
  if (fs.existsSync(cliRoot)) {
    for (const entry of fs.readdirSync(cliRoot)) {
      if (entry !== 'commands') fs.rmSync(path.join(cliRoot, entry), { recursive: true, force: true });
    }
    const commands = path.join(cliRoot, 'commands');
    if (fs.existsSync(commands)) for (const entry of fs.readdirSync(commands)) {
      if (!/^start\.(?:js|d\.ts)$/u.test(entry)) fs.rmSync(path.join(commands, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(path.join(packageDir, 'bin'), { recursive: true, force: true });
}

function applyServiceProfile(packageDir, manifest) {
  applyServicePayload(packageDir);
  applyServiceManifest(manifest);
}

function walkFiles(rootDir, currentDir = rootDir, files = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, entryPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stats = fs.statSync(entryPath);
    files.push({
      path: path.relative(rootDir, entryPath).replace(/\\/g, '/'),
      size: stats.size,
      mode: stats.mode & 0o777,
    });
  }
  return files;
}

function summarizeTarball(tarballPath, originals, finalBody) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-pack-summary-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');

  try {
    fs.mkdirSync(unpackDir, { recursive: true });
    packCommand(originals, 'tar', [ 'xf', tarballPath, '-C', unpackDir ]);

    const buffer = finalBody ? undefined : fs.readFileSync(tarballPath);
    const files = walkFiles(packageDir);
    return {
      size: finalBody ? finalBody.reference.bytes : buffer.length,
      unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
      shasum: finalBody ? finalBody.shasum : crypto.createHash('sha1').update(buffer).digest('hex'),
      integrity: finalBody ? finalBody.integrity : `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`,
      files,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function packWithManifestRestoration(repoRoot, invocation, env, originals) {
  const backupPath = path.join(repoRoot, '.test-data', 'package.json.pack.backup');
  if (fs.existsSync(backupPath)) {
    throw new Error('A package manifest backup already exists; restore it before packing again');
  }
  try {
    return packCommand(originals, invocation.command, invocation.args, {
      cwd: repoRoot, encoding: 'utf8', env, stdio: [ 'ignore', 'pipe', 'inherit' ],
    });
  } finally {
    // npm does not run postpack when packing fails after prepack.
    if (fs.existsSync(backupPath)) {
      packCommand(originals, process.execPath, [path.join(repoRoot, 'scripts', 'prepare-package-manifest.cjs'), 'restore'], {
        cwd: repoRoot, env, stdio: 'inherit',
      });
    }
  }
}

function main() {
  const repoRoot = process.cwd();
  const packDir = path.resolve(repoRoot, process.argv[2] || '.test-data/npm-pack');
  const cacheDir = path.resolve(repoRoot, process.argv[3] || '.test-data/npm-cache');
  const profile = process.argv[4] || 'compat';
  if (!['compat', 'service'].includes(profile)) throw new Error('Unsupported artifact profile');
  const retained = process.argv[5] === '--retain-service-originals';
  if (process.argv.length > 5 && !retained) throw new Error('Unsupported pack observation arguments');
  let originals, phase, restoreStdio, nodeRuntime;
  if (retained) {
    if (profile !== 'service' || process.argv.length !== 9 || !/^[a-f0-9]{40}$/u.test(process.argv[6])) throw new Error('Exact service source/parent observation required');
    phase = require('./service-pack-phase.cjs').createPackPhase({deadlineUnixMs:Number(process.argv[7]),retainedCeilingBytes:Number(process.argv[8])});
    originals = require('./service-pack-originals.cjs').createServicePackOriginals({directory:path.join(repoRoot,'.test-data/service-pack-originals'),bodyDirectory:path.join(repoRoot,'.test-data/service-pack-bodies'),sourceSha:process.argv[6],check:phase.check,reserveBytes:phase.reserveBytes,remainingBytes:phase.remainingBytes,metadataStart:phase.metadataStart,execFileSync:phase.execFileSync,reserveOriginalMaximum:phase.reserveOriginalMaximum,settleOriginalReservation:phase.settleOriginalReservation});
    phase.attachRecorder(originals);restoreStdio=phase.installStdio();
  }

  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  let packError;
  try {
  if(originals){nodeRuntime=require('./service-pack-node-runtime.cjs').captureNodeWorker({check:phase.check});if(nodeRuntime)originals.event({role:'actual-node-runtime-before',observation:nodeRuntime.before});}
  const npmInvocation = getNpmInvocation([
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packDir,
  ]);

  const packEnvironment = { ...process.env, npm_config_cache: cacheDir };
  if (originals) {
    originals.readOriginal(path.join(repoRoot, 'package.json'), 'actual-prepack-root-input');
    originals.event({ role: 'actual-prepack-policy', includePlatformPackages: packEnvironment.XPOD_INCLUDE_PLATFORM_PACKAGES === 'true' });
  }
  const stdout = packWithManifestRestoration(repoRoot, npmInvocation, packEnvironment, originals);

  const packJsonPath = path.join(packDir, 'pack.json');
  const packData = JSON.parse(stdout);
  const pack = packData[0];
  if (!pack?.filename) {
    throw new Error('npm pack did not return a filename');
  }
  const tarballPath = path.join(packDir, pack.filename);
  if (originals) originals.retainBody(tarballPath, 'seed-npm-pack');
  const bundledLocalDependencies = getBundledLocalDependencies(repoRoot, profile, originals);

  bundleLocalDependenciesIntoTarball(tarballPath, bundledLocalDependencies, profile, originals);
  const finalBody = originals ? originals.retainBody(tarballPath, 'final-service-pack') : undefined;
  Object.assign(pack, summarizeTarball(tarballPath, originals, finalBody));
  fs.writeFileSync(packJsonPath, JSON.stringify(packData, null, 2) + '\n');

  console.log(`[npm-pack] wrote ${packJsonPath}`);
  console.log(`[npm-pack] tarball ${tarballPath}`);
  if(nodeRuntime)originals.event({role:'actual-node-runtime-after',observation:nodeRuntime.finish()});
  if (originals) originals.seal({...(nodeRuntime?{nodeRuntimeModel:'actual-linux-node-worker-executable-v1'}:{}),completion:'actual-pack-returned',resolutionSearchModel:'actual-node-module-search-prefix-v1',budget:phase.snapshot()});
  } catch (error) { packError = error;throw error; } finally {
    let cleanupError;try{if(nodeRuntime)nodeRuntime.close();}catch(error){cleanupError=error;}try { if (originals) originals.close(); } catch (error) { cleanupError ??= error; }
    try { if (restoreStdio) restoreStdio(); } catch (error) { cleanupError ??= error; }
    if (!packError && cleanupError) throw cleanupError;
  }
}

module.exports = { installedResolutionSearchRoots, inspectInstalledResolutionSearch, removeWorkspaceDependenciesManifest, projectExposedRuntimeDependency, projectServicePackManifest, projectPackedManifest, planExposedRuntimeDependencies, getNpmInvocation, summarizeTarball, serviceWorkspacePackages, getBundledLocalDependencies, bundleLocalDependenciesIntoTarball, packWithManifestRestoration, applyServiceProfile, shouldCopyBundledDependency };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
