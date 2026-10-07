import { describe, expect, it, vi } from 'vitest';
import { createOwnerPodBaseUrlResolver, resolveOwnerPodBaseUrl } from '../../../src/api/ai-gateway/pod/PodBaseUrlResolver';
import type { PodLookupResult } from '../../../src/identity/drizzle/PodLookupRepository';

const owner = 'https://identity.example/alice/profile/card#me';
const podA = 'https://cloud.example/alice/';
const podB = 'https://local.example/storage/alice/';
function repository(pods: PodLookupResult[]) {
  return {
    findAllByWebId: vi.fn(async (webId: string) => webId === owner ? pods : []),
    findByWebId: vi.fn(async (webId: string) => webId === owner ? pods[0] : undefined),
  };
}
function registered(baseUrl: string, storageUrl?: string): PodLookupResult {
  return { podId: baseUrl, accountId: 'alice', baseUrl, storageUrl, webId: owner };
}

describe('authoritative current Pod binding', () => {
  it('carries the requested Pod through the same resolver used by repositories', async () => {
    const source = repository([registered(podA), registered(podB)]);
    const resolver = createOwnerPodBaseUrlResolver(source, 'unique');
    await expect(resolveOwnerPodBaseUrl(owner, resolver, {
      type: 'solid', webId: owner, requestedPodUrl: podB,
    })).resolves.toBe(podB);
    expect(source.findAllByWebId).toHaveBeenCalledWith(owner);
  });

  it('intersects the requested Pod with a trusted Pod-scoped capability', async () => {
    const resolver = createOwnerPodBaseUrlResolver(repository([registered(podA), registered(podB)]), 'unique');
    await expect(resolveOwnerPodBaseUrl(owner, resolver, {
      type: 'solid', webId: owner, authorizedPodUrl: podA, requestedPodUrl: podB,
      viaGatewayApiKey: true,
    })).rejects.toThrow();
  });

  it('refuses capability conflicts even when the owner and the requested Pod are both registered', async () => {
    await expect(resolveOwnerPodBaseUrl(owner, async () => podB, {
      type: 'solid', webId: owner, authorizedPodUrl: podA, requestedPodUrl: podB,
    })).rejects.toThrow('service_access_missing');
    await expect(resolveOwnerPodBaseUrl(owner, async () => podA, {
      type: 'solid', webId: owner, authorizedPodUrl: podA, requestedPodUrl: podA,
    })).resolves.toBe(podA);
    await expect(resolveOwnerPodBaseUrl(owner, async () => podA, {
      type: 'solid', webId: 'https://identity.example/bob/profile/card#me', requestedPodUrl: podA,
    })).rejects.toThrow('caller_owner_mismatch');
  });

  it.each([
    ['managed Local', owner, 'https://local.example/storage/alice/'],
    ['Cloud', owner, 'https://cloud.example/storage/alice/'],
    ['Standalone', 'https://standalone.example/alice/profile/card#me', 'https://standalone.example/storage/alice/'],
  ])('preserves the %s identity independently of its registered storage', async (_label, webId, storageUrl) => {
    const source = { findAllByWebId: vi.fn(async () => [{ ...registered(storageUrl), webId }]), findByWebId: vi.fn() };
    const resolver = createOwnerPodBaseUrlResolver(source, 'unique');
    await expect(resolver(webId)).resolves.toBe(storageUrl);
    expect(source.findAllByWebId).toHaveBeenCalledWith(webId);
  });

  it('returns one canonical storage binding for both registered base and storage aliases', async () => {
    const resolver = createOwnerPodBaseUrlResolver(repository([registered(podA, podB)]), 'unique');
    await expect(resolver(owner, podA)).resolves.toBe(podB);
    await expect(resolver(owner, podB)).resolves.toBe(podB);
    await expect(resolver(owner)).resolves.toBe(podB);
  });

  it('refuses unknown owners, unregistered selections, and ambiguous unselected Pods', async () => {
    const resolver = createOwnerPodBaseUrlResolver(repository([registered(podA), registered(podB)]), 'unique');
    await expect(resolver('https://identity.example/bob/profile/card#me', podA)).resolves.toBeUndefined();
    await expect(resolver(owner, 'https://foreign.example/alice/')).resolves.toBeUndefined();
    await expect(resolver(owner)).rejects.toThrow('ambiguous');
  });

  it.each([
    'ftp://local.example/storage/alice/',
    'https://local.example/storage/alice/#me',
    'https://local.example/storage/alice/?owner=alice',
    'https://user:password@local.example/storage/alice/',
    ' https://local.example/storage/alice/',
    'https://local.example/storage/../storage/alice/',
  ])('rejects malformed selected binding %s', async requestedPodUrl => {
    const resolver = createOwnerPodBaseUrlResolver(repository([registered(podB)]), 'unique');
    await expect(resolver(owner, requestedPodUrl)).rejects.toThrow();
  });

  it('fails closed when a specified selection has no binding instead of deriving a WebID root', async () => {
    await expect(resolveOwnerPodBaseUrl(owner, async () => undefined, {
      type: 'solid', webId: owner, requestedPodUrl: podB,
    })).rejects.toThrow();
  });
});
