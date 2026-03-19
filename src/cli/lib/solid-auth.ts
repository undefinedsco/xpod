/**
 * Solid OIDC authentication helpers for CLI.
 *
 * Two auth channels:
 * 1. Session (via @inrupt/solid-client-authn-node) — for Pod operations (drizzle-solid)
 * 2. API Key (sk-xxx format) — for xpod API calls (LLM proxy, etc.)
 *
 * The API key is derived from client_id:client_secret and used by xpod's
 * ClientCredentialsAuthenticator to authenticate API requests.
 */

import { Session } from '@inrupt/solid-client-authn-node';

export { Session } from '@inrupt/solid-client-authn-node';

export interface PodAuth {
  session: Session;   // For Pod operations (drizzle-solid)
  apiKey: string;     // For xpod API calls (sk-xxx format)
}

/**
 * Authenticate with the Pod server.
 *
 * Returns both a Session (for Pod CRUD) and an API key (for xpod API).
 */
export async function authenticate(
  clientId: string,
  clientSecret: string,
  oidcIssuer: string,
): Promise<PodAuth> {
  // 1. Create Session for Pod operations
  const session = new Session();
  await session.login({
    clientId,
    clientSecret,
    oidcIssuer,
    tokenType: 'Bearer',
  });

  if (!session.info.isLoggedIn) {
    throw new Error('Failed to authenticate with Pod');
  }

  // 2. Generate API key for xpod API calls
  // Format: sk-base64(client_id:client_secret)
  const credentials = `${clientId}:${clientSecret}`;
  const base64 = Buffer.from(credentials, 'utf-8').toString('base64');
  const apiKey = `sk-${base64}`;

  return { session, apiKey };
}

// ============================================================================
// Legacy API — used by subcommands (backup, config) not yet migrated
// ============================================================================

export interface SolidTokenResult {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
}

/** @deprecated Use authenticate() instead. */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  baseUrl: string,
): Promise<SolidTokenResult | null> {
  try {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const res = await fetch(`${base}.well-known/openid-configuration`);
    if (!res.ok) return null;
    const config = (await res.json()) as { token_endpoint?: string };
    if (!config.token_endpoint) return null;

    const tokenRes = await fetch(config.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!tokenRes.ok) return null;
    const data = (await tokenRes.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    };
  } catch {
    return null;
  }
}

/** @deprecated Use session.fetch() from authenticate() instead. */
export async function authenticatedFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
