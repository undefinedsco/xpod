import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { getFreePort } from '../../src/runtime/port-finder';
import { Supervisor } from '../../src/supervisor/Supervisor';

async function withUpstream(
  respond: (socket: net.Socket) => void,
  verify: (url: string) => Promise<void>,
): Promise<void> {
  const upstream = net.createServer((socket) => socket.once('data', () => respond(socket)));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let gateway: GatewayProxy | undefined;
  try {
    const gatewayPort = await getFreePort(46200, '127.0.0.1');
    gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1');
    gateway.setTargets({ css: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
    await gateway.start();
    await verify(`http://127.0.0.1:${gatewayPort}/malformed.txt`);
  } finally {
    await gateway?.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

/** A parser failure must not inherit the upstream body's length or encoding. */
export async function verifyGatewayProxyErrorFraming(encodedUpstream = false): Promise<void> {
  await withUpstream((socket) => {
    // A complete header reaches proxyRes before the parser rejects the surplus.
    // No real user data or credentials are used by this malformed peer.
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n${encodedUpstream ? 'Content-Encoding: gzip\r\n' : ''}Connection: close\r\n\r\nhelloEXTRA`);
  }, async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('transfer-encoding'), null);
    const body = await response.text();
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.ok(Buffer.byteLength(body) > 5);
    const error = JSON.parse(body) as { error: string; details: string };
    assert.equal(error.error, 'Service Unavailable');
    assert.match(error.details, /Parse Error/u);
  });
}

/** An already-started response cannot be replaced with a second JSON response. */
export async function verifyGatewayProxyLateError(): Promise<void> {
  let release: (() => void) | undefined;
  await withUpstream((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: close\r\n\r\npart');
    release = () => socket.destroy();
  }, async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    assert.equal(response.status, 200);
    release?.();
    await assert.rejects(response.text());
  });
}
