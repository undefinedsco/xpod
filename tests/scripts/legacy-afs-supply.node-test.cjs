const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const normal = require('../../scripts/lib/legacy-afs-supply.cjs');
const helper = require('../../scripts/lib/root-registry-supply.cjs');
const { verifyContext, verifyProducerClosure, producerClosure } = require('../../scripts/lib/legacy-root-artifact-context.cjs');
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

// Exact shape of the retained original producer job as the GitHub API returns it
// for run 40520472407 / job 122246082451: every recorded step completed and
// successful, the final `Complete job` step closed at 14:23:34Z, while the job
// header itself stayed in_progress/null with a null completed_at.
function staleHeaderProducerJob() {
  const at = ['2026-10-27T14:22:47Z', '2026-10-27T14:22:47Z', '2026-10-27T14:22:47Z', '2026-10-27T14:22:49Z',
    '2026-10-27T14:22:49Z', '2026-10-27T14:22:50Z', '2026-10-27T14:22:50Z', '2026-10-27T14:22:51Z',
    '2026-10-27T14:22:51Z', '2026-10-27T14:23:00Z', '2026-10-27T14:23:00Z', '2026-10-27T14:23:21Z',
    '2026-10-27T14:23:21Z', '2026-10-27T14:23:23Z', '2026-10-27T14:23:23Z', '2026-10-27T14:23:32Z',
    '2026-10-27T14:23:32Z', '2026-10-27T14:23:33Z', '2026-10-27T14:23:33Z', '2026-10-27T14:23:33Z',
    '2026-10-27T14:23:33Z', '2026-10-27T14:23:33Z', '2026-10-27T14:23:33Z', '2026-10-27T14:23:34Z',
    '2026-10-27T14:23:34Z', '2026-10-27T14:23:34Z'];
  const names = ['Set up job', 'Run actions/checkout@v4', 'Run oven-sh/setup-bun@v2', 'Run actions/setup-node@v4',
    'Run bun install --frozen-lockfile', 'Produce original CLI, client and standalone AFS JS distributions',
    'Run actions/upload-artifact@v4', 'Retain full normal CLI sourcekit originals even when supply fails',
    'Retain original producer diagnostics even when supply fails', 'Post Run actions/setup-node@v4',
    'Post Run oven-sh/setup-bun@v2', 'Post Run actions/checkout@v4', 'Complete job'];
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19];
  const steps = names.map((name, index) => ({
    number: numbers[index], name, status: 'completed', conclusion: 'success',
    started_at: at[index * 2], completed_at: at[index * 2 + 1],
  }));
  // the legacy workflow's own job name; the scoped `legacy_root_compat / ...` form is
  // what the candidate workflow reports for the same referenced producer.
  return { id: 122246082451, name: 'legacy-root-normal-afs', status: 'in_progress',
    conclusion: null, started_at: '2026-10-27T14:22:46Z', completed_at: null,
    run_id: 40520472407, run_attempt: 1, head_sha: 'b'.repeat(40), steps };
}
test('actual stale-header producer job closes by explicit step evidence without mutating the header', () => {
  const input = { sourceSha: 'a'.repeat(40), runHeadSha: 'b'.repeat(40), runId: 40520472407, runAttempt: 1, artifactId: 12741457563, artifactSha256: 'c'.repeat(64) };
  const run = { id: 40520472407, run_attempt: 1, head_sha: input.runHeadSha, status: 'in_progress', event: 'pull_request', workflow_id: 9, path: '.github/workflows/legacy-root-compat.yml', repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' }, run_started_at: '2026-10-27T14:22:20Z' };
  const workflow = { id: 9, path: run.path };
  const artifact = { id: 12741457563, name: `legacy-root-normal-afs-${input.sourceSha}-40520472407-1`, digest: 'sha256:' + input.artifactSha256, expired: false, size_in_bytes: 3968335, workflow_run: { id: 40520472407, head_sha: input.runHeadSha }, created_at: '2026-10-27T14:23:22Z' };
  const job = staleHeaderProducerJob();
  const jobs = { total_count: 1, jobs: [job] };
  const before = JSON.stringify(jobs);
  const verified = verifyProducerClosure(input, run, workflow, jobs);
  assert.deepEqual(verified.closure, { source: 'steps', completedAt: '2026-10-27T14:23:34Z' });
  assert.equal(verified.job.status, 'in_progress');
  assert.equal(verified.job.completed_at, null);
  assert.equal(JSON.stringify(jobs), before, 'retained original metadata must stay byte-identical');
  // the downstream custody check derives the SAME closure
  const context = verifyContext(input, { run, workflow, artifact }, jobs);
  assert.deepEqual(context.closure, verified.closure);
  // the original completed/success header path is unchanged
  const terminal = structuredClone(jobs);
  terminal.jobs[0].status = 'completed'; terminal.jobs[0].conclusion = 'success'; terminal.jobs[0].completed_at = '2026-10-27T14:23:34Z';
  assert.deepEqual(verifyProducerClosure(input, run, workflow, terminal).closure, { source: 'header', completedAt: '2026-10-27T14:23:34Z' });
});
test('producer closure refuses every partial, failed, ambiguous, misordered or unclosed step shape', () => {
  const input = { sourceSha: 'a'.repeat(40), runHeadSha: 'b'.repeat(40), runId: 40520472407, runAttempt: 1, artifactId: 12741457563, artifactSha256: 'c'.repeat(64) };
  const base = () => staleHeaderProducerJob();
  const closureIndex = 12;
  // A still-running job is NOT an error: it returns null so the caller keeps
  // polling inside the existing bound. Everything below is a terminal defect.
  // A job whose steps are recorded but whose `Complete job` is not recorded yet is
  // still legitimately in flight, so it polls instead of throwing.
  const pendingClosure = base(); pendingClosure.steps.pop();
  assert.equal(producerClosure(input, pendingClosure), null, 'unrecorded closure step still polls');
  const pendingHeader = base(); pendingHeader.completed_at = '2026-10-27T14:23:34Z';
  assert.equal(producerClosure(input, pendingHeader), null, 'timestamp arriving before terminal status still polls');
  const noSteps = base(); noSteps.steps = [];
  assert.equal(producerClosure(input, noSteps), null, 'job without steps yet still polls');
  const stillRunning = base();
  stillRunning.steps[closureIndex] = { ...stillRunning.steps[closureIndex], status: 'in_progress', conclusion: null, completed_at: null };
  assert.equal(producerClosure(input, stillRunning), null, 'still-running producer polls, never closes');
  const cases = [
    ['completed header without conclusion', job => { job.status = 'completed'; }],
    ['nonterminal header with conclusion', job => { job.conclusion = 'success'; }],
    ['failed step', job => { job.steps[5].conclusion = 'failure'; }],
    ['cancelled step', job => { job.steps[5].conclusion = 'cancelled'; }],
    ['unknown step conclusion', job => { job.steps[5].conclusion = 'neutral'; }],
    ['duplicate closure step', job => { const last = job.steps[closureIndex]; job.steps[closureIndex - 1].name = 'Complete job'; }],
    ['closure not final', job => { job.steps.push({ number: 20, name: 'Post Run x', status: 'completed', conclusion: 'success', started_at: '2026-10-27T14:23:34Z', completed_at: '2026-10-27T14:23:34Z' }); }],
    ['closure failed', job => { job.steps[closureIndex].conclusion = 'failure'; }],
    ['closure skipped', job => { job.steps[closureIndex].conclusion = 'skipped'; }],
    ['duplicate step number', job => { job.steps[2].number = job.steps[1].number; }],
    ['unordered step numbers', job => { job.steps[2].number = job.steps[1].number - 1; }],
    ['non-integer step number', job => { job.steps[2].number = '3'; }],
    ['duplicate produce step', job => { job.steps[8].name = 'Produce original CLI, client and standalone AFS JS distributions'; }],
    ['duplicate upload step', job => { job.steps[8].name = 'Run actions/upload-artifact@v4'; }],
    ['duplicate critical step later failure', job => { job.steps[8].name = 'Produce original CLI, client and standalone AFS JS distributions'; job.steps[8].conclusion = 'failure'; }],
    ['duplicate upload step later failure', job => { job.steps[8].name = 'Run actions/upload-artifact@v4'; job.steps[8].conclusion = 'failure'; }],
    ['produce completes after upload starts', job => { job.steps[5].completed_at = '2026-10-27T14:23:22Z'; }],
    ['upload completes after closure starts', job => { job.steps[6].completed_at = '2026-10-27T14:23:35Z'; }],
    ['missing produce step', job => { job.steps[5].name = 'Something else'; }],
    ['failed produce step', job => { job.steps[5].conclusion = 'failure'; }],
    ['missing upload step', job => { job.steps[6].name = 'Something else'; }],
    ['failed upload step', job => { job.steps[6].conclusion = 'failure'; }],
    ['upload before produce', job => { const produced = job.steps[5]; job.steps[5] = job.steps[6]; job.steps[6] = produced; }],
    ['step starts before job', job => { job.steps[0].started_at = '2026-10-27T14:22:00Z'; }],
    ['step ends after closure', job => { job.steps[6].completed_at = '2026-10-27T14:24:00Z'; }],
    ['closure without timestamp', job => { job.steps[closureIndex].completed_at = null; }],
    ['closure before start', job => { job.steps[closureIndex].completed_at = '2026-10-27T14:00:00Z'; }],
    ['unknown header status', job => { job.status = 'weird'; }],
    ['run id mismatch', job => { job.run_id = 1; }],
    ['attempt mismatch', job => { job.run_attempt = 2; }],
    ['head mismatch', job => { job.head_sha = 'd'.repeat(40); }],
  ];
  for (const [label, mutate] of cases) {
    const job = base(); mutate(job);
    assert.throws(() => producerClosure(input, job), undefined, label);
  }
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    const job = base(); job.status = 'completed'; job.conclusion = conclusion; job.completed_at = '2026-10-27T14:23:34Z';
    assert.throws(() => producerClosure(input, job), undefined, 'terminal ' + conclusion);
  }
  // duplicate/absent producer job selection and inventory drift
  const run = { id: 40520472407, run_attempt: 1, head_sha: input.runHeadSha, status: 'in_progress', event: 'pull_request', workflow_id: 9, path: '.github/workflows/legacy-root-compat.yml', repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' }, run_started_at: '2026-10-27T14:22:20Z' };
  const workflow = { id: 9, path: run.path };
  for (const jobs of [{ total_count: 2, jobs: [base()] }, { total_count: 1, jobs: [base(), base()] }, { total_count: 1, jobs: [{ ...base(), name: 'other' }] }]) {
    assert.throws(() => verifyProducerClosure(input, run, workflow, jobs));
  }
  // a stale header whose artifact lands after the step closure is refused
  const artifactLate = { id: 12741457563, name: `legacy-root-normal-afs-${input.sourceSha}-40520472407-1`, digest: 'sha256:' + input.artifactSha256, expired: false, size_in_bytes: 100, workflow_run: { id: 40520472407, head_sha: input.runHeadSha }, created_at: '2026-10-27T15:00:00Z' };
  assert.throws(() => verifyContext(input, { run, workflow, artifact: artifactLate }, { total_count: 1, jobs: [base()] }));
  const artifactEarly = { ...artifactLate, created_at: '2026-10-27T14:00:00Z' };
  assert.throws(() => verifyContext(input, { run, workflow, artifact: artifactEarly }, { total_count: 1, jobs: [base()] }));
  const expired = { ...artifactLate, created_at: '2026-10-27T14:23:22Z', expired: true };
  assert.throws(() => verifyContext(input, { run, workflow, artifact: expired }, { total_count: 1, jobs: [base()] }));
  const wrongDigest = { ...artifactLate, created_at: '2026-10-27T14:23:22Z', digest: 'sha256:' + 'd'.repeat(64) };
  assert.throws(() => verifyContext(input, { run, workflow, artifact: wrongDigest }, { total_count: 1, jobs: [base()] }));
  const wrongName = { ...artifactLate, created_at: '2026-10-27T14:23:22Z', name: 'legacy-root-normal-afs-' + input.sourceSha + '-40520472407-2' };
  assert.throws(() => verifyContext(input, { run, workflow, artifact: wrongName }, { total_count: 1, jobs: [base()] }));
});

function fixture(operation) {
  const parent = path.resolve('.test-data/legacy-afs-supply'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { return operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('portable original verifier preserves native receipt coordinates and rejects wrong-source/missing/hash/unclosed inputs', () => fixture(root => {
  const originals = path.join(root, 'originals'); fs.mkdirSync(originals);
  const context = { sourceSha: 'a'.repeat(40), runId: '21', runAttempt: 3 };
  const files = normal.tools.map(file => { const bytes = fs.readFileSync(path.resolve(file)); write(path.join(root, file), bytes); return { path: file, bytes: bytes.length, sha256: hash(bytes), matchesGit: true }; });
  write(path.join(root, 'packages/xpod-afs/package.json'), JSON.stringify({ name: '@undefineds.co/xpod-afs', version: '1.0.0', private: true }, null, 2) + '\n');
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
  write(path.join(originals, 'cli/source-inputs.json'), { context: cliContext, files: [files[0]] });
  const cliCommands = Array.from({ length: 10 }, (_, index) => {
    const label = 'phase-' + String(index).padStart(3, '0'), outcome = closed('cli', label);
    const member = label + '.receipt.json'; write(path.join(originals, 'cli', member), outcome);
    return { phase: 'synthetic CLI phase ' + index,
      receipt: { path: member, sha256: helper.reference(path.join(originals, 'cli', member)).sha256 }, ...outcome };
  });
  write(path.join(originals, 'cli/cleanup.json'), { schemaVersion: 1, kind: 'cli-publication-owned-command-cleanup',
    success: true, sourceAbsent: true, commandOutcomes: cliCommands });
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
  // All twelve tools remain canonical: only the cross-OS source manifest changes.
  const manifestFile = path.join(root, 'packages/xpod-afs/package.json'), manifestLF = fs.readFileSync(manifestFile);
  fs.writeFileSync(manifestFile, manifestLF.toString('utf8').replace(/\n/g, '\r\n'));
  assert.throws(() => normal.verify(originals, context, root), error => error.code === 'ERR_ASSERTION' && error.actual === sourceHash && error.expected === hash(fs.readFileSync(manifestFile)));
  fs.writeFileSync(manifestFile, Buffer.concat([manifestLF, Buffer.from(' ')]));
  assert.throws(() => normal.verify(originals, context, root), error => error.code === 'ERR_ASSERTION' && error.actual === sourceHash && error.expected === hash(fs.readFileSync(manifestFile)));
  fs.writeFileSync(manifestFile, manifestLF);
  assert.equal(normal.verify(originals, context, root).artifacts.length, 3);
  const toolFile = path.join(root, normal.tools[0]), toolBytes = fs.readFileSync(toolFile);
  fs.appendFileSync(toolFile, '\n// changed producer bytes\n');
  assert.throws(() => normal.verify(originals, context, root), /strictly equal/);
  fs.writeFileSync(toolFile, toolBytes);
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
  assert.equal(diagnostics.if, 'always()'); assert.equal(diagnostics['continue-on-error'], undefined); assert.equal(diagnostics.with.path, '${{ runner.temp }}/legacy-root-normal-afs/'); const fullOriginals = workflow.jobs.normal_afs.steps.find(row => row.name === 'Retain full normal CLI sourcekit originals even when supply fails'); assert.equal(fullOriginals.if, 'always()'); assert.equal(fullOriginals.with.path, '.test-data/afs-js-archive-ci-producer/'); assert.match(fullOriginals.with.name, /^legacy-root-normal-cli-originals-/); assert.notEqual(diagnostics.with.name, upload.with.name);
  assert.equal(workflow.jobs.lanes.if, undefined);
  const acquisitionDiagnostics = workflow.jobs.lanes.steps.find(row => row.name === 'Retain exact Bun acquisition diagnostics');
  assert.equal(acquisitionDiagnostics.if, "${{ always() && matrix.runtime == 'bun' }}");
  assert.equal(acquisitionDiagnostics.with.path, '${{ runner.temp }}/legacy-root-afs-input/');
  assert.notEqual(acquisitionDiagnostics.with.name, upload.with.name);
  const produce = workflow.jobs.normal_afs.steps.find(row => row.run?.includes('legacy-root-afs-supply.ts produce'));
  assert.equal(produce.env.EVENT_HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}'); assert.equal(produce.env.GITHUB_EVENT_HEAD_SHA, undefined);
  const acquire = workflow.jobs.lanes.steps.find(row => row.run?.includes('legacy-root-afs-supply.ts acquire'));
  assert.equal(acquire.if, "matrix.runtime == 'bun'"); assert.equal(acquire.env.SUPPLY_ARTIFACT_ID, '${{ needs.normal_afs.outputs.artifact-id }}'); assert.equal(acquire.env.SUPPLY_ARTIFACT_SHA256, '${{ needs.normal_afs.outputs.artifact-digest }}');
});

test('actual Bun entry qualifies Node 22 but refuses an extended parent budget outside the canonical recipe', () => fixture(root => {
  const control = path.join(root, 'control'); fs.mkdirSync(control);
  const cliDirectory = path.join(root, 'cli-evidence'), executed = path.join(root, 'candidate-executed');
  write(path.join(root, 'scripts/check-cli-publication.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(executed)},'unexpected')`);
  const output = path.join(root, 'actual.original.json');
  const code = `const fs=require('node:fs');const helper=require(${JSON.stringify(path.resolve('scripts/lib/legacy-afs-supply.cjs'))});try{await helper.runNormalCli(${JSON.stringify(root)},${JSON.stringify(control)},${JSON.stringify(cliDirectory)});throw new Error('unexpected success')}catch(error){fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({parentBun:process.versions.bun,error:error.message}));}`;
  const result = spawnSync('bun', ['-e', code], { env: process.env, encoding: 'utf8', timeout: 10000 }); assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(fs.readFileSync(output)); assert.ok(observed.parentBun); assert.match(observed.error, /Invalid command evidence budget/);
  const runtime = JSON.parse(fs.readFileSync(path.join(control, 'normal-node.receipt.json')));
  normal.verifyNodeRuntime(runtime, control);
  assert.equal(fs.existsSync(executed), false);
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
