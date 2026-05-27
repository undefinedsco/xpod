#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { getPlatformDependencyMismatches } = require('./platform-binaries.cjs');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const mismatches = getPlatformDependencyMismatches(packageJson, packageJson.version);

  if (mismatches.length === 0) {
    console.log('[check:platform-package-version] OK');
    return;
  }

  console.error('[check:platform-package-version] optionalDependencies must match package version:');
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch.packageName}: expected ${mismatch.expected}, got ${mismatch.actual ?? '(missing)'}`);
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
