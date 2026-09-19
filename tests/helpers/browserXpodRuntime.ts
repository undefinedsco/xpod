import type { Page } from '@playwright/test';

export interface BrowserXpodRuntimeSnapshot {
  status: string;
  webId?: string;
  podUrl?: string;
  issuer?: string;
  selectedStorage?: { webId: string; storageUrl: string };
}

export interface BrowserXpodAccountSnapshot {
  status: string;
  isAnonymous: boolean;
  authority?: string;
  id?: string;
  controls: { account?: { webId?: string } };
}

export interface BrowserPodRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function readBrowserXpodRuntime(page: Page): Promise<BrowserXpodRuntimeSnapshot> {
  return inspectBrowserHost(page, { kind: 'runtime' });
}

export function readBrowserXpodAccount(page: Page): Promise<BrowserXpodAccountSnapshot> {
  return inspectBrowserHost(page, { kind: 'account' });
}

export function refetchBrowserXpodAccount(page: Page): Promise<void> {
  return inspectBrowserHost(page, { kind: 'refetch-account' });
}

export function fetchBrowserXpodPod(
  page: Page,
  resourcePath: string,
  init?: BrowserPodRequest,
): Promise<{ status: number; body: string }> {
  return inspectBrowserHost(page, { kind: 'pod-fetch', resourcePath, init });
}

/** Bounded acceptance access through the current mounted Solid session. */
export function fetchBrowserXpodGateway(
  page: Page,
  expectedWebId: string,
  gatewayOrigin: string,
  resourcePath: string,
  init?: BrowserPodRequest,
): Promise<{ status: number; body: string }> {
  return inspectBrowserHost(page, { kind: 'api-fetch', expectedWebId, gatewayOrigin, resourcePath, init });
}

type HostOperation = { kind: 'runtime' } | { kind: 'account' } | { kind: 'refetch-account' }
  | { kind: 'api-fetch'; expectedWebId: string; gatewayOrigin: string; resourcePath: string; init?: BrowserPodRequest }
  | { kind: 'pod-fetch'; resourcePath: string; init?: BrowserPodRequest };

/** Test access to the already-mounted host; never constructs a Session or injects credentials. */
async function inspectBrowserHost<T>(page: Page, operation: HostOperation): Promise<T> {
  return await page.evaluate(async (operation) => {
    type HostValue = {
      state?: { status: string };
      session?: { getSnapshot(): { status: string; webId?: string; issuer?: string } };
      fetch?: typeof fetch;
      webId?: string;
      podUrl?: string;
      issuer?: string;
      selectedStorage?: { webId: string; storageUrl: string };
      currentPod?: { podUrl: string };
      accountState?: { status: string };
      identity?: { id?: string };
      idpIndex?: string;
      controls?: { account?: { webId?: string } };
      isAnonymous?: () => boolean;
      refetchControls?: () => Promise<unknown>;
    };
    type Fiber = {
      child?: Fiber;
      sibling?: Fiber;
      stateNode?: { current?: Fiber };
      memoizedProps?: { value?: HostValue };
    };
    const root = document.getElementById('root');
    if (!root) throw new Error('Missing React host');
    const key = Object.keys(root).find((entry) => entry.startsWith('__reactContainer$'));
    if (!key) throw new Error('Missing mounted React provider tree');
    // The container keeps its original HostRoot fiber. React commits swap
    // root.current; following alternates can expose stale Account/Pod values.
    const current = (root as unknown as Record<string, Fiber>)[key].stateNode?.current;
    if (!current) throw new Error('Missing committed React provider tree');
    const queue: Array<Fiber | undefined> = [current];
    while (queue.length) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const value = fiber.memoizedProps?.value;
      if (operation.kind === 'account' || operation.kind === 'refetch-account') {
        if (typeof value?.refetchControls === 'function') {
          if (operation.kind === 'refetch-account') {
            await value.refetchControls();
            return;
          }
          return {
            status: value.accountState?.status ?? 'unknown',
            isAnonymous: value.isAnonymous?.() ?? value.accountState?.status === 'anonymous',
            authority: value.idpIndex,
            id: value.identity?.id,
            controls: {
              account: value.controls?.account ? { webId: value.controls.account.webId } : undefined,
            },
          };
        }
      } else if (value?.session?.getSnapshot && value.fetch && value.state) {
        const snapshot = value.session.getSnapshot();
        const podUrl = value.selectedStorage?.storageUrl ?? value.currentPod?.podUrl ?? value.podUrl;
        if (operation.kind === 'runtime') {
          return {
            status: snapshot.status,
            webId: snapshot.webId,
            issuer: snapshot.issuer ?? value.issuer,
            podUrl,
            selectedStorage: value.selectedStorage,
          };
        }
        if (operation.kind === 'api-fetch') {
          if (snapshot.status !== 'authenticated' || snapshot.webId !== operation.expectedWebId) throw new Error('Gateway acceptance identity changed');
          const origin = new URL(operation.gatewayOrigin).origin;
          const url = new URL(operation.resourcePath, origin);
          const method = operation.init?.method ?? 'GET';
          const permitted = method === 'GET' && ['/api/ai/providers', '/api/ai/gateway/keys'].includes(url.pathname)
            || method === 'POST' && url.pathname === '/api/ai/gateway/keys'
            || method === 'DELETE' && /^\/api\/ai\/gateway\/keys\/[^/]+$/u.test(url.pathname);
          if (origin !== window.location.origin || url.origin !== origin || url.username || url.password || url.search || url.hash || !permitted) throw new Error('Gateway acceptance request outside boundary');
          const response = await value.fetch(url.href, { ...operation.init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
          return { status: response.status, body: await response.text() };
        }
        if (!podUrl) throw new Error('Missing current Pod');
        const url = new URL(operation.resourcePath, podUrl);
        if (!url.href.startsWith(podUrl)) throw new Error('Test resource must stay inside the current Pod');
        const response = await value.fetch(url.href, operation.init);
        return { status: response.status, body: await response.text() };
      }
      queue.push(fiber.child, fiber.sibling);
    }
    throw new Error(`Missing mounted host capability for ${operation.kind}`);
  }, operation) as T;
}
