import { beforeAll, describe, expect, it } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';
import { Parser } from 'n3';

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

suite('N3 Patch delete literal equivalence', () => {
  let session: Session;
  let doFetch: typeof fetch;
  let podBase: string;
  let containerUrl: string;
  let resourceUrl: string;

  const parseStorageFromLink = (linkValue: string | null): string | undefined => {
    if (!linkValue) return undefined;
    // naive parse: look for rel="...storage"
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

    // Fallback to GET with explicit type negotiation; also try text/html for solid-oidc profiles
    const profileUrl = new URL(webId!);
    profileUrl.searchParams.set('_type', 'text/turtle');
    const res = await session.fetch(profileUrl.toString(), {
      headers: { accept: 'text/turtle,application/ld+json;q=0.9,text/n3;q=0.8,application/n-triples;q=0.7,text/html;q=0.5' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`fetch webid failed with status ${res.status}: ${text}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      // Cannot parse HTML; bail out with clearer error
      throw new Error('WebID profile returned HTML; cannot extract pim:storage. Please provide XPOD_PATCH_POD_ID.');
    }
    const body = await res.text();
    const quads = new Parser().parse(body);
    const storage = quads.find((q) => q.subject.value === webId && q.predicate.value === 'http://www.w3.org/ns/pim/space#storage');
    if (storage) {
      return storage.object.value.endsWith('/') ? storage.object.value : `${storage.object.value}/`;
    }
    
    // Fallback: derive from WebID if pim:storage is missing
    const webIdUrl = new URL(webId!);
    const pathParts = webIdUrl.pathname.split('/');
    // Assuming standard structure: /<pod>/profile/card#me -> /<pod>/
    if (pathParts.length >= 2) {
       return `${webIdUrl.origin}/${pathParts[1]}/`;
    }
    
    throw new Error('WebID profile has no pim:storage and cannot derive pod base.');
  }

  beforeAll(async () => {
    session = new Session();
    await session.login({ clientId: clientId!, clientSecret: clientSecret!, oidcIssuer, tokenType });
    doFetch = session.fetch.bind(session);

    podBase = await resolvePodBase();
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
