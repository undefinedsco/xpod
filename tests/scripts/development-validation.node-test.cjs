'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const validation = require('../../scripts/development-validation.cjs');
const builds = require('../../scripts/build-workspace-packages.cjs');
const artifact = require('../../scripts/desktop-build-artifact.cjs');
const preflight = require('../../scripts/release-readonly-preflight.cjs');
const rollout = require('../../scripts/wait-production-rollout.cjs');
const links = require('../../scripts/check-document-links.cjs');
const parent = path.resolve('.test-data/efficiency-contract');
fs.mkdirSync(parent, { recursive: true });
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function write(root, file, value) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
function repository(root) {
  execFileSync('git', ['init', '-q', root]); write(root, 'src/example.ts', 'initial');
  execFileSync('git', ['add', 'src/example.ts'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
}
test('quick selects documents, UI, backend, contracts and conservative public consumers', () => {
  const commands = files => validation.select(files).commands.map(row => row.join(' '));
  assert.deepEqual(commands(['README.md']), ['node scripts/check-document-links.cjs README.md', 'git diff --check']);
  assert(commands(['ui/src/page.tsx']).includes('bun run build:ui'));
  assert(!commands(['ui/src/page.tsx']).includes('bun run build:ts'));
  assert(commands(['src/service/Example.ts']).includes('bun run build:ts'));
  assert(!commands(['src/service/Example.ts']).includes('bun run build:ui'));
  assert(commands(['.github/workflows/release.yml']).some(row => row.includes('vitest')));
  assert(!commands(['.github/workflows/release.yml']).includes('bun run build:ts'));
  for (const file of ['packages/solid-sdk/src/index.ts', 'bun.lock', 'config/local.json', 'unknown.input', 'src/storage/Example.ts']) {
    assert(commands([file]).includes('bun run test:integration'), file);
    assert(commands([file]).includes('bun run build:packages'), file);
  }
});
test('fingerprints include untracked input, tests, driver, lock and environment/toolchain; omit secret contents', () => fixture(root => {
  repository(root); const tools = { bun: '1', node: '2', tsc: '3' };
  let input = validation.fingerprint(root, 'local-r1', tools);
  for (const file of ['src/example.ts', 'src/runtime/example.ts', 'tests/example.ts', 'scripts/driver.cjs', 'bun.lock', 'packages/solid-sdk/src/a.ts']) {
    write(root, file, 'changed'); const next = validation.fingerprint(root, 'local-r1', tools); assert.notEqual(next, input, file); input = next;
  }
  write(root, '.env.local', 'DO_NOT_STORE=private'); assert.equal(validation.fingerprint(root, 'local-r1', tools), input);
  for (const file of ['desktop/runtime-pack.json', 'desktop/runtime-pack-budget.json']) {
    write(root, file, 'generated packaging measurement');
    assert.equal(validation.fingerprint(root, 'local-r1', tools), input);
  }
  assert.notEqual(validation.fingerprint(root, 'local-r2', tools), input);
  assert.notEqual(validation.fingerprint(root, 'local-r1', { ...tools, bun: '4' }), input);
  assert.throws(() => validation.fingerprint(root, '', tools), /environment_revision_required/);
}));
test('a successful quick integration becomes frozen evidence without a second execution', () => fixture(root => {
  repository(root); let calls = 0;
  const quick = validation.run(root, 'quick', 'fixture-r1', validation.frozen, () => { calls++; return { status: 0 }; });
  const frozen = validation.run(root, 'frozen', 'fixture-r1', validation.frozen, () => { calls++; return { status: 0 }; });
  assert.equal(calls, 1); assert.equal(frozen.reusedFrom, quick.id);
}));
test('controlled frozen input executes integration once and forged/failed/cancelled/incomplete receipts fail', () => fixture(root => {
  repository(root); let calls = 0;
  const executor = () => { calls++; return { status: 0 }; };
  const first = validation.run(root, 'frozen', 'fixture-r1', validation.frozen, executor);
  const second = validation.run(root, 'frozen', 'fixture-r1', validation.frozen, executor);
  assert.equal(calls, 1); assert.equal(first.id, second.id);
  const directory = path.join(root, '.test-data/development-validation');
  const key = fs.readFileSync(path.join(directory, 'local-key'));
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'frozen.json')));
  assert(validation.valid(envelope, key, first.fingerprint, validation.frozen.commands));
  for (const status of ['failed', 'cancelled', 'running', 'blocked', 'not-started']) {
    const row = { ...first, status }; assert(!validation.valid({ receipt: row, signature: validation.seal(row, key) }, key, first.fingerprint, validation.frozen.commands));
  }
  assert(!validation.valid({ ...envelope, signature: 'forged' }, key, first.fingerprint, validation.frozen.commands));
  const incomplete = { ...first, results: [] };
  assert(!validation.valid({ receipt: incomplete, signature: validation.seal(incomplete, key) }, key, first.fingerprint, validation.frozen.commands));
  write(root, 'src/example.ts', 'new'); validation.run(root, 'frozen', 'fixture-r1', validation.frozen, executor); assert.equal(calls, 2);
  write(root, 'src/example.ts', 'failure'); assert.throws(() => validation.run(root, 'frozen', 'fixture-r1', validation.frozen, () => ({ status: 1 })), /failed/);
  validation.run(root, 'frozen', 'fixture-r1', validation.frozen, executor); assert.equal(calls, 3);
  write(root, 'src/example.ts', 'cancel'); assert.throws(() => validation.run(root, 'frozen', 'fixture-r1', validation.frozen, () => ({ status: null, signal: 'SIGTERM' })), /cancelled/);
}));
test('shared package closure, output tamper and upstream changes invalidate local build reuse', () => fixture(root => {
  const directories = ['solid-sdk', 'shared-ui', 'pod-collections', 'extension-sdk', 'ai-connections', 'pod-settings', 'tasks'];
  for (const name of directories) {
    write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@undefineds.co/${name}`, dependencies: name === 'tasks' ? { '@undefineds.co/extension-sdk': 'workspace:*' } : name === 'extension-sdk' ? { '@undefineds.co/solid-sdk': 'workspace:*' } : {} }));
    write(root, `packages/${name}/src/index.ts`, name);
  }
  const execute = row => { write(root, `${row.directory}/dist/index.js`, 'built'); return { status: 0 }; };
  const first = builds.build(root, ['@undefineds.co/tasks'], execute); assert.deepEqual(first.map(row => row.name), ['@undefineds.co/solid-sdk', '@undefineds.co/extension-sdk', '@undefineds.co/tasks']);
  assert(first.every(row => row.action === 'built'));
  assert(builds.build(root, ['@undefineds.co/tasks'], execute).every(row => row.action === 'reused'));
  write(root, 'packages/tasks/dist/index.js', 'tampered'); assert.equal(builds.build(root, ['@undefineds.co/tasks'], execute).at(-1).action, 'built');
  write(root, 'packages/solid-sdk/src/index.ts', 'changed'); assert(builds.build(root, ['@undefineds.co/tasks'], execute).every(row => row.action === 'built'));
  write(root, 'bun.lock', 'new lock'); assert(builds.build(root, ['@undefineds.co/tasks'], execute).every(row => row.action === 'built'));
  write(root, 'scripts/acceptance-driver.cjs', 'unrelated driver'); assert(builds.build(root, ['@undefineds.co/tasks'], execute).every(row => row.action === 'reused'));
}));
test('immutable desktop transfer rejects missing bytes, altered manifest, version, SHA and run', () => fixture(root => {
  write(root, 'Xpod.zip', 'zip'); write(root, 'Xpod.dmg', 'dmg');
  const sha = 'a'.repeat(40); const digest = artifact.create(root, sha, '0.4.30', '123');
  artifact.verify(root, sha, '0.4.30', '123', digest);
  for (const [s, v, r, d] of [['b'.repeat(40), '0.4.30', '123', digest], [sha, '0.4.31', '123', digest], [sha, '0.4.30', '124', digest], [sha, '0.4.30', '123', '0'.repeat(64)]]) assert.throws(() => artifact.verify(root, s, v, r, d));
  write(root, 'Xpod.zip', 'different'); assert.throws(() => artifact.verify(root, sha, '0.4.30', '123', digest));
  fs.rmSync(path.join(root, 'Xpod.dmg')); assert.throws(() => artifact.create(root, sha, '0.4.30', '123'));
}));
function deployment() { return { spec: { template: { spec: { containers: [{ name: 'app', image: 'ghcr.io/undefinedsco/xpod:old', args: ['start', '-c', 'config/cloud.json'], env: [{ name: 'DB', valueFrom: { secretKeyRef: { name: 'db', key: 'connection-url' } } }] }] } } } }; }
test('production preflight fails safely for key, permission, startup and real environment policy gaps', () => {
  const image = 'ghcr.io/undefinedsco/xpod@sha256:' + 'a'.repeat(64);
  assert.equal(preflight.deploymentCheck(() => ({ data: { 'connection-url': Buffer.from('sensitive-fixture').toString('base64') } }), deployment(), image).checks[0].passed, true);
  for (const resource of [{ data: {} }, { data: { 'connection-url': '' } }]) assert.throws(() => preflight.deploymentCheck(() => resource, deployment(), image), /preflight_reference_key_missing_or_empty/);
  assert.throws(() => preflight.deploymentCheck(() => { throw new preflight.PreflightError('preflight_read_unavailable'); }, deployment(), image), /preflight_read_unavailable/);
  const env = { deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
  assert(!preflight.environmentAllowed(env, [{ type: 'branch', name: 'staging' }], 'tag', 'v0.4.31'));
  assert(preflight.environmentAllowed(env, [{ type: 'tag', name: 'v0.4.31' }], 'tag', 'v0.4.31'));
  assert(!preflight.environmentAllowed(env, [{ type: 'tag', name: 'v0.4.3?' }], 'tag', 'v0.4.31'));
  assert(!preflight.environmentAllowed({ deployment_branch_policy: { protected_branches: true } }, [], 'tag', 'v0.4.31', true));
  const missing = deployment(); missing.spec.template.spec.containers[0].args = []; assert.throws(() => preflight.references(missing, image), /startup_contract_missing/);
  const printed = JSON.stringify(preflight.deploymentCheck(() => ({ data: { 'connection-url': Buffer.from('sensitive-fixture').toString('base64') } }), deployment(), image));
  assert(!printed.includes('sensitive-fixture')); assert(!printed.includes(Buffer.from('sensitive-fixture').toString('base64')));
  const production = deployment(); const productionEnv = production.spec.template.spec.containers[0].env;
  productionEnv.push(...Object.entries({ XPOD_EDITION: 'cloud', CSS_BASE_URL: 'https://id.undefineds.co', CSS_IDENTITY_DB_URL: 'postgresql://db/identity', CSS_SPARQL_ENDPOINT: 'postgresql://db/rdf' }).map(([name, value]) => ({ name, value })));
  preflight.deploymentCheck(() => ({ data: { 'connection-url': Buffer.from('sensitive-fixture').toString('base64') } }), production, image, 'https://id.undefineds.co');
  productionEnv.find(row => row.name === 'CSS_SPARQL_ENDPOINT').value = 'postgresql://db/xpod_rc';
  assert.throws(() => preflight.deploymentCheck(() => ({ data: { 'connection-url': Buffer.from('sensitive-fixture').toString('base64') } }), production, image, 'https://id.undefineds.co'), /production_database_invalid/);
});
test('rollout ignores transient Pending and old pods, fails config early and bounds persistent pulls', () => {
  const pod = reason => ({ metadata: {}, spec: { containers: [{ name: 'app', image: 'new' }] }, status: { containerStatuses: [{ name: 'app', state: { waiting: { reason } } }] } });
  assert.equal(rollout.failureReason({ items: [pod('ContainerCreating')] }, 'app', 'new'), undefined);
  assert.equal(rollout.failureReason({ items: [pod('CreateContainerConfigError')] }, 'app', 'old'), undefined);
  assert.equal(rollout.failureReason({ items: [pod('CreateContainerConfigError')] }, 'app', 'new'), 'rollout_configuration_error');
  let polls = 0; let clock = 0;
  const command = reason => args => args[0] === 'rollout' ? (++polls, clock += 15000, { status: 1 }) : ({ status: 0, stdout: JSON.stringify({ items: [pod(reason)] }) });
  assert.throws(() => rollout.wait('app', 'namespace', 'app', 'new', 900, command('CreateContainerConfigError'), () => clock), /configuration_error/); assert.equal(polls, 1);
  polls = 0; clock = 0;
  assert.throws(() => rollout.wait('app', 'namespace', 'app', 'new', 900, command('ImagePullBackOff'), () => clock), /image_pull_persistent/); assert.equal(polls, 4);
  polls = 0; clock = 0;
  assert.throws(() => rollout.wait('app', 'namespace', 'app', 'new', 30, command('ContainerCreating'), () => clock), /rollout_timeout/); assert.equal(polls, 2);
});
test('document quick checks local relative links and reports missing targets', () => fixture(root => {
  write(root, 'docs/a.md', '[valid](b.md#heading) [external](https://example.com)'); write(root, 'docs/b.md', '# heading');
  assert.equal(links.check(root, ['docs/a.md']), 1);
  write(root, 'docs/a.md', '[missing](missing.md)'); assert.throws(() => links.check(root, ['docs/a.md']), /document_link_missing/);
}));
