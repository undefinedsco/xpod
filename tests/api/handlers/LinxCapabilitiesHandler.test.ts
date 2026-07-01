import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../../../src/api/ApiServer';
import { registerLinxCapabilitiesRoutes } from '../../../src/api/handlers/LinxCapabilitiesHandler';

describe('LinxCapabilitiesHandler', () => {
  let routes: Record<string, Function>;
  let server: ApiServer;

  beforeEach(() => {
    routes = {};
    server = {
      get: vi.fn((path, handler, options) => {
        routes[`GET ${path}`] = handler;
        routes[`GET ${path} options`] = options as any;
      }),
    } as unknown as ApiServer;
    registerLinxCapabilitiesRoutes(server);
  });

  it('does not advertise standalone agent authorization because ChatKit sessions carry workspace authority', async () => {
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    await routes['GET /api/linx/capabilities']({}, response, {});

    expect(routes['GET /api/linx/capabilities options']).toEqual({ public: true });
    const body = JSON.parse((response.end as any).mock.calls[0][0]);
    expect(body).toEqual(expect.objectContaining({
      contract: 'linx-local-onboarding/v1',
    }));
    expect(body.agentAuth).toBeUndefined();
  });
});
