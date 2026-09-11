import { describe, expect, it, vi } from 'vitest';

import { createProviderOAuthIntegrations, createBrowserOAuthIntegrations } from '../../../src/api/ai-gateway/connect/ProviderAuthorizationProfiles';
import {
  DeviceCodeConnectAdapter,
  InMemoryConnectAttemptStore,
  OAuthIntegrationRegistry,
  type ConnectBeginResult,
} from '../../../src/api/ai-gateway/connect';
import type { DeviceCodeOAuthIntegration } from '../../../src/api/ai-gateway/connect/DeviceCodeProtocol';

const WEB_ID = 'https://id.example/alice/profile/card#me';

interface RecordedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

function requiredAttempt(result: ConnectBeginResult) {
  expect(result.attemptId).toBeTruthy();
  expect(result.state).toBeTruthy();
  expect(result.signature).toBeTruthy();
  return {
    attemptId: result.attemptId!,
    state: result.state!,
    signature: result.signature!,
  };
}

function requestBodyText(init?: RequestInit): string {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'string') return body;
  throw new Error(`Unexpected request body fixture type: ${typeof body}`);
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  const source = init?.headers;
  if (!source) return {};
  if (source instanceof Headers) return Object.fromEntries(source.entries());
  if (Array.isArray(source)) return Object.fromEntries(source);
  return source as Record<string, string>;
}

function makeAdapter(
  integration: DeviceCodeOAuthIntegration,
  fetchMock: typeof fetch,
  now: () => Date = () => new Date('2026-09-08T00:00:00.000Z'),
): DeviceCodeConnectAdapter {
  return new DeviceCodeConnectAdapter({
    integration,
    fetch: fetchMock,
    attempts: new InMemoryConnectAttemptStore(),
    credentialRepository: {} as any,
    vault: {} as any,
    deployment: 'local',
    signingSecret: 'profile-test-secret',
    now,
    randomBytes: () => Buffer.alloc(32, 7),
  });
}

function registryFromProductionProfiles(): OAuthIntegrationRegistry {
  return OAuthIntegrationRegistry.fromServerConfig({
    integrations: createProviderOAuthIntegrations(),
  });
}

