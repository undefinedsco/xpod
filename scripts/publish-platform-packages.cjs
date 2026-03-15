#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildPlatformPackage } = require('./build-platform-package.cjs');
const { PLATFORM_TARGETS } = require('./platform-binaries.cjs');

const repoRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    tag: undefined,
    targets: [],
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (arg.startsWith('--tag=')) {
      args.tag = arg.slice('--tag='.length);
      continue;
    }

    if (arg.startsWith('--target=')) {
      args.targets.push(arg.slice('--target='.length));
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';
  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  fs.mkdirSync(npmCacheDir, { recursive: true });

  const targets = args.targets.length > 0
    ? args.targets
    : PLATFORM_TARGETS.map((target) => target.id);

  for (const target of targets) {
    const { target: targetMeta, stageDir } = buildPlatformPackage(target);
    const publishArgs = [
      'publish',
      stageDir,
      '--registry',
      publishRegistry,
      '--access',
      'public',
    ];

    if (args.tag) {
      publishArgs.push('--tag', args.tag);
    }
    if (args.dryRun) {
      publishArgs.push('--dry-run');
    }

    run('npm', publishArgs, {
      env: {
        npm_config_cache: npmCacheDir,
        npm_config_registry: publishRegistry,
      },
    });
    console.log(`[publish:platform-packages] published ${targetMeta.packageName}${args.dryRun ? ' (dry-run)' : ''}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
