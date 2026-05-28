import { getAccessToken, authenticatedFetch } from './solid-auth';
import {
  getClientCredentials,
  loadCredentials,
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
      'No credentials found. Run `xpod auth login` first.',
      2,
    );
  }

  const clientCredentials = getClientCredentials(credentials);
  if (!clientCredentials) {
    throw new CliCommandError(
      'auth_unsupported',
      'Stored OAuth credentials are not supported for CLI resource operations yet. Run `xpod auth login` to create client credentials.',
      2,
    );
  }

  const baseUrl = normalizeBaseUrl(options.url ?? credentials.url);
  const tokenResult = await getAccessToken(
    clientCredentials.clientId,
    clientCredentials.clientSecret,
    baseUrl,
  );
  if (!tokenResult) {
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
    accessToken: tokenResult.accessToken,
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
