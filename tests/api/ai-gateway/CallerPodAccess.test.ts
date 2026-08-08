import { describe, expect, it, vi } from 'vitest';

import { createCallerAuthenticatedPodFetch } from '../../../src/api/ai-gateway/auth/CallerPodAccess';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const OWNER = 'https://id.example/alice/profile/card#me';

describe('createCallerAuthenticatedPodFetch', () => {
  it('replays only the owner-bound Bearer token minted from sk client credentials', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const auth: AuthContext = {
      type: 'solid',
      webId: OWNER,
      viaApiKey: true,
      accessToken: 'caller-access-token',
      tokenType: 'Bearer',
    };

    const podFetch = createCallerAuthenticatedPodFetch(OWNER, auth, upstream as typeof fetch);
    expect(podFetch).toBeDefined();

    await podFetch!('https://id.example/alice/settings/credentials.ttl', {
      headers: { Accept: 'text/turtle' },
    });

    expect(upstream).toHaveBeenCalledWith(
      'https://id.example/alice/settings/credentials.ttl',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = upstream.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer caller-access-token');
    expect(headers.get('Accept')).toBe('text/turtle');
  });

  it('lets the runtime recalculate entity headers when replaying a Request body', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    const auth: AuthContext = {
      type: 'solid',
      webId: OWNER,
      viaApiKey: true,
      accessToken: 'caller-access-token',
      tokenType: 'Bearer',
    };
    const podFetch = createCallerAuthenticatedPodFetch(OWNER, auth, upstream as typeof fetch)!;

    await podFetch(new Request('https://id.example/alice/settings/-/sparql', {
      method: 'POST',
      headers: { 'content-length': '999', 'content-type': 'application/sparql-query' },
      body: 'SELECT * WHERE { ?s ?p ?o }',
    }));

    const headers = upstream.mock.calls[0]![1]!.headers as Headers;
    expect(headers.has('content-length')).toBe(false);
  });

  it.each([
    ['wrong owner', { type: 'solid', webId: 'https://id.example/bob/profile/card#me', viaApiKey: true, accessToken: 'token', tokenType: 'Bearer' }],
    ['not api-key transport', { type: 'solid', webId: OWNER, accessToken: 'token', tokenType: 'Bearer' }],
    ['DPoP token', { type: 'solid', webId: OWNER, viaApiKey: true, accessToken: 'token', tokenType: 'DPoP' }],
    ['missing token', { type: 'solid', webId: OWNER, viaApiKey: true, tokenType: 'Bearer' }],
    ['non-solid auth', { type: 'service', serviceType: 'cloud', serviceId: 'svc', scopes: [] }],
  ] as Array<[string, AuthContext]>)('rejects %s', (_label, auth) => {
    expect(createCallerAuthenticatedPodFetch(OWNER, auth)).toBeUndefined();
  });
});
