import type { IncomingMessage } from 'node:http';
import {
  createDpopHeader,
  generateDpopKeyPair,
} from '@inrupt/solid-client-authn-core';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';
import { extractAuthoritativeWebIdFromTokenResponse } from './TokenIdentity';

/**
 * Interface for token cache
 */
export interface TokenCache {
  get(clientId: string): Promise<{
    token: string;
    tokenType?: 'Bearer' | 'DPoP';
    webId: string;
    expiresAt: Date;
  } | undefined>;
  set(
    clientId: string,
    token: string,
    webId: string,
    expiresAt: Date,
    tokenType?: 'Bearer' | 'DPoP',
  ): Promise<void>;
}

export interface ClientCredentialsAuthenticatorOptions {
  tokenCache?: TokenCache;
  /**
   * CSS token endpoint URL
   */
  tokenEndpoint: string;
  /** Canonical CSS URL represented by an internal token endpoint. */
  publicBaseUrl?: string;
}

/**
 * Authenticator for CSS client credentials wrapped in sk-xxx transport format.
 * 
 * Format: sk-base64(client_id:client_secret)
 * 
 * This authenticator:
 * 1. Decodes the wrapper to get client_id and client_secret
 * 2. Exchanges them for a Solid Token via CSS token endpoint
 * 3. Extracts webId from the token response
 * 4. Returns a SolidAuthContext
 */
export class ClientCredentialsAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly tokenCache?: TokenCache;
  private readonly tokenEndpoint: string;
  private readonly tokenEndpointHeaders: Record<string, string>;
  private readonly tokenEndpointProofUrl: string;

  public constructor(options: ClientCredentialsAuthenticatorOptions) {
    this.tokenCache = options.tokenCache;
    this.tokenEndpoint = options.tokenEndpoint;
    this.tokenEndpointHeaders = tokenEndpointRoutingHeaders(options.tokenEndpoint, options.publicBaseUrl);
    this.tokenEndpointProofUrl = tokenEndpointProofUrl(
      options.tokenEndpoint,
      options.publicBaseUrl,
      this.tokenEndpointHeaders,
    );
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return false;
    }
    // If there's a DPoP header, it's a Solid Token, not a client credentials wrapper.
    if (request.headers.dpop) {
      return false;
    }
    const token = auth.slice(7).trim();
    if (!token) {
      return false;
    }
    // Xpod coding-client API keys are CSS client credentials wrapped as
    // sk-base64(client_id:client_secret). Other bearer formats must be left
    // for their owning authenticators or rejected by the auth chain.
    return token.startsWith('sk-');
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return { success: false, error: 'Missing Bearer token' };
    }

    const token = authorization.slice(7).trim();
    if (!token) {
      return { success: false, error: 'Empty client credentials wrapper' };
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
            return { success: false, error: 'Invalid client credentials wrapper: missing colon separator' };
          }
          clientId = decoded.slice(0, colonIndex);
          clientSecret = decoded.slice(colonIndex + 1);
          
          if (!clientId || !clientSecret) {
            return { success: false, error: 'Invalid client credentials wrapper: empty client_id or client_secret' };
          }
        } catch {
          return { success: false, error: 'Invalid client credentials wrapper encoding' };
        }
      } else {
        // Non sk- format is intentionally unsupported; Xpod does not keep an API key mirror table.
        return { success: false, error: 'Invalid client credentials wrapper: must start with sk-' };
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
              accessToken: cached.token,
              tokenType: cached.tokenType ?? 'Bearer',
              viaApiKey: true,
            },
          };
        }
      }

      // Exchange for token at CSS endpoint
      this.logger.debug(`Exchanging client credentials at ${this.tokenEndpoint}`);
      const tokenResult = await this.exchangeForToken(clientId, clientSecret);
      this.logger.debug(`Token exchange result: success=${tokenResult.success}, webId=${tokenResult.webId}, error=${tokenResult.error}`);
      
      if (!tokenResult.success || !tokenResult.webId || !tokenResult.token) {
        return { success: false, error: tokenResult.error || 'Token exchange failed' };
      }

      // Cache the token
      if (this.tokenCache && tokenResult.expiresAt) {
        await this.tokenCache.set(
          clientId,
          tokenResult.token!,
          tokenResult.webId,
          tokenResult.expiresAt,
          tokenResult.tokenType,
        );
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId: tokenResult.webId,
        accountId: tokenResult.webId,
        clientId,
        clientSecret,
        accessToken: tokenResult.token,
        tokenType: tokenResult.tokenType ?? 'Bearer',
        viaApiKey: true,
      };

      this.logger.debug(`Authenticated client credentials for webId: ${tokenResult.webId}`);
      return { success: true, context };
    } catch (error) {
      this.logger.error(`Client credentials authentication error: ${error}`);
      return { success: false, error: 'Authentication failed' };
    }
  }

  private async exchangeForToken(clientId: string, clientSecret: string): Promise<{
    success: boolean;
    token?: string;
    tokenType?: 'Bearer' | 'DPoP';
    webId?: string;
    expiresAt?: Date;
    error?: string;
  }> {
    try {
      const dpopKey = await generateDpopKeyPair();
      const response = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
          DPoP: await createDpopHeader(this.tokenEndpointProofUrl, 'POST', dpopKey),
          ...this.tokenEndpointHeaders,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'webid',
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
      const webId = extractAuthoritativeWebIdFromTokenResponse(data);

      if (!webId) {
        return { success: false, error: 'Could not determine webId from token response' };
      }

      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000 - 60000) // 1 min buffer
        : new Date(Date.now() + 3600000); // Default 1 hour

      return {
        success: true,
        token: data.access_token,
        tokenType: data.token_type?.toUpperCase() === 'DPOP' ? 'DPoP' : 'Bearer',
        webId,
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

function tokenEndpointRoutingHeaders(tokenEndpoint: string, publicBaseUrl: string | undefined): Record<string, string> {
  if (!publicBaseUrl) return {};
  try {
    const internal = new URL(tokenEndpoint);
    const canonical = new URL(publicBaseUrl);
    if (internal.origin === canonical.origin || !isLoopbackHostname(internal.hostname)) return {};
    return {
      'X-Forwarded-Host': canonical.host,
      'X-Forwarded-Proto': canonical.protocol.slice(0, -1),
    };
  } catch {
    return {};
  }
}

function tokenEndpointProofUrl(
  tokenEndpoint: string,
  publicBaseUrl: string | undefined,
  routingHeaders: Record<string, string>,
): string {
  if (!publicBaseUrl || Object.keys(routingHeaders).length === 0) return tokenEndpoint;
  return new URL('/.oidc/token', publicBaseUrl).toString();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
