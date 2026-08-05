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
      'https://pod.example/alice/settings/providers/openai.ttl',
      'https://pod.example/alice/settings/providers/anthropic.ttl',
      'https://pod.example/alice/settings/providers/kimi.ttl',
      'https://pod.example/alice/settings/providers/bailian.ttl',
      'https://pod.example/alice/settings/providers/deepseek.ttl',
      'https://pod.example/alice/.data/ai/gateway/quota.ttl',
    ]);
    expect(descriptor.resources.every((resource) =>
      resource.access.controlRead === undefined &&
      resource.access.controlWrite === undefined,
    )).toBe(true);
  });

  it('does not publish a duplicate Gateway Access Key resource', () => {
    const descriptor = createAiConnectionServiceAccess({
      ownerWebId: 'https://pod.example/bob/profile/card#me',
      serviceWebId: 'https://pod.example/alice/profile/card#me',
    });

    expect(descriptor.resources.map((resource) => resource.id)).not.toContain('gatewayAccessKeys');
  });
});
