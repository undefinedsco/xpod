import { asValue, createContainer } from 'awilix';
import { describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { PodChatKitStore, type PodChatKitStoreOptions } from '../../../src/api/chatkit/pod-store';
import { registerCommonServices } from '../../../src/api/container/common';
import type { StoreContext } from '../../../src/api/chatkit/store';
import type { ThreadMetadata } from '../../../src/api/chatkit/types';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const STORAGE = 'https://storage.example/alice/';
const THREAD_ID = 'task/task_1/index.ttl#thread_1';

function context(): StoreContext {
  return { userId: WEB_ID, auth: { type: 'solid', webId: WEB_ID } };
}
function thread(): ThreadMetadata {
  return { id: THREAD_ID, parent: 'task/index.ttl#task_1', status: { type: 'active' },
    created_at: 1, updated_at: 1, workspace: `${STORAGE}work/` };
}
function transport(denied = false) {
  return vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://id.example/') || denied) return new Response(null, { status: 403 });
    const method = init?.method ?? 'GET';
    return new Response(null, { status: method === 'PUT' ? 201 : method === 'PATCH' ? 205 : 404 });
  });
}
function wiredStore(roots: string[], request: typeof fetch) {
  const container = createContainer();
  registerCommonServices(container);
  const lookup = {
    findByWebId: vi.fn(async () => roots.length ? { storageUrl: roots[0], baseUrl: roots[0] } : undefined),
    findAllByWebId: vi.fn(async () => roots.map(storageUrl => ({ storageUrl, baseUrl: storageUrl }))),
  };
  container.register({
    config: asValue({ edition: 'local' }), ownerPodAccess: asValue({ getPodFetch: async () => request }),
    podLookupRepo: asValue(lookup), serverGroupReconcilerService: asValue(undefined),
  });
  return { store: container.resolve<PodChatKitStore>('chatKitStore'), lookup };
}

describe('ChatKit authoritative Pod storage', () => {
  it('creates the Task thread through real drizzle at Local storage and never Cloud card data', async () => {
    const request = transport();
    const { store } = wiredStore([STORAGE], request);
    await store.saveThread(thread(), context());
    const targets = request.mock.calls.map(([input, init]) => ({ url: String(input), method: init?.method ?? 'GET' }));
    expect(targets.some(row => row.url === `${STORAGE}.data/task/task_1/index.ttl` && ['PUT', 'PATCH'].includes(row.method))).toBe(true);
    expect(targets.every(row => row.url.startsWith(STORAGE))).toBe(true);
  });

  it('fails before data access when no owned storage binding is available', async () => {
    const request = transport();
    const { store } = wiredStore([], request);
    await expect(store.saveThread(thread(), context())).rejects.toThrow(/storage.*unavailable/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses multiple storage roots for the same WebID', async () => {
    const request = transport();
    const { store } = wiredStore([STORAGE, 'https://other.example/alice/'], request);
    await expect(store.saveThread(thread(), context())).rejects.toThrow(/storage.*ambiguous/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('deduplicates repeated bindings of one storage root', async () => {
    const request = transport();
    const { store, lookup } = wiredStore([STORAGE, STORAGE.replace(/\/$/u, '')], request);
    await store.saveThread(thread(), context());
    expect(lookup.findAllByWebId).toHaveBeenCalledWith(WEB_ID);
    expect(request.mock.calls.every(([input]) => String(input).startsWith(STORAGE))).toBe(true);
  });

  it('retains a real Local storage 403 without treating it as missing or trying Cloud', async () => {
    const request = transport(true);
    const { store } = wiredStore([STORAGE], request);
    await expect(store.saveThread(thread(), context())).rejects.toThrow();
    expect(request.mock.calls.every(([input]) => String(input).startsWith(STORAGE))).toBe(true);
    expect(request.mock.calls.every(([, init]) => !['PUT', 'PATCH'].includes(init?.method ?? 'GET'))).toBe(true);
  });

  it('uses a previously verified explicit context root without selecting another binding', async () => {
    const request = transport();
    const resolver = vi.fn(async () => 'https://other.example/alice/');
    const store = new PodChatKitStore({ podAccess: { getPodFetch: async () => request },
      podBaseUrlResolver: resolver } as PodChatKitStoreOptions);
    await store.saveThread(thread(), { ...context(), podUrl: STORAGE } as StoreContext);
    expect(resolver).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([input]) => String(input).startsWith(STORAGE))).toBe(true);
  });

  it('rejects changing an explicit root on a context with an already bound database', async () => {
    const request = transport();
    const { store } = wiredStore([STORAGE], request);
    const boundContext = { ...context(), podUrl: STORAGE } as StoreContext;
    await store.saveThread(thread(), boundContext);
    const db = (boundContext as StoreContext & { _cachedDb?: unknown })._cachedDb;
    request.mockClear();
    (boundContext as StoreContext & { podUrl: string }).podUrl = 'https://other.example/alice/';
    await expect(store.saveThread(thread(), boundContext)).rejects.toThrow(/storage.*binding.*changed/i);
    expect(request).not.toHaveBeenCalled();
    expect((boundContext as StoreContext & { _cachedDb?: unknown })._cachedDb).toBe(db);
  });

  it('preserves the explicit Standalone database binding contract', async () => {
    const request = transport();
    const db = drizzle({ fetch: request, info: { webId: WEB_ID, isLoggedIn: true } }, { podUrl: STORAGE });
    const store = new PodChatKitStore({});
    await store.saveThread(thread(), { ...context(), _cachedDb: db } as StoreContext);
    expect(request.mock.calls.every(([input]) => String(input).startsWith(STORAGE))).toBe(true);
  });

  it('forwards the task credential binding to Pod access and binds it to the cached database', async () => {
    const request = transport();
    const getPodFetch = vi.fn(async () => request);
    const store = new PodChatKitStore({ podAccess: { getPodFetch }, podBaseUrlResolver: async () => STORAGE });
    const boundContext = { ...context(), taskCredential: { credentialRef: 'taskcred_a', version: 3 } } as StoreContext;
    await store.saveThread(thread(), boundContext);
    expect(getPodFetch).toHaveBeenCalledWith(WEB_ID, expect.objectContaining({
      taskCredential: { credentialRef: 'taskcred_a', version: 3 },
    }));
    expect((boundContext as { _cachedAuth?: string })._cachedAuth).toBeDefined();
  });

  it('does not reuse a cached database after the task credential binding changes', async () => {
    const request = transport();
    const getPodFetch = vi.fn(async () => request);
    const store = new PodChatKitStore({ podAccess: { getPodFetch }, podBaseUrlResolver: async () => STORAGE });
    const boundContext = { ...context(), taskCredential: { credentialRef: 'taskcred_a', version: 3 } } as StoreContext;
    await store.saveThread(thread(), boundContext);
    const callsBefore = getPodFetch.mock.calls.length;
    (boundContext as { taskCredential?: unknown }).taskCredential = { credentialRef: 'taskcred_a', version: 4 };
    await expect(store.saveThread(thread(), boundContext)).rejects.toThrow(/credential binding changed/i);
    expect(getPodFetch.mock.calls.length).toBe(callsBefore);
  });
});
