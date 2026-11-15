const assert = require('node:assert/strict');

const LEGACY_WORKFLOW = '.github/workflows/legacy-root-compat.yml';
const CANDIDATE_WORKFLOW = '.github/workflows/candidate.yml';
const PRODUCER_JOB = 'legacy-root-normal-afs';
const SCOPED_PRODUCER_JOB = 'legacy_root_compat / legacy-root-normal-afs';

// The normal producer's critical steps, by the names the workflow actually uses.
const PRODUCE_STEP = /^Produce original CLI, client and standalone AFS JS distributions$/;
const UPLOAD_STEP = 'Run actions/upload-artifact@v4';
const CLOSURE_STEP = 'Complete job';

// A step may legitimately be skipped (conditional post-steps), but the critical
// producer steps below must be exactly `success`.
const ACCEPTED_STEP_OUTCOMES = new Set(['success', 'skipped']);
const TERMINAL_FAILURE_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'stale',
]);
const NONTERMINAL_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

function producerJobName(input, run, workflow) {
  assert.equal(workflow.id, run.workflow_id); assert.equal(run.path?.split('@')[0], workflow.path);
  if (workflow.path === LEGACY_WORKFLOW) return PRODUCER_JOB;
  assert.equal(workflow.path, CANDIDATE_WORKFLOW);
  const references = run.referenced_workflows?.filter(row => row.path?.startsWith('undefinedsco/xpod/' + LEGACY_WORKFLOW + '@') && row.sha === input.sourceSha);
  assert.equal(references?.length, 1);
  return SCOPED_PRODUCER_JOB;
}

/**
 * Derive producer closure from the RETAINED original job record.
 *
 * Returns `{ source, completedAt }` where `source` is either
 *   'header' - the job header itself is completed/success (the original path,
 *              behaviour byte-for-byte unchanged), or
 *   'steps'  - the header is still in_progress/null while every recorded step is
 *              a complete, causally ordered, closed original.
 * Returns `null` while the producer is legitimately still running, and throws for
 * any state that can never become a valid closure.
 *
 * This never mutates the fetched job. Callers must keep using `source` to say
 * WHERE the closure came from; the API header is never rewritten to look
 * completed.
 */
function producerStepsClosure(job) {
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  // A still-running job always has at least one step without a terminal outcome.
  if (steps.some(step => !step || typeof step !== 'object' || step.status !== 'completed' || typeof step.conclusion !== 'string')) return null;
  let previous = 0;
  for (const step of steps) {
    assert.ok(Number.isSafeInteger(step.number) && step.number > 0, 'producer step number');
    assert.ok(step.number > previous, 'producer step order');
    previous = step.number;
    assert.ok(ACCEPTED_STEP_OUTCOMES.has(step.conclusion), 'producer step outcome');
  }
  const closures = steps.filter(step => step.name === CLOSURE_STEP);
  // Every recorded step is settled but the runner has not recorded `Complete job`
  // yet: the job is still legitimately in flight, NOT malformed.
  if (closures.length === 0) return null;
  assert.equal(closures.length, 1, 'producer closure step count');
  const closureIndex = steps.length - 1;
  assert.equal(steps[closureIndex].name, CLOSURE_STEP, 'producer closure step not final');
  assert.equal(steps[closureIndex].conclusion, 'success', 'producer closure step outcome');
  const produces = steps.map((step, index) => [step, index]).filter(([step]) => PRODUCE_STEP.test(step.name));
  assert.equal(produces.length, 1, 'producer critical step count');
  const uploads = steps.map((step, index) => [step, index]).filter(([step]) => step.name === UPLOAD_STEP);
  assert.equal(uploads.length, 1, 'producer upload step count');
  const [produceStep, produceIndex] = produces[0];
  const [uploadStep, uploadIndex] = uploads[0];
  assert.equal(produceStep.conclusion, 'success', 'producer critical step outcome');
  assert.equal(uploadStep.conclusion, 'success', 'producer upload step outcome');
  // Causal order is asserted on the RECORDED timestamps, not only on position.
  const produceEnd = Date.parse(produceStep.completed_at), uploadStart = Date.parse(uploadStep.started_at);
  const uploadEnd = Date.parse(uploadStep.completed_at);
  const closureStart = Date.parse(steps[closureIndex].started_at);
  assert.ok(Number.isFinite(produceEnd) && Number.isFinite(uploadStart) && Number.isFinite(uploadEnd) && Number.isFinite(closureStart), 'producer causal timestamps');
  assert.ok(produceEnd <= uploadStart, 'producer produce after upload');
  assert.ok(uploadEnd <= closureStart, 'producer upload after closure');
  assert.ok(produceIndex < uploadIndex, 'producer upload precedes production');
  assert.ok(uploadIndex < closureIndex, 'producer upload after closure');
  const started = Date.parse(job.started_at);
  assert.ok(Number.isFinite(started), 'producer start timestamp');
  const completedAt = steps[closureIndex].completed_at;
  const closed = Date.parse(completedAt);
  assert.ok(Number.isFinite(closed), 'producer closure timestamp');
  assert.ok(closed >= started, 'producer closure before start');
  for (const step of steps) {
    const from = Date.parse(step.started_at), to = Date.parse(step.completed_at);
    assert.ok(Number.isFinite(from) && Number.isFinite(to), 'producer step window');
    assert.ok(from >= started && to >= from && to <= closed, 'producer step window outside closure');
  }
  return { source: 'steps', completedAt };
}

