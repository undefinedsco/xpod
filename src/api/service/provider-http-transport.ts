import { ProxyAgent as UndiciProxyAgent } from 'undici';
import {
  DEFAULT_PROVIDER_HTTP_TIMEOUT_MS,
  PROVIDER_ERROR_BODY_LIMIT_BYTES,
  assertProviderTargetAllowed,
  defaultProviderAddressResolver,
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

function createProxyFetch(proxyUrl: string, fetchFn: typeof fetch): typeof fetch {
  const normalized = normalizeProviderProxyUrl(proxyUrl);
  if (!normalized) return fetchFn;
  const dispatcher = new UndiciProxyAgent(normalized);
  return (url, init) => fetchFn(url, { ...init, dispatcher } as any);
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
    await this.assertRequestAllowed(options.url, options.proxy, options.allowPrivateNetwork);
    const fetchFn = options.proxy ? createProxyFetch(options.proxy, this.fetch) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await fetchFn(options.url, {
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
    await this.assertRequestAllowed(options.url, options.proxy, options.allowPrivateNetwork);
    const fetchFn = options.proxy ? createProxyFetch(options.proxy, this.fetch) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal,
      redirect: 'manual',
    }).finally(cleanup);

    if (!response.ok) {
      const errorText = await readResponseTextLimit(response, PROVIDER_ERROR_BODY_LIMIT_BYTES);
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
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
    await this.assertRequestAllowed(options.url, options.proxy, options.allowPrivateNetwork);
    const fetchFn = options.proxy ? createProxyFetch(options.proxy, this.fetch) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (options.apiKey) {
      headers.set('Authorization', `Bearer ${options.apiKey}`);
    }

    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await fetchFn(options.url, {
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
    await this.assertRequestAllowed(options.url, options.proxy, options.allowPrivateNetwork);
    const fetchFn = options.proxy ? createProxyFetch(options.proxy, this.fetch) : this.fetch;
    const headers = new Headers(options.headers);
    if (options.apiKey) headers.set('Authorization', `Bearer ${options.apiKey}`);
    const { signal, cleanup } = createProviderRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await fetchFn(options.url, {
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
    }
  }

  private async assertTargetAllowed(
    url: string,
    allowPrivateNetwork?: boolean,
    allowConfiguredPrivateOrigin = true,
  ): Promise<void> {
    const configuredOriginAllowed = allowConfiguredPrivateOrigin
      && this.allowedPrivateOrigins.has(new URL(url).origin);
    await assertProviderTargetAllowed({
      url,
      allowPrivateNetwork: configuredOriginAllowed || allowPrivateNetwork,
      resolver: this.resolver,
    });
  }

  private async assertRequestAllowed(
    url: string,
    proxy: string | undefined,
    allowPrivateNetwork?: boolean,
  ): Promise<void> {
    await this.assertTargetAllowed(url, allowPrivateNetwork);
    if (proxy) await this.assertTargetAllowed(normalizeProviderProxyUrl(proxy)!, false, false);
  }
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
