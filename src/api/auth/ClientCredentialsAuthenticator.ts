import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';

/**
 * Stored client credentials record
 */
export interface ClientCredentialsRecord {
  clientId: string;
  clientSecret: string;  // Encrypted
  webId: string;
  accountId: string;
  displayName?: string;
  createdAt: Date;
}

/**
 * Interface for client credentials storage
 */
export interface ClientCredentialsStore {
  /**
   * Find by client_id
   */
  findByClientId(clientId: string): Promise<ClientCredentialsRecord | undefined>;
}

/**
 * Interface for token cache
 */
export interface TokenCache {
  get(clientId: string): Promise<{ token: string; expiresAt: Date } | undefined>;
  set(clientId: string, token: string, expiresAt: Date): Promise<void>;
}

export interface ClientCredentialsAuthenticatorOptions {
  store: ClientCredentialsStore;
  tokenCache?: TokenCache;
  /**
   * CSS token endpoint URL
   */
  tokenEndpoint: string;
}

/**
 * Authenticator for API Keys that are actually CSS client credentials.
 * 
 * When a third-party provides an API Key (client_id), this authenticator:
 * 1. Looks up the stored client_secret
 * 2. Exchanges client_id + secret for a Solid Token via CSS
 * 3. Returns a SolidAuthContext (same as direct Solid Token auth)
 */
export class ClientCredentialsAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly store: ClientCredentialsStore;
  private readonly tokenCache?: TokenCache;
  private readonly tokenEndpoint: string;

  public constructor(options: ClientCredentialsAuthenticatorOptions) {
    this.store = options.store;
    this.tokenCache = options.tokenCache;
    this.tokenEndpoint = options.tokenEndpoint;
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return false;
    }
    // If there's a DPoP header, it's a Solid Token, not an API Key
    if (request.headers.dpop) {
      return false;
    }
    const token = auth.slice(7).trim();
    if (!token) {
      return false;
    }
    return !this.isJwt(token);
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return { success: false, error: 'Missing Bearer token' };
    }

    const clientId = authorization.slice(7).trim();
    if (!clientId) {
      return { success: false, error: 'Empty API Key' };
    }

    try {
      // Look up stored credentials
      const record = await this.store.findByClientId(clientId);
      if (!record) {
        this.logger.warn(`API Key not found: ${clientId.slice(0, 8)}...`);
        return { success: false, error: 'Invalid API Key' };
      }

      // Check cache first
      if (this.tokenCache) {
        const cached = await this.tokenCache.get(clientId);
        if (cached && cached.expiresAt > new Date()) {
          this.logger.debug(`Using cached token for ${clientId.slice(0, 8)}...`);
          return {
            success: true,
            context: {
              type: 'solid',
              webId: record.webId,
              accountId: record.accountId,
              clientId,
              displayName: record.displayName,
            },
          };
        }
      }

      // Exchange for token
      const tokenResult = await this.exchangeForToken(record.clientId, record.clientSecret);
      if (!tokenResult.success) {
        return { success: false, error: tokenResult.error };
      }

      // Cache the token
      if (this.tokenCache && tokenResult.expiresAt) {
        await this.tokenCache.set(clientId, tokenResult.token!, tokenResult.expiresAt);
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId: record.webId,
        accountId: record.accountId,
        clientId,
        displayName: record.displayName,
        viaApiKey: true,
      };

      this.logger.debug(`Authenticated API Key for webId: ${record.webId}`);
      return { success: true, context };
    } catch (error) {
      this.logger.error(`API Key authentication error: ${error}`);
      return { success: false, error: 'Authentication failed' };
    }
  }

  private async exchangeForToken(clientId: string, clientSecret: string): Promise<{
    success: boolean;
    token?: string;
    expiresAt?: Date;
    error?: string;
  }> {
    // 开发模式：跳过 CSS token exchange
    if (process.env.NODE_ENV === 'development') {
      this.logger.warn(`[DEV] Skipping token exchange for ${clientId.slice(0, 8)}...`);
      return {
        success: true,
        token: `dev-token-${clientId}`,
        expiresAt: new Date(Date.now() + 3600000),
      };
    }

    try {
      const response = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.warn(`Token exchange failed: ${response.status} ${error}`);
        return { success: false, error: 'Token exchange failed' };
      }

      const data = await response.json() as {
        access_token: string;
        expires_in?: number;
        token_type: string;
      };

      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000 - 60000) // 1 min buffer
        : new Date(Date.now() + 3600000); // Default 1 hour

      return {
        success: true,
        token: data.access_token,
        expiresAt,
      };
    } catch (error) {
      this.logger.error(`Token exchange error: ${error}`);
      return { success: false, error: 'Token exchange failed' };
    }
  }

  private isJwt(token: string): boolean {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  }
}
