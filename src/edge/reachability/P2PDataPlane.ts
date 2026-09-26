import type { AccessRoute } from './types';

export const XPOD_P2P_HTTP_PROTOCOL = 'xpod-p2p-http/1' as const;

/**
 * Resource ceilings for the P2P data plane (audit N17).
 *
 * The data plane is a byte pipe between two processes, so every unbounded quantity on it is a
 * denial-of-service waiting to happen: a single line that never ends, a body that never stops,
 * or a peer that opens more requests than the other side can serve. The numbers are deliberately
 * generous for Pod traffic and small enough to fail fast.
 */
export const P2P_DATA_PLANE_LIMITS = {
  /** Largest single wire line (one JSON envelope, base64 included). */
  maxFrameBytes: 8 * 1024 * 1024,
  /** Largest request or response body carried inside frames. */
  maxBodyBytes: 4 * 1024 * 1024,
  /** In-flight requests allowed per transport and per socket. */
  maxConcurrentRequests: 16,
  /** Chunk size used when a response body is streamed. */
  chunkBytes: 256 * 1024,
} as const;

export type P2PDataPlaneLimit = keyof typeof P2P_DATA_PLANE_LIMITS;

/** Exceeding a ceiling is its own error so callers can answer 413/429 instead of a generic 502. */
export class P2PDataPlaneLimitError extends Error {
  public constructor(message: string, public readonly limit: P2PDataPlaneLimit) {
    super(message);
    this.name = 'P2PDataPlaneLimitError';
  }
}

/** The caller aborted: the request may still be running on the peer until the cancel lands. */
export class P2PDataPlaneAbortError extends Error {
  public constructor(message = 'P2P data plane request was aborted') {
    super(message);
    this.name = 'P2PDataPlaneAbortError';
  }
}

/** Header a client sets to say it can consume chunked (streamed) response bodies. */
export const XPOD_P2P_ACCEPT_HEADER = 'x-xpod-p2p-accept' as const;
export const XPOD_P2P_ACCEPT_CHUNKED = 'chunked' as const;

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
  /**
   * Set when the head (status/headers) was delivered before the body finished: `bodyBase64` is
   * then absent, every chunk follows through the transport's chunk callback, and the end of the
   * body arrives with the transport's end callback.
   */
  streamed?: boolean;
  /** Present instead of `bodyBase64` when the requester accepts a streamed body. */
  bodyStream?: ReadableStream<Uint8Array>;
}

export interface P2PDataPlaneRequestOptions {
  /** Aborting removes the pending request and tells the peer to stop working on it. */
  signal?: AbortSignal;
  /** Receives every body chunk of a streamed response, in order. */
  onChunk?: (chunk: Uint8Array) => void;
  /** Called once the body of a streamed response is complete. */
  onEnd?: () => void;
  /** Called when a streamed body fails after its head was already delivered. */
  onError?: (error: Error) => void;
}

export interface P2PDataPlaneTransport {
  /**
   * True when the transport understands chunk/end envelopes. A transport that does not must
   * never be sent a streaming request: it would drop the body and answer an empty 200.
   */
  readonly supportsStreaming?: boolean;
  request(frame: P2PHttpRequestFrame, options?: P2PDataPlaneRequestOptions): Promise<P2PHttpResponseFrame>;
}

export interface P2PDataPlaneLimitsOptions {
  maxFrameBytes?: number;
  maxBodyBytes?: number;
  maxConcurrentRequests?: number;
}

export interface P2PDataPlaneFetchOptions extends P2PDataPlaneLimitsOptions {
  route: AccessRoute;
  transport: P2PDataPlaneTransport;
}

export interface P2PDataPlaneHandlerOptions extends P2PDataPlaneLimitsOptions {
  targetBaseUrl: string | URL;
  fetchImpl?: typeof fetch;
}

export interface P2PDataPlaneHandler {
  handleRequest(frame: P2PHttpRequestFrame, options?: { signal?: AbortSignal }): Promise<P2PHttpResponseFrame>;
}

export type P2PDataPlaneFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createP2PDataPlaneFetch(options: P2PDataPlaneFetchOptions): P2PDataPlaneFetch {
  if (options.route.kind !== 'p2p') {
    throw new Error(`P2P data plane requires a p2p route, got ${options.route.kind}`);
  }
  const canonicalOrigin = new URL(options.route.canonicalUrl).origin;
  const maxBodyBytes = options.maxBodyBytes ?? P2P_DATA_PLANE_LIMITS.maxBodyBytes;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const canonicalUrl = new URL(request.url);
    if (canonicalUrl.origin !== canonicalOrigin) {
      throw new Error(`Request ${canonicalUrl.toString()} is outside canonical origin ${canonicalOrigin}`);
    }

    const bodyBase64 = await bodyToBase64(request, maxBodyBytes);
    const headers = headersToList(request.headers);
    // Only a transport that can carry chunk envelopes may ask for a streamed body. An older
    // peer ignores the header and answers with one frame, which this side still accepts.
    if (options.transport.supportsStreaming
      && !headers.some(([key]) => key.toLowerCase() === XPOD_P2P_ACCEPT_HEADER)) {
      headers.push([XPOD_P2P_ACCEPT_HEADER, XPOD_P2P_ACCEPT_CHUNKED]);
    }

    const frame: P2PHttpRequestFrame = {
      protocol: XPOD_P2P_HTTP_PROTOCOL,
      method: request.method,
      url: canonicalUrl.toString(),
      headers,
      bodyBase64,
    };

    const signal = init?.signal ?? request.signal;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        // The consumer stopped reading: the request must not keep the peer working.
        streamController = undefined;
      },
    });

    let responseFrame: P2PHttpResponseFrame;
    try {
      responseFrame = await options.transport.request(frame, {
        ...(signal ? { signal } : {}),
        onChunk: (chunk) => {
          streamController?.enqueue(chunk);
        },
        onEnd: () => {
          streamController?.close();
          streamController = undefined;
        },
        onError: (error) => {
          streamController?.error(error);
          streamController = undefined;
        },
      });
    } catch (error) {
      // Nothing will read the stream prepared above, and an aborted request must surface as an
      // abort rather than as a transport error (fetch semantics).
      await streamedBody.cancel().catch(() => undefined);
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw error;
    }
    validateResponseFrame(responseFrame, maxBodyBytes);

    if (responseFrame.streamed) {
      // Hand the stream over even when it already completed: the consumer still has to read
      // the chunks that were enqueued before the end envelope arrived.
      return new Response(streamedBody, {
        status: responseFrame.status,
        statusText: responseFrame.statusText,
        headers: new Headers(responseFrame.headers),
      });
    }

    await streamedBody.cancel().catch(() => undefined);
    return new Response(base64ToBody(responseFrame.bodyBase64, maxBodyBytes), {
      status: responseFrame.status,
      statusText: responseFrame.statusText,
      headers: new Headers(responseFrame.headers),
    });
  };
}

