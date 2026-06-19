import type { AccessRoute } from './types';

export interface CanonicalFetchOptions {
  route: AccessRoute;
  fetchImpl?: typeof fetch;
}

export type CanonicalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createCanonicalFetch(options: CanonicalFetchOptions): CanonicalFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const route = options.route;
  const canonicalOrigin = new URL(route.canonicalUrl).origin;
  const targetBase = new URL(route.targetUrl);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const canonicalUrl = new URL(request?.url ?? input.toString());
    if (canonicalUrl.origin !== canonicalOrigin) {
      throw new Error(`Request ${canonicalUrl.toString()} is outside canonical origin ${canonicalOrigin}`);
    }

    const targetUrl = rewriteTargetUrl(targetBase, canonicalUrl);
    const headers = new Headers(request?.headers ?? undefined);
    const initHeaders = new Headers(init?.headers ?? undefined);
    initHeaders.forEach((value, key) => headers.set(key, value));
    headers.set('x-xpod-canonical-url', canonicalUrl.toString());
    headers.set('x-xpod-canonical-origin', canonicalOrigin);
    headers.set('x-xpod-canonical-host', canonicalUrl.host);

    const nextInit: RequestInit = {
      ...init,
      method: init?.method ?? request?.method,
      headers,
      body: init?.body ?? requestBody(request),
      signal: init?.signal ?? request?.signal,
    };
    return fetchImpl(targetUrl, nextInit);
  };
}

function rewriteTargetUrl(targetBase: URL, canonicalUrl: URL): string {
  const basePath = targetBase.pathname.endsWith('/')
    ? targetBase.pathname.slice(0, -1)
    : targetBase.pathname;
  const targetPath = `${basePath}${canonicalUrl.pathname}`.replace(/\/+/gu, '/');
  const target = new URL(targetBase.toString());
  target.pathname = targetPath;
  target.search = canonicalUrl.search;
  target.hash = '';
  return target.toString();
}

function requestBody(request?: Request): BodyInit | null | undefined {
  if (!request || request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }
  return request.body as unknown as BodyInit | null | undefined;
}
