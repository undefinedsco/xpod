import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type GatewayDeployment = 'local' | 'cloud';

export interface ParsedGatewayApiKey {
  version: 'v1';
  deployment: GatewayDeployment;
  keyId: string;
  secret: string;
}

export interface GatewayApiKeyRecordInput {
  id: string;
  secretHash: string;
  deployment: GatewayDeployment;
}

export interface CreatedGatewayApiKey {
  plaintext: string;
  secret: string;
  record: GatewayApiKeyRecordInput;
}

export interface CreateGatewayApiKeyInput {
  deployment: GatewayDeployment;
  keyId?: string;
  secret?: string;
}

const PREFIX = 'xpod_gw';
const VERSION = 'v1';
const SECRET_BYTES = 32;
const KEY_ID_BYTES = 18;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

export async function createGatewayApiKey(input: CreateGatewayApiKeyInput): Promise<CreatedGatewayApiKey> {
  const keyId = input.keyId ?? createGatewayKeyId();
  const secret = input.secret ?? randomBase64Url(SECRET_BYTES);
  const plaintext = formatGatewayApiKey({
    version: VERSION,
    deployment: input.deployment,
    keyId,
    secret,
  });
  return {
    plaintext,
    secret,
    record: {
      id: keyId,
      deployment: input.deployment,
      secretHash: await hashGatewayApiKeySecret(secret),
    },
  };
}

export function createGatewayKeyId(): string {
  return `gak_${randomBase64Url(KEY_ID_BYTES)}`;
}


export function formatGatewayApiKey(parsed: ParsedGatewayApiKey): string {
  assertDeployment(parsed.deployment);
  if (!parsed.keyId || parsed.keyId.includes(' ') || parsed.keyId.includes('/')) {
    throw new Error('Invalid Gateway API key id');
  }
  if (!parsed.secret || !/^[A-Za-z0-9-]+$/.test(parsed.secret)) {
    throw new Error('Invalid Gateway API key secret');
  }
  return `${PREFIX}_${parsed.version}_${parsed.deployment}_${parsed.keyId}_${parsed.secret}`;
}

export function parseGatewayApiKey(value: string): ParsedGatewayApiKey | undefined {
  const parts = value.split('_');
  if (parts.length < 6 || parts[0] !== 'xpod' || parts[1] !== 'gw' || parts[2] !== VERSION) {
    return undefined;
  }
  const deployment = parts[3];
  if (deployment !== 'local' && deployment !== 'cloud') {
    return undefined;
  }
  const secret = parts[parts.length - 1];
  const keyId = parts.slice(4, -1).join('_');
  if (!keyId || !secret || !/^[A-Za-z0-9-]+$/.test(secret)) {
    return undefined;
  }
  return {
    version: VERSION,
    deployment,
    keyId,
    secret,
  };
}

export async function hashGatewayApiKeySecret(secret: string): Promise<string> {
  const salt = randomBase64Url(16);
  const key = await deriveScrypt(secret, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    'v=1',
    `N=${SCRYPT_N}`,
    `r=${SCRYPT_R}`,
    `p=${SCRYPT_P}`,
    `salt=${salt}`,
    `key=${key.toString('base64url')}`,
  ].join('$');
}

export async function verifyGatewayApiKeySecret(secret: string, encodedHash: string): Promise<boolean> {
  const parsed = parseScryptHash(encodedHash);
  if (!parsed) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = await deriveScrypt(secret, parsed.salt, parsed.N, parsed.r, parsed.p);
  } catch {
    return false;
  }
  const expected = Buffer.from(parsed.key, 'base64url');
  if (actual.byteLength !== expected.byteLength) {
    const paddedActual = Buffer.alloc(SCRYPT_KEY_BYTES);
    const paddedExpected = Buffer.alloc(SCRYPT_KEY_BYTES);
    actual.copy(paddedActual, 0, 0, Math.min(actual.byteLength, SCRYPT_KEY_BYTES));
    expected.copy(paddedExpected, 0, 0, Math.min(expected.byteLength, SCRYPT_KEY_BYTES));
    timingSafeEqual(paddedActual, paddedExpected);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function parseScryptHash(encodedHash: string): {
  N: number;
  r: number;
  p: number;
  salt: string;
  key: string;
} | undefined {
  const parts = encodedHash.split('$');
  if (
    parts.length !== 7
    || parts[0] !== 'scrypt'
    || parts[1] !== 'v=1'
    || parts[2] !== `N=${SCRYPT_N}`
    || parts[3] !== `r=${SCRYPT_R}`
    || parts[4] !== `p=${SCRYPT_P}`
    || !parts[5]?.startsWith('salt=')
    || !parts[6]?.startsWith('key=')
  ) {
    return undefined;
  }
  const salt = parts[5].slice('salt='.length);
  const key = parts[6].slice('key='.length);
  if (!isBase64UrlBytes(salt, 16) || !isBase64UrlBytes(key, SCRYPT_KEY_BYTES)) {
    return undefined;
  }
  return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt, key };
}

function isBase64UrlBytes(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64url').byteLength === bytes;
  } catch {
    return false;
  }
}

async function deriveScrypt(
  secret: string,
  salt: string,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    scrypt(secret, salt, SCRYPT_KEY_BYTES, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    }, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url').replaceAll('_', '-');
}

function assertDeployment(deployment: string): asserts deployment is GatewayDeployment {
  if (deployment !== 'local' && deployment !== 'cloud') {
    throw new Error(`Invalid Gateway API key deployment: ${deployment}`);
  }
}
