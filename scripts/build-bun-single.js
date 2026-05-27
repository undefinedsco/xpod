#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
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
    console.error('Please run `yarn build` first.');
    process.exit(1);
  }
}

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

async function bundlePackageMain(packageName, packageDir, packageJson, stageDir) {
  const entryPoint = packageName === rootPackage.name
    ? path.join(packageDir, 'src', 'cli', 'index.ts')
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
    plugins: [createPackagePatchPlugin(packageName, packageDir)].filter(Boolean),
  });
  return bundleMainRelative;
}

function packageFileRoots(packageJson) {
  const roots = new Set();
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
  const queue = [rootPackage.name];
  const visited = new Set();

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
  const compressedManifest = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)));
  const manifestSha = crypto.createHash('sha256').update(compressedManifest).digest('hex');

  const generatedEntryPath = path.join(tempRoot, 'bun-single-entry.ts');
  fs.writeFileSync(generatedEntryPath, [
    'import crypto from \'node:crypto\';',
    'import fs from \'node:fs\';',
    'import os from \'node:os\';',
    'import path from \'node:path\';',
    'import zlib from \'node:zlib\';',
    'import { pathToFileURL } from \'node:url\';',
    '',
    `const ARCHIVE_SHA256 = '${manifestSha}';`,
    `const MANIFEST_BASE64 = '${compressedManifest.toString('base64')}';`,
    '',
    'function resolveCacheRoot(): string {',
    '  const candidates = [',
    '    process.env.XPOD_BUN_SINGLE_CACHE_DIR,',
    '    path.join(os.tmpdir(), \'xpod-bun-cache\'),',
    '    path.join(os.homedir(), \'.xpod\', \'bun-single-cache\'),',
    '  ].filter((value): value is string => typeof value === \'string\' && value.length > 0);',
    '  for (const candidate of candidates) {',
    '    try {',
    '      const absolute = path.resolve(candidate);',
    '      fs.mkdirSync(absolute, { recursive: true });',
    '      return absolute;',
    '    } catch {',
    '    }',
    '  }',
    '  throw new Error(\'No writable cache directory found for Bun single binary.\');',
    '}',
    '',
    'function ensureExtracted(cacheDir: string): void {',
    '  const marker = path.join(cacheDir, \'.xpod-bun-single-ready\');',
    '  if (fs.existsSync(marker)) {',
    '    return;',
    '  }',
    '  fs.mkdirSync(cacheDir, { recursive: true });',
    '  const compressedManifest = Buffer.from(MANIFEST_BASE64, \'base64\');',
    '  const actualSha = crypto.createHash(\'sha256\').update(compressedManifest).digest(\'hex\');',
    '  if (actualSha !== ARCHIVE_SHA256) {',
    '    throw new Error(\'Embedded manifest checksum mismatch.\');',
    '  }',
    '  const manifest = JSON.parse(zlib.gunzipSync(compressedManifest).toString(\'utf8\')) as Array<{ path: string; contentBase64: string; mode: number }>;',
    '  for (const item of manifest) {',
    '    const targetPath = path.join(cacheDir, item.path);',
    '    fs.mkdirSync(path.dirname(targetPath), { recursive: true });',
    '    fs.writeFileSync(targetPath, Buffer.from(item.contentBase64, \'base64\'));',
    '    if (process.platform !== \'win32\' && typeof item.mode === \'number\') {',
    '      fs.chmodSync(targetPath, item.mode);',
    '    }',
    '  }',
    '  fs.writeFileSync(marker, new Date().toISOString());',
    '}',
    '',
    'async function main(): Promise<void> {',
    '  const cacheRoot = resolveCacheRoot();',
    '  const cacheDir = path.join(cacheRoot, ARCHIVE_SHA256.slice(0, 16));',
    '  ensureExtracted(cacheDir);',
    '  const entryPath = path.join(cacheDir, \'dist\', \'__bundle__.cjs\');',
    '  const argv0 = process.argv[0] ?? process.execPath;',
    '  const userArgs = process.argv.length > 1 ? process.argv.slice(1) : [];',
    '  process.argv = [argv0, entryPath, ...userArgs];',
    '  process.chdir(cacheDir);',
    '  await import(pathToFileURL(entryPath).href);',
    '}',
    '',
    'void main();',
    '',
  ].join('\n'));

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
