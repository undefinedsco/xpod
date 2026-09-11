import { asValue, createContainer } from 'awilix';
import { describe, expect, it } from 'vitest';
import { registerCommonServices } from '../../../src/api/container/common';
import type { ApiContainerCradle } from '../../../src/api/container/types';

// Resolve the production registration instead of rebuilding its adapters in a test.
function connectService(edition: 'local' | 'cloud') {
  const container = createContainer<ApiContainerCradle>();
  registerCommonServices(container);
  container.register({
    config: asValue({ edition } as ApiContainerCradle['config']),
    hostedPodDataAccess: asValue(undefined),
  });
  return container.resolve('providerConnectService')!;
}

describe('production authorization registration', () => {
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
});
