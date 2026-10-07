import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { createOwnerPodBaseUrlResolver, resolveOwnerPodBaseUrl } from '../../src/api/ai-gateway/pod/PodBaseUrlResolver';
import type { SolidAuthContext } from '../../src/api/auth/AuthContext';

const owner = 'https://identity.example/alice/profile/card#me';
const podA = 'https://store.example/one/';
const podB = 'https://store.example/two/';
describe('HTTP Pod selection failures', () => {
  let server: ApiServer | undefined;
  afterEach(async () => { await server?.stop(); server = undefined; });
  it.each(['ambiguous', 'scope-conflict', 'unregistered', 'same-pod'] as const)('returns a recoverable safe HTTP response for %s', async scenario => {
    const auth: SolidAuthContext = { type: 'solid', webId: owner,
      ...(scenario === 'scope-conflict' || scenario === 'same-pod' ? { authorizedPodUrl: podA } : {}) };
    const resolver = createOwnerPodBaseUrlResolver({ findByWebId: async () => undefined,
      findAllByWebId: async () => [podA, podB].map(baseUrl => ({ podId: baseUrl, accountId: 'alice', webId: owner, baseUrl })),
    }, 'unique');
    server = new ApiServer({ port: 0, authMiddleware: new AuthMiddleware({
      authenticator: { canAuthenticate: () => true, authenticate: async () => ({ success: true, context: auth }) },
    }) });
    server.get('/api/ai/providers', async (request, response) => {
      await resolveOwnerPodBaseUrl(owner, resolver, request.auth);
      response.end(JSON.stringify({ data: [] }));
    });
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test endpoint');
    const selected = scenario === 'ambiguous' ? undefined : scenario === 'unregistered' ? 'https://foreign.example/one/' : scenario === 'scope-conflict' ? podB : podA;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/providers`, {
      headers: { Authorization: 'Bearer test-owned-session', ...(selected ? { 'X-Xpod-Pod-Url': selected } : {}) },
    });
    expect(response.status).toBe(scenario === 'same-pod' ? 200 : 403);
    const body = await response.text();
    if (scenario !== 'same-pod') expect(JSON.parse(body)).toEqual({ error: 'service_access_missing' });
    expect(body).not.toContain('store.example');
    expect(body).not.toContain('identity.example');
  });
});
