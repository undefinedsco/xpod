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

function capture(command, extraEnv = {}) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'inherit' ],
    env: { ...process.env, ...extraEnv },
  });
}

function main() {
  const repoRoot = process.cwd();
  const dryRun = process.argv.includes('--dry-run') || process.env.XPOD_PUBLISH_DRY_RUN === 'true';
  const publishRegistry = process.env.XPOD_NPM_REGISTRY || 'https://registry.npmjs.org';

  run('bun run build');

  const npmCacheDir = path.join(repoRoot, '.test-data', 'npm-cache');
  const packDir = path.join(repoRoot, '.test-data', 'npm-pack');
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });

  const npmEnv = {
    npm_config_cache: npmCacheDir,
    npm_config_registry: publishRegistry,
  };
  const packJsonRaw = capture(`npm pack --json --silent --pack-destination ${JSON.stringify(packDir)}`, npmEnv);
  const packJsonPath = path.join(packDir, 'pack.json');
  fs.writeFileSync(packJsonPath, packJsonRaw);
  run(`node scripts/check-pack-json.cjs ${JSON.stringify(packJsonPath)}`);
  const pack = JSON.parse(packJsonRaw)[0];
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
