import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  Agent as UndiciAgent,
  Client as UndiciClient,
  Dispatcher as UndiciDispatcher,
  ProxyAgent as UndiciProxyAgent,
  buildConnector,
  fetch as undiciFetch,
} from 'undici/index.js';
import {
  DEFAULT_PROVIDER_HTTP_TIMEOUT_MS,
  PROVIDER_ERROR_BODY_LIMIT_BYTES,
  defaultProviderAddressResolver,
  isProviderAddressUnsafe,
  resolveProviderTarget,
  type ProviderTargetResolution,
  type ProviderAddressResolver,
} from './provider-http-policy';

export type { ProviderAddressResolver, ProviderResolvedAddress } from './provider-http-policy';

export function normalizeProviderProxyUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || !value.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('invalid_proxy_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new Error('invalid_proxy_url');
  }
  return parsed.href.replace(/\/$/u, '');
}

export function redactProviderProxyUrl(value: string | undefined | null): string | undefined {
  const normalized = normalizeProviderProxyUrl(value);
  if (!normalized) return undefined;
  const parsed = new URL(normalized);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/$/u, '');
}

export function discoverSystemProviderProxy(): string | undefined {
  const environmentProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (environmentProxy) return normalizeProviderProxyUrl(environmentProxy);
  if (process.platform !== 'darwin') return undefined;
  try {
    const output = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1_000 });
    const enabled = /HTTPSEnable\s*:\s*1/u.test(output);
    const host = output.match(/HTTPSProxy\s*:\s*([^\s]+)/u)?.[1];
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/u)?.[1];
    return enabled && host && port ? normalizeProviderProxyUrl(`http://${host}:${port}`) : undefined;
  } catch {
    return undefined;
  }
}

type ProviderConnector = ReturnType<typeof buildConnector>;
type ProviderConnectOptions = Parameters<ProviderConnector>[0];
type ProviderConnectCallback = Parameters<ProviderConnector>[1];

interface PreparedProviderRequest {
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit, onBodyFinish?: () => void) => Promise<Response>;
  dispatcher: UndiciDispatcher;
}

/** @internal Runtime compatibility for Bun's inert undici dispatcher shim. */
export async function closeProviderDispatcher(dispatcher: UndiciDispatcher): Promise<void> {
  const compatible = dispatcher as UndiciDispatcher & {
    destroyed?: boolean;
    close?: () => Promise<void> | void;
    destroy?: () => Promise<void> | void;
  };
  if (compatible.destroyed) return;
  if (typeof compatible.close === 'function') {
    await compatible.close();
    return;
  }
  if (typeof compatible.destroy === 'function') {
    await compatible.destroy();
  }
}

function createPinnedConnector(
  resolver: ProviderAddressResolver,
  allowPrivateNetwork: boolean,
): ProviderConnector {
  const connector = buildConnector({});
  return (options: ProviderConnectOptions, callback: ProviderConnectCallback) => {
    const originalHostname = options.hostname;
    const hostname = stripIpv6Brackets(originalHostname);
    const recordsPromise = isIP(hostname) !== 0
      ? Promise.resolve([{ address: hostname }])
      : resolver(originalHostname);

    void recordsPromise.then((records) => {
      if (records.length === 0
        || records.some((record) => !record.address || isIP(stripIpv6Brackets(record.address)) === 0)
        || (!allowPrivateNetwork && records.some((record) => isProviderAddressUnsafe(record.address)))) {
        callback(new Error('unsafe_provider_target'), null);
        return;
      }

      const address = stripIpv6Brackets(records[0]!.address);
      connector({
        ...options,
        hostname: address,
        servername: options.servername ?? originalHostname,
      }, callback);
    }).catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error(String(error)), null);
    });
  };
}

function createPinnedAgent(
  resolution: ProviderTargetResolution,
  resolver: ProviderAddressResolver,
): UndiciAgent {
  return new UndiciAgent({
    connect: createPinnedConnector(resolver, resolution.allowPrivateNetwork),
  });
}

