import createWechatConnector from '@logto/connector-wechat-web';
import { BadRequestHttpError } from '@solid/community-server';

export interface ExternalIdentity {
  subject: string;
  unionId?: string;
}

export interface ExternalLoginProvider {
  id: string;
  name: string;
  namespace: string;
  authorizationUrl(state: string, redirectUri: string): Promise<string>;
  identity(code: string): Promise<ExternalIdentity>;
}

interface SocialConnector {
  getAuthorizationUri(input: { state: string; redirectUri: string }): Promise<string>;
  getUserInfo(input: { code: string }): Promise<{ rawData?: unknown }>;
}

/** Generic adapter for Logto social connectors; stable identity comes from a declared raw field. */
export class LogtoLoginProvider implements ExternalLoginProvider {
  private readonly connector: Promise<SocialConnector>;

  public constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly namespace: string,
    factory: () => Promise<SocialConnector>,
    private readonly subjectField: string,
    private readonly unionField?: string,
  ) { this.connector = factory(); }

  public async authorizationUrl(state: string, redirectUri: string): Promise<string> {
    return (await this.connector).getAuthorizationUri({ state, redirectUri });
  }

  public async identity(code: string): Promise<ExternalIdentity> {
    try {
      const { rawData } = await (await this.connector).getUserInfo({ code });
      const raw = rawData as Record<string, unknown> | undefined;
      const subject = raw?.[this.subjectField];
      const unionId = this.unionField ? raw?.[this.unionField] : undefined;
      if (typeof subject !== 'string' || !subject || subject.length > 256) throw new Error('Invalid subject');
      return { subject, ...(typeof unionId === 'string' && unionId ? { unionId } : {}) };
    } catch {
      // Upstream errors can contain query strings with app secrets or access tokens.
      throw new BadRequestHttpError('EXTERNAL_AUTHORIZATION_FAILED');
    }
  }
}

/** A single declaration of the WeChat plugin; Xpod never uses Logto's unionid-or-openid fallback ID. */
export function createWechatLoginProvider(appId: string, appSecret: string): ExternalLoginProvider {
  return new LogtoLoginProvider('wechat', '微信', appId, async () => createWechatConnector({
    getConfig: async () => ({ appId, appSecret }),
  }), 'openid', 'unionid');
}
