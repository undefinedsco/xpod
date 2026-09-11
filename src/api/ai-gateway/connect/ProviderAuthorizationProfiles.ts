import type { DeviceCodeOAuthIntegration, AuthorizationCodeOAuthIntegration } from './DeviceCodeProtocol';
import { SUBSCRIPTION_AUTHORIZATION_BINDINGS } from '../providers/OfferingAuthorization';

// Public first-party client profiles, not Xpod-owned registrations. These values
// are trusted application configuration; management requests never supply them.
// Wire formats and source revisions are recorded in docs/ai-authorization-mechanisms.md.
const CLIENT_PROFILES: Record<string, Omit<DeviceCodeOAuthIntegration, 'provider' | 'offeringId' | 'integrationId' | 'mode'>> = {
  'openai-codex-public': {
    issuedBy: 'openai/codex',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    accountLabel: 'OpenAI Subscription',
    protocol: {
      id: 'device-code-json-authorization-code-pkce',
      verificationUriOrigins: ['https://auth.openai.com'],
      begin: {
        endpoint: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
        codec: 'deviceCodeJson',
        expiresAtField: 'expires_at',
        defaultExpiresInSeconds: 900,
        defaultIntervalSeconds: 5,
      },
      poll: {
        endpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
        codec: 'deviceCodeJson',
        pendingHttpStatuses: [403, 404],
      },
      tokenExchange: {
        endpoint: 'https://auth.openai.com/oauth/token',
        codec: 'authorizationCodeForm',
        redirectUri: 'https://auth.openai.com/deviceauth/callback',
      },
      refresh: {
        endpoint: 'https://auth.openai.com/oauth/token',
        codec: 'refreshTokenForm',
      },
      defaultVerificationUri: 'https://auth.openai.com/codex/device',
      accountIdClaim: ['https://api.openai.com/auth', 'chatgpt_account_id'],
    },
  },
  'kimi-code-public': {
    issuedBy: 'MoonshotAI/kimi-cli',
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
    accountLabel: 'Kimi Subscription',
    protocol: {
      id: 'oauth-device-code-form',
      verificationUriOrigins: ['https://www.kimi.com'],
      begin: {
        endpoint: 'https://auth.kimi.com/api/oauth/device_authorization',
        codec: 'oauthDeviceCode',
        headers: { 'X-Msh-Platform': 'xpod' },
      },
      poll: {
        endpoint: 'https://auth.kimi.com/api/oauth/token',
        headers: { 'X-Msh-Platform': 'xpod' },
        codec: 'oauthDeviceCode',
      },
      refresh: {
        endpoint: 'https://auth.kimi.com/api/oauth/token',
        headers: { 'X-Msh-Platform': 'xpod' },
        codec: 'refreshTokenForm',
      },
    },
  },
};

export function createProviderOAuthIntegrations(): DeviceCodeOAuthIntegration[] {
  return SUBSCRIPTION_AUTHORIZATION_BINDINGS.map((binding) => {
    const profile = CLIENT_PROFILES[binding.integrationId];
    if (!profile) throw new Error(`OAuth client profile is not registered: ${binding.integrationId}`);
    return {
      ...binding,
      ...structuredClone(profile),
      mode: 'deviceCodeOAuth',
    };
  });
}

const BROWSER_PROTOCOLS: Record<string, AuthorizationCodeOAuthIntegration['protocol']> = {
  'openai-codex-browser-public': {
    id: 'authorization-code-pkce-loopback',
    authorization: {
      endpoint: 'https://auth.openai.com/oauth/authorize',
      redirectUris: ['http://localhost:1455/auth/callback', 'http://localhost:1457/auth/callback'],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      extraParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'xpod' },
    },
    token: { endpoint: 'https://auth.openai.com/oauth/token', codec: 'authorizationCodeForm' },
  },
};

/** Browser authorization shares the public client identity and token lifecycle. */
export function createBrowserOAuthIntegrations(): AuthorizationCodeOAuthIntegration[] {
  return SUBSCRIPTION_AUTHORIZATION_BINDINGS.flatMap((binding) => {
    if (!('browserIntegrationId' in binding)) return [];
    const profile = CLIENT_PROFILES[binding.integrationId];
    const protocol = BROWSER_PROTOCOLS[binding.browserIntegrationId];
    if (!profile || !protocol) throw new Error(`OAuth browser profile is not registered: ${binding.browserIntegrationId}`);
    return [{
      provider: binding.provider,
      offeringId: binding.offeringId,
      integrationId: binding.browserIntegrationId,
      issuedBy: profile.issuedBy,
      clientId: profile.clientId,
      accountLabel: profile.accountLabel,
      mode: 'authorizationCodeOAuth' as const,
      protocol: {
        ...structuredClone(protocol),
        refresh: structuredClone(profile.protocol.refresh),
        accountIdClaim: structuredClone(profile.protocol.accountIdClaim),
      },
    }];
  });
}
