import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { Parser } from 'n3';
import { config as loadEnv } from 'dotenv';
import { resolveSolidIntegrationConfig } from './utils/integrationEnv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const { baseUrl, oidcIssuer, webId } = resolveSolidIntegrationConfig();
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret && webId;
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Subgraph SPARQL endpoint integration (/-/sparql)', () => {
  let session: Session;
  let authFetch: typeof fetch;
  let podBase: string;
  let testContainer: string;
  let testResource: string;

  const parseStorageFromLink = (linkValue: string | null): string | undefined => {
    if (!linkValue) return undefined;
    const parts = linkValue.split(',');
    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/pim\/space#storage"/);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  };

  async function resolvePodBase(): Promise<string> {
    // Try Link header from HEAD first
    const headRes = await session.fetch(webId!, { method: 'HEAD' }).catch(() => undefined);
    if (headRes && headRes.ok) {
      const linkStorage = parseStorageFromLink(headRes.headers.get('link'));
      if (linkStorage) {
        return linkStorage.endsWith('/') ? linkStorage : `${linkStorage}/`;
      }
    }

    // Fallback to GET profile
    const res = await session.fetch(webId!, {
      headers: { accept: 'text/turtle' },
    });
    if (!res.ok) {
      throw new Error(`fetch webid failed with status ${res.status}`);
    }
    const body = await res.text();
    const quads = new Parser().parse(body);
    const storage = quads.find((q) => q.subject.value === webId && q.predicate.value === 'http://www.w3.org/ns/pim/space#storage');
    if (storage) {
      return storage.object.value.endsWith('/') ? storage.object.value : `${storage.object.value}/`;
    }

    // Fallback: derive from WebID
    const webIdUrl = new URL(webId!);
    const pathParts = webIdUrl.pathname.split('/');
    if (pathParts.length >= 2) {
      return `${webIdUrl.origin}/${pathParts[1]}/`;
    }

    throw new Error('Cannot resolve pod base from WebID');
  }

  beforeAll(async () => {
    // Check server is running
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && ![401, 404, 405].includes(health.status)) {
        throw new Error(`Server responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach server at ${baseUrl}. Start it with "yarn local" first. Details: ${message}`);
    }

    // Setup authenticated fetch via OIDC
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType,
    });
    authFetch = session.fetch.bind(session);

    // Resolve pod base from WebID
    podBase = await resolvePodBase();
    testContainer = joinUrl(podBase, `sparql-test-${Date.now()}/`);
    testResource = joinUrl(testContainer, 'data.ttl');

    // Create test container
    const createContainer = await authFetch(testContainer, {
      method: 'PUT',
      headers: {
        'content-type': 'text/turtle',
        'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    if (![200, 201, 205].includes(createContainer.status)) {
      const body = await createContainer.text();
      console.error(`Failed to create container: ${createContainer.status} - ${body.slice(0, 300)}`);
    }
    expect([200, 201, 205].includes(createContainer.status)).toBe(true);

    // Create test resource with RDF data
    const createResource = await authFetch(testResource, {
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
    await authFetch?.(testResource, { method: 'DELETE' }).catch(() => {});
    await authFetch?.(testContainer, { method: 'DELETE' }).catch(() => {});
    await session?.logout();
  });

  describe('URL routing (/-/sparql)', () => {
    it('should accept container sidecar endpoint /-/sparql', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/sparql-results+json');
    });

    it('should accept nested path sidecar endpoint', async () => {
      // /sparql-test-xxx/data.ttl → query via /sparql-test-xxx/-/sparql scoped to container
      const sparqlUrl = testContainer + '-/sparql';
      const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/sparql-results+json');
    });
  });

  describe('SELECT queries', () => {
    it('should return SPARQL results JSON', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name ?name }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.head.vars).toContain('name');
      expect(json.results.bindings.length).toBeGreaterThan(0);

      const names = json.results.bindings.map((b: any) => b.name.value);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
    });

    it('should scope queries to container path', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      // Query for data that doesn't exist in this specific container
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name "NonExistent" }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.results.bindings.length).toBe(0);
    });
  });

  describe('ASK queries', () => {
    it('should return boolean for ASK via GET', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        ASK { ?s foaf:name "Alice" }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.boolean).toBe(true);
    });

    it('should return boolean for ASK via POST', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        ASK { ?s foaf:name "Alice" }
      `;

      const response = await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-query' },
        body: query,
      });
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.boolean).toBe(true);
    });

    it('should handle ASK with LIMIT (strip limit to avoid Comunica crash)', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        ASK { ?s foaf:name "Alice" } LIMIT 1
      `;

      const response = await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-query' },
        body: query,
      });
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.boolean).toBe(true);
    });
  });

  describe('CONSTRUCT queries', () => {
    it('should return N-Quads for CONSTRUCT', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        CONSTRUCT { ?s foaf:name ?name } WHERE { ?s foaf:name ?name }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/n-quads');

      const nquads = await response.text();
      expect(nquads).toContain('Alice');
      expect(nquads).toContain('Bob');
    });
  });

  describe('SPARQL UPDATE', () => {
    it('should INSERT data via POST', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const update = `
        PREFIX ex: <http://example.org/>
        INSERT DATA { GRAPH <${testResource}> { <#charlie> ex:name "Charlie" } }
      `;

      const response = await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: update,
      });
      expect(response.status).toBe(204);

      // Verify the insert via ASK on Sidecar (can't verify via LDP GET as this goes to sidecar graph if not persisted to main LDP graph by rewrite logic)
      // Actually, since we reverted rewrite logic, this INSERT goes to the Named Graph <testResource> which IS the LDP resource graph.
      // So it SHOULD be visible via LDP GET if quadstore works correctly.
      
      const ldpResponse = await authFetch(testResource, {
        method: 'GET',
        headers: { 'accept': 'text/turtle' },
      });
      expect(ldpResponse.status).toBe(200);
      expect(await ldpResponse.text()).toContain("Charlie");
    });

    it('should DELETE data via POST', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      // First insert something to delete
      const insertUpdate = `
        PREFIX ex: <http://example.org/>
        INSERT DATA { GRAPH <${testResource}> { <#toDelete> ex:temp "temp" } }
      `;
      await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: insertUpdate,
      });

      // Now delete it
      const deleteUpdate = `
        PREFIX ex: <http://example.org/>
        DELETE DATA { GRAPH <${testResource}> { <#toDelete> ex:temp "temp" } }
      `;
      const response = await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: deleteUpdate,
      });
      expect(response.status).toBe(204);

      // Verify deletion
      const ldpResponse = await authFetch(testResource, {
        method: 'GET',
        headers: { 'accept': 'text/turtle' },
      });
      expect(ldpResponse.status).toBe(200);
      expect(await ldpResponse.text()).not.toContain("temp");
    });
  });

  describe('Container aggregation', () => {
    it('should query across all resources in container', async () => {
      // Create another resource in the container
      const anotherResource = joinUrl(testContainer, 'more.ttl');
      await authFetch(anotherResource, {
        method: 'PUT',
        headers: { 'content-type': 'text/turtle' },
        body: `
          @prefix foaf: <http://xmlns.com/foaf/0.1/> .
          <#eve> a foaf:Person ; foaf:name "Eve" .
        `,
      });

      // Query the container sidecar endpoint
      const sparqlUrl = testContainer + '-/sparql';
      const query = `
        PREFIX foaf: <http://xmlns.com/foaf/0.1/>
        SELECT ?name WHERE { ?s foaf:name ?name }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      const names = json.results.bindings.map((b: any) => b.name.value);

      // Should find names from both resources
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
      expect(names).toContain('Eve');

      // Cleanup
      await authFetch(anotherResource, { method: 'DELETE' }).catch(() => {});
    });

    it('should include metadata graphs (meta:*) in container scope', async () => {
      // Create a binary file (which generates metadata in meta: graph)
      const binaryResource = joinUrl(testContainer, 'image.png');
      await authFetch(binaryResource, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: 'fake-image',
      });

      // Query the metadata graph directly
      const sparqlUrl = testContainer + '-/sparql';
      const metaGraph = `meta:${binaryResource}`;
      const query = `
        SELECT ?p ?o WHERE {
          GRAPH <${metaGraph}> { <${binaryResource}> ?p ?o }
        }
      `;

      const response = await authFetch(`${sparqlUrl}?query=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);

      const json = await response.json();
      const predicates = json.results.bindings.map((b: any) => b.p.value);

      // Should have metadata like content-type, modified date, etc.
      expect(predicates.length).toBeGreaterThan(0);
      expect(predicates).toContain('http://www.w3.org/ns/ma-ont#format');

      // Cleanup
      await authFetch(binaryResource, { method: 'DELETE' }).catch(() => {});
    });
  });

  describe('Subgraph isolation', () => {
    it('should reject queries targeting graphs outside scope', async () => {
      const sparqlUrl = testContainer + '-/sparql';
      const update = `
        INSERT DATA { GRAPH <http://evil.example.org/data> { <#x> <#y> <#z> } }
      `;

      const response = await authFetch(sparqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: update,
      });

      // Should be rejected (400 Bad Request)
      expect(response.status).toBe(400);
    });
  });
});