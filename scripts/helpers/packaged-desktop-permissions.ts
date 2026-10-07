import { createHash } from 'node:crypto';
import type { JSHandle, Page, Request } from '@playwright/test';
import { getLinkedResourceUrlAll, getResourceInfo } from '@inrupt/solid-client';
import { parseAiConnectionsServiceAccess } from '@undefineds.co/ai-connections';
import { AI_CONNECTIONS_SERVICE_RESOURCE_IDS } from '@undefineds.co/ai-connections/service-access-resources';
import type { SolidServiceAccessRequest } from '@undefineds.co/extension-sdk/web';
import { captureBrowserAiConnections, type MountedBrowserAiConnections } from '../../tests/helpers/browserXpodRuntime';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Closed vocabulary for the mounted Pod permission phase. The pod-a window of
 * RC 37580705243 published only the driver's generic `unclassified` code and no inner operation could be identified. Mounted-permission
 * boundaries could throw plain `Error` without attribution. Each real external
 * operation below names its own boundary, so a public artifact can attribute it
 * while the raw diagnostic stays in the private 600-mode evidence. */
export type MountedPermissionCondition = 'mounted-runtime' | 'service-access'
  | 'target-read' | 'parent-policy' | 'grant-apply' | 'grant-repeat' | 'grant-restore';

/** A mounted Pod permission failure that keeps its exact diagnostic text private
 * and publishes only a reviewed closed-vocabulary condition. */
export class MountedPermissionError extends Error {
  readonly condition: MountedPermissionCondition;
  /** The untranslated rejection behind an attributed operation, kept for the
   * private 600-mode evidence only. */
  override readonly cause?: unknown;
  constructor(condition: MountedPermissionCondition, detail: string, cause?: unknown) {
    super(detail);
    this.name = 'MountedPermissionError';
    this.condition = condition;
    this.cause = cause;
  }
}

/** Run one real mounted-permission operation and attribute its own rejection to
 * a fixed boundary token. A failure that already carries a specific condition
 * keeps that condition unchanged, so a coarse outer wrap never replaces a
 * precise inner one, and it is applied per boundary rather than as one catch-all
 * around the whole phase. */
export async function attributeMountedOperation<T>(condition: MountedPermissionCondition,
  action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof MountedPermissionError) throw error;
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new MountedPermissionError(condition,
      `Mounted permission operation "${condition}" was rejected: ${cause}`, error);
  }
}

/** Observe requests; never replace transport or read credential headers/bodies. */
export function observeOwnedPodTraffic(page: Page, podUrl: string): {
  snapshot(): { writes: number; authorizationRequests: number };
  stop(): void;
} {
  const pod = new URL(podUrl);
  const localOrigin = new URL(page.url()).origin;
  let writes = 0;
  let authorizationRequests = 0;
  const observe = (request: Request): void => {
    const url = new URL(request.url());
    if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('client_id')) authorizationRequests++;
    if ([pod.origin, localOrigin].includes(url.origin) && url.pathname.startsWith(pod.pathname)
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes++;
  };
  page.on('request', observe);
  return { snapshot: () => ({ writes, authorizationRequests }), stop: () => page.off('request', observe) };
}

/** The existing mounted session is the only credential/transport authority. */
async function readMountedDocument(handle: JSHandle<MountedBrowserAiConnections>, url: string, podUrl: string,
  method: 'GET' | 'HEAD' = 'GET'): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return handle.evaluate(async ({ host }, input) => {
    const snapshot = host.solid.session.getSnapshot();
    const pod = host.solid.pod;
    const target = new URL(input.url);
    const root = new URL(input.podUrl);
    if (snapshot.status !== 'authenticated' || pod?.status !== 'ready' || snapshot.webId !== pod.current.webId
      || pod.current.podUrl !== input.podUrl || target.origin !== root.origin || !target.pathname.startsWith(root.pathname)
      || target.search || target.hash || target.username || target.password) throw new Error('Mounted document boundary changed');
    const response = await host.solid.session.fetch(target.href, { method: input.method, redirect: 'error' });
    return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers.entries()) };
  }, { url, podUrl, method });
}

async function parentAcr(handle: JSHandle<MountedBrowserAiConnections>, podUrl: string): Promise<{ url: string; hash: string }> {
  const info = await getResourceInfo(podUrl, { fetch: (async (input, init) => {
    if (String(input) !== podUrl || (init?.method ?? 'HEAD') !== 'HEAD') throw new Error('Unexpected parent resource lookup');
    const response = await readMountedDocument(handle, podUrl, podUrl, 'HEAD');
    const forwarded = new Response(null, { status: response.status, headers: response.headers });
    // Response constructors do not carry a source URL. Retain the exact
    // requested canonical resource so the SDK can resolve its real Link header.
    Object.defineProperty(forwarded, 'url', { value: podUrl });
    return forwarded;
  }) as typeof fetch });
  const urls = getLinkedResourceUrlAll(info).acl ?? [];
  if (urls.length !== 1) throw new Error('Missing authoritative parent access-control Link');
  const response = await readMountedDocument(handle, urls[0], podUrl);
  if (response.status !== 200) throw new Error('Cannot independently read parent access control');
  return { url: urls[0], hash: sha256(response.body) };
}

export interface MountedPodPermissionPhase {
  handle: JSHandle<MountedBrowserAiConnections>;
  request: SolidServiceAccessRequest;
  evidence: {
    bindingSha256: string;
    first: { resourceIds: string[]; fresh: true; granted: number; readBack: number; parentUnchanged: true };
    repeat: { readBack: number; acrWrites: 0; sameSession: true };
  };
  restore(): Promise<true>;
}

