import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostgresRdfEngine } from '../../src/storage/rdf/PostgresRdfEngine';
import {
  runPublicRdfQuerySemanticCase,
  runPostgresPublicSemanticConformance,
} from '../../src/acceptance/PublicCloudSemanticConformance';
import type { SemanticFixtureCase } from '../../src/acceptance/RdfSemanticConformance';

const repoRoot = path.resolve(__dirname, '../..');
const fixturePath = path.join(repoRoot, 'qlever/tests/fixtures/qlever-semantic-conformance.cjs');

describe('PublicCloudSemanticConformance', () => {
  it('keeps the public Cloud RDF query authority out of the QLever native module', () => {
    const qlever = require('node:fs').readFileSync(path.join(repoRoot, 'src/acceptance/QleverSemanticConformance.ts'), 'utf8');
    const publicCloud = require('node:fs').readFileSync(path.join(repoRoot, 'src/acceptance/PublicCloudSemanticConformance.ts'), 'utf8');

    expect(qlever).not.toContain('RdfSparqlAdapter');
    expect(qlever).not.toContain('compileUpdateDelta');
    expect(qlever).not.toContain('runPostgresPublicSemanticConformance');
    expect(publicCloud).toContain('RdfSparqlAdapter');
    expect(publicCloud).toContain('compileUpdateDelta');
    expect(publicCloud).toContain('RdfQuerySparqlEngine');
  });

  it('exposes a public PostgreSQL semantic conformance entry point', () => {
    expect(runPostgresPublicSemanticConformance).toBeTypeOf('function');
  });

  it('runs public Cloud prepared updates through the RDF query authority without native SPARQL', async () => {
    await expect(expectPublicCase('update/insert-delete-where')).resolves.toMatchObject({
      caseId: 'update/insert-delete-where',
      status: 'ok',
      canonical: fixtureCase('update/insert-delete-where').expectedCanonical,
    });
  }, 240_000);

  it('enforces source-file ACLs through the public RDF query authority', async () => {
    await expectPublicCase('scope/source-denied');
  }, 240_000);
});

function fixtureCase(id: string): SemanticFixtureCase {
  const fixture = require(fixturePath) as {
    semanticConformanceCases: SemanticFixtureCase[];
  };
  const testCase = fixture.semanticConformanceCases.find((candidate) => candidate.id === id);
  if (!testCase) {
    throw new Error(`missing semantic fixture case ${id}`);
  }
  return testCase;
}

async function expectPublicCase(id: string) {
  const testCase = fixtureCase(id);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-public-semantic-'));
  try {
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: path.join(tempRoot, testCase.id.replaceAll('/', '-')),
      rdfAccelerationProfile: 'pg-hot-operators',
      maintenanceIntervalMs: 0,
    });
    expect(engine.sparqlQuery).toBeUndefined();
    return await runPublicRdfQuerySemanticCase(
      engine,
      testCase,
      120_000,
      `pglite:${testCase.id}`,
    );
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}
