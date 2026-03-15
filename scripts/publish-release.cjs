#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');

function run(command, extraEnv = {}) {
  execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function main() {
  const repoRoot = process.cwd();
  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const skipBuild = process.argv.includes('--skip-build');
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';
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
    run('yarn build');
  }

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  fs.mkdirSync(npmCacheDir, { recursive: true });

  run(`node scripts/publish-platform-packages.cjs${dryRun ? ' --dry-run' : ''}`, {
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
    XPOD_NPM_REGISTRY: publishRegistry,
  });

  run(`npm publish --registry ${publishRegistry} --access public${dryRun ? ' --dry-run' : ''}`, {
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
  });

  console.log(`[publish:release] ${dryRun ? 'dry-run complete' : 'publish complete'}`);
  console.log(`[publish:release] registry: ${publishRegistry}`);
}

try {
  main();
} catch (_error) {
  process.exit(1);
}
