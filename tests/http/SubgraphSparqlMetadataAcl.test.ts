/**
 * Real-engine ACL regressions for the metadata read path (P1 review finding).
 *
 * Unlike the vi.fn engine tests, these run the real RdfQuerySparqlEngine over a
 * real RdfQuadIndex with a real authorizer, so a widened accessScope predicate
 * actually changes the result. ASK/CONSTRUCT/nested SELECT/variable GRAPH must
 * not become a metadata side channel; the explicit metadata SELECT must still
 * enforce per-subject authorization.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { IdentifierSetMultiMap } from '@solid/community-server';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { SubgraphQueryEngine } from '../../src/storage/sparql/SubgraphQueryEngine';
import { RdfQuadIndex } from '../../src/storage/rdf/RdfQuadIndex';
import { RdfQuerySparqlEngine } from '../../src/storage/rdf/RdfQuerySparqlEngine';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';

const { namedNode, literal, quad } = DataFactory;
const POD = 'http://pod.example/alice/';
const PUBLIC_DOC = `${POD}notes/public.ttl`;
const RESTRICTED = `${POD}agents/restricted/`;
const RESTRICTED_META = `meta:${RESTRICTED}`;
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const NAME = 'http://xmlns.com/foaf/0.1/name';
const SELF = 'http://pod.example/alice/agents/own/';

function createRequest(url: string): any {
  return { url, method: 'GET', headers: { host: 'pod.example' }, setEncoding() {}, on() {} };
}

function createResponse(): any {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return Object.assign(writable, {
    statusCode: 200, setHeader() {}, getHeader() {}, removeHeader() {}, hasHeader() {},
    headersSent: false, sendDate: true, getHeaderNames: () => [], getHeaders: () => ({}),
    flushHeaders() {}, writeHead() {}, body: () => Buffer.concat(chunks).toString('utf8'),
  });
}

/** Real engine + real authorizer that denies Read on the restricted child. */
async function createHarness(deny: (path: string) => boolean): Promise<{
  handle(query: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}> {
  const index = new RdfQuadIndex({ path: ':memory:' });
  const rdfEngine = new SolidRdfEngine({ index });
  await rdfEngine.open();
  await rdfEngine.put([
    quad(namedNode(PUBLIC_DOC), namedNode(NAME), literal('PUBLIC'), namedNode(PUBLIC_DOC)),
    quad(namedNode(RESTRICTED), namedNode(NAME), literal('RESTRICTED SECRET'), namedNode(RESTRICTED_META)),
    quad(namedNode(SELF), namedNode(TYPE), namedNode(AGENT), namedNode(`meta:${SELF}`)),
    quad(namedNode(SELF), namedNode(NAME), literal('Own Agent'), namedNode(`meta:${SELF}`)),
  ]);
  const engine = new SubgraphQueryEngine(new RdfQuerySparqlEngine(rdfEngine));
  const handler = new SubgraphSparqlHttpHandler(
    engine as any,
    { handleSafe: async () => ({ agent: { webId: 'https://id.example/bob#me' } }) } as any,
    { handleSafe: async () => new IdentifierSetMultiMap() } as any,
    {
      handleSafe: async ({ requestedModes }: any) => {
        const identifier = [ ...requestedModes.keys() ][0] as any;
        if (deny(identifier?.path ?? '')) {
          throw new Error('child ACR denies Read');
        }
      },
    } as any,
    {},
  );
  return {
    async handle(query: string) {
      const response = createResponse();
      await handler.handle({ request: createRequest(`/alice/-/sparql?query=${encodeURIComponent(query)}`), response } as any);
      return { status: response.statusCode, body: response.body().replace(/\s+/g, ' ') };
    },
    close: () => rdfEngine.close(),
  };
}

describe('metadata facets are not readable through ordinary query shapes', () => {
  it('fails closed for ASK / CONSTRUCT / nested SELECT / variable GRAPH over a denied facet', async () => {
    const harness = await createHarness((path) => path === RESTRICTED);
    try {
      const ask = await harness.handle(`ASK { GRAPH <${RESTRICTED_META}> { <${RESTRICTED}> <${NAME}> "RESTRICTED SECRET" } }`);
      expect(ask.status, ask.body).toBe(400);
      expect(ask.body).not.toContain('RESTRICTED SECRET');

      const construct = await harness.handle(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${RESTRICTED_META}> { ?s ?p ?o } }`);
      expect(construct.status, construct.body).toBe(400);
      expect(construct.body).not.toContain('RESTRICTED SECRET');

      const nested = await harness.handle(`SELECT ?name WHERE { { SELECT ?name WHERE { GRAPH <${RESTRICTED_META}> { <${RESTRICTED}> <${NAME}> ?name } } } }`);
      expect(nested.status, nested.body).toBe(400);
      expect(nested.body).not.toContain('RESTRICTED SECRET');

      const variable = await harness.handle(`SELECT ?g ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`);
      expect(variable.status, variable.body).toBe(200);
      expect(variable.body).not.toContain('RESTRICTED SECRET');
      const graphs = JSON.parse(variable.body).results.bindings.map((row: any) => row.g.value);
      expect(graphs).toEqual([ PUBLIC_DOC ]);
    } finally {
      await harness.close();
    }
  });

  it('still authorizes the explicit metadata SELECT per subject and allows the readable one', async () => {
    const harness = await createHarness((path) => path === RESTRICTED);
    try {
      const denied = await harness.handle(`SELECT ?name WHERE { GRAPH <${RESTRICTED_META}> { <${RESTRICTED}> <${NAME}> ?name } }`);
      expect(denied.status, denied.body).toBe(200);
      expect(JSON.parse(denied.body).results.bindings).toEqual([]);

      const own = await harness.handle(`SELECT ?name WHERE { GRAPH <meta:${SELF}> { <${SELF}> <${NAME}> ?name } }`);
      expect(own.status, own.body).toBe(200);
      expect(JSON.parse(own.body).results.bindings).toEqual([
        expect.objectContaining({ name: expect.objectContaining({ value: 'Own Agent' }) }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it('keeps ordinary data reads unaffected by the metadata guard', async () => {
    const harness = await createHarness(() => false);
    try {
      // The ordinary read axis is unchanged: data graphs remain readable and no
      // metadata facet can join the result set.
      const ordinary = await harness.handle(`SELECT ?g ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`);
      expect(ordinary.status, ordinary.body).toBe(200);
      expect(ordinary.body).not.toContain('RESTRICTED SECRET');
      expect(JSON.parse(ordinary.body).results.bindings.map((row: any) => row.g.value)).toEqual([ PUBLIC_DOC ]);

      const namedGraph = await harness.handle(`SELECT ?name WHERE { GRAPH <${PUBLIC_DOC}> { <${PUBLIC_DOC}> <${NAME}> ?name } }`);
      expect(namedGraph.status, namedGraph.body).toBe(200);
      expect(JSON.parse(namedGraph.body).results.bindings).toEqual([
        expect.objectContaining({ name: expect.objectContaining({ value: 'PUBLIC' }) }),
      ]);
    } finally {
      await harness.close();
    }
  });
});
