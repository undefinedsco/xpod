const MATRIX_JOB_NAME = 'Same image three-mode live and session acceptance';
function artifactName(sourceSha, runId, attempt) { return `service-image-modes-${sourceSha}-${runId}-${attempt}`; }
function need(value, message) { if (!value) throw new Error(message); }
function validateModeSelection(selection, expected) {
  need(selection?.schemaVersion === 1, 'Matrix artifact selection missing');
  for (const key of ['sourceSha','image','platform','runId']) need(selection[key] === expected[key], 'Matrix artifact selection mismatch');
  need(/^[1-9][0-9]*$/.test(selection.runId) && /^[1-9][0-9]*$/.test(selection.runAttempt), 'Matrix actual run/attempt missing');
  need(Number.isSafeInteger(selection.artifactId) && selection.artifactId > 0 && /^sha256:[a-f0-9]{64}$/.test(selection.artifactDigest), 'Matrix artifact identity missing');
  need(selection.artifactName === artifactName(selection.sourceSha, selection.runId, selection.runAttempt), 'Matrix artifact name mismatch');
  if (expected.runAttempt !== undefined) need(selection.runAttempt === expected.runAttempt, 'Matrix artifact attempt mismatch');
  return selection;
}
/** The execution facts GitHub retains for a job row. A later partial rerun keeps
 * this exact projection for a job it did not execute, while a real rerun changes
 * the job/step timestamps. Returns null for any incomplete or malformed row. */
function actualExecutionFacts(job) {
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!job || typeof job !== 'object' || typeof job.name !== 'string' || !job.name
    || !timestamp(job.started_at) || !timestamp(job.completed_at)
    || Date.parse(job.completed_at) < Date.parse(job.started_at)
    || !Array.isArray(job.steps) || job.steps.length === 0) return null;
  const steps = [];
  let previous = 0;
  for (const step of job.steps) {
    if (!step || typeof step !== 'object' || typeof step.name !== 'string' || !step.name
      || !Number.isSafeInteger(step.number) || step.number <= previous
      || typeof step.status !== 'string' || typeof step.conclusion !== 'string'
      || !timestamp(step.started_at) || !timestamp(step.completed_at)
      || Date.parse(step.completed_at) < Date.parse(step.started_at)) return null;
    previous = step.number;
    steps.push([step.number, step.name, step.status, step.conclusion, step.started_at, step.completed_at]);
  }
  return { runId: String(job.run_id), headSha: job.head_sha, name: job.name, status: job.status,
    conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at, steps };
}
function sameExecution(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
/** Preserve a successful matrix attempt across partial reruns; reject superseded failures.
 *
 * The selection and artifact encode the attempt that ACTUALLY executed the
 * matrix. GitHub retains the same job row under each later run attempt without
 * executing it again; those retained clones keep the producer's job window and
 * every step fact unchanged. Later rows are therefore only admissible when they
 * prove that exact retained execution. Any later real execution (new success,
 * failure, cancellation, pending row) or any incomplete/ambiguous row rejects
 * the older proof instead of silently selecting it. */
function validateModeArtifactAuthority(selection, artifact, pages, expected) {
  validateModeSelection(selection, expected);
  need(artifact?.id === selection.artifactId && artifact.name === selection.artifactName && artifact.digest === selection.artifactDigest && artifact.expired === false, 'Matrix artifact metadata mismatch');
  need(artifact.workflow_run?.id === Number(expected.runId) && artifact.workflow_run.head_sha === expected.sourceSha, 'Matrix artifact run/source mismatch');
  need(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 20 * 1024 * 1024, 'Matrix artifact archive budget exceeded');
  const pageList = Array.isArray(pages) ? pages : [pages];
  need(pageList.length > 0 && pageList.every(page => Array.isArray(page.jobs)), 'Matrix job observations missing');
  const jobs = pageList.flatMap(page => page.jobs).filter(job => job.name === MATRIX_JOB_NAME);
  need(jobs.length > 0 && jobs.every(job => String(job.run_id) === expected.runId && Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 && job.head_sha === expected.sourceSha), 'Matrix observed job identity mismatch');
  const byAttempt = new Map();
  const jobIds = new Set();
  for (const job of jobs) {
    need(!byAttempt.has(job.run_attempt) && !jobIds.has(job.id), 'Matrix observed job lineage is ambiguous');
    byAttempt.set(job.run_attempt, job);
    jobIds.add(job.id);
  }
  const producerAttempt = Number(expected.runAttempt);
  need(Number.isSafeInteger(producerAttempt) && producerAttempt > 0 && String(producerAttempt) === expected.runAttempt, 'Matrix actual attempt missing');
  const producer = byAttempt.get(producerAttempt);
  need(producer && producer.status === 'completed' && producer.conclusion === 'success' && Number.isSafeInteger(producer.id), 'Matrix actual producer did not succeed');
  const laterAttempts = [...byAttempt.keys()].filter(attempt => attempt > producerAttempt).sort((left, right) => left - right);
  if (laterAttempts.length > 0) {
    const producerFacts = actualExecutionFacts(producer);
    need(producerFacts, 'Matrix producer execution facts missing');
    for (const attempt of laterAttempts) {
      const later = byAttempt.get(attempt);
      need(later.status === 'completed' && later.conclusion === 'success' && Number.isSafeInteger(later.id), 'Matrix later actual job did not succeed');
      const laterFacts = actualExecutionFacts(later);
      need(laterFacts && sameExecution(producerFacts, laterFacts), 'Matrix later actual job is not a retained clone');
    }
  }
  return { jobId: producer.id, actualMatrixAttempt: String(producerAttempt), artifactId: selection.artifactId, artifactDigest: selection.artifactDigest };
}
module.exports = { MATRIX_JOB_NAME, artifactName, validateModeSelection, validateModeArtifactAuthority };
