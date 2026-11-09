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
/** Preserve a successful matrix attempt across partial reruns; reject superseded failures. */
function validateModeArtifactAuthority(selection, artifact, pages, expected) {
  validateModeSelection(selection, expected);
  need(artifact?.id === selection.artifactId && artifact.name === selection.artifactName && artifact.digest === selection.artifactDigest && artifact.expired === false, 'Matrix artifact metadata mismatch');
  need(artifact.workflow_run?.id === Number(expected.runId) && artifact.workflow_run.head_sha === expected.sourceSha, 'Matrix artifact run/source mismatch');
  need(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 20 * 1024 * 1024, 'Matrix artifact archive budget exceeded');
  const pageList = Array.isArray(pages) ? pages : [pages];
  need(pageList.length > 0 && pageList.every(page => Array.isArray(page.jobs)), 'Matrix job observations missing');
  const jobs = pageList.flatMap(page => page.jobs).filter(job => job.name === MATRIX_JOB_NAME);
  need(jobs.length > 0 && jobs.every(job => String(job.run_id) === expected.runId && Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 && job.head_sha === expected.sourceSha), 'Matrix observed job identity mismatch');
  const attempt = Math.max(...jobs.map(job => job.run_attempt));
  const latest = jobs.filter(job => job.run_attempt === attempt);
  need(latest.length === 1 && String(attempt) === expected.runAttempt && latest[0].status === 'completed' && latest[0].conclusion === 'success' && Number.isSafeInteger(latest[0].id), 'Matrix latest actual job did not succeed');
  return { jobId: latest[0].id, actualMatrixAttempt: String(attempt), artifactId: selection.artifactId, artifactDigest: selection.artifactDigest };
}
module.exports = { MATRIX_JOB_NAME, artifactName, validateModeSelection, validateModeArtifactAuthority };
