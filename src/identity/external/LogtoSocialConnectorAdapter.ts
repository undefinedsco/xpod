import createWechatConnector from '@logto/connector-wechat-web';
import { BadRequestHttpError } from '@solid/community-server';
import type { ExternalIdentity, ExternalLoginProvider } from './ExternalLoginProvider';
import type { ExternalLoginConnectorFactory } from './ExternalLoginProviderFactory';

export interface LogtoSocialConnector {
  getAuthorizationUri(input: { state: string; redirectUri: string }): Promise<string>;
  getUserInfo(input: { code: string }): Promise<{ id?: string; rawData?: unknown }>;
}

export interface ConnectorIdentityField {
  readonly source: 'profile' | 'rawData';
  readonly field: string;
}

export interface ConnectorIdentityMapping {
  readonly subject: ConnectorIdentityField;
  readonly unionId?: ConnectorIdentityField;
}

/** Logto supplies protocol connectors; Xpod owns authentication and identity bindings. */
export class LogtoSocialConnectorAdapter implements ExternalLoginProvider {
  public readonly id: string;
  public readonly provider: string;
  public readonly name: string;
  public readonly namespace: string;
  private connector?: Promise<LogtoSocialConnector>;

  public constructor(
    entry: Pick<ExternalLoginProvider, 'id' | 'provider' | 'name' | 'namespace'>,
    private readonly createConnector: () => Promise<LogtoSocialConnector>,
    private readonly mapping: ConnectorIdentityMapping,
  ) {
    this.id = entry.id;
    this.provider = entry.provider;
    this.name = entry.name;
    this.namespace = entry.namespace;
  }

  public async authorizationUrl(state: string, redirectUri: string): Promise<string> {
    try { return await (await this.getConnector()).getAuthorizationUri({ state, redirectUri }); }
    catch { throw new BadRequestHttpError('EXTERNAL_AUTHORIZATION_FAILED'); }
  }

  public async identity(code: string): Promise<ExternalIdentity> {
    try {
      const profile = await (await this.getConnector()).getUserInfo({ code });
      const read = ({ source, field }: ConnectorIdentityField): unknown => {
        const data = source === 'profile' ? profile : profile.rawData;
        return data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, field)
          ? (data as Record<string, unknown>)[field] : undefined;
      };
      const subject = read(this.mapping.subject);
      const unionId = this.mapping.unionId ? read(this.mapping.unionId) : undefined;
      if (typeof subject !== 'string' || !subject || subject.length > 256) throw new Error('Invalid subject');
      if (unionId !== undefined && (typeof unionId !== 'string' || !unionId || unionId.length > 256)) throw new Error('Invalid union ID');
      return { subject, ...(typeof unionId === 'string' ? { unionId } : {}) };
    } catch {
      // Connector errors may contain URLs with app secrets or access tokens.
      throw new BadRequestHttpError('EXTERNAL_AUTHORIZATION_FAILED');
    }
  }

  private getConnector(): Promise<LogtoSocialConnector> {
    // Initialize once on first use; a failed initialization can be retried safely.
    this.connector ??= Promise.resolve().then(this.createConnector).catch(error => {
      this.connector = undefined;
      throw error;
    });
    return this.connector;
  }
}

/** One registration for this published plugin, including its identity contract. */
export const logtoSocialConnectorFactories: readonly ExternalLoginConnectorFactory[] = [{
  id: 'logto-wechat-web',
  create(entry) {
    const { appId, appSecret } = entry.config;
    if (typeof appId !== 'string' || !appId.trim() || typeof appSecret !== 'string' || !appSecret.trim()) {
      throw new Error('WeChat requires both AppID and AppSecret');
    }
    return new LogtoSocialConnectorAdapter({ id: entry.id, provider: 'wechat', name: entry.name ?? '微信', namespace: appId },
      async () => createWechatConnector({ getConfig: async () => ({ appId, appSecret }) }), {
        subject: { source: 'rawData', field: 'openid' },
        unionId: { source: 'rawData', field: 'unionid' },
      });
  },
}];
