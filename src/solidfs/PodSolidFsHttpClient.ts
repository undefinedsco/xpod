import type { AuthContext, SolidAuthContext } from '../api/auth/AuthContext';
import { isSolidAuth } from '../api/auth/AuthContext';
import type { StoreContext } from '../api/chatkit/store';
import type { SolidFsManifest } from './types';

export interface PodSolidFsHttpClientOptions {
  fetch?: typeof fetch;
  tokenEndpoint?: string;
}

export class PodSolidFsHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenEndpoint?: string;

  public constructor(options: PodSolidFsHttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.tokenEndpoint = options.tokenEndpoint ?? resolveDefaultTokenEndpoint();
  }

  public async request(input: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }

  public async createAuthHeaders(context: unknown, operation: string): Promise<Headers> {
    const auth = solidAuthFromContext(context);
    if (!auth) {
      throw new Error(`Cannot ${operation} without Solid auth context`);
    }

    const headers = new Headers();
    if (auth.accessToken) {
      headers.set('Authorization', `${auth.tokenType ?? 'Bearer'} ${auth.accessToken}`);
      return headers;
    }

    const token = await this.exchangeClientCredentials(auth);
    headers.set('Authorization', `${token.tokenType ?? 'Bearer'} ${token.accessToken}`);
    return headers;
  }

  private async exchangeClientCredentials(auth: SolidAuthContext): Promise<{ accessToken: string; tokenType?: 'Bearer' | 'DPoP' }> {
    if (!this.tokenEndpoint) {
      throw new Error('Cannot access Pod HTTP resource with client credentials because CSS token endpoint is not configured');
    }
    if (!auth.clientId || !auth.clientSecret) {
      throw new Error('Cannot access Pod HTTP resource without access token or Solid client credentials');
    }
    const response = await this.request(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`SolidFS token exchange failed: ${response.status} ${await response.text().catch(() => '')}`);
    }
    const token = await response.json() as { access_token?: string; token_type?: string };
    if (!token.access_token) {
      throw new Error(`SolidFS token exchange response missing access_token: ${JSON.stringify(token)}`);
    }
    return {
      accessToken: token.access_token,
      tokenType: token.token_type?.toUpperCase() === 'DPOP' ? 'DPoP' : 'Bearer',
    };
  }
}

export function resolvePodWorkspaceResourceUrl(relativePath: string, workspace: SolidFsManifest): string | undefined {
  try {
    const base = new URL(workspace.workspace.endsWith('/') ? workspace.workspace : `${workspace.workspace}/`);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return undefined;
    }
    return new URL(normalizePodRelativePath(relativePath), base).href;
  } catch {
    return undefined;
  }
}

export function solidAuthFromContext(context: unknown): SolidAuthContext | undefined {
  const auth = (context as StoreContext | undefined)?.auth as AuthContext | undefined;
  return auth && isSolidAuth(auth) ? auth : undefined;
}

function normalizePodRelativePath(input: string): string {
  const parts = input.split(/[\\/]+/u).filter((part) => part.length > 0);
  if (input.startsWith('/') || parts.length === 0 || parts.includes('..')) {
    throw new Error(`Invalid Pod resource relative path: ${input}`);
  }
  return parts.join('/');
}

function resolveDefaultTokenEndpoint(): string | undefined {
  if (process.env.CSS_TOKEN_ENDPOINT) {
    return process.env.CSS_TOKEN_ENDPOINT;
  }
  if (process.env.CSS_BASE_URL) {
    return new URL('.oidc/token', process.env.CSS_BASE_URL.endsWith('/') ? process.env.CSS_BASE_URL : `${process.env.CSS_BASE_URL}/`).href;
  }
  return undefined;
}
