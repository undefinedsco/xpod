const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '../..');

test('locked standalone tooling runs original aggregate CLI in a clean Git scope and rejects drift', () => {
  assert.equal(process.versions.node.split('.')[0], '22', 'This tooling contract runs under the declared Node 22');
  const parent = path.join(fs.realpathSync(os.tmpdir()), '.test-data/xpod-legacy-verifier'); fs.mkdirSync(parent, { recursive: true });
  const owned = fs.mkdtempSync(path.join(parent, 'case-')), root = path.join(owned, 'source'); fs.mkdirSync(root);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const execute = (args, env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
  try {
    for (let current = root; ; current = path.dirname(current)) { assert.equal(fs.existsSync(path.join(current, 'node_modules')), false, current); if (current === path.dirname(current)) break; }
    fs.cpSync(path.join(repository, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ui')); fs.copyFileSync(path.join(repository, 'ui/build-targets.json'), path.join(root, 'ui/build-targets.json'));
    fs.mkdirSync(path.join(root, 'tests/scripts'), { recursive: true }); fs.copyFileSync(path.join(repository, 'tests/scripts/legacy-root-compat.node-test.cjs'), path.join(root, 'tests/scripts/legacy-root-compat.node-test.cjs'));
    fs.mkdirSync(path.join(root, '.github/tooling'), { recursive: true }); fs.cpSync(path.join(repository, '.github/tooling/legacy-root-verifier'), path.join(root, '.github/tooling/legacy-root-verifier'), { recursive: true });
    fs.copyFileSync(path.join(repository, 'package.json'), path.join(root, 'package.json')); fs.writeFileSync(path.join(root, '.gitignore'), '.test-data/\nnode_modules/\n');
    git('init', '-q'); git('add', '--', 'scripts', 'ui/build-targets.json', 'tests/scripts/legacy-root-compat.node-test.cjs', '.github/tooling/legacy-root-verifier', 'package.json', '.gitignore');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'clean verifier scope');
    const output = path.join(owned, 'github-output');
    const plain = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', GITHUB_OUTPUT: output };
    const prepared = execute(['.github/tooling/legacy-root-verifier/prepare.cjs', owned], plain); assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const tools = JSON.parse(prepared.stdout.trim().split('\n').find(line => line.startsWith('{"kind":"legacy-verifier-tooling-preparation"')));
    assert.equal(tools.actualBun, '1.4.2'); assert.equal(path.relative(root, tools.directory).startsWith('..'), true); assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
    const env = { ...plain, NODE_PATH: tools['node-path'], NODE_OPTIONS: tools['node-options'] };
    const probe = execute(['-e', "const fs=require('fs'),path=require('path'),assert=require('assert/strict');for(const file of JSON.parse(process.argv[1]))if(file.endsWith('.cjs'))require(path.resolve(file));for(const file of Object.keys(require.cache))assert(file.startsWith(process.cwd()+path.sep)||file.startsWith(process.env.NODE_PATH+path.sep),file);console.log('Complete actual verifier import closure loaded from source and isolated semver only');", JSON.stringify([
      'scripts/release-gate-evidence.cjs', 'scripts/lib/root-registry-supply.cjs', 'scripts/lib/legacy-afs-supply.cjs', 'scripts/lib/product-artifact-command.cjs', 'scripts/lib/legacy-root-artifact-context.cjs', 'scripts/check-afs-js-archive-ci.cjs', 'scripts/check-afs-client-publication.cjs', 'scripts/verify-installed-bundles.cjs',
    ])], { ...env, NODE_OPTIONS: '' }); assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const file = path.join(root, 'tests/scripts/legacy-root-compat.node-test.cjs'), requireFixture = Module.createRequire(file);
    const prefix = fs.readFileSync(file, 'utf8').split("test('one authority")[0];
    const before = process.cwd(); process.chdir(root);
    try {
      new Function('require', '__dirname', 'check', prefix + '\nfixture(check);')(requireFixture, path.dirname(file), fixture => {
        const args = ['scripts/release-gate-evidence.cjs', 'verify-root-compat', '--source-sha', fixture.args.sourceSha, '--run-id', fixture.args.runId, '--archive-dir', fixture.root, '--out', path.join(fixture.root, 'compat.receipt.json')];
        const run = override => { fs.rmSync(path.join(tools.directory, 'verification.receipt.json'), { force: true }); return execute(args, { ...env, ...override }); };
        const success = run(); assert.equal(success.status, 0, success.stdout + success.stderr); assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, 'compat.receipt.json'))).lanes.length, 18);
        const facts = JSON.parse(fs.readFileSync(path.join(tools.directory, 'verification.receipt.json'))); assert.equal(facts.actualNode.split('.')[0], '22'); assert.equal(facts.semver.version, '7.8.5'); assert.ok(facts.semver.entry.startsWith(tools['node-path'] + path.sep));
        const raw = path.join(fixture.receipts[0].directory, fixture.receipts[0].receipt.steps[0].stdout.path); fs.appendFileSync(raw, 'tampered');
        const tampered = run(); assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /raw|binding|hash/i);
        const semver = path.join(tools['node-path'], 'semver'), absent = path.join(tools['node-path'], 'semver-absent'); fs.renameSync(semver, absent);
        const missing = run(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /semver/); fs.renameSync(absent, semver);
        fs.mkdirSync(path.join(root, 'node_modules/semver'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/semver/package.json'), '{"name":"semver","version":"7.8.5","main":"index.js"}'); fs.writeFileSync(path.join(root, 'node_modules/semver/index.js'), 'throw Error("host package executed")');
        const shadow = run(); assert.notEqual(shadow.status, 0); assert.match(shadow.stderr, /escaped locked tooling/); assert.doesNotMatch(shadow.stderr, /host package executed/); fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
        const lock = path.join(tools.directory, 'bun.lock'), original = fs.readFileSync(lock); fs.appendFileSync(lock, ' '); const drift = run(); assert.notEqual(drift.status, 0); assert.match(drift.stderr, /source\/lock mismatch/); fs.writeFileSync(lock, original);
      });
    } finally { process.chdir(before); }
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
});
