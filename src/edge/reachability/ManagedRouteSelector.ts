import { isHttpTarget, probeSolidWellKnown, routeUnusableReason } from './RouteValidation';
import type { AccessRoute, RouteSet } from './types';

export interface ChooseAccessRouteOptions {
  managedClient: boolean;
  timeoutMs?: number;
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean;
  /** Injectable clock: expired access points must be rejected against a known time in tests. */
  now?: () => Date;
}

export async function chooseAccessRoute(
  routeSet: RouteSet,
  options: ChooseAccessRouteOptions,
): Promise<AccessRoute | null> {
  const now = (options.now ?? (() => new Date()))();
  const candidates = routeSet.routes
    .filter((route) => route.health !== 'unreachable')
    .filter((route) => options.managedClient || !route.requiresManagedClient)
    // Expired and loopback-only access points are dropped before any probe: the node
    // advertises its own list, so validating it is the client's job (N06).
    .filter((route) => routeUnusableReason(route, { now, remoteClient: options.managedClient }) === undefined)
    .slice()
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  if (candidates.length === 0) {
    return null;
  }

  const probe = options.probe ?? defaultProbe;
  const results = await Promise.all(candidates.map(async (route) => ({
    route,
    ok: await probeWithTimeout(route, probe, options.timeoutMs ?? 1_000),
  })));

  return results.find((result) => result.ok)?.route ?? null;
}

async function probeWithTimeout(
  route: AccessRoute,
  probe: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.resolve(probe(route, controller.signal));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultProbe(route: AccessRoute, signal: AbortSignal): Promise<boolean> {
  if (!isHttpTarget(route.targetUrl)) {
    return route.health === 'healthy';
  }
  return await probeSolidWellKnown(route.targetUrl, signal);
}
