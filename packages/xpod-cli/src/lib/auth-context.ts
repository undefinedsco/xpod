import { getAccessToken, authenticatedFetch, type SolidTokenResult } from './solid-auth';
import {
  getClientCredentials,
  getOAuthCredentials,
  loadCredentials,
  type StoredCredentials,
} from './credentials-store';
import { getOidcAccessToken, TOKEN_EXPIRY_SKEW_MS } from './oidc-auth';
import { CliCommandError } from './output';

interface ClientTokenState {
  key: string;
  token?: SolidTokenResult;
  pending?: Promise<SolidTokenResult | null>;
}

// A long-lived mount reuses only its current credential generation, in memory.
let clientTokenState: ClientTokenState | undefined;

function clientTokenKey(credentials: StoredCredentials, baseUrl: string): string | undefined {
  const client = getClientCredentials(credentials);
  return client ? JSON.stringify([
    baseUrl, normalizeBaseUrl(credentials.url), credentials.webId, credentials.authType,
    client.clientId, client.clientSecret,
  ]) : undefined;
}

function isReusableClientToken(token: SolidTokenResult | undefined): token is SolidTokenResult {
  const expiresAt = token?.expiresAt.getTime();
  return expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

async function getClientToken(
  credentials: StoredCredentials,
  baseUrl: string,
  forceRefresh = false,
): Promise<SolidTokenResult | null> {
  const client = getClientCredentials(credentials)!;
  const key = clientTokenKey(credentials, baseUrl)!;
  if (clientTokenState?.key !== key || (forceRefresh && clientTokenState.token)) {
    clientTokenState = { key };
  }
  const state = clientTokenState!;
  if (!forceRefresh && isReusableClientToken(state.token)) { return state.token; }
  if (state.pending) { return state.pending; }

  // Late 401s for an earlier token must not discard an exchange already in flight.
  state.token = undefined;
  state.pending = (async () => {
    const token = await getAccessToken(client.clientId, client.clientSecret, baseUrl);
    const current = loadCredentials();
    if (clientTokenState !== state || !current || clientTokenKey(current, baseUrl) !== key) {
      if (clientTokenState === state) { clientTokenState = undefined; }
      throw new CliCommandError('auth_changed', 'Credentials changed while authenticating. Retry with the current login.', 2);
    }
    if (isReusableClientToken(token ?? undefined)) { state.token = token!; }
    return token;
  })();
  try { return await state.pending; }
  finally { state.pending = undefined; }
}

export interface CliAuthContext {
  baseUrl: string;
  webId: string;
  podRoot: string;
  baseIri: string;
  accessToken: string;
  credentials: StoredCredentials;
}

export interface AuthStatus {
  authenticated: boolean;
  authType?: string;
  baseUrl?: string;
  webId?: string;
  podRoot?: string;
}

export function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function resolvePodRootFromWebId(webId: string): string {
  const webIdUrl = new URL(webId);
  const path = webIdUrl.pathname;
  const profileSuffix = '/profile/card';
  if (path.endsWith(profileSuffix)) {
    const podPath = path.slice(0, -profileSuffix.length);
    return `${webIdUrl.origin}${podPath.endsWith('/') ? podPath : `${podPath}/`}`;
  }

  const pathParts = path.split('/').filter(Boolean);
  if (pathParts.length > 0) {
    return `${webIdUrl.origin}/${pathParts[0]}/`;
  }
  return `${webIdUrl.origin}/`;
}

export function getStoredAuthStatus(urlOverride?: string): AuthStatus {
  const credentials = loadCredentials();
  if (!credentials) {
    clientTokenState = undefined;
    return { authenticated: false };
  }

  const baseUrl = normalizeBaseUrl(urlOverride ?? credentials.url);
  const podRoot = resolvePodRootFromWebId(credentials.webId);
  return {
    authenticated: true,
    authType: credentials.authType,
    baseUrl,
    webId: credentials.webId,
    podRoot,
  };
}

export async function requireAuthContext(options: {
  url?: string;
  json?: boolean;
  /**
   * Force a token refresh instead of reusing a still-valid cached token.
   * Used by the loopback bridge after an upstream 401; never on 403 (a 403 is
   * an authorization decision, not an expired session).
   */
  forceRefresh?: boolean;
} = {}): Promise<CliAuthContext> {
  const credentials = loadCredentials();
  if (!credentials) {
    clientTokenState = undefined;
    throw new CliCommandError(
      'auth_required',
      'No credentials found. Run `xpod auth login` first.',
      2,
    );
  }

  const baseUrl = normalizeBaseUrl(options.url ?? credentials.url);
  const clientCredentials = getClientCredentials(credentials);
  const oauthCredentials = getOAuthCredentials(credentials);
  let accessToken: string | null | undefined;
  if (clientCredentials) {
    accessToken = (await getClientToken(credentials, baseUrl, options.forceRefresh))?.accessToken;
  } else {
    clientTokenState = undefined;
    accessToken = oauthCredentials
      ? await getOidcAccessToken(credentials, { forceRefresh: options.forceRefresh }) : null;
  }

  if (!accessToken) {
    throw new CliCommandError(
      'auth_failed',
      'Failed to obtain an access token. Run `xpod auth login` again.',
      2,
    );
  }

  const podRoot = resolvePodRootFromWebId(credentials.webId);
  return {
    baseUrl,
    webId: credentials.webId,
    podRoot,
    baseIri: podRoot,
    accessToken,
    credentials,
  };
}

export async function authFetch(
  context: CliAuthContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await authenticatedFetch(url, context.accessToken, init);
  if (response.status === 401 && clientTokenState?.token?.accessToken === context.accessToken &&
      clientTokenState.key === clientTokenKey(context.credentials, context.baseUrl)) {
    clientTokenState = undefined;
  }
  return response;
}
