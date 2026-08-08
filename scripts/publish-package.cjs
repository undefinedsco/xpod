#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const packageDir = process.argv[2];
if (!packageDir) {
  console.error('usage: node scripts/publish-package.cjs <package-dir> [--dry-run]');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');

const manifestPath = path.join(packageDir, 'package.json');
const original = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function resolveWorkspaceVersion(name) {
  const targetPath = path.join(__dirname, '..', 'packages', name.replace(/^@undefineds\.co\//, ''), 'package.json');
  if (!fs.existsSync(targetPath)) {
    throw new Error(`cannot resolve workspace dependency ${name} (${targetPath})`);
  }
  return JSON.parse(fs.readFileSync(targetPath, 'utf8')).version;
}

let rewritten = 0;
for (const field of DEP_FIELDS) {
  const deps = manifest[field];
  if (!deps) continue;
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      deps[name] = `^${resolveWorkspaceVersion(name)}`;
      rewritten += 1;
    }
  }
}

if (rewritten > 0) {
  console.log(`[publish:package] rewrote ${rewritten} workspace:* dependencies`);
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
try {
  execSync(`npm publish --access public${dryRun ? ' --dry-run' : ''}`, {
    cwd: packageDir,
    stdio: 'inherit',
  });
} finally {
  fs.writeFileSync(manifestPath, original);
}
