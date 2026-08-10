import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('lite integration local runtime isolation', () => {
  it('regenerates Components.js metadata before starting the runtime', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    const buildIndex = script.indexOf("runCommand('bun', [ 'run', 'build:components' ]");
    const startIndex = script.indexOf("stack.start('local'");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(startIndex);
  });

  it('does not auto-register a standalone lite stack against the official Cloud', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    expect(script).toContain("XPOD_LOCAL_AUTO_PROVISION: 'false'");
    expect(script).toContain('stack.start(');
    expect(script).not.toMatch(/await\s+stack\.start\(\s*\)/);
  });

  it('disables auto-provision only for standalone full-runtime local nodes', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8');

    const localManagedBlock = script.slice(
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'local')"),
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"),
    );
    const standaloneBlock = script.slice(script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"));

    expect(localManagedBlock).toContain('XPOD_CLOUD_API_ENDPOINT');
    expect(localManagedBlock).not.toContain('XPOD_LOCAL_AUTO_PROVISION');
    expect(standaloneBlock).toContain("XPOD_LOCAL_AUTO_PROVISION: 'false'");
  });

  it('requires the full integration stack to use an explicit QLever PostgreSQL image', async () => {
    const compose = await readFile(path.join(root, 'docker-compose.cluster.integration.yml'), 'utf8');

    expect(compose).toContain('image: ${XPOD_FULL_POSTGRES_IMAGE:?XPOD_FULL_POSTGRES_IMAGE is required}');
    expect(compose).not.toContain('image: pgvector/pgvector:pg16');
  });

  it('pins full CI conformance to an immutable verified PG17 QLever image', async () => {
    const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toMatch(
      /XPOD_FULL_POSTGRES_IMAGE: ghcr\.io\/undefinedsco\/xpod-rdf-postgres@sha256:[0-9a-f]{64}/,
    );
  });

  it('cuts production over to a fresh PG17 QLever database without migration or fallback', async () => {
    const script = await readFile(path.join(root, 'scripts/qlever-production-cutover.sh'), 'utf8');

    expect(script).not.toContain('pg_dump');
    expect(script).not.toContain('pg_restore');
    expect(script).not.toContain('OLD_POSTGRES');
    expect(script).not.toContain('rollback');
    expect(script).not.toContain('map(select(.name!="POSTGRES_DB"))');
    expect(script).toContain('REQUIRED_DATABASES');
    expect(script).toContain('createdb --maintenance-db=postgres "$database"');
    expect(script).toContain('psql -d "$database" -v ON_ERROR_STOP=1');
    expect(script).not.toContain('expected shared database authority');
    expect(script).toContain('delete pvc -l "app=$SOURCE_POSTGRES_STS" --wait=true');
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
    expect(script).toContain("Expected PostgreSQL 17");
  });

});
