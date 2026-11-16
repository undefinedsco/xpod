import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { RdfQuadIndex } from '../../../src/storage/rdf/RdfQuadIndex';
import { QleverSparqlEngine } from '../../../src/storage/rdf/QleverSparqlEngine';
import { RdfQuerySparqlEngine } from '../../../src/storage/rdf/RdfQuerySparqlEngine';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import { METADATA_GRAPH_PREFIX } from '../../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;
const POD = 'https://pod.example/alice/';
const CONTAINER = `${POD}agents/key/`;
const META = `${METADATA_GRAPH_PREFIX}${CONTAINER}`;
const DATA = `${POD}agents/data.ttl`;
const NAME = 'http://xmlns.com/foaf/0.1/name';

describe('metadata facet reads on the Cloud/JS engine path', () => {
  it('reads the meta graph through the metadata base and excludes data graphs', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    const engine = new RdfQuerySparqlEngine(rdfEngine);
    await rdfEngine.put([
      quad(namedNode(CONTAINER), namedNode(NAME), literal('Key Agent'), namedNode(META)),
      quad(namedNode(CONTAINER), namedNode(NAME), literal('Data Decoy'), namedNode(DATA)),
    ]);

    const query = `SELECT ?name WHERE { GRAPH <${META}> { <${CONTAINER}> <${NAME}> ?name } }`;
    const stream = await engine.queryMetadataBindings(query, POD);
    const names: string[] = [];
    for await (const binding of stream as AsyncIterable<any>) {
      names.push(binding.get('name')?.value);
    }
    expect(names).toEqual([ 'Key Agent' ]);
    await engine.close();
  });

  it('lists only metadata graphs for the endpoint base', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    const rdfEngine = new SolidRdfEngine({ index });
    await rdfEngine.open();
    const engine = new RdfQuerySparqlEngine(rdfEngine);
    await rdfEngine.put([
      quad(namedNode(CONTAINER), namedNode(NAME), literal('Key Agent'), namedNode(META)),
      quad(namedNode(CONTAINER), namedNode(NAME), literal('Data Decoy'), namedNode(DATA)),
    ]);

    await expect(engine.listMetadataGraphs(POD)).resolves.toEqual(new Set([ META ]));
    await engine.close();
  });
});

describe('native metadata facet options', () => {
  it('sends no base prefix, physical dataset and a finite meta: ACL scope', async () => {
    const calls: any[] = [];
    const engine = new QleverSparqlEngine({
      open: () => undefined,
      close: () => undefined,
      put: () => undefined,
      replaceSource: () => undefined,
      deleteSource: () => 0,
      delete: () => 0,
      applyDelta: () => ({ deletedRows: 0, insertedRows: 0 }),
      scan: () => ({ quads: [], metrics: {} } as any),
      query: () => ({ bindings: [] } as any),
      refreshDerivedIndexes: () => ({}) as any,
      storageStats: () => ({}) as any,
      sparqlQuery: async (query: string, options: any) => {
        calls.push({ query, options });
        return { status: 'ok', mediaType: 'application/sparql-results+json',
          body: JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }) };
      },
    } as any);

    const scope = { basePath: `${METADATA_GRAPH_PREFIX}${POD}`, mode: 'read' as const };
    await engine.queryMetadataBindings(
      `SELECT ?name WHERE { GRAPH <${META}> { ?s <${NAME}> ?name } }`,
      POD,
      scope,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].options.basePath).toBe('');
    expect(calls[0].options.defaultDataset).toBe('physical');
    expect(calls[0].options.accessScope.basePath).toBe(`${METADATA_GRAPH_PREFIX}${POD}`);
    await expect(engine.queryMetadataBindings('SELECT * WHERE { ?s ?p ?o }', POD))
      .rejects.toThrow(/finite meta: access scope/);
  });
});
