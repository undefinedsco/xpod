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

  it('injects one explicit fake QLever command into source-only runtime smokes', async () => {
    const [ lite, bunSmoke, full, packageSmoke, helper, productClient ] = await Promise.all([
      readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8'),
      readFile(path.join(root, 'scripts/run-bun-runtime-smoke.ts'), 'utf8'),
      readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8'),
      readFile(path.join(root, 'scripts/package-consumer-smoke.cjs'), 'utf8'),
      readFile(path.join(root, 'tests/helpers/qleverRuntime.ts'), 'utf8'),
      readFile(path.join(root, 'src/storage/rdf/LocalQleverNativeSparqlClient.ts'), 'utf8'),
    ]);

    expect(helper).toContain('createFakeQleverRuntimeCommand');
    expect(helper).toContain('fake-qlever-native-runtime.js');
    expect(helper).toContain('`#!${process.execPath}\\nrequire(');
    expect(lite).toContain('createFakeQleverRuntimeCommand');
    expect(bunSmoke).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: runtimeCommand');
    expect(full.match(/XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeCommand/g)).toHaveLength(2);
    expect(packageSmoke).toContain('createFakeQleverRuntimeCommand');
    expect(packageSmoke).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: runtimeFixture.command');
    expect(packageSmoke).toContain("process.env.XPOD_SMOKE_NODE || process.execPath");
    expect(packageSmoke).not.toContain("process.env.XPOD_SMOKE_NODE || 'node'");
    expect(productClient).toContain("const DEFAULT_LOCAL_QLEVER_RUNTIME_COMMAND = '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'");
    expect(productClient).not.toContain('fake-qlever-native-runtime.js');
  });

  it('keeps the bun runtime RDF gate as a write-then-SELECT smoke', async () => {
    const script = await readFile(path.join(root, 'scripts/run-bun-runtime-smoke.ts'), 'utf8');

    expect(script).toContain('runtime sparql smoke');
    expect(script).toContain('SELECT ?label WHERE');
    expect(script).toContain("labels.includes('runtime sparql smoke')");
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

  it('keeps the private PostgreSQL gate out of the public CI workflow', async () => {
    const compose = await readFile(path.join(root, 'docker-compose.cluster.integration.yml'), 'utf8');
    const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(compose).toContain('image: ${XPOD_FULL_POSTGRES_IMAGE:?XPOD_FULL_POSTGRES_IMAGE is required}');
    expect(compose).not.toContain('image: pgvector/pgvector:pg16');
    expect(workflow).toMatch(/permissions:\n  contents: read/);
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('packages: read');
    expect(workflow).not.toContain('integration-full:');
    expect(workflow).not.toContain('xpod-rdf-postgres');
    expect(workflow).toContain(
      'XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: ${{ github.workspace }}/tests/fixtures/fake-qlever-native-runtime.js',
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
