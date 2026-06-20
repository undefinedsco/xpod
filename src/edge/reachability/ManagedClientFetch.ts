import { createCanonicalFetch, type CanonicalFetch } from './CanonicalFetch';
import { createP2PDataPlaneFetch } from './P2PDataPlane';
import type { AccessRoute, RouteSet } from './types';
import {
  connectSignaledRawTcpP2PTransport,
  type ConnectSignaledRawTcpP2PTransportOptions,
} from './TcpP2PSignalingSession';
import type { TcpP2PDataPlaneTransport } from './TcpP2PDataPlaneTransport';

export interface ManagedClientFetchOptions {
  routeSet: RouteSet;
  fetchImpl?: typeof fetch;
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean;
  probeTimeoutMs?: number;
  p2p?: Omit<ConnectSignaledRawTcpP2PTransportOptions, 'signaling' | 'clientId'> & Pick<ConnectSignaledRawTcpP2PTransportOptions, 'signaling' | 'clientId'>;
}

export interface ManagedClientFetch {
  route: AccessRoute;
  fetch: CanonicalFetch;
  close(): void;
}

export async function createManagedClientFetch(options: ManagedClientFetchOptions): Promise<ManagedClientFetch> {
  const errors: string[] = [];
  for (const route of candidateRoutes(options.routeSet)) {
    if (!await routeProbeSucceeds(route, options)) {
      continue;
    }
    if (route.kind === 'p2p') {
      if (!options.p2p) {
        errors.push(`Route ${route.id} requires p2p options`);
        continue;
      }
      try {
        const connected = await connectSignaledRawTcpP2PTransport(options.p2p);
        const fetchViaP2P = createP2PDataPlaneFetch({
          route: connected.rawTcpRoute ?? route,
          transport: connected.transport,
        });
        return managedResult(route, fetchViaP2P, connected.transport);
      } catch (error) {
        errors.push(`Route ${route.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    return managedResult(route, createCanonicalFetch({ route, fetchImpl: options.fetchImpl }));
  }

  throw new Error(`No managed client route could be opened${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);
}

function candidateRoutes(routeSet: RouteSet): AccessRoute[] {
  return routeSet.routes
    .filter((route) => route.health !== 'unreachable')
    .slice()
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

async function routeProbeSucceeds(route: AccessRoute, options: ManagedClientFetchOptions): Promise<boolean> {
  const probe = options.probe ?? defaultManagedProbe;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.probeTimeoutMs ?? 1_000);
  try {
    return await Promise.resolve(probe(route, controller.signal));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultManagedProbe(route: AccessRoute, signal: AbortSignal): Promise<boolean> {
  if (route.kind === 'p2p') {
    return route.health !== 'unreachable';
  }
  if (!route.targetUrl.startsWith('http://') && !route.targetUrl.startsWith('https://')) {
    return route.health === 'healthy';
  }
  const response = await fetch(new URL('/.well-known/solid', route.targetUrl), {
    method: 'HEAD',
    signal,
  });
  return response.ok || response.status === 401 || response.status === 403;
}

function managedResult(
  route: AccessRoute,
  fetch: CanonicalFetch,
  transport?: TcpP2PDataPlaneTransport,
): ManagedClientFetch {
  return {
    route,
    fetch,
    close(): void {
      transport?.close();
    },
  };
}
