#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const zlib = require('node:zlib');
const esbuild = require('esbuild');
const { stageEmbeddedNativeCli } = require('./lib/embedded-native-cli.cjs');
const { createSingleBinaryEntry } = require('./lib/bun-single-runtime-entry.cjs');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
// Packages a built runtime loads by bare specifier at request time.
const RUNTIME_WORKSPACE_PACKAGES = [
  '@undefineds.co/solid-sdk',
];
const COMMON_BUNDLE_EXTERNALS = [
  'bun:sqlite',
  'mysql',
  'mysql2',
  'oracledb',
  'pg-native',
  'sqlite3',
  'tedious',
];
const argv = process.argv.slice(2);
const outputArg = argv.find((arg) => arg.startsWith('--output='));
const targetArg = argv.find((arg) => arg.startsWith('--target='));
const outputPath = outputArg
  ? path.resolve(repoRoot, outputArg.slice('--output='.length))
  : path.join(distRoot, 'xpod-bun');
const compileTarget = targetArg
  ? targetArg.slice('--target='.length)
  : undefined;

const requiredEntries = [
  path.join(repoRoot, 'dist', 'index.js'),
  path.join(repoRoot, 'dist', 'components', 'components.jsonld'),
  path.join(repoRoot, 'config', 'local.json'),
];

for (const entry of requiredEntries) {
  if (!fs.existsSync(entry)) {
    console.error(`Missing required build artifact: ${path.relative(repoRoot, entry)}`);
    console.error('Please run `bun run build` first.');
    process.exit(1);
  }
}

// Validate the compiler too: it embeds its Bun runtime in the shipped binary.
require('../dist/runtime/compat/ensureSupportedBun').ensureSupportedBun(run('bun', ['--version']).stdout.trim());

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-bun-single-'));
const stageRoot = path.join(tempRoot, 'package');

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const stdout = result.stdout ? `\n${result.stdout}` : '';
    const stderr = result.stderr ? `\n${result.stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed.${stdout}${stderr}`);
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function extractRefs(text) {
  const refs = new Set();
  const bundlePattern = /https:\/\/linkedsoftwaredependencies\.org\/bundles\/npm\/(.*?)\/\^/g;
  const npmdPattern = /npmd:((?:@[^/]+\/[^/]+)|[^/"'#]+)(?=(?:\/\^|["'#]))/g;
  for (const match of text.matchAll(bundlePattern)) {
    refs.add(match[1]);
  }
  for (const match of text.matchAll(npmdPattern)) {
    refs.add(match[1]);
  }
  return refs;
}

function iterFiles(rootPath) {
  const entries = [];
  if (!fs.existsSync(rootPath)) {
    return entries;
  }
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    return [rootPath];
  }
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        entries.push(fullPath);
      }
    }
  }
  return entries;
}

function shouldIncludeFile(packageName, relativePath) {
  if (relativePath.endsWith('.map') || relativePath.endsWith('.d.ts') || relativePath.endsWith('.ts')) {
    return false;
  }
  if (relativePath.startsWith('templates/')) {
    return true;
  }
  if (relativePath.startsWith('dist/')) {
    return relativePath.endsWith('.json') || relativePath.endsWith('.jsonld');
  }
  if (relativePath.startsWith('config/')) {
    return true;
  }
  if (relativePath.startsWith('bin/')) {
    return relativePath.endsWith('.js') || !path.extname(relativePath);
  }
  if (packageName === rootPackage.name && relativePath.startsWith('static/')) {
    return true;
  }
  return relativePath.endsWith('.json') || relativePath.endsWith('.jsonld');
}

function copyIfNeeded(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function normalizeImportRoot(relativePath) {
  return relativePath.replace(/\/+$/, '');
}

function resolvePackageDir(packageName) {
  if (packageName === rootPackage.name) {
    return repoRoot;
  }
  return path.join(repoRoot, 'node_modules', ...packageName.split('/'));
}

function resolveStageDir(packageName) {
  if (packageName === rootPackage.name) {
    return stageRoot;
  }
  return path.join(stageRoot, 'node_modules', ...packageName.split('/'));
}

function createMinimalPackageJson(pkg, bundleMainRelative) {
  const minimal = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    main: bundleMainRelative,
    'lsd:module': pkg['lsd:module'],
    'lsd:components': pkg['lsd:components'],
    'lsd:contexts': pkg['lsd:contexts'],
    'lsd:importPaths': pkg['lsd:importPaths'],
  };
  if (pkg.type) {
    minimal.type = pkg.type;
  }
  return minimal;
}

