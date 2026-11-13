/** Regression for a REAL Gateway failure found by actually booting the compiled
 * binary: `openid-client` was missing at startup because
 * @inrupt/solid-client-authn-node was treated as "externally kept" and its own
 * dependency closure was never staged. The package keeps its manifest, but its
 * runtime dependencies must still be expanded, exactly as HEAD did.
 *
 * The fixture is generic on purpose: an externally-kept-shaped root package that
 * declares a runtime dependency must get that dependency staged.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { stageInstalledDependencyClosure } = require('../../scripts/lib/installed-dependency-closure.cjs');

const root = path.resolve(__dirname, '../..');

function writePackage(directory, manifest) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'index.js'), 'module.exports = {};\n');
}

test('an externally-kept-shaped entry package still expands its own runtime closure', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/authn-closure-'));
  try {
    const nodeModules = path.join(dir, 'node_modules');
    // Shaped like @inrupt/solid-client-authn-node: a real package with its own deps.
    writePackage(path.join(nodeModules, '@fixture/authn-entry'), {
      name: '@fixture/authn-entry', version: '1.0.0',
      dependencies: { 'authn-token-client': '^5.7.1', 'authn-jose': '^5.1.3' },
    });
    writePackage(path.join(nodeModules, 'authn-token-client'), { name: 'authn-token-client', version: '5.7.1' });
    writePackage(path.join(nodeModules, 'authn-jose'), { name: 'authn-jose', version: '5.1.3' });

    const stageRoot = path.join(dir, 'package');
    // The build stages canonical/entry roots BEFORE calling the closure, which is
    // what makes their presence a precondition here.
    fs.cpSync(path.join(nodeModules, '@fixture/authn-entry'),
      path.join(stageRoot, 'node_modules/@fixture/authn-entry'), { recursive: true });
    const staged = stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      // Seeded exactly like the build seeds the runtime entry package.
      canonicalPackages: ['@fixture/authn-entry'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: () => true,
    });

    // The entry package is staged AND its declared runtime deps are expanded.
    assert.ok(fs.existsSync(path.join(stageRoot, 'node_modules/@fixture/authn-entry')));
    assert.ok(fs.existsSync(path.join(stageRoot, 'node_modules/authn-token-client')), 'runtime dependency must be staged');
    assert.ok(fs.existsSync(path.join(stageRoot, 'node_modules/authn-jose')), 'runtime dependency must be staged');
    assert.ok(staged.rootNames.has('authn-token-client'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
