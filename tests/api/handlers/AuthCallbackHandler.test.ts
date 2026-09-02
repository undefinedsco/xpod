import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiServer } from '../../../src/api/ApiServer';
import { registerAuthCallbackRoutes } from '../../../src/api/handlers/AuthCallbackHandler';
import type { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';

describe('AuthCallbackHandler', () => {
  let server: ApiServer;
  let staticDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'xpod-auth-callback-'));
    await mkdir(path.join(staticDir, 'assets'));
    await writeFile(path.join(staticDir, 'auth-callback.html'), '<html>callback entry</html>');
    await writeFile(path.join(staticDir, 'theme-init.js'), 'document.documentElement.dataset.theme = "dark";');
    await writeFile(path.join(staticDir, 'assets', 'callback.js'), 'export const callback = true;');

    server = new ApiServer({
      port: 0,
      host: '127.0.0.1',
      authMiddleware: { process: async () => true } as unknown as AuthMiddleware,
    });
    registerAuthCallbackRoutes(server, { staticDir });
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await rm(staticDir, { recursive: true, force: true });
  });

  it('serves the exact callback entry while retaining a query-bearing OIDC request', async () => {
    const response = await fetch(`${baseUrl}/auth/callback?transaction=tx-123&code=code-456&state=state-789`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('callback entry');
  });

  it('serves only scoped callback assets and supports HEAD without a body', async () => {
    const asset = await fetch(`${baseUrl}/auth/callback/assets/callback.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('application/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const head = await fetch(`${baseUrl}/auth/callback?transaction=tx-123`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-cache');
    expect(await head.text()).toBe('');

    expect((await fetch(`${baseUrl}/auth/callback/`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/auth/callback/../auth-callback.html`, { redirect: 'manual' })).status).toBe(404);
  });

  it('serves the callback prepaint theme bootstrap from its stable URL', async () => {
    const response = await fetch(`${baseUrl}/auth/callback/theme-init.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('dataset.theme');
  });
});
