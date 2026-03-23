#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';

function readNonEmptyEnv(key) {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function run(command, extraEnv = {}) {
  execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function readPackMetadata(packJsonPath) {
  const items = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
  const pack = Array.isArray(items) ? items[0] : items;
  if (!pack?.filename) {
    throw new Error(`No tarball filename found in ${packJsonPath}`);
  }
  return pack;
}

function main() {
  const repoRoot = process.cwd();
  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const skipBuild = process.argv.includes('--skip-build');
  const publishRegistry = readNonEmptyEnv('XPOD_PUBLISH_REGISTRY') || OFFICIAL_NPM_REGISTRY;
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const mismatches = getPlatformDependencyMismatches(packageJson, packageJson.version);

  if (mismatches.length > 0) {
    console.error('[publish:release] package.json optionalDependencies do not match version');
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch.packageName}: expected ${mismatch.expected}, got ${mismatch.actual ?? '(missing)'}`);
    }
    process.exit(1);
  }

  if (!skipBuild) {
    run('bun run build');
  }

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  const packDir = path.join(repoRoot, '.test-data', 'npm-pack');
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });

  const npmEnv = {
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
  };

  run(`node scripts/run-npm-pack.cjs ${JSON.stringify(packDir)} ${JSON.stringify(npmCacheDir)}`, npmEnv);

  const packJsonPath = path.join(packDir, 'pack.json');
  run(`node scripts/check-pack-json.cjs ${JSON.stringify(packJsonPath)}`);

  run(`node scripts/publish-platform-packages.cjs${dryRun ? ' --dry-run' : ''}`, npmEnv);

  const pack = readPackMetadata(packJsonPath);
  const tarballPath = path.join(packDir, pack.filename);
  run(`npm publish ${JSON.stringify(tarballPath)} --registry ${publishRegistry} --access public${dryRun ? ' --dry-run' : ''}`, npmEnv);

  console.log(`[publish:release] ${dryRun ? 'dry-run complete' : 'publish complete'}`);
  console.log(`[publish:release] registry: ${publishRegistry}`);
}

try {
  main();
} catch (_error) {
  process.exit(1);
}
