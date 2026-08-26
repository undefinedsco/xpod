import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiServer } from '../../../src/api/ApiServer';
import { registerStaticSpaRoutes } from '../../../src/api/handlers/StaticSpaHandler';

describe('registerStaticSpaRoutes', () => {
  let server: ApiServer;
  let staticDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), 'xpod-static-spa-'));
    await mkdir(path.join(staticDir, 'assets'));
    await writeFile(path.join(staticDir, 'settings.html'), '<html>settings product</html>');
    await writeFile(path.join(staticDir, 'assets', 'main.js'), 'export const ready = true;');

    server = new ApiServer({
      port: 0,
      host: '127.0.0.1',
      authMiddleware: { process: async () => true } as any,
    });
    registerStaticSpaRoutes(server, {
      prefix: '/settings',
      staticDir,
      entryFiles: ['settings.html'],
      label: 'Settings',
    });
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await rm(staticDir, { recursive: true, force: true });
  });

  it('redirects the bare product path to its trailing-slash root', async () => {
    const response = await fetch(`${baseUrl}/settings`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/settings/');
  });

  it('serves the entry document as the SPA fallback without caching it', async () => {
    const response = await fetch(`${baseUrl}/settings/models`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('settings product');
  });

  it('serves immutable assets with their media type', async () => {
    const response = await fetch(`${baseUrl}/settings/assets/main.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
  });

  it('supports HEAD without returning the file body', async () => {
    const response = await fetch(`${baseUrl}/settings/models`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});
