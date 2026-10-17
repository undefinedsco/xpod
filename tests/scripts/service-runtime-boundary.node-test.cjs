const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyServiceProfile, shouldCopyBundledDependency } = require('../../scripts/run-npm-pack.cjs');
const launcher = require('../../bin/xpod.js');

test('staged public root exports retain runtime siblings without compiler diagnostics or tests', () => {
  const root = fs.mkdtempSync(path.resolve('.test-data/service-public-exports-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: './index.cjs', exports: { './alias': { require: './alias.cjs', import: './alias.js' }, './sync': [{ require: './sync/index.cjs' }, './sync/fallback.js'] } }));
    for (const file of ['index.cjs', 'alias.cjs', 'alias.js', 'internal.cjs', 'index.d.ts']) assert.equal(shouldCopyBundledDependency(root, path.join(root, file)), true, file);
    for (const file of ['index.js.map', 'alias.test.js', 'tsconfig.json']) assert.equal(shouldCopyBundledDependency(root, path.join(root, file)), false, file);
    assert.equal(shouldCopyBundledDependency(root, path.join(root, 'sync/index.cjs')), true);
    assert.equal(shouldCopyBundledDependency(root, path.join(root, 'lib/textParsers.js')), true);
    assert.equal(shouldCopyBundledDependency(root, path.join(root, 'tests/nested.js')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installed compatibility launcher sends client commands to JS and service startup to native', () => {
  const root = fs.mkdtempSync(path.resolve('.test-data/service-dispatch-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(path.resolve('bin/xpod.js'), path.join(root, 'bin/xpod.js'));
    fs.mkdirSync(path.join(root, 'dist/cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/cli/index.js'), 'console.log(JSON.stringify({host:"compat",args:process.argv.slice(2)}));');
    const candidate = launcher.getBinaryPackageCandidates()[0];
    assert.ok(candidate, 'fixture requires a supported native host');
    const native = path.join(root, 'node_modules', candidate);
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: candidate, xpodBinary: './native' }));
    fs.writeFileSync(path.join(native, 'native'), '#!/usr/bin/env bun\nconsole.log(JSON.stringify({host:"service",args:process.argv.slice(2)}));', { mode: 0o700 });
    for (const [args, host] of [[['get', '--help'], 'compat'], [['auth', '--help'], 'compat'], [['--help'], 'compat'], [['--json', 'status'], 'compat'], [['start', '--help'], 'service'], [['__internal-css', '--help'], 'service']]) {
      const child = spawnSync(process.execPath, [path.join(root, 'bin/xpod.js'), ...args], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { host, args });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('service profile changes only its own host contract and preserves public library manifests', () => {
  const root = fs.mkdtempSync(path.resolve('.test-data/service-profile-'));
  try {
    for (const file of ['dist/runtime/service-entry.js', 'dist/cli/commands/start.js', 'dist/cli/commands/auth.js', 'dist/cli/index.js', 'bin/xpod.js']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'fixture');
    }
    const publicDir = path.join(root, 'node_modules/@undefineds.co/xpod-afs');
    fs.mkdirSync(publicDir, { recursive: true });
    const publicManifest = '{"exports":{"./workcopy":"./dist/workcopy.cjs","./sqlite":"./dist/sqlite.cjs"}}';
    fs.writeFileSync(path.join(publicDir, 'package.json'), publicManifest);
    const manifest = { dependencies: { '@undefineds.co/xpod-cli': '1.0.0', '@undefineds.co/xpod-client': 'file:./node_modules/@undefineds.co/xpod-client', '@undefineds.co/xpod-afs': 'file:./node_modules/@undefineds.co/xpod-afs' }, bin: { xpod: './bin/xpod.js' }, scripts: { build: 'fixture' }, bundledDependencies: ['@undefineds.co/xpod-cli', '@undefineds.co/xpod-client', '@undefineds.co/xpod-afs'] };
    manifest.workspaces = ['packages/*', 'ui', 'desktop'];
    applyServiceProfile(root, manifest);
    assert.deepEqual(manifest.bin, { 'xpod-service': './dist/runtime/service-entry.js' });
    assert.equal(manifest.dependencies['@undefineds.co/xpod-cli'], undefined);
    assert.equal(manifest.workspaces, undefined);
    assert.ok(manifest.dependencies['@undefineds.co/xpod-client']);
    assert.ok(manifest.dependencies['@undefineds.co/xpod-afs']);
    assert.deepEqual(manifest.bundledDependencies, ['@undefineds.co/xpod-client', '@undefineds.co/xpod-afs']);
    assert.equal(JSON.stringify(manifest).includes('workspace:'), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/cli/index.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/cli/commands/auth.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist/cli/commands/start.js')), true);
    assert.equal(fs.readFileSync(path.join(publicDir, 'package.json'), 'utf8'), publicManifest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('service profile rejects an absent built entry before changing the compatibility host', () => {
  const root = fs.mkdtempSync(path.resolve('.test-data/service-profile-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/xpod.js'), 'compatibility host');
    const manifest = { dependencies: { '@undefineds.co/xpod-cli': '1.0.0' }, bin: { xpod: './bin/xpod.js' } };
    const before = JSON.stringify(manifest);
    assert.throws(() => applyServiceProfile(root, manifest), /Service entry build is missing/);
    assert.equal(JSON.stringify(manifest), before);
    assert.equal(fs.readFileSync(path.join(root, 'bin/xpod.js'), 'utf8'), 'compatibility host');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime installation patches retain pinned dist checks without requiring upstream source', () => {
  const root = fs.mkdtempSync(path.resolve('.test-data/service-runtime-patches-'));
  const names = ['@inrupt/solid-client-authn-core', '@inrupt/solid-client-authn-browser'];
  const patchers = ['refresh', 'transport', 'operation-cleanup'].map(name => require(`../../scripts/patch-inrupt-authn-${name}.js`).patchInstalledPackage);
  try {
    for (const name of names) {
      const original = path.resolve('node_modules', name);
      const destination = path.join(root, 'node_modules', name);
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(path.join(original, 'package.json'), path.join(destination, 'package.json'));
      fs.cpSync(path.join(original, 'dist'), path.join(destination, 'dist'), { recursive: true });
      assert.equal(fs.existsSync(path.join(destination, 'src')), false);
    }
    for (const patch of patchers) {
      assert.doesNotThrow(() => patch(root, { runtimeOnly: true }));
      assert.throws(() => patch(root), /ENOENT/);
    }
    for (const patch of patchers) {
      for (const name of names) {
        const filename = path.join(root, 'node_modules', name, 'package.json');
        const bytes = fs.readFileSync(filename);
        fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(bytes), version: '99.0.0' }));
        if ((name.endsWith('core') && patch === patchers[2]) || (name.endsWith('browser') && patch === patchers[0])) {
          assert.doesNotThrow(() => patch(root, { runtimeOnly: true }));
        } else {
          assert.throws(() => patch(root, { runtimeOnly: true }), /Unsupported/);
        }
        fs.writeFileSync(filename, bytes);
      }
    }
    for (const patch of patchers) {
      const name = patch === patchers[0] ? names[0] : names[1];
      const filename = path.join(root, 'node_modules', name, 'dist/index.mjs');
      const bytes = fs.readFileSync(filename);
      fs.unlinkSync(filename);
      assert.throws(() => patch(root, { runtimeOnly: true }), /ENOENT/);
      fs.writeFileSync(filename, bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
