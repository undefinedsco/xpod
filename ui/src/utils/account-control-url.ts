import {
  discoverSolidLocalRoute,
  resolveSolidLocalRouteUrl,
  type SolidLocalRoute,
} from '@undefineds.co/solid-sdk';

let cachedRoute: SolidLocalRoute | undefined;
let cachedRouteOrigin: string | undefined;

/**
 * Accept an Account control only when it remains inside the current Xpod
 * http(s) origin and does not carry URL userinfo.
 */
export function resolveSameOriginAccountControlUrl(value: string | undefined): string | undefined {
  if (typeof window === 'undefined' || typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const candidate = value.trim();
  try {
    const url = new URL(candidate, window.location.origin);
    if (
      url.origin !== window.location.origin
      || !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an Account control advertised with the canonical public Xpod URL to
 * the equivalent local Gateway endpoint. Ownership comes only from the
 * same-origin provisioning status; arbitrary third-party controls fail closed.
 */
export async function resolveHostedAccountControlUrl(
  value: string | undefined,
  fetchImpl: typeof fetch = fetch,
  trustedAccountIndex?: string,
): Promise<string | undefined> {
  if (typeof window === 'undefined' || typeof value !== 'string' || !value.trim()) return undefined;

  if (trustedAccountIndex) {
    try {
      const accountIndex = new URL(trustedAccountIndex, window.location.origin);
      const trustedControl = new URL(value.trim(), accountIndex);
      if (
        trustedControl.origin === accountIndex.origin
        && accountIndex.pathname.startsWith('/.account/')
        && trustedControl.pathname.startsWith('/.account/')
        && ['http:', 'https:'].includes(trustedControl.protocol)
        && !trustedControl.username
        && !trustedControl.password
      ) {
        return trustedControl.href;
      }
    } catch {
      // Continue with same-origin and Local route resolution.
    }
  }

  const sameOrigin = resolveSameOriginAccountControlUrl(value);
  if (sameOrigin) return sameOrigin;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.pathname.startsWith('/.account/')) {
    return undefined;
  }

  if (cachedRoute && cachedRouteOrigin === window.location.origin) {
    const cached = resolveSolidLocalRouteUrl(url, [cachedRoute]);
    if (cached) return cached.href;
  }

  const discoveryOptions = {
    localBaseUrl: `${window.location.origin}/`,
    statusUrl: new URL('/provision/status', window.location.origin).href,
  };
  const statusResponse = await Promise.resolve(fetchImpl.call(globalThis, discoveryOptions.statusUrl, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })).catch(() => undefined);
  const route = statusResponse
    ? await discoverSolidLocalRoute({
      ...discoveryOptions,
      fetch: async () => statusResponse.clone(),
    })
    : undefined;
  if (route) {
    cachedRoute = route;
    cachedRouteOrigin = window.location.origin;
  }
  return route ? resolveSolidLocalRouteUrl(url, [route])?.href : undefined;
}
