const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const {
  validateDesktopRelease, PRODUCTION_DEPLOY_JOB, PRODUCTION_DEPLOY_REUSABLE_JOB,
} = require('../../scripts/desktop-release-guard.cjs');

const sha = 'a'.repeat(40);
const valid = () => ({
  tag: 'v0.4.31', sha, tagSha: sha, candidateRunId: '42',
  run: { id: 42, path: '.github/workflows/candidate.yml', head_branch: 'staging', head_sha: sha, status: 'completed', conclusion: 'failure' },
  manifest: { targetVersion: '0.4.31', sourceSha: sha, imageDigest: `sha256:${'b'.repeat(64)}`, candidateVersion: '0.4.31-rc.430' },
  desktopCheck: { desktop: 'passed' },
  releaseJobs: [{ name: PRODUCTION_DEPLOY_JOB, conclusion: 'success' }],
});

test('the desktop releases for an accepted candidate even when the candidate run concluded failure elsewhere', () => {
  assert.deepEqual(validateDesktopRelease(valid()), { tag: 'v0.4.31', version: '0.4.31', source_sha: sha,
    image_digest: `sha256:${'b'.repeat(64)}`, candidate_version: '0.4.31-rc.430', candidate_run_id: '42' });
});

test('accepts the actual reusable .co job name GitHub lists for release.yml', () => {
  // release.yml names the caller `Deploy production .co`; the reusable job is
  // listed as the hierarchical `Deploy production .co / Deploy to .co`.
  assert.equal(PRODUCTION_DEPLOY_REUSABLE_JOB, 'Deploy production .co / Deploy to .co');
  const input = valid();
  input.releaseJobs = [ { name: PRODUCTION_DEPLOY_REUSABLE_JOB, conclusion: 'success' } ];
  assert.equal(validateDesktopRelease(input).version, '0.4.31');
});

test('the accepted reusable name matches the release caller and deploy job definitions', () => {
  const root = path.resolve(__dirname, '../..');
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(release, /^  deploy_production_co:\n    name: Deploy production \.co$/m);
  assert.match(deploy, /^  deploy-co:\n    name: Deploy to \.co$/m);
  assert.equal(
    `${PRODUCTION_DEPLOY_JOB} / Deploy to .co`,
    PRODUCTION_DEPLOY_REUSABLE_JOB,
  );
});

test('rejects .cn, unrelated, failed, and fuzzy supersets of the production deploy job', () => {
  const rejected = [
    'Deploy production .cn',
    'Deploy production .cn / Deploy to .cn',
    'Deploy production .co / Deploy to .cn',
    'Deploy production .co / Deploy to .co / extra',
    'Deploy production .co / Deploy to .co2',
    'xDeploy production .co',
    'Deploy production .co / Deploy to .cn / Deploy to .co',
    'Release',
  ];
  for (const name of rejected) {
    const input = valid();
    input.releaseJobs = [ { name, conclusion: 'success' } ];
    assert.throws(() => validateDesktopRelease(input), /not deployed to production/);
  }
  for (const name of [ PRODUCTION_DEPLOY_JOB, PRODUCTION_DEPLOY_REUSABLE_JOB ]) {
    const input = valid();
    input.releaseJobs = [ { name, conclusion: 'failure' } ];
    assert.throws(() => validateDesktopRelease(input), /not deployed to production/);
  }
});

function desktopWorkflow() {
  return parse(fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/release-desktop.yml'), 'utf8',
  ));
}

