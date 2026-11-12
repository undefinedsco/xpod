const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const read = name => yaml.load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows', name), 'utf8'));

test('RC requires real permission producer and source-bound artifact in the combined mandatory desktop gate', () => {
  const { jobs } = read('candidate.yml');
  assert.ok(jobs.build_desktop_rc.needs.includes('deploy_and_accept'));
  const producer = jobs.build_desktop_rc.steps.find(step => step.run?.includes('bun scripts/accept-packaged-desktop-permissions.ts'));
  assert.ok(producer);
  assert.doesNotMatch(producer.run, /--key-file|XPOD_LIVE_PROVIDER_API_KEY_CONFIG/);
  assert.match(producer.run, /--source-sha "\$\{\{ github\.sha \}\}"/);
  assert.match(producer.run, /--archive "\$new_zip"/);
  assert.equal(producer['continue-on-error'], undefined);
  const upload = jobs.build_desktop_rc.steps.find(step => step.with?.name === 'desktop-permission-acceptance-${{ github.sha }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.path, '${{ runner.temp }}/desktop-permission-evidence.json');
  // A failed producer must still leave a redacted stage/error summary in the log
  // and as an artifact; the private directory itself is never uploaded.
  const failureSummary = jobs.build_desktop_rc.steps.find(step => step.with?.name === 'desktop-permission-failure-${{ github.sha }}');
  assert.ok(failureSummary);
  assert.equal(failureSummary.if, 'failure()');
  assert.equal(failureSummary.with['if-no-files-found'], 'ignore');
  assert.equal(failureSummary.with.path, '${{ runner.temp }}/desktop-permission-private/failure-safe.json');
  assert.ok(!failureSummary.with.path.endsWith('failure-private.json'));
  const final = jobs.finalize_acceptance.steps;
  assert.ok(final.some(step => step.with?.name === 'desktop-permission-acceptance-${{ github.sha }}'));
  const combined = final.find(step => step.run?.includes('node scripts/desktop-acceptance.cjs'));
  assert.ok(combined);
  for (const flag of ['--self-update-evidence', '--permission-evidence', '--expected-archive', '--checks-out']) assert.ok(combined.run.includes(flag));
  assert.ok(!final.some(step => step.run?.includes('scripts/desktop-self-update-acceptance.cjs verify')));
});

test('stable repeats both actual operations and self-update for its newly built exact archive', () => {
  const job = read('release.yml').jobs.build_desktop_macos;
  assert.ok(job.steps.some(step => step.run?.includes('bun scripts/accept-packaged-desktop-permissions.ts')));
  assert.ok(job.steps.some(step => step.run?.includes('node desktop/scripts/packaged-update-acceptance.mjs')));
  const combined = job.steps.find(step => step.run?.includes('node scripts/desktop-acceptance.cjs'));
  assert.ok(combined);
  assert.match(combined.run, /--version "\$RELEASE_VERSION"/);
  assert.match(combined.run, /--source-sha "\$XPOD_ACCEPTED_SHA"/);
  assert.match(combined.run, /--expected-archive "\$new_zip"/);
  const evidence = job.steps.find(step => step.with?.name === 'desktop-stable-acceptance-${{ github.sha }}');
  assert.equal(evidence.with['if-no-files-found'], 'error');
  assert.ok(!evidence.with.path.includes('private'));
  const stableFailure = job.steps.find(step => step.with?.name === 'desktop-permission-failure-${{ github.sha }}');
  assert.ok(stableFailure);
  assert.equal(stableFailure.if, 'failure()');
  assert.equal(stableFailure.with.path, '${{ runner.temp }}/desktop-permission-private/failure-safe.json');
});

test('RC scale-down waits for desktop and final acceptance even when upstream jobs fail', () => {
  const { jobs } = read('candidate.yml');
  assert.ok(!jobs.deploy_and_accept.steps.some(step => step.name === 'Scale RC deployments to zero'));
  const cleanup = jobs.cleanup_rc;
  assert.equal(cleanup.if, '${{ always() }}');
  for (const name of ['deploy_and_accept', 'build_desktop_rc', 'finalize_acceptance']) assert.ok(cleanup.needs.includes(name));
  assert.equal(cleanup.concurrency.group, jobs.deploy_and_accept.concurrency.group);
  const scale = cleanup.steps.find(step => step.name === 'Scale RC deployments to zero');
  assert.ok(scale);
  assert.equal(scale.if, undefined);
  assert.match(scale.run, /rc-cleanup-ownership\.cjs/);
  assert.doesNotMatch(scale.run, /statefulset\//);
  assert.match(scale.run, /scale deployment\/xpod-rc-inngest --replicas=0/);
  assert.match(scale.run, /delete secret "\$XPOD_RC_SEED_SECRET_NAME" --ignore-not-found/);
  assert.match(scale.run, /scale deployment\/xpod-rc --replicas=0/);
  assert.match(scale.run, /node scripts\/check-rc-deployment-boundary\.cjs/);
  assert.match(scale.run, /if \[ "\$ownership_status" -eq 0 \]; then/);
  assert.ok(scale.run.indexOf('if [ "$ownership_status" -eq 0 ]; then')
    < scale.run.indexOf('scale deployment/xpod-rc --replicas=0'));
  assert.doesNotMatch(scale.run, /deployment\/xpod-cloud|namespace\/|delete deployment|delete statefulset|rollout/);
});

test('staging candidates retain a fixed workflow RC lock through desktop and cleanup', () => {
  const workflow = read('candidate.yml');
  assert.deepEqual(workflow.on.push.branches, ['staging']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.notEqual(workflow.concurrency.group, workflow.jobs.deploy_and_accept.concurrency.group);
  assert.notEqual(workflow.concurrency.group, workflow.jobs.cleanup_rc.concurrency.group);
  assert.equal(workflow.concurrency.group, 'xpod-rc-candidate');
});

test('PR CI runs all Node release and tooling suites before the unit suite', () => {
  const steps = read('ci.yml').jobs.test.steps;
  const nodeTests = steps.findIndex(step => step.run === 'node --test tests/scripts/*.node-test.cjs tests/scripts/*.node-test.mjs');
  const unitTests = steps.findIndex(step => step.run === 'bun run test:run');
  assert.ok(nodeTests >= 0);
  assert.ok(unitTests > nodeTests);
});

// ---- RC410 final wiring: clean-source API preparation + artifact custody ----
const stepIndex = (steps, predicate) => steps.findIndex(predicate);

test('candidate produces the API capability ONCE on clean source BEFORE the version stamp', () => {
  const { jobs } = read('candidate.yml');
  const steps = jobs.build_desktop_rc.steps;
  const api = stepIndex(steps, s => s.run?.includes('prepareApiCapability'));
  const stamp = stepIndex(steps, s => s.run?.includes('--apply-root-version'));
  const packages = stepIndex(steps, s => s.run?.includes('bun run build:packages'));
  assert.ok(api >= 0, 'API capability production step must exist');
  assert.ok(stamp >= 0, 'version stamp step must exist');
  assert.ok(packages >= 0, 'workspace packages step must exist');
  // Order: packages -> API production -> version stamp. The producer refuses a
  // dirty tree, so preparing after any rewrite is invalid by construction.
  assert.ok(packages < api, 'API production must follow workspace package build');
  assert.ok(api < stamp, 'API production must precede the version stamp');
  // Exactly one canonical pipeline: no duplicated producer invocation.
  assert.equal(steps.filter(s => s.run?.includes('prepareApiCapability')).length, 1);
  // Read-only official native input acquisition, never echoed.
  assert.equal(steps[api].env?.GH_TOKEN, '${{ github.token }}');
  assert.doesNotMatch(steps[api].run, /echo\s+.*GH_TOKEN|set\s+-x/);
});

test('diagnostic produces the API capability ONCE on clean source BEFORE its version stamp', () => {
  const { jobs } = read('ci.yml');
  const steps = jobs['desktop-launch-diagnostic'].steps;
  const api = stepIndex(steps, s => s.run?.includes('prepareApiCapability'));
  const stamp = stepIndex(steps, s => s.run?.includes('applyRootVersion'));
  const packages = stepIndex(steps, s => s.run?.includes('bun run build:packages'));
  assert.ok(api >= 0 && stamp >= 0 && packages >= 0);
  assert.ok(packages < api, 'API production must follow workspace package build');
  assert.ok(api < stamp, 'API production must precede the diagnostic version stamp');
  assert.equal(steps.filter(s => s.run?.includes('prepareApiCapability')).length, 1);
  // The pinned QLever identity stays immutable and no rc env/secret is added.
  assert.equal(jobs['desktop-launch-diagnostic'].env.DIAGNOSTIC_ARTIFACT_ID, '13912079864');
  assert.match(jobs['desktop-launch-diagnostic'].env.DIAGNOSTIC_ARTIFACT_SHA256, /^92710334875497ba/);
  assert.equal(jobs['desktop-launch-diagnostic'].env.ORIGINAL_SOURCE_SHA, '021c809886629624934826f4aacf87ff59326932');
  assert.equal(jobs['desktop-launch-diagnostic'].environment, undefined);
});

test('RC desktop job has artifact-read permission and calls the shared retainer', () => {
  const job = read('candidate.yml').jobs.build_desktop_rc;
  // contents-only yields HTTP 403 from the artifact API.
  assert.equal(job.permissions.actions, 'read');
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.environment, 'rc', 'rc environment must be preserved');
  const retain = job.steps.find(s => s.run?.includes('retain-qlever-materials.py'));
  assert.ok(retain, 'shared retainer must be used');
  assert.equal(retain.env.QLEVER_ARTIFACT_ID, '${{ needs.build_qlever_macos_runtime.outputs.artifact_id }}');
  assert.equal(retain.env.QLEVER_ARTIFACT_DIGEST, '${{ needs.build_qlever_macos_runtime.outputs.artifact_digest }}');
  assert.equal(retain.env.QLEVER_SOURCE_SHA, '${{ needs.build_qlever_macos_runtime.outputs.source_sha }}');
  // No ad-hoc re-download/re-tar path beside the shared contract.
  assert.ok(!job.steps.some(s => s.run?.includes('gh run download')));
});

test('stable job consumes the ACCEPTED candidate run through the shared retainer', () => {
  const job = read('release.yml').jobs.build_desktop_macos;
  assert.equal(job.permissions.actions, 'read');
  const retain = job.steps.find(s => s.run?.includes('retain-qlever-materials.py'));
  assert.ok(retain, 'stable must use the shared retainer, not an ad-hoc download');
  assert.equal(retain.env.QLEVER_ARTIFACT_SOURCE_RUN_ID, '${{ needs.promotion_guard.outputs.candidate_run_id }}');
  assert.equal(retain.env.QLEVER_SOURCE_SHA, '${{ github.sha }}');
  // No artifact-id/digest inputs for the stable path: the accepted run + accepted
  // source define the identity breadth, and the helper selects the single match.
  assert.equal(retain.env.QLEVER_ARTIFACT_ID, undefined);
  assert.equal(retain.env.QLEVER_ARTIFACT_DIGEST, undefined);
  // No ad-hoc QLever download, no latest-run discovery, no native rebuild.
  // (Other artifacts — e.g. the self-update acceptance evidence — legitimately
  // keep their own `gh run download` and are out of this scope.)
  assert.ok(!job.steps.some(s => (s.run ?? '').includes('qlever-local-runtime-darwin-arm64')),
    'stable must not hand-roll the QLever artifact name');
  assert.ok(!job.steps.some(s => /gh run list|--latest/i.test(s.run ?? '')));
  // Same workspace-package prerequisite as the RC desktop job, before the build.
  const packages = stepIndex(job.steps, s => s.run?.includes('bun run build:packages'));
  const build = stepIndex(job.steps, s => s.run?.includes('bun run dist'));
  assert.ok(packages >= 0 && build >= 0);
  assert.ok(packages < build, 'workspace packages must be built before the desktop build');
});
