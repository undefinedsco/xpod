// Focused regression for the RC384 producer copy/pack boundary.
//
// Real shape (verified against the actual RC384 artifact and selected-real.json):
// `packages/xpod-afs` is a workspace with `inputKind:'workspace'` and BOTH body
// roles (`selected-input-source-tar` and `public-selected-input-source-tar`). A
// build/probe wrote three diagnostics under `.test-data/build/`; they are not
// tracked Git and not declared build outputs, so they must not reach (a) the
// delivered runtime copy, (b) the selected-input copy/ledger, or (c) the
// public-selected source body that `bun pm pack` selects.
//
// Everything derives from the REAL exported producer functions. All intermediate
// data lives under the project `.test-data/` suite dir and is removed afterwards.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const { shouldCopyBundledDependency, bundleLocalDependenciesIntoTarball } =
  require(path.join(ROOT, 'scripts/run-npm-pack.cjs'));

const SUITE = path.join(ROOT, '.test-data', 'service-pack-scratch-filter');
fs.rmSync(SUITE, { recursive: true, force: true });
fs.mkdirSync(SUITE, { recursive: true });
const created = [SUITE];
function workdir(name) {
  const dir = fs.mkdtempSync(path.join(SUITE, name + '-'));
  created.push(dir);
  return dir;
}
after(() => { for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// Names/shape match the real RC384 diagnostics. Contents are placeholders: the
// actual RC384 bytes/SHA are established by the artifact itself, not by a fixture.
const DIAGNOSTICS = [
  'commands-inputs.physical.json',
  'commands-invocation.raw.json',
  'library-inputs.raw.json',
];

function makeWorkspace({ withNpmIgnore = true } = {}) {
  const root = workdir('pkg');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, '.test-data', 'build'), { recursive: true });
  // Real `packages/xpod-afs/package.json` entry shape: root main plus conditional
  // subpath exports (read from the checked-in manifest, not invented).
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'xpod-afs', 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: real.name, version: real.version, main: real.main, exports: real.exports }, null, 2));
  fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'export const real = 1;\n');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
  for (const name of DIAGNOSTICS) {
    fs.writeFileSync(path.join(root, '.test-data', 'build', name), `{"diag":"${name}"}\n`);
  }
  // A nested generated tree is NOT whitelisted by the old code, so this is the
  // path that actually exercises the new rule rather than the root whitelist.
  fs.mkdirSync(path.join(root, 'dist', '.test-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', '.test-data', 'nested.json'), '{"nested":true}\n');
  if (withNpmIgnore) fs.writeFileSync(path.join(root, '.npmignore'), '.test-data/\n');
  return root;
}

test('normal copy path drops declared test scratch, keeps runtime payload', () => {
  const root = makeWorkspace();
  for (const relative of ['package.json', 'dist/index.cjs', 'LICENSE']) {
    assert.equal(shouldCopyBundledDependency(root, path.join(root, relative)), true, `must keep ${relative}`);
  }
  for (const name of DIAGNOSTICS) {
    assert.equal(
      shouldCopyBundledDependency(root, path.join(root, '.test-data', 'build', name)),
      false, `must drop ${name}`);
  }
  // generic at any depth, and legacy guards still hold
  assert.equal(shouldCopyBundledDependency(root, path.join(root, 'dist', '.test-data', 'x.json')), false);
  assert.equal(shouldCopyBundledDependency(root, path.join(root, 'node_modules', 'x.js')), false);
  assert.equal(shouldCopyBundledDependency(root, path.join(root, '.git', 'config')), false);
});

