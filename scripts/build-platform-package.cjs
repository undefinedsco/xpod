#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  EMBEDDED_SOURCE_MANIFEST_RELATIVE_PATH,
  EMBEDDED_SOURCE_RELATIVE_PATH,
  getCurrentPlatformTarget,
  QLEVER_LOCAL_RUNTIME_RELATIVE_PATH,
  resolvePlatformTarget,
} = require('./platform-binaries.cjs');
const { stageEmbeddedNativeSource } = require('./lib/embedded-native-source.cjs');
const { verifyPlatformPackageBudget } = require('./lib/platform-package-budget.cjs');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_CACHE_DIR = path.join(repoRoot, 'node_modules', '.cache', 'xpod-embedded-native-source');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readNonEmptyEnv(key) {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createReadme(rootPackage, target) {
  return [
    `# ${target.packageName}`,
    '',
    `Prebuilt ${target.label} Bun binary for \`${rootPackage.name}\`.`,
    '',
    'This package is installed automatically as an optional dependency of the main `@undefineds.co/xpod` package on matching platforms.',
    '',
    'It is not intended to be imported directly.',
    '',
  ].join('\n');
}

function createStagePackageJson(rootPackage, target) {
  const packageJson = {
    name: target.packageName,
    version: rootPackage.version,
    description: `Prebuilt ${target.label} binary for ${rootPackage.name}`,
    license: rootPackage.license,
    repository: rootPackage.repository,
    private: false,
    os: target.os,
    cpu: target.cpu,
    files: [
      target.binaryName,
      'qlever',
      EMBEDDED_SOURCE_RELATIVE_PATH,
      'README.md',
      'LICENSE',
    ],
    xpodBinary: `./${target.binaryName}`,
    xpodQleverLocalRuntime: `./${QLEVER_LOCAL_RUNTIME_RELATIVE_PATH}`,
    xpodEmbeddedSource: `./${EMBEDDED_SOURCE_MANIFEST_RELATIVE_PATH}`,
  };

  if (target.libc) {
    packageJson.libc = target.libc;
  }

  return packageJson;
}

function resolveQleverRuntimeArtifactPath(options = {}) {
  const artifactPath = options.qleverRuntimeArtifactPath
    ?? readNonEmptyEnv('XPOD_QLEVER_LOCAL_RUNTIME_ARTIFACT');
  if (!artifactPath) {
    throw new Error('Missing QLever local runtime artifact: pass --qlever-runtime-artifact=<path> or set XPOD_QLEVER_LOCAL_RUNTIME_ARTIFACT');
  }

  const resolvedPath = path.resolve(repoRoot, artifactPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile() || !resolvedPath.endsWith('.tar.gz')) {
    throw new Error(`QLever local runtime artifact does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
}

function extractQleverRuntimeArtifact(stageDir, artifactPath) {
  const runtimeOutputPath = path.join(stageDir, QLEVER_LOCAL_RUNTIME_RELATIVE_PATH);
  const runtimeRoot = path.join(stageDir, 'qlever');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const result = spawnSync('tar', [ '-xzf', artifactPath, '-C', runtimeRoot ], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract QLever local runtime artifact: ${artifactPath}`);
  }
  if (!fs.existsSync(runtimeOutputPath) || !fs.statSync(runtimeOutputPath).isFile()) {
    throw new Error(`QLever local runtime archive is missing ${QLEVER_LOCAL_RUNTIME_RELATIVE_PATH}`);
  }
  fs.chmodSync(runtimeOutputPath, 0o755);
  return runtimeOutputPath;
}

async function buildPlatformPackage(targetRef, options = {}) {
  const target = targetRef === 'current'
    ? getCurrentPlatformTarget()
    : resolvePlatformTarget(targetRef);

  if (!target) {
    throw new Error(`Unsupported platform target: ${targetRef ?? '(missing)'}`);
  }

  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const stageDir = options.stageDir ?? path.join(repoRoot, 'dist', 'npm', target.id);
  const qleverRuntimeArtifactPath = resolveQleverRuntimeArtifactPath(options);
  const binaryOutputPath = path.join(stageDir, target.binaryName);
  const relativeBinaryOutputPath = path.relative(repoRoot, binaryOutputPath);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  run(process.execPath, [
    'scripts/build-bun-single.js',
    `--target=${target.bunTarget}`,
    `--output=${relativeBinaryOutputPath}`,
  ]);
  const qleverRuntimeOutputPath = extractQleverRuntimeArtifact(stageDir, qleverRuntimeArtifactPath);

  // Corresponding Source for the embedded native CLI. Ships as a sidecar, never
  // inside the Bun binary. Drift in the installed package, binary, license,
  // archive or embedded docs fails the build.
  const source = await stageEmbeddedNativeSource(stageDir, {
    target: target.id,
    nodeModulesRoot: path.join(repoRoot, 'node_modules'),
    artifactPath: options.sourceArtifactPath,
    docsRoot: options.sourceDocsRoot,
    cacheDir: options.sourceCacheDir ?? DEFAULT_SOURCE_CACHE_DIR,
  });

  const packageJson = createStagePackageJson(rootPackage, target);
  packageJson.xpodEmbeddedSourceSha256 = source.manifestSha256;
  writeJson(path.join(stageDir, 'package.json'), packageJson);
  fs.writeFileSync(path.join(stageDir, 'README.md'), createReadme(rootPackage, target));
  fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  if (process.platform !== 'win32') {
    fs.chmodSync(binaryOutputPath, 0o755);
  }

  // Measure the actual gzip tarball, including all fixed source/runtime files,
  // before either desktop/RC packaging or stable publication can proceed.
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: stageDir,
    encoding: 'utf8',
  });
  if (packed.status !== 0) {
    throw new Error(`Platform package preflight failed: ${packed.stderr}`);
  }
  const pack = JSON.parse(packed.stdout)[0];
  writeJson(`${stageDir}-pack.json`, [pack]);
  const publicationBudget = verifyPlatformPackageBudget(pack, target, rootPackage.version);
  const publicationBudgetPath = `${stageDir}-pack-budget.json`;
  writeJson(publicationBudgetPath, publicationBudget);

  return {
    publicationBudget,
    publicationBudgetPath,
    target,
    stageDir,
    binaryOutputPath,
    qleverRuntimeOutputPath,
    sourceManifestSha256: source.manifestSha256,
    sourceFiles: source.files,
  };
}

