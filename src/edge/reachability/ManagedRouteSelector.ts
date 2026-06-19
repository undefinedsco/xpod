import type { AccessRoute, RouteSet } from './types';

export interface ChooseAccessRouteOptions {
  managedClient: boolean;
  timeoutMs?: number;
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean;
}

export async function chooseAccessRoute(
  routeSet: RouteSet,
  options: ChooseAccessRouteOptions,
): Promise<AccessRoute | null> {
  const candidates = routeSet.routes
    .filter((route) => route.health !== 'unreachable')
    .filter((route) => options.managedClient || !route.requiresManagedClient)
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
  if (!route.targetUrl.startsWith('http://') && !route.targetUrl.startsWith('https://')) {
    return route.health === 'healthy';
  }
  const response = await fetch(new URL('/.well-known/solid', route.targetUrl), {
    method: 'HEAD',
    signal,
  });
  return response.ok || response.status === 401 || response.status === 403;
}
