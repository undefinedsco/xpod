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
  '@undefineds.co/extension-sdk',
  '@undefineds.co/shared-ui',
  '@undefineds.co/solid-sdk',
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

function getBundledLocalDependencies(repoRoot) {
  const privatePatchedDependencies = [ DRIZZLE_SOLID_PACKAGE, EXTENSIONS_PACKAGE ].flatMap((name) => {
    const sourcePackageRoot = path.join(repoRoot, 'node_modules', ...name.split('/'));
    if (!fs.existsSync(sourcePackageRoot)) {
      return [];
    }
    return [{ name, sourcePackageRoot: fs.realpathSync(sourcePackageRoot) }];
  });

  const workspaceDependencies = WORKSPACE_PACKAGES.map((name) => ({
    name,
    sourcePackageRoot: path.join(repoRoot, 'packages', name.slice('@undefineds.co/'.length)),
  }));

  const patchedRuntimeDependencies = PATCHED_RUNTIME_PACKAGES.map((name) => ({
    name,
    sourcePackageRoot: fs.realpathSync(path.join(repoRoot, 'node_modules', ...name.split('/'))),
    patchedRuntime: true,
  }));
  return [ ...privatePatchedDependencies, ...workspaceDependencies, ...patchedRuntimeDependencies ].map((entry) => ({ ...entry, repoRoot }));
}

function removeWorkspaceDependencies(packageRoot) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  for (const field of [ 'dependencies', 'optionalDependencies', 'peerDependencies' ]) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const [ name, version ] of Object.entries(dependencies)) {
      if (BUNDLED_LOCAL_PACKAGES.includes(name) || (typeof version === 'string' && version.startsWith('workspace:'))) {
        delete dependencies[name];
      }
    }
  }
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

function isCompilerDiagnostic(filePath) {
  return /(?:\.[cm]?[jt]sx?\.map|\.tsbuildinfo)$/.test(filePath);
}

function shouldCopyBundledDependency(sourceRoot, sourcePath, patchedRuntime = false) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }
  if (isCompilerDiagnostic(relativePath)) {
    return false;
  }

  const topLevelEntry = relativePath.split(path.sep)[0];
  if (topLevelEntry === 'node_modules' || topLevelEntry === '.git' || topLevelEntry === 'src' || topLevelEntry === 'tsconfig.json') {
    return false;
  }

  return (
    (patchedRuntime && [ 'bin', 'config', 'templates', 'lib' ].includes(topLevelEntry)) ||
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

  fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
}

