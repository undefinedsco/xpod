import type { AccessRoute } from './types';

export const XPOD_P2P_HTTP_PROTOCOL = 'xpod-p2p-http/1' as const;

export type P2PHttpProtocol = typeof XPOD_P2P_HTTP_PROTOCOL;
export type P2PHttpHeaderList = [string, string][];

export interface P2PHttpRequestFrame {
  protocol: P2PHttpProtocol;
  requestId?: string;
  method: string;
  url: string;
  headers?: P2PHttpHeaderList;
  bodyBase64?: string;
}

export interface P2PHttpResponseFrame {
  protocol: P2PHttpProtocol;
  requestId?: string;
  status: number;
  statusText?: string;
  headers?: P2PHttpHeaderList;
  bodyBase64?: string;
}

export interface P2PDataPlaneTransport {
  request(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame>;
}

export interface P2PDataPlaneFetchOptions {
  route: AccessRoute;
  transport: P2PDataPlaneTransport;
}

export interface P2PDataPlaneHandlerOptions {
  targetBaseUrl: string | URL;
  fetchImpl?: typeof fetch;
}

export interface P2PDataPlaneHandler {
  handleRequest(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame>;
}

export type P2PDataPlaneFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createP2PDataPlaneFetch(options: P2PDataPlaneFetchOptions): P2PDataPlaneFetch {
  if (options.route.kind !== 'p2p') {
    throw new Error(`P2P data plane requires a p2p route, got ${options.route.kind}`);
  }
  const canonicalOrigin = new URL(options.route.canonicalUrl).origin;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const canonicalUrl = new URL(request.url);
    if (canonicalUrl.origin !== canonicalOrigin) {
      throw new Error(`Request ${canonicalUrl.toString()} is outside canonical origin ${canonicalOrigin}`);
    }

    const frame: P2PHttpRequestFrame = {
      protocol: XPOD_P2P_HTTP_PROTOCOL,
      method: request.method,
      url: canonicalUrl.toString(),
      headers: headersToList(request.headers),
      bodyBase64: await bodyToBase64(request),
    };
    const responseFrame = await options.transport.request(frame);
    validateResponseFrame(responseFrame);
    return new Response(base64ToBody(responseFrame.bodyBase64), {
      status: responseFrame.status,
      statusText: responseFrame.statusText,
      headers: new Headers(responseFrame.headers),
    });
  };
}

export function createP2PDataPlaneHandler(options: P2PDataPlaneHandlerOptions): P2PDataPlaneHandler {
  const targetBaseUrl = new URL(options.targetBaseUrl.toString());
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async handleRequest(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame> {
      validateRequestFrame(frame);
      const canonicalUrl = new URL(frame.url);
      const targetUrl = rewriteTargetUrl(targetBaseUrl, canonicalUrl);
      const headers = new Headers(frame.headers);
      removeHopByHopHeaders(headers);
      headers.set('x-xpod-canonical-url', canonicalUrl.toString());
      headers.set('x-xpod-canonical-origin', canonicalUrl.origin);
      headers.set('x-xpod-canonical-host', canonicalUrl.host);

      const response = await fetchImpl(targetUrl, {
        method: frame.method,
        headers,
        body: methodCanHaveBody(frame.method) ? base64ToBody(frame.bodyBase64) : undefined,
      });

      return {
        protocol: XPOD_P2P_HTTP_PROTOCOL,
        requestId: frame.requestId,
        status: response.status,
        statusText: response.statusText,
        headers: headersToList(response.headers),
        bodyBase64: await responseToBase64(response),
      };
    },
  };
}

function validateRequestFrame(frame: P2PHttpRequestFrame): void {
  if (frame.protocol !== XPOD_P2P_HTTP_PROTOCOL) {
    throw new Error(`Unsupported P2P HTTP protocol: ${String(frame.protocol)}`);
  }
  if (typeof frame.method !== 'string' || frame.method.trim().length === 0) {
    throw new Error('P2P HTTP request method is required');
  }
  try {
    new URL(frame.url);
  } catch {
    throw new Error('P2P HTTP request URL must be absolute');
  }
}

function validateResponseFrame(frame: P2PHttpResponseFrame): void {
  if (frame.protocol !== XPOD_P2P_HTTP_PROTOCOL) {
    throw new Error(`Unsupported P2P HTTP protocol: ${String(frame.protocol)}`);
  }
  if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599) {
    throw new Error(`Invalid P2P HTTP response status: ${String(frame.status)}`);
  }
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

function headersToList(headers: Headers): P2PHttpHeaderList {
  const result: P2PHttpHeaderList = [];
  headers.forEach((value, key) => {
    if (!isHopByHopHeader(key)) {
      result.push([key, value]);
    }
  });
  return result;
}

function removeHopByHopHeaders(headers: Headers): void {
  const keysToDelete: string[] = [];
  headers.forEach((_value, key) => {
    if (isHopByHopHeader(key)) {
      keysToDelete.push(key);
    }
  });
  for (const key of keysToDelete) {
    headers.delete(key);
  }
}

function isHopByHopHeader(key: string): boolean {
  switch (key.toLowerCase()) {
    case 'connection':
    case 'keep-alive':
    case 'proxy-authenticate':
    case 'proxy-authorization':
    case 'te':
    case 'trailer':
    case 'transfer-encoding':
    case 'upgrade':
    case 'host':
    case 'content-length':
      return true;
    default:
      return false;
  }
}

function methodCanHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

async function bodyToBase64(request: Request): Promise<string | undefined> {
  if (!methodCanHaveBody(request.method)) {
    return undefined;
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(body).toString('base64');
}

async function responseToBase64(response: Response): Promise<string | undefined> {
  const body = await response.arrayBuffer();
  if (body.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(body).toString('base64');
}

function base64ToBody(value?: string): BodyInit | undefined {
  if (!value) {
    return undefined;
  }
  return Buffer.from(value, 'base64');
}
