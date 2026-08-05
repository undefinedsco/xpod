import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createAiConnectionServiceAccess } from '../../../src/api/ai-gateway/service-access/AiConnectionServiceAccess';
import { HostedPodDataAccess } from '../../../src/api/ai-gateway/pod/HostedPodDataAccess';
import {
  GATEWAY_ADMIN_PROXY_HEADERS,
  verifyGatewayAdminProxyHeaders,
} from '../../../src/runtime/GatewayAdminProxyAuth';

const SECRET = 'hosted-pod-test-secret';
const OWNER = 'https://pod.example/alice/profile/card#me';
const BOB = 'https://pod.example/bob/profile/card#me';
const CREDENTIAL_RESOURCE = createAiConnectionServiceAccess({
  ownerWebId: OWNER,
  serviceWebId: OWNER,
}).resources.find((resource) => resource.id === 'providerCredentials')!.url;
const QUOTA_RESOURCE = createAiConnectionServiceAccess({
  ownerWebId: OWNER,
  serviceWebId: OWNER,
}).resources.find((resource) => resource.id === 'quotaSnapshots')!.url;
const MODEL_QUERY = 'SELECT ?id WHERE { ?id ?predicate ?value }';
const MODEL_SPARQL_RESOURCE = `https://pod.example/alice/settings/providers/-/sparql?query=${encodeURIComponent(MODEL_QUERY)}`;
const MODEL_SPARQL_POST_RESOURCE = 'https://pod.example/alice/settings/providers/-/sparql';

