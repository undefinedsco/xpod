'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { produce, context, inventory, directChildOutcome, childEvidence, TOOLS } = require('../../scripts/check-cli-publication.cjs');
const { copyCliBuildInputs, CLI_ENTRIES, CLIENT_ENTRIES } = require('../../scripts/cli-build-inputs.cjs');
const root = path.resolve(__dirname, '../..');

test('actual checkout/run identity is bound without treating PR head as checkout', () => {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const result = context(root, { GITHUB_ACTIONS: 'true', GITHUB_SHA: sha, EVENT_HEAD_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(result.checkoutSha, sha); assert.equal(result.eventHeadSha, 'a'.repeat(40)); assert.equal(result.runAttempt, '2');
  assert.throws(() => context(root, { GITHUB_SHA: 'b'.repeat(40) }), /checkout/);
  assert.throws(() => context(root, { GITHUB_ACTIONS: 'true', GITHUB_SHA: sha }), /run_context/);
});

test('minimal copy includes only declared CLI/client/type/host sources with untouched bytes', () => {
  const parent = path.join(root, '.test-data/cli-publication-contract');fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, 'case-'));
  const origin = path.join(temporary, 'original'), output = path.join(temporary, 'copy');
  try {
    for (const [pkg, entries] of [['xpod-cli', CLI_ENTRIES], ['xpod-client', CLIENT_ENTRIES]]) {
      for (const entry of entries) {
        const file = path.join(origin, 'packages', pkg, entry);
        if (!entry.includes('.')) { fs.mkdirSync(file, { recursive: true }); fs.writeFileSync(path.join(file, 'fixture.txt'), entry); }
        else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry === 'package.json' ? JSON.stringify({ name: '@undefineds.co/' + pkg, dependencies: { client: 'workspace:*' } }) : entry); }
      }
    }
    const canonical = path.join(origin, 'packages/xpod-cli/scripts/canonical-host-sources.json');
    fs.writeFileSync(canonical, JSON.stringify(['runtime/fixture.ts']));
    for (const file of ['src/runtime/fixture.ts', 'types/bun/index.d.ts', 'LICENSE']) { fs.mkdirSync(path.dirname(path.join(origin, file)), { recursive: true }); fs.writeFileSync(path.join(origin, file), file); }
    const result = copyCliBuildInputs(origin, output);
    assert.equal(fs.existsSync(path.join(output, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(output, 'packages/xpod-api')), false);
    for (const row of result.files) assert.deepEqual(fs.readFileSync(path.join(output, row.path)), fs.readFileSync(path.join(origin, row.path)));
    assert.ok(result.files.some(row => row.path === 'src/runtime/fixture.ts'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'packages/xpod-cli/package.json'))).dependencies.client, 'workspace:*');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('workflow keeps old private artifact separate from normal producer and binds actual attempt', () => {
  const file = path.join(root, '.github/workflows/cli-package.yml');
  const parsed = spawnSync('bun', ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))', file], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const workflow = JSON.parse(parsed.stdout);assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs['standalone-cli'].steps;
  assert.ok(steps.some(step => step.run === 'node scripts/check-cli-package.cjs'));
  const publicationSteps = workflow.jobs['normal-publication'].steps;
  assert.ok(publicationSteps.some(step => step.run === 'node scripts/check-cli-publication.cjs'));
  assert.ok(steps.some(step => step.with?.name === 'xpod-cli-${{ runner.os }}-${{ github.sha }}'));
  const upload = publicationSteps.find(step => step.name === 'Upload publication preparation originals');
  assert.match(upload.with.name, /publication-preparation.*steps.source.outputs.sha.*github.run_id.*github.run_attempt/);
  assert.equal(upload.with.path, '.test-data/cli-publication-preparation/');
  assert.equal(upload.with['if-no-files-found'], 'error');
  const paths = workflow.on.pull_request.paths;
  assert.ok(paths.includes('bunfig.toml'));
  assert.ok(paths.includes('packages/xpod-cli/**')); // includes the dedicated publication.bun.lock
  assert.ok(fs.existsSync(path.join(root, 'packages/xpod-cli/publication.bun.lock')));
  assert.equal(steps[0].with.ref, '${{ github.sha }}');assert.equal(steps[0].with['persist-credentials'], false);
});

test('producer runs actual normal workspace builds with independent lock and repository tool closure', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/check-cli-publication.cjs'), 'utf8');
  for (const tool of TOOLS) assert.ok(fs.existsSync(path.join(root, tool)));
  assert.ok(source.includes("'bunfig.toml'"));
  assert.match(source, /publication\.bun\.lock/);assert.match(source, /--frozen-lockfile/);
  assert.match(source, /await compile\(\['run', 'build:tools'\], cli, 'cli-build-tools'\)/);
  assert.match(source, /await compile\(\['run', 'build'\], client, 'client-build'\)/);
  assert.match(source, /await compile\(\['run', 'build'\], cli, 'cli-build'\)/);
  assert.doesNotMatch(source, /npm.*install|file:'?\s*\+|dependencies\[.*\]\s*=/);
  const old = fs.readFileSync(path.join(root, 'scripts/check-cli-package.cjs'), 'utf8');
  assert.ok(old.includes("packedCliManifest.dependencies['@undefineds.co/xpod-client'] = 'file:' + runtimeClientTar"));
  assert.ok(old.includes("JSON.stringify({ '@undefineds.co/xpod-client': 'file:' + runtimeClientTar })"));
  assert.ok(old.includes("path.join(evidence, 'xpod-cli.tgz')"));
});

test('publication refuses existing evidence and inventories only regular original files', () => {
  const parent = path.join(root, '.test-data/cli-publication-contract');fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'evidence-'));
  try {
    const original = path.join(directory, 'client.tgz');fs.writeFileSync(original, 'retained original');
    assert.throws(() => produce(root, directory), /already_exists/);
    assert.equal(fs.readFileSync(original, 'utf8'), 'retained original');
    const rows = inventory(directory);assert.equal(rows.length, 1);assert.equal(rows[0].path, 'client.tgz');
    assert.equal(rows[0].bytes, Buffer.byteLength('retained original'));assert.match(rows[0].sha256, /^[a-f0-9]{64}$/);
    fs.symlinkSync(original, path.join(directory, 'alias'));
    assert.throws(() => inventory(directory), /not_regular/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('direct child success does not claim a detached descendant has closed', async () => {
  const result = spawnSync(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref(); console.log(child.pid);
  `], { encoding: 'utf8', timeout: 5000 });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  try {
    assert.equal(result.status, 0); process.kill(pid, 0);
    const evidence = childEvidence([directChildOutcome(result)]);
    assert.equal(evidence.directChildrenWaited, true);
    assert.equal(evidence.descendantClosureVerified, false);
    assert.equal('childCommandsClosed' in evidence, false);
  } finally {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('owned detached fixture did not exit');
  }
});

test('command evidence preserves spawn failures and signal termination without closure inflation', () => {
  const missing = directChildOutcome(spawnSync('/nonexistent/xpod-publication-fixture-command', []));
  assert.equal(missing.exitCode, null); assert.equal(missing.error.code, 'ENOENT');
  assert.equal(missing.directChildWaited, false);
  const signaled = directChildOutcome(spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']));
  assert.equal(signaled.exitCode, null); assert.equal(signaled.signal, 'SIGTERM');
  assert.equal(signaled.directChildWaited, true);
  assert.equal(childEvidence([signaled, missing]).directChildrenWaited, false);
  assert.equal(childEvidence([]).directChildrenWaited, false);
  assert.equal(childEvidence([signaled]).descendantClosureVerified, false);
});
