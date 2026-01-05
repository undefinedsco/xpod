import type { IncomingMessage } from 'node:http';
import type { AuthContext } from './AuthContext';

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  success: boolean;
  context?: AuthContext;
  error?: string;
}

/**
 * Base interface for authenticators
 */
export interface Authenticator {
  /**
   * Check if this authenticator can handle the request
   */
  canAuthenticate(request: IncomingMessage): boolean;

  /**
   * Attempt to authenticate the request
   */
  authenticate(request: IncomingMessage): Promise<AuthResult>;
}
