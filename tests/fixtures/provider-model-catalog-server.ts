import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ProviderModelCatalogFixtureOptions {
  host?: string;
  port?: number;
  models?: readonly string[];
  controlToken?: string;
}

export interface ProviderModelCatalogFixtureSnapshot {
  modelIds: string[];
  requestCount: number;
  authorizationTouched: boolean;
  authorizationRequestCount: number;
  paths: string[];
}

export interface ProviderModelCatalogFixture {
  /** OpenAI-compatible provider base URL, including the `/v1` path. */
  baseUrl: string;
  /** Local-only control endpoint; it never exposes request headers. */
  controlUrl: string;
  setModels(modelIds: readonly string[]): Promise<void>;
  removeModel(modelId: string): Promise<void>;
  resetAuthTouches(): Promise<void>;
  snapshot(): Promise<ProviderModelCatalogFixtureSnapshot>;
  close(): Promise<void>;
}

const DEFAULT_MODELS = ['gpt-5', 'gpt-5-mini'];
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A deterministic, mutable OpenAI-compatible provider for local acceptance.
 *
 * The fixture deliberately records only whether an Authorization header was
 * present and bounded request metadata. It never stores, returns, or logs the
 * header value, so provider credentials cannot become acceptance artifacts.
 */
export async function startProviderModelCatalogServer(
  options: ProviderModelCatalogFixtureOptions = {},
): Promise<ProviderModelCatalogFixture> {
  const host = options.host ?? '127.0.0.1';
  const controlToken = options.controlToken?.trim() || undefined;
  let modelIds = normalizeModelIds(options.models ?? DEFAULT_MODELS) ?? [];
  let requestCount = 0;
  let authorizationTouched = false;
  let authorizationRequestCount = 0;
  const paths: string[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    const method = request.method ?? 'GET';
    requestCount += 1;
    paths.push(`${method} ${url.pathname}`);
    if (request.headers.authorization) {
      authorizationTouched = true;
      authorizationRequestCount += 1;
    }

    if (method === 'OPTIONS') {
      sendJson(response, 204, undefined);
      return;
    }

    if (url.pathname === '/__xpod_fixture/status' && method === 'GET') {
      if (!authorizedControlRequest(request, controlToken)) {
        sendJson(response, 401, { error: 'fixture_control_unauthorized' });
        return;
      }
      sendJson(response, 200, snapshotValue());
      return;
    }

    if (url.pathname === '/__xpod_fixture/models' && method === 'PUT') {
      if (!authorizedControlRequest(request, controlToken)) {
        sendJson(response, 401, { error: 'fixture_control_unauthorized' });
        return;
      }
      const body = await readJsonBody(request, response);
      if (!body) return;
      const next = normalizeModelIds(body.models);
      if (!next) {
        sendJson(response, 400, { error: 'models must be a string array' });
        return;
      }
      modelIds = next;
      sendJson(response, 200, snapshotValue());
      return;
    }

    if (url.pathname === '/__xpod_fixture/models/remove' && method === 'POST') {
      if (!authorizedControlRequest(request, controlToken)) {
        sendJson(response, 401, { error: 'fixture_control_unauthorized' });
        return;
      }
      const body = await readJsonBody(request, response);
      const id = body?.id;
      if (typeof id !== 'string' || !id.trim()) {
        sendJson(response, 400, { error: 'id is required' });
        return;
      }
      modelIds = modelIds.filter((candidate) => candidate !== id.trim());
      sendJson(response, 200, snapshotValue());
      return;
    }

    if (url.pathname === '/__xpod_fixture/auth/reset' && method === 'POST') {
      if (!authorizedControlRequest(request, controlToken)) {
        sendJson(response, 401, { error: 'fixture_control_unauthorized' });
        return;
      }
      authorizationTouched = false;
      authorizationRequestCount = 0;
      sendJson(response, 200, snapshotValue());
      return;
    }

    if (url.pathname === '/v1/models' && method === 'GET') {
      sendJson(response, 200, {
        object: 'list',
        data: modelIds.map((id) => ({
          id,
          object: 'model',
          owned_by: 'xpod-acceptance-fixture',
        })),
      });
      return;
    }

    if (url.pathname === '/v1/responses' && method === 'POST') {
      await handleResponses(request, response);
      return;
    }

    if (url.pathname === '/v1/chat/completions' && method === 'POST') {
      await handleChatCompletions(request, response);
      return;
    }

    if (url.pathname === '/v1/messages' && method === 'POST') {
      await handleMessages(request, response);
      return;
    }

    sendJson(response, 404, { error: 'fixture_route_not_found' });
  });

  await listen(server, host, options.port ?? 0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('provider model fixture did not expose a TCP address');
  }
  const origin = `http://${host}:${address.port}`;

  const snapshot = (): ProviderModelCatalogFixtureSnapshot => snapshotValue();
  const assertControlToken = (headers: HeadersInit = {}): Headers => {
    const normalized = new Headers(headers);
    if (controlToken) normalized.set('x-xpod-fixture-token', controlToken);
    return normalized;
  };
  const controlRequest = async (pathname: string, init?: RequestInit): Promise<Response> => fetch(`${origin}${pathname}`, {
    ...init,
    headers: assertControlToken(init?.headers),
  });

  return {
    baseUrl: `${origin}/v1`,
    controlUrl: `${origin}/__xpod_fixture`,
    async setModels(nextModelIds) {
      const response = await controlRequest('/__xpod_fixture/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: nextModelIds }),
      });
      if (!response.ok) throw new Error(`fixture setModels failed: ${response.status}`);
      modelIds = normalizeModelIds(nextModelIds) ?? modelIds;
    },
    async removeModel(modelId) {
      const response = await controlRequest('/__xpod_fixture/models/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: modelId }),
      });
      if (!response.ok) throw new Error(`fixture removeModel failed: ${response.status}`);
      modelIds = modelIds.filter((id) => id !== modelId);
    },
    async resetAuthTouches() {
      const response = await controlRequest('/__xpod_fixture/auth/reset', { method: 'POST' });
      if (!response.ok) throw new Error(`fixture resetAuthTouches failed: ${response.status}`);
      authorizationTouched = false;
      authorizationRequestCount = 0;
    },
    async snapshot() {
      return snapshot();
    },
    async close() {
      await closeServer(server);
    },
  };

  function snapshotValue(): ProviderModelCatalogFixtureSnapshot {
    return {
      modelIds: [...modelIds],
      requestCount,
      authorizationTouched,
      authorizationRequestCount,
      paths: [...paths],
    };
  }
}

