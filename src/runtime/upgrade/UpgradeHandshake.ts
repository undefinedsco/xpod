import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';

/**
 * HTTP handshake helpers for the gateway's upgrade relay.
 *
 * Upgrade requests are relayed to the internal services byte-for-byte, so the
 * relay has to build the upstream request itself (see `BunNativeUpgradeRelay`).
 * Keeping the header rules here makes them unit-testable and keeps the HTTP
 * semantics of the gateway in one place.
 */

/** RFC 7230 hop-by-hop headers: never forwarded to the next hop. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers that belong to a single WebSocket handshake on one hop. They are set
 * by the relay (or by the WebSocket implementation) for the upstream hop and
 * must not be copied from the client request.
 */
const HANDSHAKE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-version',
  // The relay never forwards a request body, so a content-length from the
  // client must not make the upstream wait for one.
  'content-length',
]);

export interface BuildUpstreamUpgradeOptions {
  /** Request path (including query string) to request from the upstream. */
  path: string;
  /** Client request headers. */
  headers: IncomingHttpHeaders;
  /** Subprotocols requested by the client, in client preference order. */
  protocols: string[];
  /** Freshly generated `Sec-WebSocket-Key`. Defaults to a random key. */
  key?: string;
  /** `X-Forwarded-*` values; parity with `http-proxy`'s `xfwd: true`. */
  forwardedFor?: string;
  forwardedPort?: string;
  forwardedProto?: string;
}

export function createWebSocketKey(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Builds the raw HTTP upgrade request that is sent to the internal service.
 * The client's `Host` and its application headers (authorization, cookies,
 * origin, DPoP, custom `X-*`, ...) are forwarded unchanged so the internal
 * server answers exactly as it would for a direct connection.
 */
export function buildUpstreamUpgradeRequest(options: BuildUpstreamUpgradeOptions): Buffer {
  const headers = new Map<string, string>();

  for (const [ name, value ] of Object.entries(options.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || HANDSHAKE_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    headers.set(lower, Array.isArray(value) ? value.join(', ') : String(value));
  }

  appendForwarded(headers, 'x-forwarded-for', options.forwardedFor);
  appendForwarded(headers, 'x-forwarded-port', options.forwardedPort);
  appendForwarded(headers, 'x-forwarded-proto', options.forwardedProto);

  headers.set('upgrade', 'websocket');
  headers.set('connection', 'Upgrade');
  headers.set('sec-websocket-key', options.key ?? createWebSocketKey());
  headers.set('sec-websocket-version', '13');
  if (options.protocols.length > 0) {
    headers.set('sec-websocket-protocol', options.protocols.join(', '));
  }

  const lines = [ `GET ${options.path} HTTP/1.1` ];
  for (const [ name, value ] of headers) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

function appendForwarded(headers: Map<string, string>, name: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  const existing = headers.get(name);
  headers.set(name, existing ? `${existing},${value}` : value);
}

export interface UpgradeHandshakeResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  /** Raw response bytes (status line + headers), without the body that follows. */
  head: Buffer;
  /** Bytes received after the header block (already-upgraded frames or a body). */
  rest: Buffer;
}

/**
 * Parses the beginning of the upstream upgrade response.
 * @returns the parsed response, or `undefined` while the header block is incomplete.
 */
export function parseUpgradeHandshakeResponse(buffer: Buffer): UpgradeHandshakeResponse | undefined {
  const boundary = buffer.indexOf('\r\n\r\n');
  if (boundary < 0) {
    return undefined;
  }

  const headerBlock = buffer.subarray(0, boundary).toString('latin1');
  const lines = headerBlock.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const match = /^HTTP\/\d\.\d (\d{3}) ?(.*)$/.exec(statusLine);
  if (!match) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }

  return {
    statusCode: Number(match[1]),
    statusMessage: match[2] ?? '',
    headers,
    head: buffer.subarray(0, boundary + 4),
    rest: buffer.subarray(boundary + 4),
  };
}

/** Subprotocol selected by the upstream server, if any. */
export function selectedProtocol(response: UpgradeHandshakeResponse): string {
  const value = response.headers['sec-websocket-protocol'];
  return value ? value.split(',')[0]!.trim() : '';
}

/** True when the upstream actually switched protocols to WebSocket. */
export function isWebSocketUpgrade(response: UpgradeHandshakeResponse): boolean {
  return response.statusCode === 101 && (response.headers.upgrade ?? '').toLowerCase() === 'websocket';
}

export function parseRequestedProtocols(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) {
    return [];
  }
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

interface RawWritable {
  write(chunk: Buffer): unknown;
  end?(): unknown;
}

/**
 * Writes raw bytes to a socket handed over by the HTTP server's `upgrade` event.
 *
 * Bun's `node:http` server hands the upgrade listener a socket shim whose
 * `write()` never reaches the peer (`socket.write()` returns `true` and the
 * bytes are dropped), which is why the gateway cannot use `http-proxy`'s
 * WebSocket pass there. The underlying Bun socket handle still writes
 * correctly, so error responses are written through it; on every other runtime
 * the regular socket write is used.
 */
export function writeUpgradeSocketBytes(socket: Duplex, chunk: Buffer): void {
  const handle = findBunSocketHandle(socket);
  if (handle) {
    handle.write(chunk);
    return;
  }
  socket.write(chunk);
}

export function endUpgradeSocket(socket: Duplex): void {
  const handle = findBunSocketHandle(socket);
  if (handle?.end) {
    handle.end();
    return;
  }
  socket.end();
}

function findBunSocketHandle(socket: Duplex): RawWritable | undefined {
  for (const symbol of Object.getOwnPropertySymbols(socket)) {
    if (symbol.description !== 'handle') {
      continue;
    }
    const handle = (socket as unknown as Record<symbol, unknown>)[symbol];
    if (handle && typeof (handle as { write?: unknown }).write === 'function') {
      return handle as RawWritable;
    }
  }
  return undefined;
}

/** Writes a complete HTTP response to an upgrade request that could not be relayed. */
export function writeUpgradeErrorResponse(
  socket: Duplex,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string>,
  body: string,
): void {
  const payload = Buffer.from(body, 'utf8');
  const lines = [ `HTTP/1.1 ${statusCode} ${statusMessage}` ];
  for (const [ name, value ] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${payload.length}`, 'Connection: close', '', '');
  writeUpgradeSocketBytes(socket, Buffer.concat([ Buffer.from(lines.join('\r\n'), 'latin1'), payload ]));
  endUpgradeSocket(socket);
}

/** Best-effort `X-Forwarded-*` values matching `http-proxy`'s `xfwd: true`. */
export function forwardedHeaderValues(req: IncomingMessage): {
  forwardedFor?: string;
  forwardedPort?: string;
  forwardedProto: string;
} {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  const port = host?.match(/:(\d+)/)?.[1];
  const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
  return {
    forwardedFor: req.socket.remoteAddress,
    forwardedPort: port ?? (encrypted ? '443' : '80'),
    forwardedProto: encrypted ? 'wss' : 'ws',
  };
}
