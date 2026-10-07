import { JSDOM } from 'jsdom';
import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { captureBrowserAiConnections, readBrowserXpodRuntime } from './browserXpodRuntime';

function mountedFixture() {
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
  const appletFiber = (value: typeof host) => ({ memoizedState: {
    memoizedState: [value, []], next: { memoizedState: [{ layout: 'two-pane', controller }, []] },
  } });
  const committed = { memoizedProps: { value: runtime }, child: appletFiber(host) };
  const stale = { memoizedProps: { value: { ...runtime, currentPod: { ...binding, podUrl: 'https://local.example/a/' } } } };
  const rootState = { current: committed };
  Object.assign(dom.window.document.getElementById('root')!, { __reactContainer$fixture: { ...stale, stateNode: rootState } });
  const evaluate = async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg);
  const page = {
    evaluateHandle: evaluate, evaluate,
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const value = await fn(arg);
      if (!value) throw new Error('Missing mounted host capability for ai-host');
      return value;
    },
  };
  return { binding, host, controller, revoke, runtime, committed, rootState, appletFiber, page,
    close: () => { vi.unstubAllGlobals(); dom.window.close(); } };
}

it('retains only the exact committed mounted host, including its existing grant attribution', async () => {
  const fixture = mountedFixture();
  const { binding, host, controller, revoke } = fixture;
  const page = fixture.page as unknown as Page;
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
  } finally { fixture.close(); }
});

it('waits for the exact committed applet after runtime authentication', async () => {
  const fixture = mountedFixture();
  const { binding, host, controller, committed, rootState, appletFiber } = fixture;
  const unmounted = { ...committed, child: undefined } as unknown as typeof committed;
  const foreignHost = { ...host, solid: { ...host.solid,
    pod: { ...host.solid.pod, current: { ...binding, podUrl: 'https://local.example/a/' } } } };
  const foreign = { ...committed, child: appletFiber(foreignHost) };
  rootState.current = unmounted;
  const observations: unknown[] = [];
  fixture.page.waitForFunction = async (fn, arg) => {
    for (const current of [unmounted, foreign, committed]) {
      rootState.current = current;
      const value = fn(arg);
      expect(value).not.toBeInstanceOf(Promise);
      observations.push(value);
      if (value) return value;
    }
    throw new Error('Missing mounted host capability for ai-host');
  };
  try {
    expect((await readBrowserXpodRuntime(fixture.page as unknown as Page)).status).toBe('authenticated');
    const retained = await captureBrowserAiConnections(fixture.page as unknown as Page, binding) as unknown as { host: typeof host; controller: typeof controller };
    expect(observations).toHaveLength(3);
    expect(observations.slice(0, 2).every(value => !value)).toBe(true);
    expect(retained.host).toBe(host);
    expect(retained.controller).toBe(controller);
    expect(fixture.revoke).not.toHaveBeenCalled();
  } finally { fixture.close(); }
});
