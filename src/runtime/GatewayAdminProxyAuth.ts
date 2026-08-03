import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

export const GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER = 'x-xpod-admin-proxy-loopback';
export const GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER = 'x-xpod-admin-proxy-timestamp';
export const GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER = 'x-xpod-admin-proxy-signature';
export const GATEWAY_ADMIN_PROXY_INTENT_HEADER = 'x-xpod-admin-proxy-intent';
export const GATEWAY_ADMIN_PROXY_NONCE_HEADER = 'x-xpod-admin-proxy-nonce';

export const GATEWAY_ADMIN_PROXY_HEADERS = [
  GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER,
  GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER,
  GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER,
  GATEWAY_ADMIN_PROXY_INTENT_HEADER,
  GATEWAY_ADMIN_PROXY_NONCE_HEADER,
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
  nonce?: string;
  intent?: GatewayAdminProxyIntent;
}

export interface GatewayAdminProxyMarkerVerification {
  present: boolean;
  valid: boolean;
  originalClientLoopback: boolean;
  nonce?: string;
  intent?: GatewayAdminProxyIntent;
  reason?: string;
}

export interface GatewayAdminProxyIntent {
  ownerWebId: string;
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  resourceUrl: string;
  principalKind: 'solid-user';
  scopes: string[];
}

export function createGatewayAdminProxyHeaders(input: GatewayAdminProxyMarkerInput): OutgoingHttpHeaders {
  const issuedAt = input.issuedAt ?? Date.now();
  const loopback = input.originalClientLoopback ? '1' : '0';
  const intent = input.intent ? canonicalGatewayAdminProxyIntent(input.intent) : undefined;
  return {
    [GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER]: loopback,
    [GATEWAY_ADMIN_PROXY_TIMESTAMP_HEADER]: String(issuedAt),
    ...(input.nonce ? { [GATEWAY_ADMIN_PROXY_NONCE_HEADER]: input.nonce } : {}),
    ...(intent ? { [GATEWAY_ADMIN_PROXY_INTENT_HEADER]: intent } : {}),
    [GATEWAY_ADMIN_PROXY_SIGNATURE_HEADER]: signGatewayAdminProxyMarker({
      secret: input.secret,
      method: input.method,
      url: input.url,
      loopback,
      issuedAt,
      nonce: input.nonce,
      intent,
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
  const nonce = firstHeader(input.headers[GATEWAY_ADMIN_PROXY_NONCE_HEADER]);
  const intentHeader = firstHeader(input.headers[GATEWAY_ADMIN_PROXY_INTENT_HEADER]);
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

  const intent = parseGatewayAdminProxyIntent(intentHeader);
  if (intentHeader !== undefined && !intent) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'invalid_intent' };
  }

  const expected = signGatewayAdminProxyMarker({
    secret: input.secret,
    method: input.method,
    url: input.url,
    loopback,
    issuedAt,
    nonce,
    intent: intentHeader,
  });
  if (!safeEqual(signature, expected)) {
    return { present: true, valid: false, originalClientLoopback: loopback === '1', reason: 'bad_signature' };
  }

  return { present: true, valid: true, originalClientLoopback: loopback === '1', nonce, intent };
}

function signGatewayAdminProxyMarker(input: {
  secret: string;
  method: string | undefined;
  url: string | undefined;
  loopback: '0' | '1';
  issuedAt: number;
  nonce?: string;
  intent?: string;
}): string {
  const payload = [
    'v1',
    (input.method ?? 'GET').toUpperCase(),
    input.url ?? '/',
    input.loopback,
    String(input.issuedAt),
    input.nonce ?? '',
    input.intent ?? '',
  ].join('\n');
  return createHmac('sha256', input.secret).update(payload).digest('base64url');
}

export function canonicalGatewayAdminProxyIntent(intent: GatewayAdminProxyIntent): string {
  return JSON.stringify({
    ownerWebId: intent.ownerWebId,
    method: intent.method,
    resourceUrl: intent.resourceUrl,
    principalKind: intent.principalKind,
    scopes: [...intent.scopes].sort(),
  });
}

function parseGatewayAdminProxyIntent(value: string | undefined): GatewayAdminProxyIntent | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<GatewayAdminProxyIntent>;
    if (typeof parsed.ownerWebId !== 'string' ||
      typeof parsed.resourceUrl !== 'string' ||
      (parsed.method !== 'GET' && parsed.method !== 'PUT' && parsed.method !== 'PATCH' && parsed.method !== 'DELETE') ||
      parsed.principalKind !== 'solid-user' ||
      !Array.isArray(parsed.scopes) ||
      !parsed.scopes.every((scope) => typeof scope === 'string')) {
      return undefined;
    }
    return {
      ownerWebId: parsed.ownerWebId,
      method: parsed.method,
      resourceUrl: parsed.resourceUrl,
      principalKind: parsed.principalKind,
      scopes: parsed.scopes,
    };
  } catch {
    return undefined;
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