async function handleResponses(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request, response);
  if (!body) return;
  const model = typeof body.model === 'string' ? body.model : 'gpt-5';
  sendJson(response, 200, {
    id: 'resp_xpod_fixture',
    object: 'response',
    model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture response' }] }],
  });
}

async function handleChatCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request, response);
  if (!body) return;
  const model = typeof body.model === 'string' ? body.model : 'gpt-5';
  sendJson(response, 200, {
    id: 'chatcmpl_xpod_fixture',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }],
  });
}

async function handleMessages(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request, response);
  if (!body) return;
  const model = typeof body.model === 'string' ? body.model : 'gpt-5';
  sendJson(response, 200, {
    id: 'msg_xpod_fixture',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'fixture response' }],
    stop_reason: 'end_turn',
  });
}

function normalizeModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.trim())
    .filter(Boolean))];
  return ids;
}

function authorizedControlRequest(request: IncomingMessage, controlToken: string | undefined): boolean {
  return !controlToken || request.headers['x-xpod-fixture-token'] === controlToken;
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: 'fixture_body_too_large' });
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    sendJson(response, 400, { error: 'fixture_invalid_json' });
    return undefined;
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type, x-xpod-fixture-token');
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const models = readFlag('--models')?.split(',') ?? DEFAULT_MODELS;
  const fixture = await startProviderModelCatalogServer({
    host: readFlag('--host') ?? '127.0.0.1',
    port: Number(readFlag('--port') ?? 0),
    models,
    controlToken: readFlag('--control-token'),
  });
  process.stdout.write(`${JSON.stringify({ baseUrl: fixture.baseUrl, controlUrl: fixture.controlUrl })}\n`);
  const shutdown = async (): Promise<void> => {
    await fixture.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => undefined);
}
