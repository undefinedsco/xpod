import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from '../auth/Authenticator';
import type { AuthContext } from '../auth/AuthContext';

/**
 * Extended request with auth context
 */
export interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthContext;
}

export interface AuthMiddlewareOptions {
  authenticator: Authenticator;
  /**
   * Paths that do not require authentication
   */
  publicPaths?: string[];
}

/**
 * Middleware that handles authentication for API requests
 */
export class AuthMiddleware {
  private readonly logger = getLoggerFor(this);
  private readonly authenticator: Authenticator;
  private readonly publicPaths: Set<string>;

  public constructor(options: AuthMiddlewareOptions) {
    this.authenticator = options.authenticator;
    this.publicPaths = new Set(options.publicPaths ?? []);
  }

  /**
   * Check if a path is public (does not require authentication)
   */
  public isPublicPath(path: string): boolean {
    // Normalize path by removing query string
    const normalizedPath = path.split('?')[0];
    return this.publicPaths.has(normalizedPath);
  }

  /**
   * Process the request, adding auth context if authenticated
   * Returns true if request should continue, false if response was sent
   */
  public async process(request: AuthenticatedRequest, response: ServerResponse): Promise<boolean> {
    // Check for authorization header
    if (!request.headers.authorization) {
      this.sendUnauthorized(response, 'Authentication required');
      return false;
    }

    // Attempt authentication
    const result = await this.authenticator.authenticate(request);

    this.logger.debug(
      `Auth ${request.method} ${request.url} success=${result.success}` +
      (result.error ? ` error=${result.error}` : '') +
      (result.context ? ` context=${JSON.stringify(this.safeContextForLog(result.context))}` : ''),
    );

    if (!result.success) {
      this.sendAuthFailure(response, result);
      return false;
    }

    // Attach auth context to request
    request.auth = result.context;
    return true;
  }

  private sendUnauthorized(response: ServerResponse, message: string): void {
    this.sendAuthFailure(response, {
      error: message,
      category: 'invalid_credentials',
      statusCode: 401,
    });
  }

  private sendAuthFailure(
    response: ServerResponse,
    result: Pick<AuthResult, 'error' | 'category' | 'statusCode'>,
  ): void {
    const statusCode = result.statusCode ?? (
      result.category === 'service_unavailable' ? 503 :
      result.category === 'forbidden' ? 403 :
      401
    );
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json');
    if (statusCode === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer, DPoP');
    }
    if (statusCode === 503) {
      response.end(JSON.stringify({
        error: 'Service Unavailable',
        message: 'Authentication service unavailable',
      }));
      return;
    }
    if (statusCode === 403) {
      response.end(JSON.stringify({
        error: 'Forbidden',
        message: result.error ?? 'Forbidden',
      }));
      return;
    }
    response.end(JSON.stringify({
      error: 'Unauthorized',
      message: result.error ?? 'Authentication failed',
    }));
  }

  private safeContextForLog(context: AuthContext): Record<string, unknown> {
    return {
      type: (context as any).type,
      webId: (context as any).webId,
      accountId: (context as any).accountId,
      clientId: (context as any).clientId,
      tokenType: (context as any).tokenType,
      viaApiKey: (context as any).viaApiKey,
    };
  }
}
