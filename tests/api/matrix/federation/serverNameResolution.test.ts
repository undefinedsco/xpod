import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEDERATION_PORT,
  MatrixServerNameResolver,
  readMServer,
  selectSrvRecord,
  splitServerName,
} from '../../../../src/api/matrix/federation/serverNameResolution';

const NOW = 1_700_000_000_000;

function jsonResponse(body: unknown, init: { status?: number; cacheControl?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.cacheControl ? { 'cache-control': init.cacheControl } : {},
  });
}

function resolver(options: {
  responses?: Record<string, Response | (() => Response | Promise<Response>)>;
  srv?: Record<string, readonly { target: string; port: number; priority?: number; weight?: number }[]>;
  now?: () => number;
} = {}) {
  const fetch = vi.fn(async (url: URL | RequestInfo) => {
    const key = String(url);
    const entry = options.responses?.[key];
    if (!entry) throw new Error(`unexpected fetch: ${key}`);
    return typeof entry === 'function' ? await entry() : entry.clone();
  });
  const resolveSrv = options.srv
    ? vi.fn(async (name: string) => {
      const records = options.srv?.[name];
      if (!records) throw new Error(`NXDOMAIN ${name}`);
      return records;
    })
    : undefined;
  const instance = new MatrixServerNameResolver({
    fetch: fetch as unknown as typeof fetch,
    ...(resolveSrv ? { resolveSrv } : {}),
    now: options.now ?? (() => NOW),
    random: () => 0,
  });
  return { instance, fetch, resolveSrv };
}