// Installers do not traverse bundled packages. Declare their external runtime
// edges on the published root; keep only conflicting pure-JS versions nested.
function exposeBundledRuntimeDependencies(packageDir, dependencies) {
  const { createRequire } = require('node:module');
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies ??= {};
  const resolveInstalled = (source, name) => {
    const resolver = createRequire(path.join(source, 'package.json'));
    const resolved = resolver.resolve.paths('__xpod_runtime_dependency__')
      .map((root) => path.join(root, ...name.split('/')))
      .find((root) => fs.existsSync(path.join(root, 'package.json')));
    return resolved && fs.realpathSync(resolved);
  };
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
    const childManifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const optional = childManifest.optionalDependencies || {};
    for (const [name, range] of Object.entries({ ...childManifest.dependencies, ...optional })) {
      const childSource = resolveInstalled(source, name);
      const existing = roots.get(name);
      if (!childSource && !Object.hasOwn(optional, name)) {
        throw new Error(`Missing installed runtime dependency ${name} required by ${childManifest.name}`);
      }
      if (!roots.has(name) || existing === childSource) {
        if (!Object.hasOwn(optional, name) && !bundledNames.has(name) &&
            manifest.optionalDependencies?.[name] && !manifest.dependencies[name]) {
          manifest.dependencies[name] = range;
          delete manifest.optionalDependencies[name];
        }
        if (!roots.has(name)) {
          roots.set(name, childSource);
          const field = Object.hasOwn(optional, name) ? 'optionalDependencies' : 'dependencies';
          manifest[field] ??= {};
          manifest[field][name] = range;
        }
        continue;
      }
      if (!childSource) throw new Error(`Unresolved optional dependency conflict: ${name}`);
      const nestedManifest = JSON.parse(fs.readFileSync(path.join(childSource, 'package.json'), 'utf8'));
      if (nestedManifest.os || nestedManifest.cpu || nestedManifest.libc ||
          nestedManifest.scripts?.install || nestedManifest.scripts?.postinstall) {
        throw new Error(`Cannot bundle platform-specific dependency conflict: ${name}`);
      }
      const childDestination = path.join(destination, 'node_modules', ...name.split('/'));
      fs.mkdirSync(path.dirname(childDestination), { recursive: true });
      fs.cpSync(childSource, childDestination, {
        recursive: true, dereference: true,
        filter: (file) => {
          if (['node_modules', '.git'].includes(path.relative(childSource, file).split(path.sep)[0])) return false;
          if (isCompilerDiagnostic(file)) return false;
          if (/\.(node|dylib|so|dll|exe)$/.test(file)) throw new Error(`Cannot bundle native dependency file: ${file}`);
          return true;
        },
      });
      queue.push({ source: childSource, destination: childDestination });
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function bundleLocalDependenciesIntoTarball(tarballPath, dependencies) {
  if (dependencies.length === 0) {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-pack-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');

  try {
    fs.mkdirSync(unpackDir, { recursive: true });
    execFileSync('tar', [ 'xf', tarballPath, '-C', unpackDir ]);
    removeWorkspaceDependencies(packageDir);

    for (const dependency of dependencies) {
      const destinationDir = path.join(packageDir, 'node_modules', ...dependency.name.split('/'));
      fs.rmSync(destinationDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
      fs.cpSync(dependency.sourcePackageRoot, destinationDir, {
        recursive: true,
        dereference: true,
        filter: (sourcePath) => shouldCopyBundledDependency(dependency.sourcePackageRoot, sourcePath, dependency.patchedRuntime),
      });
      if (dependency.name === DRIZZLE_SOLID_PACKAGE) {
        patchBundledDrizzleSolid(destinationDir);
      }
      removeWorkspaceDependencies(destinationDir);
      console.log(`[npm-pack] bundled local dependency ${dependency.name}`);
    }

    exposeBundledRuntimeDependencies(packageDir, dependencies);

    // Declare every copied package as bundled. Without this installer contract,
    // npm can prune workspace/private packages or replace them with registry copies.
    // npm publication inserts "*" for missing bundle edges. Private/workspace
    // bundles need package-relative file edges so Bun does not query the registry.
    // Published patched runtime packages retain their existing exact registry edges.
    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const dependency of dependencies) {
      manifest.dependencies ??= {};
      if (dependency.patchedRuntime) {
        const installed = JSON.parse(fs.readFileSync(path.join(dependency.sourcePackageRoot, 'package.json'), 'utf8'));
        manifest.dependencies[dependency.name] = installed.version;
      } else {
        manifest.dependencies[dependency.name] = `file:./node_modules/${dependency.name}`;
      }
      manifest.bundledDependencies ??= [];
      if (!manifest.bundledDependencies.includes(dependency.name)) manifest.bundledDependencies.push(dependency.name);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    execFileSync('tar', [ 'czf', tarballPath, '-C', unpackDir, 'package' ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

function summarizeTarball(tarballPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-pack-summary-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');

  fs.mkdirSync(unpackDir, { recursive: true });
  execFileSync('tar', [ 'xf', tarballPath, '-C', unpackDir ]);

  const buffer = fs.readFileSync(tarballPath);
  const files = walkFiles(packageDir);
  return {
    size: buffer.length,
    unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
    shasum: crypto.createHash('sha1').update(buffer).digest('hex'),
    integrity: `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`,
    files,
  };
}

function packWithManifestRestoration(repoRoot, invocation, env) {
  const backupPath = path.join(repoRoot, '.test-data', 'package.json.pack.backup');
  if (fs.existsSync(backupPath)) {
    throw new Error('A package manifest backup already exists; restore it before packing again');
  }
  try {
    return execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot, encoding: 'utf8', env, stdio: [ 'ignore', 'pipe', 'inherit' ],
    });
  } finally {
    // npm does not run postpack when packing fails after prepack.
    if (fs.existsSync(backupPath)) {
      execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'prepare-package-manifest.cjs'), 'restore'], {
        cwd: repoRoot, env, stdio: 'inherit',
      });
    }
  }
}

function main() {
  const repoRoot = process.cwd();
  const packDir = path.resolve(repoRoot, process.argv[2] || '.test-data/npm-pack');
  const cacheDir = path.resolve(repoRoot, process.argv[3] || '.test-data/npm-cache');

  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const npmInvocation = getNpmInvocation([
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packDir,
  ]);

  const stdout = packWithManifestRestoration(repoRoot, npmInvocation, {
    ...process.env,
    npm_config_cache: cacheDir,
  });

  const packJsonPath = path.join(packDir, 'pack.json');
  const packData = JSON.parse(stdout);
  const pack = packData[0];
  if (!pack?.filename) {
    throw new Error('npm pack did not return a filename');
  }
  const tarballPath = path.join(packDir, pack.filename);
  const bundledLocalDependencies = getBundledLocalDependencies(repoRoot);

  bundleLocalDependenciesIntoTarball(tarballPath, bundledLocalDependencies);
  Object.assign(pack, summarizeTarball(tarballPath));
  fs.writeFileSync(packJsonPath, JSON.stringify(packData, null, 2) + '\n');

  console.log(`[npm-pack] wrote ${packJsonPath}`);
  console.log(`[npm-pack] tarball ${tarballPath}`);
}

module.exports = { getBundledLocalDependencies, bundleLocalDependenciesIntoTarball, packWithManifestRestoration };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
