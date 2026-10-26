/**
 * RC-dedicated PostgreSQL renderer / boundary contract.
 *
 * These exercise the REAL renderer and boundary validator in this repository:
 * the RC-only StatefulSet + bootstrap Job are rendered from the checked-in
 * templates, the dedicated service host is admitted, and the shared production
 * host is still rejected. No cluster, Docker, network or secret access.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  rcOverlayPath,
  read,
  requireRepoModule,
  syntheticAppImage,
  syntheticDigest,
  tempDir,
  yamlObjects,
} from './rc-dedicated-postgres-fixture.mjs';

const renderer = requireRepoModule('scripts/render-rc-manifests.cjs');
const boundary = requireRepoModule('scripts/check-rc-deployment-boundary.cjs');

const NS = 'ns-iknkxtc8';

function renderPg(t, image = syntheticDigest()) {
  const directory = tempDir(t, 'xpod-rc-pg-render-');
  const output = path.join(directory, 'pg.yaml');
  renderer.renderPgManifests(rcOverlayPath, output, image);
  return { output, objects: yamlObjects(read(output)) };
}

test('renderer emits the RC-only StatefulSet, Service and bootstrap Job', (t) => {
  const image = syntheticDigest();
  const { objects } = renderPg(t, image);

  const statefulSet = objects.find((object) => object.kind === 'StatefulSet');
  assert.ok(statefulSet, 'StatefulSet present');
  assert.equal(statefulSet.metadata.name, 'xpod-rc-rdf-postgres');
  assert.equal(statefulSet.spec.template.spec.containers[0].image, image);

  const service = objects.find((object) => object.kind === 'Service');
  assert.equal(service.metadata.name, 'xpod-rc-rdf-postgres');

  const job = objects.find((object) => object.kind === 'Job');
  assert.equal(job.metadata.name, 'xpod-rc-postgres-bootstrap');
  assert.equal(job.spec.template.spec.containers[0].image, image);

  // The PG half must never smuggle an application Deployment into the file
  // that the workflow applies before the single final app apply.
  assert.equal(objects.some((object) => object.kind === 'Deployment'), false);
});

test('rendered PG manifests carry neither the mutable placeholder nor a foreign digest', (t) => {
  const image = syntheticDigest('b');
  const { output } = renderPg(t, image);
  const text = read(output);
  assert.equal(text.includes(renderer.PG_PLACEHOLDER), false);
  for (const document of yamlObjects(text)) {
    for (const container of document.spec?.template?.spec?.containers ?? []) {
      assert.equal(container.image, image, `${document.kind}/${document.metadata?.name}`);
    }
  }
});

test('renderer never mutates the checked-in overlay template', (t) => {
  const before = read(path.join(rcOverlayPath, 'postgres.yaml'));
  renderPg(t, syntheticDigest('c'));
  assert.equal(read(path.join(rcOverlayPath, 'postgres.yaml')), before);
  assert.equal(before.includes(syntheticDigest('c')), false);
});

test('renderer refuses a mutable PG image and a partial PG half', (t) => {
  const directory = tempDir(t, 'xpod-rc-pg-reject-');
  assert.throws(() => renderer.renderRcManifests({
    overlay: rcOverlayPath,
    output: path.join(directory, 'app.yaml'),
    pgOutput: path.join(directory, 'pg.yaml'),
    namespace: NS,
    image: syntheticAppImage,
    pgImage: `${syntheticDigest().split('@')[0]}:latest`,
  }), /immutable sha256/);

  assert.throws(() => renderer.renderRcManifests({
    overlay: rcOverlayPath,
    output: path.join(directory, 'app.yaml'),
    namespace: NS,
    image: syntheticAppImage,
    pgImage: syntheticDigest(),
  }), /must be provided together/);
});

test('pg-only rendering emits no application manifest', (t) => {
  const directory = tempDir(t, 'xpod-rc-pg-only-');
  const output = path.join(directory, 'pg-only.yaml');
  renderer.renderRcManifests({
    pgOnly: true,
    overlay: rcOverlayPath,
    pgOutput: output,
    pgJobName: 'xpod-rc-postgres-bootstrap-9-1',
    pgImage: syntheticDigest(),
  });
  const objects = yamlObjects(read(output));
  assert.ok(objects.length >= 3);
  assert.equal(objects.some((object) => object.kind === 'Deployment'), false);
});

test('renderer stamps the ownership annotation on the run-scoped Job only', (t) => {
  const directory = tempDir(t, 'xpod-rc-pg-owner-');
  const output = path.join(directory, 'owned.yaml');
  const nonce = 'xpod-rc-postgres-bootstrap-1-1';
  renderer.renderPgManifests(rcOverlayPath, output, syntheticDigest(), nonce, nonce);
  const objects = yamlObjects(read(output));
  assert.equal(
    objects.find((object) => object.kind === 'Job').metadata.annotations[renderer.OWNER_ANNOTATION],
    nonce,
  );
  assert.equal(
    objects.find((object) => object.kind === 'StatefulSet').metadata.annotations,
    undefined,
    'retained resources must not carry a per-run owner annotation',
  );
});

test('renderer rejects the static bootstrap Job name and accepts a run-scoped one', (t) => {
  const directory = tempDir(t, 'xpod-rc-pg-jobname-');
  assert.throws(() => renderer.renderPgManifests(
    rcOverlayPath, path.join(directory, 'static.yaml'), syntheticDigest(), 'xpod-rc-postgres-bootstrap',
  ), /run-scoped, not the static template name/);

  const output = path.join(directory, 'run.yaml');
  renderer.renderPgManifests(rcOverlayPath, output, syntheticDigest(), 'xpod-rc-postgres-bootstrap-123-1');
  const job = yamlObjects(read(output)).find((object) => object.kind === 'Job');
  assert.equal(job.metadata.name, 'xpod-rc-postgres-bootstrap-123-1');
});

test('boundary admits the dedicated RC PostgreSQL service variants', () => {
  for (const host of boundary.rcPostgresHosts(NS)) {
    const url = `postgresql://xpod_rc:s3cret@${host}:5432/xpod_rc`;
    assert.doesNotThrow(() => boundary.validateDatabases(new Map([
      ['CSS_IDENTITY_DB_URL', url],
      ['CSS_SPARQL_ENDPOINT', url],
    ]), NS), host);
  }
});

test('boundary rejects the shared production host and production roles', () => {
  const entries = (url) => new Map([
    ['CSS_IDENTITY_DB_URL', url],
    ['CSS_SPARQL_ENDPOINT', url],
  ]);
  for (const host of ['xpod-rdf-postgres', `xpod-rdf-postgres.${NS}`,
    `xpod-rdf-postgres.${NS}.svc`, `xpod-rdf-postgres.${NS}.svc.cluster.local`,
    'production-postgres', 'id.undefineds.cn']) {
    assert.throws(
      () => boundary.validateDatabases(entries(`postgresql://xpod_rc:s3cret@${host}:5432/xpod_rc`), NS),
      /RC-only PostgreSQL/,
      host,
    );
  }
  for (const role of ['postgres', 'xpod_cn', 'xpod_co']) {
    assert.throws(
      () => boundary.validateDatabases(entries(`postgresql://${role}:s3cret@xpod-rc-rdf-postgres:5432/xpod_rc`), NS),
      /RC-only PostgreSQL/,
      role,
    );
  }
});

test('boundary rejects production databases, ports, query, fragment and mismatched credentials', () => {
  const entries = (url) => new Map([
    ['CSS_IDENTITY_DB_URL', url],
    ['CSS_SPARQL_ENDPOINT', url],
  ]);
  const base = 'postgresql://xpod_rc:s3cret@xpod-rc-rdf-postgres:5432/xpod_rc';
  for (const url of [
    base.replace('/xpod_rc', '/xpod_cn'),
    base.replace('/xpod_rc', '/xpod_co'),
    base.replace(':5432', ':5433'),
    `${base}?sslmode=require`,
    `${base}#fragment`,
    base.replace('xpod_rc:', 'postgres:'),
  ]) {
    assert.throws(() => boundary.validateDatabases(entries(url), NS), /RC-only/, url);
    try { boundary.validateDatabases(entries(url), NS); } catch (error) {
      assert.equal(String(error).includes('s3cret'), false, 'error must not leak the password');
    }
  }

  const mismatch = entries(base);
  mismatch.set('CSS_SPARQL_ENDPOINT', base.replace('s3cret', 'other'));
  assert.throws(() => boundary.validateDatabases(mismatch, NS), /credentials must match/);

  const conflicting = entries(base);
  conflicting.set('DATABASE_URL', base.replace('xpod-rc-rdf-postgres', 'xpod-rdf-postgres'));
  assert.throws(() => boundary.validateDatabases(conflicting, NS), /conflicting RC database authority/);
});
