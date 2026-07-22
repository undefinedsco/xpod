import type { InternalPodAccessTokenProvider } from './PodGatewayAccessKeyRepository';

export interface ClientCredentialsInternalPodAccessTokenProviderOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

type CachedToken = {
  accessToken: string;
  tokenType: 'Bearer' | 'DPoP';
  expiresAt: number;
};

export class ClientCredentialsInternalPodAccessTokenProvider implements InternalPodAccessTokenProvider {
  private readonly tokenEndpoint: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CachedToken>();

  public constructor(options: ClientCredentialsInternalPodAccessTokenProviderOptions) {
    if (!options.clientId.trim() || !options.clientSecret.trim()) {
      throw new Error('Gateway internal Pod access client credentials are required');
    }
    this.tokenEndpoint = options.tokenEndpoint;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async getTrustedFetch(owner: string): Promise<typeof fetch | undefined> {
    const token = await this.getAccessToken(owner);
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
      }
      return this.fetchImpl(input, { ...init, headers });
    };
  }

  private async getAccessToken(owner: string): Promise<CachedToken> {
    const cached = this.cache.get(owner);
    const now = Date.now();
    if (cached && cached.expiresAt - 30_000 > now) {
      return cached;
    }

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
        webid: owner,
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
    const tokenType: CachedToken['tokenType'] = body.token_type === 'DPoP' ? 'DPoP' : 'Bearer';
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 300;
    const token: CachedToken = {
      accessToken,
      tokenType,
      expiresAt: now + expiresIn * 1000,
    };
    this.cache.set(owner, token);
    return token;
  }
}
