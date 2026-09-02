import { describe, expect, it, vi } from 'vitest';
import { createMockWebExtensionHost } from '../src/testing';
import type {
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  SolidServiceAccessStatus,
  WebExtensionSolidCapability,
} from '../src/web';

describe('WebExtensionSolidCapability permissions', () => {
  it('lets a WebExtensionHost carry host-owned Solid permission brokering', async () => {
    const request: SolidServiceAccessRequest = {
      appletId: 'ai-connections',
      service: {
        webId: 'https://xpod.example/service#agent',
        label: 'Xpod AI Gateway',
      },
      resources: [
        {
          id: 'settings/model-provider.ttl',
          url: 'https://pod.example/alice/settings/model-provider.ttl',
          mediaType: 'text/turtle',
          access: {
            read: true,
            append: true,
            write: true,
          },
        },
      ],
    };
    const granted: SolidServiceAccessStatus = {
      status: 'granted',
      resources: request.resources,
    };
    const permissions: SolidPermissionCapability = {
      inspectAgentAccess: vi.fn(async () => granted),
      ensureAgentAccess: vi.fn(async () => granted),
      revokeAgentAccess: vi.fn(async () => granted),
    };
    const solid: WebExtensionSolidCapability = {
      session: {
        fetch: globalThis.fetch,
        getSnapshot: () => ({ status: 'authenticated', webId: 'https://pod.example/alice/profile/card#me' }),
        subscribe: () => () => undefined,
      },
      permissions,
      requireLogin: async () => undefined,
    };
    const host = createMockWebExtensionHost({ solid });

    const status = await host.solid.permissions?.ensureAgentAccess(request);

    expect(host.solid.pod).toBeUndefined();
    expect(host.solid.permissions).toBe(permissions);
    expect(permissions.ensureAgentAccess).toHaveBeenCalledWith({
      appletId: 'ai-connections',
      service: {
        webId: 'https://xpod.example/service#agent',
        label: 'Xpod AI Gateway',
      },
      resources: [
        {
          id: 'settings/model-provider.ttl',
          url: 'https://pod.example/alice/settings/model-provider.ttl',
          mediaType: 'text/turtle',
          access: {
            read: true,
            append: true,
            write: true,
          },
        },
      ],
    });
    expect(status).toEqual({
      status: 'granted',
      resources: request.resources,
    });
  });
});
