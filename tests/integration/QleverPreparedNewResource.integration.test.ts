import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { createAcceptanceTempDir, qleverAcceptanceGateEnabled, requireAcceptanceEnv } from '../../src/acceptance/QleverSearchConformance';
import { PREPARED_UPDATE_MEDIA_TYPE, parsePreparedUpdateDelta } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { LocalQleverNativeSparqlClient } from '../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';

const { literal, namedNode, quad } = DataFactory;

describe.skipIf(!qleverAcceptanceGateEnabled())('QLever prepared update for a new Pod resource', () => {
  it('preserves quoted JSON literals in prepared graph updates', { timeout: 120_000 }, async () => {
    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const tempRoot = createAcceptanceTempDir('qlever-prepared-json-literal');
    const dbPath = join(tempRoot, 'rdf.sqlite');
    const resourceIri = 'http://localhost:5737/alice/.data/chat/messages.ttl';
    const subjectIri = `${resourceIri}#assistant-1`;
    const predicateIri = 'http://rdfs.org/sioc/ns#richContent';
    const jsonValue = JSON.stringify({ id: 'assistant-1', feedback: 'positive', text: 'say "hello"' });
    const seedEngine = new SolidRdfEngine({ index: { path: dbPath } });
    await seedEngine.open();
    seedEngine.replaceSource([
      quad(namedNode(subjectIri), namedNode(predicateIri), literal('{}'), namedNode(resourceIri)),
    ], { source: resourceIri, workspace: 'http://localhost:5737/alice/' });
    await seedEngine.close();

    const client = new LocalQleverNativeSparqlClient({
      command: runtimeCommand,
      args: ['--sqlite-path', dbPath],
      cwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
      startupTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
      requestTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
    });
    try {
      const escapedJson = jsonValue.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
      const result = await client.query(`
        DELETE { GRAPH <${resourceIri}> { <${subjectIri}> <${predicateIri}> ?old . } }
        INSERT { GRAPH <${resourceIri}> { <${subjectIri}> <${predicateIri}> "${escapedJson}" . } }
        WHERE { GRAPH <${resourceIri}> { <${subjectIri}> <${predicateIri}> ?old . } }
      `, {
        basePath: resourceIri,
        sourceUri: resourceIri,
        operation: 'prepareUpdate',
        acceptMediaType: PREPARED_UPDATE_MEDIA_TYPE,
      });

      expect(result.status, result.error).toBe('ok');
      const delta = parsePreparedUpdateDelta(result.body);
      expect(delta.graphs).toHaveLength(1);
      expect(delta.graphs[0]?.inserts).toHaveLength(1);
      expect(delta.graphs[0]?.inserts[0]?.object.value).toBe(jsonValue);
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('maps INSERT DATA default graph mutations to the writable resource IRI', { timeout: 120_000 }, async () => {
    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const tempRoot = createAcceptanceTempDir('qlever-prepared-new-resource');
    const dbPath = join(tempRoot, 'rdf.sqlite');
    const resourceIri = 'http://localhost:5737/alice/.data/contacts/new-contact.ttl';
    const seedEngine = new SolidRdfEngine({ index: { path: dbPath } });
    await seedEngine.open();
    await seedEngine.close();

    const client = new LocalQleverNativeSparqlClient({
      command: runtimeCommand,
      args: ['--sqlite-path', dbPath],
      cwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
      startupTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
      requestTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
    });
    try {
      const result = await client.query(`INSERT DATA {
        <${resourceIri}> <http://www.w3.org/2006/vcard/ns#fn> "Chat P0 E2E" .
        <${resourceIri}> <https://undefineds.co/ns#favorite> false .
      }`, {
        basePath: resourceIri,
        sourceUri: resourceIri,
        operation: 'prepareUpdate',
        acceptMediaType: PREPARED_UPDATE_MEDIA_TYPE,
      });

      expect(result.status, result.error).toBe('ok');
      expect(result.mediaType).toBe(PREPARED_UPDATE_MEDIA_TYPE);
      expect(parsePreparedUpdateDelta(result.body)).toMatchObject({
        version: 1,
        graphs: [{
          graphIri: resourceIri,
          sourceUri: resourceIri,
          deletes: [],
          inserts: expect.arrayContaining([
            expect.objectContaining({
              subject: expect.objectContaining({ value: resourceIri }),
            }),
          ]),
        }],
      });
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(['graph', 'source', 'both'] as const)('does not widen an absent %s allow-list', { timeout: 120_000 }, async (scope) => {
    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const tempRoot = createAcceptanceTempDir('qlever-missing-exact-scope');
    const dbPath = join(tempRoot, 'rdf.sqlite');
    const podRoot = 'http://localhost:5737/alice/';
    const existingGraph = `${podRoot}settings/existing.ttl`;
    const missingGraph = `${podRoot}settings/ai/config.ttl`;
    const seedEngine = new SolidRdfEngine({ index: { path: dbPath } });
    await seedEngine.open();
    seedEngine.replaceSource([
      quad(
        namedNode(`${existingGraph}#subject`),
        namedNode('https://undefineds.co/ns#label'),
        literal('must not leak'),
        namedNode(existingGraph),
      ),
    ], { source: existingGraph, workspace: podRoot });
    await seedEngine.close();

    const client = new LocalQleverNativeSparqlClient({
      command: runtimeCommand,
      args: ['--sqlite-path', dbPath],
      cwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
      startupTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
      requestTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
    });
    try {
      const unrestricted = await client.query('SELECT ?subject WHERE { GRAPH ?graph { ?subject ?predicate ?object } }', {
        basePath: podRoot,
        operation: 'queryBindings',
        acceptMediaType: 'application/sparql-results+json',
      });
      expect(unrestricted.status, unrestricted.error).toBe('ok');
      expect(JSON.parse(unrestricted.body).results.bindings).toHaveLength(1);

      const result = await client.query(`SELECT ?subject WHERE {
        GRAPH ?graph { ?subject ?predicate ?object }
      }`, {
        basePath: podRoot,
        operation: 'queryBindings',
        acceptMediaType: 'application/sparql-results+json',
        accessScope: {
          basePath: podRoot,
          mode: 'read',
          ...(scope !== 'source' ? { allowedGraphUrls: [missingGraph] } : {}),
          ...(scope !== 'graph' ? { allowedSourceUrls: [missingGraph] } : {}),
        },
      });

      expect(result.status, result.error).toBe('ok');
      expect(JSON.parse(result.body)).toMatchObject({
        results: { bindings: [] },
      });
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
