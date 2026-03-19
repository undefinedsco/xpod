#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function main() {
  const repoRoot = process.cwd();
  const packDir = path.resolve(repoRoot, process.argv[2] || '.test-data/npm-pack');
  const cacheDir = path.resolve(repoRoot, process.argv[3] || '.test-data/npm-cache');

  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const stdout = execFileSync(getNpmCommand(), [
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packDir,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
    stdio: [ 'ignore', 'pipe', 'inherit' ],
  });

  const packJsonPath = path.join(packDir, 'pack.json');
  fs.writeFileSync(packJsonPath, stdout);

  const pack = JSON.parse(stdout)[0];
  if (!pack?.filename) {
    throw new Error('npm pack did not return a filename');
  }

  console.log(`[npm-pack] wrote ${packJsonPath}`);
  console.log(`[npm-pack] tarball ${path.join(packDir, pack.filename)}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
