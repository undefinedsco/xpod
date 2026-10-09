const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const read = name => yaml.load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows', name), 'utf8'));

test('RC requires real permission producer and source-bound artifact in the combined mandatory desktop gate', () => {
  const { jobs } = read('candidate.yml');
  assert.ok(jobs.accept_desktop_rc.needs.includes('deploy_and_accept'));
  const producer = jobs.accept_desktop_rc.steps.find(step => step.run?.includes('bun scripts/accept-packaged-desktop-permissions.ts'));
  assert.ok(producer);
  assert.match(producer.run, /chmod 600/);
  assert.match(producer.run, /--source-sha "\$\{\{ github\.sha \}\}"/);
  assert.match(producer.run, /--archive "\$new_zip"/);
  assert.equal(producer['continue-on-error'], undefined);
  const upload = jobs.accept_desktop_rc.steps.find(step => step.with?.name === 'desktop-permission-acceptance-${{ github.sha }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.path, '${{ runner.temp }}/desktop-permission-evidence.json');
  // A failed producer must still leave a redacted stage/error summary in the log
  // and as an artifact; the private directory itself is never uploaded.
  const failureSummary = jobs.accept_desktop_rc.steps.find(step => step.with?.name === 'desktop-permission-failure-${{ github.sha }}');
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
  const job = read('release.yml').jobs.accept_desktop_macos;
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
  for (const name of ['deploy_and_accept', 'build_desktop_rc', 'accept_desktop_rc', 'finalize_acceptance']) assert.ok(cleanup.needs.includes(name));
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
test('package builders run before service availability while every acceptance and finalizer waits', () => {
  const candidate = read('candidate.yml').jobs;
  assert.deepEqual(candidate.build_desktop_rc.needs, ['metadata', 'build_qlever_macos_runtime']);
  assert.equal(candidate.build_desktop_rc.environment, undefined);
  assert.equal(candidate.build_desktop_rc.env.XPOD_LIVE_PROVIDER_API_KEY_CONFIG, undefined);
  assert(candidate.accept_desktop_rc.needs.includes('deploy_and_accept'));
  assert(candidate.accept_desktop_rc.needs.includes('build_desktop_rc'));
  assert(candidate.finalize_acceptance.needs.includes('accept_desktop_rc'));
  assert(candidate.cleanup_rc.needs.includes('accept_desktop_rc'));
  const stable = read('release.yml').jobs;
  assert.deepEqual(stable.build_desktop_macos.needs, ['promotion_guard']);
  assert.equal(stable.build_desktop_macos.environment, undefined);
  assert.equal(stable.build_desktop_macos.env.XPOD_LIVE_PROVIDER_API_KEY_CONFIG, undefined);
  assert(stable.accept_desktop_macos.needs.includes('build_desktop_macos'));
  assert(stable.accept_desktop_macos.needs.includes('deploy_production_co'));
  assert(stable.create_github_release.needs.includes('accept_desktop_macos'));
  for (const name of ['shared_packages', 'publish_npm_staging']) assert(stable[name].needs.includes('release_preflight'));
  for (const [jobs, build, accept] of [[candidate, 'build_desktop_rc', 'accept_desktop_rc'], [stable, 'build_desktop_macos', 'accept_desktop_macos']]) {
    assert(jobs[build].outputs.manifest_digest);
    const verify = jobs[accept].steps.find(step => step.run?.includes('desktop-build-artifact.cjs verify'));
    assert(verify && verify.run.includes(`needs.${build}.outputs.manifest_digest`));
    assert(!jobs[accept].steps.some(step => step.run?.includes('bun run dist')));
    assert(!jobs[accept].if && !jobs[accept]['continue-on-error']);
  }
});
