import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';

/** API Key prefix */
const API_KEY_PREFIX = 'sk-';

export interface ClientCredentialsAuthenticatorOptions {
  /**
   * CSS token endpoint URL
   */
  tokenEndpoint: string;
}

/**
 * Authenticator for CSS client credentials via API Key.
 * 
 * API Key format: sk-{base64(client_id:client_secret)}
 * 
 * Usage:
 *   Authorization: Bearer sk-xxxxxxxx
 * 
 * This is compatible with OpenAI-style API calls.
 * No storage needed - credentials are encoded in the API Key itself.
 */
export class ClientCredentialsAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly tokenEndpoint: string;

  public constructor(options: ClientCredentialsAuthenticatorOptions) {
    this.tokenEndpoint = options.tokenEndpoint;
  }

  /**
   * Generate an API Key from client credentials.
   * Format: sk-{base64(client_id:client_secret)}
   */
  public static generateApiKey(clientId: string, clientSecret: string): string {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return `${API_KEY_PREFIX}${encoded}`;
  }

  /**
   * Parse an API Key to extract client credentials.
   * Returns null if the key format is invalid.
   */
  public static parseApiKey(apiKey: string): { clientId: string; clientSecret: string } | null {
    if (!apiKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }

    const base64 = apiKey.slice(API_KEY_PREFIX.length);
    try {
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      const colonIndex = decoded.indexOf(':');
      if (colonIndex === -1) {
        return null;
      }

      const clientId = decoded.slice(0, colonIndex);
      const clientSecret = decoded.slice(colonIndex + 1);

      if (!clientId || !clientSecret) {
        return null;
      }

      return { clientId, clientSecret };
    } catch {
      return null;
    }
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return false;
    }
    // Only handle Bearer tokens that look like our API Keys (sk-xxx)
    const token = auth.slice(7).trim();
    return token.startsWith(API_KEY_PREFIX);
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return { success: false, error: 'Missing Bearer token' };
    }

    const apiKey = authorization.slice(7).trim();
    const credentials = ClientCredentialsAuthenticator.parseApiKey(apiKey);
    
    if (!credentials) {
      return { success: false, error: 'Invalid API Key format' };
    }

    const { clientId, clientSecret } = credentials;

    try {
      // Exchange for token
      const tokenResult = await this.exchangeForToken(clientId, clientSecret);
      if (!tokenResult.success) {
        return { success: false, error: tokenResult.error };
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId: tokenResult.webId!,
        accountId: tokenResult.webId!, // Use webId as accountId
        clientId,
        clientSecret,
        viaApiKey: true,
      };

      this.logger.debug(`Authenticated API Key for webId: ${tokenResult.webId}`);
      return { success: true, context };
    } catch (error) {
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
        return { success: false, error: 'Invalid credentials' };
      }

      const data = await response.json() as {
        access_token: string;
        expires_in?: number;
        token_type: string;
        id_token?: string;
      };

      // Extract webId from id_token if present, or decode from access_token
      let webId: string | undefined;
      
      // Try to get webId from id_token
      if (data.id_token) {
        try {
          const payload = JSON.parse(
            Buffer.from(data.id_token.split('.')[1], 'base64').toString('utf8')
          );
          webId = payload.webid || payload.sub;
        } catch {
          // Ignore decode errors
        }
      }

      // Fallback: try access_token
      if (!webId && data.access_token) {
        try {
          const payload = JSON.parse(
            Buffer.from(data.access_token.split('.')[1], 'base64').toString('utf8')
          );
          webId = payload.webid || payload.sub;
        } catch {
          // Ignore decode errors
        }
      }

      if (!webId) {
        return { success: false, error: 'Cannot determine webId from token' };
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
}
