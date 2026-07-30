import { gatewayAccessKeyResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import { createAiConnectionServiceAccess } from '../../../src/api/ai-gateway/service-access/AiConnectionServiceAccess';

describe('createAiConnectionServiceAccess', () => {
  it('derives exact resources from the authenticated owner and service WebID', () => {
    const descriptor = createAiConnectionServiceAccess({
      ownerWebId: 'https://pod.example/alice/profile/card#me',
      serviceWebId: 'https://id.example/xpod/profile/card#me',
    });

    expect(descriptor).toMatchObject({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
    });
    expect(descriptor.resources.map((resource) => resource.url)).toEqual([
      'https://pod.example/alice/settings/credentials.ttl',
      'https://pod.example/alice/settings/providers/__service_access__.ttl',
      'https://pod.example/alice/.data/ai/gateway/access-keys.ttl',
      'https://pod.example/alice/.data/ai/gateway/quota.ttl',
    ]);
    expect(descriptor.resources.every((resource) =>
      resource.access.controlRead === undefined &&
      resource.access.controlWrite === undefined,
    )).toBe(true);
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
      const descriptor = createAiConnectionServiceAccess({
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
