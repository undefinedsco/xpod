import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { loginWithClientCredentials, setupAccount, type AccountSetup, type ClientCredentialsSolidSession } from './helpers/solidAccount';

const run = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = run ? describe : describe.skip;
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const SUCCESS = new Set([ 200, 201, 202, 204, 205, 207 ]);

function assertSuccess(response: Response, step: string): void {
  if (!SUCCESS.has(response.status)) {
    throw new Error(`${step} failed with ${response.status}`);
  }
}

suite('Explicit metadata graph reads on a real self-boot Xpod/Pod', () => {
  const stack = new XpodTestStack();
  let runtimeRoot: string | undefined;
  let baseUrl: string;
  let account: AccountSetup;
  let session: ClientCredentialsSolidSession;
  let containerUrl: string;
  let metadataUrl: string;

  beforeAll(async () => {
    runtimeRoot = await mkdtemp(path.resolve('.test-data/explicit-metadata-read-'));
    await stack.start('local', {
      transport: 'port', open: false, apiOpen: false, logLevel: 'error', runtimeRoot,
    });
    baseUrl = stack.baseUrl;
    const created = await setupAccount(baseUrl, 'metadata-read');
    expect(created, 'account/Pod creation must succeed').not.toBeNull();
    account = created!;
    session = await loginWithClientCredentials(account);

    containerUrl = new URL(`agents/${randomUUID()}/`, account.podUrl).href;
    metadataUrl = `${containerUrl}.meta`;
    const createContainer = await session.fetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'If-None-Match': '*',
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    assertSuccess(createContainer, 'create agent container');

    const patchDate = await session.fetch(metadataUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { <${containerUrl}> <${FOAF_NAME}> "Key Agent" }`,
    });
    assertSuccess(patchDate, 'patch container metadata');
  }, 120_000);

  afterAll(async () => {
    await stack.stop();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  }, 60_000);

  it('returns the Agent name through an explicit metadata graph read', async () => {
    const query = `SELECT ?name WHERE { GRAPH <meta:${containerUrl}> { <${containerUrl}> <${FOAF_NAME}> ?name } }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', query);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    expect(json.results.bindings.map((row) => row.name?.value)).toContain('Key Agent');
  }, 60_000);

  it('discovers the facet through a bounded metadata graph-variable collection query', async () => {
    // The endpoint is /agents/-/sparql, so the bounded namespace is meta:<pod>/agents/.
    const agentsBase = new URL('agents/', account.podUrl).href;
    const query = `SELECT ?resource ?metadataGraph ?name WHERE { GRAPH ?metadataGraph { ?resource <${FOAF_NAME}> ?name } FILTER(STRSTARTS(STR(?metadataGraph), "meta:${agentsBase}")) FILTER(STR(?resource) = STRAFTER(STR(?metadataGraph), "meta:")) }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', query);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    const names = json.results.bindings
      .filter((row) => row.resource?.value === containerUrl)
      .map((row) => row.name?.value);
    expect(names).toContain('Key Agent');
  }, 60_000);

  it('keeps ordinary un-named data queries unchanged', async () => {
    const query = `SELECT ?name WHERE { ?s <${FOAF_NAME}> ?name }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', query);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    // The metadata-only name must not leak into the ordinary data namespace.
    expect(json.results.bindings.map((row) => row.name?.value)).not.toContain('Key Agent');
  }, 60_000);

  it('reads binary resource metadata through an explicit graph and keeps modified managed on write', async () => {
    const binaryUrl = new URL('image.png', containerUrl).href;
    const binary = await session.fetch(binaryUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
      body: 'not-an-image',
    });
    assertSuccess(binary, 'write binary');

    const query = `SELECT ?p ?o WHERE { GRAPH <meta:${binaryUrl}> { <${binaryUrl}> ?p ?o } }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', query);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    const predicates = json.results.bindings.map((row) => row.p?.value);
    expect(predicates).toContain('http://www.w3.org/ns/ma-ont#format');

    const modifiedPatch = await session.fetch(`${binaryUrl}.meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { <${binaryUrl}> <http://purl.org/dc/terms/modified> "2020-01-01T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> }`,
    });
    expect(modifiedPatch.status, 'CSS managed dcterms:modified must stay protected').toBe(409);
  }, 60_000);

  it('keeps SPARQL metadata writes closed', async () => {
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    const response = await session.fetch(endpoint.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { GRAPH <meta:${containerUrl}> { <${containerUrl}> <${FOAF_NAME}> "Leak" } }`,
      signal: AbortSignal.timeout(20_000),
    });
    expect([ 400, 403, 405 ]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain('Leak');
  }, 60_000);

  it('denies a child ACL override and keeps cross-Pod metadata graphs out of scope', async () => {
    const other = await setupAccount(baseUrl, 'metadata-other');
    expect(other).not.toBeNull();
    const otherSession = await loginWithClientCredentials(other!);

    const privateChild = new URL(`private-${randomUUID()}/`, containerUrl).href;
    const created = await session.fetch(privateChild, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle', 'If-None-Match': '*',
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    assertSuccess(created, 'create private child');
    const acr = await session.fetch(`${privateChild}.acr`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n@prefix acp: <http://www.w3.org/ns/solid/acp#>.\n<#acr> a acp:AccessControlResource; acp:resource <${privateChild}>; acp:accessControl <#owner>; acp:memberAccessControl <#owner>.\n<#owner> a acp:AccessControl; acp:apply [ a acp:Policy; acp:allow acl:Read, acl:Write, acl:Append, acl:Control; acp:anyOf [ a acp:Matcher; acp:agent <${account.webId}> ] ].`,
    });
    assertSuccess(acr, 'write child ACR');
    const patched = await session.fetch(`${privateChild}.meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { <${privateChild}> <${FOAF_NAME}> "Private Agent" }`,
    });
    assertSuccess(patched, 'patch private child metadata');

    const privateQuery = `SELECT ?name WHERE { GRAPH <meta:${privateChild}> { <${privateChild}> <${FOAF_NAME}> ?name } }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', privateQuery);
    const denied = await otherSession.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    if (denied.status === 200) {
      const json = await denied.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
      expect(json.results.bindings.map((row) => row.name?.value)).not.toContain('Private Agent');
    } else {
      expect([ 401, 403, 404 ]).toContain(denied.status);
    }

    const owner = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(owner.status, await owner.clone().text()).toBe(200);
    const ownerJson = await owner.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    expect(ownerJson.results.bindings.map((row) => row.name?.value)).toContain('Private Agent');

    const crossPodQuery = `SELECT ?name WHERE { GRAPH <meta:${other!.podUrl}agents/x/> { ?s <${FOAF_NAME}> ?name } }`;
    const crossEndpoint = new URL('agents/-/sparql', account.podUrl);
    crossEndpoint.searchParams.set('query', crossPodQuery);
    const cross = await session.fetch(crossEndpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(cross.status).toBe(400);
  }, 120_000);

  it('serves a child .meta from its own read while a sibling denial cannot leak', async () => {
    const childUrl = new URL('child/', containerUrl).href;
    const created = await session.fetch(childUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle', 'If-None-Match': '*',
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    assertSuccess(created, 'create child container');
    const patched = await session.fetch(`${childUrl}.meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { <${childUrl}> <${FOAF_NAME}> "Child Agent" }`,
    });
    assertSuccess(patched, 'patch child metadata');

    const query = `SELECT ?name WHERE { GRAPH <meta:${childUrl}> { <${childUrl}> <${FOAF_NAME}> ?name } }`;
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', query);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(20_000) });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    expect(json.results.bindings.map((row) => row.name?.value)).toContain('Child Agent');
  }, 60_000);
});
