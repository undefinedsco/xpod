import { JSDOM } from 'jsdom';
import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { captureBrowserAiConnections, readBrowserXpodRuntime } from './browserXpodRuntime';

/**
 * Execute a page callback the way Playwright does: ONLY `fn.toString()` crosses
 * the boundary, and the body runs in a fresh scope with no Node module bindings.
 *
 * This is what makes the harness able to catch a callback that closes over a
 * module-scope helper (the RC417 defect: `samePodRoot is not defined`).
 *
 * Identity is preserved because the jsdom document and the fiber tree live in
 * this same process, so traversing `document` inside the isolated function still
 * yields the very objects the test built.
 */
function runSerialized<T>(fn: (arg: unknown) => unknown, arg: unknown): T {
  // Playwright transpiles then serializes; `fn` here is already transpiled JS, so
  // toString() is exactly the text the page would receive.
  const isolated = new Function('arg', `"use strict"; return (${fn.toString()})(arg);`);
  return isolated(arg) as T;
}

function mountedFixture() {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('document', dom.window.document);
  const binding = { webId: 'https://id.example/card#me', podUrl: 'https://local.example/b/' };
  const revoke = vi.fn();
  const host = { solid: {
    session: { getSnapshot: () => ({ status: 'authenticated', webId: binding.webId }) },
    permissions: { revokeAgentAccess: revoke }, pod: { status: 'ready', current: binding },
  }, capabilities: {} };
  // The client carries its OWN immutable Pod binding; apiBase alone (origin only)
  // cannot distinguish two Pods of the same owner on one Gateway.
  const controller = { client: { webId: binding.webId,
    apiBase: new URL(binding.podUrl).origin, podBaseUrl: binding.podUrl }, authorizeService: vi.fn() };
  const runtime = { state: { status: 'authenticated' }, session: host.solid.session, fetch: vi.fn(), currentPod: binding };
  const appletFiber = (value: typeof host) => ({ memoizedState: {
    memoizedState: [value, []], next: { memoizedState: [{ layout: 'two-pane', controller }, []] },
  } });
  const committed = { memoizedProps: { value: runtime }, child: appletFiber(host) };
  const stale = { memoizedProps: { value: { ...runtime, currentPod: { ...binding, podUrl: 'https://local.example/a/' } } } };
  const rootState = { current: committed };
  Object.assign(dom.window.document.getElementById('root')!, { __reactContainer$fixture: { ...stale, stateNode: rootState } });
  const page = {
    evaluateHandle: async (fn: (arg: unknown) => unknown, arg: unknown) => runSerialized(fn, arg),
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => runSerialized(fn, arg),
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const value = await runSerialized(fn, arg);
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

it('runs the real capture callback through Playwright serialization with no module bindings (RC417 regression)', async () => {
  const fixture = mountedFixture();
  const { binding } = fixture;
  const page = fixture.page as unknown as Page;
  try {
    // Only fn.toString() crosses into the page, so a callback closing over a
    // module-scope helper throws there. Any such throw fails this test outright;
    // there is deliberately no message-text assertion.
    const retained = await captureBrowserAiConnections(page, binding) as unknown as
      { host: typeof fixture.host; controller: typeof fixture.controller };
    expect(retained.host).toBe(fixture.host);
    expect(retained.controller).toBe(fixture.controller);
    // A same-origin, same-webId client bound to another Pod must still refuse.
    await expect(captureBrowserAiConnections(page, { ...binding,
      podUrl: 'https://local.example/a/' })).rejects.toThrow('Missing mounted host');
  } finally { fixture.close(); }
});

it('refuses a same-origin same-webId client bound to a DIFFERENT Pod', async () => {
  const fixture = mountedFixture();
  const { binding, controller } = fixture;
  const page = fixture.page as unknown as Page;
  try {
    // Sanity: the correct Pod binding IS accepted.
    await expect(captureBrowserAiConnections(page, binding)).resolves.toBeDefined();
    // Same owner, same Gateway origin, same webId, different Pod path. The
    // origin-only apiBase is identical, so only podBaseUrl can catch this.
    const foreign = { ...controller, client: { ...controller.client,
      podBaseUrl: 'https://local.example/a/' } };
    expect(new URL(foreign.client.podBaseUrl).origin).toBe(new URL(binding.podUrl).origin);
    expect(foreign.client.apiBase).toBe(controller.client.apiBase);
    expect(foreign.client.webId).toBe(controller.client.webId);
    expect(foreign.client.podBaseUrl).not.toBe(binding.podUrl);
    // Swap the mounted controller for the foreign-client one.
    Object.defineProperty(controller, 'client', { value: foreign.client, configurable: true });
    await expect(captureBrowserAiConnections(page, binding)).rejects.toThrow('Missing mounted host');
    // Restoring the correct binding makes capture succeed again.
    Object.defineProperty(controller, 'client', { value: fixture.controller.client, configurable: true });
  } finally { fixture.close(); }
});

it('accepts trailing-slash variance on the same root but refuses a different webId', async () => {
  const fixture = mountedFixture();
  const { binding, controller, host } = fixture;
  const page = fixture.page as unknown as Page;
  try {
    // Same root written without the trailing slash is still the same Pod.
    Object.defineProperty(controller, 'client', { value: { ...controller.client,
      podBaseUrl: binding.podUrl.replace(/\/$/u, '') }, configurable: true });
    await expect(captureBrowserAiConnections(page, binding)).resolves.toBeDefined();
    // Same Pod root but a different owner identity must never be accepted.
    Object.defineProperty(controller, 'client', { value: { ...controller.client,
      podBaseUrl: binding.podUrl, webId: 'https://id.example/card#other' }, configurable: true });
    await expect(captureBrowserAiConnections(page, binding)).rejects.toThrow('Missing mounted host');
    expect(host.solid.pod.current.podUrl).toBe(binding.podUrl);
  } finally { fixture.close(); }
});

it('refuses a client that exposes no Pod binding at all', async () => {
  const fixture = mountedFixture();
  const { binding, controller } = fixture;
  const page = fixture.page as unknown as Page;
  try {
    Object.defineProperty(controller, 'client', { value: { webId: binding.webId,
      apiBase: new URL(binding.podUrl).origin }, configurable: true });
    // A client that cannot prove its Pod must never satisfy the binding check.
    await expect(captureBrowserAiConnections(page, binding)).rejects.toThrow('Missing mounted host');
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

it('waits for the current Account actor without accepting the retained Pod-only host', async () => {
  const fixture = mountedFixture();
  const { binding, host, controller, committed, rootState, appletFiber } = fixture;
  const accountHost = { ...host, capabilities: { aiClientCredentials: { list: vi.fn() } } };
  const accountCommitted = { ...committed, child: appletFiber(accountHost) };
  const observations: unknown[] = [];
  fixture.page.waitForFunction = async (fn, arg) => {
    for (const current of [committed, accountCommitted]) {
      rootState.current = current;
      const value = fn(arg);
      expect(value).not.toBeInstanceOf(Promise);
      observations.push(value);
      if (value) return value;
    }
    throw new Error('Missing mounted host capability for ai-host');
  };
  try {
    const retained = await captureBrowserAiConnections(fixture.page as unknown as Page,
      { ...binding, requireAccountActor: true }) as unknown as { host: typeof accountHost; controller: typeof controller };
    expect(observations.map(Boolean)).toEqual([false, true]);
    expect(retained.host).toBe(accountHost);
    expect(retained.controller).toBe(controller);
    expect(fixture.revoke).not.toHaveBeenCalled();
  } finally { fixture.close(); }
});
