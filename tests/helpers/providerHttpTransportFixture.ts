import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { type TLSSocket } from 'node:tls';
import { ProviderHttpTransport } from '../../src/api/service/provider-http-transport';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function verify(): Promise<void> {
  assert(process.versions.bun, 'this fixture must run on native Bun');
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  let connectionCount = 0;
  const track = (server: Server): Server => {
    servers.push(server);
    server.on('connection', (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return server;
  };
  let targetRequests = 0;
  let tunnels = 0;
  let proxyRequests = 0;
  let tokenRequests = 0;
  let redirectRequests = 0;
  const target = track(createHttpsServer({
    cert: readFileSync(process.argv[2]), key: readFileSync(process.argv[3]),
  }, (request, response) => {
    targetRequests += 1;
    assert.equal(request.headers.host, `native.provider.test:${targetPort}`);
    assert.equal((request.socket as TLSSocket & { servername: string }).servername, 'native.provider.test');
    if (request.url === '/redirect') {
      redirectRequests += 1;
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    } else if (request.url === '/oauth/token') {
      tokenRequests += 1;
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        assert.equal(body, 'grant_type=refresh_token&refresh_token=fixture-only');
        assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.equal(request.headers['x-client'], 'fixture');
        assert.equal(request.headers.authorization, undefined);
        response.writeHead(400, { 'content-type': 'application/json', 'x-fixture': 'oauth-error' });
        response.end('{"error":"invalid_grant"}');
      });
    } else if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write('data: first\n\n');
      const timer = setTimeout(() => response.end('data: second\n\n'), 30);
      response.on('close', () => clearTimeout(timer));
    } else if (request.url === '/error') {
      response.writeHead(429, { 'content-type': 'text/plain', 'x-fixture': 'error' });
      response.end('x'.repeat(70 * 1024));
    } else if (request.url === '/slow-json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    } else if (request.url === '/abort') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write('data: first\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, method: request.method }));
    }
  }));
  const targetPort = await listen(target);
  const proxy = track(createServer((request, response) => {
    proxyRequests += 1;
    assert.equal(request.url, 'http://203.0.113.10/models');
    assert.equal(request.headers.host, 'public.provider.test');
    response.end(JSON.stringify({ proxy: true }));
  }));
  proxy.on('connect', (request, client, head) => {
    if (request.url === '203.0.113.10:80') {
      proxyRequests += 1;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.once('data', (data) => {
        assert.match(data.toString(), /host: public\.provider\.test\r\n/iu);
        const body = JSON.stringify({ proxy: true });
        client.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
      return;
    }
    tunnels += 1;
    assert.equal(request.url, `127.0.0.1:${targetPort}`);
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const origin = `https://native.provider.test:${targetPort}`;
  const resolver = async (host: string) => [{ address: host === 'public.provider.test' ? '203.0.113.10' : '127.0.0.1' }];
  const transport = new ProviderHttpTransport({
    resolver, allowedPrivateOrigins: [origin],
    systemProxy: `http://system.proxy.test:${proxyPort}`, timeoutMs: 1_000,
  });
  try {
    // Ambient bypass must not override the explicitly selected proxy.
    process.env.NO_PROXY = '*';
    process.env.no_proxy = '';
    assert.deepEqual(await transport.getJson({ url: 'http://public.provider.test/models' }), { proxy: true });
    assert.equal(proxyRequests, 1);
    assert.deepEqual(await transport.getJson({
      url: 'http://public.provider.test/models', proxy: `http://system.proxy.test:${proxyPort}/`,
    }), { proxy: true });
    assert.equal(proxyRequests, 2);
    assert.deepEqual(await transport.getJson({ url: `${origin}/json` }), { ok: true, method: 'GET' });
    assert.deepEqual(await transport.postJson({ url: `${origin}/json`, apiKey: 'fixture', body: {} }), { ok: true, method: 'POST' });
    const events = [];
    for await (const event of transport.postSse({ url: `${origin}/stream`, body: {} })) events.push(event.data);
    assert.deepEqual(events, ['first', 'second']);
    const abort = new AbortController();
    const iterator = transport.postSse({ url: `${origin}/abort`, body: {}, signal: abort.signal })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.data, 'first');
    abort.abort(new Error('fixture_abort'));
    await assert.rejects(iterator.next(), /fixture_abort/u);
    await assert.rejects(transport.getJson({ url: `${origin}/redirect` }), { status: 302 });
    assert.equal(targetRequests, 5);
    assert.equal(tunnels, 5);

    const rawAbort = new AbortController();
    const raw = await transport.postStream({ url: `${origin}/abort`, apiKey: 'fixture', body: {}, signal: rawAbort.signal });
    const rawReader = raw.body!.getReader();
    assert.equal((await rawReader.read()).done, false);
    rawAbort.abort(new Error('raw_fixture_abort'));
    await assert.rejects(rawReader.read(), /raw_fixture_abort/u);
    rawReader.releaseLock();
    const timed = new ProviderHttpTransport({ resolver, allowedPrivateOrigins: [origin], systemProxy: `http://system.proxy.test:${proxyPort}`, timeoutMs: 100 });
    await assert.rejects(timed.getJson({ url: `${origin}/slow-json` }), /provider_request_timeout/u);
    await assert.rejects(transport.postStream({ url: `${origin}/error`, apiKey: 'fixture', body: {} }), (error: any) =>
      error.status === 429 && error.body === 'x'.repeat(64 * 1024) && error.headers.get('x-fixture') === 'error');
    const tokenResponse = await transport.request({
      url: `${origin}/oauth/token`, method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'fixture-only' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-client': 'fixture' },
      redirect: 'error', timeoutMs: 10_000,
    });
    assert.equal(tokenResponse.status, 400);
    assert.equal(tokenResponse.headers.get('x-fixture'), 'oauth-error');
    assert.deepEqual(await tokenResponse.json(), { error: 'invalid_grant' });
    assert.equal(tokenRequests, 1);
    await assert.rejects(transport.request({ url: `${origin}/redirect`, method: 'POST', body: 'fixture', redirect: 'error' }));
    const manualRedirect = await transport.request({ url: `${origin}/redirect` });
    assert.equal(manualRedirect.status, 302);
    await manualRedirect.arrayBuffer();
    assert.equal(redirectRequests, 3);
    const rawTimedResponse = await timed.request({ url: `${origin}/slow-json` });
    await assert.rejects(rawTimedResponse.text(), /provider_request_timeout/u);
    const cancelledResponse = await transport.request({ url: `${origin}/abort` });
    const cancelledReader = cancelledResponse.body!.getReader();
    assert.equal((await cancelledReader.read()).done, false);
    await cancelledReader.cancel('fixture-consumer-cancelled');
    cancelledReader.releaseLock();
    const before = proxyRequests + tunnels;
    const beforeConnections = connectionCount;
    await assert.rejects(transport.getJson({ url: 'http://169.254.169.254/metadata' }), /unsafe_provider_target/u);
    await assert.rejects(transport.getJson({ url: `${origin}/json`, proxy: 'http://127.0.0.1:1' }), /unsafe_provider_target/u);
    for (const viaProxy of [false, true]) {
      let lookups = 0;
      const rebound = new ProviderHttpTransport({
        resolver: async () => [{ address: ++lookups === 1 ? '203.0.113.10' : '127.0.0.1' }],
        systemProxy: viaProxy ? `http://127.0.0.1:${proxyPort}` : undefined,
        timeoutMs: 1_000,
      });
      await assert.rejects(rebound.getJson({ url: `http://rebind.provider.test:${targetPort}/models` }), (error: any) =>
        (error.cause?.message ?? error.message) === 'unsafe_provider_target');
      assert.equal(lookups, 2);
    }
    let proxyLookups = 0;
    const reboundProxy = new ProviderHttpTransport({
      resolver: async (host) => [{ address: host === 'public.provider.test' || ++proxyLookups === 1 ? '203.0.113.10' : '127.0.0.1' }],
      timeoutMs: 1_000,
    });
    await assert.rejects(reboundProxy.getJson({ url: 'http://public.provider.test/models', proxy: `http://rebind.proxy.test:${proxyPort}` }), (error: any) =>
      (error.cause?.message ?? error.message) === 'unsafe_provider_target');
    assert.equal(proxyRequests + tunnels, before);
    assert.equal(connectionCount, beforeConnections);

    // Direct requests ignore ambient proxies and retain checked DNS/TLS identity.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.NO_PROXY = '';
    const direct = new ProviderHttpTransport({ resolver, allowedPrivateOrigins: [origin], timeoutMs: 1_000 });
    assert.deepEqual(await direct.getJson({ url: `${origin}/json` }), { ok: true, method: 'GET' });
    assert.equal(tunnels, before - proxyRequests);
    process.stdout.write('native provider transport verified\n');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

void verify().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
