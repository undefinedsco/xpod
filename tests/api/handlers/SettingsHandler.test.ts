import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import { registerSettingsRoutes } from '../../../src/api/handlers/SettingsHandler';

describe('registerSettingsRoutes', () => {
  it('registers public Settings, AI Connections, and AI Config SPA surfaces', () => {
    const server = {
      get: vi.fn(),
      route: vi.fn(),
    } as unknown as ApiServer;

    registerSettingsRoutes(server, { staticDir: path.resolve('static/settings') });

    expect(server.get).toHaveBeenCalledWith('/settings', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/settings/', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/settings/*path', expect.any(Function), { public: true });
    expect(server.route).toHaveBeenCalledWith('HEAD', '/settings/*path', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/ai-connections', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/ai-connections/*path', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/ai-config', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/ai-config/*path', expect.any(Function), { public: true });
  });

  it('keeps first-class AI entry paths canonical while serving the Settings SPA', async () => {
    const routes = new Map<string, RouteHandler>();
    const server = {
      get: vi.fn((route: string, handler: RouteHandler) => routes.set(`GET ${route}`, handler)),
      route: vi.fn((method: string, route: string, handler: RouteHandler) => routes.set(`${method} ${route}`, handler)),
    } as unknown as ApiServer;

    registerSettingsRoutes(server, { staticDir: path.resolve('static/settings') });

    for (const prefix of ['/ai-config', '/ai-connections'] as const) {
      const response = createResponse();
      await routes.get(`GET ${prefix}`)?.({ url: `${prefix}?provider=kimi` } as never, response as never, {});
      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['content-type']).toBe('text/html');

      const deepResponse = createResponse();
      await routes.get(`GET ${prefix}/*path`)?.(
        { url: `${prefix}/model-assignments?surface=providers` } as never,
        deepResponse as never,
        { path: 'model-assignments' },
      );
      expect(deepResponse.statusCode).toBe(200);
      expect(deepResponse.headers.location).toBeUndefined();
      expect(deepResponse.headers['content-type']).toBe('text/html');
    }
  });
});

function createResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(),
  };
}
