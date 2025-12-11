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

suite('Graph inference compatibility (LDP ⇄ SPARQL)', () => {
  let session: Session;
  let doFetch: typeof fetch;
  let podBase: string;
  let containerUrl: string;
  let resourceUrl: string;

  const parseStorageFromLink = (linkValue: string | null): string | undefined => {
    if (!linkValue) return undefined;
    const parts = linkValue.split(',');
    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/pim\/space#storage"/);
      if (match?.[1]) return match[1];
    }
    return undefined;
  };

  async function resolvePodBase(): Promise<string> {
    const headRes = await doFetch(webId!, { method: 'HEAD' }).catch(() => undefined);
    if (headRes && headRes.ok) {
      const linkStorage = parseStorageFromLink(headRes.headers.get('link'));
      if (linkStorage) return linkStorage.endsWith('/') ? linkStorage : `${linkStorage}/`;
    }

    const profileUrl = new URL(webId!);
    profileUrl.searchParams.set('_type', 'text/turtle');
    const res = await doFetch(profileUrl.toString(), {
      headers: { accept: 'text/turtle,application/ld+json;q=0.9,text/n3;q=0.8,application/n-triples;q=0.7,text/html;q=0.5' },
    });
    const fallbackBase = (() => {
      try {
        const url = new URL(webId!);
        // strip path after pod-id (assume /{podId}/... )
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          const podId = parts[0];
          return `${url.origin}/${podId}/`;
        }
        return `${url.origin}/`;
      } catch {
        return (process.env.SOLID_OIDC_ISSUER ?? '').replace(/\/?$/, '/');
      }
    })();

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`fetch webid failed with status ${res.status}: ${text}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      return fallbackBase;
    }
    const body = await res.text();
    const quads = new Parser().parse(body);
    const storage = quads.find((q) => q.subject.value === webId && q.predicate.value === 'http://www.w3.org/ns/pim/space#storage');
    if (!storage) {
      return fallbackBase;
    }
    return storage.object.value.endsWith('/') ? storage.object.value : `${storage.object.value}/`;
  }

  beforeAll(async () => {
    session = new Session();
    await session.login({ clientId: clientId!, clientSecret: clientSecret!, oidcIssuer, tokenType });
    doFetch = session.fetch.bind(session);

    podBase = await resolvePodBase();
    containerUrl = new URL('graph-inference/', podBase).toString();
    resourceUrl = new URL('doc.ttl', containerUrl).toString();

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

  it('writes via LDP (document mode) and updates via SPARQL without explicit GRAPH', async () => {
    // LDP PUT seeds default graph with document subject
    await assertSuccess(await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: `<${resourceUrl}> <https://schema.org/name> "Alice" .`,
    }), 'seed document');

    // SPARQL UPDATE without GRAPH should target the document graph
    const update = `
PREFIX schema: <https://schema.org/>
DELETE { <${resourceUrl}> schema:name ?o }
INSERT { <${resourceUrl}> schema:name "Bob" }
WHERE  { <${resourceUrl}> schema:name ?o }
`;
    const updRes = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: update,
    });
    await assertSuccess(updRes, 'sparql update');

    const check = await doFetch(resourceUrl, { method: 'GET', headers: { accept: 'text/turtle' } });
    await assertSuccess(check, 'get document');
    const body = await check.text();
    expect(body).toMatch(/https:\/\/schema\.org\/name>\s+"Bob"/);
    expect(body).not.toMatch(/https:\/\/schema\.org\/name>\s+"Alice"/);
  });
});
