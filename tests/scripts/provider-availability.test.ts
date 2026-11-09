import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  CHAT_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  MAX_CHAT_RESPONSE_BYTES,
  MAX_MODELS_RESPONSE_BYTES,
  NETWORK_DEADLINE_MS,
  catalogBaseUrl,
  credentialFieldsFromEnvironment,
  parseCredentialText,
  runMonitor,
  validateSecureBaseUrl,
  type FetchLike,
} from '../../scripts/check-provider-availability';

interface Fixture {
  baseUrl: string;
  fetchImpl: FetchLike;
  hits: string[];
  close(): Promise<void>;
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;

/**
 * A local HTTP fixture that is addressed through an HTTPS-shaped test origin.
 * It exists only to exercise the monitor protocol and error classification; it
 * is not a provider, an Xpod deployment or product/RC evidence.
 */
async function fixture(handler: Handler): Promise<Fixture> {
  const hits: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    hits.push(`${request.method ?? ''} ${request.url ?? ''}`);
    await handler(request, response, Buffer.concat(chunks).toString('utf8'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  return {
    baseUrl: 'https://upstream.test/v1',
    fetchImpl,
    hits,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function completion(content: string, finishReason: string = 'stop'): unknown {
  return {
    choices: [{ message: { content, reasoning_content: 'hidden reasoning' }, finish_reason: finishReason }],
  };
}

function nonceFrom(requestBody: string): string {
  const body = JSON.parse(requestBody) as { messages?: Array<{ content?: unknown }> };
  const content = body.messages?.[0]?.content;
  return typeof content === 'string' ? content.replace(/^Reply with exactly: /u, '') : '';
}

const credentialFor = (baseUrl: string, extra = ''): string =>
  `provider=deepseek\napiKey=sk-test-not-a-secret\nbaseUrl=${baseUrl}\n${extra}`;

describe('provider availability input boundary', () => {
  it('parses the existing canary key=value format and ignores comments', () => {
    expect(parseCredentialText(
      '# comment\nprovider=deepseek\napiKey=test\nbaseUrl=https://api.deepseek.com/v1\n',
    )).toEqual({
      provider: 'deepseek',
      apiKey: 'test',
      baseUrl: 'https://api.deepseek.com/v1',
      expectedModels: undefined,
    });
    expect(parseCredentialText('provider=deepseek\napiKey=test\nexpectedModels=a, b\n').expectedModels)
      .toEqual(['a', 'b']);
  });

  it('maps the agreed TIMICC variables only at the input boundary', () => {
    expect(credentialFieldsFromEnvironment({ TIMICC_BASE_URL: 'https://timicc.example/v1', TIMICC_API_KEY: 'k' }))
      .toEqual({ baseUrl: 'https://timicc.example/v1', apiKey: 'k' });
    expect(credentialFieldsFromEnvironment({})).toEqual({});
  });

  it('derives a base URL from the shared catalog instead of a second provider map', () => {
    expect(catalogBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
    expect(catalogBaseUrl('not-a-provider')).toBeUndefined();
    // The catalog's custom placeholder is not a real upstream.
    expect(validateSecureBaseUrl(catalogBaseUrl('custom') ?? '').ok).toBe(false);
  });

  it('accepts only a credential-free HTTPS base URL', () => {
    expect(validateSecureBaseUrl('https://api.example/v1').ok).toBe(true);
    for (const rejected of [
      'http://api.example/v1',
      'https://user:pass@api.example/v1',
      'https://api.example/v1?target=other',
      'https://api.example/v1#fragment',
      'https://example.invalid/v1',
      'not-a-url',
    ]) {
      expect(validateSecureBaseUrl(rejected).ok, rejected).toBe(false);
    }
  });

  it('reports a missing credential as unconfigured, never as a pass', async () => {
    const result = await runMonitor({ fileContents: '', environment: {} });
    expect(result).toMatchObject({
      configured: false,
      status: 'unconfigured',
      phase: 'credential',
      httpStatus: null,
      success: false,
      category: 'missing-credential',
    });
    expect(JSON.stringify(result)).not.toContain('sk-');
  });

  it('reports a credential file read failure without inventing a configuration', async () => {
    const result = await runMonitor({ fileReadError: true });
    expect(result).toMatchObject({ configured: false, status: 'unconfigured', category: 'credential-read-error' });
  });
});

describe('provider availability upstream protocol', () => {
  it('discovers models and validates one real exact-marker Chat completion', async () => {
    let chatCalls = 0;
    const server = await fixture(async (request, response, body) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'expensive-model' }, { id: 'cheap-model' }] });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        chatCalls += 1;
        expect(request.headers.authorization).toBe('Bearer sk-test-not-a-secret');
        expect(request.headers['content-type']).toBe('application/json');
        json(response, 200, completion(nonceFrom(body)));
        return;
      }
      json(response, 500, { error: 'unexpected route' });
    });
    try {
      const result = await runMonitor({
        fileContents: credentialFor(server.baseUrl),
        fetchImpl: server.fetchImpl,
      });
      expect(result).toMatchObject({
        configured: true,
        status: 'passed',
        phase: 'complete',
        httpStatus: 200,
        modelCount: 2,
        deadlineMs: NETWORK_DEADLINE_MS,
        success: true,
        category: 'ok',
      });
      expect(result.modelIdHash).toMatch(/^[0-9a-f]{16}$/u);
      expect(NETWORK_DEADLINE_MS).toBe(DISCOVERY_DEADLINE_MS + CHAT_DEADLINE_MS);
      expect(CHAT_DEADLINE_MS).toBe(90_000);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(server.hits).toEqual(['GET /v1/models', 'POST /v1/chat/completions']);
      expect(chatCalls).toBe(1);
      // The report is an allowlist; no body, reasoning, header, key or raw id leaks.
      const serialized = JSON.stringify(result);
      for (const forbidden of ['hidden reasoning', 'sk-test-not-a-secret', 'Authorization', 'Reply with exactly', 'expensive-model', 'cheap-model']) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await server.close();
    }
  });

  it('uses an expected discovered model when available, otherwise the first discovered id', async () => {
    const seen: string[] = [];
    const server = await fixture((request, response, body) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'first' }, { id: 'preferred' }] });
        return;
      }
      seen.push((JSON.parse(body) as { model: string }).model);
      json(response, 200, completion(nonceFrom(body)));
    });
    try {
      const preferred = await runMonitor({
        fileContents: credentialFor(server.baseUrl, 'expectedModels=missing,preferred\n'),
        fetchImpl: server.fetchImpl,
      });
      expect(preferred.status).toBe('passed');
      const fallback = await runMonitor({
        fileContents: credentialFor(server.baseUrl),
        fetchImpl: server.fetchImpl,
      });
      expect(fallback.status).toBe('passed');
      // The raw id is used only on the wire, never in the public report.
      expect(seen).toEqual(['preferred', 'first']);
      expect(JSON.stringify([preferred, fallback])).not.toContain('preferred');
    } finally {
      await server.close();
    }
  });

  it.each([401, 404, 429, 500])('treats GET /models HTTP %i as a monitor failure', async (status) => {
    const server = await fixture((_request, response) => {
      json(response, status, { error: { message: 'upstream detail must not be reported' } });
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({
        configured: true,
        status: 'failed',
        phase: 'models',
        httpStatus: status,
        success: false,
        category: 'http-error',
      });
      expect(JSON.stringify(result)).not.toContain('upstream detail');
      expect(server.hits).toEqual(['GET /v1/models']);
    } finally {
      await server.close();
    }
  });

  it.each([402, 429, 500])('treats Chat HTTP %i as a monitor failure without retry', async (status) => {
    let chatCalls = 0;
    const server = await fixture((request, response) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'model' }] });
        return;
      }
      chatCalls += 1;
      json(response, status, { error: { message: 'billing detail must not be reported' } });
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({
        configured: true,
        status: 'failed',
        phase: 'chat',
        httpStatus: status,
        modelCount: 1,
        success: false,
        category: 'http-error',
      });
      expect(JSON.stringify(result)).not.toContain('billing detail');
      expect(chatCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('rejects a successful Chat response that differs from the exact nonce', async () => {
    const server = await fixture((request, response, body) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'model' }] });
        return;
      }
      // Reasoning text and a partial marker are not the answer.
      json(response, 200, {
        choices: [{
          message: { content: `${nonceFrom(body)} extra`, reasoning_content: nonceFrom(body) },
          finish_reason: 'stop',
        }],
      });
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'chat', httpStatus: 200, category: 'completion-mismatch' });
      expect(JSON.stringify(result)).not.toContain('extra');
    } finally {
      await server.close();
    }
  });

  it('rejects a truncated completion even when the content matches', async () => {
    const server = await fixture((request, response, body) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'model' }] });
        return;
      }
      json(response, 200, completion(nonceFrom(body), 'length'));
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'chat', category: 'completion-mismatch' });
    } finally {
      await server.close();
    }
  });

  it('treats an empty model list as a failure rather than a pass', async () => {
    const server = await fixture((_request, response) => json(response, 200, { data: [] }));
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'models', httpStatus: 200, category: 'no-models', modelCount: 0 });
      expect(result.modelIdHash).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('bounds the models response body without logging it', async () => {
    const server = await fixture((_request, response) => {
      const payload = JSON.stringify({ data: [], padding: 'x'.repeat(MAX_MODELS_RESPONSE_BYTES) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(payload);
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'models', category: 'response-too-large' });
      expect(JSON.stringify(result).length).toBeLessThan(1000);
    } finally {
      await server.close();
    }
  });

  it('bounds the Chat response body', async () => {
    const server = await fixture((request, response) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'model' }] });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('x'.repeat(MAX_CHAT_RESPONSE_BYTES + 100));
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'chat', category: 'response-too-large' });
    } finally {
      await server.close();
    }
  });

  it('refuses redirects instead of forwarding the key to another origin', async () => {
    let leaked = false;
    const server = await fixture((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(302, { location: '/elsewhere' });
        response.end();
        return;
      }
      leaked = true;
      json(response, 200, { data: [] });
    });
    try {
      const result = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(result).toMatchObject({ status: 'failed', phase: 'models', category: 'network-error' });
      expect(leaked).toBe(false);
      expect(server.hits).toEqual(['GET /v1/models']);
    } finally {
      await server.close();
    }
  });

  it('does not retry a network failure', async () => {
    let calls = 0;
    const result = await runMonitor({
      fileContents: credentialFor('https://upstream.test/v1'),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('connection refused with a secret-looking detail');
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'failed', phase: 'models', category: 'network-error' });
    expect(JSON.stringify(result)).not.toContain('secret-looking');
  });

  it('treats malformed JSON and a non-object body as invalid responses', async () => {
    let mode: 'text' | 'array' = 'text';
    const server = await fixture((_request, response) => {
      if (mode === 'array') {
        json(response, 200, [{ id: 'model' }]);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json');
    });
    try {
      const text = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(text.category).toBe('invalid-response');
      mode = 'array';
      const array = await runMonitor({ fileContents: credentialFor(server.baseUrl), fetchImpl: server.fetchImpl });
      expect(array.category).toBe('invalid-response');
    } finally {
      await server.close();
    }
  });

  it('accepts the user TIMICC file keys at the same input boundary as the environment adapter', async () => {
    const server = await fixture((request, response, body) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'file-model' }] });
        return;
      }
      expect(request.headers.authorization).toBe('Bearer timicc-file-key');
      json(response, 200, completion(nonceFrom(body)));
    });
    try {
      // The exact contents of a user-supplied file, no process env involved.
      const result = await runMonitor({
        fileContents: `TIMICC_BASE_URL=${server.baseUrl}\nTIMICC_API_KEY=timicc-file-key\n`,
        environment: {},
        fetchImpl: server.fetchImpl,
      });
      expect(result).toMatchObject({ configured: true, status: 'passed', phase: 'complete' });
      expect(JSON.stringify(result)).not.toContain('timicc-file-key');
      expect(parseCredentialText(`TIMICC_BASE_URL=${server.baseUrl}\nTIMICC_API_KEY=k\n`))
        .toEqual({ baseUrl: server.baseUrl, apiKey: 'k', provider: undefined, expectedModels: undefined });
    } finally {
      await server.close();
    }
  });

  it('never publishes an upstream model id that echoes the configured key', async () => {
    const secret = 'sk-echoed-in-model-id-0123456789';
    const server = await fixture((request, response) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: secret }, { id: `prefix-${secret}` }] });
        return;
      }
      // Make Chat fail too: the failure report still must not carry the id.
      json(response, 402, { error: { message: secret } });
    });
    try {
      const result = await runMonitor({
        fileContents: `provider=custom\napiKey=${secret}\nbaseUrl=${server.baseUrl}\n`,
        fetchImpl: server.fetchImpl,
      });
      expect(result).toMatchObject({ status: 'failed', phase: 'chat', httpStatus: 402, modelCount: 2 });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('prefix-');
      expect(serialized).not.toContain('modelIds');
    } finally {
      await server.close();
    }
  });

  it('classifies a deadline expiry as a network failure with the documented bound', async () => {
    const result = await runMonitor({
      fileContents: credentialFor('https://upstream.test/v1'),
      deadlines: { discoveryMs: 5, chatMs: 5, totalMs: 10 },
      fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by deadline')));
      }),
    });
    expect(result).toMatchObject({
      status: 'failed',
      phase: 'models',
      category: 'network-error',
      // The public report always names the production bound; test overrides
      // only shorten the fixture's wait.
      deadlineMs: NETWORK_DEADLINE_MS,
      success: false,
    });
    expect(NETWORK_DEADLINE_MS).toBe(110_000);
  });

  it('uses TIMICC input when no credential file exists and fills only fields the file left empty', async () => {
    const server = await fixture((request, response, body) => {
      if (request.url === '/v1/models') {
        json(response, 200, { data: [{ id: 'model' }] });
        return;
      }
      json(response, 200, completion(nonceFrom(body)));
    });
    try {
      const result = await runMonitor({
        environment: { TIMICC_BASE_URL: server.baseUrl, TIMICC_API_KEY: 'timicc-key' },
        fetchImpl: server.fetchImpl,
      });
      expect(result.status).toBe('passed');

      // A file with provider/expectedModels but an empty key still gets the key
      // and endpoint from the TIMICC boundary adapter, and the catalog supplies
      // the endpoint for the named provider when TIMICC_BASE_URL is absent.
      const filled = await runMonitor({
        fileContents: 'provider=deepseek\napiKey=\nexpectedModels=cheap-model\n',
        environment: { TIMICC_API_KEY: 'timicc-key' },
        fetchImpl: async (input) => {
          expect(String(input)).toBe('https://api.deepseek.com/v1/models');
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      });
      expect(filled).toMatchObject({ status: 'failed', phase: 'models', httpStatus: 200, category: 'no-models' });

      const catalog = await runMonitor({
        environment: { TIMICC_API_KEY: 'timicc-key' },
        fetchImpl: async () => {
          throw new Error('catalog endpoint is not contacted in this assertion');
        },
      });
      // No TIMICC base URL means no endpoint; only an explicit provider name
      // derives one from the shared catalog.
      expect(catalog).toMatchObject({ status: 'failed', phase: 'credential', category: 'missing-base-url' });
    } finally {
      await server.close();
    }
  });
});

describe('provider availability workflow isolation', () => {
  it('is staging-only, manually dispatchable, serialized and independent of candidate gates', async () => {
    const source = await readFile(
      path.resolve('.github/workflows/provider-availability.yml'),
      'utf8',
    );
    const document = parseDocument(source);
    expect(document.errors).toEqual([]);
    const workflow = document.toJS() as Record<string, any>;
    expect(workflow.on.schedule).toBeUndefined();
    expect(workflow.on.push.branches).toEqual(['staging']);
    expect(workflow.on.push.paths).toContain('scripts/check-provider-availability.ts');
    expect(workflow.on.push.paths).toContain('packages/ai-connections-runtime/src/contract/provider-catalog.ts');
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.concurrency).toMatchObject({ group: 'xpod-provider-availability', 'cancel-in-progress': false });
    const job = workflow.jobs['provider-availability'];
    expect(job.needs).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.environment).toBe('rc');
    expect(job.steps.some((step: any) => step.uses === 'actions/upload-artifact@v4')).toBe(true);
    expect(source).toContain('XPOD_LIVE_PROVIDER_API_KEY_CONFIG');
    expect(source).toContain('refs/heads/staging');
    expect(source).not.toContain('schedule:');
  });
});
