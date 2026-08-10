import { ProxyAgent } from 'undici';

function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export interface ProviderSseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface ProviderHttpTransportOptions {
  fetch?: typeof fetch;
}

export class ProviderHttpTransport {
  private readonly fetch: typeof fetch;

  public constructor(options: ProviderHttpTransportOptions = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  public async postJson(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    maxResponseBytes?: number;
  }): Promise<any> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return readJsonResponse(response, options.maxResponseBytes);
  }

  public async postStream(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }): Promise<Response> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return response;
  }

  public async postForm(options: {
    url: string;
    apiKey: string;
    body: FormData;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
    maxResponseBytes?: number;
  }): Promise<any> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${options.apiKey}`);
    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: options.body,
      signal: options.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }
    return readJsonResponse(response, options.maxResponseBytes);
  }

  public async *postSse(options: {
    url: string;
    apiKey?: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }): AsyncIterable<ProviderSseEvent> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : this.fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (options.apiKey) {
      headers.set('Authorization', `Bearer ${options.apiKey}`);
    }

    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    if (!response.body) {
      return;
    }

    yield* parseSseStream(response.body);
  }
}

async function readJsonResponse(response: Response, maxBytes?: number): Promise<unknown> {
  if (!maxBytes) return response.json();
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw providerResponseTooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw providerResponseTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function providerResponseTooLarge(): Error {
  const error = new Error('Provider response exceeds the configured size limit');
  (error as any).status = 502;
  return error;
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
