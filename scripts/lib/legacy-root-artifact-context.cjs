const assert = require('node:assert/strict');
function producerJobName(input, run, workflow) {
  const legacy = '.github/workflows/legacy-root-compat.yml';
  assert.equal(workflow.id, run.workflow_id); assert.equal(run.path?.split('@')[0], workflow.path);
  if (workflow.path === legacy) return 'legacy-root-normal-afs';
  assert.equal(workflow.path, '.github/workflows/candidate.yml');
  const references = run.referenced_workflows?.filter(row => row.path?.startsWith('undefinedsco/xpod/' + legacy + '@') && row.sha === input.sourceSha);
  assert.equal(references?.length, 1);
  return 'legacy_root_compat / legacy-root-normal-afs';
}
function verifyProducerJob(input, run, workflow, jobs) {
  const jobName = producerJobName(input, run, workflow);
  assert.equal(jobs.total_count, jobs.jobs.length);
  const selected = jobs.jobs.filter(job => job.name === jobName); assert.equal(selected.length, 1);
  const job = selected[0];
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); assert.equal(job.run_id, input.runId); assert.equal(job.run_attempt, input.runAttempt); assert.equal(job.head_sha, input.runHeadSha);
  return job;
}
function verifyContext(input, metadata, jobs) {
  const { run, workflow, artifact } = metadata;
  const job = verifyProducerJob(input, run, workflow, jobs);
  assert.equal(run.repository?.full_name, 'undefinedsco/xpod'); assert.equal(run.head_repository?.full_name, 'undefinedsco/xpod');
  assert.equal(run.id, input.runId); assert.equal(run.run_attempt, input.runAttempt); assert.equal(run.head_sha, input.runHeadSha);
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(run.event)); assert.ok(['queued', 'in_progress', 'completed'].includes(run.status));
  assert.equal(artifact.id, input.artifactId); assert.equal(artifact.name, `legacy-root-normal-afs-${input.sourceSha}-${input.runId}-${input.runAttempt}`);
  assert.equal(artifact.expired, false); assert.equal(artifact.workflow_run?.id, input.runId); assert.equal(artifact.workflow_run?.head_sha, input.runHeadSha);
  assert.equal(artifact.digest, 'sha256:' + input.artifactSha256);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 16 * 1024 ** 2);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse); assert.ok(times.every(Number.isFinite)); assert.ok(times[0] <= times[1] && times[1] <= times[2]);
}
module.exports = { verifyContext, producerJobName, verifyProducerJob };
