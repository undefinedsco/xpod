import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator } from '../auth/Authenticator';
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

    console.log(`[AuthMiddleware] ${request.method} ${request.url} - success: ${result.success}, error: ${result.error}, context: ${JSON.stringify(result.context)}`);

    if (!result.success) {
      this.sendUnauthorized(response, result.error ?? 'Authentication failed');
      return false;
    }

    // Attach auth context to request
    request.auth = result.context;
    return true;
  }

  private sendUnauthorized(response: ServerResponse, message: string): void {
    response.statusCode = 401;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('WWW-Authenticate', 'Bearer, DPoP');
    response.end(JSON.stringify({ error: 'Unauthorized', message }));
  }
}
