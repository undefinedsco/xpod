/** Installed dependency closure staging must preserve Node's package-relative
 * resolution. The real installed tree legitimately holds two different versions
 * of one package name for different parents; the staged runtime has to keep
 * both, each parent resolving its own. These tests build a synthetic install and
 * prove behaviour with ACTUAL Node resolution, not by inspecting file names.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { stageInstalledDependencyClosure } = require('../../scripts/lib/installed-dependency-closure.cjs');

const root = path.resolve(__dirname, '../..');
const shouldCopyAll = () => true;

function workspace() {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  return fs.mkdtempSync(path.join(root, '.test-data/installed-closure-'));
}

/** Write a package whose entry reports its own name/version, plus extra files. */
function writePackage(directory, manifest, extraFiles = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'index.js'),
    `module.exports = { name: ${JSON.stringify(manifest.name)}, version: ${JSON.stringify(manifest.version)}, marker: ${JSON.stringify(extraFiles.marker ?? null)} };\n`);
  for (const [name, content] of Object.entries(extraFiles)) {
    if (name === 'marker') continue;
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
}

/** Resolve a package from a staged parent with Node's real resolver and load it. */
function requireFrom(parentEntry, request) {
  const script = `
    const { createRequire } = require('node:module');
    const resolved = createRequire(${JSON.stringify(parentEntry)}).resolve(${JSON.stringify(request)});
    process.stdout.write(JSON.stringify({ resolved, loaded: require(resolved) }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('two parents that resolved different versions of one name keep their own versions', () => {
  const dir = workspace();
  try {
    // Installed hoist root holds v2 for the service; an older v1 is nested under
    // the transitive parent, exactly like the real drizzle-orm situation.
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { 'shared-dep': '^2.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/beta'), {
      name: '@fixture/beta', version: '1.0.0', dependencies: { 'shared-dep': '^1.0.0' },
    });
    writePackage(path.join(nodeModules, 'shared-dep'), { name: 'shared-dep', version: '2.0.0' });
    writePackage(path.join(nodeModules, '@fixture/beta/node_modules/shared-dep'),
      { name: 'shared-dep', version: '1.0.0' });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    const staged = stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha', '@fixture/beta'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    assert.ok(staged.stagedNames.has('shared-dep'));
    // Alpha still sees the hoisted 2.0.0 ...
    const fromAlpha = requireFrom(path.join(stageRoot, 'node_modules/@fixture/alpha/index.js'), 'shared-dep');
    assert.equal(fromAlpha.loaded.version, '2.0.0');
    // ... while beta keeps the nested 1.0.0 it actually resolved.
    const fromBeta = requireFrom(path.join(stageRoot, 'node_modules/@fixture/beta/index.js'), 'shared-dep');
    assert.equal(fromBeta.loaded.version, '1.0.0');
    // The two resolutions are physically distinct files, not one overwritten copy.
    assert.notEqual(fromAlpha.resolved, fromBeta.resolved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one hoisted copy is reused by several parents instead of duplicated', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { 'shared-dep': '^2.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/beta'), {
      name: '@fixture/beta', version: '1.0.0', dependencies: { 'shared-dep': '^2.0.0' },
    });
    writePackage(path.join(nodeModules, 'shared-dep'), { name: 'shared-dep', version: '2.0.0' });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha', '@fixture/beta'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    const a = requireFrom(path.join(stageRoot, 'node_modules/@fixture/alpha/index.js'), 'shared-dep');
    const b = requireFrom(path.join(stageRoot, 'node_modules/@fixture/beta/index.js'), 'shared-dep');
    assert.equal(a.loaded.version, '2.0.0');
    assert.equal(b.loaded.version, '2.0.0');
    assert.equal(a.resolved, b.resolved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cyclic dependency graph terminates and stays resolvable', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { '@fixture/cycle-a': '1.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/cycle-a'), {
      name: '@fixture/cycle-a', version: '1.0.0', dependencies: { '@fixture/cycle-b': '1.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/cycle-b'), {
      name: '@fixture/cycle-b', version: '1.0.0', dependencies: { '@fixture/cycle-a': '1.0.0' },
    });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    // A cap would either hang or throw; correctness is that it returns at all.
    stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    const a = requireFrom(path.join(stageRoot, 'node_modules/@fixture/cycle-a/index.js'), '@fixture/cycle-b');
    assert.equal(a.loaded.name, '@fixture/cycle-b');
    const b = requireFrom(path.join(stageRoot, 'node_modules/@fixture/cycle-b/index.js'), '@fixture/cycle-a');
    assert.equal(b.loaded.name, '@fixture/cycle-a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an optional peer is followed only when the root manifest selects it', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0',
      peerDependencies: { 'selected-peer': '1.0.0', 'unselected-peer': '1.0.0' },
      peerDependenciesMeta: { 'unselected-peer': { optional: true } },
    });
    writePackage(path.join(nodeModules, 'selected-peer'), { name: 'selected-peer', version: '1.0.0' });
    writePackage(path.join(nodeModules, 'unselected-peer'), { name: 'unselected-peer', version: '1.0.0' });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    const staged = stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir,
      rootPackageJson: { dependencies: { 'selected-peer': '1.0.0' } },
      canonicalPackages: ['@fixture/alpha'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    assert.ok(staged.stagedNames.has('selected-peer'));
    assert.ok(!staged.stagedNames.has('unselected-peer'));
    assert.equal(fs.existsSync(path.join(stageRoot, 'node_modules/unselected-peer')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a required dependency missing from the installed tree fails the stage', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { 'absent-dep': '1.0.0' },
    });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    assert.throws(() => stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    }), /Installed runtime dependency is missing: @fixture\/alpha -> absent-dep/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an already-staged canonical root is reused, never overwritten by the closure', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { '@fixture/canonical': '1.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/canonical'), { name: '@fixture/canonical', version: '1.0.0' });

    const stageRoot = path.join(dir, 'package');
    const canonicalSlot = path.join(stageRoot, 'node_modules/@fixture/canonical');
    fs.mkdirSync(canonicalSlot, { recursive: true });
    // A derived component host manifest, as component discovery would produce.
    fs.writeFileSync(path.join(canonicalSlot, 'package.json'),
      JSON.stringify({ name: '@fixture/canonical', version: '1.0.0', main: 'derived-bundle.cjs' }));
    fs.writeFileSync(path.join(canonicalSlot, 'derived-bundle.cjs'), 'module.exports={derived:true};');

    // `@fixture/canonical` is staged by component discovery BEFORE the closure
    // runs, so it is already a canonical root when the closure asks for it.
    stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha', '@fixture/canonical'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    // The derived host manifest survives untouched.
    assert.equal(JSON.parse(fs.readFileSync(path.join(canonicalSlot, 'package.json'), 'utf8')).main, 'derived-bundle.cjs');
    assert.equal(fs.existsSync(path.join(canonicalSlot, 'index.js')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a declared Node builtin is provided by the runtime, not required as a package', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    // Packages such as n3 legitimately declare `buffer` for browser parity while
    // Node supplies the builtin; this must not be reported as a missing package.
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { buffer: '^6.0.3', 'fs': '^0.0.0' },
    });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    const staged = stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });
    assert.ok(!staged.stagedNames.has('buffer'));
    assert.ok(!staged.rootNames.has('buffer'));
    assert.ok(!staged.stagedNames.has('fs'));
    // No builtin is copied into the stage, and the runtime still supplies it:
    // Node's own `buffer` resolves and exposes its constructor.
    assert.equal(fs.existsSync(path.join(stageRoot, 'node_modules/buffer')), false);
    const builtin = requireFrom(path.join(stageRoot, 'node_modules/@fixture/alpha/index.js'), 'buffer');
    assert.equal(typeof builtin.resolved, 'string');
    assert.match(builtin.resolved, /^node:buffer$|buffer/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested copy is staged under its own parent, not merged into the hoist slot', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    // The real shape: the service package pins the hoisted version AND pulls a
    // transitive package whose own copy is the older nested one.
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { '@fixture/mid': '1.0.0', orm: '^0.45.1' },
    });
    writePackage(path.join(nodeModules, '@fixture/mid'), { name: '@fixture/mid', version: '1.0.0', dependencies: { orm: '^0.28.0' } });
    // Nested exactly as the real tree nests the older version.
    writePackage(path.join(nodeModules, '@fixture/mid/node_modules/orm'), { name: 'orm', version: '0.28.6' }, { marker: 'nested' });
    writePackage(path.join(nodeModules, 'orm'), { name: 'orm', version: '0.45.2' }, { marker: 'hoisted' });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    const staged = stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    const hoisted = requireFrom(path.join(stageRoot, 'node_modules/@fixture/mid/index.js'), 'orm');
    assert.equal(hoisted.loaded.version, '0.28.6');
    // Both are hoisted in this install, so both are root-resolvable specifiers;
    // `orm` is advertised once at the hoist slot while its older copy is not.
    assert.ok(staged.rootNames.has('orm'));
    assert.ok(staged.rootNames.has('@fixture/mid'));
    assert.ok(staged.stagedNames.has('orm'));
    assert.equal(hoisted.loaded.marker, 'nested');
    // The hoist slot keeps the service's own version for other parents.
    assert.equal(JSON.parse(fs.readFileSync(path.join(stageRoot, 'node_modules/orm/package.json'), 'utf8')).version, '0.45.2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same version, equal file lengths, DIFFERENT payload: both parents load their own original', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { dup: '1.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/beta'), {
      name: '@fixture/beta', version: '1.0.0', dependencies: { dup: '1.0.0' },
    });
    // Hoisted copy and a nested copy: same name, same version, SAME byte lengths,
    // but different content. Only physical identity can distinguish them.
    writePackage(path.join(nodeModules, 'dup'), { name: 'dup', version: '1.0.0' }, { 'payload.txt': 'AAAA' });
    writePackage(path.join(nodeModules, '@fixture/beta/node_modules/dup'),
      { name: 'dup', version: '1.0.0' }, { 'payload.txt': 'BBBB' });

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha', '@fixture/beta'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    const fromAlpha = requireFrom(path.join(stageRoot, 'node_modules/@fixture/alpha/index.js'), 'dup');
    const fromBeta = requireFrom(path.join(stageRoot, 'node_modules/@fixture/beta/index.js'), 'dup');
    // Each parent keeps its own installed object's bytes.
    assert.equal(fs.readFileSync(path.join(path.dirname(fromAlpha.resolved), 'payload.txt'), 'utf8'), 'AAAA');
    assert.equal(fs.readFileSync(path.join(path.dirname(fromBeta.resolved), 'payload.txt'), 'utf8'), 'BBBB');
    assert.notEqual(fromAlpha.resolved, fromBeta.resolved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identical package content under two physical source paths keeps each own transitive version', () => {
  const dir = workspace();
  try {
    const nodeModules = path.join(dir, 'node_modules');
    // Two DISTINCT installed objects for `shared`, with byte-identical manifests
    // and payload. They differ only in which nested `leaf` version they carry.
    const writeShared = (root, leafVersion) => {
      writePackage(root, { name: 'shared', version: '1.0.0', dependencies: { leaf: '1.0.0' } }, { 'payload.txt': 'SAME' });
      writePackage(path.join(root, 'node_modules/leaf'), { name: 'leaf', version: leafVersion });
    };
    writePackage(path.join(nodeModules, '@fixture/alpha'), {
      name: '@fixture/alpha', version: '1.0.0', dependencies: { shared: '1.0.0' },
    });
    writePackage(path.join(nodeModules, '@fixture/beta'), {
      name: '@fixture/beta', version: '1.0.0', dependencies: { shared: '1.0.0' },
    });
    writeShared(path.join(nodeModules, 'shared'), '1.0.0');
    writeShared(path.join(nodeModules, '@fixture/beta/node_modules/shared'), '2.0.0');

    // Pre-condition: the two physical objects really do have equal package.json
    // bytes, so any content-only comparison would merge them.
    assert.equal(
      fs.readFileSync(path.join(nodeModules, 'shared/package.json'), 'utf8'),
      fs.readFileSync(path.join(nodeModules, '@fixture/beta/node_modules/shared/package.json'), 'utf8'),
    );

    const stageRoot = path.join(dir, 'package');
    fs.mkdirSync(stageRoot, { recursive: true });
    stageInstalledDependencyClosure({
      stageRoot, repoRoot: dir, rootPackageJson: { dependencies: {} },
      canonicalPackages: ['@fixture/alpha', '@fixture/beta'],
      resolvePackageDir: (name) => path.join(nodeModules, ...name.split('/')),
      shouldCopy: shouldCopyAll,
    });

    const alphaShared = requireFrom(path.join(stageRoot, 'node_modules/@fixture/alpha/index.js'), 'shared');
    const betaShared = requireFrom(path.join(stageRoot, 'node_modules/@fixture/beta/index.js'), 'shared');
    // Each staged `shared` still resolves the leaf version it originally had.
    const alphaLeaf = requireFrom(alphaShared.resolved, 'leaf');
    const betaLeaf = requireFrom(betaShared.resolved, 'leaf');
    assert.equal(alphaLeaf.loaded.version, '1.0.0');
    assert.equal(betaLeaf.loaded.version, '2.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The production desktop builder is invoked under BUN (stageDesktopRuntime imports
// buildPlatformPackage in Bun, so process.execPath spawns build-bun-single.js with
// Bun). Bun's createRequire().resolve.paths() returned an EMPTY list for real
// installed packages (node-fetch, undici), so the closure wrongly reported them
// missing. The resolver is now a physical ancestor walk; this asserts it agrees
// with the NODE ground truth on the same tree, under BOTH runtimes.
test('installed dependency lookup agrees with Node semantics under both Node and Bun', () => {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/lookup-parity-'));
  try {
    const nodeModules = path.join(dir, 'node_modules');
    const writePackage = (target, manifest) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = {};\n');
    };
    // Nearest-wins tree: a hoisted copy plus a nested, different version.
    writePackage(path.join(nodeModules, '@fx/parent'), { name: '@fx/parent', version: '1.0.0', dependencies: { shared: '^2.0.0' } });
    writePackage(path.join(nodeModules, '@fx/parent/node_modules/shared'), { name: 'shared', version: '2.0.0' });
    writePackage(path.join(nodeModules, '@fx/other'), { name: '@fx/other', version: '1.0.0', dependencies: { shared: '^1.0.0' } });
    writePackage(path.join(nodeModules, 'shared'), { name: 'shared', version: '1.0.0' });
    writePackage(path.join(nodeModules, 'only-hoisted'), { name: 'only-hoisted', version: '3.0.0' });
    // Bun's resolve.paths() returns an EMPTY list for specific REAL package names
    // (node-fetch / undici), not for arbitrary names. A generic fixture therefore
    // cannot pin the production failure: these packages must be present under
    // their actual names so the old implementation provably breaks here.
    writePackage(path.join(nodeModules, 'node-fetch'), { name: 'node-fetch', version: '3.3.2' });
    writePackage(path.join(nodeModules, 'undici'), { name: 'undici', version: '6.19.2' });
    // Nested differing copies prove the lookup still respects nearest-wins for
    // these same names instead of collapsing to one global answer.
    writePackage(path.join(nodeModules, '@fx/parent/node_modules/node-fetch'), { name: 'node-fetch', version: '2.7.0' });
    writePackage(path.join(nodeModules, '@fx/parent/node_modules/undici'), { name: 'undici', version: '5.28.4' });

    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, `
      const path = require('node:path');
      const { resolveInstalledDependency } = require(${JSON.stringify(path.join(root, 'scripts/lib/installed-dependency-closure.cjs'))});
      const parent = ${JSON.stringify(path.join(nodeModules, '@fx/parent'))};
      const other = ${JSON.stringify(path.join(nodeModules, '@fx/other'))};
      const read = (dir, name) => {
        const hit = resolveInstalledDependency(dir, name);
        return hit ? JSON.parse(require('node:fs').readFileSync(path.join(hit.directory, 'package.json'), 'utf8')).version : 'MISSING';
      };
      console.log(JSON.stringify({
        parentShared: read(parent, 'shared'),
        otherShared: read(other, 'shared'),
        hoisted: read(parent, 'only-hoisted'),
        absent: read(parent, 'definitely-not-installed'),
        nodeFetchNested: read(parent, 'node-fetch'),
        undiciNested: read(parent, 'undici'),
        nodeFetchHoisted: read(other, 'node-fetch'),
        undiciHoisted: read(other, 'undici'),
      }));
    `);
    const expected = {
      parentShared: '2.0.0', otherShared: '1.0.0', hoisted: '3.0.0', absent: 'MISSING',
      // The two names Bun's resolve.paths() cannot see must be FOUND, at the
      // physically nearest version for each requester.
      nodeFetchNested: '2.7.0', undiciNested: '5.28.4',
      nodeFetchHoisted: '3.3.2', undiciHoisted: '6.19.2',
    };
    for (const runtime of ['node', 'bun']) {
      const run = spawnSync(runtime, [script], { encoding: 'utf8', timeout: 30000 });
      assert.equal(run.status, 0, `${runtime} failed: ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout.trim()), expected, `${runtime} disagreed with nearest-physical semantics`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
