import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import { registerSettingsRoutes } from '../../../src/api/handlers/SettingsHandler';

describe('registerSettingsRoutes', () => {
  it('registers a public Settings SPA at the settings prefix', () => {
    const server = {
      get: vi.fn(),
      route: vi.fn(),
    } as unknown as ApiServer;

    registerSettingsRoutes(server, { staticDir: path.resolve('static/dashboard') });

    expect(server.get).toHaveBeenCalledWith('/settings', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/settings/', expect.any(Function), { public: true });
    expect(server.get).toHaveBeenCalledWith('/settings/*path', expect.any(Function), { public: true });
    expect(server.route).toHaveBeenCalledWith('HEAD', '/settings/*path', expect.any(Function), { public: true });
  });

  it('registers AI entry aliases with required surface precedence and preserved query parameters', async () => {
    const routes = new Map<string, RouteHandler>();
    const server = {
      get: vi.fn((route: string, handler: RouteHandler) => routes.set(`GET ${route}`, handler)),
      route: vi.fn((method: string, route: string, handler: RouteHandler) => routes.set(`${method} ${route}`, handler)),
    } as unknown as ApiServer;

    registerSettingsRoutes(server, { staticDir: path.resolve('static/dashboard') });

    for (const [alias, expected] of [
      ['/ai-config', '/settings/models?surface=ai-config&provider=kimi'],
      ['/ai-connections', '/settings/models?surface=ai-connections&provider=kimi'],
    ] as const) {
      const response = createResponse();
      await routes.get(`GET ${alias}`)?.({ url: `${alias}?provider=kimi&surface=wrong#fragment` } as never, response as never, {});
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(expected);

      const headResponse = createResponse();
      await routes.get(`HEAD ${alias}`)?.({ url: `${alias}?provider=kimi` } as never, headResponse as never, {});
      expect(headResponse.statusCode).toBe(302);
      expect(headResponse.headers.location).toBe(expected);
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
