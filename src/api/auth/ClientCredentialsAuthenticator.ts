import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';
import { SolidSessionError, type SolidSession, type SolidSessionFactory } from './SolidSessionFactory';

export interface ClientCredentialsAuthenticatorOptions {
  /**
   * Shared Solid session factory. Inbound bearer credentials and outbound Pod access resolve to
   * the same session, so a credential is exchanged for a token only once.
   */
  sessions: SolidSessionFactory;
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
  private readonly sessions: SolidSessionFactory;

  public constructor(options: ClientCredentialsAuthenticatorOptions) {
    this.sessions = options.sessions;
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

      // One exchange per credential: the factory keeps the token together with the DPoP key it
      // is bound to, so outbound Pod access reuses this session instead of exchanging again.
      let session: SolidSession;
      try {
        session = await this.sessions.session({ clientId, clientSecret });
      } catch (error) {
        const status = error instanceof SolidSessionError ? error.status : undefined;
        const unavailable = status === undefined || status >= 500;
        this.logger.warn(`Client credentials exchange failed for ${clientId.slice(0, 8)}...: ${String(error)}`);
        return unavailable
          ? { success: false, error: 'Token exchange temporarily unavailable', category: 'service_unavailable', statusCode: 503, cause: error }
          : { success: false, error: `Token exchange failed: ${status ?? 'unknown'}`, cause: error };
      }
      if (!session.webId) {
        return { success: false, error: 'Could not determine webId from token response' };
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId: session.webId,
        accountId: session.webId,
        clientId,
        clientSecret,
        accessToken: session.accessToken,
        tokenType: session.tokenType,
        viaApiKey: true,
      };

      this.logger.debug(`Authenticated client credentials for webId: ${session.webId}`);
      return { success: true, context };
    } catch (error) {
      this.logger.error(`Client credentials authentication error: ${error}`);
      return { success: false, error: 'Authentication failed' };
    }
  }
}
