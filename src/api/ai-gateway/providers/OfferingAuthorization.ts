/** Public entry points, separate from how the resulting credential authenticates. */
export interface OfferingAuthorizationMethod {
  id: string;
  authMode: 'oauth' | 'deviceCode' | 'local' | 'apiKey';
  connectMode?: 'authorizationCodeOAuth' | 'deviceCodeOAuth' | 'browserAssistedApiKey';
  /**
   * Wording is the applet's (`display-wording.ts` in `@undefineds.co/ai-connections`),
   * decided from the entry's id. The gateway names the entry and says whether this
   * deployment can offer it; it does not write the button.
   */
  label?: string;
  lifecycle: 'active' | 'unavailable';
  reason?: string;
}

/** Xpod integrations supplement the shared offering catalog with runtime capabilities. */
export const SUBSCRIPTION_AUTHORIZATION_BINDINGS = [
  { provider: 'openai', offeringId: 'official-subscription', integrationId: 'openai-codex-public', browserIntegrationId: 'openai-codex-browser-public' },
  { provider: 'kimi', offeringId: 'subscription-key', integrationId: 'kimi-code-public' },
] as const;

export function subscriptionAuthorizationMethods(deployment: 'local' | 'cloud', binding?: { integrationId: string; browserIntegrationId?: string }): OfferingAuthorizationMethod[] {
  const browserMethods: OfferingAuthorizationMethod[] = binding?.browserIntegrationId ? [{
    id: 'browser-oauth',
    authMode: 'oauth',
    connectMode: 'authorizationCodeOAuth',
    lifecycle: deployment === 'local' ? 'active' : 'unavailable',
    ...(deployment === 'local' ? {} : { reason: '浏览器登录需要本机回调，请在本机 Xpod 中使用，或选择设备码登录。' }),
  }] : [];
  return [
    ...browserMethods,
    {
      id: 'device-code',
      authMode: 'deviceCode',
      connectMode: 'deviceCodeOAuth',
      lifecycle: 'active',
    },
    {
      id: 'local-session-import',
      authMode: 'local',
      lifecycle: deployment === 'local' ? 'active' : 'unavailable',
      ...(deployment === 'local' ? {} : { reason: '请在运行本机客户端的 Xpod 上导入登录态。' }),
    },
  ];
}
