#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const backupPath = path.join(repoRoot, '.test-data', 'package.json.pack.backup');

function sanitizeManifest(pkg) {
  const nextPkg = { ...pkg };
  if (nextPkg.scripts) {
    const nextScripts = { ...nextPkg.scripts };
    delete nextScripts.postinstall;
    delete nextScripts.prepack;
    delete nextScripts.postpack;
    nextPkg.scripts = nextScripts;
  }

  delete nextPkg.bundleDependencies;
  delete nextPkg.bundledDependencies;

  return nextPkg;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'pack' && mode !== 'restore') {
    throw new Error('Usage: node scripts/prepare-package-manifest.cjs <pack|restore>');
  }

  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  if (mode === 'pack') {
    const originalRaw = fs.readFileSync(packageJsonPath, 'utf8');
    fs.writeFileSync(backupPath, originalRaw);
    const pkg = JSON.parse(originalRaw);
    writeJson(packageJsonPath, sanitizeManifest(pkg));
    return;
  }

  if (!fs.existsSync(backupPath)) {
    return;
  }

  const backupRaw = fs.readFileSync(backupPath, 'utf8');
  fs.writeFileSync(packageJsonPath, backupRaw);
  fs.rmSync(backupPath, { force: true });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
