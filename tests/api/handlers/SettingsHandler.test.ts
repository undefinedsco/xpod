import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ApiServer } from '../../../src/api/ApiServer';
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
});