function createPackagePatchPlugin(packageName, packageDir) {
  if (packageName !== '@solid/community-server') {
    return undefined;
  }

  const normalize = (filePath) => filePath.split(path.sep).join(path.posix.sep);
  const pathUtilPath = normalize(path.join(packageDir, 'dist', 'util', 'PathUtil.js'));
  const baseFactoryPath = normalize(path.join(packageDir, 'dist', 'pods', 'generate', 'BaseComponentsJsFactory.js'));
  const templatedPodPath = normalize(path.join(packageDir, 'dist', 'pods', 'generate', 'TemplatedPodGenerator.js'));

  return {
    name: 'community-server-bundle-path-patch',
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (args) => {
        const normalizedPath = normalize(args.path);
        if (
          normalizedPath !== pathUtilPath &&
          normalizedPath !== baseFactoryPath &&
          normalizedPath !== templatedPodPath
        ) {
          return undefined;
        }

        let contents = fs.readFileSync(args.path, 'utf8');
        if (normalizedPath === pathUtilPath) {
          contents = contents.replace(
            "return joinFilePath(__dirname, '../../');",
            "return joinFilePath(__dirname, '../');",
          );
        }
        if (normalizedPath === baseFactoryPath) {
          contents = contents.replace(
            "constructor(relativeModulePath = '../../../', logLevel = 'error') {",
            "constructor(relativeModulePath = '../', logLevel = 'error') {",
          );
        }
        if (normalizedPath === templatedPodPath) {
          contents = contents.replace(
            "const DEFAULT_CONFIG_PATH = (0, PathUtil_1.joinFilePath)(__dirname, '../../../templates/config/');",
            "const DEFAULT_CONFIG_PATH = (0, PathUtil_1.joinFilePath)(__dirname, '../templates/config/');",
          );
        }

        return {
          contents,
          loader: 'js',
        };
      });
    },
  };
}

const kyUniversalBrowserPlugin = {
  name: 'ky-universal-browser-entry',
  setup(build) {
    build.onResolve({ filter: /^ky-universal$/ }, () => ({
      path: path.join(path.dirname(require.resolve('ky-universal')), 'browser.js'),
    }));
  },
};

// Every bundle and parser must share the same factory counter. Inlining
// separate copies gives unrelated RDF blank nodes the same identifier.
function sharedDataFactoryPlugin(bundleOutputPath) {
  const entryPath = path.join(stageRoot, 'node_modules', 'rdf-data-factory', 'index.js');
  const relativePath = path.relative(path.dirname(bundleOutputPath), entryPath).split(path.sep).join('/');
  return {
    name: 'shared-rdf-data-factory',
    setup(build) {
      build.onResolve({ filter: /^rdf-data-factory$/ }, () => ({
        path: relativePath.startsWith('.') ? relativePath : `./${relativePath}`,
        external: true,
      }));
    },
  };
}

// Logger state is module-local: CSS initialization and Xpod components must
// resolve one factory, including loggers created before initialization.
function sharedLoggerFactoryPlugin(bundleOutputPath) {
  const entryPath = path.join(stageRoot, 'node_modules', 'global-logger-factory', 'dist', '__bundle__.cjs');
  const relativePath = path.relative(path.dirname(bundleOutputPath), entryPath).split(path.sep).join('/');
  return {
    name: 'shared-global-logger-factory',
    setup(build) {
      build.onResolve({ filter: /^global-logger-factory$/ }, () => ({
        path: relativePath.startsWith('.') ? relativePath : `./${relativePath}`,
        external: true,
      }));
    },
  };
}

function copySharedDataFactory() {
  const packageDir = resolvePackageDir('rdf-data-factory');
  const stageDir = resolveStageDir('rdf-data-factory');
  for (const sourcePath of iterFiles(packageDir)) {
    const relativePath = path.relative(packageDir, sourcePath);
    if (relativePath === 'package.json' || relativePath === 'index.js' ||
      (relativePath.startsWith(`lib${path.sep}`) && relativePath.endsWith('.js'))) {
      copyIfNeeded(sourcePath, path.join(stageDir, relativePath));
    }
  }
}

