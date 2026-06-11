import { getAccessToken, authenticatedFetch, refreshOidcAccessToken } from './solid-auth';
import {
  getClientCredentials,
  getOAuthCredentials,
  loadCredentials,
  isOidcOAuth,
  type StoredCredentials,
} from './credentials-store';
import { CliCommandError } from './output';

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
} = {}): Promise<CliAuthContext> {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new CliCommandError(
      'auth_required',
      'No credentials found. Run \`xpod auth login\` first.',
      2,
    );
  }

  const baseUrl = normalizeBaseUrl(options.url ?? credentials.url);
  let accessToken: string;

  if (isOidcOAuth(credentials.secrets)) {
    // OIDC OAuth flow — use stored access token, refresh if expired
    const oauthSecrets = getOAuthCredentials(credentials)!;

    // Check if token is expired (with 5-minute buffer)
    const expiresAt = new Date(oauthSecrets.oidcExpiresAt);
    const isExpired = Date.now() >= expiresAt.getTime() - 5 * 60 * 1000;

    if (isExpired) {
      const clientId = oauthSecrets.oidcClientId;
      if (!clientId) {
        throw new CliCommandError(
          'auth_failed',
          'OIDC access token is expired and no clientId is available for refresh. Run \`linx auth login\` again.',
          2,
        );
      }
      const refreshed = await refreshOidcAccessToken(
        normalizeBaseUrl(credentials.url),
        oauthSecrets.oidcRefreshToken,
        clientId,
      );
      if (!refreshed) {
        throw new CliCommandError(
          'auth_failed',
          'Failed to refresh OIDC access token. The refresh token may have expired. Run \`linx auth login\` or \`xpod auth login\` again.',
          2,
        );
      }
      accessToken = refreshed.accessToken;
    } else {
      accessToken = oauthSecrets.oidcAccessToken;
    }
  } else {
    // Client credentials flow
    const clientCredentials = getClientCredentials(credentials);
    if (!clientCredentials) {
      throw new CliCommandError(
        'auth_unsupported',
        'Unsupported credentials format. Run \`xpod auth login\` to create client credentials.',
        2,
      );
    }

    const tokenResult = await getAccessToken(
      clientCredentials.clientId,
      clientCredentials.clientSecret,
      baseUrl,
    );
    if (!tokenResult) {
      throw new CliCommandError(
        'auth_failed',
        'Failed to obtain an access token. Run \`xpod auth login\` again.',
        2,
      );
    }
    accessToken = tokenResult.accessToken;
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
  return authenticatedFetch(url, context.accessToken, init);
}
