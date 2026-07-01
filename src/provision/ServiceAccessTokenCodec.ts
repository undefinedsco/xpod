/**
 * ServiceAccessTokenCodec
 *
 * Long-lived serviceToken is a local/root setup credential. Cloud should not
 * embed it into provisionCode. Instead Cloud signs a short-lived access token
 * with serviceToken, and Local verifies it statelessly before accepting
 * provision callbacks.
 *
 * 格式: "sat-" + base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ServiceAccessTokenPayload {
  typ: 'xpod-service-access';
  sub?: string;
  scopes: string[];
  exp: number;
}

export interface CreateServiceAccessTokenOptions {
  /** Long-lived local serviceToken used only as signing secret. */
  serviceToken: string;
  /** Node/app/service subject, normally nodeId. */
  subject?: string;
  scopes: string[];
  /** Relative lifetime in seconds. Ignored when expiresAt is set. */
  ttlSeconds?: number;
  /** Absolute expiration as Unix timestamp seconds. */
  expiresAt?: number;
  /** Test hook. Returns milliseconds. */
  now?: () => number;
}

export interface VerifyServiceAccessTokenOptions {
  /** Long-lived local serviceToken used only as verification secret. */
  serviceToken: string;
  requiredScope?: string;
  /** Test hook. Returns milliseconds. */
  now?: () => number;
}

export type VerifyServiceAccessTokenResult =
  | { valid: true; payload: ServiceAccessTokenPayload }
  | { valid: false; reason: 'malformed' | 'signature' | 'expired' | 'scope' };

const TOKEN_PREFIX = 'sat-';

export function createServiceAccessToken(options: CreateServiceAccessTokenOptions): string {
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const exp = options.expiresAt ?? (
    options.ttlSeconds && options.ttlSeconds > 0
      ? nowSeconds + options.ttlSeconds
      : undefined
  );

  if (!exp || !Number.isFinite(exp)) {
    throw new Error('service access token expiration is required');
  }

  const payload: ServiceAccessTokenPayload = {
    typ: 'xpod-service-access',
    sub: options.subject,
    scopes: dedupeScopes(options.scopes),
    exp,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${TOKEN_PREFIX}${data}.${sign(data, options.serviceToken)}`;
}

export function verifyServiceAccessToken(
  token: string | undefined | null,
  options: VerifyServiceAccessTokenOptions,
): VerifyServiceAccessTokenResult {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    return { valid: false, reason: 'malformed' };
  }

  const body = token.slice(TOKEN_PREFIX.length);
  const dotIndex = body.indexOf('.');
  if (dotIndex <= 0) {
    return { valid: false, reason: 'malformed' };
  }

  const data = body.slice(0, dotIndex);
  const signature = body.slice(dotIndex + 1);
  if (!safeEqual(signature, sign(data, options.serviceToken))) {
    return { valid: false, reason: 'signature' };
  }

  let payload: ServiceAccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as ServiceAccessTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (!isValidPayload(payload)) {
    return { valid: false, reason: 'malformed' };
  }

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (payload.exp <= nowSeconds) {
    return { valid: false, reason: 'expired' };
  }

  if (options.requiredScope && !payload.scopes.includes(options.requiredScope)) {
    return { valid: false, reason: 'scope' };
  }

  return { valid: true, payload };
}

function sign(data: string, serviceToken: string): string {
  return createHmac('sha256', serviceToken).update(data).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function isValidPayload(payload: ServiceAccessTokenPayload): boolean {
  return Boolean(
    payload
    && payload.typ === 'xpod-service-access'
    && Array.isArray(payload.scopes)
    && payload.scopes.every((scope) => typeof scope === 'string' && scope.length > 0)
    && typeof payload.exp === 'number'
    && Number.isFinite(payload.exp),
  );
}
