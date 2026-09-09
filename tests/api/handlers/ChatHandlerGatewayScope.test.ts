import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { registerChatRoutes } from '../../../src/api/handlers/ChatHandler';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(scopes: string[], body?: unknown): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.headers = {};
  req.auth = {
    type: 'solid',
    webId: 'https://id.example/alice/profile/card#me',
    internalInvocation: true,
    scopes,
  } as any;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return Object.assign(new EventEmitter(), {
    statusCode: 0,
    destroyed: false,
    writableEnded: false,
    setHeader: vi.fn(),
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
      this.writableEnded = true;
    }),
  });
}

describe('ChatHandler invocation-token scopes', () => {
  it('requires inference:write for inference endpoints', async () => {
    const aiGatewayService = {
      complete: vi.fn(async() => {
        throw new GatewayProtocolError('Missing required scope: inference:write', {
          code: 'invalid_request',
          status: 403,
          details: { scope: 'inference:write' },
        });
      }),
      execute: vi.fn(),
      listModels: vi.fn(),
    };
    const { server, routes } = createServer();
    registerChatRoutes(server, { aiGatewayService: aiGatewayService as any });
    const res = response();

    await routes['POST /v1/chat/completions'](request(['models:read'], {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    }), res, {});

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({
      code: 'invalid_request',
      message: 'Missing required scope: inference:write',
    });
    expect(aiGatewayService.complete).toHaveBeenCalledOnce();
  });

  it('requires models:read for model listing', async () => {
    const aiGatewayService = {
      complete: vi.fn(),
      execute: vi.fn(),
      listModels: vi.fn(async() => {
        throw new GatewayProtocolError('Missing required scope: models:read', {
          code: 'invalid_request',
          status: 403,
          details: { scope: 'models:read' },
        });
      }),
    };
    const { server, routes } = createServer();
    registerChatRoutes(server, { aiGatewayService: aiGatewayService as any });
    const res = response();

    await routes['GET /v1/models'](request(['inference:write']), res, {});

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({
      code: 'invalid_request',
      message: 'Missing required scope: models:read',
    });
    expect(aiGatewayService.listModels).toHaveBeenCalledOnce();
  });
});
