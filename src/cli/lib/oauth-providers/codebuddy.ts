/**
 * CodeBuddy OAuth Provider
 *
 * 通过 @tencent-ai/agent-sdk 的 authenticate() 实现 OAuth 登录。
 * 登录后 token 存入 Pod 的 Credential 表，跨环境复用。
 */

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@mariozechner/pi-ai/dist/utils/oauth/types.js';

interface CodeBuddyAuthState {
  state: string;
  authUrl: string;
}

interface CodeBuddyUserinfo {
  userId: string;
  userName: string;
  userNickname: string;
  token: string;
}

/**
 * CodeBuddy OAuth 登录
 *
 * 调用 @tencent-ai/agent-sdk 的 authenticate()，
 * 打开浏览器让用户登录腾讯账号，获取 token。
 */
export async function loginCodeBuddy(
  onAuthUrl: (url: string) => void,
): Promise<OAuthCredentials> {
  // 动态导入，避免未安装时报错
  const mod = await (new Function(
    'specifier',
    'return import(specifier)',
  ))('@tencent-ai/agent-sdk') as Record<string, any>;

  const authenticate = mod.unstable_v2_authenticate;
  if (typeof authenticate !== 'function') {
    throw new Error(
      '@tencent-ai/agent-sdk 不可用或版本过低，需要 unstable_v2_authenticate',
    );
  }

  const result = await authenticate({
    environment: 'external',
    onAuthUrl: (authState: CodeBuddyAuthState) => {
      onAuthUrl(authState.authUrl);
    },
  }) as { userinfo: CodeBuddyUserinfo };

  return {
    refresh: '',
    access: result.userinfo.token,
    expires: Date.now() + 24 * 3600_000,
    userId: result.userinfo.userId,
    userName: result.userinfo.userName,
  };
}

/**
 * CodeBuddy token 刷新
 *
 * CodeBuddy SDK 内部管理 token 生命周期，
 * 如果 token 过期，需要重新登录。
 */
export async function refreshCodeBuddyToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credentials.expires > Date.now()) {
    return credentials;
  }
  throw new Error('CodeBuddy token expired, please login again');
}

/**
 * CodeBuddy OAuth Provider 实现
 */
export const codeBuddyOAuthProvider: OAuthProviderInterface = {
  id: 'codebuddy',
  name: 'CodeBuddy',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginCodeBuddy((url) => {
      callbacks.onAuth({ url, instructions: '请在浏览器中登录腾讯账号' });
    });
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshCodeBuddyToken(credentials);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};
