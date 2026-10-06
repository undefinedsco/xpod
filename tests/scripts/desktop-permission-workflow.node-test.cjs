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
  assert.match(producer.run, /chmod 600/);
  assert.match(producer.run, /--source-sha "\$\{\{ github\.sha \}\}"/);
  assert.match(producer.run, /--archive "\$new_zip"/);
  assert.equal(producer['continue-on-error'], undefined);
  const upload = jobs.build_desktop_rc.steps.find(step => step.with?.name === 'desktop-permission-acceptance-${{ github.sha }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.path, '${{ runner.temp }}/desktop-permission-evidence.json');
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
});

test('RC scale-down waits for desktop and final acceptance even when upstream jobs fail', () => {
  const { jobs } = read('candidate.yml');
  assert.ok(!jobs.deploy_and_accept.steps.some(step => step.name === 'Scale RC deployments to zero'));
  const cleanup = jobs.cleanup_rc;
  assert.equal(cleanup.if, '${{ always() }}');
  for (const name of ['deploy_and_accept', 'build_desktop_rc', 'finalize_acceptance']) assert.ok(cleanup.needs.includes(name));
  assert.equal(cleanup.concurrency.group, jobs.deploy_and_accept.concurrency.group);
  const scale = cleanup.steps.find(step => step.run?.includes('scale "$resource"'));
  assert.equal(scale.if, undefined);
  assert.match(scale.run, /rc-cleanup-ownership\.cjs/);
  assert.doesNotMatch(scale.run, /statefulset\//);
  assert.match(scale.run, /scale deployment\/xpod-rc-inngest --replicas=0/);
  assert.match(scale.run, /delete secret "\$XPOD_RC_SEED_SECRET_NAME" --ignore-not-found/);
  assert.match(scale.run, /resource=deployment\/xpod-rc/);
  assert.doesNotMatch(scale.run, /deployment\/xpod-cloud|namespace\/|delete deployment|delete statefulset|rollout/);
});

test('different release branches retain the same workflow RC lock through desktop and cleanup', () => {
  const workflow = read('candidate.yml');
  const keyFor = ref => workflow.concurrency.group.replaceAll('${{ github.ref }}', ref);
  assert.equal(keyFor('refs/heads/release/0.4.26'), keyFor('refs/heads/release/0.4.27'));
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.notEqual(workflow.concurrency.group, workflow.jobs.deploy_and_accept.concurrency.group);
  assert.notEqual(workflow.concurrency.group, workflow.jobs.cleanup_rc.concurrency.group);
  assert.equal(workflow.concurrency.group, 'xpod-shared-rc-workflow');
});
