const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '../../..');
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
function prepare(parent) {
  if (process.versions.bun || process.versions.node.split('.')[0] !== '22') throw new Error('Verifier tooling requires actual Node 22');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')));
  const { resolveCatalogManifest } = require('../../../scripts/prepare-package-manifest.cjs');
  const rootManifest = resolveCatalogManifest(JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))));
  if (manifest.dependencies.semver !== rootManifest.devDependencies.semver || manifest.packageManager !== rootManifest.packageManager) throw new Error('Verifier tooling pin differs from repository authority');
  const base = fs.realpathSync(parent);
  if (inside(fs.realpathSync(repository), base) || /[\x00-\x1f\x7f]/u.test(base)) throw new Error('Verifier tooling must be outside the checkout');
  const directory = fs.mkdtempSync(path.join(base, 'xpod-legacy-verifier-'));
  for (const file of ['package.json', 'bun.lock', '.npmrc']) fs.copyFileSync(path.join(__dirname, file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
  const version = spawnSync('bun', ['--version'], { env, encoding: 'utf8' });
  if (version.error || version.status !== 0 || 'bun@' + version.stdout.trim() !== manifest.packageManager) throw new Error('Locked verifier Bun version mismatch');
  const install = spawnSync('bun', ['install', '--cwd', directory, '--frozen-lockfile', '--ignore-scripts'], { cwd: directory, env, stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0 || install.signal) throw new Error('Isolated verifier tooling install failed');
  const nodePath = fs.realpathSync(path.join(directory, 'node_modules'));
  const preload = path.join(__dirname, 'preload.cjs');
  const output = { directory, 'node-path': nodePath, 'node-options': '--require ' + JSON.stringify(preload) };
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => key + '=' + value + '\n').join(''));
  console.log(JSON.stringify({ kind: 'legacy-verifier-tooling-preparation', ...output,
    manifestSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'package.json'))).digest('hex'),
    lockSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'bun.lock'))).digest('hex'), actualNode: process.versions.node, actualBun: version.stdout.trim() }));
  return output;
}
module.exports = { prepare };
if (require.main === module) {
  try { prepare(process.argv[2]); } catch (error) { console.error('[legacy-verifier-tooling] ' + error.message); process.exitCode = 1; }
}
