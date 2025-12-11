import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_SERVER_BASE_URL ?? 'http://localhost:3000/';
const webId = process.env.SOLID_WEBID;
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';

const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret;
const suite = shouldRunIntegration ? describe : describe.skip;

import { Parser } from 'n3';

// ... (imports)

suite('PUT All Content Types Integration', () => {
  let session: Session;
  let authFetch: typeof fetch;
  let testContainer: string;

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
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType,
    });
    authFetch = session.fetch.bind(session);
    
    const podBase = await resolvePodBase();
    testContainer = `${podBase}test-put-types-${Date.now()}/`;
    
    // Create container explicitly
    await authFetch(testContainer, {
      method: 'PUT',
      headers: { 
        'content-type': 'text/turtle',
        'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
    });
  });

  afterAll(async () => {
    // Cleanup container if possible (recursive delete not standard LDP, so might leave artifacts)
  });

  it('should PUT text/plain', async () => {
    const url = `${testContainer}file.txt`;
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Hello World',
    });
    if (![200, 201].includes(res.status)) {
        console.log('Error Body:', await res.text());
    }
    expect([200, 201]).toContain(res.status);
    
    const get = await authFetch(url);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('Hello World');
    expect(get.headers.get('content-type')).toContain('text/plain');
  });

  it('should PUT image/png', async () => {
    const url = `${testContainer}image.png`;
    // 1x1 transparent pixel
    const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: pngBuffer,
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    const buffer = await get.arrayBuffer();
    expect(Buffer.from(buffer).equals(pngBuffer)).toBe(true);
    expect(get.headers.get('content-type')).toContain('image/png');
  });

  it('should PUT application/json', async () => {
    const url = `${testContainer}data.json`;
    const json = { foo: 'bar' };
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(json);
    expect(get.headers.get('content-type')).toContain('application/json');
  });
  
  it('should PUT text/turtle', async () => {
    const url = `${testContainer}data.ttl`;
    const ttl = '<#me> <http://ex.org/a> "b" .';
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: ttl,
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    // Content might be reformatted, so just check persistence
    expect(get.headers.get('content-type')).toContain('text/turtle');
  });

  it('should PUT application/ld+json and convert to RDF', async () => {
    const url = `${testContainer}data.jsonld`;
    const jsonld = {
      "@context": { "name": "http://schema.org/name" },
      "@type": "http://schema.org/Person",
      "name": "Jane Doe"
    };
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(jsonld),
    });
    expect([200, 201]).toContain(res.status);

    // Verify conversion: Requesting default should return Turtle (or match preference), not necessarily JSON-LD string match
    const get = await authFetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/turtle'); // Proof of conversion
    const body = await get.text();
    expect(body).toContain('Jane Doe');
  });

  it('should PUT text/markdown and keep as Binary', async () => {
    const url = `${testContainer}doc.md`;
    const md = '# Title\n\nContent';
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: md,
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/markdown'); // Proof of binary retention
    expect(await get.text()).toBe(md);
  });

  it('should PUT text/html and keep as Binary (Skip RDFa)', async () => {
    const url = `${testContainer}page.html`;
    const html = '<html><body><h1>Hi</h1></body></html>';
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/html');
    expect(await get.text()).toBe(html);
  });

  it('should PUT video/mp4 and keep as Binary', async () => {
    const url = `${testContainer}video.mp4`;
    // Minimal MP4 header (fake)
    const mp4Buffer = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    
    const res = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4Buffer,
    });
    expect([200, 201]).toContain(res.status);

    const get = await authFetch(url);
    expect(get.status).toBe(200);
    const buffer = await get.arrayBuffer();
    expect(Buffer.from(buffer).equals(mp4Buffer)).toBe(true);
    expect(get.headers.get('content-type')).toContain('video/mp4');
  });
});
