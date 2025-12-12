import { beforeAll, describe, expect, it } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';
import { resolvePodBase } from './utils/pod';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const webId = process.env.SOLID_WEBID;
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret && oidcIssuer && webId;
const suite = shouldRun ? describe : describe.skip;

const SUCCESS = new Set([ 200, 201, 202, 204, 205, 207 ]);

async function assertSuccess(response: Response, step: string): Promise<void> {
  if (!SUCCESS.has(response.status)) {
    const text = await response.clone().text();
    throw new Error(`${step} failed with status ${response.status}: ${text}`);
  }
}

suite('SPARQL UPDATE literal delete/insert', () => {
  let podBase: string;
  let containerUrl: string;
  let resourceUrl: string;
  let graph: string;
  let session: Session;
  let doFetch: typeof fetch;

  beforeAll(async () => {
    session = new Session();
    await session.login({ clientId: clientId!, clientSecret: clientSecret!, oidcIssuer, tokenType });
    doFetch = session.fetch.bind(session);

    podBase = await resolvePodBase(doFetch, webId!, assertSuccess, oidcIssuer);
    containerUrl = new URL('drizzle-tests/', podBase).toString();
    resourceUrl = new URL('literal-delete-sparql.ttl', containerUrl).toString();
    graph = resourceUrl;

    // ensure container exists
    const headContainer = await doFetch(containerUrl, { method: 'HEAD' });
    if (headContainer.status === 404) {
      const createContainer = await doFetch(containerUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'text/turtle',
          'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
      await assertSuccess(createContainer, 'create container');
    } else {
      await assertSuccess(headContainer, 'check container');
    }
  });

  it('deletes canonical literal and inserts new value with GRAPH', async () => {
    // seed
    await assertSuccess(await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '<> <https://schema.org/age> 20 .',
    }), 'seed resource');

    const sparql = `PREFIX schema: <https://schema.org/>
DELETE { GRAPH <${graph}> { <${resourceUrl}> schema:age ?o . } }
INSERT { GRAPH <${graph}> { <${resourceUrl}> schema:age 99 . } }
WHERE  { GRAPH <${graph}> { <${resourceUrl}> schema:age ?o . } }`;

    await assertSuccess(await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    }), 'sparql patch');

    const res = await doFetch(resourceUrl, { method: 'GET', headers: { accept: 'application/n-quads' } });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    expect(body).toMatch(/<https:\/\/schema\.org\/age>\s+"?99/);
    expect(body).not.toMatch(/<https:\/\/schema\.org\/age>\s+"?20/);
  });

  it('DELETE DATA / INSERT DATA with string literals should not parse literals as IRIs', async () => {
    // This is the exact bug scenario reported:
    // String literals like "Alice Example" were being serialized as <Alice Example> (IRIs)
    const testResource = new URL('literal-data-test.ttl', containerUrl).toString();
    
    // Seed with initial data
    await assertSuccess(await doFetch(testResource, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: `
        <${testResource}#profile> <https://schema.org/name> "Alice Example" .
        <${testResource}#profile> <https://schema.org/age> 30 .
      `,
    }), 'seed resource');

    // This is the exact SPARQL UPDATE from the bug report
    const sparql = `
DELETE DATA {
  <${testResource}#profile> <https://schema.org/name> "Alice Example" .
  <${testResource}#profile> <https://schema.org/age> 30 .
};
INSERT DATA {
  <${testResource}#profile> <https://schema.org/name> "Alice Updated" .
  <${testResource}#profile> <https://schema.org/age> 31 .
}`;

    const patchRes = await doFetch(testResource, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    });
    await assertSuccess(patchRes, 'sparql patch with DELETE DATA / INSERT DATA');

    // Verify the update worked
    const res = await doFetch(testResource, { method: 'GET', headers: { accept: 'application/n-quads' } });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    
    console.log('Result body:', body);
    
    // New values should exist
    expect(body).toContain('"Alice Updated"');
    expect(body).toMatch(/"31"/);
    
    // Old values should be gone
    expect(body).not.toContain('"Alice Example"');
    expect(body).not.toMatch(/"30"/);
  });

  it('DELETE DATA / INSERT DATA with language-tagged literals', async () => {
    const testResource = new URL('literal-lang-test.ttl', containerUrl).toString();
    
    await assertSuccess(await doFetch(testResource, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: `<${testResource}#item> <http://www.w3.org/2000/01/rdf-schema#label> "Hello"@en .`,
    }), 'seed resource');

    const sparql = `
DELETE DATA {
  <${testResource}#item> <http://www.w3.org/2000/01/rdf-schema#label> "Hello"@en .
};
INSERT DATA {
  <${testResource}#item> <http://www.w3.org/2000/01/rdf-schema#label> "Bonjour"@fr .
}`;

    await assertSuccess(await doFetch(testResource, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    }), 'sparql patch');

    const res = await doFetch(testResource, { method: 'GET', headers: { accept: 'application/n-quads' } });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    
    expect(body).toContain('"Bonjour"@fr');
    expect(body).not.toContain('"Hello"@en');
  });
});
