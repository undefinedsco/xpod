import { resolveSolidLocalRouteUrl, type SolidLocalRoute } from '@undefineds.co/solid-sdk';

export type XpodLocalPodRoute = SolidLocalRoute;

export interface XpodProvisionRouteStatus {
  managed?: boolean;
  storageRoot?: string;
}

export async function currentHostLocalPodRoute(
  storageUrl: string,
  fetchImpl: typeof fetch,
): Promise<XpodLocalPodRoute | undefined> {
  if (typeof window === 'undefined') return undefined;
  const desktopRoute = desktopLocalPodRoute(storageUrl);
  if (desktopRoute) return desktopRoute;
  if (storageUrlUsesCurrentOrigin(storageUrl)) return undefined;

  const status = await fetchCurrentProvisionRouteStatus(fetchImpl);
  return currentProvisionLocalPodRoute(storageUrl, status);
}

export function currentProvisionLocalPodRoute(
  storageUrl: string,
  status: XpodProvisionRouteStatus,
): XpodLocalPodRoute | undefined {
  if (typeof window === 'undefined') return undefined;
  if (status.managed !== true || typeof status.storageRoot !== 'string') return undefined;
  if (!managedPublicRouteCoversStorage(storageUrl, status.storageRoot)) return undefined;
  return podScopedLocalRoute(storageUrl);
}

function desktopLocalPodRoute(storageUrl: string): XpodLocalPodRoute | undefined {
  if (typeof window === 'undefined' || !window.xpodDesktop) return undefined;
  return podScopedLocalRoute(storageUrl);
}

async function fetchCurrentProvisionRouteStatus(
  fetchImpl: typeof fetch,
): Promise<XpodProvisionRouteStatus> {
  let response: Response | undefined;
  try {
    response = await fetchImpl(new URL('/provision/status', window.location.origin).href, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    return {};
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer().catch(() => undefined);
    return {};
  }
  const status = await response.json().catch(() => undefined) as {
    managed?: unknown;
    publicUrl?: unknown;
  } | undefined;
  return {
    managed: status?.managed === true,
    storageRoot: typeof status?.publicUrl === 'string' ? status.publicUrl : undefined,
  };
}

function podScopedLocalRoute(storageUrl: string): XpodLocalPodRoute | undefined {
  try {
    const canonical = new URL(storageUrl);
    const local = new URL(canonical.pathname, window.location.origin);
    if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password) {
      return undefined;
    }
    canonical.search = '';
    canonical.hash = '';
    local.search = '';
    local.hash = '';
    return {
      canonicalBaseUrl: canonical.href.endsWith('/') ? canonical.href : `${canonical.href}/`,
      localBaseUrl: local.href.endsWith('/') ? local.href : `${local.href}/`,
    };
  } catch {
    return undefined;
  }
}

function managedPublicRouteCoversStorage(storageUrl: string, storageRoot: string): boolean {
  try {
    const canonicalPublicUrl = new URL(storageRoot);
    const localPublicUrl = new URL(canonicalPublicUrl.pathname, window.location.origin);
    return resolveSolidLocalRouteUrl(storageUrl, [{
      canonicalBaseUrl: canonicalPublicUrl.href,
      localBaseUrl: localPublicUrl.href,
    }]) !== undefined;
  } catch {
    return false;
  }
}

function storageUrlUsesCurrentOrigin(value: string): boolean {
  try {
    return new URL(value).origin === window.location.origin;
  } catch {
    return false;
  }
}
