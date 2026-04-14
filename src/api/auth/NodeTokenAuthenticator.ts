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
    // 支持两种格式:
    // 1. XpodNode nodeId:token
    // 2. Bearer <raw-node-token> (带 X-Node-Id 头)
    // 3. Bearer username:secret / base64(username:secret) (兼容旧格式，带 X-Node-Id 头)
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
      // 兼容旧的 username:secret / base64(username:secret) 形式。
      nodeId = request.headers['x-node-id'] as string;
      const bearerToken = auth.slice(7).trim();
      if (!bearerToken) {
        return { success: false, error: 'Empty node token' };
      }
      const parsed = this.parseNodeToken(bearerToken);
      token = parsed?.token ?? bearerToken;
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

  /**
   * 解析 Node Token (username:secret 或 base64)
   */
  private parseNodeToken(token: string): { username: string; token: string } | undefined {
    if (token.includes(':')) {
      const [username, ...secretParts] = token.split(':');
      const secret = secretParts.join(':');
      if (username && secret) {
        return { username, token: secret };
      }
    }

    // 尝试 base64 解码
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      if (decoded.includes(':')) {
        const [username, ...secretParts] = decoded.split(':');
        const secret = secretParts.join(':');
        if (username && secret) {
          return { username, token: secret };
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  /**
   * 检查是否是 base64 编码的 Node Token
   */
  private isBase64NodeToken(token: string): boolean {
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      return decoded.includes(':');
    } catch {
      return false;
    }
  }
}
