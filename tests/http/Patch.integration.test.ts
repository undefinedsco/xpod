import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_PATCH_BASE_URL ?? 'http://localhost:3000/';
const podId = process.env.XPOD_PATCH_POD_ID ?? 'test';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret && oidcIssuer;
const suite = shouldRun ? describe : describe.skip;

const SUCCESS = new Set([ 200, 201, 202, 204, 205, 207 ]);

async function assertSuccess(response: Response, step: string): Promise<void> {
  if (!SUCCESS.has(response.status)) {
    const text = await response.clone().text();
    throw new Error(`${step} failed with status ${response.status}: ${text}`);
  }
}

suite('Patch integration (SPARQL + N3)', () => {
  const podBase = new URL(`${podId}/`, baseUrl).toString();
  const containerUrl = new URL(`integration/`, podBase).toString();
  const resourceUrl = new URL('res.ttl', containerUrl).toString();
  let session: Session;
  let doFetch: typeof fetch;

  async function getObjectUrls(resourceUrl: string): Promise<string[]> {
    const res = await doFetch(resourceUrl, { method: 'GET', headers: { accept: 'application/n-quads' } });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(' ')[2]?.replace(/[<>]/g, ''));
  }

  beforeAll(async () => {
    const ping = await fetch(baseUrl, { method: 'HEAD' }).catch((error: Error) => {
      throw new Error(`Unable to reach CSS instance at ${baseUrl}. Details: ${error.message}`);
    });
    if (!SUCCESS.has(ping.status) && ![ 401, 404, 405 ].includes(ping.status)) {
      throw new Error(`Server at ${baseUrl} responded with ${ping.status}`);
    }

    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType,
    });
    doFetch = session.fetch.bind(session);

    // ensure container exists inside the pod (only create when missing)
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

    const seed = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '<> <https://schema.org/url> <https://example.com/home-1> .',
    });
    await assertSuccess(seed, 'seed resource');

    // HEAD should expose Accept-Patch types
    const head = await doFetch(resourceUrl, { method: 'HEAD' });
    await assertSuccess(head, 'head resource');
    const acceptPatch = head.headers.get('accept-patch') ?? '';
    expect(acceptPatch).toContain('application/sparql-update');
    expect(acceptPatch).toContain('text/n3');
  });

  afterAll(async () => {
    await doFetch?.(containerUrl, { method: 'DELETE' }).catch(() => undefined);
    if (session?.info.isLoggedIn) {
      await session.logout().catch(() => undefined);
    }
  });

  it('applies SPARQL UPDATE patches', async () => {
    const sparql = `
DELETE DATA { <${resourceUrl}> <https://schema.org/url> <https://example.com/home-1> . };
INSERT DATA { <${resourceUrl}> <https://schema.org/url> <https://example.com/home-2> . };
`.trim();

    const res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    });
    await assertSuccess(res, 'sparql patch');

    const urls = await getObjectUrls(resourceUrl);
    expect(urls).toContain('https://example.com/home-2');
    expect(urls).not.toContain('https://example.com/home-1');
  });

  it('applies N3 InsertDeletePatch with solid:inserts/solid:deletes', async () => {
    const n3Patch = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <https://schema.org/> .
<> a solid:InsertDeletePatch ;
   solid:where   { <> schema:url ?o . } ;
   solid:deletes { <> schema:url ?o . } ;
   solid:inserts { <> schema:url <https://example.com/home-3> . } .
`.trim();

    const res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    });
    await assertSuccess(res, 'n3 patch');

    const urls = await getObjectUrls(resourceUrl);
    expect(urls).toContain('https://example.com/home-3');
    expect(urls).not.toContain('https://example.com/home-2');
  });

  it('applies SPARQL UPDATE with WHERE (non-BGP-only)', async () => {
    const sparql = `
PREFIX schema: <https://schema.org/>
DELETE { <${resourceUrl}> schema:url ?o }
INSERT { <${resourceUrl}> schema:url <https://example.com/home-4> }
WHERE  { <${resourceUrl}> schema:url ?o }
`.trim();

    const res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    });
    await assertSuccess(res, 'sparql patch with where');

    const urls = await getObjectUrls(resourceUrl);
    expect(urls).toContain('https://example.com/home-4');
    expect(urls).not.toContain('https://example.com/home-3');
  });

  it('applies SPARQL UPDATE with OPTIONAL', async () => {
    const sparql = `
PREFIX schema: <https://schema.org/>
DELETE { <${resourceUrl}> schema:url ?o }
INSERT { <${resourceUrl}> schema:url <https://example.com/home-5> }
WHERE  {
  <${resourceUrl}> schema:url ?o .
  OPTIONAL { <${resourceUrl}> schema:alternateName ?alt }
}
`.trim();

    const res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: sparql,
    });
    await assertSuccess(res, 'sparql patch with optional');

    const urls = await getObjectUrls(resourceUrl);
    expect(urls).toContain('https://example.com/home-5');
    expect(urls).not.toContain('https://example.com/home-4');
  });
});