test('delivered pack carries zero diagnostics while source keeps them', () => {
  const root = makeWorkspace();
  const seed = workdir('seed');
  fs.mkdirSync(path.join(seed, 'package'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'package', 'package.json'),
    JSON.stringify({ name: 'consumer-package', version: '1.0.0' }, null, 2));
  const tarball = path.join(workdir('tar'), 'payload.tgz');
  execFileSync('tar', ['czf', tarball, '-C', seed, 'package']);
  bundleLocalDependenciesIntoTarball(tarball, [
    { name: '@undefineds.co/xpod-afs', sourcePackageRoot: root, repoRoot: workdir('repo'), patchedRuntime: false },
  ]);
  const out = workdir('unpack');
  execFileSync('tar', ['xf', tarball, '-C', out]);
  const shipped = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else shipped.push(path.relative(out, full));
    }
  })(out);
  assert.equal(shipped.filter((name) => name.includes('.test-data')).length, 0,
    'diagnostics must not be delivered');
  assert.ok(shipped.join('\n').includes('dist/index.cjs'), 'runtime payload must ship');
  for (const name of DIAGNOSTICS) {
    assert.ok(fs.existsSync(path.join(root, '.test-data', 'build', name)),
      'raw diagnostic stays on source for forensics');
  }
});

test('public-selected body boundary: bun pm pack excludes scratch only when declared', () => {
  // This is the raw-Bun-pack path used by capturePublicPack/retainPublicSelectedSource;
  // the normal copy filter cannot influence it.
  const declared = makeWorkspace({ withNpmIgnore: true });
  const undeclared = makeWorkspace({ withNpmIgnore: false });
  const dryRun = (cwd) =>
    execFileSync('bun', ['pm', 'pack', '--dry-run', '--ignore-scripts'], { cwd, encoding: 'utf8' });
  assert.equal(dryRun(declared).includes('.test-data'), false,
    'declared .npmignore must keep scratch out of the public selection');
  assert.equal(dryRun(undeclared).includes('.test-data'), true,
    'without a declaration bun would select the scratch tree (the RC384 defect)');
});

test('actual mutation: the checked-in package declares the exclusion', () => {
  // The authoritative producer fix for the raw-Bun-pack boundary lives in the
  // package declaration itself, so assert the real workspace file.
  const npmignore = path.join(ROOT, 'packages', 'xpod-afs', '.npmignore');
  assert.ok(fs.existsSync(npmignore), 'packages/xpod-afs/.npmignore must exist');
  assert.match(fs.readFileSync(npmignore, 'utf8'), /(?:^|\n)\.test-data\/?\s*(?:\n|$)/,
    'must declare .test-data');
  // Mutant: dropping the declaration re-exposes the diagnostics through bun pack.
  const mutant = makeWorkspace({ withNpmIgnore: false });
  const output = execFileSync('bun', ['pm', 'pack', '--dry-run', '--ignore-scripts'],
    { cwd: mutant, encoding: 'utf8' });
  assert.equal(output.includes('.test-data'), true,
    'mutant without the declaration does expose scratch');
});

test('a declared runtime entry inside scratch fails closed instead of shipping broken', () => {
  // If a package declares its main/bin/exports inside `.test-data`, dropping the
  // tree would produce a package with a missing entry. The producer must refuse.
  const root = workdir('broken');
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'broken-pkg', version: '1.0.0', main: '.test-data/entry.js' }, null, 2));
  fs.writeFileSync(path.join(root, '.test-data', 'entry.js'), 'export const x = 1;\n');
  assert.throws(
    () => shouldCopyBundledDependency(root, path.join(root, 'dist', 'anything.js')),
    /Declared runtime entry lives inside declared test scratch/,
  );
});