test('the workflow runner commit may differ from the product tag, but the guard receives the tag commit', () => {
  const runnerSha = 'c'.repeat(40);
  // The workflow ref is only the CI entry point: a runner commit S != tag M is
  // legitimate as long as the guard is handed M and every source binding is M.
  const release = desktopWorkflow();
  const guardRun = release.jobs.desktop_guard.steps.find(
    step => step.id === 'guard',
  ).run;
  assert.match(guardRun, /refs\/tags\/\$\{TAG_NAME\}\^\{commit\}/);
  assert.match(guardRun, /--sha "\$SOURCE_SHA"/);
  assert.equal(guardRun.includes('--sha "$GITHUB_SHA"'), false);
  assert.equal(release.jobs.desktop_guard.outputs.source_sha,
    '${{ steps.guard.outputs.source_sha }}');

  // If a runner SHA S is handed to the guard instead of M, the existing
  // tag/source/acceptance checks reject it.
  const forged = valid();
  forged.sha = runnerSha;
  assert.throws(() => validateDesktopRelease(forged), /tag commit does not match/);
});

test('every build, artifact, and native source binding uses the verified tag commit', () => {
  const release = desktopWorkflow();
  const build = release.jobs.build_desktop_macos;
  const checkout = build.steps.find(step => step.uses === 'actions/checkout@v4');
  assert.deepEqual(checkout.with, {
    ref: '${{ needs.desktop_guard.outputs.source_sha }}', 'fetch-depth': 0,
  });
  assert.equal(build.env.XPOD_ACCEPTED_SHA, '${{ needs.desktop_guard.outputs.source_sha }}');
  const retain = build.steps.find(step => step.run?.includes('retain-qlever-materials.py'));
  assert.equal(retain.env.QLEVER_SOURCE_SHA, '${{ needs.desktop_guard.outputs.source_sha }}');
  assert.equal(retain.env.QLEVER_ARTIFACT_SOURCE_RUN_ID, '${{ needs.desktop_guard.outputs.candidate_run_id }}');

  const uploads = build.steps.filter(step => step.uses === 'actions/upload-artifact@v4');
  assert.ok(uploads.length >= 3);
  for (const upload of uploads) {
    assert.equal(String(upload.with.name).includes('${{ github.sha }}'), false);
  }
  assert.ok(build.steps.some(step => step.with?.name
    === 'desktop-stable-acceptance-${{ needs.desktop_guard.outputs.source_sha }}'));
  assert.ok(build.steps.some(step => step.with?.name
    === 'xpod-desktop-macos-${{ needs.desktop_guard.outputs.version }}'));

  // Product checkout is ALWAYS the accepted tag commit. A repair tooling
  // checkout is allowed, but it must be a SEPARATE, explicitly named and gated
  // step writing to .ci-repair - never a product fallback.
  const tooling = build.steps.filter(step => JSON.stringify(step).includes('github.sha'));
  assert.equal(tooling.length, 1, 'exactly one runner-ref checkout is allowed');
  const repair = tooling[0];
  assert.equal(repair.uses, 'actions/checkout@v4');
  assert.deepEqual(repair.with, { ref: '${{ github.sha }}', path: '.ci-repair' });
  assert.equal(repair.if, "env.REUSE_MEDIA == 'true'", 'tooling checkout is reuse-only');

  // The primary product checkout stays the tag commit and is not the tooling one.
  const product = build.steps.filter(step => step.uses === 'actions/checkout@v4');
  assert.equal(product.length, 2, 'product checkout plus the gated tooling checkout');
  assert.deepEqual(product[0].with, {
    ref: '${{ needs.desktop_guard.outputs.source_sha }}', 'fetch-depth': 0,
  });
  assert.equal(product[0].if, undefined, 'product checkout must run on both paths');

  // No OTHER runner-ref use anywhere: media, acceptance and upload bindings all
  // stay on the verified tag commit or the verified version input.
  const runnerShaOccurrences = JSON.stringify(release).match(/github\.sha/g) || [];
  assert.equal(runnerShaOccurrences.length, 1, 'runner SHA appears only in the tooling checkout');
  for (const step of build.steps) {
    if (step === repair) continue;
    assert.equal(JSON.stringify(step).includes('github.sha'), false,
      'runner SHA must not leak into ' + (step.name ?? step.uses));
  }
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
