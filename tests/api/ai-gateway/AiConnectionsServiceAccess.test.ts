import { gatewayAccessKeyResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import {
  AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS,
  createAiConnectionsServiceAccess,
} from '../../../src/api/ai-gateway/service-access/AiConnectionsServiceAccess';
import { AI_CONNECTIONS_PROVIDERS } from '@undefineds.co/ai-connections/client';
import {
  CUSTOM_DEFAULT_OFFERINGS,
  DEFAULT_PROVIDER_OFFERINGS,
  PROVIDER_OFFERINGS,
} from '@undefineds.co/ai-connections/provider-catalog';
import { parseAiConnectionsServiceAccess } from '../../../packages/ai-connections/src/service-access';

/**
 * Frozen copy of the granted provider documents. It is deliberately independent
 * of both consumers: the Gateway list and the applet validator must project the
 * shared catalogue into exactly this set, in this order. Changing the
 * authorization surface has to change this expectation too.
 */
const EXPECTED_PROVIDER_DOCUMENT_IDS = [
  'openai',
  'openai-official-subscription',
  'openai-api-platform',
  'anthropic',
  'anthropic-official-subscription',
  'anthropic-api-platform',
  'kimi',
  'kimi-subscription-key',
  'kimi-api-platform',
  'bailian',
  'bailian-pay-as-you-go',
  'bailian-token-plan',
  'bailian-token-plan-team',
  'bailian-coding-plan',
  'deepseek',
  'deepseek-api-platform',
  'zhipu',
  'zhipu-api-platform',
  'zhipu-coding-plan',
  'ollama',
  'ollama-local',
  'custom',
  'custom-openai-compatible',
  'custom-anthropic-compatible',
];

describe('createAiConnectionsServiceAccess', () => {
  it('derives exact resources from the authenticated owner and service WebID', () => {
    const descriptor = createAiConnectionsServiceAccess({
      ownerWebId: 'https://pod.example/alice/profile/card#me',
      serviceWebId: 'https://id.example/xpod/profile/card#me',
    });

    expect(descriptor).toMatchObject({
      appletId: 'co.undefineds.ai-connections',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
    });
    expect(descriptor.resources.map((resource) => resource.id)).toEqual([
      'providerCredentials',
      'providerDefinitions',
      'gatewayAccessKeys',
      'gatewayAccessKeySecrets',
      'quotaSnapshots',
      ...AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS.map((provider) => `providerDocument:${provider}`),
    ]);
    expect(descriptor.resources.map((resource) => resource.url)).toEqual([
      'https://pod.example/alice/settings/credentials.ttl',
      'https://pod.example/alice/settings/providers/__service_access__.ttl',
      'https://pod.example/alice/.data/ai/gateway/access-keys.ttl',
      'https://pod.example/alice/.data/ai/gateway/access-key-secrets.json',
      'https://pod.example/alice/.data/ai/gateway/quota.ttl',
      ...AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS.map((provider) =>
        `https://pod.example/alice/settings/providers/${provider}.ttl`),
    ]);
    expect(descriptor.resources.every((resource) =>
      resource.access.controlRead === undefined &&
      resource.access.controlWrite === undefined,
    )).toBe(true);
  });

  it('projects the granted provider documents from the shared catalogue for both consumers', () => {
    const catalogOfferings = (provider: string) =>
      provider === 'custom'
        ? CUSTOM_DEFAULT_OFFERINGS
        : PROVIDER_OFFERINGS[provider as keyof typeof PROVIDER_OFFERINGS] ?? DEFAULT_PROVIDER_OFFERINGS;
    const projected = AI_CONNECTIONS_PROVIDERS.flatMap((provider) => [
      provider,
      ...catalogOfferings(provider).map((offering) => `${provider}-${offering.id}`),
    ]);

    expect(projected).toEqual(EXPECTED_PROVIDER_DOCUMENT_IDS);
    expect([...AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS]).toEqual(EXPECTED_PROVIDER_DOCUMENT_IDS);
  });

  it('emits documents the applet validator accepts, so the two consumers cannot drift apart', () => {
    const descriptor = createAiConnectionsServiceAccess({
      ownerWebId: 'https://pod.example/alice/profile/card#me',
      serviceWebId: 'https://id.example/xpod/profile/card#me',
    });
    const documents = descriptor.resources.filter((resource) => resource.id.startsWith('providerDocument:'));
    const expectedDocumentIds = EXPECTED_PROVIDER_DOCUMENT_IDS.map((provider) => `providerDocument:${provider}`);
    expect(documents.map((resource) => resource.id)).toEqual(expectedDocumentIds);

    const parsed = parseAiConnectionsServiceAccess({
      appletId: descriptor.appletId,
      service: descriptor.service,
      resources: documents.map((resource) => ({ ...resource })),
    }, 'https://pod.example/alice/');
    expect(parsed.resources.map((resource) => resource.id)).toEqual(expectedDocumentIds);

    // A document outside the projected set is not a valid service resource: the
    // validator is not a superset of what the Gateway grants.
    expect(() => parseAiConnectionsServiceAccess({
      appletId: 'co.undefineds.ai-connections',
      service: { webId: 'https://id.example/xpod/profile/card#me', label: 'Xpod AI Connection' },
      resources: [{
        id: 'providerDocument:openai-retired-offering',
        url: 'https://pod.example/alice/settings/providers/openai-retired-offering.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }, 'https://pod.example/alice/')).toThrow();
  });

  it('can target a resolved hosted Pod root that differs from the WebID origin', () => {
    const descriptor = createAiConnectionsServiceAccess({
      ownerWebId: 'https://id.undefineds.co/alice/profile/card#me',
      serviceWebId: 'https://id.undefineds.co/xpod/profile/card#me',
      podBaseUrl: 'http://127.0.0.1:3000/test/',
    });

    expect(descriptor.resources.find((resource) => resource.id === 'gatewayAccessKeys')?.url)
      .toBe('http://127.0.0.1:3000/test/.data/ai/gateway/access-keys.ttl');
    expect(descriptor.resources.find((resource) => resource.id === 'gatewayAccessKeySecrets')?.url)
      .toBe('http://127.0.0.1:3000/test/.data/ai/gateway/access-key-secrets.json');
  });

  it('does not leak a previously hydrated Pod resource path into another owner descriptor', () => {
    const mutableResource = gatewayAccessKeyResource as unknown as {
      resourcePath: string;
      config: { base: string };
    };
    const originalResourcePath = mutableResource.resourcePath;
    const originalConfigBase = mutableResource.config.base;
    mutableResource.resourcePath = 'https://pod.example/alice/.data/';
    mutableResource.config.base = 'https://pod.example/alice/.data/';

    try {
      const descriptor = createAiConnectionsServiceAccess({
        ownerWebId: 'https://pod.example/bob/profile/card#me',
        serviceWebId: 'https://pod.example/alice/profile/card#me',
      });

      expect(descriptor.resources.find((resource) => resource.id === 'gatewayAccessKeys')?.url)
        .toBe('https://pod.example/bob/.data/ai/gateway/access-keys.ttl');
    } finally {
      mutableResource.resourcePath = originalResourcePath;
      mutableResource.config.base = originalConfigBase;
    }
  });
});
