import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';

export interface MultiAuthenticatorOptions {
  authenticators: Authenticator[];
}

/**
 * Combines multiple authenticators, trying each in order
 */
export class MultiAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly authenticators: Authenticator[];

  public constructor(options: MultiAuthenticatorOptions) {
    this.authenticators = options.authenticators;
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    return this.authenticators.some((auth) => auth.canAuthenticate(request));
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    console.log(`[MultiAuthenticator] Starting authentication with ${this.authenticators.length} authenticators`);
    for (const authenticator of this.authenticators) {
      const canAuth = authenticator.canAuthenticate(request);
      console.log(`[MultiAuthenticator] ${authenticator.constructor.name}.canAuthenticate: ${canAuth}`);
      if (canAuth) {
        const result = await authenticator.authenticate(request);
        if (result.success) {
          return result;
        }
        // If this authenticator claimed it could handle but failed,
        // don't try others - return the error
        this.logger.debug(`Authenticator failed: ${result.error}`);
        return result;
      }
    }

    return { success: false, error: 'No valid authentication provided' };
  }
}
