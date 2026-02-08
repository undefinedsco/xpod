#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function run(command, extraEnv = {}) {
  execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function main() {
  const repoRoot = process.cwd();
  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';

  run('yarn build:single');

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  fs.mkdirSync(npmCacheDir, { recursive: true });

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
