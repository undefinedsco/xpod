/** Published 1.6.6 ships JavaScript only. These are the adapter methods consumed by Xpod. */
declare module '@logto/connector-wechat-web' {
  export default function createConnector(input: {
    getConfig: (id: string) => Promise<{ appId: string; appSecret: string }>;
  }): Promise<{
    getAuthorizationUri(input: { state: string; redirectUri: string }): Promise<string>;
    getUserInfo(input: { code: string }): Promise<{ rawData?: unknown }>;
  }>;
}
