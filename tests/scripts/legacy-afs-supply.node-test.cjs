const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const normal = require('../../scripts/lib/legacy-afs-supply.cjs');
const helper = require('../../scripts/lib/root-registry-supply.cjs');
const { verifyContext, verifyProducerClosure, producerClosure } = require('../../scripts/lib/legacy-root-artifact-context.cjs');
const { buildNormalSupplyFixture, contextFixture } = require('./helpers/legacy-afs-supply-fixture.cjs');
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

test('partial rerun: producer attempt 1 retained for a consumer lane on attempt 2', () => {
  // The real defect: a successful producer executed on attempt 1, then a partial
  // rerun makes the consuming lane attempt 2. The artifact name and the producer
  // job are bound to attempt 1 and must still verify; the consumer keeps its own 2.
  const f = contextFixture();
  f.input.runAttempt = 1;
  f.metadata.run.run_attempt = 1;
  f.metadata.artifact.name = `legacy-root-normal-afs-${f.input.sourceSha}-${f.input.runId}-1`;
  f.jobs.jobs[0].run_attempt = 1;
  verifyContext(f.input, f.metadata, f.jobs);

  // Same-run/same-source/digest positive: identical producer coordinates still verify.
  verifyContext({ ...f.input }, structuredClone(f.metadata), structuredClone(f.jobs));

  // The producer attempt must NOT be accepted for any other number: a future or
  // merely-"<=" attempt is a hard failure, never a tolerated window.
  for (const wrongAttempt of [2, 3, 4, 0, -1]) {
    const changed = structuredClone(f);
    changed.input.runAttempt = wrongAttempt;
    assert.throws(() => verifyContext(changed.input, changed.metadata, changed.jobs),
      `producer attempt ${wrongAttempt} must not verify`);
  }

  // Wrong source / run / digest against the retained producer all fail closed.
  for (const mutate of [
    c => { c.input.sourceSha = 'd'.repeat(40); },
    c => { c.input.runId = 999; },
    c => { c.input.runHeadSha = 'e'.repeat(40); },
    c => { c.input.artifactSha256 = 'd'.repeat(64); },
    c => { c.input.artifactId = 999999; },
    c => { c.metadata.artifact.name = `legacy-root-normal-afs-${c.input.sourceSha}-${c.input.runId}-2`; },
    c => { c.metadata.artifact.digest = 'sha256:' + 'd'.repeat(64); },
    c => { c.jobs.jobs[0].conclusion = 'failure'; },
    c => { c.jobs.jobs[0].status = 'in_progress'; },
    c => { c.jobs.jobs[0].run_attempt = 2; },
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.throws(() => verifyContext(changed.input, changed.metadata, changed.jobs));
  }
});

test('real verifyCustody binds the producer coordinate, not the caller context', () => {
  // Drives the REAL verifyCustody against a minimal on-disk request receipt. This
  // is the R3/P1 blocker reproduced end to end: readRootSupply hands over the
  // consumer's own build input (attempt 2) while the retained originals belong to
  // producer attempt 1. A mirror of the clause cannot show that; this does.
  const saved = { ...process.env };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(__dirname, '..', '..', '.test-data', 'legacy-afs-custody-')));
  try {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = '40637818669';
    process.env.GITHUB_RUN_ATTEMPT = '2';

    const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), SHA = 'c'.repeat(64);
    const make = (dir, producerAttempt, consumerAttempt) => {
      fs.mkdirSync(path.join(dir, 'custody'), { recursive: true });
      const input = { sourceSha: SOURCE, runId: 40637818669, runAttempt: producerAttempt,
        runHeadSha: HEAD, artifactId: 47, artifactSha256: SHA };
      const request = { input, producerAttempt, consumerAttempt,
        custodyReceipt: { path: 'receipt.json', bytes: 1, sha256: SHA },
        index: { path: 'supply-index.original.json', bytes: 1, sha256: SHA } };
      fs.writeFileSync(path.join(dir, 'request.original.json'), JSON.stringify(request));
      return request;
    };

    // The split pair is consistent: producer 1 recorded, and the caller context is
    // the consumer's own attempt 2 — exactly readRootSupply's situation. Asserting
    // that the coordinate gate no longer fires 1 !== 2 is the regression proof.
    const dir = path.join(root, 'split');
    const request = make(dir, 1, 2);
    const context = { sourceSha: SOURCE, runId: 40637818669, runAttempt: 2 };
    // It still fails later (no real custody receipt bytes on disk), but never with
    // the old coordinate mismatch message.
    let error;
    try { normal.verifyCustody(dir, context, root); } catch (caught) { error = caught; }
    assert.ok(error, 'verifyCustody must fail without real custody originals');
    assert.doesNotMatch(String(error.message), /1 !== 2|expected 1 to equal 2/,
      'R2 defect: consumer context must not be compared to the producer coordinate');

    // One-sided replacement of the producer coordinate is refused.
    const bad = path.join(root, 'onesided');
    const badRequest = make(bad, 1, 2);
    badRequest.producerAttempt = 3;
    fs.writeFileSync(path.join(bad, 'request.original.json'), JSON.stringify(badRequest));
    assert.throws(() => normal.verifyCustody(bad, context, root), /producer coordinate\/selector mismatch/);

    // consumer < producer is refused as an impossible ordering.
    const inverted = path.join(root, 'inverted');
    make(inverted, 2, 1);
    const invertedRequest = JSON.parse(fs.readFileSync(path.join(inverted, 'request.original.json')));
    invertedRequest.input.runAttempt = 2;
    fs.writeFileSync(path.join(inverted, 'request.original.json'), JSON.stringify(invertedRequest));
    assert.throws(() => normal.verifyCustody(inverted, { ...context, runAttempt: 1 }, root),
      /consumer attempt precedes its producer/);
    assert.equal(request.producerAttempt, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
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
  // The complete original fixture (root files, three real tgz members, index,
  // commands, source and tool refs, real ZIP, custody metadata/receipt/request) is
  // built by the shared helper. Defaults keep producer attempt 3 and a split-less
  // request, so every existing assertion below observes the same shapes as before.
  const built = buildNormalSupplyFixture(root);
  const originals = built.originals, context = built.context, index = built.index, indexFile = built.indexFile;
  const request = built.request, custody = built.custody, archive = built.archive, archiveRef = built.archiveRef;
  const f = { input: built.input, metadata: built.metadata, jobs: built.jobs };
  // The cross-OS source manifest hash the builder bound into the afs publication.
  const sourceHash = helper.reference(path.join(root, 'packages/xpod-afs/package.json')).sha256;
  assert.equal(built.artifacts.length, 3);
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
  // Custody, archive, metadata and the pre-existing same-run request all come from
  // the builder; the assertions below still exercise the real verifier paths.
  const environmentKeys = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod', GITHUB_RUN_ID: '21', GITHUB_RUN_ATTEMPT: '3' });
    assert.equal(normal.verifyCustody(root, context, root).artifacts.length, 3);
    process.env.GITHUB_RUN_ID = '22'; assert.throws(() => normal.verifyCustody(root, context, root));
    process.env.GITHUB_RUN_ID = '21'; process.env.GITHUB_RUN_ATTEMPT = '4'; assert.throws(() => normal.verifyCustody(root, context, root));
    assert.equal(normal.verifyCustody(root, context, root, { retained: true }).artifacts.length, 3);

    // R3 full-chain positive: the SAME real custody/originals are read by a caller
    // whose own context is consumer attempt 2, while the producer coordinate stays
    // 3 (this fixture's producer). This is exactly readRootSupply's situation and it
    // must still return the real three artifacts, not fail 3 !== 2.
    const splitRequest = { ...request, producerAttempt: 3, consumerAttempt: 4 };
    write(path.join(root, 'request.original.json'), splitRequest);
    process.env.GITHUB_RUN_ATTEMPT = '4';
    const splitResult = normal.verifyCustody(root, { ...context, runAttempt: 4 }, root);
    assert.equal(splitResult.artifacts.length, 3);
    assert.equal(splitResult.index.runAttempt, 3, 'retained originals stay bound to the producer');
    // One-sided producer replacement against the real receipt is still refused.
    write(path.join(root, 'request.original.json'), { ...splitRequest, producerAttempt: 4 });
    assert.throws(() => normal.verifyCustody(root, { ...context, runAttempt: 4 }, root),
      /producer coordinate\/selector mismatch/);
    // A live lane whose attempt is not the recorded consumer is refused.
    write(path.join(root, 'request.original.json'), splitRequest);
    process.env.GITHUB_RUN_ATTEMPT = '5';
    assert.throws(() => normal.verifyCustody(root, { ...context, runAttempt: 4 }, root));
    // Restore for the following assertions.
    write(path.join(root, 'request.original.json'), request);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.deepEqual(Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])), saved);

  for (const mutate of [v => v.sourceSha = 'f'.repeat(40), v => v.runAttempt++, v => v.phases[0].groupAbsent = false, v => v.phases[0].command = '/posix/bun', v => v.nodeRuntime.args = ['-e', 'unqualified'], v => v.members[0].sha256 = '0'.repeat(64), v => v.members.push(v.members[0]), v => v.members[0].member = '../outside']) {
    const changed = structuredClone(index); mutate(changed); write(indexFile, changed); assert.throws(() => normal.verify(originals, context, root));
  }
  write(indexFile, index); fs.unlinkSync(path.join(originals, 'cli/client.tgz')); assert.throws(() => normal.verify(originals, context, root));
}));
test('builder produces an internally consistent producer1/consumer2 fixture that the real verifier accepts', () => fixture(root => {
  // Builder usability check (NOT the final full chain): the same complete fixture,
  // now with producer attempt 1 and an explicit split request recording consumer 2.
  // All producer-side coordinates must come from the same options.
  const built = buildNormalSupplyFixture(root, { runAttempt: 1, consumerAttempt: 2 });
  assert.equal(built.index.runAttempt, 1);
  assert.equal(built.index.runId, String(built.context.runId));
  assert.equal(built.index.sourceSha, built.context.sourceSha);
  assert.equal(built.metadata.artifact.name,
    `legacy-root-normal-afs-${built.context.sourceSha}-${built.context.runId}-1`);
  assert.equal(built.jobs.jobs[0].run_attempt, 1);
  assert.equal(built.request.producerAttempt, 1);
  assert.equal(built.request.consumerAttempt, 2);
  assert.equal(built.request.input.runAttempt, 1, 'producer originals are untouched by the split');
  assert.equal(built.artifacts.length, 3);

  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod',
      GITHUB_RUN_ID: String(built.context.runId), GITHUB_RUN_ATTEMPT: '2' });
    // Real verifier, consumer context 2 vs producer originals 1.
    const verified = normal.verifyCustody(root, { ...built.context, runAttempt: 2 }, root);
    assert.equal(verified.artifacts.length, 3);
    assert.equal(verified.index.runAttempt, 1, 'retained originals stay on the producer coordinate');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}));
