import type { IncomingMessage } from 'node:http';
import { DataFactory, Writer } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { gatewayAccessKeyResource } from '@undefineds.co/models';
import { createOwnerPodBaseUrlResolver, resolveOwnerPodBaseUrl } from '../../../src/api/ai-gateway/pod/PodBaseUrlResolver';
import { AesGatewayKeyLocatorCodec, createGatewayKeyLocator } from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { createGatewayApiKey } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import { GatewayApiKeyAuthenticator } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { PodGatewayAccessKeyRepository } from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';

const owner = 'https://identity.example/alice/profile/card#me';
const otherOwner = 'https://identity.example/bob/profile/card#me';
const podA = 'https://cloud.example/alice/';
const podB = 'https://local.example/storage/alice/';
const aliasB = 'https://local.example/alice/';
const { namedNode, literal, quad } = DataFactory;
async function fixture(placement: 'unique' | 'duplicate' | 'foreign-owner' | 'absent' | 'inaccessible' = 'unique') {
  const codec = new AesGatewayKeyLocatorCodec('fixture-locator-secret');
  const id = createGatewayKeyLocator(owner, 'local', codec);
  const issued = await createGatewayApiKey({ deployment: 'local', keyId: id, secret: 'fixture-key-secret' });
  const resourceId = gatewayAccessKeyResource.buildId({ id });
  const document = (root: string) => gatewayAccessKeyResource.buildIri(root, { id }).split('#')[0];
  async function body(root: string, rowOwner: string) {
    const subject = namedNode(gatewayAccessKeyResource.buildIri(root, { id }));
    const q = [quad(subject, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(gatewayAccessKeyResource.config.type!))];
    const values: Record<string, string[]> = { owner: [rowOwner], secretHash: [issued.record.secretHash], deployment: ['local'], scopes: ['models:read', 'inference:write'], createdAt: ['2026-10-05T00:00:00Z'] };
    for (const [key, items] of Object.entries(values)) for (const value of items) {
      const predicate = gatewayAccessKeyResource.columns[key as keyof typeof gatewayAccessKeyResource.columns].options.predicate!;
      const object = key === 'owner' ? namedNode(value) : key === 'createdAt' ? literal(value, namedNode('http://www.w3.org/2001/XMLSchema#dateTime')) : literal(value);
      q.push(quad(subject, namedNode(predicate), object));
    }
    const writer = new Writer();
    writer.addQuads(q);
    return await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
  }
  const documents = new Map<string, string>();
  if (placement !== 'absent') documents.set(document(podB), await body(podB, placement === 'foreign-owner' ? otherOwner : owner));
  if (placement === 'duplicate') documents.set(document(podA), await body(podA, owner));
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const transport: typeof fetch = vi.fn(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, ...(init?.body ? { body: String(init.body) } : {}) });
    if (method !== 'GET') return new Response(null, { status: 204 });
    if (placement === 'inaccessible' && url === document(podA)) return new Response(null, { status: 403 });
    return documents.has(url) ? new Response(documents.get(url), { headers: { 'content-type': 'text/turtle' } }) : new Response(null, { status: 404 });
  });
  const resolver = createOwnerPodBaseUrlResolver({ findByWebId: vi.fn(), findAllByWebId: vi.fn(async webId => webId === owner ? [
    { podId: 'cloud', accountId: 'alice', webId: owner, baseUrl: podA },
    { podId: 'local', accountId: 'alice', webId: owner, baseUrl: aliasB, storageUrl: podB },
  ] : []) }, 'unique');
  const repository = new PodGatewayAccessKeyRepository({ locatorCodec: codec, podBaseUrlResolver: resolver,
    podAccess: { getPodFetch: vi.fn(async () => transport) },
  });
  const authenticator = new GatewayApiKeyAuthenticator({ repository, deployment: 'local', now: () => new Date('2026-10-05T00:01:00Z') });
  return { issued, requests, authenticator, repository, resolver, document, resourceId };
}

describe('legacy key authoritative Pod lookup through real ORM', () => {
  it.each([undefined, aliasB])('verifies the unique key and touches only its Pod with hint %s', async hint => {
    const f = await fixture();
    const req = { headers: { authorization: `Bearer ${f.issued.plaintext}`, ...(hint ? { 'x-xpod-pod-url': hint } : {}) } } as IncomingMessage;
    const result = await f.authenticator.authenticate(req);
    expect(result.success).toBe(true);
    expect(result.context).toMatchObject({ webId: owner, authorizedPodUrl: podB });
    expect(result.context).not.toHaveProperty('requestedPodUrl');
    if (result.context?.type !== 'solid') throw new Error('Expected key auth');
    await expect(resolveOwnerPodBaseUrl(owner, f.resolver, { ...result.context, ...(hint ? { requestedPodUrl: hint } : {}) })).resolves.toBe(podB);
    expect(f.requests.filter(row => row.method === 'GET').some(row => row.url === f.document(podA))).toBe(true);
    const writes = f.requests.filter(row => row.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(row => row.url === f.document(podB))).toBe(true);
    expect(writes.some(row => row.body?.includes(gatewayAccessKeyResource.columns.lastUsedAt.options.predicate!))).toBe(true);
    expect(f.requests.every(row => [f.document(podA), f.document(podB)].includes(row.url))).toBe(true);
  });

  it.each(['duplicate', 'foreign-owner', 'absent'] as const)('rejects %s rows before any write or caller identity', async placement => {
    const f = await fixture(placement);
    const result = await f.authenticator.authenticate({ headers: { authorization: `Bearer ${f.issued.plaintext}` } } as IncomingMessage);
    expect(result).toMatchObject({ success: false, statusCode: 401 });
    expect(result).not.toHaveProperty('context');
    expect(f.requests.every(row => row.method === 'GET')).toBe(true);
  });

  it('fails closed if an owned candidate cannot be read instead of claiming a unique match', async () => {
    const f = await fixture('inaccessible');
    const result = await f.authenticator.authenticate({ headers: { authorization: `Bearer ${f.issued.plaintext}` } } as IncomingMessage);
    expect(result).toMatchObject({ success: false, statusCode: 503 });
    expect(result).not.toHaveProperty('context');
    expect(f.requests.every(row => row.method === 'GET')).toBe(true);
  });

  it('never trusts a foreign hint or touches another Pod after a wrong secret', async () => {
    const f = await fixture();
    const invalid = await f.authenticator.authenticate({ headers: { authorization: `Bearer ${f.issued.plaintext}wrong` } } as IncomingMessage);
    expect(invalid.success).toBe(false);
    expect(f.requests.every(row => row.method === 'GET')).toBe(true);
    const valid = await f.authenticator.authenticate({ headers: { authorization: `Bearer ${f.issued.plaintext}`, 'x-xpod-pod-url': 'https://foreign.example/owner/' } } as unknown as IncomingMessage);
    if (valid.context?.type !== 'solid') throw new Error('Expected authenticated key before hint intersection');
    await expect(resolveOwnerPodBaseUrl(owner, f.resolver, { ...valid.context, requestedPodUrl: 'https://foreign.example/owner/' })).rejects.toThrow('service_access_missing');
  });
});
