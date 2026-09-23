import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GATE = 'scripts/check-rdf-sqlite-backend-plugin.ts';
const CMAKE = 'qlever/rdf_sqlite_backend/CMakeLists.txt';
const HARNESS = 'qlever/tests/xpod_rdf_sqlite_plugin_smoke.c';
const DOC = 'docs/testing/native-fixture-contracts.md';
const PACKAGE = 'package.json';

describe('RDF SQLite backend plugin gate', () => {
  it('keeps the packaged runtime on the static target while offering a plugin target', () => {
    const cmake = readFileSync(CMAKE, 'utf8');
    // The image contract asserts this literal, so the default must stay static.
    expect(cmake).toMatch(/add_library\(xpod_rdf_sqlite_backend\s+STATIC/);
    expect(cmake).toContain('option(XPOD_RDF_SQLITE_BACKEND_SHARED');
    expect(cmake).toMatch(/add_library\(xpod_rdf_sqlite_backend_plugin\s+SHARED/);
    expect(cmake).toContain('OUTPUT_NAME "xpod_rdf_sqlite_backend"');
  });

  it('provisions the owner-facts schema the backend fails closed on', () => {
    const gate = readFileSync(GATE, 'utf8');
    for (const table of ['rdf_terms', 'rdf_quads', 'rdf_index_metadata']) {
      expect(gate).toContain(`CREATE TABLE ${table}`);
    }
    expect(gate).toContain("VALUES ('schema_version', '");
    expect(gate).toContain("const SCHEMA_VERSION = '1'");
    // A missing schema must stay a hard failure, never a silent empty backend.
    expect(gate).toContain('exitCode !== 0');
  });

  it('asserts the rollback-only staging contract and the read path', () => {
    const harness = readFileSync(HARNESS, 'utf8');
    expect(harness).toContain('apply_mutation alone persists nothing (rollback-only staging)');
    expect(harness).toContain('commit_transaction refuses with UNSUPPORTED');
    expect(harness).toContain('looks up a seeded subject term');
    expect(harness).toContain('counts the seeded quad through a SPOG permutation scan');
  });

  it('is registered as a documented gate', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:qlever:sqlite-plugin']).toBe('bun scripts/check-rdf-sqlite-backend-plugin.ts');
    expect(readFileSync(DOC, 'utf8')).toContain('bun run test:qlever:sqlite-plugin');
  });
});
