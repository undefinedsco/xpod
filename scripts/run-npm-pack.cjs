#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DRIZZLE_SOLID_PACKAGE = '@undefineds.co/drizzle-solid';
const MODELS_PACKAGE = '@undefineds.co/models';

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
  const privatePatchedDependencies = [ DRIZZLE_SOLID_PACKAGE, MODELS_PACKAGE ].flatMap((name) => {
    const sourcePackageRoot = path.join(repoRoot, 'node_modules', ...name.split('/'));
    if (!fs.existsSync(sourcePackageRoot)) {
      return [];
    }
    return [{ name, sourcePackageRoot: fs.realpathSync(sourcePackageRoot) }];
  });

  return privatePatchedDependencies;
}

function shouldCopyBundledDependency(sourceRoot, sourcePath) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  const topLevelEntry = relativePath.split(path.sep)[0];
  if (topLevelEntry === 'node_modules' || topLevelEntry === '.git' || topLevelEntry === 'src' || topLevelEntry === 'tsconfig.json') {
    return false;
  }

  return (
    topLevelEntry === 'dist' ||
    topLevelEntry === 'package.json' ||
    topLevelEntry.startsWith('README') ||
    topLevelEntry.startsWith('LICENSE')
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

function bundleLocalDependenciesIntoTarball(tarballPath, dependencies) {
  if (dependencies.length === 0) {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-pack-'));
  const unpackDir = path.join(tempRoot, 'unpack');
  const packageDir = path.join(unpackDir, 'package');

  fs.mkdirSync(unpackDir, { recursive: true });
  execFileSync('tar', [ 'xf', tarballPath, '-C', unpackDir ]);

  for (const dependency of dependencies) {
    const destinationDir = path.join(packageDir, 'node_modules', ...dependency.name.split('/'));
    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
    fs.cpSync(dependency.sourcePackageRoot, destinationDir, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => shouldCopyBundledDependency(dependency.sourcePackageRoot, sourcePath),
    });
    if (dependency.name === DRIZZLE_SOLID_PACKAGE) {
      patchBundledDrizzleSolid(destinationDir);
    }
    console.log(`[npm-pack] bundled local dependency ${dependency.name}`);
  }

  execFileSync('tar', [ 'czf', tarballPath, '-C', unpackDir, 'package' ]);
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

  const stdout = execFileSync(npmInvocation.command, npmInvocation.args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
    stdio: [ 'ignore', 'pipe', 'inherit' ],
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

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
