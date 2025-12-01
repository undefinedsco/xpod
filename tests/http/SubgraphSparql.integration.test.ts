import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.dev' });

const baseUrl = process.env.XPOD_DEV_BASE_URL ?? 'http://localhost:3000/';

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

const shouldRunIntegration = process.env.XPOD_RUN_SPARQL_TESTS === 'true';
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Subgraph SPARQL endpoint integration', () => {
  const testContainer = joinUrl(baseUrl, `sparql-test-${Date.now()}/`);
  const testResource = joinUrl(testContainer, 'data.ttl');

  beforeAll(async () => {
    // Check server is running
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && ![401, 404, 405].includes(health.status)) {
        throw new Error(`Server responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach server at ${baseUrl}. Start it with "yarn dev" first. Details: ${message}`);
    }

    // Create test container
    const createContainer = await fetch(testContainer, {
      method: 'PUT',
      headers: {
        'content-type': 'text/turtle',
        'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    expect([200, 201, 205].includes(createContainer.status)).toBe(true);

    // Create test resource with RDF data
    const createResource = await fetch(testResource, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: `
        @prefix ex: <http://example.org/> .
        @prefix foaf: <http://xmlns.com/foaf/0.1/> .

        <#alice> a foaf:Person ;
          foaf:name "Alice" ;
          ex:age 30 .

        <#bob> a foaf:Person ;
          foaf:name "Bob" ;
          ex:age 25 .
      `,
    });
    expect([200, 201, 205].includes(createResource.status)).toBe(true);
  });

  afterAll(async () => {
    // Cleanup - delete test resource and container
    await fetch(testResource, { method: 'DELETE' }).catch(() => {});
    await fetch(testContainer, { method: 'DELETE' }).catch(() => {});
  });

  describe('URL routing', () => {
    it('should accept container endpoint /sparql', async () => {
      const sparqlUrl = testContainer + 'sparql';
      const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/sparql-results+json');
    });

    it('should accept resource endpoint .sparql', async () => {
      const sparqlUrl = testResource + '.sparql';
      const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/sparql-results+json');
    });
  });

  describe('SELECT queries', () => {
    it('should return SPARQL results JSON', async () => {
      const sparqlUrl = testResource + '.sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name ?name }
      `;

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.head.vars).toContain('name');
      expect(json.results.bindings.length).toBeGreaterThan(0);

      const names = json.results.bindings.map((b: any) => b.name.value);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
    });

    it('should scope queries to resource graph', async () => {
      const sparqlUrl = testResource + '.sparql';
      // Query for data that doesn't exist in this specific resource
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name "NonExistent" }
      `;

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.results.bindings.length).toBe(0);
    });
  });

  describe('ASK queries', () => {
    it('should return boolean for ASK', async () => {
      const sparqlUrl = testResource + '.sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        ASK { ?s foaf:name "Alice" }
      `;

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.boolean).toBe(true);
    });
  });

  describe('CONSTRUCT queries', () => {
    it('should return N-Quads for CONSTRUCT', async () => {
      const sparqlUrl = testResource + '.sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        CONSTRUCT { ?s foaf:name ?name } WHERE { ?s foaf:name ?name }
      `;

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/n-quads');

      const nquads = await response.text();
      expect(nquads).toContain('Alice');
      expect(nquads).toContain('Bob');
    });
  });

  describe('SPARQL UPDATE', () => {
    it('should INSERT data via POST', async () => {
      const sparqlUrl = testResource + '.sparql';
      const update = `
        PREFIX ex: <http://example.org/>
        INSERT DATA { <#charlie> ex:name "Charlie" }
      `;

      const response = await fetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: update,
      });
      expect(response.status).toBe(204);

      // Verify the insert
      const verifyQuery = 'PREFIX ex: <http://example.org/> ASK { <#charlie> ex:name "Charlie" }';
      const verifyResponse = await fetch(`${sparqlUrl}?query=${encodeURIComponent(verifyQuery)}`);
      const verifyJson = await verifyResponse.json();
      expect(verifyJson.boolean).toBe(true);
    });

    it('should DELETE data via POST', async () => {
      const sparqlUrl = testResource + '.sparql';
      // First insert something to delete
      const insertUpdate = `
        PREFIX ex: <http://example.org/>
        INSERT DATA { <#toDelete> ex:temp "temp" }
      `;
      await fetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: insertUpdate,
      });

      // Now delete it
      const deleteUpdate = `
        PREFIX ex: <http://example.org/>
        DELETE DATA { <#toDelete> ex:temp "temp" }
      `;
      const response = await fetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: deleteUpdate,
      });
      expect(response.status).toBe(204);

      // Verify deletion
      const verifyQuery = 'PREFIX ex: <http://example.org/> ASK { <#toDelete> ex:temp "temp" }';
      const verifyResponse = await fetch(`${sparqlUrl}?query=${encodeURIComponent(verifyQuery)}`);
      const verifyJson = await verifyResponse.json();
      expect(verifyJson.boolean).toBe(false);
    });
  });

  describe('Container aggregation', () => {
    it('should query across all resources in container', async () => {
      // Create another resource in the container
      const anotherResource = joinUrl(testContainer, 'more.ttl');
      await fetch(anotherResource, {
        method: 'PUT',
        headers: { 'content-type': 'text/turtle' },
        body: `
          @prefix foaf: <http://xmlns.com/foaf/0.1/> .
          <#eve> a foaf:Person ; foaf:name "Eve" .
        `,
      });

      // Query the container endpoint
      const sparqlUrl = testContainer + 'sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name ?name }
      `;

      const response = await fetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      const names = json.results.bindings.map((b: any) => b.name.value);

      // Should find names from both resources
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
      expect(names).toContain('Eve');

      // Cleanup
      await fetch(anotherResource, { method: 'DELETE' }).catch(() => {});
    });
  });

  describe('Subgraph isolation', () => {
    it('should reject queries targeting graphs outside scope', async () => {
      const sparqlUrl = testResource + '.sparql';
      const update = `
        INSERT DATA { GRAPH <http://evil.example.org/data> { <#x> <#y> <#z> } }
      `;

      const response = await fetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: update,
      });

      // Should be rejected (400 Bad Request)
      expect(response.status).toBe(400);
    });
  });
});
