import {
  normalizeWebIdLoginRoute,
  type WebIdLoginRouteDescriptor,
} from '@undefineds.co/solid-sdk';
import {
  normalizeXpodReturnPath,
  XPOD_RETURN_PATH_PREFIXES,
} from '../../../src/shared/xpod-route-policy';

export const XPOD_LOGIN_ROUTE_ID = 'xpod-current-origin';

export const XPOD_LOGIN_RETURN_PREFIXES = XPOD_RETURN_PATH_PREFIXES;

export function createXpodLoginRoute(
  locationLike: Location | URL | string = typeof window === 'undefined' ? 'http://localhost' : window.location,
): WebIdLoginRouteDescriptor {
  const location = toLocation(locationLike);
  const origin = location.origin;
  if (!origin || origin === 'null') {
    throw new TypeError('Xpod login requires a same-origin browser URL');
  }

  return {
    id: XPOD_LOGIN_ROUTE_ID,
    label: 'Xpod',
    identityProvider: { url: origin, label: location.host || origin },
    storageProvider: { url: origin, label: location.host || origin },
    availability: 'ready',
  };
}

export function createXpodLoginRoutes(
  locationLike?: Location | URL | string,
): readonly [WebIdLoginRouteDescriptor] {
  return [createXpodLoginRoute(locationLike)];
}

export function normalizeXpodReturnTo(value: string | undefined): string | undefined {
  return normalizeXpodReturnPath(value);
}

export function assertXpodLoginRoute(
  route: WebIdLoginRouteDescriptor,
  origin: string,
): WebIdLoginRouteDescriptor {
  const normalized = normalizeWebIdLoginRoute(route);
  const expectedOrigin = new URL(origin).origin;
  const identityOrigin = new URL(normalized.identityProvider.url).origin;
  const storageOrigin = normalized.storageProvider
    ? new URL(normalized.storageProvider.url).origin
    : undefined;

  if (
    normalized.id !== XPOD_LOGIN_ROUTE_ID
    || identityOrigin !== expectedOrigin
    || storageOrigin !== expectedOrigin
    || normalized.identityProvider.url !== normalized.storageProvider?.url
  ) {
    throw new TypeError('Xpod login route must use the current origin for identity and storage');
  }

  // The Xpod policy keeps origin URLs as origin strings (without a trailing
  // slash) so they can be compared with window.location.origin exactly.
  return {
    ...normalized,
    identityProvider: { ...normalized.identityProvider, url: expectedOrigin },
    storageProvider: normalized.storageProvider
      ? { ...normalized.storageProvider, url: expectedOrigin }
      : undefined,
  };
}

function toLocation(locationLike: Location | URL | string): { origin: string; host: string; href: string } {
  if (typeof locationLike === 'string') {
    const url = new URL(locationLike, typeof window === 'undefined' ? undefined : window.location.href);
    return { origin: url.origin, host: url.host, href: url.href };
  }
  if (locationLike instanceof URL) {
    return { origin: locationLike.origin, host: locationLike.host, href: locationLike.href };
  }
  return {
    origin: locationLike.origin,
    host: locationLike.host,
    href: locationLike.href,
  };
}