describe('server name resolution', () => {
  it('uses an IP literal directly on 8448 unless a port is given', async () => {
    const { instance } = resolver();
    await expect(instance.resolve('[2001:db8::1]')).resolves.toEqual({
      baseUrl: `https://[2001:db8::1]:${DEFAULT_FEDERATION_PORT}`, hostHeader: '[2001:db8::1]', via: 'ip-literal',
    });
    await expect(instance.resolve('192.0.2.10:8449')).resolves.toEqual({
      baseUrl: 'https://192.0.2.10:8449', hostHeader: '192.0.2.10:8449', via: 'ip-literal',
    });
  });

  it('uses an explicit port without asking about .well-known', async () => {
    const { instance, fetch } = resolver();
    await expect(instance.resolve('example.com:8449')).resolves.toEqual({
      baseUrl: 'https://example.com:8449', hostHeader: 'example.com:8449', via: 'explicit-port',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows a valid .well-known delegation, keeping the delegated name as Host', async () => {
    const { instance } = resolver({ responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }) } });
    await expect(instance.resolve('example.com')).resolves.toEqual({
      baseUrl: `https://matrix.example.net:${DEFAULT_FEDERATION_PORT}`, hostHeader: 'matrix.example.net', via: 'well-known', delegatedTo: 'matrix.example.net',
    });
  });

  it('uses a delegated explicit port verbatim and SRV only when no port is delegated', async () => {
    const withPort = resolver({ responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net:9443' }) } });
    await expect(withPort.instance.resolve('example.com')).resolves.toMatchObject({
      baseUrl: 'https://matrix.example.net:9443', hostHeader: 'matrix.example.net:9443', via: 'well-known',
    });

    const withSrv = resolver({
      responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }) },
      srv: { '_matrix-fed._tcp.matrix.example.net': [ { target: 'srv.example.net', port: 8448 } ] },
    });
    await expect(withSrv.instance.resolve('example.com')).resolves.toMatchObject({
      baseUrl: 'https://srv.example.net:8448', hostHeader: 'matrix.example.net', via: 'srv-fed',
    });
  });

  it('falls back to SRV when .well-known is missing, unusable or an error', async () => {
    const missing = resolver({ srv: { '_matrix-fed._tcp.example.com': [ { target: 'fed.example.net', port: 8448 } ] } });
    await expect(missing.instance.resolve('example.com')).resolves.toMatchObject({
      baseUrl: 'https://fed.example.net:8448', hostHeader: 'example.com', via: 'srv-fed',
    });

    const broken = resolver({
      responses: {
        'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'not a server name' }),
        'https://other.example/.well-known/matrix/server': new Response('not json', { status: 200 }),
      },
      srv: { '_matrix._tcp.other.example': [ { target: 'legacy.example.net', port: 8448 } ] },
    });
    await expect(broken.instance.resolve('example.com')).resolves.toMatchObject({ via: 'implicit-port' });
    // The deprecated `_matrix._tcp` name is still honoured when `_matrix-fed` is absent.
    await expect(broken.instance.resolve('other.example')).resolves.toMatchObject({
      baseUrl: 'https://legacy.example.net:8448', hostHeader: 'other.example', via: 'srv-legacy',
    });
  });

  it('uses the implicit federation port when nothing points elsewhere', async () => {
    const { instance } = resolver({ responses: { 'https://example.com/.well-known/matrix/server': new Response('', { status: 404 }) } });
    await expect(instance.resolve('example.com')).resolves.toEqual({
      baseUrl: `https://example.com:${DEFAULT_FEDERATION_PORT}`, hostHeader: 'example.com', via: 'implicit-port',
    });
  });

  it('caches discovery for the default 24 hours and honours max-age and the 48 hour ceiling', async () => {
    const { instance, fetch } = resolver({ responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }) } });
    await instance.resolve('example.com');
    await instance.resolve('example.com');
    expect(fetch).toHaveBeenCalledTimes(1);

    // A day later the default TTL has expired, so discovery happens again.
    let now = NOW;
    const clock = resolver({ responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }) }, now: () => now });
    await clock.instance.resolve('example.com');
    now += 24 * 60 * 60 * 1000 + 1;
    await clock.instance.resolve('example.com');
    expect(clock.fetch).toHaveBeenCalledTimes(2);

    let headerNow = NOW;
    const header = resolver({
      responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }, { cacheControl: 'public, max-age=3600' }) },
      now: () => headerNow,
    });
    await header.instance.resolve('example.com');
    headerNow += 3600 * 1000 + 1;
    await header.instance.resolve('example.com');
    expect(header.fetch).toHaveBeenCalledTimes(2);

    // max-age beyond the ceiling is clamped to 48 hours.
    let ceilingNow = NOW;
    const ceiling = resolver({
      responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }, { cacheControl: 'max-age=99999999' }) },
      now: () => ceilingNow,
    });
    await ceiling.instance.resolve('example.com');
    ceilingNow += 48 * 60 * 60 * 1000 - 1;
    await ceiling.instance.resolve('example.com');
    expect(ceiling.fetch).toHaveBeenCalledTimes(1);

    // `no-store` is respected: the answer is used, but never cached.
    const noStore = resolver({
      responses: { 'https://example.com/.well-known/matrix/server': jsonResponse({ 'm.server': 'matrix.example.net' }, { cacheControl: 'no-store' }) },
    });
    await noStore.instance.resolve('example.com');
    await noStore.instance.resolve('example.com');
    expect(noStore.fetch).toHaveBeenCalledTimes(2);
  });

  it('caches failures for an hour and backs off exponentially while they repeat', async () => {
    let now = NOW;
    const { instance, fetch } = resolver({ responses: { 'https://example.com/.well-known/matrix/server': new Response('', { status: 500 }) }, now: () => now });
    await instance.resolve('example.com');
    now += 60 * 60 * 1000 - 1;
    await instance.resolve('example.com');
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2;
    await instance.resolve('example.com');
    expect(fetch).toHaveBeenCalledTimes(2);
    // The second failure caches for two hours rather than one.
    now += 60 * 60 * 1000 + 1;
    await instance.resolve('example.com');
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 60 * 60 * 1000;
    await instance.resolve('example.com');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares one discovery request between concurrent callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { instance, fetch } = resolver({
      responses: {
        'https://example.com/.well-known/matrix/server': async () => {
          await gate;
          return jsonResponse({ 'm.server': 'matrix.example.net' });
        },
      },
    });
    const first = instance.resolve('example.com');
    const second = instance.resolve('example.com');
    release?.();
    expect(await first).toEqual(await second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that is not a server name', async () => {
    const { instance, fetch } = resolver();
    await expect(instance.resolve('example.com/path')).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('resolution helpers', () => {
  it('reads m.server only from a usable document', () => {
    expect(readMServer({ 'm.server': 'example.com:8448' })).toBe('example.com:8448');
    expect(readMServer({ 'm.server': 'example.com/path' })).toBeUndefined();
    expect(readMServer({ 'm.server': 42 })).toBeUndefined();
    expect(readMServer({})).toBeUndefined();
    expect(readMServer('m.server')).toBeUndefined();
    expect(readMServer([ { 'm.server': 'example.com' } ])).toBeUndefined();
  });

  it('splits server names into host and port', () => {
    expect(splitServerName('example.com')).toEqual({ host: 'example.com' });
    expect(splitServerName('example.com:8448')).toEqual({ host: 'example.com', port: 8448 });
    expect(splitServerName('[::1]')).toEqual({ host: '::1' });
    expect(splitServerName('[::1]:8448')).toEqual({ host: '::1', port: 8448 });
  });

  it('selects SRV records by priority and weight', () => {
    const records = [
      { target: 'low.example.net', port: 1, priority: 10, weight: 0 },
      { target: 'high.example.net', port: 1, priority: 5, weight: 0 },
    ];
    expect(selectSrvRecord(records, () => 0)?.target).toBe('high.example.net');
    expect(selectSrvRecord([], () => 0)).toBeUndefined();
    expect(selectSrvRecord([ { target: 'x', port: 0 } ], () => 0)).toBeUndefined();
    // Weighted choice: with total weight 10 a draw of 0.05 lands in the light record.
    const weighted = [
      { target: 'light.example.net', port: 1, priority: 0, weight: 1 },
      { target: 'heavy.example.net', port: 1, priority: 0, weight: 9 },
    ];
    expect(selectSrvRecord(weighted, () => 0.05)?.target).toBe('light.example.net');
    expect(selectSrvRecord(weighted, () => 0.5)?.target).toBe('heavy.example.net');
  });
});
