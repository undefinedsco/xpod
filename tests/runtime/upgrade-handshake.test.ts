import { describe, expect, it } from 'vitest';
import {
  buildUpstreamUpgradeRequest,
  createWebSocketKey,
  forwardedHeaderValues,
  isWebSocketUpgrade,
  parseRequestedProtocols,
  parseUpgradeHandshakeResponse,
  selectedProtocol,
} from '../../src/runtime/upgrade/UpgradeHandshake';

function parseRequest(buffer: Buffer): { requestLine: string; headers: Record<string, string> } {
  const text = buffer.toString('latin1');
  const [ headerBlock ] = text.split('\r\n\r\n');
  const lines = headerBlock!.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { requestLine: lines[0]!, headers };
}

describe('upgrade request preparation', () => {
  it('forwards application headers and drops hop-by-hop and handshake headers', () => {
    const request = buildUpstreamUpgradeRequest({
      path: '/.notifications/WebSocketChannel2023/abc?x=1',
      protocols: [ 'solid-notifications', 'other' ],
      key: 'dGhlIHNhbXBsZSBub25jZQ==',
      headers: {
        host: '127.0.0.1:3000',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'client-key',
        'sec-websocket-version': '13',
        'sec-websocket-extensions': 'permessage-deflate',
        'sec-websocket-protocol': 'solid-notifications, other',
        authorization: 'DPoP token',
        cookie: 'a=b',
        origin: 'http://127.0.0.1:3000',
        'x-custom': 'kept',
      },
    });

    const { requestLine, headers } = parseRequest(request);
    expect(requestLine).toBe('GET /.notifications/WebSocketChannel2023/abc?x=1 HTTP/1.1');
    expect(headers).toMatchObject({
      host: '127.0.0.1:3000',
      authorization: 'DPoP token',
      cookie: 'a=b',
      origin: 'http://127.0.0.1:3000',
      'x-custom': 'kept',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'solid-notifications, other',
    });
    // A fresh key per hop, and no extension is ever offered: the relay speaks
    // uncompressed frames.
    expect(headers['sec-websocket-key']).not.toBe('client-key');
    expect(headers['sec-websocket-extensions']).toBeUndefined();
    expect(headers['keep-alive']).toBeUndefined();
  });

  it('appends the x-forwarded-* chain like http-proxy xfwd does', () => {
    const request = buildUpstreamUpgradeRequest({
      path: '/channel',
      protocols: [],
      headers: { host: 'pod.example:443', 'x-forwarded-for': '10.0.0.1' },
      forwardedFor: '127.0.0.1',
      forwardedPort: '443',
      forwardedProto: 'ws',
    });
    const { headers } = parseRequest(request);
    expect(headers['x-forwarded-for']).toBe('10.0.0.1,127.0.0.1');
    expect(headers['x-forwarded-port']).toBe('443');
    expect(headers['x-forwarded-proto']).toBe('ws');
  });

  it('generates unique base64 websocket keys', () => {
    const first = createWebSocketKey();
    expect(Buffer.from(first, 'base64')).toHaveLength(16);
    expect(first).not.toBe(createWebSocketKey());
  });

  it('parses and normalizes requested subprotocols', () => {
    expect(parseRequestedProtocols('a, b ,c')).toEqual([ 'a', 'b', 'c' ]);
    expect(parseRequestedProtocols([ 'a', 'b' ])).toEqual([ 'a', 'b' ]);
    expect(parseRequestedProtocols(undefined)).toEqual([]);
  });

  it('derives x-forwarded values from the client socket', () => {
    const values = forwardedHeaderValues({
      headers: { host: '127.0.0.1:3000' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);
    expect(values).toEqual({ forwardedFor: '127.0.0.1', forwardedPort: '3000', forwardedProto: 'ws' });
  });
});

describe('upstream handshake response parsing', () => {
  it('returns undefined until the header block is complete', () => {
    expect(parseUpgradeHandshakeResponse(Buffer.from('HTTP/1.1 101 Switching'))).toBeUndefined();
  });

  it('parses a 101 response and keeps the trailing bytes', () => {
    const response = parseUpgradeHandshakeResponse(Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: abc\r\n'
      + 'Sec-WebSocket-Protocol: solid-notifications\r\n'
      + '\r\n'
      + 'FRAMES',
    ));

    expect(response).toBeDefined();
    expect(response!.statusCode).toBe(101);
    expect(response!.statusMessage).toBe('Switching Protocols');
    expect(isWebSocketUpgrade(response!)).toBe(true);
    expect(selectedProtocol(response!)).toBe('solid-notifications');
    expect(response!.rest.toString()).toBe('FRAMES');
  });

  it('treats non-101 answers as rejections and keeps their headers', () => {
    const response = parseUpgradeHandshakeResponse(Buffer.from(
      'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
    ));
    expect(isWebSocketUpgrade(response!)).toBe(false);
    expect(selectedProtocol(response!)).toBe('');
    expect(response!.headers['content-type']).toBe('application/json');
    expect(response!.rest.toString()).toBe('{}');
  });

  it('does not treat a 101 without the websocket upgrade header as an upgrade', () => {
    const response = parseUpgradeHandshakeResponse(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\n\r\n'));
    expect(isWebSocketUpgrade(response!)).toBe(false);
  });
});
