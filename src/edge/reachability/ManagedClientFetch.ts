import { createCanonicalFetch, type CanonicalFetch } from './CanonicalFetch';
import { createP2PDataPlaneFetch } from './P2PDataPlane';
import { createP2PSignalingClient } from './P2PSignalingClient';
import {
  connectSignaledRawTcpP2PTransport,
  type ConnectSignaledRawTcpP2PTransportOptions,
} from './TcpP2PSignalingSession';
import type { TcpP2PDataPlaneTransport } from './TcpP2PDataPlaneTransport';
import type { AccessRoute, RouteSet } from './types';

type ManagedClientP2POptions =
  Omit<ConnectSignaledRawTcpP2PTransportOptions, 'signaling' | 'clientId'>
  & Pick<ConnectSignaledRawTcpP2PTransportOptions, 'signaling' | 'clientId'>;

type SignaledManagedClientP2POptions = Omit<ManagedClientP2POptions, 'signaling' | 'clientId'>;

export interface ManagedClientFetchOptions {
  routeSet: RouteSet;
  fetchImpl?: typeof fetch;
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean;
  probeTimeoutMs?: number;
  p2p?: ManagedClientP2POptions;
}

export interface ManagedClientFetch {
  route: AccessRoute;
  fetch: CanonicalFetch;
  close(): void;
}

export interface SignaledManagedClientFetchOptions
  extends Omit<ManagedClientFetchOptions, 'routeSet' | 'p2p'>, SignaledManagedClientP2POptions {
  apiBaseUrl: string;
  nodeId: string;
  token?: string;
  clientId: string;
}

export async function createSignaledManagedClientFetch(options: SignaledManagedClientFetchOptions): Promise<ManagedClientFetch> {
  const {
    apiBaseUrl,
    nodeId,
    token,
    clientId,
    fetchImpl,
    probe,
    probeTimeoutMs,
    ...p2pOptions
  } = options;
  const routeSet = await fetchManagedRouteSet({
    apiBaseUrl,
    nodeId,
    token,
    fetchImpl,
  });
  const signaling = createP2PSignalingClient({
    apiBaseUrl,
    nodeId,
    token,
    fetchImpl,
  });
  return createManagedClientFetch({
    routeSet,
    fetchImpl,
    probe,
    probeTimeoutMs,
    p2p: {
      ...p2pOptions,
      signaling,
      clientId,
    },
  });
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

async function fetchManagedRouteSet(options: {
  apiBaseUrl: string;
  nodeId: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<RouteSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = new Headers({ accept: 'application/json' });
  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
  }
  const response = await fetchImpl(new URL(`/v1/signal/nodes/${encodeURIComponent(options.nodeId)}/routes`, options.apiBaseUrl).toString(), {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    throw new Error(`Route set request failed with ${response.status}: ${await safeReadText(response)}`);
  }
  const body = await response.json() as unknown;
  if (!isRouteSet(body)) {
    throw new Error('Route set response is not a valid route set');
  }
  return body;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isRouteSet(value: unknown): value is RouteSet {
  return isRecord(value)
    && typeof value.nodeId === 'string'
    && typeof value.canonicalUrl === 'string'
    && typeof value.generatedAt === 'string'
    && Array.isArray(value.routes)
    && value.routes.every(isAccessRoute);
}

function isAccessRoute(value: unknown): value is AccessRoute {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.nodeId === 'string'
    && typeof value.canonicalUrl === 'string'
    && typeof value.kind === 'string'
    && typeof value.targetUrl === 'string'
    && typeof value.priority === 'number'
    && typeof value.requiresManagedClient === 'boolean'
    && typeof value.visibility === 'string'
    && typeof value.health === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