test('the produce step shell freezes attempt only after a successful producer', () => {
  // Scope-explicit stub: run the EXACT step body against a temp GITHUB_OUTPUT with a
  // stand-in producer command, proving the ordering and the positive-integer gate.
  const workflow = require('yaml').parse(fs.readFileSync(path.resolve('.github/workflows/legacy-root-compat.yml'), 'utf8'));
  const produce = workflow.jobs.normal_afs.steps.find(row => row.id === 'produce');
  const root = fs.mkdtempSync(path.join('.test-data/legacy-afs-supply', 'shell-'));
  try {
    const runBody = (attempt, producerExit) => {
      const out = path.join(root, 'out-' + attempt + '-' + producerExit);
      fs.writeFileSync(out, '');
      // Replace the real producer invocation with a stub that records it ran.
      const marker = path.join(root, 'producer-ran-' + attempt + '-' + producerExit);
      // A producer stub that records it ran; a non-zero exit simulates failure. It
      // must not `exit` on success, or the following step lines would be skipped.
      const body = produce.run
        .replace('bun scripts/legacy-root-afs-supply.ts produce "$RUNNER_TEMP/legacy-root-normal-afs" "$SOURCE_SHA"',
          `echo ran > ${JSON.stringify(marker)}; ${producerExit === 0 ? 'true' : `exit ${producerExit}`}`);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', body],
        {env: {...process.env, GITHUB_RUN_ATTEMPT: attempt, GITHUB_OUTPUT: out, RUNNER_TEMP: root, SOURCE_SHA: 'a'.repeat(40)},
          encoding: 'utf8'});
      return {status: result.status, output: fs.readFileSync(out, 'utf8'), ran: fs.existsSync(marker)};
    };

    // attempt 1: producer runs, and the frozen attempt is written afterwards.
    const ok = runBody('1', 0);
    assert.equal(ok.status, 0, 'valid attempt must succeed');
    assert.equal(ok.ran, true, 'the real producer command must still run');
    assert.equal(ok.output.trim(), 'attempt=1');

    // a non-canonical attempt is refused before the producer runs at all.
    for (const bad of ['0', '01', '2e0', 'abc', '']) {
      const rejected = runBody(bad, 0);
      assert.notEqual(rejected.status, 0, 'invalid attempt ' + JSON.stringify(bad) + ' must fail');
      assert.equal(rejected.ran, false, 'producer must not run for invalid attempt ' + JSON.stringify(bad));
      assert.equal(rejected.output.trim(), '', 'no attempt output may be written');
    }

    // a failing producer must not publish a success attempt.
    const failed = runBody('1', 3);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.output.trim(), '', 'failed producer must not write attempt');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

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
  // The producer attempt is frozen inside the EXISTING produce step (no extra step):
  // the job output must reference that step's output, and the step must both run the
  // real producer command and write the attempt only after it succeeded.
  assert.equal(produce.id, 'produce');
  assert.equal(workflow.jobs.normal_afs.outputs['artifact-attempt'], '${{ steps.produce.outputs.attempt }}');
  assert.equal(workflow.jobs.normal_afs.steps.some(row => row.id === 'producer_identity'), false);
  // Exactly the budget's eight steps: no extra step can exist without breaking the
  // strict NORMAL_SUPPLY_BUDGET assertion in the CLI projection test.
  const { NORMAL_SUPPLY_BUDGET: budget } = require('../../scripts/lib/legacy-afs-publication-budget.cjs');
  assert.equal(workflow.jobs.normal_afs.steps.length, Object.keys(budget.steps).length);
  assert.match(produce.run, /set -euo pipefail/);
  // A bare `[[ ]]` is not fatal under `set -e`, so the step must guard explicitly.
  assert.match(produce.run, /\[\[ "\$GITHUB_RUN_ATTEMPT" =~ \^\[1-9\]\[0-9\]\*\$ \]\] \|\| \{ echo [^}]+; exit 1; \}/);
  assert.ok(produce.run.indexOf('legacy-root-afs-supply.ts produce') < produce.run.indexOf('"$GITHUB_OUTPUT"'),
    'attempt is written only after the producer command');
  // attempt expression must never fall back to a re-evaluated github.run_attempt.
  assert.doesNotMatch(JSON.stringify(workflow.jobs.normal_afs.outputs), /github\.run_attempt/);
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
