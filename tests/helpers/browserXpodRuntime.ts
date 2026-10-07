import type { JSHandle, Page } from '@playwright/test';
import type { AiConnectionsController } from '@undefineds.co/ai-connections';
import type { WebExtensionHost } from '@undefineds.co/extension-sdk/web';

export interface MountedBrowserAiConnections {
  host: WebExtensionHost;
  controller: AiConnectionsController;
}

/** Retain the exact mounted capability so attribution can be restored before navigation.
 * This is a read-only handle to React's existing objects, not a second host/session.
 */
export async function captureBrowserAiConnections(page: Page, binding: { webId: string; podUrl: string }): Promise<JSHandle<MountedBrowserAiConnections>> {
  // Session authentication and the lazy applet commit are separate transitions.
  // Poll the committed tree, retaining only the exact current binding; a stale
  // host, another Pod or an anonymous session can never satisfy this wait.
  return await page.waitForFunction(inspectCommittedHost,
    { kind: 'ai-host' as const, ...binding }, { timeout: 30_000 }) as JSHandle<MountedBrowserAiConnections>;
}

export interface BrowserXpodRuntimeSnapshot {
  status: string;
  webId?: string;
  podUrl?: string;
  issuer?: string;
  selectedStorage?: { webId: string; storageUrl: string };
  aiClientConfigurationAvailable?: boolean;
}

export interface BrowserXpodAccountSnapshot {
  status: string;
  isAnonymous: boolean;
  authority?: string;
  id?: string;
  controls: { account?: { webId?: string } };
  hasClientCredentialsControl?: boolean;
  hasIdentityWebId?: boolean;
  identityMatchesRuntime?: boolean;
}

