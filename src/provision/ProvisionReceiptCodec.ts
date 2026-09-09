import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 5 * 60;

export interface ProvisionReceiptPayload {
  typ: 'xpod-provision-receipt';
  podName: string;
  webId: string;
  podUrl: string;
  exp: number;
}

export interface CreateProvisionReceiptOptions {
  secret: string;
  podName: string;
  webId: string;
  podUrl: string;
  expiresAt?: number;
  ttlSeconds?: number;
  now?: () => number;
}

export interface VerifyProvisionReceiptOptions {
  secret: string;
  now?: () => number;
}

export type VerifyProvisionReceiptResult =
  | { valid: true; payload: ProvisionReceiptPayload }
  | { valid: false; reason: 'malformed' | 'signature' | 'expired' };

export function deriveProvisionReceiptSecret(serviceToken: string): string {
  return createHash('sha256').update(serviceToken).digest('hex');
}

export function createProvisionReceipt(options: CreateProvisionReceiptOptions): string {
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const exp = options.expiresAt ?? nowSeconds + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  if (!options.secret || !Number.isFinite(exp)) {
    throw new Error('Provision receipt secret and expiration are required');
  }

  const payload: ProvisionReceiptPayload = {
    typ: 'xpod-provision-receipt',
    podName: options.podName,
    webId: options.webId,
    podUrl: options.podUrl,
    exp,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${data}.${sign(data, options.secret)}`;
}

export function verifyProvisionReceipt(
  receipt: string | undefined | null,
  options: VerifyProvisionReceiptOptions,
): VerifyProvisionReceiptResult {
  if (typeof receipt !== 'string' || !options.secret) {
    return { valid: false, reason: 'malformed' };
  }

  const dotIndex = receipt.indexOf('.');
  if (dotIndex <= 0 || dotIndex === receipt.length - 1 || receipt.indexOf('.', dotIndex + 1) !== -1) {
    return { valid: false, reason: 'malformed' };
  }

  const data = receipt.slice(0, dotIndex);
  const signature = receipt.slice(dotIndex + 1);
  if (!safeEqual(signature, sign(data, options.secret))) {
    return { valid: false, reason: 'signature' };
  }

  let payload: ProvisionReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as ProvisionReceiptPayload;
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

  return { valid: true, payload };
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidPayload(value: unknown): value is ProvisionReceiptPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const payload = value as Partial<ProvisionReceiptPayload>;
  return payload.typ === 'xpod-provision-receipt'
    && typeof payload.podName === 'string'
    && payload.podName.length > 0
    && typeof payload.webId === 'string'
    && payload.webId.length > 0
    && typeof payload.podUrl === 'string'
    && payload.podUrl.length > 0
    && typeof payload.exp === 'number'
    && Number.isFinite(payload.exp);
}
