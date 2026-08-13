import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertSemanticConformanceParity,
  type SemanticConformanceReport,
} from '../../../src/acceptance/QleverSemanticConformance';

const repoRoot = path.resolve(__dirname, '../../..');
const helperPath = path.join(repoRoot, 'src/acceptance/QleverSemanticConformance.ts');
const scriptPath = path.join(repoRoot, 'scripts/check-qlever-sqlite-semantic-conformance.ts');
const parserPath = path.join(repoRoot, 'src/storage/accessors/SolidRdfDataAccessor.ts');
const fixturePath = path.join(repoRoot, 'qlever/tests/fixtures/qlever-semantic-conformance.cjs');

describe('LocalQleverSemanticAuthorityHarness', () => {
  it('seeds file-authority documents before exercising prepared updates', () => {
    expect(existsSync(helperPath)).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
    const helper = readFileSync(helperPath, 'utf8');
    expect(helper).toContain('parsePreparedUpdateDelta');
    expect(helper).toContain('PREPARED_UPDATE_MEDIA_TYPE');
    expect(helper).toContain("operation: 'prepareUpdate'");
    expect(helper).toContain('engine.applyDelta');
    expect(helper).toContain('const seedEngine = new SolidRdfEngine({ index: { path: dbPath } })');
    expect(helper).toContain('await seedEngine.close()');
    expect(helper).toContain('index: { path: dbPath }');
    expect(helper).not.toContain('new RdfQuadIndex({ path: dbPath })');
    expect(helper).toContain('new SolidRdfEngine');
    expect(helper).toContain('engine.replaceSource');
    expect(helper).toContain('new Parser');
    expect(helper).toContain('allowedSourceUrls');
    expect(helper).toContain('deniedSourceUrls');
    expect(helper).toContain('rmSync(dbPath, { force: true })');
    expect(helper).not.toContain("operation: 'execute'");
    expect(helper).not.toContain('CREATE TABLE rdf_terms');
    expect(helper).not.toContain('CREATE TRIGGER');
    expect(helper).toContain('prepareAndApplyUpdate(engine, update.sparql');
    expect(helper).toContain('sourceUri,\n    operation: \'prepareUpdate\'');
    expect(helper).not.toContain('sourceUri: DEFAULT_SOURCE_URI');
    expect(helper).not.toContain('RdfSparqlAdapter');
    expect(helper).not.toContain('compileUpdateDelta');
  });

  it('uses explicit documents and updates without the obsolete setup-update shape', () => {
    const fixture = require(fixturePath) as {
      semanticConformanceCases: {
        id: string;
        documents: { sourceUri: string; graph?: string; contentType: string; body: string }[];
        updates: { sourceUri: string; sparql: string }[];
        setupUpdate?: unknown;
        sourceScopedUpdates?: unknown;
      }[];
    };

    expect(fixture.semanticConformanceCases).toHaveLength(14);
    for (const testCase of fixture.semanticConformanceCases) {
      expect(testCase.setupUpdate).toBeUndefined();
      expect(testCase.sourceScopedUpdates).toBeUndefined();
      expect(Array.isArray(testCase.documents)).toBe(true);
      expect(Array.isArray(testCase.updates)).toBe(true);
      for (const document of testCase.documents) {
        expect(document.sourceUri).toBeTruthy();
        expect(document.graph ?? 'source').toMatch(/^(source|default)$/);
        expect(document.contentType).toBe('text/turtle');
        expect(document.body.trim()).toBeTruthy();
      }
      for (const update of testCase.updates) {
        expect(update.sourceUri).toBeTruthy();
        expect(update.sparql.trim()).toBeTruthy();
      }
    }
  });

  it('models RDF default graph separately from file source authority', () => {
    const fixture = require(fixturePath) as {
      semanticConformanceCases: {
        id: string;
        documents: { sourceUri: string; graph?: string; body: string }[];
      }[];
    };
    const helper = readFileSync(helperPath, 'utf8');
    const defaultGraphCase = fixture.semanticConformanceCases
      .find((testCase) => testCase.id === 'graph/default-and-named');

    expect(defaultGraphCase).toBeTruthy();
    expect(defaultGraphCase?.documents).toContainEqual(expect.objectContaining({
      sourceUri: 'urn:xpod:semantic:source:default-graph',
      graph: 'default',
    }));
    expect(defaultGraphCase?.documents.some((document) =>
      document.sourceUri === 'http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph')).toBe(false);
    expect(helper).toContain("document.graph === 'default'");
    expect(helper).toContain('DataFactory.defaultGraph()');
    expect(helper).toContain('DataFactory.namedNode(document.sourceUri)');
  });

  it('uses RDF/JS canonical lowercase language tags', () => {
    const fixture = require(fixturePath) as {
      semanticConformanceCases: {
        id: string;
        documents: { body: string }[];
        expectedCanonical: { rows: { o?: string }[] };
      }[];
    };
    const languageCase = fixture.semanticConformanceCases
      .find((testCase) => testCase.id === 'term/language-literal');

    expect(languageCase?.documents[0]?.body).toContain('"colour"@en-GB');
    expect(languageCase?.expectedCanonical.rows).toContainEqual(expect.objectContaining({
      o: '"colour"@en-gb',
    }));
  });

  it('requires explicit fixture, runtime, and artifact paths', () => {
    const result = spawnSync('bun', [scriptPath, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        XPOD_QLEVER_SEMANTIC_FIXTURE_PATH: '',
        XPOD_QLEVER_SQLITE_RUNTIME_COMMAND: '',
        XPOD_QLEVER_SQLITE_SEMANTIC_ARTIFACT_PATH: '',
      },
    });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'failed',
      backend: 'sqlite',
      error: expect.stringContaining('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH'),
    });
  });

  it('uses the product prepared-delta parser through a narrow export', () => {
    const parser = readFileSync(parserPath, 'utf8');
    expect(parser).toContain('export const PREPARED_UPDATE_MEDIA_TYPE');
    expect(parser).toContain('export function parsePreparedUpdateDelta');
  });

  it('compares canonical case results instead of backend-specific report digests', () => {
    const local = semanticReport('sqlite', { kind: 'bindings', rows: [{ value: 'same' }] });
    const cloud = semanticReport('pg', { kind: 'bindings', rows: [{ value: 'same' }] });
    local.canonicalDigest = 'sha256:local-report-metadata';
    cloud.canonicalDigest = 'sha256:cloud-report-metadata';

    expect(assertSemanticConformanceParity(local, cloud)).toMatchObject({
      caseIds: ['case-1'],
      canonicalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    cloud.results[0].canonical = { kind: 'bindings', rows: [{ value: 'different' }] };
    expect(() => assertSemanticConformanceParity(local, cloud))
      .toThrow('Local/Cloud semantic canonical mismatch');
  });
});

function semanticReport(
  backend: 'sqlite' | 'pg',
  canonical: unknown,
): SemanticConformanceReport {
  return {
    schemaVersion: 1,
    backend,
    engine: backend === 'sqlite'
      ? 'local-qlever-prepared-update-authority'
      : 'pg-qlever-prepared-update-authority',
    status: 'ok',
    caseIds: ['case-1'],
    skipped: [],
    failed: [],
    results: [{
      caseId: 'case-1',
      status: 'ok',
      canonical,
      preparedUpdates: 1,
      appliedDelta: { deletedRows: 0, insertedRows: 1 },
      authority: backend,
    }],
    authorization: { deniedRowsObserved: 0 },
    sourceScope: { sourceDeniedValidatedBy: backend },
    canonicalDigest: '',
  };
}
