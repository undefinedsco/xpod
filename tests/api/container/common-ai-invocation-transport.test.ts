import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';
import { registerSocketOriginShims } from '../../../src/runtime/socket-shim';

/**
 * Regression: the invocation key issued to remote consumers is always bound to the canonical
 * identity realm (baseUrl/audience/issuer). A local agent loop reaches the Gateway through the
 * runtime `gatewayTransport` binding (socket or gateway port), which never leaks into that key.
 *
 * The owned listener is a raw OpenAI-compatible fixture, NOT the production API server.
 */

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const ENV_KEYS = ['CSS_BASE_URL', 'XPOD_PUBLIC_URL', 'XPOD_MAIN_PORT'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address !== 'object') {
        probe.close(() => reject(new Error('No port allocated')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

type Served = { url: string; streaming: boolean };

function startModelServer(served: Served[], listen: number | string): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1_000_000) {
          break;
        }
      }
      let streaming = false;
      try {
        streaming = JSON.parse(body)?.stream === true;
      } catch {
        streaming = false;
      }
      served.push({ url: request.url ?? '', streaming });

      if (streaming) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        sendSse(response, {
          id: 'chatcmpl-transport-stream',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        });
        sendSse(response, {
          id: 'chatcmpl-transport-stream',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
        });
        sendSse(response, {
          id: 'chatcmpl-transport-stream',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-transport-regression',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    })();
  });
  return new Promise<Server>((resolve, reject) => {
    server.on('error', reject);
    if (typeof listen === 'number') {
      server.listen(listen, '127.0.0.1', () => resolve(server));
    } else {
      server.listen(listen, () => resolve(server));
    }
  });
}

function sendSse(response: ServerResponse, chunk: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function baseConfig(overrides: Partial<ApiContainerConfig> = {}): ApiContainerConfig {
  return {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'http://127.0.0.1:1/.oidc/token',
    gatewayLocatorSecret: 'unit-test-locator-secret-000000000000',
    secretCellVaultFactory: (() => ({})) as never,
    ...overrides,
  };
}

type Issued = {
  container: ReturnType<typeof createApiContainer>;
  baseUrl: string;
  apiKey: string;
  audience: string | undefined;
  issuer: string | undefined;
};

async function issueForLocal(config: ApiContainerConfig): Promise<Issued> {
  const container = createApiContainer(config);
  try {
    const issuer = container.resolve('aiConnectionInvocationKeyIssuer');
    if (!issuer) {
      throw new Error('aiConnectionInvocationKeyIssuer is not registered');
    }
    const invocation = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID } } as never);
    const codec = container.resolve('invocationTokenCodec');
    if (!codec) {
      throw new Error('invocationTokenCodec is not registered');
    }
    const claims = codec.decode(invocation.apiKey);
    return {
      container,
      baseUrl: invocation.baseUrl,
      apiKey: invocation.apiKey,
      audience: claims?.audience,
      issuer: claims?.issuer,
    };
  } catch (error) {
    await container.dispose();
    throw error;
  }
}

function fakeClient(issued: Issued): OpenAI {
  return new OpenAI({ apiKey: issued.apiKey, baseURL: issued.baseUrl, maxRetries: 0, timeout: 5_000 });
}

async function authenticateConsumer(issued: Issued): Promise<boolean> {
  const authenticator = issued.container.resolve('authenticator') as unknown as {
    authenticate: (request: unknown) => Promise<{ success: boolean }>;
  };
  const result = await authenticator.authenticate({
    headers: { authorization: `Bearer ${issued.apiKey}` },
    method: 'POST',
    url: '/v1/chat/completions',
  });
  return result.success;
}

