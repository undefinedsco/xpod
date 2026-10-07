import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildAuthenticatedFetch, createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';

/** A real external public OIDC client. Never renders or impersonates the Xpod desktop shell. */
export async function startBrowserExternalRp(issuer: string) {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Matrix application</title><h1>Application callback</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const callbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= new Promise<void>((resolve, reject) => {
    // Register the close callback first: Bun stops the listener in closeAllConnections.
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  try {
    const discovery = await fetch(new URL('/.well-known/openid-configuration', issuer));
    if (!discovery.ok) throw new Error(`External RP discovery failed: ${discovery.status}`);
    const configuration = await discovery.json() as {
      issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string;
    };
    if (new URL(configuration.issuer).origin !== new URL(issuer).origin) throw new Error('External RP discovered a different issuer');
    const registration = await fetch(configuration.registration_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Xpod acceptance external application',
        redirect_uris: [callbackUrl], response_types: ['code'], grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none', application_type: 'native' }),
    });
    if (registration.status !== 201) throw new Error(`External RP registration failed: ${registration.status}`);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    if (!clientId) throw new Error('External RP registration did not return a client ID');
    return {
      callbackUrl,
      close,
      authorization(provisionCode?: string) {
        const verifier = `${randomUUID()}${randomUUID()}`;
        const state = randomUUID();
        const authorization = new URL(configuration.authorization_endpoint);
        authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl,
          response_type: 'code', scope: 'openid webid offline_access', state,
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          ...(provisionCode ? { provisionCode } : {}),
        }).toString();
        let tokenRequests = 0;
        return {
          get tokenRequests() { return tokenRequests; },
          url: authorization.href,
          state,
          async exchange(callback: URL) {
            if (`${callback.origin}${callback.pathname}` !== callbackUrl || callback.searchParams.get('state') !== state) {
              throw new Error('External RP callback does not match its transaction');
            }
            const code = callback.searchParams.get('code');
            if (!code || callback.searchParams.has('error')) throw new Error('External RP callback did not grant authorization');
            const dpopKey = await generateDpopKeyPair();
            tokenRequests++;
            const token = await fetch(configuration.token_endpoint, { method: 'POST', headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              DPoP: await createDpopHeader(configuration.token_endpoint, 'POST', dpopKey),
            }, body: new URLSearchParams({ grant_type: 'authorization_code', code,
              client_id: clientId, redirect_uri: callbackUrl, code_verifier: verifier }) });
            if (token.status !== 200) throw new Error(`External RP authorization-code exchange failed: ${token.status}`);
            const tokens = await token.json() as { access_token: string; id_token: string; token_type: string };
            if (tokens.token_type.toLowerCase() !== 'dpop') throw new Error('External RP expected a DPoP-bound access token');
            const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()) as { webid?: string; sub: string; iss: string };
            const authenticatedFetch = await buildAuthenticatedFetch(tokens.access_token, { dpopKey, fetch });
            return { authenticatedFetch, webId: claims.webid ?? claims.sub, issuer: claims.iss, tokenStatus: token.status };
          },
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
