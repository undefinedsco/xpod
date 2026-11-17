/**
 * Real-engine regressions for the metadata collection ownership contract.
 *
 * P2 review finding: a filter inside one UNION/OPTIONAL branch must not satisfy
 * the global ownership check, because it constrains only that branch. A foreign
 * "about own" triple that sorts first must never turn LIMIT 1 into a wrong empty
 * answer. Grouped aggregates must stay legal (no ungrouped projection) while the
 * correlation and the authorized-graph snapshot still apply before GROUP BY.
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
const BASE = 'http://pod.example/alice/agents/';
const OWN = `${BASE}a/`;
const OTHER = `${BASE}b/`;
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const NAME = 'http://xmlns.com/foaf/0.1/name';

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

async function createHarness(): Promise<{
  handle(query: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}> {
  const index = new RdfQuadIndex({ path: ':memory:' });
  const rdfEngine = new SolidRdfEngine({ index });
  await rdfEngine.open();
  // Own facet for a/ ; a foreign facet (graph of b/) that also describes a/ and
  // sorts before the own row. This is the exact reviewer counterexample.
  await rdfEngine.put([
    quad(namedNode(OWN), namedNode(TYPE), namedNode(AGENT), namedNode(`meta:${OWN}`)),
    quad(namedNode(OWN), namedNode(NAME), literal('ZZZ Own'), namedNode(`meta:${OWN}`)),
    quad(namedNode(OWN), namedNode(TYPE), namedNode(AGENT), namedNode(`meta:${OTHER}`)),
    quad(namedNode(OWN), namedNode(NAME), literal('AAAA foreign about own'), namedNode(`meta:${OTHER}`)),
  ]);
  const engine = new SubgraphQueryEngine(new RdfQuerySparqlEngine(rdfEngine));
  const handler = new SubgraphSparqlHttpHandler(
    engine as any,
    { handleSafe: async () => ({ agent: { webId: 'https://id.example/alice#me' } }) } as any,
    { handleSafe: async () => new IdentifierSetMultiMap() } as any,
    { handleSafe: async () => undefined } as any,
    {},
  );
  return {
    async handle(query: string) {
      const response = createResponse();
      await handler.handle({ request: createRequest(`/alice/agents/-/sparql?query=${encodeURIComponent(query)}`), response } as any);
      return { status: response.statusCode, body: response.body().replace(/\s+/g, ' ') };
    },
    close: () => rdfEngine.close(),
  };
}

const names = (body: string): string[] =>
  JSON.parse(body).results.bindings.map((row: any) => row.name?.value);

describe('metadata collection ownership is query-level', () => {
  it('rejects a UNION whose ownership filter constrains only one branch', async () => {
    const harness = await createHarness();
    try {
      const union = `SELECT ?subject ?metadataGraph ?name WHERE {
        GRAPH ?metadataGraph {
          { ?subject <${TYPE}> <${AGENT}>; <${NAME}> ?name }
          UNION
          { ?subject <${TYPE}> <${AGENT}>; <${NAME}> ?name
            FILTER(STR(?subject) = STRAFTER(STR(?metadataGraph), "meta:")) }
        }
        FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}"))
      } ORDER BY ?name LIMIT 1`;
      const response = await harness.handle(union);
      expect(response.status, response.body).toBe(400);
      expect(response.body).toContain('STRAFTER');
    } finally {
      await harness.close();
    }
  });

  it('never lets a foreign about-own triple win LIMIT 1 over the own facet', async () => {
    const harness = await createHarness();
    try {
      const canonical = `SELECT ?subject ?metadataGraph ?name WHERE {
        GRAPH ?metadataGraph { ?subject <${TYPE}> <${AGENT}>; <${NAME}> ?name }
        FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}"))
        FILTER(STR(?subject) = STRAFTER(STR(?metadataGraph), "meta:"))
      } ORDER BY ?name LIMIT 1`;
      const response = await harness.handle(canonical);
      expect(response.status, response.body).toBe(200);
      expect(names(response.body)).toEqual([ 'ZZZ Own' ]);
    } finally {
      await harness.close();
    }
  });

  it('keeps the alpha-renamed canonical shape equivalent', async () => {
    const harness = await createHarness();
    try {
      const renamed = `SELECT ?res ?g ?label WHERE {
        GRAPH ?g { ?res <${TYPE}> <${AGENT}>; <${NAME}> ?label }
        FILTER(STRSTARTS(STR(?g), "meta:${BASE}"))
        FILTER(STR(?res) = STRAFTER(STR(?g), "meta:"))
      } ORDER BY ?label LIMIT 1`;
      const response = await harness.handle(renamed);
      expect(response.status, response.body).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.results.bindings.map((row: any) => row.label.value)).toEqual([ 'ZZZ Own' ]);
      expect(payload.results.bindings[0].g.value).toBe(`meta:${OWN}`);
    } finally {
      await harness.close();
    }
  });

  it('accepts a grouped aggregate without projecting graph or subject', async () => {
    const harness = await createHarness();
    try {
      const aggregate = `SELECT ?name (COUNT(?name) AS ?total) WHERE {
        GRAPH ?metadataGraph { ?subject <${TYPE}> <${AGENT}>; <${NAME}> ?name }
        FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}"))
        FILTER(STR(?subject) = STRAFTER(STR(?metadataGraph), "meta:"))
      } GROUP BY ?name`;
      const response = await harness.handle(aggregate);
      expect(response.status, response.body).toBe(200);
      const payload = JSON.parse(response.body);
      // Only the own facet is aggregated; the foreign about-own row is excluded by
      // the WHERE-level correlation, before GROUP BY.
      expect(payload.results.bindings.map((row: any) => [ row.name.value, row.total.value ])).toEqual([ [ 'ZZZ Own', '1' ] ]);
    } finally {
      await harness.close();
    }
  });

  it('rejects an aggregate that drops the correlation', async () => {
    const harness = await createHarness();
    try {
      const uncorrelated = `SELECT ?name (COUNT(?name) AS ?total) WHERE {
        GRAPH ?metadataGraph { ?subject <${TYPE}> <${AGENT}>; <${NAME}> ?name }
        FILTER(STRSTARTS(STR(?metadataGraph), "meta:${BASE}"))
      } GROUP BY ?name`;
      const response = await harness.handle(uncorrelated);
      expect(response.status, response.body).toBe(400);
    } finally {
      await harness.close();
    }
  });
});
