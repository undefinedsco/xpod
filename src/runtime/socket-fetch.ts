import { getSocketPathForOrigin, registerSocketOrigin } from './socket-origin-registry';
import { requestViaSocket } from './socket-transport';

const originalFetch = globalThis.fetch.bind(globalThis);
let patched = false;
let patchRefCount = 0;
const debugSocketFetch = process.env.XPOD_DEBUG_SOCKET_FETCH === 'true';

function resolveOrigin(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') {
    return new URL(input).origin;
  }
  if (input instanceof URL) {
    return input.origin;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new URL(input.url).origin;
  }
  return undefined;
}

function resolveRequestUrl(baseUrl: string, input: string | URL | Request): URL {
  if (typeof input === 'string' || input instanceof URL) {
    return new URL(String(input), baseUrl);
  }
  return new URL(input.url, baseUrl);
}

function resolveRequestMethod(input: string | URL | Request, init?: RequestInit): string {
  if (init?.method) {
    return init.method;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method;
  }
  return 'GET';
}

function resolveRequestHeaders(input: string | URL | Request, url: URL, init?: RequestInit): Headers {
  const headers = typeof Request !== 'undefined' && input instanceof Request
    ? new Headers(input.headers)
    : new Headers();

  if (init?.headers) {
    const initHeaders = new Headers(init.headers);
    initHeaders.forEach((value, key) => headers.set(key, value));
  }

  if (!headers.has('host')) {
    headers.set('host', url.host);
  }
  return headers;
}

async function resolveRequestBody(input: string | URL | Request, init?: RequestInit): Promise<Buffer | undefined> {
  const body = init?.body ?? (typeof Request !== 'undefined' && input instanceof Request ? input.clone().body : undefined);
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  const arrayBuffer = await new Response(body as BodyInit).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchViaSocket(
  socketPath: string,
  baseUrl: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestUrl = resolveRequestUrl(baseUrl, input);
  const method = resolveRequestMethod(input, init);
  const headers = resolveRequestHeaders(input, requestUrl, init);
  const body = await resolveRequestBody(input, init);

  if (body && method !== 'GET' && method !== 'HEAD' && !headers.has('content-length')) {
    headers.set('content-length', String(body.byteLength));
  }

  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  const response = await requestViaSocket({
    protocol: requestUrl.protocol as 'http:' | 'https:',
    socketPath,
    path: `${requestUrl.pathname}${requestUrl.search}`,
    method,
    headers: requestHeaders,
    body,
    signal: init?.signal ?? undefined,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function ensurePatched(): void {
  if (patched) {
    return;
  }

  globalThis.fetch = (async(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const origin = resolveOrigin(input);
    const socketPath = origin ? getSocketPathForOrigin(origin) : undefined;

    if (debugSocketFetch && origin) {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
      console.log(`[socket-fetch] ${socketPath ? 'rewrite' : 'passthrough'} ${url}`);
    }

    if (!socketPath) {
      return originalFetch(input as any, init as any);
    }

    return fetchViaSocket(socketPath, origin!, input as any, init);
  }) as typeof fetch;

  patched = true;
}

function maybeRestoreOriginalFetch(): void {
  if (patchRefCount > 0 || !patched) {
    return;
  }

  globalThis.fetch = originalFetch as typeof fetch;
  patched = false;
}

export function acquireSocketFetchShim(): void {
  patchRefCount += 1;
  ensurePatched();
}

export function releaseSocketFetchShim(): void {
  if (patchRefCount > 0) {
    patchRefCount -= 1;
  }
  maybeRestoreOriginalFetch();
}

export function registerSocketFetchOrigin(origin: string, socketPath: string): () => Promise<void> {
  const unregisterOrigin = registerSocketOrigin(origin, socketPath);
  acquireSocketFetchShim();

  return async(): Promise<void> => {
    unregisterOrigin();
    releaseSocketFetchShim();
  };
}
