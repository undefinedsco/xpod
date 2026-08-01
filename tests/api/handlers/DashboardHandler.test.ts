import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import { registerDashboardRoutes } from '../../../src/api/handlers/DashboardHandler';

describe('registerDashboardRoutes legacy product redirects', () => {
  it('redirects moved configuration routes and preserves query parameters', async () => {
    const routes = new Map<string, RouteHandler>();
    const server = {
      get: vi.fn((route: string, handler: RouteHandler) => routes.set(`GET ${route}`, handler)),
      route: vi.fn(),
    } as unknown as ApiServer;
    registerDashboardRoutes(server, { staticDir: path.resolve('static/dashboard') });
    const handler = routes.get('GET /dashboard/models');
    expect(handler).toBeTypeOf('function');

    const response = createResponse();
    await handler?.({ url: '/dashboard/models?provider=kimi' } as never, response as never, {});

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/settings/models?provider=kimi');

    const servicesResponse = createResponse();
    await routes.get('GET /dashboard/services')?.({ url: '/dashboard/services' } as never, servicesResponse as never, {});
    expect(servicesResponse.headers.location).toBe('/settings/services');
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
