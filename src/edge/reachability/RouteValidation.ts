import type { AccessRoute } from './types';

/**
 * Route validity, decided locally before anything is dialled.
 *
 * Both selection paths (the managed-client fetch and the best-effort chooser) used to trust
 * whatever the node advertised: an expired access point, a loopback address from another
 * machine, or an unrelated service on the same port could all be selected (audit N06). The
 * rules live here so the two paths cannot drift apart.
 */

export interface RouteValidityContext {
  now: Date;
  /** A caller on another machine cannot use a loopback access point, whatever the node says. */
  remoteClient: boolean;
}

/** Fail closed: an expiry that cannot be parsed is treated as no usable expiry information. */
export function routeUnusableReason(route: AccessRoute, context: RouteValidityContext): string | undefined {
  if (context.remoteClient && route.visibility === 'local-only') {
    return 'loopback-only access point, not usable from a remote client';
  }
  if (route.expiresAt === undefined) {
    return undefined;
  }
  const expiresAt = Date.parse(route.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return `unparseable expiresAt "${route.expiresAt}"`;
  }
  if (expiresAt <= context.now.getTime()) {
    return `expired at ${route.expiresAt}`;
  }
  return undefined;
}

export function isHttpTarget(targetUrl: string): boolean {
  return targetUrl.startsWith('http://') || targetUrl.startsWith('https://');
}

/**
 * Probe an HTTP access point and require evidence that it really is a Solid server.
 *
 * Captured from a running Community Solid Server: `HEAD /.well-known/solid` answers 405 with a
 * `Link` header carrying Solid vocabulary and `x-powered-by: Community Solid Server`. A 404
 * ("no Solid resource here") or 5xx (broken origin) always fails; any other answer still has to
 * carry identity evidence, because the old `status < 500` rule let an unrelated service on the
 * same port pass just by answering.
 */
export async function probeSolidWellKnown(
  targetUrl: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const response = await (fetchImpl ?? fetch)(new URL('/.well-known/solid', targetUrl), {
    method: 'HEAD',
    signal,
  });
  if (response.status === 404 || response.status >= 500) {
    return false;
  }
  return isSolidWellKnownResponse(response);
}

/** Identity evidence for a `/.well-known/solid` answer. */
export function isSolidWellKnownResponse(response: Response): boolean {
  const link = response.headers.get('link') ?? '';
  if (link.includes('http://www.w3.org/ns/solid/terms#')) {
    return true;
  }
  if (link.includes('rel="acl"') && link.includes('rel="describedby"')) {
    return true;
  }
  const poweredBy = response.headers.get('x-powered-by') ?? '';
  return /community solid server/iu.test(poweredBy);
}