describe('Hosted AI-Connection invocation key realm', () => {
  it('routes the installed SDK to the owned gateway socket through the canonical origin without changing the key realm', async () => {
    const served: Served[] = [];
    const socketDir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'inv-sock-'));
    const socketPath = path.join(socketDir, 'g.sock');
    const canonicalOrigin = 'https://node.example';
    let issued: Issued | undefined;
    let server: Server | undefined;
    const unregister = registerSocketOriginShims(canonicalOrigin, socketPath);
    try {
      server = await startModelServer(served, socketPath);
      issued = await issueForLocal(baseConfig({ host: '127.0.0.1', port: 3001, publicUrl: `${canonicalOrigin}/` }));

      expect(issued.baseUrl).toBe(`${canonicalOrigin}/v1`);
      expect(issued.audience).toBe(canonicalOrigin);
      expect(issued.issuer).toBe(canonicalOrigin);

      const stream = await fakeClient(issued).chat.completions.create({
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      });
      let text = '';
      let sawStop = false;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        text += choice?.delta?.content ?? '';
        if (choice?.finish_reason === 'stop') {
          sawStop = true;
        }
      }
      expect(text).toBe('ok');
      expect(sawStop).toBe(true);
      expect(served).toEqual([{ url: '/v1/chat/completions', streaming: true }]);

      expect(await authenticateConsumer(issued)).toBe(true);
    } finally {
      await issued?.container.dispose();
      await unregister();
      if (server) {
        await closeServer(server);
      }
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('keeps the issued key canonical while a bound local listener and gateway port serve only the runtime wire target', async () => {
    const served: Served[] = [];
    const server = await startModelServer(served, 0);
    const listenerPort = (server.address() as AddressInfo).port;
    const canonicalPort = await reserveClosedPort();
    const canonicalOrigin = `http://127.0.0.1:${canonicalPort}`;
    process.env.XPOD_MAIN_PORT = '34567';
    let issued: Issued | undefined;
    try {
      issued = await issueForLocal(baseConfig({ host: '0.0.0.0', port: listenerPort, publicUrl: `${canonicalOrigin}/` }));

      expect(issued.baseUrl).toBe(`${canonicalOrigin}/v1`);
      expect(issued.audience).toBe(canonicalOrigin);
      expect(issued.issuer).toBe(canonicalOrigin);

      expect(await authenticateConsumer(issued)).toBe(true);
      expect(served).toEqual([]);
    } finally {
      await issued?.container.dispose();
      await closeServer(server);
    }
  });

  it('keeps the canonical public transport for cloud edition', async () => {
    const issued = await issueForLocal(baseConfig({
      edition: 'cloud',
      host: '0.0.0.0',
      port: 3001,
      publicUrl: 'https://node.example/',
    }));
    try {
      expect(issued.baseUrl).toBe('https://node.example/v1');
      expect(issued.audience).toBe('https://node.example');
      expect(issued.issuer).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });

  it.each([
    { name: 'unresolved port 0', host: '0.0.0.0', port: 0 },
    { name: 'out-of-range port', host: '0.0.0.0', port: 70_000 },
    { name: 'empty host', host: '', port: 3001 },
  ])('keeps the canonical realm despite $name', async ({ host, port }) => {
    const issued = await issueForLocal(baseConfig({ host, port, publicUrl: 'https://node.example/' }));
    try {
      expect(issued.baseUrl).toBe('https://node.example/v1');
      expect(issued.audience).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });

  it('keeps the canonical realm over a configured socket transport', async () => {
    const issued = await issueForLocal(baseConfig({
      host: '0.0.0.0',
      port: 3001,
      socketPath: '/tmp/xpod-api-transport-test.sock',
      publicUrl: 'https://node.example/',
    }));
    try {
      expect(issued.baseUrl).toBe('https://node.example/v1');
      expect(issued.audience).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });

  it('keeps the canonical realm for an IPv6 wildcard host', async () => {
    process.env.CSS_BASE_URL = 'https://node.example/';
    const issued = await issueForLocal(baseConfig({ host: '::', port: 65_530 }));
    try {
      expect(issued.baseUrl).toBe('https://node.example/v1');
      expect(issued.audience).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });
});
