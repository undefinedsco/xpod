/**
 * RC-dedicated PostgreSQL candidate-workflow contract.
 *
 * The assertions read the REAL .github/workflows/candidate.yml and the REAL
 * checked-in manifests. They pin the externally observable contract rather than
 * restating the workflow: one canonical PG digest, the 17+6 gate before any
 * mutation, one final app apply, run-scoped bootstrap Job with UID-guarded
 * deletion, fail-closed quiescence, and the dedicated RC StatefulSet.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  cleanupSteps,
  deploySteps,
  findStep,
  loadWorkflow,
  rcOverlayPath,
  read,
  readWorkflowText,
  yamlObjects,
} from './rc-dedicated-postgres-fixture.mjs';

const PG_DIGEST = /xpod-rdf-postgres@sha256:([a-f0-9]{64})/g;
const STALE_DIGEST = '1199698c789fb65897e4b0bd370f7faa959bcbdd3499784af256ad5bb8f0a5f3';

test('workflow declares one canonical immutable PG image', () => {
  const workflow = loadWorkflow();
  assert.match(workflow.env.NATIVE_PG_IMAGE, /@sha256:[a-f0-9]{64}$/);
  const text = readWorkflowText();
  assert.equal(text.includes(STALE_DIGEST), false, 'superseded digest must not remain');
  const digests = [...text.matchAll(PG_DIGEST)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(digests)].sort(),
    [ workflow.env.NATIVE_PG_IMAGE.split(':').at(-1),
      workflow.env.PG_REGISTRY_AUTHORITY_IMAGE.split(':').at(-1) ].sort(),
    'only the RC target and the declared production authority digest may appear',
  );
});

test('the production authority image stays the shared production digest', () => {
  const workflow = loadWorkflow();
  assert.notEqual(workflow.env.PG_REGISTRY_AUTHORITY_IMAGE, workflow.env.NATIVE_PG_IMAGE);
  assert.match(workflow.env.PG_REGISTRY_AUTHORITY_IMAGE, /@sha256:[a-f0-9]{64}$/);
});

test('one NATIVE_PG_IMAGE feeds the gate, full suite, pull preflight and RC workload', () => {
  const text = readWorkflowText();
  assert.match(text, /--installed-image "\$NATIVE_SERVICE_IMAGE" --pg-image "\$NATIVE_PG_IMAGE"/);
  assert.match(text, /XPOD_FULL_POSTGRES_IMAGE: \$\{\{ env.NATIVE_PG_IMAGE \}\}/);
  assert.match(text, /job\.spec\.template\.spec\.containers\[0\]\.image=process\.env\.NATIVE_PG_IMAGE/);
  assert.match(text, /--pg-image "\$NATIVE_PG_IMAGE"/);
  assert.equal(/--pg-image "\$PG_REGISTRY_AUTHORITY_IMAGE"/.test(text), false,
    'the production credential-source digest must never be passed as the RC PG image');
});

test('registry authority is selected from the declared current/target pair', () => {
  const text = readWorkflowText();
  assert.match(text, /select-pg-registry-authority\.ts[\s\S]{0,400}?--current-image "\$PG_REGISTRY_AUTHORITY_IMAGE"/);
  assert.match(text, /--target-image "\$NATIVE_PG_IMAGE"/);
  assert.equal(text.includes('--select-registry-authority'), false, 'the single-image selector must be gone');
});

test('no step mutates or scales the shared production StatefulSet', () => {
  const text = readWorkflowText();
  for (const forbidden of [
    'set image statefulset/xpod-rdf-postgres',
    'patch statefulset/xpod-rdf-postgres',
    'rollout restart statefulset/xpod-rdf-postgres',
    'delete statefulset/xpod-rdf-postgres',
    'scale statefulset/xpod-rdf-postgres',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('17+6 conformance and both applies are ordered before RC mutation', () => {
  const steps = deploySteps();
  const names = steps.map((step) => step.name ?? '');
  const index = (needle) => names.findIndex((name) => name.includes(needle));

  const gate = index('Preflight immutable native images before any RC mutation');
  const bootstrap = index('Verify RC-only PostgreSQL and bootstrap');
  const app = index('Deploy RC image by digest');
  assert.ok(gate >= 0 && bootstrap > gate && app > bootstrap, 'gate → PG bootstrap → single app apply');

  // The 17+6 gate text itself, plus private17 admission, must precede every
  // apply that touches the RC environment.
  const gateText = findStep(steps, 'Preflight immutable native images').run;
  assert.match(gateText, /--pg-image "\$NATIVE_PG_IMAGE"/);
  const private17 = findStep(steps, 'Require independent exact-pair Private17 admission').run;
  assert.match(private17, /--verify-private17-admission/);
  assert.match(private17, /--pg-image "\$NATIVE_PG_IMAGE"/);
  assert.ok(index('Require independent exact-pair Private17 admission') < bootstrap,
    'private17 admission must precede the PG bootstrap');

  // The recorded proof asserts the exact 16 public + 17 pro cases; that check
  // happens when the acceptance manifest is assembled, never as a substitute
  // for the gate above.
  const evidence = findStep(steps, 'Create service acceptance evidence').run;
  assert.match(evidence, /publicCases !== 16 \|\| private17\.proCases !== 17/);
});

test('the app Deployment is applied exactly once, with no per-field mutation', () => {
  const text = readWorkflowText();
  assert.match(text, /kubectl apply -f "\$rendered_manifest"/);
  assert.equal(text.match(/kubectl apply -f "\$rendered_manifest"/g).length, 1);
  for (const forbidden of [ 'set image deployment/xpod-rc', 'patch deployment/xpod-rc',
    'rollout restart deployment/xpod-rc' ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // The PG half has its own rendered file and its own apply; they never mix.
  assert.match(text, /--pg-output "\$pg_output"/);
  assert.match(text, /kubectl -n "\$SEALOS_NAMESPACE" apply -f "\$pg_output"/);
});

test('bootstrap readiness targets the RC-only StatefulSet, never the shared one', () => {
  const text = readWorkflowText();
  assert.match(text, /rollout status statefulset\/xpod-rc-rdf-postgres/);
  assert.match(text, /wait --for=condition=complete "job\/\$pg_job_name"/);
  assert.match(text, /exec -i statefulset\/xpod-rc-rdf-postgres -- sh -s < scripts\/verify-protected-rc-database\.sh/);
  assert.equal(/exec -i statefulset\/xpod-rdf-postgres --/.test(text), false);
});

test('the consuming step re-derives the validated env file (cross-step shell isolation)', () => {
  const text = readWorkflowText();
  assert.match(text, /env_file="\$\{RUNNER_TEMP\}\/xpod-rc\.env"/);
  assert.match(text, /validated RC env file is missing/);
});

test('run-scoped bootstrap Job is deleted only through the nonce+UID guard', () => {
  const text = readWorkflowText();
  assert.match(text, /pg_job_name="xpod-rc-postgres-bootstrap-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(text, /--pg-job-name "\$pg_job_name"/);
  assert.match(text, /--pg-owner "\$pg_job_name"/);
  assert.match(text, /rc-bootstrap-ownership\.cjs delete-options/);
  assert.match(text, /delete --raw "\/apis\/batch\/v1\/namespaces\/\$\{SEALOS_NAMESPACE\}\/jobs\/\$\{pg_job_name\}"/);
  assert.equal(/kubectl[^\n]*delete job "\$pg_job_name" --ignore-not-found --wait=true/.test(text), false,
    'no unqualified delete-by-name of the run Job');
  const deleteAt = text.indexOf('delete-options');
  const applyAt = text.indexOf('apply -f "$pg_output"');
  assert.ok(deleteAt > 0 && applyAt > deleteAt, 'ownership-checked delete must precede apply');
});

test('quiescence is fail-closed and happens before any PG mutation', () => {
  const text = readWorkflowText();
  assert.match(text, /rc-bootstrap-ownership\.cjs quiescent/);
  assert.match(text, /get pods -l app=xpod-rc -o json/);
  const quiesceAt = text.indexOf('rc-bootstrap-ownership.cjs quiescent');
  const applyAt = text.indexOf('apply -f "$pg_output"');
  assert.ok(quiesceAt > 0 && applyAt > quiesceAt, 'quiescence must run before the PG apply');
  assert.equal(/scale deployment\/xpod-rc --replicas=0[\s\S]{0,200}quiesc/.test(text), false,
    'quiescence must never scale an active candidate');
  assert.equal(/kubectl[^\n]*scale deployment\/xpod-rc[^\n]*\n[^\n]*quiescent/.test(text), false);
});

test('the validation step materializes the dedicated host from current credentials', () => {
  const text = findStep(deploySteps(), 'Validate RC runtime secret isolation').run;
  assert.match(text, /materializeRcDatabaseConfiguration\(entries, namespace\)/);
  assert.match(text, /require\('\.\/scripts\/check-rc-deployment-boundary\.cjs'\)/);
  assert.equal(text.includes('APP_ENV_FILE='), false, 'the step consumes the injected secret, never a GitHub write');
  for (const forbidden of [ 'gh secret', 'gh api', 'secrets\.APP_ENV_FILE' ]) {
    assert.equal(new RegExp(forbidden).test(text), false, forbidden);
  }
});

test('the quiescence observation fails closed on API errors', () => {
  const text = readWorkflowText();
  assert.match(text, /get deployment xpod-rc --ignore-not-found -o json/);
  assert.match(text, /get pods -l app=xpod-rc -o json/);
  assert.equal(/get deployment xpod-rc -o json[^\n]*2>\/dev\/null/.test(text), false,
    'an observation error must abort, not be read as absent');
  assert.equal(/get pods -l app=xpod-rc -o json[^\n]*2>\/dev\/null/.test(text), false);
});

test('cleanup deletes only the run-owned bootstrap Job, never the RC server', () => {
  const text = findStep(cleanupSteps(), 'Scale RC deployments').run;
  assert.match(text, /bootstrap_job="xpod-rc-postgres-bootstrap-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(text, /rc-bootstrap-ownership\.cjs delete-options[\s\S]{0,200}--owner "\$bootstrap_job"/);
  assert.match(text, /delete --raw "\/apis\/batch\/v1\/namespaces\/\$\{SEALOS_NAMESPACE\}\/jobs\/\$\{bootstrap_job\}"/);
  assert.match(text, /wait --for=delete pod -l "job-name=\$bootstrap_job"/);
  assert.match(text, /scale deployment\/xpod-rc --replicas=0/);
  for (const forbidden of [ 'delete statefulset/xpod-rc-rdf-postgres',
    'delete pvc xpod-rc-rdf-postgres', 'delete secret xpod-rc-postgres-bootstrap' ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('cleanup keeps the RC server, PVC and admin secret', () => {
  const text = readWorkflowText();
  const cleanup = yamlObjects(read(path.join(rcOverlayPath, 'postgres.yaml')));
  assert.ok(cleanup.some((object) => object.kind === 'StatefulSet'));
  for (const forbidden of [
    'delete statefulset/xpod-rc-rdf-postgres',
    'delete pvc xpod-rc-rdf-postgres-postgres-data',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('RC PG templates stay outside the kustomization so app apply stays single', () => {
  const kustomization = read(path.join(rcOverlayPath, 'kustomization.yaml'));
  assert.equal(kustomization.includes('postgres.yaml'), false);
  assert.equal(kustomization.includes('postgres-bootstrap.yaml'), false);
});