function packStageDirectory(stageDir) {
  run('npm', [ 'pack' ], { cwd: stageDir });
}

function parseArgs(argv) {
  const args = {
    pack: false,
    target: undefined,
  };

  for (const arg of argv) {
    if (arg === '--pack') {
      args.pack = true;
      continue;
    }

    if (arg === '--current') {
      args.target = 'current';
      continue;
    }

    if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
      continue;
    }

    if (arg.startsWith('--qlever-runtime-artifact=')) {
      args.qleverRuntimeArtifactPath = arg.slice('--qlever-runtime-artifact='.length);
      continue;
    }

    if (arg.startsWith('--source-artifact=')) {
      args.sourceArtifactPath = path.resolve(repoRoot, arg.slice('--source-artifact='.length));
      continue;
    }

    if (arg.startsWith('--source-docs=')) {
      args.sourceDocsRoot = path.resolve(repoRoot, arg.slice('--source-docs='.length));
      continue;
    }

    if (arg.startsWith('--source-cache-dir=')) {
      args.sourceCacheDir = path.resolve(repoRoot, arg.slice('--source-cache-dir='.length));
      continue;
    }

    if (arg.startsWith('--stage-dir=')) {
      args.stageDir = path.resolve(repoRoot, arg.slice('--stage-dir='.length));
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildPlatformPackage(args.target ?? 'current', {
    qleverRuntimeArtifactPath: args.qleverRuntimeArtifactPath,
    sourceArtifactPath: args.sourceArtifactPath,
    sourceDocsRoot: args.sourceDocsRoot,
    sourceCacheDir: args.sourceCacheDir,
    stageDir: args.stageDir,
  });
  if (args.pack) {
    packStageDirectory(result.stageDir);
  }
  console.log(`[build:platform-package] ${result.target.packageName} -> ${path.relative(repoRoot, result.stageDir)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildPlatformPackage,
  extractQleverRuntimeArtifact,
  createStagePackageJson,
  resolveQleverRuntimeArtifactPath,
};
