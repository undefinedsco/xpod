/**
 * OAuth Providers Registry
 *
 * 注册所有 AI Provider 的 OAuth 实现。
 * Solid OIDC 不在这里——它是"统一钥匙"，存本地。
 * 这里的 provider token 存 Pod，跨环境复用。
 */

import { loadPiAiOAuthUtils } from '../pi-optional';
import { codeBuddyOAuthProvider } from './codebuddy';

/**
 * 注册所有自定义 OAuth providers 到 pi-mono 框架
 */
export async function registerCustomOAuthProviders(): Promise<void> {
  const { registerOAuthProvider } = await loadPiAiOAuthUtils();
  registerOAuthProvider(codeBuddyOAuthProvider);
}

export { codeBuddyOAuthProvider } from './codebuddy';
