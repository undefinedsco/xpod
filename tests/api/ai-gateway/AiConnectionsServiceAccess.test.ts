import { gatewayAccessKeyResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import {
  AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS,
  createAiConnectionsServiceAccess,
} from '../../../src/api/ai-gateway/service-access/AiConnectionsServiceAccess';

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
