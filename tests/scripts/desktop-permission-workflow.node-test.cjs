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

test('diagnostic reuses the retained prebuilt app instead of rebuilding API/native/desktop', () => {
  const { jobs } = read('ci.yml');
  const job = jobs['desktop-launch-diagnostic'];
  const steps = job.steps;
  // No build pipeline remains in this diagnostic route.
  for (const marker of ['prepareApiCapability', 'applyRootVersion', 'bun run build:packages',
    'build:ts', 'build:components', 'bun run dist', 'electron/install.js',
    'restore-root-dependencies']) {
    assert.equal(steps.filter(s => s.run?.includes(marker)).length, 0,
      `${marker} must not run in the retained-artifact diagnostic`);
  }
  // Immutable retained origin, never a rebuilt archive.
  assert.equal(job.env.DIAGNOSTIC_ARTIFACT_ID, '14027002959');
  assert.equal(job.env.DIAGNOSTIC_ARTIFACT_SHA256,
    '1c631b05304f0f74bb169ca89c66331f17a211d16103cc23c438d61d67e131d5');
  assert.equal(job.env.DIAGNOSTIC_ARTIFACT_SIZE, '1574941283');
  assert.equal(job.env.DIAGNOSTIC_RUN_ID, '43399663838');
  assert.equal(job.env.DIAGNOSTIC_RUN_SOURCE_SHA, '759379b8d5a3b82cf008e6e42c5742b0305c4dd6');
  assert.equal(job.env.ORIGINAL_SOURCE_SHA, undefined);
  assert.equal(job.env.ORIGINAL_APP_SHA, undefined);
  assert.equal(job.env.ORIGINAL_APP_DIGEST, undefined);
  // Verification happens before the launch, and only a small safe record is kept.
  const verify = steps.findIndex(s => s.run?.includes('verify-retained-desktop-artifact.py extract'));
  const launch = steps.findIndex(s => s.run?.includes('desktop-launch-diagnostic.ts'));
  assert.ok(verify >= 0 && launch > verify);
  const upload = steps.find(s => s.uses === 'actions/upload-artifact@v4');
  const uploaded = String(upload.with.path);
  assert.ok(!uploaded.includes('*-mac.zip') && !uploaded.includes('*.dmg'));
  assert.ok(uploaded.includes('desktop-launch-diagnostic/diagnostic-safe.json'));
  // Timeout only shrank; the original 60s launch budget lives in the helper.
  assert.ok(job['timeout-minutes'] <= 20);
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions.actions, 'read');
  assert.equal(job.environment, undefined);
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

// ---- FAILURE-EVIDENCE retention after an API preparation failure -------------
// The approved canonical pattern (api-module-product.yml) uploads only the
// producer's own receipt/evidence, never a workspace or env dump. These assert
// the same narrow contract in each desktop job.
const FAILURE_UPLOAD = 'Upload failed API preparation diagnostics separately';

test('all three desktop jobs retain the producer receipt/evidence on API failure', () => {
  // The ci.yml diagnostic no longer produces an API capability at all: it launches
  // the RETAINED archive. Only the two real build jobs keep the API failure upload.
  const jobs = [
    ['candidate.yml', 'build_desktop_rc'],
    ['release.yml', 'build_desktop_macos'],
  ];
  for (const [file, jobName] of jobs) {
    const job = read(file).jobs[jobName];
    const upload = job.steps.find(s => s.name === FAILURE_UPLOAD);
    assert.ok(upload, `${file}:${jobName} must retain failure evidence`);
    // Runs ONLY on failure, and only when the owned root was published.
    assert.match(String(upload.if), /^failure\(\)/);
    assert.match(String(upload.if), /XPOD_API_CAPABILITY_ROOT != ''/);
    // Never fail the job for missing evidence; the real failure must stand.
    assert.equal(upload.with['if-no-files-found'], 'warn');
    const paths = String(upload.with.path);
    // Exactly the approved narrow members.
    for (const member of ['producer.receipt.json', 'evidence/', 'originals/prepare-inputs.receipt.safe.json']) {
      assert.ok(paths.includes(member), `${file}:${jobName} must retain ${member}`);
    }
    // No broad tree, dependency cache, environment or credential dump.
    assert.doesNotMatch(paths, /node_modules|workspace|\bsrc\/|\.env|token|secret/i);
    // The artifact is explicitly a diagnostic, not desktop qualification.
    assert.match(String(upload.with.name), /diagnostics/);
    // The prep step must PUBLISH the canonical root, otherwise the upload can
    // never resolve it and the reason is lost again.
    const prep = job.steps.find(s => s.run?.includes('prepareApiCapability'));
    assert.ok(prep, `${file}:${jobName} must run the API preparation`);
    assert.match(String(prep.run), /XPOD_API_CAPABILITY_ROOT="\$PWD\/\.test-data\/api-capability-\$\(git rev-parse HEAD\)"/);
    assert.match(String(prep.run), /GITHUB_ENV/);
  }
});

test('the API failure reporter projects only allow-listed facts and leaks nothing', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const root = path.resolve(__dirname, '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-reporter-'));
  try {
    const probe = path.join(dir, 'probe.ts');
    fs.writeFileSync(probe, [
      `import { describeProducerFailure } from ${JSON.stringify(path.join(root, 'desktop/scripts/api-capability-producer.ts'))};`,
      `import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';`,
      `import { tmpdir } from 'node:os';`,
      `import path from 'node:path';`,
      `const mk = () => { const d = mkdtempSync(path.join(tmpdir(), 'fr-')); mkdirSync(path.join(d, 'evidence'), { recursive: true }); return d; };`,
      `const out: any = {};`,
      // A: absent receipt
      `{ const d = mk(); out.absent = describeProducerFailure(d, 1); rmSync(d, { recursive: true, force: true }); }`,
      // B: realistic dependency-state failure with the REAL phase receipt fields
      `{ const d = mk();`,
      `  writeFileSync(path.join(d, 'producer.receipt.json'), JSON.stringify({`,
      `    status: 'failed',`,
      `    failure: 'ValueError: API phase did not close successfully: dependency-state',`,
      `    phases: [`,
      `      { name: 'install', receipt: { sha256: 'a'.repeat(64) }, raw: { sha256: 'b'.repeat(64) } },`,
      `      { name: 'dependency-state', receipt: { sha256: 'c'.repeat(64) }, raw: { sha256: 'd'.repeat(64) } },`,
      `    ],`,
      `  }));`,
      `  writeFileSync(path.join(d, 'evidence', 'dependency-state.receipt.json'), JSON.stringify({`,
      `    exit: 1, signal: null, actualWait: true, ownedGroupAbsentAfterWait: true,`,
      `    rawClosedBeforeHash: true, resourceStop: null, supervisorError: null, cleanupErrors: [],`,
      `  }));`,
      `  out.real = describeProducerFailure(d, 1); rmSync(d, { recursive: true, force: true }); }`,
      // C: malicious positions — failure text, phase.name and digests all carry a secret
      `{ const d = mk();`,
      `  writeFileSync(path.join(d, 'producer.receipt.json'), JSON.stringify({`,
      `    status: 'failed',`,
      `    failure: 'ValueError: API phase did not close successfully: SECRET-TOKEN-VALUE /Users/secret/path',`,
      `    phases: [`,
      `      { name: 'SECRET-TOKEN-VALUE', receipt: { sha256: 'SECRET-TOKEN-VALUE' }, raw: { sha256: 'SECRET-TOKEN-VALUE' } },`,
      `      { name: 'dependency-state', receipt: { sha256: 'SECRET-TOKEN-VALUE' }, raw: { sha256: 'e'.repeat(64) } },`,
      `    ],`,
      `    env: { GH_TOKEN: 'SECRET-TOKEN-VALUE' }, token: 'SECRET-TOKEN-VALUE',`,
      `  }));`,
      `  writeFileSync(path.join(d, 'evidence', 'dependency-state.receipt.json'), JSON.stringify({ exit: 0, signal: null }));`,
      `  out.malicious = describeProducerFailure(d, 1); rmSync(d, { recursive: true, force: true }); }`,
      // D: failure text that is NOT the fixed pattern must never be echoed
      `{ const d = mk();`,
      `  writeFileSync(path.join(d, 'producer.receipt.json'), JSON.stringify({`,
      `    status: 'failed', failure: 'OSError: /Users/secret/path SECRET-TOKEN-VALUE', phases: [],`,
      `  }));`,
      `  out.freeform = describeProducerFailure(d, 1); rmSync(d, { recursive: true, force: true }); }`,
      `process.stdout.write(JSON.stringify(out));`,
    ].join('\n'));
    const run = spawnSync('bun', ['run', probe], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    const { absent, real, malicious, freeform } = JSON.parse(String(run.stdout).trim());

    // Missing receipt is reported honestly.
    assert.match(absent, /receipt=absent/);

    // Realistic dependency-state failure: phase, digests and REAL closure fields.
    assert.match(real, /failedPhase=dependency-state/);
    assert.match(real, /producerExit=1/);
    assert.match(real, /\[dependency-state receipt=cccccccccccc raw=dddddddddddd exit=1 signal=null actualWait=1 groupAbsent=1 rawClosed=1 resourceStop=none supervisorError=none cleanupErrors=0\]/);

    // A non-canonical phase name and non-hex digests are refused, not echoed.
    assert.match(malicious, /failedPhase=unavailable/);
    assert.doesNotMatch(malicious, /SECRET/);
    assert.doesNotMatch(malicious, /secret\/path/);
    assert.match(malicious, /\[dependency-state receipt=none raw=eeeeeeeeeeee/);

    // Free-form failure text is never printed.
    assert.match(freeform, /failedPhase=unavailable/);
    assert.doesNotMatch(freeform, /SECRET/);
    assert.doesNotMatch(freeform, /Users\/secret/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
