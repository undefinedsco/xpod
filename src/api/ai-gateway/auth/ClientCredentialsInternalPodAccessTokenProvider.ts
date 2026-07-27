import type { InternalPodAccessTokenProvider } from './PodGatewayAccessKeyRepository';
import { extractAuthoritativeWebIdFromTokenResponse } from '../../auth/TokenIdentity';

export interface ClientCredentialsInternalPodAccessTokenProviderOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type CachedToken = {
  accessToken: string;
  webId: string;
  expiresAt: number;
};

export class ClientCredentialsInternalPodAccessTokenProvider implements InternalPodAccessTokenProvider {
  private readonly tokenEndpoint: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedToken?: CachedToken;
  private tokenRequest?: Promise<CachedToken>;
  private serviceWebId?: string;

  public constructor(options: ClientCredentialsInternalPodAccessTokenProviderOptions) {
    if (!options.clientId.trim() || !options.clientSecret.trim()) {
      throw new Error('Gateway internal Pod access client credentials are required');
    }
    this.tokenEndpoint = options.tokenEndpoint;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async getTrustedFetch(_owner: string): Promise<typeof fetch | undefined> {
    const token = await this.getAccessToken();
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token.accessToken}`);
      }
      return this.fetchImpl(input, { ...init, headers });
    };
  }

  public async getServicePrincipal(): Promise<{ webId: string }> {
    const token = await this.getAccessToken();
    return { webId: token.webId };
  }

  private async getAccessToken(): Promise<CachedToken> {
    const now = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 30_000 > now) {
      return this.cachedToken;
    }
    if (this.tokenRequest) {
      return this.tokenRequest;
    }

    this.tokenRequest = this.exchangeToken(now);
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async exchangeToken(now: number): Promise<CachedToken> {
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'webid',
      }),
    });
    if (!response.ok) {
      throw new Error(`Gateway internal Pod token exchange failed: HTTP ${response.status}`);
    }
    const body = await response.json() as Record<string, unknown>;
    const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
    if (!accessToken) {
      throw new Error('Gateway internal Pod token response missing access_token');
    }
    if (body.token_type !== 'Bearer') {
      throw new Error('Gateway internal service token must be Bearer');
    }
    const tokenWebId = extractAuthoritativeWebIdFromTokenResponse(body);
    if (!tokenWebId) {
      throw new Error('Gateway internal Pod token response missing authoritative WebID');
    }
    if (this.serviceWebId && tokenWebId !== this.serviceWebId) {
      throw new Error('Gateway internal service WebID changed');
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 300;
    const token: CachedToken = {
      accessToken,
      webId: tokenWebId,
      expiresAt: now + expiresIn * 1000,
    };
    this.serviceWebId = tokenWebId;
    this.cachedToken = token;
    return token;
  }
}
