export const LOCAL_ROUTE_CANONICAL_URL_HEADER = 'x-xpod-canonical-url';
export const LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER = 'x-xpod-canonical-origin';
export const LOCAL_ROUTE_CANONICAL_HOST_HEADER = 'x-xpod-canonical-host';
export const LOCAL_ROUTE_LOCAL_URL_HEADER = 'x-xpod-local-route-url';

const ALLOWED_PROVISION_PATHS = new Set(['/provision/webids', '/provision/pods']);
export interface LocalProvisionClientRequest {
  on(event: 'response', listener: (response: LocalProvisionClientResponse) => void): this;
  on(event: 'redirect', listener: (
    statusCode: number,
    method: string,
    redirectUrl: string,
    responseHeaders: Record<string, string | string[]>,
  ) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): void;
  end(): void;
  abort(): void;
}

export interface LocalProvisionClientResponse {
  statusCode?: number;
  headers: Record<string, string | string[]>;
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type LocalProvisionClientRequestFactory = (options: {
  url: string;
  method: string;
}) => LocalProvisionClientRequest | Promise<LocalProvisionClientRequest>;

export interface LocalProvisionProtocolSession {
  readonly protocol: {
    handle(scheme: 'https', handler: (request: Request) => Promise<Response> | Response): void;
  };
}

export interface RefreshLocalProvisionRouteOptions {
  session: LocalProvisionProtocolSession;
  targetOrigin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  createClientRequest?: LocalProvisionClientRequestFactory;
}

interface LocalProvisionRoute {
  localOrigin: string;
  publicOrigin: string;
  /**
   * Whether this node's canonical URL is reachable from outside right now
   * (`/provision/status` → `publicRoute.available`). A canonical URL exists with
   * or without a tunnel; only the public access route depends on one.
   */
  publicRouteAvailable: boolean;
}

interface LocalProvisionRouteState {
  route?: LocalProvisionRoute;
  createClientRequest: LocalProvisionClientRequestFactory;
}

const installedSessions = new WeakMap<LocalProvisionProtocolSession, LocalProvisionRouteState>();

export function clearLocalProvisionRoute(session: LocalProvisionProtocolSession): void {
  const state = installedSessions.get(session);
  if (state) state.route = undefined;
}

export async function refreshLocalProvisionRoute({
  session,
  targetOrigin,
  fetchImpl = fetch,
  timeoutMs = 3_000,
  createClientRequest = createElectronClientRequest,
}: RefreshLocalProvisionRouteOptions): Promise<boolean> {
  const localOrigin = normalizeLoopbackOrigin(targetOrigin);
  if (!localOrigin) {
    clearLocalProvisionRoute(session);
    return false;
  }

  const route = await discoverLocalProvisionRoute(fetchImpl, localOrigin, timeoutMs);
  const state = installedSessions.get(session);
  if (!route) {
    clearLocalProvisionRoute(session);
    return false;
  }

  if (state) {
    state.route = route;
    state.createClientRequest = createClientRequest;
    return true;
  }

  const nextState: LocalProvisionRouteState = { route, createClientRequest };
  session.protocol.handle('https', (request) => handleHttpsProvisionRequest(nextState, request));
  installedSessions.set(session, nextState);
  return true;
}

async function discoverLocalProvisionRoute(
  fetchImpl: typeof fetch,
  localOrigin: string,
  timeoutMs: number,
): Promise<LocalProvisionRoute | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/provision/status', localOrigin).href, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      ...(timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const body = await response.json().catch(() => undefined) as {
    publicUrl?: unknown;
    publicRoute?: { available?: unknown } | undefined;
  } | undefined;
  const publicOrigin = normalizeHttpsPublicOrigin(body?.publicUrl);
  if (!publicOrigin) return undefined;
  return {
    localOrigin,
    publicOrigin,
    publicRouteAvailable: body?.publicRoute?.available === true,
  };
}

