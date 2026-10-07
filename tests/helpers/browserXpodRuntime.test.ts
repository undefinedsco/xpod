import { JSDOM } from 'jsdom';
import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { captureBrowserAiConnections, readBrowserXpodRuntime } from './browserXpodRuntime';

it('retains only the exact committed mounted host, including its existing grant attribution', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('document', dom.window.document);
  const binding = { webId: 'https://id.example/card#me', podUrl: 'https://local.example/b/' };
  const revoke = vi.fn();
  const host = { solid: {
    session: { getSnapshot: () => ({ status: 'authenticated', webId: binding.webId }) },
    permissions: { revokeAgentAccess: revoke }, pod: { status: 'ready', current: binding },
  }, capabilities: {} };
  const controller = { client: { webId: binding.webId }, authorizeService: vi.fn() };
  const runtime = { state: { status: 'authenticated' }, session: host.solid.session, fetch: vi.fn(), currentPod: binding };
  const committed = { memoizedProps: { value: runtime }, child: { memoizedState: {
    memoizedState: [host, []], next: { memoizedState: [{ layout: 'two-pane', controller }, []] },
  } } };
  const stale = { memoizedProps: { value: { ...runtime, currentPod: { ...binding, podUrl: 'https://local.example/a/' } } } };
  Object.assign(dom.window.document.getElementById('root')!, { __reactContainer$fixture: { ...stale, stateNode: { current: committed } } });
  const page = {
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const result = await fn(arg);
      if (!result) throw new Error('Missing mounted host');
      return result;
    },
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  try {
    const retained = await captureBrowserAiConnections(page, binding) as unknown as { host: typeof host; controller: typeof controller };
    expect(retained.host).toBe(host);
    expect(retained.controller).toBe(controller);
    expect(retained.host.solid.permissions.revokeAgentAccess).toBe(revoke);
    expect((await readBrowserXpodRuntime(page)).podUrl).toBe(binding.podUrl);
    await expect(captureBrowserAiConnections(page, { ...binding, podUrl: 'https://local.example/a/' })).rejects.toThrow('Missing mounted host');
    await expect(captureBrowserAiConnections(page, { ...binding, webId: 'https://id.example/card#other' })).rejects.toThrow('Missing mounted host');
    host.solid.session.getSnapshot = () => ({ status: 'anonymous', webId: binding.webId });
    await expect(captureBrowserAiConnections(page, binding)).rejects.toThrow('Missing mounted host');
    expect(revoke).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
});

// Authentication can commit before the lazy settings page mounts its applet.
it('waits for the exact mounted applet after authentication without accepting another Pod', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('document', dom.window.document);
  const binding = { webId: 'https://id.example/card#me', podUrl: 'https://local.example/b/' };
  const host = { solid: {
    session: { getSnapshot: () => ({ status: 'authenticated', webId: binding.webId }) },
    permissions: { revokeAgentAccess: vi.fn() }, pod: { status: 'ready', current: binding },
  }, capabilities: {} };
  const controller = { client: { webId: binding.webId }, authorizeService: vi.fn() };
  const committed: { child?: object } = {};
  Object.assign(dom.window.document.getElementById('root')!, { __reactContainer$fixture: { stateNode: { current: committed } } });
  const mount = (podUrl: string) => ({ memoizedState: {
    memoizedState: [{ ...host, solid: { ...host.solid, pod: { status: 'ready', current: { ...binding, podUrl } } } }, []],
    next: { memoizedState: [{ layout: 'two-pane', controller }, []] },
  } });
  const observations: unknown[] = [];
  const page = {
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown, options: { timeout: number }) => {
      expect(options.timeout).toBeGreaterThan(0);
      const observed = fn(arg);
      expect(observed).not.toBeInstanceOf(Promise);
      observations.push(observed);
      committed.child = mount('https://local.example/a/');
      observations.push(await fn(arg));
      committed.child = mount(binding.podUrl);
      return await fn(arg);
    },
  } as unknown as Page;
  try {
    const retained = await captureBrowserAiConnections(page, binding) as unknown as { host: typeof host; controller: typeof controller };
    expect(observations).toEqual([false, false]);
    expect(retained.host.solid.pod.current).toEqual(binding);
    expect(retained.controller).toBe(controller);
    expect(host.solid.permissions.revokeAgentAccess).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
});