// Compiled Bun cannot resolve bare specifiers in extracted node_modules
// (oven-sh/bun#27058). Components.js already discovered each package root;
// use that authoritative metadata rather than repeating package resolution.
const extractedComponentsPlugin = {
  name: 'extracted-components-package-resolution',
  setup(build) {
    build.onLoad({ filter: /ConstructionStrategyCommonJs\.js$/ }, (args) => {
      const source = fs.readFileSync(args.path, 'utf8');
      const resolver = 'this.req.resolve(options.requireName, { paths: [options.moduleState.mainModulePath] })';
      if (!source.includes(resolver)) {
        throw new Error('Components.js package resolver changed; revalidate the Bun single-file adapter.');
      }
      return { contents: source.replace(
        resolver,
        `(() => {
          const entry = Object.entries(options.moduleState.packageJsons).find(([, pkg]) => pkg.name === options.requireName);
          return entry ? Path.join(entry[0], entry[1].main || 'index.js')
            : this.req.resolve(options.requireName, { paths: [options.moduleState.mainModulePath] });
        })()`,
      ),
      loader: 'js' };
    });
  },
};

async function bundlePackageMain(packageName, packageDir, packageJson, stageDir) {
  const entryPoint = packageName === rootPackage.name
    ? path.join(packageDir, 'src', 'index.ts')
    : packageJson.main ? path.join(packageDir, packageJson.main) : undefined;
  if (!entryPoint) {
    return undefined;
  }
  const bundleMainRelative = path.posix.join('dist', '__bundle__.cjs');
  const bundleOutputPath = path.join(stageDir, bundleMainRelative);
  fs.mkdirSync(path.dirname(bundleOutputPath), { recursive: true });
  await esbuild.build({
    entryPoints: [entryPoint],
    outfile: bundleOutputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    external: COMMON_BUNDLE_EXTERNALS,
    plugins: [
      packageName === rootPackage.name && {
        name: 'shared-css-components',
        setup(build) {
          // DI constructs CSS components from this staged bundle. Subclasses
          // must share its provider/policy classes, whose checks use instanceof.
          // Only the public entry is external: private subpaths are not staged.
          build.onResolve({ filter: /^@solid\/community-server$/ }, () => ({
            path: '../node_modules/@solid/community-server/dist/__bundle__.cjs',
            external: true,
          }));
        },
      },
      createPackagePatchPlugin(packageName, packageDir), extractedComponentsPlugin,
      kyUniversalBrowserPlugin, sharedDataFactoryPlugin(bundleOutputPath),
      packageName !== 'global-logger-factory' && sharedLoggerFactoryPlugin(bundleOutputPath),
    ].filter(Boolean),
  });
  return bundleMainRelative;
}

function packageFileRoots(packageJson) {
  const roots = new Set();
  for (const value of Object.values(packageJson.bin || {})) {
    roots.add(normalizeImportRoot(value));
  }
  for (const value of Object.values(packageJson['lsd:importPaths'] || {})) {
    const normalized = normalizeImportRoot(value);
    roots.add(normalized);
    if (normalized.startsWith('templates/')) {
      roots.add('templates');
    }
  }
  if (packageJson['lsd:components']) {
    roots.add(normalizeImportRoot(path.dirname(packageJson['lsd:components'])));
  }
  for (const value of Object.values(packageJson['lsd:contexts'] || {})) {
    roots.add(normalizeImportRoot(path.dirname(value)));
  }
  return [ ...roots ].filter(Boolean);
}

const rootPackage = readJson(path.join(repoRoot, 'package.json'));

