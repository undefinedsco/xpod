import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { Authenticator, AuthResult } from './Authenticator';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';

export interface NodeTokenAuthenticatorOptions {
  repository: EdgeNodeRepository;
}

export class NodeTokenAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly repo: EdgeNodeRepository;

  public constructor(options: NodeTokenAuthenticatorOptions) {
    this.repo = options.repository;
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    return !!auth?.startsWith('XpodNode ');
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const auth = request.headers.authorization!;
    const credentials = auth.slice(9).trim();

    const colonIndex = credentials.indexOf(':');
    if (colonIndex <= 0) {
      return { success: false, error: 'Invalid XpodNode credentials format. Expected nodeId:token' };
    }

    const nodeId = credentials.slice(0, colonIndex);
    const token = credentials.slice(colonIndex + 1);

    try {
      const secret = await this.repo.getNodeSecret(nodeId);
      if (!secret) {
        return { success: false, error: 'Unknown node' };
      }

      if (!secret.tokenHash || !this.repo.matchesToken(secret.tokenHash, token)) {
        return { success: false, error: 'Invalid node token' };
      }

      this.logger.debug(`Authenticated edge node: ${nodeId}`);

      return {
        success: true,
        context: {
          type: 'node',
          nodeId,
          accountId: (secret as any).accountId,
        },
      };
    } catch (error) {
      this.logger.error(`Node authentication failed: ${error}`);
      return { success: false, error: 'Internal authentication error' };
    }
  }
}
