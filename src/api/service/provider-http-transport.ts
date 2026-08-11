import { isIP } from 'node:net';
import {
  Agent as UndiciAgent,
  Client as UndiciClient,
  Dispatcher as UndiciDispatcher,
  ProxyAgent as UndiciProxyAgent,
  buildConnector,
} from 'undici';
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

type ProviderConnector = ReturnType<typeof buildConnector>;
type ProviderConnectOptions = Parameters<ProviderConnector>[0];
type ProviderConnectCallback = Parameters<ProviderConnector>[1];

interface PreparedProviderRequest {
  fetch: typeof fetch;
  dispatcher: UndiciDispatcher;
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
): UndiciProxyAgent {
  const proxyConnector = createPinnedConnector(resolver, resolution.allowPrivateNetwork);
  return new UndiciProxyAgent({
    uri: resolution.url.href,
    clientFactory: (origin, options) => new UndiciClient(origin, {
      ...options,
      connect: proxyConnector,
    }),
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
}

export class ProviderHttpTransport {
  private readonly fetch: typeof fetch;
  private readonly resolver: ProviderAddressResolver;
  private readonly timeoutMs: number;
  private readonly allowedPrivateOrigins: ReadonlySet<string>;

  public constructor(options: ProviderHttpTransportOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.resolver = options.resolver ?? defaultProviderAddressResolver;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_HTTP_TIMEOUT_MS;
    this.allowedPrivateOrigins = new Set((options.allowedPrivateOrigins ?? []).map((value) => new URL(value).origin));
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
      await request.dispatcher.close();
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
      });
    } catch (error) {
      cleanup();
      await request.dispatcher.close();
      throw error;
    }
    cleanup();

    if (!response.ok) {
      try {
        const errorText = await readResponseTextLimit(response, PROVIDER_ERROR_BODY_LIMIT_BYTES);
        const error = new Error(`Provider error: ${response.statusText}`);
        (error as any).status = response.status;
        (error as any).headers = response.headers;
        (error as any).body = errorText;
        throw error;
      } finally {
        await request.dispatcher.close();
      }
    }

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

      if (!response.body) {
        return;
      }

      yield* parseSseStream(response.body);
    } finally {
      cleanup();
      await request.dispatcher.close();
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
      await request.dispatcher.close();
    }
  }

  private async resolveTarget(
    url: string,
    allowPrivateNetwork?: boolean,
    allowConfiguredPrivateOrigin = true,
  ): Promise<ProviderTargetResolution> {
    const configuredOriginAllowed = allowConfiguredPrivateOrigin
      && this.allowedPrivateOrigins.has(new URL(url).origin);
    return resolveProviderTarget({
      url,
      allowPrivateNetwork: configuredOriginAllowed || allowPrivateNetwork,
      resolver: this.resolver,
    });
  }

  private async prepareRequest(
    url: string,
    proxy: string | undefined,
    allowPrivateNetwork?: boolean,
  ): Promise<PreparedProviderRequest> {
    const targetResolution = await this.resolveTarget(url, allowPrivateNetwork);
    const normalizedProxy = normalizeProviderProxyUrl(proxy);
    const dispatcher = normalizedProxy
      ? createPinnedProxyAgent(
        await this.resolveTarget(normalizedProxy, false, false),
        this.resolver,
      )
      : createPinnedAgent(targetResolution, this.resolver);
    return {
      dispatcher,
      fetch: (input, init) => this.fetch(input, { ...init, dispatcher } as any),
    };
  }
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
  try {
    while (total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    reader.releaseLock();
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
