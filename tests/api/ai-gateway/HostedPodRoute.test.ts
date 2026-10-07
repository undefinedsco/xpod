import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createHostedPodRouteTransport, resolveHostedPodRoute } from '../../../src/api/ai-gateway/pod/HostedPodRoute';

describe('resolveHostedPodRoute', () => {
  it('names the gateway route for a canonical deployment URL', () => {
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayHost: 'localhost',
      gatewayPort: 5737,
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://localhost:5737/',
    });
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayPort: '5737',
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://127.0.0.1:5737/',
    });
  });

  it('connects to the address the gateway bound rather than a guess', () => {
    // A wildcard bind is not connectable everywhere, and `localhost` may be IPv6-only.
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '0.0.0.0', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://127.0.0.1:1/' });
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '::', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://[::1]:1/' });
  });

  it('has no route to offer without a canonical URL or a gateway port', () => {
    expect(resolveHostedPodRoute({ gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/' })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: '  ', gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayPort: 'not-a-port' }))
      .toBeUndefined();
  });

  it('loads the SDK transport and preserves canonical identity and proof headers over the numeric route', async () => {
    const wireFetch = vi.fn(async (input: string | URL | Request) => {
      const response = new Response('ok');
      Object.defineProperty(response, 'url', { value: input instanceof Request ? input.url : String(input), configurable: true });
      return response;
    });
    const transport = await createHostedPodRouteTransport(wireFetch as typeof fetch, resolveHostedPodRoute({
      canonicalBaseUrl: 'http://localhost:5737/', gatewayHost: '127.0.0.1', gatewayPort: 5737,
    }));
    const canonical = 'http://localhost:5737/pod/resource?view=1';
    const response = await transport(new Request(canonical, {
      headers: { authorization: 'DPoP synthetic-token', dpop: 'synthetic-proof' },
    }));
    const [request] = wireFetch.mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe('http://127.0.0.1:5737/pod/resource?view=1');
    expect((request as Request).headers.get('x-xpod-canonical-url')).toBe(canonical);
    expect((request as Request).headers.get('authorization')).toBe('DPoP synthetic-token');
    expect((request as Request).headers.get('dpop')).toBe('synthetic-proof');
    expect(response.url).toBe(canonical);
    expect(response.clone().url).toBe(canonical);

    await transport('https://unrelated.example/resource');
    expect(wireFetch.mock.calls[1]![0]).toBe('https://unrelated.example/resource');
  });
});


describe('bundled local route transport', () => {
  const cacheRoot = join(process.cwd(), '.test-data', `xpod-staged-solid-sdk-${randomUUID()}`);
  const load = createRequire(join(process.cwd(), 'package.json'));
  const route = { canonicalBaseUrl: 'https://canonical.example/', localBaseUrl: 'http://127.0.0.1:5737/' };

  beforeAll(() => {
    // Old and current archives coexist after upgrades. Neither is a module-resolution fallback.
    for (const archive of ['old-archive', 'current-archive']) {
      const staged = join(cacheRoot, archive, 'node_modules', '@undefineds.co', 'solid-sdk', 'dist');
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, 'local-route-fetch.js'),
        'export const createSolidLocalRouteFetch = () => async () => new Response("wrong cached SDK");\n');
    }
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  async function bundle(failure?: { message: string; code: string; key: string }) {
    const outfile = join(cacheRoot, `transport-${randomUUID()}.cjs`);
    const result = await build({
      entryPoints: [join(process.cwd(), 'src/api/ai-gateway/pod/HostedPodRoute.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      metafile: true,
      plugins: [{
        name: 'isolate-runtime-bootstrap',
        setup(builder) {
          // Port formatting is outside this loader regression; the production SDK is bundled.
          builder.onResolve({ filter: /runtime\/bootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'exports.localServiceUrl = (host, port) => `http://${host}:${port}`;',
          }));
          if (failure) {
            builder.onResolve({ filter: /^@undefineds\.co\/solid-sdk\/local-route-fetch$/ }, () => ({ path: 'sdk', namespace: 'broken-sdk' }));
            builder.onLoad({ filter: /.*/, namespace: 'broken-sdk' }, () => ({
              contents: `const error = Object.assign(new Error(${JSON.stringify(failure.message)}), { code: ${JSON.stringify(failure.code)} }); globalThis[Symbol.for(${JSON.stringify(failure.key)})] = error; throw error;`,
            }));
          }
        },
      }],
    });
    return { result, module: load(outfile) as typeof import('../../../src/api/ai-gateway/pod/HostedPodRoute') };
  }

  it('bundles the public SDK export rather than loading another archive from the cache root', async () => {
    vi.stubEnv('XPOD_BUN_SINGLE_CACHE_DIR', cacheRoot);
    try {
      const { result, module } = await bundle();
      expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith('solid-sdk/dist/local-route-fetch.cjs'))).toBe(true);
      const wireFetch = vi.fn(async (_input: string | URL | Request) => new Response('current bundled SDK'));
      const transport = await module.createHostedPodRouteTransport(wireFetch as typeof fetch, route);
      expect(await (await transport('https://canonical.example/resource')).text()).toBe('current bundled SDK');
      expect(String(wireFetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:5737/resource');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { code: 'EINITIALIZE', message: 'Current SDK initialization failed' },
    { code: 'MODULE_NOT_FOUND', message: "Cannot find module '@undefineds.co/solid-sdk/local-route-fetch'" },
    { code: 'MODULE_NOT_FOUND', message: "Cannot find module 'nested-sdk-dependency'" },
  ])('preserves $code ($message) without selecting a cached SDK', async failure => {
    const key = `hosted-pod-route-failure-${randomUUID()}`;
    vi.stubEnv('XPOD_BUN_SINGLE_CACHE_DIR', cacheRoot);
    try {
      const { module } = await bundle({ ...failure, key });
      let caught: unknown;
      try {
        await module.createHostedPodRouteTransport(fetch, route);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(caught).toBe(Reflect.get(globalThis, Symbol.for(key)));
      expect(caught).toMatchObject(failure);
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for(key));
      vi.unstubAllEnvs();
    }
  });
});
