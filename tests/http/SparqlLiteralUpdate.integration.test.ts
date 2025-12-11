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
});
