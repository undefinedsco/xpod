#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { applyPlatformOptionalDependencies } = require('./platform-binaries.cjs');

function buildLocalVersion(currentVersion) {
  const [core] = currentVersion.split('-');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  return `${core}-local.${stamp}`;
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
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const originalRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(originalRaw);

  const nextVersion = buildLocalVersion(packageJson.version);
  packageJson.version = nextVersion;
  applyPlatformOptionalDependencies(packageJson, nextVersion);

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`[publish:local] version bumped to ${nextVersion}`);

  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';

  try {
    run('bun run build');

    const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
    const packDir = path.join(repoRoot, '.test-data', 'npm-pack');
    fs.mkdirSync(npmCacheDir, { recursive: true });
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.mkdirSync(packDir, { recursive: true });

    const npmEnv = {
      npm_config_cache: npmCacheDir,
      npm_config_registry: publishRegistry,
      XPOD_NPM_REGISTRY: publishRegistry,
    };

    run(`node scripts/run-npm-pack.cjs ${JSON.stringify(packDir)} ${JSON.stringify(npmCacheDir)}`, npmEnv);

    const packJsonPath = path.join(packDir, 'pack.json');
    run(`node scripts/check-pack-json.cjs ${JSON.stringify(packJsonPath)}`);

    run(`node scripts/publish-platform-packages.cjs --tag=local${dryRun ? ' --dry-run' : ''}`, npmEnv);

    const pack = readPackMetadata(packJsonPath);
    const tarballPath = path.join(packDir, pack.filename);
    run(`npm publish ${JSON.stringify(tarballPath)} --registry ${publishRegistry} --tag local --access public${dryRun ? ' --dry-run' : ''}`, npmEnv);
  } catch (error) {
    fs.writeFileSync(packageJsonPath, originalRaw);
    console.error('[publish:local] failed, package.json restored');
    throw error;
  } finally {
    fs.writeFileSync(packageJsonPath, originalRaw);
  }

  console.log(`[publish:local] ${dryRun ? 'dry-run complete' : 'publish complete'}, package.json restored`);
  console.log(`[publish:local] registry: ${publishRegistry}`);
  console.log(`[publish:local] published ${packageJson.name}@${nextVersion} with tag=local${dryRun ? ' (dry-run)' : ''}`);
}

try {
  main();
} catch (error) {
  process.exit(1);
}
