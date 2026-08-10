import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('QLever production cutover', () => {
  it('replaces PostgreSQL with a fresh PG17 QLever service without migrating data', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).toContain("readonly XPOD_DEPLOYMENTS=(xpod-cloud xpod-rc)");
    expect(script).toContain("readonly WRITER_DEPLOYMENTS=(xpod-cloud xpod-rc xpod-inngest)");
    expect(script).toContain('scale "deployment/$deployment" --replicas=0');
    expect(script).toContain('createdb');
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS xpod_rdf');
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
    expect(script).not.toContain('pg_dump');
    expect(script).not.toContain('pg_restore');
    expect(script).toContain('xpod_rdf.validate_statistics()');
    expect(script).toContain("xpod_rdf.native_sparql_query(");
    expect(script).toContain('CSS_SPARQL_ENDPOINT');
    expect(script).toContain('CSS_IDENTITY_DB_URL');
    expect(script).toContain('kubectl set image');
    expect(script).toContain('readonly IMAGE_PULL_SECRET="${XPOD_IMAGE_PULL_SECRET:?XPOD_IMAGE_PULL_SECRET is required}"');
    expect(script).toContain('k get secret "$IMAGE_PULL_SECRET"');
    expect(script).toContain('.spec.template.spec.imagePullSecrets=[{"name":$pullSecret}]');
    expect(script).toContain('k patch deployment "$deployment" --type=merge');
    expect(script).toContain('k delete statefulset "$SOURCE_POSTGRES_STS" --wait=true');
    expect(script).toContain('k delete service "$SOURCE_POSTGRES_SERVICE" --wait=true');
    expect(script).toContain('k delete pvc -l "app=$SOURCE_POSTGRES_STS" --wait=true');
    expect(script.indexOf("xpod_rdf.native_sparql_query(")).toBeLessThan(
      script.indexOf('k delete statefulset "$SOURCE_POSTGRES_STS" --wait=true'),
    );
  });

  it('requires immutable images and supports a read-only preflight', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).toContain('preflight');
    expect(script).toContain('cutover');
    expect(script).toContain('sha256:');
    expect(script).toContain('@sha256:[0-9a-f]{64}$');
    expect(script).not.toContain('^ghcr\\.io/undefinedsco/');
    expect(script).toContain('The fresh PG17 target resources already exist');
    expect(script).toContain('must use a dedicated application database');
    expect(script).toContain('Preflight passed: production inputs are consistent');
  });

  it('opens stdin only for PostgreSQL commands that consume a heredoc', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    const nonInteractive = script.slice(script.indexOf('postgres_exec() {'), script.indexOf('postgres_exec_stdin() {'));
    expect(nonInteractive).toContain('k exec "$pod"');
    expect(nonInteractive).not.toContain('exec -i');
    expect(script).toContain('postgres_exec_stdin "$TARGET_POSTGRES_STS-0" psql');
  });

  it('sends psql variable expressions through stdin instead of dash-c', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).not.toContain('-c "SELECT count(*) FROM pg_database WHERE datname = :\'database\'"');
    expect(script).toMatch(/\|\s+postgres_exec_stdin "\$TARGET_POSTGRES_STS-0" psql -d postgres -At/);
  });

  it('uses the same resolved access options as the Cloud native SPARQL adapter', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).toContain("'graphPrefix', 'https://id.undefineds.co/'");
    expect(script).toContain("'authorizationModel', 'mixed'");
    expect(script).toContain("'accessScopeResolved', true");
  });

  it('enables the PostgreSQL-native FTS backend required by the cutover gate', async () => {
    const cloud = await readFile(new URL('../../config/cloud.json', import.meta.url), 'utf8');

    expect(cloud).toContain('"options_textSearchBackend": "pg-native-fts"');
  });

  it('exposes the cutover only through the protected co environment', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/qlever-production-cutover.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('environment: co');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('scripts/qlever-production-cutover.sh');
    expect(workflow).not.toContain('KUBE_CONFIG_DATA }} |');
  });
});
