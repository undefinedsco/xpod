import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { registerSocketOriginShims } from '../../src/runtime/socket-shim';

it('carries canonical HTTPS fetch and Node requests over the owned plain HTTP socket', async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'origin-sock-'));
  const socket = path.join(dir, 'g.sock');
  const observed: Array<{ path?: string; host?: string }> = [];
  const server = createServer((request, response) => {
    observed.push({ path: request.url, host: request.headers.host });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('canonical body');
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const origin = 'https://owned-unrouted.invalid';
  const unregister = registerSocketOriginShims(origin, socket);
  try {
    const fetched = await fetch(`${origin}/fetch`);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe('canonical body');
    const received = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      https.get(`${origin}/node`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk.toString(); });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      }).on('error', reject);
    });
    expect(received).toEqual({ status: 200, body: 'canonical body' });
    expect(observed).toEqual([{ path: '/fetch', host: 'owned-unrouted.invalid' }, { path: '/node', host: 'owned-unrouted.invalid' }]);
  } finally {
    await unregister();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


it('preserves native TLS for an unregistered HTTPS origin and an explicit socketPath', async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'tls-sock-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const tlsSocket = path.join(dir, 'tls.sock');
  const plainSocket = path.join(dir, 'p.sock');
  const tlsConfig = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  const native = https.createServer(tlsConfig, (_request, response) => response.end('native TLS body'));
  const socketTls = https.createServer(tlsConfig, (_request, response) => response.end('explicit TLS body'));
  const plain = createServer((_request, response) => response.end('unexpected plain socket'));
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => socketTls.listen(tlsSocket, resolve));
  await new Promise<void>(resolve => plain.listen(plainSocket, resolve));
  const unregister = registerSocketOriginShims('https://localhost', plainSocket);
  const read = (options: https.RequestOptions) => new Promise<string>((resolve, reject) => {
    https.get(options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    }).on('error', reject);
  });
  try {
    const port = (native.address() as { port: number }).port;
    expect(await read({ hostname: '127.0.0.1', port, servername: 'localhost', ca: tlsConfig.cert })).toBe('native TLS body');
    expect(await read({ hostname: 'localhost', socketPath: tlsSocket, ca: tlsConfig.cert })).toBe('explicit TLS body');
  } finally {
    await unregister();
    for (const server of [native, socketTls, plain]) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
