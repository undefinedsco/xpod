import { describe, expect, it, vi } from 'vitest';
import { createSolidPermissionCapability } from '../src/solid-permissions';
import type { SolidServiceAccessRequest } from '../src/web';

const request: SolidServiceAccessRequest = {
  appletId: 'co.undefineds.ai-connections',
  service: { webId: 'https://xpod.example/service#agent', label: 'Xpod AI Connection' },
  resources: [{
    id: 'credentials',
    url: 'https://pod.example/alice/settings/credentials.ttl',
    mediaType: 'text/turtle',
    access: { read: true, append: true, write: true },
  }],
};

describe('createSolidPermissionCapability', () => {
  it('creates a missing resource and grants the declared agent access', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'HEAD') return new Response(null, { status: 201 });
      return String(url).endsWith('/settings/')
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    });
    const setAgentAccess = vi.fn(async () => ({ read: true, append: true, write: true }));
    const capability = createSolidPermissionCapability({
      fetch: fetch as typeof globalThis.fetch,
      access: { getAgentAccess: vi.fn(), setAgentAccess } as never,
    });

    await expect(capability.ensureAgentAccess(request)).resolves.toMatchObject({ status: 'granted' });
    expect(fetch).toHaveBeenNthCalledWith(1, request.resources[0].url, { method: 'HEAD' });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://pod.example/alice/settings/', { method: 'HEAD' });
    expect(fetch).toHaveBeenNthCalledWith(3, request.resources[0].url, expect.objectContaining({ method: 'PUT' }));
    expect(setAgentAccess).toHaveBeenCalledWith(
      request.resources[0].url,
      request.service.webId,
      expect.objectContaining({ read: true, append: true, write: true }),
      { fetch },
    );
  });

  it('creates missing parent containers from the nearest existing ancestor', async () => {
    const nestedRequest: SolidServiceAccessRequest = {
      ...request,
      resources: [{ ...request.resources[0], url: 'https://pod.example/alice/.data/ai/gateway/keys.ttl' }],
    };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'HEAD') return new Response(null, { status: 201 });
      return String(url) === 'https://pod.example/alice/'
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    });
    const capability = createSolidPermissionCapability({
      fetch: fetch as typeof globalThis.fetch,
      access: {
        getAgentAccess: vi.fn(),
        setAgentAccess: vi.fn(async () => ({ read: true, append: true, write: true })),
      } as never,
    });

    await expect(capability.ensureAgentAccess(nestedRequest)).resolves.toMatchObject({ status: 'granted' });
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts.map(([url]) => String(url))).toEqual([
      'https://pod.example/alice/.data/',
      'https://pod.example/alice/.data/ai/',
      'https://pod.example/alice/.data/ai/gateway/',
      'https://pod.example/alice/.data/ai/gateway/keys.ttl',
    ]);
  });

  it('does not report granted when the Pod refuses the ACL/ACP update', async () => {
    const capability = createSolidPermissionCapability({
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as typeof globalThis.fetch,
      access: { getAgentAccess: vi.fn(), setAgentAccess: vi.fn(async () => null) } as never,
    });

    await expect(capability.ensureAgentAccess(request)).resolves.toMatchObject({ status: 'permissionDenied' });
  });

  it('inspects and revokes exact service-agent grants', async () => {
    const getAgentAccess = vi.fn(async () => ({ read: true, append: true, write: true }));
    const setAgentAccess = vi.fn(async () => ({ read: false, append: false, write: false }));
    const capability = createSolidPermissionCapability({
      fetch: vi.fn() as typeof globalThis.fetch,
      access: { getAgentAccess, setAgentAccess } as never,
    });

    await expect(capability.inspectAgentAccess(request)).resolves.toMatchObject({ status: 'granted' });
    await expect(capability.revokeAgentAccess(request)).resolves.toMatchObject({ status: 'missing' });
    expect(setAgentAccess).toHaveBeenCalledWith(
      request.resources[0].url,
      request.service.webId,
      expect.objectContaining({ read: false, append: false, write: false }),
      expect.any(Object),
    );
  });
});
