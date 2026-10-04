import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import OpenAI from 'openai';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';

/**
 * Regression: on Local edition the server-side model call must be addressed to the bound API
 * listener, while the invocation token's canonical identity (audience/issuer) stays the public
 * origin. The model wire target and the token realm are allowed to differ.
 *
 * This drives the real container + issuer + real public OpenAI-compatible SDK against an owned
 * loopback listener; the canonical origin is a closed loopback port. No fetch/streamFn mock.
 *
 * The owned listener is a raw OpenAI-compatible fixture, NOT the production API server: this test
 * proves URL selection + SDK wiring + token realm, not end-to-end API routing.
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

/**
 * Owned OpenAI-compatible fixture. It branches on `stream` so a streaming request receives a
 * legal SSE body that ends with the terminal marker. Only the decoded body's `stream` flag is
 * retained (never the prompt, credential, or model text).
 */
async function startModelServer(served: Served[]): Promise<{ server: Server; port: number }> {
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
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('No bound port'));
      }
    });
  });
  return { server, port };
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

describe('Local AI-Connection invocation transport', () => {
  it('streams the model call to the bound API listener while the token realm stays canonical', async () => {
    const served: Served[] = [];
    let server: Server | undefined;
    let issued: Issued | undefined;
    try {
      const started = await startModelServer(served);
      server = started.server;
      const canonicalPort = await reserveClosedPort();
      const canonicalOrigin = `http://127.0.0.1:${canonicalPort}`;
      issued = await issueForLocal(baseConfig({
        host: '0.0.0.0',
        port: started.port,
        publicUrl: `${canonicalOrigin}/`,
      }));

      // Real network first: the model SDK must complete against the owned listener.
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

      // Then the target assertions.
      expect(new URL(issued.baseUrl).origin).toBe(`http://127.0.0.1:${started.port}`);
      expect(issued.audience).toBe(canonicalOrigin);
      expect(issued.issuer).toBe(canonicalOrigin);

      // The canonical-realm token is accepted by the real existing authenticator.
      const authenticator = issued.container.resolve('authenticator') as unknown as {
        authenticate: (request: unknown) => Promise<{ success: boolean }>;
      };
      const authResult = await authenticator.authenticate({
        headers: { authorization: `Bearer ${issued.apiKey}` },
        method: 'POST',
        url: '/v1/chat/completions',
      });
      expect(authResult.success).toBe(true);
    } finally {
      await issued?.container.dispose();
      if (server) {
        await closeServer(server);
      }
    }
  });

  it('without a publicUrl still targets the bound API rather than the public CSS_BASE_URL', async () => {
    const served: Served[] = [];
    let server: Server | undefined;
    let issued: Issued | undefined;
    try {
      const started = await startModelServer(served);
      server = started.server;
      const canonicalPort = await reserveClosedPort();
      process.env.CSS_BASE_URL = `http://127.0.0.1:${canonicalPort}/`;
      issued = await issueForLocal(baseConfig({ host: '0.0.0.0', port: started.port }));

      const completion = await fakeClient(issued).chat.completions.create({
        model: 'test-model',
        messages: [{ role: 'user', content: 'ping' }],
      });
      expect(completion.choices[0]?.message?.content).toBe('ok');
      expect(served).toEqual([{ url: '/v1/chat/completions', streaming: false }]);

      expect(new URL(issued.baseUrl).origin).toBe(`http://127.0.0.1:${started.port}`);
      expect(issued.audience).toBe(`http://127.0.0.1:${canonicalPort}`);
    } finally {
      await issued?.container.dispose();
      if (server) {
        await closeServer(server);
      }
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
    } finally {
      await issued.container.dispose();
    }
  });

  it.each([
    { name: 'unresolved port 0', host: '0.0.0.0', port: 0 },
    { name: 'out-of-range port', host: '0.0.0.0', port: 70_000 },
    { name: 'empty host', host: '', port: 3001 },
  ])('falls back to the canonical origin for $name', async ({ host, port }) => {
    const issued = await issueForLocal(baseConfig({ host, port, publicUrl: 'https://node.example/' }));
    try {
      expect(issued.baseUrl).toBe('https://node.example/v1');
      expect(issued.audience).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });

  it('falls back to the canonical origin over a socket transport', async () => {
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

  it('maps an IPv6 wildcard API host to bracketed loopback on the wire', async () => {
    process.env.CSS_BASE_URL = 'https://node.example/';
    const issued = await issueForLocal(baseConfig({ host: '::', port: 65_530 }));
    try {
      expect(issued.baseUrl).toBe('http://[::1]:65530/v1');
      expect(issued.audience).toBe('https://node.example');
    } finally {
      await issued.container.dispose();
    }
  });
});
