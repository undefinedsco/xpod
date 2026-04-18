#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { applyPlatformOptionalDependencies } = require('./platform-binaries.cjs');

function writePackageJson(packageJsonPath, packageJson) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function stagePackageJson(repoRoot) {
  execFileSync('git', [ 'add', 'package.json' ], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const shouldStage = process.argv.includes('--stage');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const before = JSON.stringify(packageJson.optionalDependencies ?? {});

  applyPlatformOptionalDependencies(packageJson, packageJson.version);

  const after = JSON.stringify(packageJson.optionalDependencies ?? {});
  if (before !== after) {
    writePackageJson(packageJsonPath, packageJson);
    console.log(`[sync:platform-package-version] synced optionalDependencies to ${packageJson.version}`);
  } else {
    console.log(`[sync:platform-package-version] already synced to ${packageJson.version}`);
  }

  if (shouldStage) {
    stagePackageJson(repoRoot);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
