import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createNodeFederationFetch,
  federationRequestOptions,
} from '../../../../src/api/matrix/federation/federationFetch';

describe('presenting the name a delegated endpoint must prove', () => {
  it('connects to the resolved address while carrying the server name', () => {
    const plan = federationRequestOptions({
      url: 'https://delegated.example:8448/_matrix/federation/v1/version?x=1',
      target: { baseUrl: 'https://delegated.example:8448', hostHeader: 'alice.example' },
      init: { method: 'GET', headers: { authorization: 'X-Matrix origin="alice.example"' } },
    });

    // The address is where the endpoint actually is; the name is what it has to prove, as SNI and
    // as `Host` — which is exactly what `fetch` cannot do.
    expect(plan).toMatchObject({
      protocol: 'https:',
      hostname: 'delegated.example',
      port: 8448,
      path: '/_matrix/federation/v1/version?x=1',
      servername: 'alice.example',
    });
    expect(plan.headers.host).toBe('alice.example');
    expect(plan.headers.authorization).toBe('X-Matrix origin="alice.example"');
  });

  it('keeps an explicit port in Host but not in SNI, which has no ports', () => {
    const plan = federationRequestOptions({
      url: 'https://address.example:8449/_matrix/key/v2/server',
      target: { baseUrl: 'https://address.example:8449', hostHeader: 'alice.example:8449' },
      init: { method: 'GET' },
    });
    expect(plan.headers.host).toBe('alice.example:8449');
    expect(plan.servername).toBe('alice.example');
    expect(plan.port).toBe(8449);
  });

  it('refuses a URL that is not HTTP(S) rather than guessing a transport', () => {
    expect(() => federationRequestOptions({
      url: 'ftp://delegated.example/x',
      target: { baseUrl: 'ftp://delegated.example', hostHeader: 'alice.example' },
      init: { method: 'GET' },
    })).toThrow(/HTTP\(S\)/u);
  });

  it('sends the request to the address with the name in Host, and returns the answer', async () => {
    const seen: { host?: string; path?: string; method?: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        seen.push({
          host: request.headers.host,
          path: request.url,
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await listen(server);
    const port = addressOf(server);
    try {
      const fetchTarget = createNodeFederationFetch();
      const response = await fetchTarget({
        url: `http://127.0.0.1:${port}/_matrix/federation/v1/send/txn-1`,
        target: { baseUrl: `http://127.0.0.1:${port}`, hostHeader: 'alice.example' },
        init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pdus: [] }) },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      // The socket went to the loopback address; the peer saw the name it is being asked for.
      expect(seen).toEqual([ {
        host: 'alice.example',
        path: '/_matrix/federation/v1/send/txn-1',
        method: 'PUT',
        body: JSON.stringify({ pdus: [] }),
      } ]);
    } finally {
      await close(server);
    }
  });

  it('answers a refusal as a response, and only a transport failure as an error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errcode: 'M_FORBIDDEN' }));
    });
    await listen(server);
    const port = addressOf(server);
    try {
      const fetchTarget = createNodeFederationFetch();
      const refused = await fetchTarget({
        url: `http://127.0.0.1:${port}/x`,
        target: { baseUrl: `http://127.0.0.1:${port}`, hostHeader: 'alice.example' },
        init: { method: 'GET' },
      });
      // The caller classifies statuses; "refused" must not look like "unreachable".
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toEqual({ errcode: 'M_FORBIDDEN' });
    } finally {
      await close(server);
    }

    // Nothing is listening on that port any more: that is the case that throws.
    const fetchTarget = createNodeFederationFetch();
    await expect(fetchTarget({
      url: `http://127.0.0.1:${port}/x`,
      target: { baseUrl: `http://127.0.0.1:${port}`, hostHeader: 'alice.example' },
      init: { method: 'GET' },
    })).rejects.toThrow();
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function addressOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the test server did not bind a port');
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()); });
}

