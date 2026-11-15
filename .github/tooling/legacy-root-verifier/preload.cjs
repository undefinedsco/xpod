const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
try {
  if (process.versions.bun || process.versions.node.split('.')[0] !== '22') throw new Error('Verifier requires actual Node 22');
  const repository = fs.realpathSync(path.resolve(__dirname, '../../..'));
  if (fs.realpathSync(process.argv[1]) !== path.join(repository, 'scripts/release-gate-evidence.cjs') || process.argv[2] !== 'verify-root-compat') throw new Error('Tooling preload is only for the original root compatibility verifier');
  const supplied = process.env.NODE_PATH;
  if (!supplied || supplied.includes(path.delimiter) || /[\x00-\x1f\x7f]/u.test(supplied)) throw new Error('Exactly one explicit verifier NODE_PATH required');
  const modules = fs.realpathSync(supplied), tooling = path.dirname(modules);
  if (modules !== path.resolve(supplied) || path.basename(modules) !== 'node_modules' || inside(repository, tooling)) throw new Error('Verifier dependency scope is not isolated');
  for (const file of ['package.json', 'bun.lock', '.npmrc']) if (!fs.readFileSync(path.join(tooling, file)).equals(fs.readFileSync(path.join(__dirname, file)))) throw new Error('Verifier tooling source/lock mismatch');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')));
  const { resolveCatalogManifest } = require('../../../scripts/prepare-package-manifest.cjs');
  const rootManifest = resolveCatalogManifest(JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))));
  if (Object.keys(manifest.dependencies).join(',') !== 'semver' || manifest.dependencies.semver !== rootManifest.devDependencies.semver) throw new Error('Verifier dependency contract mismatch');
  const validatorRequire = Module.createRequire(path.join(repository, 'scripts/lib/root-registry-supply.cjs'));
  const entry = validatorRequire.resolve('semver'), packageFile = validatorRequire.resolve('semver/package.json');
  const expected = fs.realpathSync(path.join(modules, 'semver'));
  if (!inside(modules, expected) || !inside(expected, fs.realpathSync(entry)) || !inside(expected, fs.realpathSync(packageFile))) throw new Error('Verifier dependency escaped locked tooling: semver');
  const semver = validatorRequire('semver/package.json');
  if (semver.name !== 'semver' || semver.version !== manifest.dependencies.semver) throw new Error('Verifier semver identity mismatch');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const receipt = { kind: 'legacy-root-verifier-tooling', actualNode: process.versions.node, executable: fs.realpathSync(process.execPath),
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    manifestSHA256: hash(path.join(__dirname, 'package.json')), lockSHA256: hash(path.join(__dirname, 'bun.lock')),
    preloadSHA256: hash(__filename), semver: { version: semver.version, entry: fs.realpathSync(entry), entrySHA256: hash(entry) },
    scope: 'Locked tooling provenance only; does not grant evidence acceptance' };
  fs.writeFileSync(path.join(tooling, 'verification.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('[legacy-verifier-tooling] ' + JSON.stringify(receipt));
} catch (error) {
  console.error('[legacy-verifier-tooling] ' + error.message); process.exit(1);
}
