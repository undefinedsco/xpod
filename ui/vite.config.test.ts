import { describe, expect, test } from 'vitest';
import {
  shouldProxyXpodCanonicalRouteRequest,
  xpodGatewayProxy,
  xpodDesktopClientDocumentPlugin,
} from './vite.config';
import { existsSync } from 'node:fs';
import viteConfig from './vite.config';
import { resolveConfig } from 'vite';
import path from 'node:path';
import desktopClient from '../src/identity/oidc/xpod-desktop-client.json';

describe('bundled desktop client document', () => {
  test('emits the same metadata used by the Provider without a second public source', () => {
    const plugin = xpodDesktopClientDocumentPlugin();
    const emitted: unknown[] = [];
    if (typeof plugin.generateBundle !== 'function') throw new Error('Expected bundle hook');
    plugin.generateBundle.call({ emitFile: (asset: unknown) => emitted.push(asset) } as any, {} as any, {}, false);
    expect(emitted).toEqual([{ type: 'asset', fileName: 'xpod-desktop-client.json',
      source: `${JSON.stringify(desktopClient, null, 2)}\n` }]);
    expect(existsSync(new URL('./public/xpod-desktop-client.json', import.meta.url))).toBe(false);
  });
});

describe('Vite Xpod Gateway proxy', () => {
  test('keeps Bun as the workspace lockfile without a separate UI Yarn lockfile', () => {
    expect(existsSync(new URL('./yarn.lock', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../bun.lock', import.meta.url))).toBe(true);
  });
  test('prebundles the CommonJS Comunica engine and serializers for browser imports', async () => {
    if (typeof viteConfig !== 'function') throw new Error('Expected Vite configuration factory');
    const config = await viteConfig({ command: 'serve', mode: 'development' });
    for (const dependency of ['@comunica/query-sparql-solid', '@comunica/actor-query-result-serialize-stats', '@comunica/actor-query-result-serialize-sparql-json']) {
      expect(config.optimizeDeps?.exclude ?? []).not.toContain(dependency);
      expect(config.optimizeDeps?.include).toContain(dependency);
    }
  });
  test('proxies the notification channel and its websocket upgrade unconditionally', () => {
    const proxy = xpodGatewayProxy('http://127.0.0.1:16310');
    const notifications = proxy['/.notifications'];
    expect(notifications).toMatchObject({
      target: 'http://127.0.0.1:16310',
      changeOrigin: true,
      xfwd: true,
      ws: true,
    });
    // `new WebSocket(url)` cannot carry the canonical route headers the
    // catch-all bypass checks, so this route must not be gated.
    expect(notifications.bypass).toBeUndefined();
    // Proxy contexts are matched in declaration order, so the channel route has
    // to sit in front of the catch-all.
    const keys = Object.keys(proxy);
    expect(keys.indexOf('/.notifications')).toBeLessThan(keys.indexOf('^/.*'));
    // Every other explicit prefix keeps the plain HTTP shape.
    for (const prefix of ['/.account', '/.well-known', '/provision', '/api', '/v1', '/service', '/status']) {
      expect(proxy[prefix].ws, prefix).toBeUndefined();
      expect(proxy[prefix].bypass, prefix).toBeUndefined();
    }
  });
  test('proxies only SDK canonical route requests through the catch-all route', () => {
    const proxy = xpodGatewayProxy('http://127.0.0.1:16310');
    expect(Object.keys(proxy)).toContain('^/.*');
    expect(proxy['^/.*'].xfwd).toBe(true);
    expect(proxy['/api'].xfwd).toBe(true);
    expect(proxy['/v1'].xfwd).toBe(true);
    // The desktop shell only attaches when `/service/status` and `/status/overview`
    // answer on its own origin, so both must stay reachable through this dev server.
    expect(proxy['/service'].xfwd).toBe(true);
    expect(proxy['/status'].xfwd).toBe(true);

    expect(shouldProxyXpodCanonicalRouteRequest({
      accept: 'text/html',
    })).toBe(false);
    expect(shouldProxyXpodCanonicalRouteRequest({
      'x-xpod-canonical-url': 'https://acceptance-local.nodes.acceptance.test/alice/settings/credentials.ttl',
      'x-xpod-local-route-url': 'http://127.0.0.1:5173/alice/settings/credentials.ttl',
    })).toBe(true);
    expect(shouldProxyXpodCanonicalRouteRequest({
      'x-xpod-canonical-url': 'not a url',
      'x-xpod-local-route-url': 'http://127.0.0.1:5173/alice/settings/credentials.ttl',
    })).toBe(false);
  });
});

describe('unified repair documents', () => {
  test('serves every document surface while preserving API requests and query strings', async () => {
    const { developmentDocumentPath } = await import('./vite.config');
    for (const [url, entry] of [
      ['/.account/login/password/', '/index.html'],
      ['/app/', '/index.html'],
      ['/settings/pod', '/settings.html'],
      ['/ai-connections', '/settings.html'],
      ['/ai-config/model-assignments', '/settings.html'],
      ['/status/overview', '/dashboard.html'],
      ['/network', '/dashboard.html'],
      ['/dashboard', '/dashboard.html'],
      ['/auth/callback', '/auth-callback.html'],
    ]) {
      expect(developmentDocumentPath(`${url}?code=one&state=two`, 'GET', 'text/html')).toBe(`${entry}?code=one&state=two`);
      expect(developmentDocumentPath(url, 'GET', 'application/json')).toBeUndefined();
      expect(developmentDocumentPath(url, 'POST', 'text/html')).toBeUndefined();
    }
  });
  test('ignores managed canonical identity when choosing transport', async () => {
    const { resolveLocalXpodGateway } = await import('./vite.config');
    expect(resolveLocalXpodGateway({ CSS_BASE_URL: 'https://managed.example/' })).toBe('http://127.0.0.1:3000');
    expect(resolveLocalXpodGateway({ XPOD_DEV_GATEWAY_URL: 'http://127.0.0.1:3030/' })).toBe('http://127.0.0.1:3030');
    expect(() => resolveLocalXpodGateway({ XPOD_DEV_GATEWAY_URL: 'ftp://example.com' })).toThrow();
  });
  test('fixes development origin without changing production base', async () => {
    if (typeof viteConfig !== 'function') throw new Error('Expected factory');
    const dev = await viteConfig({ command: 'serve', mode: 'development' });
    expect(dev.base).toBe('/');
    expect(dev.server).toMatchObject({ host: '127.0.0.1', port: 5173, strictPort: true });
    const build = await viteConfig({ command: 'build', mode: 'production' });
    expect(build.base).not.toBe('/');
  });
});


describe('workspace browser dependency resolution', () => {
  test.each(['serve', 'build'] as const)('%s resolves workspace entries without changing production exports', async (command) => {
    if (typeof viteConfig !== 'function') throw new Error('Expected Vite configuration factory');
    const config = await viteConfig({ command, mode: command === 'serve' ? 'development' : 'production' });
    const resolved = await resolveConfig({ ...config, configFile: false, root: __dirname }, command);
    const resolve = resolved.createResolver();
    const entries = {
      'extension-sdk': 'extension-sdk/index',
      'extension-sdk/testing': 'extension-sdk/testing',
      'extension-sdk/react': 'extension-sdk/react',
      'extension-sdk/web': 'extension-sdk/web',
      'extension-sdk/manifest': 'extension-sdk/manifest',
      'solid-sdk': 'solid-sdk/index',
      'solid-sdk/pod-runtime': 'solid-sdk/pod-runtime',
      'solid-sdk/react': 'solid-sdk/react',
      'solid-sdk/webid-auth': 'solid-sdk/webid-auth',
      'solid-sdk/storage-selection': 'solid-sdk/storage-selection',
      'solid-sdk/local-route-fetch': 'solid-sdk/local-route-fetch',
      'solid-sdk/session': 'solid-sdk/session',
      'solid-sdk/login-store': 'solid-sdk/login-store',
      'shared-ui': 'shared-ui/index',
      'shared-ui/theme.css': 'shared-ui/theme.css',
      'pod-collections': 'pod-collections/index',
      'pod-collections/react': 'pod-collections/react',
      'ai-connections': 'ai-connections/index',
      'ai-connections/manifest': 'ai-connections/manifest',
      // The interoperability surface moved to its own package; the product no
      // longer republishes it, so these are aliased against the core.
      'ai-connections-core': 'ai-connections-core/index',
      'ai-connections-core/client': 'ai-connections-core/ai-connections-client',
      'ai-connections-core/provider-catalog': 'ai-connections-core/provider-catalog',
      'ai-connections-core/client-config': 'ai-connections-core/client-config/index',
      'ai-connections-core/endpoint-urls': 'ai-connections-core/endpoint-urls',
    };
    for (const [specifier, entry] of Object.entries(entries)) {
      const [pkg, ...segments] = entry.split('/');
      const file = segments.join('/');
      const extension = file.endsWith('.css') ? '' : command === 'serve' ? '.ts' : '.js';
      const expected = path.resolve(__dirname, '../packages', pkg, command === 'serve' ? 'src' : 'dist', `${file}${extension}`);
      expect(await resolve(`@undefineds.co/${specifier}`, path.resolve(__dirname, 'src/main.tsx'))).toBe(expected);
      expect(existsSync(expected)).toBe(true);
    }
  });
});