function createPinnedProxyAgent(
  resolution: ProviderTargetResolution,
  resolver: ProviderAddressResolver,
  target?: ProviderTargetResolution,
): UndiciDispatcher {
  const proxyConnector = createPinnedConnector(resolver, resolution.allowPrivateNetwork);
  const agent = new UndiciProxyAgent({
    uri: resolution.url.href,
    requestTls: target ? { servername: stripIpv6Brackets(target.hostname) } : undefined,
    clientFactory: (origin, options) => new UndiciClient(origin, {
      ...options,
      connect: proxyConnector,
    }),
  });
  if (!target) return agent;
  // fetch removes Host before dispatch. Restore the checked origin's identity
  // inside the tunnel while its request URL keeps the destination IP pinned.
  return agent.compose((dispatch) => (options, handler) => {
    const headers = options.headers;
    const entries = Array.isArray(headers)
      ? headers.reduce<[string, string][]>((pairs, value, index) => {
        if (index % 2 === 0) pairs.push([value, headers[index + 1]]);
        return pairs;
      }, [])
      : headers && Symbol.iterator in headers ? [...headers] : Object.entries(headers ?? {});
    return dispatch({ ...options, headers: { ...Object.fromEntries(entries), host: target.url.host } }, handler);
  });
}

export interface ProviderSseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface ProviderHttpTransportOptions {
  fetch?: typeof fetch;
  resolver?: ProviderAddressResolver;
  timeoutMs?: number;
  /** Exact origins owned by a hermetic test harness; never a general private-network bypass. */
  allowedPrivateOrigins?: string[];
  systemProxy?: string;
}

export interface ProviderHttpRequestOptions {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  proxy?: string;
  redirect?: 'manual' | 'error';
  allowPrivateNetwork?: boolean;
}

export class ProviderHttpTransport {
  private readonly fetch: typeof fetch;
  private readonly resolver: ProviderAddressResolver;
  private readonly timeoutMs: number;
  private readonly allowedPrivateOrigins: ReadonlySet<string>;
  private readonly systemProxy?: string;

  public constructor(options: ProviderHttpTransportOptions = {}) {
    // The bare undici import is an inert Bun built-in shim. Its package entry
    // and fetch implementation are required for DNS-pinned dispatchers on Bun.
    this.fetch = options.fetch ?? (process.versions.bun ? undiciFetch as unknown as typeof fetch : fetch);
    this.resolver = options.resolver ?? defaultProviderAddressResolver;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_HTTP_TIMEOUT_MS;
    this.allowedPrivateOrigins = new Set((options.allowedPrivateOrigins ?? []).map((value) => new URL(value).origin));
    this.systemProxy = normalizeProviderProxyUrl(options.systemProxy);
  }

