import { describe, expect, it, vi } from 'vitest';
import { ViewInteractionHandler, type JsonInteractionHandlerInput, type JsonInteractionHandler, type JsonView, type PodIdRoute } from '@solid/community-server';
import { PodDeletionInteractionHandler } from '../../src/identity/PodDeletionInteractionHandler';
import { PodDeletionInventoryHandler } from '../../src/identity/PodDeletionInventoryHandler';
import type { PodDeletionLifecycleService } from '../../src/service/PodDeletionLifecycleService';

describe('Pod deletion interaction routing', () => {
  const input = { method: 'DELETE', accountId: 'alice', target: { path: 'https://id.test/.account/alice/pod/p1/' }, json: { accountId: 'bob', storageUrl: 'https://evil.test/' } } as JsonInteractionHandlerInput;
  const source = { canHandle: vi.fn(), handle: vi.fn(async () => ({ json: { updated: true } })), getView: vi.fn(async () => ({ json: { pods: { 'https://id.test/alice/': 'control', 'https://external.test/alice/': 'external' } } })) } as unknown as JsonInteractionHandler & JsonView;
  it('locks the previous DELETE 405 and preserves GET/POST while using authenticated identity', async () => {
    const upstream = new ViewInteractionHandler(source);
    await expect(upstream.canHandle(input)).rejects.toMatchObject({ statusCode: 405 });
    const deleteOwned = vi.fn();
    const route = { matchPath: () => ({ accountId: 'alice', podId: 'p1' }) } as unknown as PodIdRoute;
    const handler = new PodDeletionInteractionHandler(upstream, route, { deleteOwned } as unknown as PodDeletionLifecycleService);
    await handler.handleSafe(input);
    expect(deleteOwned).toHaveBeenCalledWith('alice', 'p1');
    expect(await handler.handleSafe({ ...input, method: 'GET' })).toEqual(await source.getView(input));
    expect(await handler.handleSafe({ ...input, method: 'POST' })).toEqual({ json: { updated: true } });
    await expect(handler.handleSafe({ ...input, accountId: undefined })).rejects.toThrow();
  });
  it('advertises separate controls only for supported Pod storage', async () => {
    const handler = new PodDeletionInventoryHandler(source, { canAuthorizeDeletion: async () => false, canDelete: async (url: string) => url.startsWith('https://id.test/') } as unknown as PodDeletionLifecycleService);
    const result = await handler.getView(input);
    expect(result.json.podDeletionControls).toEqual({ 'https://id.test/alice/': 'control' });
    expect(result.json.pods).toHaveProperty('https://external.test/alice/');
  });
});