async function handleHttpsProvisionRequest(
  state: LocalProvisionRouteState,
  request: Request,
): Promise<Response> {
  const route = state.route;
  const canonicalUrl = safeRequestUrl(request);
  if (!route || !canonicalUrl || !shouldRouteRequestLocally(canonicalUrl, route)) {
    return proxyRequestWithNativeRedirects(state.createClientRequest, request, request.url);
  }

  const localUrl = new URL(`${canonicalUrl.pathname}${canonicalUrl.search}`, route.localOrigin).href;
  const headers = new Headers(request.headers);
  headers.set(LOCAL_ROUTE_CANONICAL_URL_HEADER, canonicalUrl.href);
  headers.set(LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER, canonicalUrl.origin);
  headers.set(LOCAL_ROUTE_CANONICAL_HOST_HEADER, canonicalUrl.host);
  headers.set(LOCAL_ROUTE_LOCAL_URL_HEADER, localUrl);

  return proxyRequestWithNativeRedirects(state.createClientRequest, request, localUrl, headers);
}

async function proxyRequestWithNativeRedirects(
  createClientRequest: LocalProvisionClientRequestFactory,
  sourceRequest: Request,
  targetUrl: string,
  overrideHeaders?: Headers,
): Promise<Response> {
  const body = await readRequestBody(sourceRequest);
  const headers = overrideHeaders ?? sourceRequest.headers;
  const clientRequest = await createClientRequest({ url: targetUrl, method: sourceRequest.method });
  enableProtocolHandlerBypass(clientRequest);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    clientRequest.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      clientRequest.abort();
      settle(() => resolve(new Response(null, {
        status: statusCode,
        headers: { ...responseHeaders, location: redirectUrl },
      })));
    });

    clientRequest.on('response', (response) => {
      const chunks: Uint8Array[] = [];
      response.on('data', (chunk) => {
        chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      });
      response.on('end', () => {
        const responseBody = sourceRequest.method === 'HEAD' ? null : concatenateChunks(chunks);
        settle(() => resolve(new Response(responseBody, {
          status: response.statusCode ?? 200,
          headers: Object.fromEntries(Object.entries(response.headers)
            .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])),
        })));
      });
      response.on('error', (error) => settle(() => reject(error)));
    });
    clientRequest.on('error', (error) => settle(() => reject(error)));

    for (const [name, value] of headers.entries()) {
      clientRequest.setHeader(name, value);
    }
    if (body && body.byteLength > 0) clientRequest.write(body);
    clientRequest.end();
  });
}

async function readRequestBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > 0 ? body : undefined;
}

function concatenateChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function createElectronClientRequest(options: { url: string; method: string }): Promise<LocalProvisionClientRequest> {
  const { net } = await import('electron');
  return net.request(options) as LocalProvisionClientRequest;
}

function enableProtocolHandlerBypass(request: LocalProvisionClientRequest): void {
  // Electron 33's net.fetch cancels manual redirects (electron/electron#43715).
  // The upstream net-fetch implementation uses this ClientRequest option to avoid
  // re-entering custom protocol handlers; keep it until Electron upgrades are
  // validated with the real redirect harness.
  const mutableRequest = request as LocalProvisionClientRequest & {
    _urlLoaderOptions?: { bypassCustomProtocolHandlers?: boolean };
  };
  if (mutableRequest._urlLoaderOptions) {
    mutableRequest._urlLoaderOptions.bypassCustomProtocolHandlers = true;
  }
}

/**
 * A canonical URL is the node's own identity (WebID, Pod root, OIDC issuer), so a
 * request for it belongs to this node either way - see `docs/multi-channel-access.md`:
 * the canonical URL never degrades to loopback, loopback is only its access route.
 *
 * Provisioning is always served locally because Cloud hands those URLs out
 * mid-flight. Everything else on the canonical origin is served locally too while
 * no public route is available, which is what keeps a Local Pod reachable without
 * a tunnel; once a tunnel is connected the request keeps its public path so
 * streaming and long-lived routes are not downgraded to this buffered proxy.
 */
function shouldRouteRequestLocally(url: URL, route: LocalProvisionRoute): boolean {
  if (url.origin !== route.publicOrigin) return false;
  return ALLOWED_PROVISION_PATHS.has(url.pathname) || !route.publicRouteAvailable;
}

function safeRequestUrl(request: Request): URL | undefined {
  try {
    return new URL(request.url);
  } catch {
    return undefined;
  }
}

function normalizeLoopbackOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHostname(url.hostname)) {
    return undefined;
  }
  return url.origin;
}

function normalizeHttpsPublicOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
