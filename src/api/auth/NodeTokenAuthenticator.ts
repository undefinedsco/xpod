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
        // 未注册的节点一律拒绝：节点必须先通过 /provision/nodes 注册并领取 token。
        // 放行未知节点会让调用方拿着自称的 nodeId 通过认证（下游 handler 信任 auth.nodeId）。
        this.logger.warn(`Rejecting credentials for unknown node: ${nodeId}`);
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
        },
      };
    } catch (error) {
      this.logger.error(`Node authentication failed: ${error}`);
      return { success: false, error: 'Internal authentication error' };
    }
  }


}
