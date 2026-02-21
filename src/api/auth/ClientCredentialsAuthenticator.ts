import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';

/**
 * Interface for token cache
 */
export interface TokenCache {
  get(clientId: string): Promise<{ token: string; webId: string; expiresAt: Date } | undefined>;
  set(clientId: string, token: string, webId: string, expiresAt: Date): Promise<void>;
}

export interface ClientCredentialsAuthenticatorOptions {
  tokenCache?: TokenCache;
  /**
   * CSS token endpoint URL
   */
  tokenEndpoint: string;
}

/**
 * Authenticator for API Keys in sk-xxx format.
 * 
 * Format: sk-base64(client_id:client_secret)
 * 
 * This authenticator:
 * 1. Decodes the API Key to get client_id and client_secret
 * 2. Exchanges them for a Solid Token via CSS token endpoint
 * 3. Extracts webId from the token response
 * 4. Returns a SolidAuthContext
 */
export class ClientCredentialsAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly tokenCache?: TokenCache;
  private readonly tokenEndpoint: string;

  public constructor(options: ClientCredentialsAuthenticatorOptions) {
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
    // Only handle sk-xxx format or non-JWT tokens
    return token.startsWith('sk-') || !this.isJwt(token);
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return { success: false, error: 'Missing Bearer token' };
    }

    const token = authorization.slice(7).trim();
    if (!token) {
      return { success: false, error: 'Empty API Key' };
    }

    try {
      let clientId: string;
      let clientSecret: string;

      // Parse sk-xxx format (base64 encoded client_id:client_secret)
      if (token.startsWith('sk-')) {
        const base64 = token.slice(3);
        try {
          const decoded = Buffer.from(base64, 'base64').toString('utf-8');
          const colonIndex = decoded.indexOf(':');
          if (colonIndex === -1) {
            return { success: false, error: 'Invalid API Key format: missing colon separator' };
          }
          clientId = decoded.slice(0, colonIndex);
          clientSecret = decoded.slice(colonIndex + 1);
          
          if (!clientId || !clientSecret) {
            return { success: false, error: 'Invalid API Key format: empty client_id or client_secret' };
          }
        } catch {
          return { success: false, error: 'Invalid API Key encoding' };
        }
      } else {
        // Non sk- format not supported without database lookup
        return { success: false, error: 'Invalid API Key format: must start with sk-' };
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
              webId: cached.webId,
              accountId: cached.webId,
              clientId,
              clientSecret,
              viaApiKey: true,
            },
          };
        }
      }

      // Exchange for token at CSS endpoint
      console.log(`[ClientCredentialsAuthenticator] Exchanging credentials at ${this.tokenEndpoint}`);
      const tokenResult = await this.exchangeForToken(clientId, clientSecret);
      console.log(`[ClientCredentialsAuthenticator] Token exchange result: success=${tokenResult.success}, webId=${tokenResult.webId}, error=${tokenResult.error}`);
      
      if (!tokenResult.success || !tokenResult.webId) {
        return { success: false, error: tokenResult.error || 'Token exchange failed' };
      }

      // Cache the token
      if (this.tokenCache && tokenResult.expiresAt) {
        await this.tokenCache.set(clientId, tokenResult.token!, tokenResult.webId, tokenResult.expiresAt);
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId: tokenResult.webId,
        accountId: tokenResult.webId,
        clientId,
        clientSecret,
        viaApiKey: true,
      };

      this.logger.debug(`Authenticated API Key for webId: ${tokenResult.webId}`);
      return { success: true, context };
    } catch (error) {
      console.error(`[ClientCredentialsAuthenticator] API Key authentication error:`, error);
      this.logger.error(`API Key authentication error: ${error}`);
      return { success: false, error: 'Authentication failed' };
    }
  }

  private async exchangeForToken(clientId: string, clientSecret: string): Promise<{
    success: boolean;
    token?: string;
    webId?: string;
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
        return { success: false, error: `Token exchange failed: ${response.status}` };
      }

      const data = await response.json() as {
        access_token: string;
        expires_in?: number;
        token_type: string;
        webid?: string;  // CSS returns webid in response
      };

      // Extract webId from token response or decode from JWT
      let webId = data.webid;
      if (!webId && data.access_token) {
        webId = this.extractWebIdFromJwt(data.access_token);
      }

      if (!webId) {
        return { success: false, error: 'Could not determine webId from token response' };
      }

      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000 - 60000) // 1 min buffer
        : new Date(Date.now() + 3600000); // Default 1 hour

      return {
        success: true,
        token: data.access_token,
        webId,
        expiresAt,
      };
    } catch (error) {
      this.logger.error(`Token exchange error: ${error}`);
      return { success: false, error: 'Token exchange failed' };
    }
  }

  /**
   * Extract webId from JWT access token
   */
  private extractWebIdFromJwt(jwt: string): string | undefined {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) {
        return undefined;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
      return payload.webid || payload.webId || payload.sub;
    } catch {
      return undefined;
    }
  }

  private isJwt(token: string): boolean {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  }
}

// Re-export for backwards compatibility (these are no longer needed but keep for other code)
export interface ClientCredentialsRecord {
  clientId: string;
  webId: string;
  accountId: string;
  displayName?: string;
  createdAt: Date;
}

export interface ClientCredentialsStore {
  findByClientId(clientId: string): Promise<ClientCredentialsRecord | undefined>;
}
