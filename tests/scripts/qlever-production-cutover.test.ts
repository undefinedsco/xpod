import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('QLever production cutover', () => {
  it('keeps the old database as a rollback point and migrates both Xpod deployments', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).toContain("readonly XPOD_DEPLOYMENTS=(xpod-cloud xpod-rc)");
    expect(script).toContain("readonly WRITER_DEPLOYMENTS=(xpod-cloud xpod-rc xpod-inngest)");
    expect(script).toContain('scale --replicas=0');
    expect(script).toContain('pg_dump');
    expect(script).toContain('pg_restore');
    expect(script).toContain('query_public_table_counts');
    expect(script).toContain('xpod_bootstrap');
    expect(script).toContain('createdb');
    expect(script).not.toContain('--clean --if-exists');
    expect(script).toContain('xpod_qlever_refresh_statistics()');
    expect(script).toContain('xpod_qlever_prepare_physical_schema()');
    expect(script).toContain('xpod_rdf.validate_statistics()');
    expect(script).toContain('CREATE INDEX CONCURRENTLY');
    expect(script).toContain("xpod_rdf.native_sparql_query(");
    expect(script).toContain('CSS_SPARQL_ENDPOINT');
    expect(script).toContain('CSS_IDENTITY_DB_URL');
    expect(script).toContain('kubectl set image');
    expect(script).not.toMatch(/kubectl[^\n]+delete[^\n]+statefulset[^\n]+postgres/i);
    expect(script).not.toMatch(/kubectl[^\n]+delete[^\n]+pvc/i);
  });

  it('requires immutable images and supports a read-only preflight', async () => {
    const script = await readFile(new URL('../../scripts/qlever-production-cutover.sh', import.meta.url), 'utf8');

    expect(script).toContain('preflight');
    expect(script).toContain('cutover');
    expect(script).toContain('sha256:');
    expect(script).toContain('^ghcr\\.io/undefinedsco/xpod-rdf-postgres@sha256:');
    expect(script).toContain("pid<>pg_backend_pid()");
    expect(script).toContain('sha-[0-9a-f]');
    expect(script).toContain('The two authority URLs must refer to the same database');
    expect(script).toContain('TARGET_DATABASE" == postgres');
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
