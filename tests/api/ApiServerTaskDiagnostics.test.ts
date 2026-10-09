import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseLogger, resetInternalLoggerFactory, setGlobalLoggerFactory, type Logger, type LogLevel } from 'global-logger-factory';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';
import type { RuntimeHost } from '../../src/runtime/host/types';

const SESSION = 'xpod-controlled-thread-session';
const HASH = createHash('sha256').update(SESSION).digest('hex');
const EVENT = 'xpod.task-gateway-http-diagnostic';
const ROUTES = [
  ['/v1/chat/completions', 'chat_completions'],
  ['/v1/responses', 'responses'],
  ['/v1/messages', 'anthropic_messages'],
] as const;

describe('ApiServer Task HTTP diagnostics', () => {
  const servers: ApiServer[] = [];
  const sockets: Socket[] = [];
  let lines: string[];
  let rejectDiagnosticLog = false;

  class CapturingLogger extends BaseLogger {
    public override log(level: LogLevel, message: string): Logger {
      if (level === 'error' && message.startsWith('{') && message.includes(EVENT)) {
        if (rejectDiagnosticLog) throw new Error('controlled sink failure');
        lines.push(message);
      }
      return this;
    }
  }

  beforeEach(() => {
    lines = [];
    rejectDiagnosticLog = false;
    setGlobalLoggerFactory({ createLogger: () => new CapturingLogger() });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await server.stop();
    resetInternalLoggerFactory();
  });

  function createServer(runtimeHost?: RuntimeHost): ApiServer {
    const server = new ApiServer({ port: 0, host: '127.0.0.1', runtimeHost,
      authMiddleware: new AuthMiddleware({ authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({ success: false, category: 'forbidden', statusCode: 403,
          error: 'controlled private authorization prose' }),
      } }),
    });
    servers.push(server);
    return server;
  }

  async function controlledResponse(options: {
    path?: string; method?: string; session?: string | string[];
  } = {}): Promise<ServerResponse> {
    const runtimeHost = new NodeRuntimeHost();
    vi.spyOn(runtimeHost, 'listen').mockResolvedValue(undefined);
    vi.spyOn(runtimeHost, 'close').mockResolvedValue(undefined);
    const server = createServer(runtimeHost);
    const path = options.path ?? '/v1/chat/completions';
    const method = options.method ?? 'POST';
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    server.route(method, path.split('?')[0], async () => { entered(); }, { public: true });
    await server.start();
    const socket = new Socket();
    sockets.push(socket);
    const request = new IncomingMessage(socket);
    request.method = method;
    request.url = path;
    request.headers = { host: 'localhost', ...(options.session === undefined ? {} : {
      'x-opencode-session': options.session,
    }) };
    const response = new ServerResponse(request);
    server.getHttpServer()!.emit('request', request, response);
    await ready;
    return response;
  }

  function expectReceipt(status: number, route: string, statusSource = 'response_finished'): void {
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: EVENT, schemaVersion: 1, scope: 'session',
      correlationHash: HASH, route, callerHTTPstatus: status, statusSource,
      durationMs: expect.any(Number) });
    const receipt = JSON.parse(lines[0]);
    expect(Number.isSafeInteger(receipt.durationMs)).toBe(true);
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
    expect(receipt.durationMs).toBeLessThanOrEqual(2147483647);
    expect(lines[0]).not.toContain(SESSION);
    expect(lines[0]).not.toContain('controlled private');
  }

  // The server tracks every response for graceful drain with exactly one 'responseDone'
  // listener per event. Task diagnostics must add nothing on top of that, so assertions
  // filter the server's own listener instead of counting every listener on the response.
  function diagnosticListeners(response: ServerResponse, event: 'finish' | 'close'): Array<(...args: unknown[]) => void> {
    return response.listeners(event).filter(
      (listener): listener is (...args: unknown[]) => void => listener.name !== 'responseDone',
    );
  }

  it.each(ROUTES)('observes actual 401 before the %s handler runs', async (path, route) => {
    const server = createServer();
    const handler = vi.fn(async () => {});
    server.post(path, handler);
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { 'x-opencode-session': SESSION, Connection: 'close' },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expectReceipt(401, route);
  });

  it('observes actual 403 and isolates a failing diagnostic sink from authentication', async () => {
    const server = createServer();
    const handler = vi.fn(async () => {});
    server.post('/v1/chat/completions', handler);
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener');
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const headers = { 'x-opencode-session': SESSION, Authorization: 'Bearer controlled-fixture-only', Connection: 'close' };
    const response = await fetch(url, { method: 'POST', headers });
    await response.arrayBuffer();
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expectReceipt(403, 'chat_completions');
    rejectDiagnosticLog = true;
    const second = await fetch(url, { method: 'POST', headers });
    await second.arrayBuffer();
    expect(second.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves successful Task HTTP and ordinary unauthenticated Chat without receipts', async () => {
    const server = createServer();
    server.post('/v1/responses', async (_request, response) => { response.end('ok'); }, { public: true });
    server.post('/v1/chat/completions', async () => { throw new Error('Must not reach handler'); });
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const success = await fetch(`${origin}/v1/responses`, {
      method: 'POST', headers: { 'x-opencode-session': SESSION, Connection: 'close' },
    });
    await success.arrayBuffer();
    expect(success.status).toBe(200);
    const ordinary = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { Connection: 'close' } });
    await ordinary.arrayBuffer();
    expect(ordinary.status).toBe(401);
    expect(lines).toEqual([]);
  });

  it('does not report an unsent early close and removes both listeners', async () => {
    const response = await controlledResponse({ session: SESSION });
    response.statusCode = 500;
    expect(response.headersSent).toBe(false);
    response.emit('close');
    response.emit('finish');
    expect(lines).toEqual([]);
    expect(diagnosticListeners(response, 'finish')).toEqual([]);
    expect(diagnosticListeners(response, 'close')).toEqual([]);
  });

  it('reports sent failure headers on close once and cleans listeners', async () => {
    const response = await controlledResponse({ session: SESSION });
    response.writeHead(403);
    expect(response.headersSent).toBe(true);
    response.emit('close');
    response.emit('finish');
    expectReceipt(403, 'chat_completions', 'response_closed');
    expect(diagnosticListeners(response, 'finish')).toEqual([]);
    expect(diagnosticListeners(response, 'close')).toEqual([]);
  });

  it('reports finish once despite duplicate finish/close, without URL/query prose', async () => {
    const response = await controlledResponse({ session: SESSION, path: '/v1/responses?private=controlled-private-prose' });
    response.statusCode = 502;
    response.emit('finish');
    response.emit('finish');
    response.emit('close');
    expectReceipt(502, 'responses');
    expect(lines[0]).not.toContain('private');
    expect(diagnosticListeners(response, 'finish')).toEqual([]);
    expect(diagnosticListeners(response, 'close')).toEqual([]);
  });

  it.each([200, 204, 399, 600, NaN])('does not report non-failure or invalid status %s', async status => {
    const response = await controlledResponse({ session: SESSION });
    response.statusCode = status;
    response.emit('finish');
    expect(lines).toEqual([]);
    expect(diagnosticListeners(response, 'close')).toEqual([]);
  });

  it.each([undefined, '', 'private text with spaces', 'a'.repeat(257), ['xpod-a', 'xpod-b'], 'xpod-a,xpod-b']
    .map(session => ({ session })))('does not observe missing or malformed session %j', async ({ session }) => {
      const response = await controlledResponse({ session });
      expect(diagnosticListeners(response, 'finish')).toEqual([]);
      expect(diagnosticListeners(response, 'close')).toEqual([]);
      response.statusCode = 401;
      response.emit('finish');
      expect(lines).toEqual([]);
    });

  it.each([
    { path: '/v1/models' }, { path: '/api/task' }, { path: '/v1/messages/extra' },
    { method: 'GET' }, { method: 'OPTIONS' },
  ])('does not observe unrelated routes or methods %j', async options => {
    // OPTIONS exits at the real preflight boundary before the registered handler.
    if (options.method === 'OPTIONS') {
      const server = createServer();
      await server.start();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected owned TCP listener');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'OPTIONS', headers: { 'x-opencode-session': SESSION, Connection: 'close' },
      });
      expect(response.status).toBe(204);
    } else {
      const response = await controlledResponse({ ...options, session: SESSION });
      expect(diagnosticListeners(response, 'finish')).toEqual([]);
      response.statusCode = 401;
      response.emit('finish');
    }
    expect(lines).toEqual([]);
  });
});
