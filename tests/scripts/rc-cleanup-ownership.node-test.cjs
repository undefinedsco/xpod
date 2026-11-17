const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownsRcDeployment, ownsRcPostgres } = require('../../scripts/rc-cleanup-ownership.cjs');
test('cleanup requires this run seed volume on the exact RC deployment and namespace', () => {
  const seed = 'xpod-rc-seed-123-1';
  const owned = { metadata: { name: 'xpod-rc', namespace: 'test-namespace' },
    spec: { template: { spec: { volumes: [{ name: 'acceptance-seed', secret: { secretName: seed } }] } } } };
  assert.equal(ownsRcDeployment(owned, 'test-namespace', seed), true);
  assert.equal(ownsRcDeployment(owned, 'test-namespace', 'xpod-rc-seed-124-1'), false);
  assert.equal(ownsRcDeployment(owned, 'another-namespace', seed), false);
  assert.equal(ownsRcDeployment({ ...owned, metadata: { ...owned.metadata, name: 'xpod-cloud' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcDeployment({ ...owned, spec: {} }, 'test-namespace', seed), false);
  assert.equal(ownsRcDeployment(null, 'test-namespace', seed), false);
});

test('partial deployment cleanup independently requires this run marker on the RC Postgres', () => {
  const seed = 'xpod-rc-seed-123-1';
  const owned = { metadata: { name: 'xpod-rc-postgres', namespace: 'test-namespace',
    annotations: { 'xpod.undefineds.co/rc-owner-seed': seed } } };
  assert.equal(ownsRcPostgres(owned, 'test-namespace', seed), true);
  assert.equal(ownsRcPostgres(owned, 'test-namespace', 'xpod-rc-seed-124-1'), false);
  assert.equal(ownsRcPostgres(owned, 'other-namespace', seed), false);
  assert.equal(ownsRcPostgres({ ...owned, metadata: { ...owned.metadata, name: 'production-postgres' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcPostgres({ metadata: { name: 'xpod-rc-postgres', namespace: 'test-namespace' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcPostgres(null, 'test-namespace', seed), false);
});

test('a re-run attempt owns the RC its own run deployed, never another run', () => {
  const { runSeedOfRcDeployment } = require('../../scripts/rc-cleanup-ownership.cjs');
  const deployment = { metadata: { name: 'xpod-rc', namespace: 'ns' },
    spec: { template: { spec: { volumes: [{ secret: { secretName: 'xpod-rc-seed-123-1' } }] } } } };
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '123'), 'xpod-rc-seed-123-1');
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '12'), undefined);
  assert.equal(runSeedOfRcDeployment(deployment, 'other', '123'), undefined);
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '1.*'), undefined);
});

test('only an RC whose retained marker names its own mounted seed counts as retained', () => {
  const { retainedRcSeed, RETAINED_ANNOTATION } = require('../../scripts/rc-cleanup-ownership.cjs');
  const deployment = seed => ({ metadata: { name: 'xpod-rc', namespace: 'ns', annotations: { [RETAINED_ANNOTATION]: 'xpod-rc-seed-123-1' } },
    spec: { template: { spec: { volumes: [{ secret: { secretName: seed } }] } } } });
  assert.equal(retainedRcSeed(deployment('xpod-rc-seed-123-1'), 'ns'), 'xpod-rc-seed-123-1');
  // A later candidate re-applied the RC: the stale marker no longer matches.
  assert.equal(retainedRcSeed(deployment('xpod-rc-seed-124-1'), 'ns'), undefined);
  assert.equal(retainedRcSeed({ ...deployment('xpod-rc-seed-123-1'), metadata: { name: 'xpod-rc', namespace: 'ns' } }, 'ns'), undefined);
  assert.equal(retainedRcSeed(null, 'ns'), undefined);
});

// ---------------------------------------------------------------------------
// Retention policy shape: read the ACTUAL workflow so the previous predicate
// (which keyed on deploy_and_accept.result) fails these assertions.
// ---------------------------------------------------------------------------
const { readFileSync } = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflow = () => yaml.load(readFileSync(
  path.resolve(__dirname, '../../.github/workflows/candidate.yml'), 'utf8'));
const cleanupJob = () => workflow().jobs.cleanup_rc;

/** Evaluate the job's real RETAIN expression against a set of job results. */
function retainFor(results) {
  const expression = cleanupJob().env.RETAIN_FOR_DIAGNOSIS;
  const match = /^\$\{\{(.*)\}\}$/u.exec(String(expression).trim());
  assert.ok(match, 'RETAIN_FOR_DIAGNOSIS must be a single GitHub expression');
  const body = match[1]
    .replace(/needs\.([a-z_]+)\.result/gu, (_all, name) => JSON.stringify(results[name]))
    .replace(/\s+/gu, ' ');
  // Only comparison/boolean operators remain, so a strict evaluator is enough.
  assert.match(body, /^[\s"'a-z!=|&()]+$/u, `unexpected expression shape: ${body}`);
  // eslint-disable-next-line no-new-func
  return Boolean(new Function(`return (${body});`)());
}

test('a late authenticated smoke failure retains the owned RC for diagnosis', () => {
  // Reproduces RC435 attempt 2: deploy_and_accept FAILED on the pod smoke while
  // both final acceptances were skipped. The old predicate (deploy success) gave
  // false here and the run destroyed its own RC.
  assert.equal(retainFor({
    deploy_and_accept: 'failure', accept_desktop_rc: 'skipped', finalize_acceptance: 'skipped',
  }), true);
});

test('cancelled or missing desktop acceptance retains the owned RC', () => {
  assert.equal(retainFor({ deploy_and_accept: 'success', accept_desktop_rc: 'cancelled', finalize_acceptance: 'success' }), true);
  assert.equal(retainFor({ deploy_and_accept: 'success', accept_desktop_rc: 'failure', finalize_acceptance: 'skipped' }), true);
  assert.equal(retainFor({ deploy_and_accept: 'success', finalize_acceptance: 'success' }), true);
});

test('only when BOTH final acceptances succeed does the run tear down its own RC', () => {
  assert.equal(retainFor({ deploy_and_accept: 'success', accept_desktop_rc: 'success', finalize_acceptance: 'success' }), false);
});

/**
 * Extract the REAL RC application teardown block from the workflow and execute it
 * against a stub kubectl. Nothing before the block (bootstrap job, credentials,
 * config preflight) is executed, and no cluster is contacted.
 */
function teardownBlock() {
  const marker = '# RC application teardown, gated by the deployment ownership status.';
  const runs = cleanupJob().steps.map(step => step.run || '');
  const hits = runs.filter(run => run.includes(marker));
  assert.equal(hits.length, 1, 'the teardown marker must appear exactly once');
  const lines = hits[0].split('\n');
  const from = lines.findIndex(line => line.includes(marker));
  // Consume the if/elif/else/fi block that follows the marker, by indentation.
  const indent = lines[from].match(/^ */u)[0].length;
  let to = from + 1;
  for (; to < lines.length; to += 1) {
    const line = lines[to];
    if (!line.trim()) continue;
    if (line.match(/^ */u)[0].length <= indent && /^\s*fi\s*$/u.test(line)) { to += 1; break; }
  }
  const block = lines.slice(from, to).map(line => line.replace(new RegExp(`^ {${indent}}`, 'u'), '')).join('\n');
  assert.match(block, /retained-for-diagnosis=/u);
  assert.match(block, /scale deployment\/xpod-rc --replicas=0/u);
  assert.match(block, /delete secret "\$XPOD_RC_SEED_SECRET_NAME"/u);
  return block;
}

const { mkdtempSync, writeFileSync, chmodSync, readFileSync: readSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

/** Run the real teardown block with a stub kubectl that records argv. */
function runTeardown({ ownershipStatus, retain }) {
  const root = mkdtempSync(path.join(__dirname, '../../.test-data/rc-cleanup-ownership-'));
  const bin = path.join(root, 'bin');
  const actions = path.join(root, 'actions.log');
  const summary = path.join(root, 'summary.md');
  try {
    require('node:fs').mkdirSync(bin, { recursive: true });
    // Stub: record argv, and answer the inngest existence check.
    const stub = [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(actions)}`,
      'case "$*" in',
      '  *"get deployment/xpod-rc-inngest"*) echo "deployment.apps/xpod-rc-inngest"; exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(path.join(bin, 'kubectl'), stub);
    chmodSync(path.join(bin, 'kubectl'), 0o755);
    writeFileSync(summary, '');

    const script = `set -u\n${teardownBlock()}\n`;
    const result = spawnSync('/bin/bash', ['-euc', script], {
      cwd: root,
      timeout: 5_000,
      encoding: 'utf8',
      // PATH is ONLY the stub dir. No inherited KUBECONFIG or secrets.
      env: {
        PATH: bin,
        SEALOS_NAMESPACE: 'test-namespace',
        XPOD_RC_SEED_SECRET_NAME: 'xpod-rc-seed-123-1',
        ownership_status: String(ownershipStatus),
        RETAIN_FOR_DIAGNOSIS: retain ? 'true' : 'false',
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    // A path that mutates nothing never creates the log.
    const recorded = require('node:fs').existsSync(actions)
      ? readSync(actions, 'utf8').split('\n').filter(Boolean) : [];
    const summaryText = readSync(summary, 'utf8');
    return { status: result.status, recorded, summaryText };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SCALE_RC = 'scale deployment/xpod-rc --replicas=0';
const SCALE_INNGEST = 'scale deployment/xpod-rc-inngest --replicas=0';
const DELETE_SEED = 'delete secret xpod-rc-seed-123-1 --ignore-not-found';
const annotateOf = recorded => recorded.filter(line => line.includes('retained-for-diagnosis='));

test('owned RC with a late acceptance failure annotates and never scales or deletes', () => {
  const { status, recorded, summaryText } = runTeardown({ ownershipStatus: 0, retain: true });
  assert.equal(status, 0);
  const annotate = annotateOf(recorded);
  assert.equal(annotate.length, 1, 'exactly one annotate of the owned RC');
  assert.match(annotate[0], /annotate deployment\/xpod-rc --overwrite/u);
  assert.match(annotate[0], /retained-for-diagnosis=xpod-rc-seed-123-1/u);
  // The whole point: retention must NOT be able to reach teardown.
  assert.equal(recorded.some(line => line.includes(SCALE_RC)), false);
  assert.equal(recorded.some(line => line.includes(SCALE_INNGEST)), false);
  assert.equal(recorded.some(line => line.includes('delete secret')), false);
  assert.match(summaryText, /RC retained for diagnosis/u);
  // Protected Postgres/PVC never touched on either path.
  assert.equal(recorded.some(line => /(statefulset|pvc|persistentvolumeclaim)/u.test(line)), false);
});

test('both final acceptances succeeding scales the owned RC to zero and deletes only its own seed', () => {
  const { status, recorded } = runTeardown({ ownershipStatus: 0, retain: false });
  assert.equal(status, 0);
  assert.equal(annotateOf(recorded).length, 0, 'a successful run must not annotate retention');
  assert.ok(recorded.some(line => line.includes(SCALE_RC)));
  assert.ok(recorded.some(line => line.includes(SCALE_INNGEST)));
  assert.ok(recorded.some(line => line.includes(DELETE_SEED)));
  // Only the run-scoped seed, and only once.
  assert.equal(recorded.filter(line => line.includes('delete secret')).length, 1);
  assert.equal(recorded.some(line => /(statefulset|pvc|persistentvolumeclaim)/u.test(line)), false);
});

test('a foreign or absent RC is never mutated, whatever the retain flag says', () => {
  for (const retain of [true, false]) {
    const { status, recorded } = runTeardown({ ownershipStatus: 2, retain });
    assert.equal(status, 0);
    assert.deepEqual(recorded, [], `status 2 must make zero kubectl calls (retain=${retain})`);
  }
});

test('an unreadable ownership status fails closed without mutating anything', () => {
  const { status, recorded } = runTeardown({ ownershipStatus: 1, retain: true });
  assert.equal(status, 1, 'the else branch must exit with the ownership status');
  assert.deepEqual(recorded, []);
});

test('bootstrap and protected Postgres boundaries are unchanged', () => {
  const run = cleanupJob().steps.map(step => step.run || '').join('\n');
  assert.ok(run.includes('rc-bootstrap-ownership.cjs delete-options'));
  assert.ok(run.includes('bootstrap_job'));
  // The RC-only Postgres/PVC are explicitly retained, never deleted here.
  assert.match(run, /intentionally NOT deleted/u);
  assert.ok(!/delete (statefulset|pvc|persistentvolumeclaim)/u.test(run));
});