test('ACTUAL pre-fix source mutant re-exposes nested scratch; current code drops it', () => {
  // Real mutation: compile a private copy of the real producer file with ONLY the
  // declared-scratch rejection removed, then run it through Module._compile. The
  // working tree is never modified.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'run-npm-pack.cjs'), 'utf8');
  const mutantSource = source
    .replace('  if (isDeclaredTestScratch(relativePath)) {\n    return false;\n  }\n', '')
    .replace('        if (isDeclaredTestScratch(childRelativePath)) return false;\n', '');
  assert.notEqual(mutantSource, source, 'mutation must actually apply');

  const loaded = new Module(path.join(ROOT, 'scripts', 'run-npm-pack.cjs'), module);
  loaded.filename = path.join(ROOT, 'scripts', 'run-npm-pack.cjs');
  loaded.paths = Module._nodeModulePaths(path.dirname(loaded.filename));
  loaded._compile(mutantSource, loaded.filename);

  const root = makeWorkspace();
  const nested = path.join(root, 'dist', '.test-data', 'nested.json');
  // Pre-fix code ships the nested scratch file...
  assert.equal(loaded.exports.shouldCopyBundledDependency(root, nested), true,
    'pre-fix source must expose nested scratch');
  // ...while the current real implementation drops it.
  assert.equal(shouldCopyBundledDependency(root, nested), false,
    'current implementation must drop nested scratch');
});

test('real nested-conflict exposure drops scratch from the nested package', () => {
  // Mirrors the proven conflicting-dependency shape: the seed depends on
  // external@^1.0.0 while the bundled parent vendors external@2.0.0, which forces
  // the REAL onNestedConflict path.
  const root = workdir('conflict-root');
  const source = path.join(root, 'node_modules', 'auth');
  const nested = path.join(source, 'node_modules', 'external');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'lib', 'runtime.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'auth', version: '1.0.0', dependencies: { external: '^2.0.0' },
  }, null, 2));
  // root-level external is the older version -> conflict against the nested one
  fs.mkdirSync(path.join(root, 'node_modules', 'external'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'external', 'package.json'),
    JSON.stringify({ name: 'external', version: '1.0.0' }, null, 2));
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({
    name: 'external', version: '2.0.0', main: 'index.js', dependencies: { leaf: '^1.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(nested, 'index.js'), 'module.exports = "nested-two";\n');
  fs.mkdirSync(path.join(nested, '.test-data', 'build'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.test-data', 'build', 'commands-inputs.physical.json'), '{"d":1}\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'leaf'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'leaf', 'package.json'),
    JSON.stringify({ name: 'leaf', version: '1.0.0' }, null, 2));

  const seed = workdir('conflict-seed');
  fs.mkdirSync(path.join(seed, 'package'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'package', 'package.json'), JSON.stringify({
    name: 'consumer-package', version: '1.0.0', dependencies: { external: '^1.0.0' },
  }, null, 2));
  const tarball = path.join(workdir('conflict-tar'), 'payload.tgz');
  execFileSync('tar', ['czf', tarball, '-C', seed, 'package']);

  bundleLocalDependenciesIntoTarball(tarball, [
    { name: 'auth', sourcePackageRoot: source, repoRoot: root, patchedRuntime: true },
  ]);
  const out = workdir('conflict-unpack');
  execFileSync('tar', ['xf', tarball, '-C', out]);
  const shipped = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else shipped.push(path.relative(out, full));
    }
  })(out);
  const joined = shipped.join('\n');
  assert.ok(joined.includes('node_modules/auth/node_modules/external/index.js'),
    'nested dependency must still ship');
  assert.equal(shipped.filter((name) => name.includes('.test-data')).length, 0,
    'nested scratch must not ship');

  // Exercise the same real nested-conflict path with a broken declared entry.
  // Refusing the pack prevents the scratch exclusion from hiding its entry.
  const manifestPath = path.join(nested, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.main = '.test-data/entry.js';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(nested, '.test-data', 'entry.js'), 'module.exports = 1;\n');
  execFileSync('tar', ['czf', tarball, '-C', seed, 'package']);
  assert.throws(() => bundleLocalDependenciesIntoTarball(tarball, [
    { name: 'auth', sourcePackageRoot: source, repoRoot: root, patchedRuntime: true },
  ]), /Declared runtime entry lives inside declared test scratch/);
});
