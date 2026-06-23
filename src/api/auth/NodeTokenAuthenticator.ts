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
    // 支持两种明确格式:
    // 1. XpodNode nodeId:token
    // 2. Bearer <raw-node-token> (带 X-Node-Id 头)
    if (auth?.startsWith('XpodNode ')) {
      return true;
    }
    if (auth?.startsWith('Bearer ') && request.headers['x-node-id']) {
      return true;
    }
    return false;
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const auth = request.headers.authorization!;

    let nodeId: string;
    let token: string;

    if (auth.startsWith('XpodNode ')) {
      // 格式: XpodNode nodeId:token
      const credentials = auth.slice(9).trim();
      const colonIndex = credentials.indexOf(':');
      if (colonIndex <= 0) {
        return { success: false, error: 'Invalid XpodNode credentials format. Expected nodeId:token' };
      }
      nodeId = credentials.slice(0, colonIndex);
      token = credentials.slice(colonIndex + 1);
    } else {
      // 格式: Bearer <raw-node-token> (带 X-Node-Id 头)
      nodeId = request.headers['x-node-id'] as string;
      token = auth.slice(7).trim();
      if (!token) {
        return { success: false, error: 'Empty node token' };
      }
    }

    try {
      const secret = await this.repo.getNodeSecret(nodeId);
      if (!secret) {
        // 节点不存在，可能是新节点注册
        // 对于 DDNS 分配等操作，允许通过（由业务逻辑处理）
        this.logger.debug(`Node not found: ${nodeId}, allowing for registration`);
        return {
          success: true,
          context: {
            type: 'node',
            nodeId,
          },
        };
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
