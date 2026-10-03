import { asValue, createContainer } from 'awilix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyAgent } from 'undici/index.js';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';
import { registerCommonServices } from '../../../src/api/container/common';
import type { ApiContainerCradle } from '../../../src/api/container/types';

// Resolve the production registration instead of rebuilding its adapters in a test.
function connectService(edition: 'local' | 'cloud', transport?: ProviderHttpTransport) {
  const container = createContainer<ApiContainerCradle>();
  registerCommonServices(container);
  container.register({
    config: asValue({ edition } as ApiContainerCradle['config']),
    ...(transport ? { providerHttpTransport: asValue(transport) } : {}),
    // Pod access is not under test here; keep the production registration from
    // constructing an OwnerPodAccess that needs a live identity database.
    ownerPodAccess: asValue(undefined as unknown as ApiContainerCradle['ownerPodAccess']),
  });
  return container.resolve('providerConnectService')!;
}

describe('production authorization registration', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['local', 'deviceCodeOAuth'],
    ['local', 'authorizationCodeOAuth'],
    ['cloud', 'deviceCodeOAuth'],
  ] as const)('routes %s %s refresh once through the configured provider proxy', async (edition, mode) => {
    const bypass = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unconfigured_fetch_bypassed_host_proxy'));
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeInstanceOf(ProxyAgent);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('fixture-refresh');
      expect(form.get('client_id')).toBeTruthy();
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-rotated', expires_in: 3600 });
    });
    const transport = new ProviderHttpTransport({
      fetch: upstream,
      resolver: async () => [{ address: '203.0.113.10' }],
      systemProxy: 'http://127.0.0.1:7890',
    });
    const service = connectService(edition, transport);
    const result = await service.refreshCallerOwned({
      deployment: edition, provider: 'openai', offeringId: 'official-subscription', mode,
      webId: 'https://pod.example/alice/profile/card#me',
      credentialId: 'fixture-credential', expectedVersion: 2, refreshToken: 'fixture-refresh',
    });
    expect(result).toMatchObject({ status: 'completed', oauthCredential: { expectedVersion: 2, refreshToken: 'fixture-rotated' } });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(bypass).not.toHaveBeenCalled();
  });

  it.each(['deviceCodeOAuth', 'authorizationCodeOAuth'] as const)('preserves %s refresh refusal classification without retrying a rotating token', async (mode) => {
    const bypass = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unconfigured_fetch_bypassed_host_proxy'));
    const upstream = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const transport = new ProviderHttpTransport({ fetch: upstream, resolver: async () => [{ address: '203.0.113.10' }] });
    await expect(connectService('local', transport).refreshCallerOwned({
      deployment: 'local', provider: 'openai', offeringId: 'official-subscription', mode,
      webId: 'https://pod.example/alice/profile/card#me',
      credentialId: 'fixture-credential', expectedVersion: 2, refreshToken: 'fixture-refresh',
    })).rejects.toThrow('OAuth refresh failed: invalid_grant');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(bypass).not.toHaveBeenCalled();
  });

  it.each(['local', 'cloud'] as const)('exposes installed mechanisms in %s', (edition) => {
    const capabilities = connectService(edition).getAuthorizationMethods();
    expect(capabilities.find((item) => item.provider === 'openai' && item.offeringId === 'official-subscription')?.endpoints).toEqual([
      { protocol: 'responses', baseUrl: 'https://chatgpt.com/backend-api/codex' },
    ]);
    for (const offering of capabilities.filter((item) => item.provider === 'custom')) {
      expect(offering.endpoints).toBeUndefined();
    }
    expect(capabilities.find((item) => item.provider === 'openai' && item.offeringId === 'official-subscription')?.authorizationMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-oauth', connectMode: 'authorizationCodeOAuth', lifecycle: edition === 'local' ? 'active' : 'unavailable' }),
    ]));
    for (const [provider, offeringId] of [['openai', 'official-subscription'], ['kimi', 'subscription-key']]) {
      const methods = capabilities.find((item) => item.provider === provider && item.offeringId === offeringId)?.authorizationMethods;
      expect(methods).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'device-code', lifecycle: 'active' }),
        expect.objectContaining({ id: 'local-session-import', lifecycle: edition === 'local' ? 'active' : 'unavailable' }),
      ]));
    }
  });

  it.each(['openai', 'kimi'])('keeps %s API-key onboarding available alongside OAuth', async (provider) => {
    const service = connectService('local');
    const result = await service.begin({
      provider,
      webId: 'https://pod.example/alice/profile/card#me',
      deployment: 'local',
      requestedMode: 'browserAssistedApiKey',
      offeringId: 'api-platform',
      authorizationMethodId: 'api-key',
    });
    expect(result).toMatchObject({ provider, offeringId: 'api-platform', status: 'pending' });
    await expect(service.status({
      provider,
      offeringId: 'api-platform',
      webId: 'https://pod.example/alice/profile/card#me',
      deployment: 'local',
      attemptId: result.attemptId!,
      state: result.state!,
      signature: result.signature!,
    })).resolves.toMatchObject({ status: 'pending' });
  });

  it.each([
    ['subscription-key', 'https://www.kimi.com/code/console'],
    ['api-platform', 'https://platform.moonshot.cn/console/api-keys'],
  ])('opens the selected Kimi %s console without pretending to finish authorization', async (offeringId, consoleUrl) => {
    const result = await connectService('local').begin({
      provider: 'kimi',
      webId: 'https://pod.example/alice/profile/card#me',
      deployment: 'local',
      requestedMode: 'browserAssistedApiKey',
      offeringId,
      authorizationMethodId: 'browser-login',
    });
    expect(result).toMatchObject({ mode: 'browserAssistedApiKey', status: 'pending', offeringId });
    const target = new URL(result.authorizationUrl!);
    expect(target.origin + target.pathname).toBe(consoleUrl);
    expect(result.oauthCredential).toBeUndefined();
  });
});
