import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';

const WEB_ID = 'https://storage.example/alice/profile/card#me';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API container Solid client credential issuer', () => {
  it.each([
    {
      name: 'managed Local with a distinct loopback Cloud issuer',
      edition: 'local' as const,
      solidBaseUrl: 'http://localhost:39995/',
      oidcIssuer: 'http://localhost:39005/',
      cssTokenEndpoint: 'http://localhost:39005/.oidc/token',
      proofUrl: 'http://localhost:39005/.oidc/token',
      forwardedHost: null,
    },
    {
      name: 'Cloud reaching its canonical identity interface through an internal alias',
      edition: 'cloud' as const,
      solidBaseUrl: 'https://id.example/',
      oidcIssuer: 'https://id.example/',
      cssTokenEndpoint: 'http://127.0.0.1:6401/.oidc/token',
      proofUrl: 'https://id.example/.oidc/token',
      forwardedHost: 'id.example',
    },
    {
      name: 'standalone without an external issuer reaching its own internal CSS alias',
      edition: 'local' as const,
      solidBaseUrl: 'https://pod.example/',
      cssTokenEndpoint: 'http://127.0.0.1:6501/.oidc/token',
      proofUrl: 'https://pod.example/.oidc/token',
      forwardedHost: 'pod.example',
    },
    {
      name: 'managed Local with a remote HTTPS Cloud issuer',
      edition: 'local' as const,
      solidBaseUrl: 'https://storage.example/',
      oidcIssuer: 'https://id.example/',
      cssTokenEndpoint: 'https://id.example/.oidc/token',
      proofUrl: 'https://id.example/.oidc/token',
      forwardedHost: null,
    },
  ])('binds the credential proof to its issuer for $name', async (deployment) => {
    const request = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'unit-test-token', token_type: 'DPoP', expires_in: 3600, webid: WEB_ID,
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const config: ApiContainerConfig = {
      edition: deployment.edition, port: 3001, host: '127.0.0.1', authMode: 'acp',
      databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
      cssTokenEndpoint: deployment.cssTokenEndpoint, solidBaseUrl: deployment.solidBaseUrl,
      ...('oidcIssuer' in deployment ? { oidcIssuer: deployment.oidcIssuer } : {}),
    };
    const container = createApiContainer(config);
    try {
      const session = await container.resolve('solidSessions').session({
        clientId: 'test-client', clientSecret: 'test-secret',
      });
      expect(session.webId).toBe(WEB_ID);
      expect(request).toHaveBeenCalledOnce();
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe(deployment.cssTokenEndpoint);
      const headers = new Headers(init?.headers);
      const proof = JSON.parse(Buffer.from(headers.get('dpop')!.split('.')[1]!, 'base64url').toString('utf8'));
      expect(proof.htu).toBe(deployment.proofUrl);
      expect(headers.get('x-forwarded-host')).toBe(deployment.forwardedHost);
      expect(headers.get('x-forwarded-proto')).toBe(deployment.forwardedHost ? 'https' : null);
    } finally {
      await container.dispose();
    }
  });
});
