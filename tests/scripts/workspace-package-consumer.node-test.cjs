const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyInstalled, exportEntries } = require('../../scripts/workspace-package-consumer.cjs');
const { assertSource, compareStable } = require('../../scripts/publish-workspace-packages.cjs');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-consumer-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const directory = path.join(root, 'node_modules', '@fixture/applet');
  const manifest = { name: '@fixture/applet', version: '1.0.0', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './style.css': './dist/style.css' } };
  fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'dist/index.js'), 'export const applet = true;');
  fs.writeFileSync(path.join(directory, 'dist/index.d.ts'), 'export declare const applet: boolean;');
  fs.writeFileSync(path.join(directory, 'dist/style.css'), '.applet { display: block; }');
  try { callback(root, directory, manifest); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('consumer resolves actual exported modules in an isolated install', () => fixture((root, directory, manifest) => {
  assert.equal(verifyInstalled(root, [manifest]), 1);
  execFileSync('bun', ['imports.mjs'], { cwd: root });
  fs.writeFileSync(path.join(directory, 'dist/index.js'), "import './missing.js';");
  assert.throws(() => execFileSync('bun', ['imports.mjs'], { cwd: root, stdio: 'pipe' }));
}));
test('consumer rejects wrong versions, missing types and empty CSS', () => fixture((root, directory, manifest) => {
  assert.throws(() => verifyInstalled(root, [{ ...manifest, version: '2.0.0' }]), /version/);
  fs.writeFileSync(path.join(directory, 'dist/style.css'), '');
  assert.throws(() => verifyInstalled(root, [manifest]), /Empty stylesheet/);
  fs.rmSync(path.join(directory, 'dist/index.d.ts'));
  assert.throws(() => verifyInstalled(root, [manifest]));
}));
test('export contract rejects JS without types and escaping paths', () => {
  assert.throws(() => exportEntries({ name: 'bad', exports: { '.': { import: './dist/index.js' } } }), /declaration/);
  assert.throws(() => exportEntries({ name: 'bad', exports: { '.': './dist/../secret.css' } }), /Invalid export/);
});
test('publication requires exact SHA and stable non-downgraded versions', () => {
  assertSource('a'.repeat(40), 'a'.repeat(40));
  assert.throws(() => assertSource('a'.repeat(40), 'b'.repeat(40)));
  assert.throws(() => assertSource('', ''));
  assert.throws(() => compareStable('0.1.0-rc.0', '0.1.0'));
  assert.ok(compareStable('0.2.0', '0.1.9') > 0);
});
test('shared publication is reachable only through accepted stable release and blocks root latest', () => {
  const yaml = require('js-yaml');
  const shared = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/packages-release.yml'), 'utf8'));
  const release = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(Object.keys(shared.on), ['workflow_call']);
  assert.equal(release.jobs.shared_packages.needs, 'promotion_guard');
  assert.equal(release.jobs.shared_packages.with['accepted-sha'], '${{ github.sha }}');
  assert.ok(release.jobs.promote_npm_latest.needs.includes('shared_packages'));
  const candidate = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/candidate.yml'), 'utf8'));
  assert.ok(candidate.jobs.finalize_acceptance.needs.includes('build_desktop_rc'));
  assert.ok(candidate.jobs.build_desktop_rc.steps.some((step) => step.run === 'node scripts/workspace-package-consumer.cjs --local'));
});

test('SDK types become checked consumer imports instead of hidden library declarations', () => fixture((root, directory, manifest) => {
  fs.writeFileSync(path.join(directory, 'dist/index.d.ts'), "import type { MissingApi as Alias, type ExistingApi, } from '@undefineds.co/solid-sdk'; export declare const applet: Alias;");
  verifyInstalled(root, [manifest]);
  const consumer = fs.readFileSync(path.join(root, 'consumer.ts'), 'utf8');
  assert.match(consumer, /import type \{ ExistingApi, MissingApi \} from '@undefineds.co\/solid-sdk'/);
  const sdk = path.join(root, 'node_modules/@undefineds.co/solid-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@undefineds.co/solid-sdk', type: 'module', types: 'index.d.ts' }));
  fs.writeFileSync(path.join(sdk, 'index.d.ts'), 'export interface ExistingApi {}');
  assert.throws(() => execFileSync('bun', [path.resolve(__dirname, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: root, stdio: 'pipe' }), (error) => error.stdout.toString().includes('MissingApi'));
}));
test('packing rewrites only the tarball manifest and restores workspace source', () => fixture((root, directory) => {
  const { packWorkspacePackages } = require('../../scripts/workspace-package-pack.cjs');
  const pkg = path.join(root, 'packages/applet');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/dep/package.json'), JSON.stringify({ name: '@fixture/dep', version: '2.0.0' }));
  const source = JSON.stringify({ name: '@fixture/applet', version: '1.0.0', files: ['index.js'], dependencies: { '@fixture/dep': 'workspace:*' } });
  fs.writeFileSync(path.join(pkg, 'package.json'), source);
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export const value = 1');
  const result = packWorkspacePackages(root, ['applet'], path.join(root, 'packed'), 'a'.repeat(40));
  assert.equal(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'), source);
  const packed = JSON.parse(execFileSync('tar', ['-xOf', result['@fixture/applet'], 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(packed.dependencies['@fixture/dep'], '2.0.0');
  assert.equal(packed.gitHead, 'a'.repeat(40));
}));

test('dist rewriting makes JS and declaration relative specifiers NodeNext-compatible', () => fixture((root, directory) => {
  const dist = path.join(directory, 'dist');
  const source = "export * from './sibling'; export type T = import('./types').T; export * from './already.js';";
  fs.writeFileSync(path.join(dist, 'contract.d.ts'), source);
  fs.writeFileSync(path.join(dist, 'contract.js'), "export * from './sibling'; const lazy = import('./sibling');");
  execFileSync('bun', [path.resolve(__dirname, '../../scripts/fix-dist-js-imports.mjs'), dist]);
  assert.equal(fs.readFileSync(path.join(dist, 'contract.d.ts'), 'utf8'), "export * from './sibling.js'; export type T = import('./types.js').T; export * from './already.js';");
  assert.match(fs.readFileSync(path.join(dist, 'contract.js'), 'utf8'), /import\('\.\/sibling\.js'\)/);
}));
test('declaration gate fails packed package errors even when consumer namespace imports compile', () => fixture((root, directory, manifest) => {
  const { check } = require('../../scripts/workspace-package-typecheck.cjs');
  fs.symlinkSync(path.resolve(__dirname, '../../node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  fs.writeFileSync(path.join(directory, 'dist/index.d.ts'), "export type Value = import('./missing.js').Value;");
  verifyInstalled(root, [manifest]);
  assert.throws(() => check(root, [manifest.name]), /missing.js/);
}));