describe('HostedPodDataAccess', () => {
  it('rejects public CSS base URLs before runtime markers can be sent', () => {
    expect(() => createAccess({ cssBaseUrl: 'https://pod.example/' }))
      .toThrow('hosted_pod_css_loopback_required');
  });

  it('signs each hosted Pod request with a fresh loopback intent and strips caller credentials', async () => {
    const sent: Request[] = [];
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        sent.push(request);
        return new Response('pod body', { status: 200, headers: { 'content-type': 'text/turtle' } });
      }) as typeof fetch,
      nonce: vi.fn()
        .mockReturnValueOnce('nonce-1')
        .mockReturnValueOnce('nonce-2'),
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, {
      type: 'solid',
      webId: OWNER,
      accessToken: 'caller-token',
      tokenType: 'DPoP',
      dpopProof: 'caller-proof',
    });
    expect(trustedFetch).toBeDefined();

    const first = await trustedFetch!(CREDENTIAL_RESOURCE, {
      method: 'GET',
      headers: {
        authorization: 'Bearer caller-token',
        dpop: 'caller-proof',
        cookie: 'sid=caller',
        'x-xpod-admin-proxy-signature': 'forged',
        accept: 'text/turtle',
      },
    });
    const second = await trustedFetch!(CREDENTIAL_RESOURCE, { method: 'GET' });

    expect(await first.text()).toBe('pod body');
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe('http://127.0.0.1:3000/.internal/pod-data');
    expect(sent[0].method).toBe('GET');
    expect(sent[0].headers.get('authorization')).toBeNull();
    expect(sent[0].headers.get('dpop')).toBeNull();
    expect(sent[0].headers.get('cookie')).toBeNull();
    expect(sent[0].headers.get('accept')).toBe('text/turtle');
    for (const marker of GATEWAY_ADMIN_PROXY_HEADERS) {
      expect(sent[0].headers.get(marker)).toBeTruthy();
    }
    expect(sent[0].headers.get('x-xpod-admin-proxy-signature')).not.toBe('forged');
    expect(sent[0].headers.get('x-xpod-admin-proxy-nonce')).toBe('nonce-1');
    expect(sent[1].headers.get('x-xpod-admin-proxy-nonce')).toBe('nonce-2');
    const forwardedHeaders: Record<string, string> = {};
    sent[0].headers.forEach((value, key) => {
      forwardedHeaders[key] = value;
    });
    expect(verifyGatewayAdminProxyHeaders({
      headers: forwardedHeaders,
      secret: SECRET,
      method: 'GET',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      originalClientLoopback: true,
      intent: {
        ownerWebId: OWNER,
        method: 'GET',
        resourceUrl: CREDENTIAL_RESOURCE,
        principalKind: 'solid-user',
        scopes: ['ai:credentials:read'],
      },
    });
  });

  it('forwards drizzle-solid HEAD probes with read-only credentials scope', async () => {
    let sent: Request | undefined;
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent = new Request(input, init);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    await trustedFetch!(CREDENTIAL_RESOURCE, { method: 'HEAD' });

    expect(sent?.method).toBe('HEAD');
    expect(verifyGatewayAdminProxyHeaders({
      headers: headersRecord(sent!.headers),
      secret: SECRET,
      method: 'HEAD',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: {
        ownerWebId: OWNER,
        method: 'HEAD',
        resourceUrl: CREDENTIAL_RESOURCE,
        principalKind: 'solid-user',
        scopes: ['ai:credentials:read'],
      },
    });
  });

  it('rejects Solid callers that do not own the requested hosted Pod', async () => {
    const access = createAccess();
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: BOB });
    expect(trustedFetch).toBeDefined();

    await expect(trustedFetch!(CREDENTIAL_RESOURCE))
      .rejects.toThrow('hosted_pod_owner_mismatch');
  });

  it('rejects missing auth instead of inventing a gateway-key principal', async () => {
    const access = createAccess();
    const trustedFetch = await access.getTrustedFetch(OWNER);
    expect(trustedFetch).toBeDefined();

    await expect(trustedFetch!(CREDENTIAL_RESOURCE))
      .rejects.toThrow('hosted_pod_auth_required');
  });

  it('allows verified sk client-credentials callers as the Solid owner without gateway-specific scopes', async () => {
    let sent: Request | undefined;
    const accessWithFetch = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent = new Request(input, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const trustedFetch = await accessWithFetch.getTrustedFetch(OWNER, {
      type: 'solid',
      webId: OWNER,
      viaApiKey: true,
    });
    expect(trustedFetch).toBeDefined();

    await trustedFetch!(CREDENTIAL_RESOURCE, { method: 'PUT', body: 'payload' });

    const forwardedHeaders: Record<string, string> = {};
    sent!.headers.forEach((value, key) => {
      forwardedHeaders[key] = value;
    });
    expect(verifyGatewayAdminProxyHeaders({
      headers: forwardedHeaders,
      secret: SECRET,
      method: 'PUT',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: {
        ownerWebId: OWNER,
        method: 'PUT',
        resourceUrl: CREDENTIAL_RESOURCE,
        principalKind: 'solid-user',
        scopes: ['ai:credentials:write'],
      },
    });
  });

  it('rejects remote Pods and non AI Connection model resources before loopback fetch', async () => {
    const upstreamFetch = vi.fn(fetch);
    const access = createAccess({ fetch: upstreamFetch as typeof fetch });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });
    expect(trustedFetch).toBeDefined();

    await expect(trustedFetch!('https://remote.example/alice/settings/credentials.ttl'))
      .rejects.toThrow('hosted_pod_remote_resource');
    await expect(trustedFetch!('https://pod.example/alice/private/other.ttl'))
      .rejects.toThrow('hosted_pod_resource_not_allowed');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('allows only the owner Pod model collection GET with one encoded query parameter', async () => {
    const sent: Request[] = [];
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent.push(new Request(input, init));
        return new Response('model results', { status: 200 });
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    const response = await trustedFetch!(MODEL_SPARQL_RESOURCE, { method: 'GET' });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(verifyGatewayAdminProxyHeaders({
      headers: headersRecord(sent[0].headers),
      secret: SECRET,
      method: 'GET',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: {
        ownerWebId: OWNER,
        resourceUrl: MODEL_SPARQL_RESOURCE,
        method: 'GET',
      },
    });
  });

  it('allows owner model collection POST bodies and signs their exact digest', async () => {
    const sent: Request[] = [];
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent.push(new Request(input, init));
        return new Response('model results', { status: 200 });
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });
    const body = new URLSearchParams({ query: MODEL_QUERY }).toString();

    const response = await trustedFetch!(MODEL_SPARQL_POST_RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(await sent[0].clone().text()).toBe(body);
    expect(verifyGatewayAdminProxyHeaders({
      headers: headersRecord(sent[0].headers),
      secret: SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: {
        ownerWebId: OWNER,
        resourceUrl: MODEL_SPARQL_POST_RESOURCE,
        method: 'POST',
        bodyDigest: createHash('sha256').update(body).digest('hex'),
      },
    });
  });

  it('also accepts raw application/sparql-query POST bodies', async () => {
    const sent: Request[] = [];
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent.push(new Request(input, init));
        return new Response('model results', { status: 200 });
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    await trustedFetch!(MODEL_SPARQL_POST_RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query' },
      body: MODEL_QUERY,
    });

    expect(await sent[0].clone().text()).toBe(MODEL_QUERY);
    expect(verifyGatewayAdminProxyHeaders({
      headers: headersRecord(sent[0].headers),
      secret: SECRET,
      method: 'POST',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: { bodyDigest: createHash('sha256').update(MODEL_QUERY).digest('hex') },
    });
  });

  it.each([
    ['cross-owner endpoint', `https://pod.example/bob/settings/providers/-/sparql?query=${encodeURIComponent(MODEL_QUERY)}`],
    ['extra query parameter', `${MODEL_SPARQL_RESOURCE}&format=json`],
    ['duplicate query parameter', `${MODEL_SPARQL_RESOURCE}&query=${encodeURIComponent(MODEL_QUERY)}`],
    ['fragment', `${MODEL_SPARQL_RESOURCE}#fragment`],
    ['arbitrary provider path', 'https://pod.example/alice/settings/providers/secret.ttl'],
  ])('rejects %s from the hosted model collection capability', async (_name, resourceUrl) => {
    const upstreamFetch = vi.fn(fetch);
    const access = createAccess({ fetch: upstreamFetch as typeof fetch });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    await expect(trustedFetch!(resourceUrl)).rejects.toThrow(/hosted_pod_(?:remote_resource|resource_not_allowed)/u);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods on the model collection capability', async () => {
    const access = createAccess();
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    await expect(trustedFetch!(MODEL_SPARQL_RESOURCE, { method: 'HEAD' }))
      .rejects.toThrow('hosted_pod_resource_not_allowed');
  });

  it.each([
    ['POST query URL', MODEL_SPARQL_RESOURCE, 'query=SELECT'],
    ['POST extra form field', MODEL_SPARQL_POST_RESOURCE, `${new URLSearchParams({ query: MODEL_QUERY }).toString()}&format=json`],
  ])('rejects malformed model collection %s bodies', async (_name, resource, body) => {
    const access = createAccess();
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });

    await expect(trustedFetch!(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })).rejects.toThrow('hosted_pod_resource_not_allowed');
  });

  it('preserves request and response bodies through the loopback channel', async () => {
    let forwardedBody = '';
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        forwardedBody = await request.text();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('streamed'));
            controller.close();
          },
        }));
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });
    expect(trustedFetch).toBeDefined();

    const response = await trustedFetch!(CREDENTIAL_RESOURCE, {
      method: 'PUT',
      body: 'payload',
      headers: { 'content-type': 'text/turtle' },
    });

    expect(forwardedBody).toBe('payload');
    expect(await response.text()).toBe('streamed');
  });

  it('signs quota snapshot refresh writes as the verified Solid user principal', async () => {
    let sent: Request | undefined;
    const access = createAccess({
      fetch: vi.fn(async (input, init) => {
        sent = new Request(input, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const trustedFetch = await access.getTrustedFetch(OWNER, { type: 'solid', webId: OWNER });
    expect(trustedFetch).toBeDefined();

    await trustedFetch!(QUOTA_RESOURCE, { method: 'PUT', body: 'quota' });

    expect(sent).toBeDefined();
    expect(verifyGatewayAdminProxyHeaders({
      headers: headersRecord(sent!.headers),
      secret: SECRET,
      method: 'PUT',
      url: '/.internal/pod-data',
      now: Date.parse('2026-08-03T00:00:00.000Z'),
    })).toMatchObject({
      valid: true,
      intent: {
        ownerWebId: OWNER,
        method: 'PUT',
        resourceUrl: QUOTA_RESOURCE,
        principalKind: 'solid-user',
        scopes: ['ai:credentials:write'],
      },
    });
  });
});

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function createAccess(overrides: Partial<ConstructorParameters<typeof HostedPodDataAccess>[0]> = {}): HostedPodDataAccess {
  return new HostedPodDataAccess({
    cssBaseUrl: 'http://127.0.0.1:3000/',
    gatewayAdminProxyAuthSecret: SECRET,
    now: () => Date.parse('2026-08-03T00:00:00.000Z'),
    nonce: () => 'nonce',
    ...overrides,
  });
}
