import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHostedPodRoute, resolveStagedLocalRouteFetch } from '../../../src/api/ai-gateway/pod/HostedPodRoute';

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
});


describe('resolveStagedLocalRouteFetch', () => {
  const cacheRoot = join(tmpdir(), `xpod-staged-solid-sdk-${randomUUID()}`);

  beforeAll(() => {
    const staged = join(cacheRoot, 'a1b2c3', 'node_modules', '@undefineds.co', 'solid-sdk', 'dist');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'local-route-fetch.js'), 'export const createSolidLocalRouteFetch = () => fetch;\n', 'utf8');
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('finds the SDK inside a compiled runtime cache so the gateway route can load it', () => {
    const previous = process.env.XPOD_BUN_SINGLE_CACHE_DIR;
    process.env.XPOD_BUN_SINGLE_CACHE_DIR = cacheRoot;
    try {
      const resolved = resolveStagedLocalRouteFetch();
      expect(resolved).toBeDefined();
      expect(resolved).toContain('@undefineds.co/solid-sdk/dist/local-route-fetch.js');
      expect(resolved?.startsWith('file:')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XPOD_BUN_SINGLE_CACHE_DIR;
      else process.env.XPOD_BUN_SINGLE_CACHE_DIR = previous;
    }
  });

  it('stays inert when the runtime has no extracted cache', () => {
    const previous = process.env.XPOD_BUN_SINGLE_CACHE_DIR;
    delete process.env.XPOD_BUN_SINGLE_CACHE_DIR;
    try {
      expect(resolveStagedLocalRouteFetch()).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.XPOD_BUN_SINGLE_CACHE_DIR = previous;
    }
  });
});