describe('production provider authorization profiles', () => {
  it('registers browser authorization separately while sharing the trusted public client', () => {
    const integrations = createBrowserOAuthIntegrations();
    const registry = OAuthIntegrationRegistry.fromServerConfig({
      integrations: [...createProviderOAuthIntegrations(), ...integrations],
    });
    const browser = registry.require('openai', 'official-subscription', 'authorizationCodeOAuth');
    const device = registry.require('openai', 'official-subscription');
    expect(browser.clientId).toBe(device.clientId);
    expect(browser.protocol.authorization).toMatchObject({
      endpoint: 'https://auth.openai.com/oauth/authorize',
      redirectUris: ['http://localhost:1455/auth/callback', 'http://localhost:1457/auth/callback'],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
    });
    expect(browser.protocol.refresh).toEqual(device.protocol.refresh);
    expect(() => registry.require('kimi', 'subscription-key', 'authorizationCodeOAuth')).toThrow('auth_not_available');
    browser.protocol.authorization.redirectUris.push('http://localhost:9999/auth/callback');
    expect(createBrowserOAuthIntegrations()[0].protocol.authorization.redirectUris).toHaveLength(2);
  });

  it('are accepted by the generic OAuth integration registry with provider/offering identity', () => {
    const registry = registryFromProductionProfiles();

    expect(registry.require('openai', 'official-subscription')).toMatchObject({
      provider: 'openai',
      offeringId: 'official-subscription',
      mode: 'deviceCodeOAuth',
      integrationId: 'openai-codex-public',
      issuedBy: 'openai/codex',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      accountLabel: 'OpenAI Subscription',
      protocol: expect.objectContaining({
        id: 'device-code-json-authorization-code-pkce',
        poll: expect.objectContaining({ pendingHttpStatuses: [403, 404] }),
        accountIdClaim: ['https://api.openai.com/auth', 'chatgpt_account_id'],
      }),
    });
    expect(registry.require('kimi', 'subscription-key')).toMatchObject({
      provider: 'kimi',
      offeringId: 'subscription-key',
      mode: 'deviceCodeOAuth',
      integrationId: 'kimi-code-public',
      issuedBy: 'MoonshotAI/kimi-cli',
      clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
      accountLabel: 'Kimi Subscription',
      protocol: expect.objectContaining({ id: 'oauth-device-code-form' }),
    });
  });

  it('drives the OpenAI Codex device-auth-code-PKCE flow through the generic engine fixture', async () => {
    const registry = registryFromProductionProfiles();
    const integration = registry.require('openai', 'official-subscription');
    const requests: RecordedRequest[] = [];
    const idToken = makeJwt({
      sub: 'chatgpt-user-123',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-openai-123' },
    });
    let now = new Date('2026-09-08T00:00:00.000Z');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method, headers: requestHeaders(init), body: requestBodyText(init) });
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return Response.json({
          device_auth_id: 'device-auth-123',
          user_code: 'CODE-12345',
          interval: '0',
        });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        expect(requests.at(-1)?.body).toBe(JSON.stringify({
          device_auth_id: 'device-auth-123',
          user_code: 'CODE-12345',
        }));
        return Response.json({
          authorization_code: 'auth-code-123',
          code_challenge: 'server-challenge',
          code_verifier: 'server-verifier',
        });
      }
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(requestBodyText(init));
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('auth-code-123');
        expect(params.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
        expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
        expect(params.get('code_verifier')).toBe('server-verifier');
        return Response.json({
          access_token: 'openai-access',
          refresh_token: 'openai-refresh',
          id_token: idToken,
          expires_in: 3600,
        });
      }
      return Response.json({ error: 'unexpected_url' }, { status: 500 });
    }) as unknown as typeof fetch;
    const adapter = makeAdapter(integration, fetchMock);

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      authorizationMethodId: 'device-code',
      requestedMode: 'deviceCodeOAuth',
    });
    expect(begun).toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'pending',
      provider: 'openai',
      offeringId: 'official-subscription',
      userCode: 'CODE-12345',
      verificationUri: 'https://auth.openai.com/codex/device',
      verificationUriComplete: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0,
    });
    expect(requests[0]).toMatchObject({
      url: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
    });

    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...requiredAttempt(begun),
    });
    expect(completed.oauthCredential).toMatchObject({
      accessToken: 'openai-access',
      refreshToken: 'openai-refresh',
      idToken,
      accountSubject: 'chatgpt-user-123',
      accountLabel: 'OpenAI Subscription',
      accountId: 'acct-openai-123',
      offeringId: 'official-subscription',
    });
  });

  it('drives the Kimi public device-code-token flow through the generic engine fixture', async () => {
    const registry = registryFromProductionProfiles();
    const integration = registry.require('kimi', 'subscription-key');
    const requests: RecordedRequest[] = [];
    let now = new Date('2026-09-08T00:00:00.000Z');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method, headers: requestHeaders(init), body: requestBodyText(init) });
      if (url.endsWith('/api/oauth/device_authorization')) {
        const params = new URLSearchParams(requestBodyText(init));
        expect(params.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
        expect(params.has('code_challenge')).toBe(false);
        return Response.json({
          device_code: 'kimi-device-123',
          user_code: 'KIMI-123',
          verification_uri: 'https://www.kimi.com/device',
          verification_uri_complete: 'https://www.kimi.com/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 1,
        });
      }
      if (url.endsWith('/api/oauth/token')) {
        const params = new URLSearchParams(requestBodyText(init));
        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
        expect(params.get('device_code')).toBe('kimi-device-123');
        expect(params.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
        expect(params.has('code_verifier')).toBe(false);
        return Response.json({
          access_token: 'kimi-access',
          refresh_token: 'kimi-refresh',
          expires_in: 3600,
          scope: 'openid profile',
          token_type: 'Bearer',
        });
      }
      return Response.json({ error: 'unexpected_url' }, { status: 500 });
    }) as unknown as typeof fetch;
    const adapter = makeAdapter(integration, fetchMock, () => now);

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'kimi',
      offeringId: 'subscription-key',
      authorizationMethodId: 'device-code',
      requestedMode: 'deviceCodeOAuth',
    });
    expect(begun).toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'pending',
      provider: 'kimi',
      offeringId: 'subscription-key',
      userCode: 'KIMI-123',
      verificationUri: 'https://www.kimi.com/device',
      verificationUriComplete: 'https://www.kimi.com/device?user_code=KIMI-123',
      intervalSeconds: 1,
    });
    expect(requests[0].headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Msh-Platform': 'xpod',
    });

    now = new Date('2026-09-08T00:00:02.000Z');
    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'kimi',
      offeringId: 'subscription-key',
      ...requiredAttempt(begun),
    });
    expect(requests[1].headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Msh-Platform': 'xpod',
    });
    expect(completed.oauthCredential).toMatchObject({
      accessToken: 'kimi-access',
      refreshToken: 'kimi-refresh',
      scope: 'openid profile',
      accountLabel: 'Kimi Subscription',
      offeringId: 'subscription-key',
    });
  });
});
