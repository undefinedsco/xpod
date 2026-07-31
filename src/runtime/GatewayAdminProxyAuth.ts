import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

export const GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER = 'x-xpod-admin-proxy-loopback';
export const GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER = 'x-xpod-admin-proxy-timestamp';
export const GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER = 'x-xpod-admin-proxy-signature';

export const GATEWAY_ADMIN_PROXY_HEADERS = [
  GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER,
  GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER,
  GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER,
] as const;

const MAX_CLOCK_SKEW_MS = 60_000;

export function createGatewayAdminProxyAuthSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface GatewayAdminProxyMarkerInput {
  secret: string;
  method: string | undefined;
  url: string | undefined;
  originalClientLoopback: boolean;
  issuedAt?: number;
}

export interface GatewayAdminProxyMarkerVerification {
  present: boolean;
  valid: boolean;
  originalClientLoopback: boolean;
  reason?: string;
}

export function createGatewayAdminProxyHeaders(input: GatewayAdminProxyMarkerInput): OutgoingHttpHeaders {
  const issuedAt = input.issuedAt ?? Date.now();
  const loopback = input.originalClientLoopback ? '1' : '0';
  return {
    [GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER]: loopback,
    [GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER]: String(issuedAt),
    [GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER]: signGatewayAdminProxyMarker({
      secret: input.secret,
      method: input.method,
      url: input.url,
      loopback,
      issuedAt,
    }),
  };
}

export function stripGatewayAdminProxyHeaders(headers: IncomingHttpHeaders): void {
  for (const header of GATEWAY_ADMIN_PROXY_HEADERS) {
    delete headers[header];
  }
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;

  if (isIP(normalized) === 4) {
    return normalized.startsWith('127.');
  }
  return normalized === '::1';
}

export function verifyGatewayAdminProxyHeaders(input: {
  headers: IncomingHttpHeaders;
  secret?: string;
  method: string | undefined;
  url: string | undefined;
  now?: number;
}): GatewayAdminProxyMarkerVerification {
  const loopback = firstHeader(input.headers[GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER]);
  const timestamp = firstHeader(input.headers[GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER]);
  const signature = firstHeader(input.headers[GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER]);
  const present = loopback !== undefined || timestamp !== undefined || signature !== undefined;
  if (!present) {
    return { present: false, valid: false, originalClientLoopback: false };
  }
  if (!input.secret) {
    return { present: true, valid: false, originalClientLoopback: false, reason: 'missing_secret' };
  }
  if (loopback !== '0' && loopback !== '1') {
    return { present: true, valid: false, originalClientLoopback: false, reason: 'invalid_loopback' };
  }
  if (!timestamp || !signature) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'incomplete_marker' };
  }

  const issuedAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(issuedAt)) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'invalid_timestamp' };
  }
  if (Math.abs((input.now ?? Date.now()) - issuedAt) > MAX_CLOCK_SKEW_MS) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'expired_marker' };
  }

  const expected = signGatewayAdminProxyMarker({
    secret: input.secret,
    method: input.method,
    url: input.url,
    loopback,
    issuedAt,
  });
  if (!safeEqual(signature, expected)) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'bad_signature' };
  }

  return { present: true, valid: true, originalClientLoopback: loopback === '1' };
}

function signGatewayAdminProxyMarker(input: {
  secret: string;
  method: string | undefined;
  url: string | undefined;
  loopback: '0' | '1';
  issuedAt: number;
}): string {
  const payload = [
    'v1',
    (input.method ?? 'GET').toUpperCase(),
    input.url ?? '/',
    input.loopback,
    String(input.issuedAt),
  ].join('\n');
  return createHmac('sha256', input.secret).update(payload).digest('base64url');
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
