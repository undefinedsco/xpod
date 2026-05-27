import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';

export interface ServiceTokenAuthenticatorOptions {
  repository: ServiceTokenRepository;
}

/**
 * Authenticator for service tokens (Business, Local SP, Cloud, Compute).
 *
 * Format: Bearer svc-xxx
 */
export class ServiceTokenAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly repo: ServiceTokenRepository;

  public constructor(options: ServiceTokenAuthenticatorOptions) {
    this.repo = options.repository;
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return false;
    }
    const token = auth.slice(7).trim();
    // Service tokens start with 'svc-'
    return token.startsWith('svc-');
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const auth = request.headers.authorization!;
    const token = auth.slice(7).trim();

    try {
      const record = await this.repo.verifyToken(token);
      if (!record) {
        return { success: false, error: 'Invalid service token' };
      }

      this.logger.debug(`Authenticated service: ${record.serviceType}:${record.serviceId}`);

      return {
        success: true,
        context: {
          type: 'service',
          serviceType: record.serviceType,
          serviceId: record.serviceId,
          scopes: record.scopes,
        },
      };
    } catch (error) {
      this.logger.error(`Service token authentication failed: ${error}`);
      return { success: false, error: 'Internal authentication error' };
    }
  }
}
