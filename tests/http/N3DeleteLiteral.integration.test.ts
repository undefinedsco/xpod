import { beforeAll, describe, expect, it } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';
import { resolveSolidIntegrationConfig } from './utils/integrationEnv';
import { resolvePodBase } from './utils/pod';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const { webId, oidcIssuer } = resolveSolidIntegrationConfig();
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
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

suite('N3 Patch delete literal equivalence', () => {
  let session: Session;
  let doFetch: typeof fetch;
  let podBase: string;
  let containerUrl: string;
  let resourceUrl: string;

  beforeAll(async () => {
    session = new Session();
    await session.login({ clientId: clientId!, clientSecret: clientSecret!, oidcIssuer, tokenType });
    doFetch = session.fetch.bind(session);

    podBase = await resolvePodBase(doFetch, webId!, assertSuccess, oidcIssuer);
    containerUrl = new URL('drizzle-tests/', podBase).toString();
    resourceUrl = new URL('literal-delete.ttl', containerUrl).toString();

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

  it('deletes integer literal regardless of lexical form', async () => {
    // seed with shorthand integer
    await assertSuccess(await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '<> <https://schema.org/age> 20 .',
    }), 'seed resource');

    // sanity check: read back to see what literal the store returns
    const seeded = await doFetch(resourceUrl, { method: 'GET', headers: { accept: 'application/n-quads' } });
    await assertSuccess(seeded, 'read seeded');
    const seededBody = await seeded.text();
    // log for debugging purposes
    console.log('Seeded N-Quads:', seededBody.trim());

    // patch delete using canonical form and insert new value
    // Note: Do NOT include solid:where if no conditions are needed.
    // An empty solid:where { } will cause CSS N3Patcher to fail with 409.
    const n3Patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<> a solid:InsertDeletePatch;
  solid:deletes { <> <https://schema.org/age> "20"^^xsd:integer . };
  solid:inserts { <> <https://schema.org/age> 99 . }.
`;

    await assertSuccess(await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    }), 'n3 patch');

    const res = await doFetch(resourceUrl, { method: 'GET', headers: { accept: 'text/turtle' } });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    expect(body).toMatch(/<https:\/\/schema\.org\/age> 99/);
    expect(body).not.toMatch(/<https:\/\/schema\.org\/age> 20/);
  });
});
