#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  getCurrentPlatformTarget,
  resolvePlatformTarget,
} = require('./platform-binaries.cjs');

const repoRoot = path.resolve(__dirname, '..');

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
      'README.md',
      'LICENSE',
    ],
    xpodBinary: `./${target.binaryName}`,
  };

  if (target.libc) {
    packageJson.libc = target.libc;
  }

  return packageJson;
}

function buildPlatformPackage(targetRef, options = {}) {
  const target = targetRef === 'current'
    ? getCurrentPlatformTarget()
    : resolvePlatformTarget(targetRef);

  if (!target) {
    throw new Error(`Unsupported platform target: ${targetRef ?? '(missing)'}`);
  }

  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const stageDir = options.stageDir ?? path.join(repoRoot, 'dist', 'npm', target.id);
  const binaryOutputPath = path.join(stageDir, target.binaryName);
  const relativeBinaryOutputPath = path.relative(repoRoot, binaryOutputPath);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  run(process.execPath, [
    'scripts/build-bun-single.js',
    `--target=${target.bunTarget}`,
    `--output=${relativeBinaryOutputPath}`,
  ]);

  writeJson(path.join(stageDir, 'package.json'), createStagePackageJson(rootPackage, target));
  fs.writeFileSync(path.join(stageDir, 'README.md'), createReadme(rootPackage, target));
  fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  if (process.platform !== 'win32') {
    fs.chmodSync(binaryOutputPath, 0o755);
  }

  return {
    target,
    stageDir,
    binaryOutputPath,
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
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildPlatformPackage(args.target ?? 'current');
  if (args.pack) {
    packStageDirectory(result.stageDir);
  }
  console.log(`[build:platform-package] ${result.target.packageName} -> ${path.relative(repoRoot, result.stageDir)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  buildPlatformPackage,
};
