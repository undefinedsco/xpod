import http from 'node:http';
import https from 'node:https';
import type { RequestOptions } from 'node:http';
import { URL } from 'node:url';
import { getSocketPathForOrigin, registerSocketOrigin } from './socket-origin-registry';

const originalHttpRequest = http.request.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalHttpGet = http.get.bind(http);
const originalHttpsGet = https.get.bind(https);
let patched = false;
let patchRefCount = 0;
const debugSocketHttp = process.env.XPOD_DEBUG_SOCKET_HTTP === 'true';

function hasHostHeader(headers: RequestOptions['headers']): boolean {
  if (!headers) {
    return false;
  }

  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === 'host');
  }

  return Object.keys(headers).some((key) => key.toLowerCase() === 'host');
}

function withHostHeader(headers: RequestOptions['headers'], host: string): RequestOptions['headers'] {
  if (!headers) {
    return { host };
  }

  if (Array.isArray(headers)) {
    return hasHostHeader(headers) ? headers : [ ...headers, [ 'host', host ] ];
  }

  return hasHostHeader(headers) ? headers : { ...headers, host };
}

function toUrlFromOptions(options: RequestOptions, defaultProtocol: 'http:' | 'https:'): URL | undefined {
  const protocol = options.protocol ?? defaultProtocol;
  const host = options.hostname ?? options.host ?? (typeof options.headers === 'object' && options.headers && 'host' in options.headers
    ? String((options.headers as Record<string, unknown>).host)
    : undefined);

  if (!host) {
    return undefined;
  }

  const path = options.path ?? '/';
  const authority = typeof host === 'string' && host.includes(':') ? host : `${host}${options.port ? `:${options.port}` : ''}`;
  return new URL(`${protocol}//${authority}${path}`);
}

function rewriteRequestOptions(url: URL, options: RequestOptions, socketPath: string): RequestOptions {
  const rewritten: RequestOptions = {
    ...options,
    socketPath,
    path: `${url.pathname}${url.search}`,
    headers: withHostHeader(options.headers, url.host),
  };

  delete rewritten.host;
  delete rewritten.hostname;
  delete rewritten.port;

  return rewritten;
}

function hasExplicitSocketPath(input: string | URL | RequestOptions, options?: RequestOptions | ((...args: any[]) => void)): boolean {
  if (typeof input === 'object' && !(input instanceof URL) && input && 'socketPath' in input && input.socketPath) {
    return true;
  }

  return typeof options === 'object' && !!options && 'socketPath' in options && !!options.socketPath;
}

function createPatchedRequest(
  original: typeof http.request,
  defaultProtocol: 'http:' | 'https:',
): typeof http.request {
  return ((input: string | URL | RequestOptions, options?: RequestOptions | ((...args: any[]) => void), callback?: (...args: any[]) => void) => {
    let url: URL | undefined;
    let requestOptions: RequestOptions = {};
    let cb: ((...args: any[]) => void) | undefined;

    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(input.toString());
      if (typeof options === 'function') {
        cb = options;
      } else {
        requestOptions = { ...(options ?? {}) };
        cb = callback;
      }
    } else {
      requestOptions = { ...(input ?? {}) };
      if (typeof options === 'function') {
        cb = options;
      } else {
        requestOptions = { ...requestOptions, ...(options ?? {}) };
        cb = callback;
      }
      url = toUrlFromOptions(requestOptions, defaultProtocol);
    }

    const explicitSocketPath = hasExplicitSocketPath(input, options);
    const socketPath = !explicitSocketPath && url ? getSocketPathForOrigin(url.origin) : undefined;
    if (debugSocketHttp && url) {
      console.log(`[socket-http] ${socketPath ? 'rewrite' : 'passthrough'} ${url.toString()}${explicitSocketPath ? ' (explicit-socket)' : ''}`);
    }
    if (!url || !socketPath) {
      return original(input as any, options as any, callback as any);
    }

    const rewritten = rewriteRequestOptions(url, requestOptions, socketPath);
    return cb ? original(rewritten, cb as any) : original(rewritten);
  }) as typeof http.request;
}

function createPatchedGet(protocol: 'http' | 'https'): typeof http.get {
  return ((input: string | URL | RequestOptions, options?: RequestOptions | ((...args: any[]) => void), callback?: (...args: any[]) => void) => {
    const requester = protocol === 'http' ? http.request : https.request;
    const req = requester(input as any, options as any, callback as any);
    req.end();
    return req;
  }) as typeof http.get;
}

function ensurePatched(): void {
  if (patched) {
    return;
  }

  http.request = createPatchedRequest(originalHttpRequest, 'http:');
  https.request = createPatchedRequest(originalHttpsRequest, 'https:');
  http.get = createPatchedGet('http');
  https.get = createPatchedGet('https');
  patched = true;
}

function maybeRestoreOriginalHttp(): void {
  if (patchRefCount > 0 || !patched) {
    return;
  }

  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
  http.get = originalHttpGet;
  https.get = originalHttpsGet;
  patched = false;
}

export function acquireSocketHttpShim(): void {
  patchRefCount += 1;
  ensurePatched();
}

export function releaseSocketHttpShim(): void {
  if (patchRefCount > 0) {
    patchRefCount -= 1;
  }
  maybeRestoreOriginalHttp();
}

export function registerSocketHttpOrigin(origin: string, socketPath: string): () => Promise<void> {
  const unregisterOrigin = registerSocketOrigin(origin, socketPath);
  acquireSocketHttpShim();

  return async(): Promise<void> => {
    unregisterOrigin();
    releaseSocketHttpShim();
  };
}