async function main() {
  copySharedDataFactory();
  const queue = [rootPackage.name, 'global-logger-factory'];
  const visited = new Set(['rdf-data-factory']);

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) {
      continue;
    }

    const packageDir = resolvePackageDir(packageName);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    const stageDir = resolveStageDir(packageName);
    fs.mkdirSync(stageDir, { recursive: true });

    const bundleMainRelative = await bundlePackageMain(packageName, packageDir, packageJson, stageDir);
    writeJson(path.join(stageDir, 'package.json'), createMinimalPackageJson(packageJson, bundleMainRelative ?? packageJson.main));

    for (const root of packageFileRoots(packageJson)) {
      const absoluteRoot = path.join(packageDir, root);
      for (const sourcePath of iterFiles(absoluteRoot)) {
        const relativePath = path.relative(packageDir, sourcePath).split(path.sep).join(path.posix.sep);
        if (!shouldIncludeFile(packageName, relativePath)) {
          continue;
        }
        copyIfNeeded(sourcePath, path.join(stageDir, relativePath));
        const text = fs.readFileSync(sourcePath, 'utf8');
        for (const ref of extractRefs(text)) {
          if (!visited.has(ref)) {
            queue.push(ref);
          }
        }
      }
    }

    visited.add(packageName);
  }

  // Runtime-only workspace packages.
  //
  // Components.js references pull in every *declared* dependency, but code paths
  // that load a package by specifier at request time (the AI gateway's
  // `@undefineds.co/solid-sdk/local-route-fetch` import) never appear there. The
  // compiled binary then resolved that specifier against the extracted runtime and
  // failed with `Cannot find module`, which surfaced as HTTP 500 from the AI
  // gateway. Stage them explicitly, keeping their ESM entry points intact.
  for (const packageName of RUNTIME_WORKSPACE_PACKAGES) {
    const packageDir = resolvePackageDir(packageName);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Runtime workspace package is missing: ${packageName}`);
    }
    const packageJson = readJson(packageJsonPath);
    const stageDir = resolveStageDir(packageName);
    for (const root of [ 'dist', 'src' ]) {
      const absoluteRoot = path.join(packageDir, root);
      for (const sourcePath of iterFiles(absoluteRoot)) {
        if (sourcePath.endsWith('.d.ts') || sourcePath.endsWith('.map') || sourcePath.endsWith('.ts')) {
          continue;
        }
        const relativePath = path.relative(packageDir, sourcePath).split(path.sep).join(path.posix.sep);
        copyIfNeeded(sourcePath, path.join(stageDir, relativePath));
      }
    }
    writeJson(path.join(stageDir, 'package.json'), {
      name: packageJson.name,
      version: packageJson.version,
      type: packageJson.type,
      main: packageJson.main,
      module: packageJson.module,
      exports: packageJson.exports,
    });
  }

  // Native CLIs the runtime spawns by path. Components.js reference walking
  // never discovers them, so stage the installed binary for the matching
  // target. A cross target fails here instead of embedding the host binary.
  const embeddedNativeCli = stageEmbeddedNativeCli(stageRoot, {
    nodeModulesRoot: path.join(repoRoot, 'node_modules'),
    compileTarget,
  });
  console.log(`[build:bun-single] embedded native CLI: ${embeddedNativeCli.join(', ')}`);

  const cliOutputPath = path.join(stageRoot, 'dist', '__cli__.cjs');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'cli', 'index.ts')],
    outfile: cliOutputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    external: COMMON_BUNDLE_EXTERNALS,
    plugins: [kyUniversalBrowserPlugin, sharedDataFactoryPlugin(cliOutputPath), sharedLoggerFactoryPlugin(cliOutputPath)],
  });

  const manifest = [];
  for (const sourcePath of iterFiles(stageRoot)) {
    const relativePath = path.relative(stageRoot, sourcePath).split(path.sep).join(path.posix.sep);
    const content = fs.readFileSync(sourcePath);
    manifest.push({
      path: relativePath,
      contentBase64: content.toString('base64'),
      mode: fs.statSync(sourcePath).mode & 0o777,
    });
  }

  manifest.sort((left, right) => left.path.localeCompare(right.path));
  const compressedManifest = zlib.brotliCompressSync(Buffer.from(JSON.stringify(manifest)), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
  });
  const manifestSha = crypto.createHash('sha256').update(compressedManifest).digest('hex');

  const generatedEntryPath = path.join(tempRoot, 'bun-single-entry.ts');
  fs.writeFileSync(generatedEntryPath, createSingleBinaryEntry(manifestSha, compressedManifest));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  run('bun', [
    'build',
    '--compile',
    ...(compileTarget ? [ `--target=${compileTarget}` ] : []),
    generatedEntryPath,
    '--outfile',
    outputPath,
  ]);

  const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
  console.log(`[build:bun-single] created ${path.relative(repoRoot, outputPath)} (${sizeMb} MB)`);
  console.log(`[build:bun-single] component package closure: ${[ ...visited ].sort().join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