function producerClosure(input, job) {
  assert.ok(job && typeof job === 'object' && !Array.isArray(job), 'producer job shape');
  assert.equal(job.run_id, input.runId, 'producer job run id');
  assert.equal(job.run_attempt, input.runAttempt, 'producer job attempt');
  assert.equal(job.head_sha, input.runHeadSha, 'producer job head');
  if (typeof job.conclusion === 'string') {
    // An explicit terminal failure is never rescued by successful steps.
    assert.ok(!TERMINAL_FAILURE_CONCLUSIONS.has(job.conclusion), 'producer terminal failure');
  }
  if (job.status === 'completed') {
    assert.equal(job.conclusion, 'success', 'producer header outcome');
    const completedAt = job.completed_at;
    assert.ok(Number.isFinite(Date.parse(completedAt)), 'producer header closure timestamp');
    return { source: 'header', completedAt };
  }
  assert.ok(NONTERMINAL_STATUSES.includes(job.status), 'producer header status');
  assert.equal(job.conclusion, null, 'producer header conclusion');
  // A timestamp may arrive before the terminal status. Keep the existing retry
  // path; this partial header cannot supply step-based closure evidence yet.
  if (job.completed_at !== null) return null;
  return producerStepsClosure(job);
}

// ONE selection/identity implementation. `verifyProducerJob` used to duplicate the
// selection and identity checks and could contradict the canonical verifier; it is
// replaced by this explicit header-only wrapper over the SAME implementation.
function verifyProducerJob(input, run, workflow, jobs) {
  const verified = requireProducerClosure(input, run, workflow, jobs);
  assert.ok(verified, 'terminal successful producer required');
  assert.equal(verified.closure.source, 'header', 'producer header closure required');
  return verified.job;
}

/** The single canonical closure verifier used by BOTH the acquirer and the
 * downstream custody check, so the two can never disagree about closure. */
/** Null-tolerant: returns `null` while the producer is legitimately still running
 * so the acquirer can keep polling inside its existing budget. Any malformed or
 * explicitly failed producer still throws. */
function verifyProducerClosure(input, run, workflow, jobs) {
  const jobName = producerJobName(input, run, workflow);
  assert.equal(jobs.total_count, jobs.jobs.length);
  const selected = jobs.jobs.filter(job => job.name === jobName); assert.equal(selected.length, 1);
  const job = selected[0];
  const closure = producerClosure(input, job);
  return closure ? { job, closure } : null;
}

/** Strict: custody requires an actual closure. */
function requireProducerClosure(input, run, workflow, jobs) {
  const verified = verifyProducerClosure(input, run, workflow, jobs);
  assert.ok(verified, 'producer closure required');
  return verified;
}

function verifyContext(input, metadata, jobs) {
  const { run, workflow, artifact } = metadata;
  const verified = requireProducerClosure(input, run, workflow, jobs);
  const job = verified.job, closure = verified.closure;
  assert.equal(run.repository?.full_name, 'undefinedsco/xpod'); assert.equal(run.head_repository?.full_name, 'undefinedsco/xpod');
  assert.equal(run.id, input.runId); assert.equal(run.run_attempt, input.runAttempt); assert.equal(run.head_sha, input.runHeadSha);
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(run.event)); assert.ok(['queued', 'in_progress', 'completed'].includes(run.status));
  assert.equal(artifact.id, input.artifactId); assert.equal(artifact.name, `legacy-root-normal-afs-${input.sourceSha}-${input.runId}-${input.runAttempt}`);
  assert.equal(artifact.expired, false); assert.equal(artifact.workflow_run?.id, input.runId); assert.equal(artifact.workflow_run?.head_sha, input.runHeadSha);
  assert.equal(artifact.digest, 'sha256:' + input.artifactSha256);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 16 * 1024 ** 2);
  const times = [job.started_at, artifact.created_at, closure.completedAt].map(Date.parse);
  assert.ok(times.every(Number.isFinite)); assert.ok(times[0] <= times[1] && times[1] <= times[2]);
  return { job, closure };
}

module.exports = { verifyContext, producerJobName, verifyProducerJob, producerClosure, verifyProducerClosure, requireProducerClosure };