  /** A single policy-checked request; the caller owns HTTP status handling and body consumption. */
  public async request(options: ProviderHttpRequestOptions): Promise<Response> {
    const redirect = options.redirect ?? 'manual';
    if (redirect !== 'manual' && redirect !== 'error') throw new Error('invalid_provider_redirect_policy');
    const { signal, cleanup } = createProviderRequestSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
    let request: PreparedProviderRequest | undefined;
    try {
      signal.throwIfAborted();
      request = await this.prepareRequest(options.url, options.proxy, options.allowPrivateNetwork, signal);
      const response = await request.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal,
        redirect,
      }, cleanup);
      if (!response.body) {
        cleanup();
        await closeProviderDispatcher(request.dispatcher);
        return response;
      }
      return process.versions.bun ? response : bindProviderResponseSignal(response, signal, request.dispatcher, cleanup);
    } catch (error) {
      cleanup();
      if (request) await closeProviderDispatcher(request.dispatcher);
      throw error;
    }
  }

  public async postJson(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean;
  }): Promise<any> {
    const request = await this.prepareRequest(options.url, options.proxy, options.allowPrivateNetwork);
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await request.fetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body),
        signal,
        redirect: 'manual',
      });

      if (!response.ok) {
        throw await providerResponseError(response);
      }

      return await response.json();
    } finally {
      cleanup();
      await closeProviderDispatcher(request.dispatcher);
    }
  }

  public async postStream(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean;
  }): Promise<Response> {
    const request = await this.prepareRequest(options.url, options.proxy, options.allowPrivateNetwork);
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await request.fetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body),
        signal,
        redirect: 'manual',
      }, cleanup);
    } catch (error) {
      cleanup();
      await closeProviderDispatcher(request.dispatcher);
      throw error;
    }
    if (process.versions.bun && response.ok && response.body) {
      return response;
    }
    if (!process.versions.bun) cleanup();

    if (!response.ok) {
      try {
        const errorText = await readResponseTextLimit(response, PROVIDER_ERROR_BODY_LIMIT_BYTES);
        const error = new Error(`Provider error: ${response.statusText}`);
        (error as any).status = response.status;
        (error as any).headers = response.headers;
        (error as any).body = errorText;
        throw error;
      } finally {
        cleanup();
        await closeProviderDispatcher(request.dispatcher);
      }
    }

    cleanup();
    return response;
  }

  public async *postSse(options: {
    url: string;
    apiKey?: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean;
  }): AsyncIterable<ProviderSseEvent> {
    const request = await this.prepareRequest(options.url, options.proxy, options.allowPrivateNetwork);
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (options.apiKey) {
      headers.set('Authorization', `Bearer ${options.apiKey}`);
    }

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await request.fetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body),
        signal,
        redirect: 'manual',
      });

      if (!response.ok) {
        throw await providerResponseError(response);
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('application/json') || contentType.includes('+json')) {
        yield { data: await response.text() };
        return;
      }

      if (!response.body) {
        return;
      }

      yield* parseSseStream(response.body);
    } finally {
      cleanup();
      await closeProviderDispatcher(request.dispatcher);
    }
  }

  public async getJson(options: {
    url: string;
    apiKey?: string;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean;
  }): Promise<any> {
    const request = await this.prepareRequest(options.url, options.proxy, options.allowPrivateNetwork);
    const headers = new Headers(options.headers);
    if (options.apiKey) headers.set('Authorization', `Bearer ${options.apiKey}`);
    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await request.fetch(options.url, {
        method: 'GET',
        headers,
        signal,
        redirect: 'manual',
      });
      if (!response.ok) {
        throw await providerResponseError(response);
      }
      return await response.json();
    } finally {
      cleanup();
      await closeProviderDispatcher(request.dispatcher);
    }
  }

  private async resolveTarget(
    url: string,
    allowPrivateNetwork?: boolean,
    allowConfiguredPrivateOrigin = true,
    resolver = this.resolver,
  ): Promise<ProviderTargetResolution> {
    const configuredOriginAllowed = allowConfiguredPrivateOrigin
      && this.allowedPrivateOrigins.has(new URL(url).origin);
    return resolveProviderTarget({
      url,
      allowPrivateNetwork: configuredOriginAllowed || allowPrivateNetwork,
      resolver,
    });
  }

  private async prepareRequest(
    url: string,
    proxy: string | undefined,
    allowPrivateNetwork?: boolean,
    signal?: AbortSignal,
  ): Promise<PreparedProviderRequest> {
    const resolver: ProviderAddressResolver = signal
      ? (hostname) => awaitProviderSignal(() => this.resolver(hostname), signal)
      : this.resolver;
    const targetResolution = await this.resolveTarget(url, allowPrivateNetwork, true, resolver);
    const normalizedProxy = normalizeProviderProxyUrl(proxy) ?? this.systemProxy;
    const trustedLocalSystemProxy = normalizedProxy !== undefined
      && normalizedProxy === this.systemProxy;
    const pinProxyTarget = Boolean(process.versions.bun || signal);
    const dispatcher = normalizedProxy
      ? createPinnedProxyAgent(
        await this.resolveTarget(normalizedProxy, trustedLocalSystemProxy, false, resolver),
        resolver,
        pinProxyTarget ? targetResolution : undefined,
      )
      : createPinnedAgent(targetResolution, resolver);
    return {
      dispatcher,
      fetch: async (input, init, onBodyFinish) => {
        if (pinProxyTarget && normalizedProxy) {
          // A proxy must connect to the checked IP, not resolve the original name
          // again. Retain the origin identity for HTTP and TLS inside the tunnel.
          const target = await this.resolveTarget(url, allowPrivateNetwork, true, resolver);
          const pinnedUrl = new URL(target.url.href);
          const address = stripIpv6Brackets(target.addresses[0]!.address);
          pinnedUrl.hostname = isIP(address) === 6 ? `[${address}]` : address;
          const response = await this.fetch(pinnedUrl.href, { ...init, dispatcher } as any);
          return process.versions.bun ? bindProviderResponseSignal(response, init?.signal, dispatcher, onBodyFinish) : response;
        }
        const response = await this.fetch(input, { ...init, dispatcher } as any);
        return process.versions.bun ? bindProviderResponseSignal(response, init?.signal, dispatcher, onBodyFinish) : response;
      },
    };
  }
}

function awaitProviderSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Tie raw response consumption to the request lifetime. Bun also needs an
// explicit body abort because undici's Node readability check misses its streams.
function bindProviderResponseSignal(
  response: Response,
  signal: AbortSignal | null | undefined,
  dispatcher: UndiciDispatcher,
  onFinish?: () => void,
): Response {
  if (!response.body || !signal) return response;
  const reader = response.body.getReader();
  let abort: () => void;
  const cleanup = () => {
    signal.removeEventListener('abort', abort);
    onFinish?.();
  };
  const cancel = async (reason?: unknown) => {
    cleanup();
    await Promise.all([
      reader.cancel(reason).catch((error: unknown) => {
        // Cancelling a stream that has already errored rejects with that same
        // terminal error. Preserve it; propagate any distinct cleanup failure.
        if (error !== reason) throw error;
      }),
      dispatcher.destroy(),
    ]);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        void cancel(signal.reason).then(
          () => controller.error(signal.reason),
          (error: unknown) => controller.error(error),
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (signal.aborted) return;
        if (done) {
          cleanup();
          if (onFinish) await closeProviderDispatcher(dispatcher);
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        await cancel(error);
        controller.error(error);
      }
    },
    cancel,
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function createProviderRequestSignal(
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('provider_request_timeout')), timeoutMs);
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

async function readResponseTextLimit(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      const remaining = limitBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    try {
      if (!completed) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return new TextDecoder().decode(concatUint8Arrays(chunks, total));
}

async function providerResponseError(response: Response): Promise<Error> {
  const errorText = await readResponseTextLimit(response, PROVIDER_ERROR_BODY_LIMIT_BYTES);
  const error = new Error(`Provider error: ${response.statusText}`);
  (error as any).status = response.status;
  (error as any).headers = response.headers;
  (error as any).body = errorText;
  return error;
}

function concatUint8Arrays(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ProviderSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let failure: unknown;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const normalized = buffer.replace(/\r\n/g, '\n');
      const events = normalized.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const parsed = parseSseEvent(event);
        if (parsed) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseEvent(buffer.replace(/\r\n/g, '\n'));
    if (parsed) {
      yield parsed;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch (cancelError) {
        if (failure === undefined) {
          throw cancelError;
        }
      }
    }
    reader.releaseLock();
  }
}

function parseSseEvent(raw: string): ProviderSseEvent | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'data') {
      data.push(value);
    } else if (field === 'event') {
      event = value;
    } else if (field === 'id') {
      id = value;
    }
  }
  return data.length > 0 ? { event, id, data: data.join('\n') } : undefined;
}
