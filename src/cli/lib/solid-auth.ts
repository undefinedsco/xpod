/**
 * Solid OIDC authentication helpers for CLI.
 *
 * Uses client_credentials grant to obtain an access token from the
 * CSS OIDC token endpoint, so CLI commands can access Pod resources
 * without email/password.
 */

export interface SolidTokenResult {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
}

/**
 * Discover the OIDC token endpoint from the server's openid-configuration.
 */
async function discoverTokenEndpoint(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}.well-known/openid-configuration`);
    if (!res.ok) return null;
    const data = (await res.json()) as { token_endpoint?: string };
    return data.token_endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Exchange client credentials for an access token via the OIDC token endpoint.
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  baseUrl: string,
): Promise<SolidTokenResult | null> {
  const tokenEndpoint = await discoverTokenEndpoint(baseUrl);
  if (!tokenEndpoint) {
    return null;
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    if (!data.access_token) return null;

    const expiresIn = data.expires_in ?? 3600;
    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? 'Bearer',
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Perform an authenticated fetch using a Bearer access token.
 */
export async function authenticatedFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