export function createP2PDataPlaneHandler(options: P2PDataPlaneHandlerOptions): P2PDataPlaneHandler {
  const targetBaseUrl = new URL(options.targetBaseUrl.toString());
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBodyBytes = options.maxBodyBytes ?? P2P_DATA_PLANE_LIMITS.maxBodyBytes;

  return {
    async handleRequest(frame: P2PHttpRequestFrame, requestOptions?: { signal?: AbortSignal }): Promise<P2PHttpResponseFrame> {
      validateRequestFrame(frame, maxBodyBytes);
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
        body: methodCanHaveBody(frame.method) ? base64ToBody(frame.bodyBase64, maxBodyBytes) : undefined,
        // Cancellation has to reach the upstream request, otherwise a cancelled client leaves
        // the node fetching a body nobody will read (audit N17).
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
      });

      const wantsStream = (frame.headers ?? [])
        .some(([key, value]) => key.toLowerCase() === XPOD_P2P_ACCEPT_HEADER && value === XPOD_P2P_ACCEPT_CHUNKED);
      if (wantsStream && response.body) {
        return {
          protocol: XPOD_P2P_HTTP_PROTOCOL,
          requestId: frame.requestId,
          status: response.status,
          statusText: response.statusText,
          headers: headersToList(response.headers),
          bodyStream: response.body,
        };
      }

      return {
        protocol: XPOD_P2P_HTTP_PROTOCOL,
        requestId: frame.requestId,
        status: response.status,
        statusText: response.statusText,
        headers: headersToList(response.headers),
        bodyBase64: await responseToBase64(response, maxBodyBytes),
      };
    },
  };
}

function validateRequestFrame(frame: P2PHttpRequestFrame, maxBodyBytes: number): void {
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
  // The client is expected to refuse oversized bodies itself; this is the side that must not
  // trust it (audit N17).
  if (frame.bodyBase64 !== undefined && base64ByteLength(frame.bodyBase64) > maxBodyBytes) {
    throw new P2PDataPlaneLimitError(
      `P2P HTTP request body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
}

function validateResponseFrame(frame: P2PHttpResponseFrame, maxBodyBytes: number): void {
  if (frame.protocol !== XPOD_P2P_HTTP_PROTOCOL) {
    throw new Error(`Unsupported P2P HTTP protocol: ${String(frame.protocol)}`);
  }
  if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599) {
    throw new Error(`Invalid P2P HTTP response status: ${String(frame.status)}`);
  }
  if (frame.bodyBase64 !== undefined && base64ByteLength(frame.bodyBase64) > maxBodyBytes) {
    throw new P2PDataPlaneLimitError(
      `P2P HTTP response body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
}

/** Decoded size of a base64 payload without allocating the buffer. */
export function base64ByteLength(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
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

async function bodyToBase64(request: Request, maxBodyBytes: number): Promise<string | undefined> {
  if (!methodCanHaveBody(request.method)) {
    return undefined;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBodyBytes) {
    // Refuse before reading: buffering an oversized upload just to reject it is the failure
    // mode this limit exists to prevent.
    throw new P2PDataPlaneLimitError(
      `P2P HTTP request body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBodyBytes) {
    throw new P2PDataPlaneLimitError(
      `P2P HTTP request body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
  if (body.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(body).toString('base64');
}

async function responseToBase64(response: Response, maxBodyBytes: number): Promise<string | undefined> {
  const body = await response.arrayBuffer();
  if (body.byteLength > maxBodyBytes) {
    throw new P2PDataPlaneLimitError(
      `P2P HTTP response body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
  if (body.byteLength === 0) {
    return undefined;
  }
  return Buffer.from(body).toString('base64');
}

function base64ToBody(value: string | undefined, maxBodyBytes: number): BodyInit | undefined {
  if (!value) {
    return undefined;
  }
  if (base64ByteLength(value) > maxBodyBytes) {
    throw new P2PDataPlaneLimitError(
      `P2P HTTP body exceeds ${maxBodyBytes} bytes`,
      'maxBodyBytes',
    );
  }
  return Buffer.from(value, 'base64');
}
