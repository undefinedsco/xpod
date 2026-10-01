import { describe, expect, it, vi } from 'vitest';
import { createMatrixPodResolver, resolveMatrixContext } from '../../../src/api/matrix/MatrixPodResolver';
import type { PodLookupResult } from '../../../src/identity/drizzle/PodLookupRepository';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';

const webId = 'https://identity.example/people/alice#me';
const pod: PodLookupResult = {
  podId: 'p1', accountId: 'a1', webId,
  baseUrl: 'https://storage.example/custom-pod/',
  storageUrl: 'https://node.example/p1/',
};

function repository(pods: PodLookupResult[] = [pod]) {
  return {
    findAllByWebId: vi.fn(async () => pods),
    findByResourceIdentifier: vi.fn(async (_url: string) => pods[0]),
  };
}

describe('MatrixPodResolver', () => {
  it('uses exact persisted ownership despite unrelated WebID issuer and path', async () => {
    const repo = repository();
    expect(await createMatrixPodResolver(repo)(webId)).toBe(pod.baseUrl);
    expect(repo.findAllByWebId).toHaveBeenCalledWith(webId);
    expect(repo.findByResourceIdentifier).not.toHaveBeenCalled();
  });

  it('requires explicit selection for multiple owned Pods', async () => {
    const repo = repository([pod, { ...pod, podId: 'p2', baseUrl: 'https://other.example/' }]);
    await expect(createMatrixPodResolver(repo)(webId)).rejects.toMatchObject({ status: 400, errcode: 'M_INVALID_PARAM' });
  });

  it('does not guess an address when the WebID owns no Pod', async () => {
    await expect(createMatrixPodResolver(repository([]))(webId)).rejects.toMatchObject({ status: 404 });
  });

  it.each([pod.baseUrl, pod.baseUrl.slice(0, -1), pod.storageUrl!])('accepts a registered root %s and returns its canonical base', async requested => {
    const repo = repository();
    expect(await createMatrixPodResolver(repo)(webId, requested)).toBe(pod.baseUrl);
    expect(repo.findAllByWebId).not.toHaveBeenCalled();
  });

  it('allows a known shared Pod without substituting the caller identity', async () => {
    const resolver = createMatrixPodResolver(repository());
    const auth = { type: 'solid' as const, webId: 'https://agents.example/bob#me', accessToken: 'caller-token' };
    const context = await resolveMatrixContext({ auth, headers: { 'x-xpod-pod-url': pod.baseUrl } } as unknown as AuthenticatedRequest, resolver);
    expect(context).toEqual({ webId: auth.webId, auth, podUrl: pod.baseUrl });
    expect(context.auth).toBe(auth);
  });

  it.each([
    '/relative/', 'file:///etc/', 'https://user:password@storage.example/custom-pod/',
    'https://storage.example/custom-pod/?x=1', 'https://storage.example/custom-pod/#secret',
    '', ' https://storage.example/custom-pod/', 'https://storage.example/custom-pod/?',
  ])('rejects malformed selectors before repository lookup: %s', async requested => {
    const repo = repository();
    await expect(createMatrixPodResolver(repo)(webId, requested)).rejects.toMatchObject({ status: 400 });
    expect(repo.findByResourceIdentifier).not.toHaveBeenCalled();
  });

  it.each([
    'https://storage.example/custom-pod/evil/',
    'https://storage.example/custom-pod-evil/',
    'https://storage.example.evil/custom-pod/',
    'https://node.example/p1/other/',
  ])('rejects prefix-only matches: %s', async requested => {
    await expect(createMatrixPodResolver(repository())(webId, requested)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects unregistered remote destinations', async () => {
    await expect(createMatrixPodResolver(repository([]))(webId, 'http://127.0.0.1/internal/')).rejects.toMatchObject({ status: 403 });
  });

  it('requires Solid authentication before resolution', async () => {
    const resolver = vi.fn();
    await expect(resolveMatrixContext({ auth: { type: 'node', nodeId: 'n' }, headers: {} } as AuthenticatedRequest, resolver)).rejects.toMatchObject({ status: 401 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects ambiguous repeated Pod selectors', async () => {
    const resolver = vi.fn();
    await expect(resolveMatrixContext({ auth: { type: 'solid', webId }, headers: { 'x-xpod-pod-url': [pod.baseUrl, 'https://other.example/'] } } as unknown as AuthenticatedRequest, resolver)).rejects.toMatchObject({ status: 400 });
    expect(resolver).not.toHaveBeenCalled();
  });
});
