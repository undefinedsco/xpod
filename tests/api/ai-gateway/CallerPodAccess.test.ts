import { describe, expect, it, vi } from 'vitest';

import {
  createCallerAuthenticatedPodFetch,
  isCallerOwnPodBearer,
} from '../../../src/api/ai-gateway/auth/CallerPodAccess';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const OWNER = 'https://id.example/alice/profile/card#me';

describe('createCallerAuthenticatedPodFetch', () => {
  it('replays the owner-bound Bearer token', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
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

  it('uses a verified direct Bearer token that did not arrive as an sk wrapper', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    // A browser-independent client can present a Solid access token it obtained itself; it was
    // verified against the issuer already, and the owner check is what makes it Pod access.
    const auth: AuthContext = {
      type: 'solid',
      webId: OWNER,
      accessToken: 'direct-solid-token',
      tokenType: 'Bearer',
    };

    const podFetch = createCallerAuthenticatedPodFetch(OWNER, auth, upstream as typeof fetch)!;
    await podFetch('https://id.example/alice/settings/credentials.ttl');

    const headers = upstream.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer direct-solid-token');
  });

  it('lets the runtime recalculate entity headers when replaying a Request body', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
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
    ['a gateway access key principal', { type: 'solid', webId: OWNER, viaGatewayApiKey: true, accessToken: 'token', tokenType: 'Bearer' }],
    ['a runtime invocation principal', { type: 'solid', webId: OWNER, internalInvocation: true, accessToken: 'token', tokenType: 'Bearer' }],
    ['DPoP token', { type: 'solid', webId: OWNER, viaApiKey: true, accessToken: 'token', tokenType: 'DPoP' }],
    ['missing token', { type: 'solid', webId: OWNER, viaApiKey: true, tokenType: 'Bearer' }],
    ['blank token', { type: 'solid', webId: OWNER, accessToken: '   ', tokenType: 'Bearer' }],
    ['non-solid auth', { type: 'service', serviceType: 'cloud', serviceId: 'svc', scopes: [] }],
    ['no auth', undefined],
  ] as Array<[string, AuthContext | undefined]>)('rejects %s', (_label, auth) => {
    expect(isCallerOwnPodBearer(OWNER, auth)).toBe(false);
    expect(createCallerAuthenticatedPodFetch(OWNER, auth)).toBeUndefined();
  });
});