async function inspectEach(handle: JSHandle<MountedBrowserAiConnections>, request: SolidServiceAccessRequest,
  expected: 'granted' | 'missing'): Promise<number> {
  let count = 0;
  for (const resource of request.resources) {
    const result = await handle.evaluate(({ host }, request) => {
      if (!host.solid.permissions) throw new Error('Missing mounted permission capability');
      return host.solid.permissions.inspectAgentAccess(request);
    }, { ...request, resources: [resource] });
    if (result.status !== expected) throw new Error('Independent target grant readback mismatch');
    count++;
  }
  return count;
}

export async function inspectFreshMountedTargets(handle: JSHandle<MountedBrowserAiConnections>, request: SolidServiceAccessRequest,
  podUrl: string): Promise<void> {
  for (const resource of request.resources) {
    const response = await readMountedDocument(handle, resource.url, podUrl, 'HEAD');
    // The installed SDK throws for a missing resource. Only this observed
    // document 404 establishes absence; do not reinterpret permissionDenied.
    if (response.status === 404) continue;
    if (response.status !== 200) throw new Error('Cannot inspect first-grant targets');
    await inspectEach(handle, { ...request, resources: [resource] }, 'missing');
  }
}

/** Real first+repeat grant phase. No evidence is emitted on a failed observation.
 * Call restore before switching Pods/navigation, while this capability owns attribution.
 */
export async function acceptMountedPodPermissions(page: Page, binding: { webId: string; podUrl: string }): Promise<MountedPodPermissionPhase> {
  const handle = await attributeMountedOperation('mounted-runtime', () => captureBrowserAiConnections(page, binding));
  let request: SolidServiceAccessRequest | undefined;
  let grantAttempted = false;
  let restored = false;
  const restore = async (): Promise<true> => {
    if (!request || !grantAttempted) throw new MountedPermissionError('grant-restore', 'No grant phase to restore');
    const active = request;
    const result = await attributeMountedOperation('grant-restore', () => handle.evaluate(({ host }, request) => {
      if (!host.solid.permissions) throw new Error('Missing original mounted permission capability');
      return host.solid.permissions.revokeAgentAccess(request);
    }, active));
    if (result.status !== 'missing') throw new MountedPermissionError('grant-restore', 'This capability did not independently restore its fresh grants');
    await attributeMountedOperation('grant-restore', () => inspectEach(handle, active, 'missing'));
    restored = true;
    return true;
  };
  try {
    request = await attributeMountedOperation('service-access', async () => parseAiConnectionsServiceAccess(await handle.evaluate(({ controller }) => {
      if (!controller.client) throw new Error('Missing mounted AI client');
      return controller.client.getServiceAccess();
    }), binding.podUrl));
    const resourceIds = request.resources.map(resource => resource.id);
    if (resourceIds.length !== AI_CONNECTIONS_SERVICE_RESOURCE_IDS.length || new Set(resourceIds).size !== resourceIds.length
      || AI_CONNECTIONS_SERVICE_RESOURCE_IDS.some(id => !resourceIds.includes(id))) throw new MountedPermissionError('service-access', 'Incomplete shared target declaration');
    const declared: SolidServiceAccessRequest = request;
    // First means observed missing service grants, not a new username assumption.
    // Normal owner initialization may already have created a target document.
    await attributeMountedOperation('target-read', () => inspectFreshMountedTargets(handle, declared, binding.podUrl));
    const before = await attributeMountedOperation('parent-policy', () => parentAcr(handle, binding.podUrl));
    grantAttempted = true;
    await attributeMountedOperation('grant-apply', () => handle.evaluate(({ controller }) => {
      if (!controller.authorizeService) throw new Error('Missing mounted authorization operation');
      return controller.authorizeService();
    }));
    const readBack = await attributeMountedOperation('grant-apply', () => inspectEach(handle, declared, 'granted'));
    const after = await attributeMountedOperation('parent-policy', () => parentAcr(handle, binding.podUrl));
    if (after.url !== before.url || after.hash !== before.hash) throw new MountedPermissionError('grant-apply', 'Parent policy changed while granting targets');
    const traffic = observeOwnedPodTraffic(page, binding.podUrl);
    let repeatReads: number;
    let repeat;
    try {
      await attributeMountedOperation('grant-repeat', () => handle.evaluate(({ controller }) => controller.authorizeService!()));
      repeatReads = await attributeMountedOperation('grant-repeat', () => inspectEach(handle, declared, 'granted'));
      repeat = traffic.snapshot();
    } finally { traffic.stop(); }
    if (repeat.writes !== 0 || repeat.authorizationRequests !== 0) throw new MountedPermissionError('grant-repeat', 'Repeat grant wrote or reauthenticated');
    return { handle, request, restore,
      evidence: { bindingSha256: sha256(JSON.stringify(binding)),
        first: { resourceIds, fresh: true, granted: readBack, readBack, parentUnchanged: true },
        repeat: { readBack: repeatReads, acrWrites: 0, sameSession: true } } };
  } catch (error) {
    // A partial/failed grant must not turn cleanup into success. The caller's
    // private diagnostic retains the failure; an unsuccessful rollback propagates.
    const failures = [error];
    try { if (grantAttempted && !restored) await restore(); }
    catch (rollback) { failures.push(rollback); }
    finally { try { await handle.dispose(); } catch (dispose) { failures.push(dispose); } }
    throw failures.length > 1 ? new AggregateError(failures, 'Permission phase and cleanup failed') : error;
  }
}
