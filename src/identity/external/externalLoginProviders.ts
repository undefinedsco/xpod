import { ExternalLoginProviderFactory, type ExternalLoginEntry } from './ExternalLoginProviderFactory';
import { logtoSocialConnectorFactories } from './LogtoSocialConnectorAdapter';

export interface ExternalLoginDeploymentConfig {
  wechatAppId?: string;
  wechatAppSecret?: string;
}

/** The composition root is the only place selecting bundled connector suppliers. */
export function createExternalLoginProviderFactory(): ExternalLoginProviderFactory {
  return new ExternalLoginProviderFactory(logtoSocialConnectorFactories);
}

/** Deployment credentials become program-side entry declarations, never user/Pod data. */
export function configuredExternalLoginEntries(config: ExternalLoginDeploymentConfig): ExternalLoginEntry[] {
  if (!config.wechatAppId && !config.wechatAppSecret) return [];
  if (!config.wechatAppId || !config.wechatAppSecret) throw new Error('WeChat requires both AppID and AppSecret');
  return [{ id: 'wechat', connector: 'logto-wechat-web', config: { appId: config.wechatAppId, appSecret: config.wechatAppSecret } }];
}
