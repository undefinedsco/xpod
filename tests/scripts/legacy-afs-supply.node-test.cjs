const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const normal = require('../../scripts/lib/legacy-afs-supply.cjs');
const helper = require('../../scripts/lib/root-registry-supply.cjs');
const { verifyContext } = require('../../scripts/lib/legacy-root-artifact-context.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
test('actual eleven-package source graph selects the standalone AFS emitter without mutating private source', () => {
  const root = path.resolve(__dirname, '../..'), authority = helper.sourceAuthority(root);
  const original = fs.readFileSync(path.join(root, 'packages/xpod-afs/package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/legacy-root-658.package.json')));
  const supplied = ['xpod-cli', 'xpod-client', 'xpod-afs'].map(id => authority.workspaces.get('@undefineds.co/' + id).manifest);
  const recipes = helper.producerRecipes(manifest, authority, supplied);
  assert.equal(recipes.length, 11);
  assert.equal(recipes.filter(row => row.recipe === 'workspace-normal-pack').length, 7);
  assert.equal(recipes.filter(row => row.recipe === 'cli-normal-publication').length, 2);
  assert.equal(recipes.filter(row => row.recipe === 'afs-standalone-js').length, 1);
  assert.equal(recipes.filter(row => row.recipe === 'external-git-normal').length, 1);
  assert.equal(JSON.parse(original).private, true); assert.deepEqual(fs.readFileSync(path.join(root, 'packages/xpod-afs/package.json')), original);
});
function contextFixture() {
  const input = { sourceSha: 'a'.repeat(40), runHeadSha: 'b'.repeat(40), runId: 21, runAttempt: 3, artifactId: 47, artifactSha256: 'c'.repeat(64) };
  const run = { id: 21, run_attempt: 3, head_sha: input.runHeadSha, status: 'in_progress', event: 'pull_request', workflow_id: 9, path: '.github/workflows/legacy-root-compat.yml', repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' } };
  const workflow = { id: 9, path: run.path };
  const artifact = { id: 47, name: `legacy-root-normal-afs-${input.sourceSha}-21-3`, digest: 'sha256:' + input.artifactSha256, expired: false, size_in_bytes: 100, workflow_run: { id: 21, head_sha: input.runHeadSha }, created_at: '2026-10-16T01:01:00Z' };
  const jobs = { total_count: 1, jobs: [{ name: 'legacy-root-normal-afs', status: 'completed', conclusion: 'success', run_id: 21, run_attempt: 3, head_sha: input.runHeadSha, started_at: '2026-10-16T01:00:00Z', completed_at: '2026-10-16T01:02:00Z' }] };
  return { input, metadata: { run, workflow, artifact }, jobs };
}
test('same-run successful producer is independent from the running workflow; stale and partial originals fail closed', () => {
  const f = contextFixture(); verifyContext(f.input, f.metadata, f.jobs);
  const caller = structuredClone(f); caller.metadata.run.path = caller.metadata.workflow.path = '.github/workflows/candidate.yml';
  caller.metadata.run.referenced_workflows = [{ path: 'undefinedsco/xpod/.github/workflows/legacy-root-compat.yml@refs/heads/staging', sha: caller.input.sourceSha }];
  caller.jobs.jobs[0].name = 'legacy_root_compat / legacy-root-normal-afs'; verifyContext(caller.input, caller.metadata, caller.jobs);
  caller.metadata.run.referenced_workflows[0].sha = 'f'.repeat(40); assert.throws(() => verifyContext(caller.input, caller.metadata, caller.jobs));
  for (const mutate of [f => f.input.sourceSha = 'd'.repeat(40), f => f.input.runAttempt++, f => f.metadata.artifact.expired = true,
    f => f.metadata.artifact.digest = 'sha256:' + 'd'.repeat(64), f => f.jobs.jobs[0].conclusion = 'failure', f => f.jobs.jobs[0].status = 'in_progress',
    f => f.jobs.jobs = [], f => f.metadata.artifact.created_at = '2026-10-15T00:00:00Z', f => f.metadata.workflow.path = '.github/workflows/cli-package.yml']) {
    const changed = structuredClone(f); mutate(changed); assert.throws(() => verifyContext(changed.input, changed.metadata, changed.jobs));
  }
});
function fixture(operation) {
  const parent = path.resolve('.test-data/legacy-afs-supply'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { return operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('portable original verifier preserves native receipt coordinates and rejects wrong-source/missing/hash/unclosed inputs', () => fixture(root => {
  const originals = path.join(root, 'originals'); fs.mkdirSync(originals);
  const context = { sourceSha: 'a'.repeat(40), runId: '21', runAttempt: 3 };
  const files = normal.tools.map(file => { const bytes = fs.readFileSync(path.resolve(file)); write(path.join(root, file), bytes); return { path: file, bytes: bytes.length, sha256: hash(bytes), matchesGit: true }; });
  write(path.join(root, 'packages/xpod-afs/package.json'), { name: '@undefineds.co/xpod-afs', version: '1.0.0', private: true });
  const sourceHash = helper.reference(path.join(root, 'packages/xpod-afs/package.json')).sha256;
  const snapshot = { sourceSha: context.sourceSha, clean: true, inputSHA256: 'd'.repeat(64), files };
  for (const stage of ['before', 'after']) write(path.join(originals, 'producer/source-' + stage + '.original.json'), snapshot);
  const closed = (directory, prefix) => { const raw = ['stdout', 'stderr'].map(channel => { const name = prefix + '.' + channel + '.raw.log'; write(path.join(originals, directory, name), 'synthetic closed output'); return { ...helper.reference(path.join(originals, directory, name)), path: name }; }); return { spawnError: null, code: 0, signal: null, actualWait: true, actualClose: true, groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true, pipeEOF: [true, true], raw }; };
  const pack = (relative, manifest, entries = {}) => {
    const stage = fs.mkdtempSync(path.join(root, 'stage-')); write(path.join(stage, 'package/package.json'), manifest);
    for (const [name, body] of Object.entries(entries)) write(path.join(stage, 'package', name), body);
    const target = path.join(originals, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); execFileSync('tar', ['czf', target, '-C', stage, 'package']);
    const bytes = fs.readFileSync(target); return { ...helper.reference(target), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
  };
  const material = '{"fixture":"original producer materials"}';
  const cli = pack('cli/cli.tgz', { name: '@undefineds.co/xpod-cli', version: '1.0.0', exports: { './producer-materials': './dist/producer-materials/index.json' } }, { 'dist/producer-materials/index.json': material });
  const client = pack('cli/client.tgz', { name: '@undefineds.co/xpod-client', version: '1.0.0' });
  const cliContext = { checkoutSha: context.sourceSha, workingTreeDirty: false, runId: '21', runAttempt: '3' };
  write(path.join(originals, 'cli/result.json'), { kind: 'cli-publication-preparation-producer', context: cliContext, privateConsumerArtifactsReused: false, embeddedClientIdentityVerified: true, published: false, releaseQualified: false,
    products: { cli: { version: '1.0.0', archive: { ...cli, path: 'cli.tgz' } }, client: { version: '1.0.0', archive: { ...client, path: 'client.tgz' } } } });
  write(path.join(originals, 'cli/source-inputs.json'), { context: cliContext, files: [files[0]] }); write(path.join(originals, 'cli/cleanup.json'), { success: true, sourceAbsent: true, directChildrenWaited: true });
  const manifest = { name: '@undefineds.co/xpod-afs', version: '1.0.0', private: false, dependencies: { '@undefineds.co/xpod-client': '1.0.0' } };
  const afs = pack('afs/xpod-afs.tgz', manifest);
  const parsed = helper.artifact({ ...afs, name: manifest.name, version: manifest.version });
  const publication = { kind: 'afs-js-normal-publication', name: manifest.name, version: manifest.version, archive: { ...afs, path: '/posix/native/afs/xpod-afs.tgz' }, stage: { manifest, sourceManifestSHA256: sourceHash, inventory: parsed.entries.filter(e => e.type === 'file').map(e => ({ path: e.path.slice(8), bytes: e.content.length, sha256: hash(e.content), mode: e.mode })) }, producerBinding: { indexSHA256: hash(Buffer.from(material)) }, command: closed('afs', 'normal-pack') };
  write(path.join(originals, 'afs/publication.original.json'), publication);
  publication.command.command = 'bun'; publication.command.cwd = '/posix/native/afs/package'; publication.command.args = ['pm', 'pack', '--ignore-scripts', '--filename', publication.archive.path];
  write(path.join(originals, 'afs/publication.original.json'), publication);
  const phases = [{ ...closed('producer', 'normal-cli'), command: '/posix/node', cwd: '/posix/source', args: ['/posix/source/scripts/check-cli-publication.cjs', '--evidence', '/posix/source/.test-data/afs-js-archive-ci-producer'] },
    { ...closed('producer', 'normal-afs'), command: 'bun', cwd: '/posix/source', args: ['/posix/source/packages/xpod-afs/scripts/build-client-publication.ts', '--cli-package', '/posix/cli', '--client-package', '/posix/client', '--output', '/posix/native/afs'] }];
  const nodeRuntime = { ...closed('producer', 'normal-node'), command: 'node', cwd: '/posix/source', args: ['-e', normal.NODE_PROBE] };
  write(path.join(originals, 'producer', nodeRuntime.raw[0].path), { execPath: '/posix/node', node: '22.21.1', bun: null });
  nodeRuntime.raw[0] = { ...helper.reference(path.join(originals, 'producer', nodeRuntime.raw[0].path)), path: nodeRuntime.raw[0].path };
  const index = { kind: 'legacy-root-original-afs-supply', nodeRuntime, nativeSourceRoot: '/posix/source', ...context, runHeadSha: 'b'.repeat(40), sourceBefore: 'producer/source-before.original.json', sourceAfter: 'producer/source-after.original.json', phases, producerTools: normal.tools.map(file => ({ file, ...helper.reference(path.join(root, file)) })), members: normal.inventory(originals), releaseQualified: false };
  const indexFile = path.join(originals, 'supply-index.original.json'); write(indexFile, index);
  assert.equal(normal.verify(originals, context, root).artifacts.length, 3);
  // Synthetic same-run custody joins the real shared ZIP parser to portable verification.
  const custody = path.join(root, 'custody'); fs.mkdirSync(custody);
  const archive = path.join(custody, 'artifact.zip');
  const zipped = spawnSync('python3', ['-c', "import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for p in pathlib.Path(sys.argv[1]).rglob('*'):\n  if p.is_file(): z.write(p,p.relative_to(sys.argv[1]).as_posix())", originals, archive], { encoding: 'utf8' }); assert.equal(zipped.status, 0, zipped.stderr);
  const archiveRef = helper.reference(archive, 16 * 1024 ** 2);
  const f = contextFixture(); f.input.artifactSha256 = archiveRef.sha256; f.metadata.artifact.digest = 'sha256:' + archiveRef.sha256; f.metadata.artifact.size_in_bytes = archiveRef.bytes;
  const inspected = spawnSync('python3', [path.resolve('scripts/lib/inspect-product-artifact.py'), archive, archiveRef.sha256, String(16 * 1024 ** 2), String(40 * 1024 ** 2), '4096'], { encoding: 'utf8' }); assert.equal(inspected.status, 0, inspected.stderr);
  const originalsBinding = {};
  for (const name of ['run', 'workflow', 'artifact']) { const member = 'metadata/' + name + '.original.json'; write(path.join(custody, member), f.metadata[name]); originalsBinding[name] = { ...helper.reference(path.join(custody, member)), path: member }; }
  write(path.join(custody, 'metadata.json'), f.metadata); write(path.join(custody, 'metadata/jobs.original.json'), f.jobs);
  const custodyReceipt = { kind: 'legacy-root-same-run-acquisition', status: 'blocked', ...f.input, expectedSourceSha: context.sourceSha, archive: { ...archiveRef, path: 'artifact.zip' },
    inventory: JSON.parse(inspected.stdout), metadata: { originals: originalsBinding, projection: { ...helper.reference(path.join(custody, 'metadata.json')), path: 'metadata.json' } }, producerJob: { ...helper.reference(path.join(custody, 'metadata/jobs.original.json')), path: 'metadata/jobs.original.json' } };
  write(path.join(custody, 'receipt.json'), custodyReceipt);
  const request = { input: f.input, custodyReceipt: helper.reference(path.join(custody, 'receipt.json')), index: helper.reference(indexFile) }; write(path.join(root, 'request.original.json'), request);
  const environmentKeys = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod', GITHUB_RUN_ID: '21', GITHUB_RUN_ATTEMPT: '3' });
    assert.equal(normal.verifyCustody(root, context, root).artifacts.length, 3);
    process.env.GITHUB_RUN_ID = '22'; assert.throws(() => normal.verifyCustody(root, context, root));
    process.env.GITHUB_RUN_ID = '21'; process.env.GITHUB_RUN_ATTEMPT = '4'; assert.throws(() => normal.verifyCustody(root, context, root));
    assert.equal(normal.verifyCustody(root, context, root, { retained: true }).artifacts.length, 3);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.deepEqual(Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])), saved);

  for (const mutate of [v => v.sourceSha = 'f'.repeat(40), v => v.runAttempt++, v => v.phases[0].groupAbsent = false, v => v.phases[0].command = '/posix/bun', v => v.nodeRuntime.args = ['-e', 'unqualified'], v => v.members[0].sha256 = '0'.repeat(64), v => v.members.push(v.members[0]), v => v.members[0].member = '../outside']) {
    const changed = structuredClone(index); mutate(changed); write(indexFile, changed); assert.throws(() => normal.verify(originals, context, root));
  }
  write(indexFile, index); fs.unlinkSync(path.join(originals, 'cli/client.tgz')); assert.throws(() => normal.verify(originals, context, root));
}));
test('shared ZIP projection copies only original canonical members and rejects unsafe or over-budget archives', () => fixture(root => {
  const parser = path.resolve('scripts/lib/inspect-product-artifact.py');
  const make = (entries, selections, limits = [16 * 1024 ** 2, 40 * 1024 ** 2, 4096]) => {
    const archive = path.join(root, 'case.zip'), output = path.join(root, 'output');
    fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output);
    const made = spawnSync('python3', ['-c', "import sys,json,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for row in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(row['name']);i.create_system=3;i.external_attr=row.get('mode',33188)<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i, row.get('body','x')*row.get('repeat',1))", archive, JSON.stringify(entries)], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
    return { output, result: spawnSync('python3', [parser, archive, hash(fs.readFileSync(archive)), ...limits.map(String), JSON.stringify(selections), output, 'legacy-root-normal-supply'], { encoding: 'utf8', maxBuffer: 1024 ** 2 }) };
  };
  const selected = [{ path: 'afs/.original', destination: 'afs/.original', bytes: 1, sha256: hash(Buffer.from('x')) }];
  const valid = make([{ name: 'afs/.original' }], selected); assert.equal(valid.result.status, 0, valid.result.stderr); assert.equal(fs.readFileSync(path.join(valid.output, 'afs/.original'), 'utf8'), 'x');
  for (const entries of [[{ name: 'afs/a' }, { name: 'afs/a' }], [{ name: '/afs/a' }], [{ name: 'afs/../a' }], [{ name: 'afs//a' }], [{ name: 'afs\\a' }], [{ name: 'afs/\u0001a' }], [{ name: 'afs/link', mode: 0o120777 }], [{ name: 'afs/big', repeat: 8 * 1024 ** 2 + 1 }]]) assert.notEqual(make(entries, []).result.status, 0);
  assert.notEqual(make([{ name: 'afs/a', repeat: 11 }], [], [10000, 10, 4096]).result.status, 0);
  assert.notEqual(make([{ name: 'afs/a' }, { name: 'afs/b' }], [], [10000, 10000, 1]).result.status, 0);
  assert.notEqual(make([{ name: 'other/a' }], [{ path: 'other/a', destination: 'other/a', bytes: 1, sha256: hash(Buffer.from('x')) }]).result.status, 0);
}));
test('workflow blocks every lane on the same-run successful producer and uses artifact ID/digest outputs', () => {
  const workflow = require('yaml').parse(fs.readFileSync(path.resolve('.github/workflows/legacy-root-compat.yml'), 'utf8'));
  assert.deepEqual(workflow.jobs.lanes.needs, ['plan', 'normal_afs']); assert.equal(workflow.jobs.normal_afs.name, 'legacy-root-normal-afs');
  assert.equal(workflow.jobs.normal_afs.if, undefined); assert.equal(workflow.jobs.normal_afs['continue-on-error'], undefined);
  const upload = workflow.jobs.normal_afs.steps.find(row => row.id === 'upload'); assert.equal(upload.if, undefined); assert.equal(upload['continue-on-error'], undefined);
  const diagnostics = workflow.jobs.normal_afs.steps.find(row => row.name === 'Retain original producer diagnostics even when supply fails');
  assert.equal(diagnostics.if, 'always()'); assert.equal(diagnostics['continue-on-error'], undefined); assert.ok(diagnostics.with.path.includes('.test-data/afs-js-archive-ci-producer/')); assert.notEqual(diagnostics.with.name, upload.with.name);
  assert.equal(workflow.jobs.lanes.if, undefined);
  const produce = workflow.jobs.normal_afs.steps.find(row => row.run?.includes('legacy-root-afs-supply.ts produce'));
  assert.equal(produce.env.EVENT_HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}'); assert.equal(produce.env.GITHUB_EVENT_HEAD_SHA, undefined);
  const acquire = workflow.jobs.lanes.steps.find(row => row.run?.includes('legacy-root-afs-supply.ts acquire'));
  assert.equal(acquire.if, "matrix.runtime == 'bun'"); assert.equal(acquire.env.SUPPLY_ARTIFACT_ID, '${{ needs.normal_afs.outputs.artifact-id }}'); assert.equal(acquire.env.SUPPLY_ARTIFACT_SHA256, '${{ needs.normal_afs.outputs.artifact-digest }}');
});

test('actual Bun entry starts the normal CLI command under explicitly qualified Node 22', () => fixture(root => {
  const control = path.join(root, 'control'); fs.mkdirSync(control);
  const cliDirectory = path.join(root, 'cli-evidence');
  write(path.join(root, 'scripts/check-cli-publication.cjs'), "process.stdout.write(JSON.stringify({execPath:process.execPath,node:process.versions.node,bun:process.versions.bun??null,args:process.argv.slice(2)}))");
  const output = path.join(root, 'actual.original.json');
  const code = `const fs=require('node:fs');const helper=require(${JSON.stringify(path.resolve('scripts/lib/legacy-afs-supply.cjs'))});const result=await helper.runNormalCli(${JSON.stringify(root)},${JSON.stringify(control)},${JSON.stringify(cliDirectory)});fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({parentBun:process.versions.bun,...result}));`;
  const result = spawnSync('bun', ['-e', code], { env: process.env, encoding: 'utf8', timeout: 10000 }); assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(fs.readFileSync(output)); assert.ok(observed.parentBun);
  const qualified = normal.verifyNodeRuntime(observed.runtime, control);
  assert.equal(observed.phase.command, qualified.execPath);
  require('../../scripts/check-afs-js-archive-ci.cjs').closedOriginal(observed.phase, control);
  const child = JSON.parse(fs.readFileSync(path.join(control, observed.phase.raw[0].path)));
  assert.equal(child.bun, null); assert.match(child.node, /^22\./); assert.equal(child.execPath, qualified.execPath); assert.deepEqual(child.args, ['--evidence', cliDirectory]);
}));

test('portable fixture isolates and restores a different CI run and attempt in a real child', () => {
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod', GITHUB_RUN_ID: '38850607818', GITHUB_RUN_ATTEMPT: '7' };
  // Start an independent test runner, rather than inheriting node:test child IPC mode.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^portable original verifier', __filename], {
    env,
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1/); assert.match(result.stdout, /# fail 0/);
});
