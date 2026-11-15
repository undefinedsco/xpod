const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDesktopRelease, PRODUCTION_DEPLOY_JOB } = require('../../scripts/desktop-release-guard.cjs');

const sha = 'a'.repeat(40);
const valid = () => ({
  tag: 'v0.4.31', sha, tagSha: sha, candidateRunId: '42',
  run: { id: 42, path: '.github/workflows/candidate.yml', head_branch: 'staging', head_sha: sha, status: 'completed', conclusion: 'failure' },
  manifest: { targetVersion: '0.4.31', sourceSha: sha, imageDigest: `sha256:${'b'.repeat(64)}`, candidateVersion: '0.4.31-rc.430' },
  desktopCheck: { desktop: 'passed' },
  releaseJobs: [{ name: PRODUCTION_DEPLOY_JOB, conclusion: 'success' }],
});

test('the desktop releases for an accepted candidate even when the candidate run concluded failure elsewhere', () => {
  assert.deepEqual(validateDesktopRelease(valid()), { tag: 'v0.4.31', version: '0.4.31',
    image_digest: `sha256:${'b'.repeat(64)}`, candidate_version: '0.4.31-rc.430', candidate_run_id: '42' });
});

test('the desktop never releases without its own acceptance, ahead of production, or for another commit', () => {
  const cases = [
    input => { input.desktopCheck = { desktop: 'failed' }; },
    input => { input.releaseJobs = [{ name: PRODUCTION_DEPLOY_JOB, conclusion: 'failure' }]; },
    input => { input.releaseJobs = []; },
    input => { input.tagSha = 'c'.repeat(40); },
    input => { input.run.head_sha = 'c'.repeat(40); },
    input => { input.run.head_branch = 'main'; },
    input => { input.run.status = 'in_progress'; },
    input => { input.run.path = '.github/workflows/ci.yml'; },
    input => { input.manifest.targetVersion = '0.4.30'; },
    input => { input.tag = 'v0.4.31-rc.1'; },
    input => { input.candidateRunId = '43'; },
  ];
  for (const mutate of cases) {
    const input = valid();
    mutate(input);
    assert.throws(() => validateDesktopRelease(input));
  }
});