export interface BrowserPodRequest {
  cache?: RequestCache;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function readBrowserXpodRuntime(page: Page): Promise<BrowserXpodRuntimeSnapshot> {
  return inspectBrowserHost(page, { kind: 'runtime' });
}

export function readBrowserXpodAccount(page: Page, expectedWebId?: string): Promise<BrowserXpodAccountSnapshot> {
  return inspectBrowserHost(page, { kind: 'account', expectedWebId });
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

export function readBrowserSessionAccountControls(page: Page): Promise<{ status: number; hasClientCredentialsControl: boolean; keys: string[] }> {
  return inspectBrowserHost(page, { kind: 'account-discovery' });
}

type HostOperation = { kind: 'ai-host'; webId: string; podUrl: string }
  | { kind: 'account-discovery' } | { kind: 'runtime' } | { kind: 'account'; expectedWebId?: string } | { kind: 'refetch-account' }
  | { kind: 'api-fetch'; expectedWebId: string; gatewayOrigin: string; resourcePath: string; init?: BrowserPodRequest }
  | { kind: 'pod-fetch'; resourcePath: string; init?: BrowserPodRequest };

/** Test access to the already-mounted host; never constructs a Session or injects credentials. */
async function inspectBrowserHost<T>(page: Page, operation: HostOperation): Promise<T> {
  return await page.evaluate(inspectCommittedHost, operation) as T;
}

/** Serialized into the page; all discoveries use the same committed root traversal. */
function inspectCommittedHost(operation: HostOperation): unknown {
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
      identity?: { id?: string; webId?: string };
      idpIndex?: string;
      controls?: { account?: { webId?: string; clientCredentials?: string } };
      isAnonymous?: () => boolean;
      refetchControls?: () => Promise<unknown>;
      aiClientConfiguration?: { available?: boolean };
    };
    type Fiber = {
      child?: Fiber;
      sibling?: Fiber;
      stateNode?: { current?: Fiber };
      memoizedProps?: { value?: HostValue };
      memoizedState?: { memoizedState?: unknown; next?: Fiber['memoizedState'] };
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
      if (operation.kind === 'ai-host') {
        // ModelsPage keeps the actual host and mounted applet in adjacent useMemo
        // hooks. Following current hooks avoids stale alternate/provider values.
        let host: WebExtensionHost | undefined;
        let controller: AiConnectionsController | undefined;
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const entry = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : undefined;
          if (entry?.solid?.session?.getSnapshot && entry?.solid?.permissions && entry?.capabilities) host = entry;
          if (entry?.layout === 'two-pane' && entry.controller?.client && entry.controller?.authorizeService) controller = entry.controller;
        }
        if (host && controller) {
          const snapshot = host.solid.session.getSnapshot();
          const pod = host.solid.pod;
          if (snapshot.status === 'authenticated' && snapshot.webId === operation.webId
            && pod?.status === 'ready' && pod.current.webId === operation.webId && pod.current.podUrl === operation.podUrl
            && controller.client?.webId === operation.webId) return { host, controller };
        }
      } else
      if (operation.kind === 'account' || operation.kind === 'refetch-account') {
        if (typeof value?.refetchControls === 'function') {
          if (operation.kind === 'refetch-account') {
            return Promise.resolve(value.refetchControls()).then(() => undefined);
          }
          return {
            status: value.accountState?.status ?? 'unknown',
            isAnonymous: value.isAnonymous?.() ?? value.accountState?.status === 'anonymous',
            authority: value.idpIndex,
            id: value.identity?.id,
            hasClientCredentialsControl: typeof value.controls?.account?.clientCredentials === 'string',
            hasIdentityWebId: Boolean(value.identity?.webId),
            identityMatchesRuntime: operation.kind === 'account' && operation.expectedWebId !== undefined ? value.identity?.webId === operation.expectedWebId : undefined,
            controls: {
              account: value.controls?.account ? { webId: value.controls.account.webId } : undefined,
            },
          };
        }
      } else if (value?.session?.getSnapshot && value.fetch && value.state) {
        const snapshot = value.session.getSnapshot();
        const podUrl = value.selectedStorage?.storageUrl ?? value.currentPod?.podUrl ?? value.podUrl;
        if (operation.kind === 'account-discovery') {
          return value.fetch(new URL('/.account/', window.location.origin).href, { headers: { Accept: 'application/json' }, redirect: 'error' }).then(async response => {
            const body = await response.json() as { controls?: { account?: { clientCredentials?: string } } };
            return { status: response.status, keys: Object.keys(body.controls?.account ?? {}), hasClientCredentialsControl: typeof body.controls?.account?.clientCredentials === 'string' };
          });
        }
        if (operation.kind === 'runtime') {
          return {
            status: snapshot.status,
            webId: snapshot.webId,
            issuer: snapshot.issuer ?? value.issuer,
            podUrl,
            selectedStorage: value.selectedStorage,
            aiClientConfigurationAvailable: value.aiClientConfiguration?.available,
          };
        }
        if (operation.kind === 'api-fetch') {
          if (snapshot.status !== 'authenticated' || snapshot.webId !== operation.expectedWebId) throw new Error('Gateway acceptance identity changed');
          const origin = new URL(operation.gatewayOrigin).origin;
          const url = new URL(operation.resourcePath, origin);
          const method = operation.init?.method ?? 'GET';
          // Only routes this build still serves: Xpod keys are Account client
          // credentials now, so the retired Gateway key paths are not permitted.
          const permitted = method === 'GET' && url.pathname === '/api/ai/providers';
          const taskPath = url.pathname === '/api/tasks';
          const taskRequest = taskPath && (method === 'GET' || method === 'POST') && !url.search
            || taskPath && method === 'PATCH' && url.searchParams.has('id')
            || url.pathname === '/api/tasks/resume' && method === 'POST' && url.searchParams.has('id');
          const taskQueryAllowed = !url.search || Array.from(url.searchParams.keys()).every(key => key === 'id')
            && url.searchParams.getAll('id').length === 1 && Boolean(url.searchParams.get('id'));
          if (origin !== window.location.origin || url.origin !== origin || url.username || url.password || url.hash
            || !(permitted && !url.search || taskRequest && taskQueryAllowed)) throw new Error('Gateway acceptance request outside boundary');
          return value.fetch(url.href, { ...operation.init, redirect: 'error', signal: AbortSignal.timeout(30_000) })
            .then(async response => ({ status: response.status, body: await response.text() }));
        }
        if (!podUrl) throw new Error('Missing current Pod');
        const url = new URL(operation.resourcePath, podUrl);
        if (!url.href.startsWith(podUrl)) throw new Error('Test resource must stay inside the current Pod');
        return value.fetch(url.href, operation.init)
          .then(async response => ({ status: response.status, body: await response.text() }));
      }
      queue.push(fiber.child, fiber.sibling);
    }
    if (operation.kind === 'ai-host') return false;
    throw new Error(`Missing mounted host capability for ${operation.kind}`);
}
