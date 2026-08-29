import { describe, expect, test } from 'vitest';
import {
  shouldProxyXpodCanonicalRouteRequest,
  xpodGatewayProxy,
} from './vite.config';
import { existsSync } from 'node:fs';
import viteConfig from './vite.config';

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
  test('proxies only SDK canonical route requests through the catch-all route', () => {
    const proxy = xpodGatewayProxy('http://127.0.0.1:16310');
    expect(Object.keys(proxy)).toContain('^/.*');
    expect(proxy['^/.*'].xfwd).toBe(true);
    expect(proxy['/api'].xfwd).toBe(true);
    expect(proxy['/v1'].xfwd).toBe(true);

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
