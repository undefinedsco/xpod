import type { IncomingMessage } from 'node:http';
import type { Authenticator, AuthResult } from './Authenticator';
import type { AccountAuthContext } from './AuthContext';

export const CSS_ACCOUNT_TOKEN_SCHEME = 'CSS-Account-Token';

export interface CssAccountTokenAuthenticatorOptions {
  /** Resolve a CSS account cookie token to the account that owns it. */
  resolveAccountId: (token: string) => Promise<string | undefined>;
}

/**
 * Authenticates the opaque account-cookie token issued by Community Solid
 * Server. The token is never logged or copied into an auth context.
 */
export class CssAccountTokenAuthenticator implements Authenticator {
  private readonly resolveAccountId: CssAccountTokenAuthenticatorOptions['resolveAccountId'];

  public constructor(options: CssAccountTokenAuthenticatorOptions) {
    this.resolveAccountId = options.resolveAccountId;
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    return parseCssAccountToken(request.headers.authorization) !== undefined;
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const token = parseCssAccountToken(request.headers.authorization);
    if (!token) {
      return invalidCredentials();
    }

    try {
      const accountId = await this.resolveAccountId(token);
      if (!accountId?.trim()) {
        return invalidCredentials();
      }

      const context: AccountAuthContext = {
        type: 'account',
        accountId: accountId.trim(),
        tokenType: CSS_ACCOUNT_TOKEN_SCHEME,
      };
      return { success: true, context };
    } catch {
      // Storage errors are deliberately generic: a token must not appear in
      // logs or response bodies, and callers should fail closed.
      return {
        success: false,
        error: 'Authentication service unavailable',
        category: 'service_unavailable',
        statusCode: 503,
      };
    }
  }
}

export function parseCssAccountToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const match = /^CSS-Account-Token\s+(\S+)$/iu.exec(authorization.trim());
  const token = match?.[1];
  if (!token || token.length > 512 || /[\r\n]/u.test(token)) {
    return undefined;
  }
  return token;
}

function invalidCredentials(): AuthResult {
  return {
    success: false,
    error: 'Invalid CSS account token',
    category: 'invalid_credentials',
    statusCode: 401,
  };
}
