import type { ServerResponse } from 'node:http';
import type { AuthContext } from '../auth/AuthContext';
import type { AuthenticatedRequest } from './AuthMiddleware';
import { AuthMiddleware } from './AuthMiddleware';

const DEFAULT_OPEN_AUTH_CONTEXT: AuthContext = {
  type: 'solid',
  webId: 'http://xpod.test/test/profile/card#me',
  accountId: 'xpod-open-account',
  displayName: 'Xpod Open Mode',
};

export interface OpenAuthMiddlewareOptions {
  context?: AuthContext;
}

export class OpenAuthMiddleware extends AuthMiddleware {
  private readonly context: AuthContext;

  public constructor(options: OpenAuthMiddlewareOptions = {}) {
    super({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({ success: true, context: options.context ?? DEFAULT_OPEN_AUTH_CONTEXT }),
      },
    });
    this.context = options.context ?? DEFAULT_OPEN_AUTH_CONTEXT;
  }

  public override async process(request: AuthenticatedRequest, _response: ServerResponse): Promise<boolean> {
    request.auth = this.context;
    return true;
  }
}
