#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

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

function main() {
  const repoRoot = process.cwd();
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const originalRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(originalRaw);

  const nextVersion = buildLocalVersion(packageJson.version);
  packageJson.version = nextVersion;

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`[publish:local] version bumped to ${nextVersion}`);

  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';

  try {
    run('yarn build:single');
    const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
    fs.mkdirSync(npmCacheDir, { recursive: true });
    run(`npm publish --registry ${publishRegistry} --tag local --access public${dryRun ? ' --dry-run' : ''}`, {
      npm_config_cache: npmCacheDir,
      npm_config_registry: publishRegistry,
    });
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
