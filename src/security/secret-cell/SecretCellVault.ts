import { webcrypto } from 'node:crypto';
import type { DeploymentRootKeyProvider } from './DeploymentRootKeyProvider';

const TEXT_ENCODER = new TextEncoder();
const AES_GCM_ALGORITHM = 'AES-256-GCM' as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const PAYLOAD_AAD_PURPOSE = 'xpod.secret-cell.payload';
const DEK_WRAP_AAD_PURPOSE = 'xpod.secret-cell.dek-wrap';
const AAD_VERSION = 'v1';
const DEK_WRAP_ALGORITHM = 'xpod-secret-cell-root-hkdf-aes-256-gcm';

export interface SecretCellContext {
  ownerWebId: string;
  resourceIri: string;
  predicate: string;
  field: string;
  schemaVersion: string;
  provider?: string;
  extra?: Record<string, string>;
}

export interface SecretCellWrappedDataKey {
  algorithm: typeof DEK_WRAP_ALGORITHM;
  keyId: string;
  aadPurpose: typeof DEK_WRAP_AAD_PURPOSE;
  aadVersion: typeof AAD_VERSION;
  nonce: string;
  ciphertext: string;
}

export interface SecretCellEnvelope {
  algorithm: typeof AES_GCM_ALGORITHM;
  aadPurpose: typeof PAYLOAD_AAD_PURPOSE;
  aadVersion: typeof AAD_VERSION;
  context: SecretCellContext;
  nonce: string;
  ciphertext: string;
  wrappedDek: SecretCellWrappedDataKey;
}

export interface SecretCellVaultOptions {
  rootKeys: DeploymentRootKeyProvider;
}

export class SecretCellError extends Error {
  public constructor() {
    super('Secret cell operation failed');
    this.name = 'SecretCellError';
  }

  public toJSON(): { name: string; message: string } {
    return {
      name: this.name,
      message: this.message,
    };
  }
}

export class SecretCellVault {
  private readonly rootKeys: DeploymentRootKeyProvider;

  public constructor(options: SecretCellVaultOptions) {
    this.rootKeys = options.rootKeys;
  }

  public needsRewrap(keyId: string): boolean {
    return keyId !== this.rootKeys.getActiveKeyId();
  }

  public async seal(plaintext: Uint8Array, context: SecretCellContext): Promise<SecretCellEnvelope> {
    const normalizedContext = normalizeContext(context);
    const dek = webcrypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    try {
      const key = await importAesGcmKey(dek, ['encrypt']);
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: payloadAad(normalizedContext),
        },
        key,
        toArrayBuffer(plaintext),
      ));
      return {
        algorithm: AES_GCM_ALGORITHM,
        aadPurpose: PAYLOAD_AAD_PURPOSE,
        aadVersion: AAD_VERSION,
        context: normalizedContext,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
        wrappedDek: await this.wrapDataKey(dek, normalizedContext),
      };
    } catch (_error) {
      throw new SecretCellError();
    } finally {
      dek.fill(0);
    }
  }

  public async open(envelope: SecretCellEnvelope, context: SecretCellContext): Promise<Uint8Array> {
    let dek: Uint8Array | undefined;
    try {
      const normalizedContext = this.assertEnvelopeContext(envelope, context);
      dek = await this.unwrapDataKey(envelope.wrappedDek, normalizedContext);
      const key = await importAesGcmKey(dek, ['decrypt']);
      const plaintext = await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decodeBase64Url(envelope.nonce),
          additionalData: payloadAad(normalizedContext),
        },
        key,
        decodeBase64Url(envelope.ciphertext),
      );
      return new Uint8Array(plaintext);
    } catch (_error) {
      throw new SecretCellError();
    } finally {
      dek?.fill(0);
    }
  }

  public async rewrap(envelope: SecretCellEnvelope, context: SecretCellContext): Promise<SecretCellEnvelope> {
    let dek: Uint8Array | undefined;
    try {
      const normalizedContext = this.assertEnvelopeContext(envelope, context);
      dek = await this.unwrapDataKey(envelope.wrappedDek, normalizedContext);
      return {
        ...envelope,
        wrappedDek: await this.wrapDataKey(dek, normalizedContext),
      };
    } catch (_error) {
      throw new SecretCellError();
    } finally {
      dek?.fill(0);
    }
  }

  public async wrapDataKey(dek: Uint8Array, context: SecretCellContext): Promise<SecretCellWrappedDataKey> {
    const normalizedContext = normalizeContext(context);
    const active = this.rootKeys.getActiveKey();
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    try {
      const key = await deriveRootWrapKey(active.key, active.keyId);
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: dekWrapAad(normalizedContext, active.keyId),
        },
        key,
        toArrayBuffer(dek),
      ));
      return {
        algorithm: DEK_WRAP_ALGORITHM,
        keyId: active.keyId,
        aadPurpose: DEK_WRAP_AAD_PURPOSE,
        aadVersion: AAD_VERSION,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
      };
    } catch (_error) {
      throw new SecretCellError();
    } finally {
      active.key.fill(0);
    }
  }

  public async unwrapDataKey(
    wrapped: SecretCellWrappedDataKey,
    context: SecretCellContext,
  ): Promise<Uint8Array> {
    try {
      if (
        wrapped.algorithm !== DEK_WRAP_ALGORITHM
        || wrapped.aadPurpose !== DEK_WRAP_AAD_PURPOSE
        || wrapped.aadVersion !== AAD_VERSION
      ) {
        throw new Error('SecretCell wrapped DEK domain mismatch');
      }
      const root = this.rootKeys.getKey(wrapped.keyId);
      if (!root) {
        throw new Error('SecretCell root key is not configured');
      }
      try {
        const key = await deriveRootWrapKey(root.key, root.keyId);
        const dek = await webcrypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: decodeBase64Url(wrapped.nonce),
            additionalData: dekWrapAad(normalizeContext(context), root.keyId),
          },
          key,
          decodeBase64Url(wrapped.ciphertext),
        );
        return new Uint8Array(dek);
      } finally {
        root.key.fill(0);
      }
    } catch (_error) {
      throw new SecretCellError();
    }
  }

  private assertEnvelopeContext(envelope: SecretCellEnvelope, context: SecretCellContext): SecretCellContext {
    const normalizedContext = normalizeContext(context);
    if (
      envelope.algorithm !== AES_GCM_ALGORITHM
      || envelope.aadPurpose !== PAYLOAD_AAD_PURPOSE
      || envelope.aadVersion !== AAD_VERSION
      || canonicalJson(normalizeContext(envelope.context)) !== canonicalJson(normalizedContext)
    ) {
      throw new Error('SecretCell envelope context mismatch');
    }
    return normalizedContext;
  }
}

async function importAesGcmKey(keyMaterial: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return await webcrypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyMaterial),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function deriveRootWrapKey(rootKey: Uint8Array, keyId: string): Promise<CryptoKey> {
  const hkdfKey = await webcrypto.subtle.importKey('raw', toArrayBuffer(rootKey), 'HKDF', false, ['deriveKey']);
  return await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: TEXT_ENCODER.encode(`xpod.secret-cell.root.${keyId}`),
      info: TEXT_ENCODER.encode(`${DEK_WRAP_AAD_PURPOSE}.${AAD_VERSION}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function payloadAad(context: SecretCellContext): Uint8Array {
  return TEXT_ENCODER.encode(canonicalJson({
    purpose: PAYLOAD_AAD_PURPOSE,
    version: AAD_VERSION,
    context,
  }));
}

function dekWrapAad(context: SecretCellContext, keyId: string): Uint8Array {
  return TEXT_ENCODER.encode(canonicalJson({
    purpose: DEK_WRAP_AAD_PURPOSE,
    version: AAD_VERSION,
    keyId,
    context,
  }));
}

export function normalizeContext(context: SecretCellContext): SecretCellContext {
  const normalized: SecretCellContext = {
    ownerWebId: requireContextField(context.ownerWebId, 'ownerWebId'),
    resourceIri: requireContextField(context.resourceIri, 'resourceIri'),
    predicate: requireContextField(context.predicate, 'predicate'),
    field: requireContextField(context.field, 'field'),
    schemaVersion: requireContextField(context.schemaVersion, 'schemaVersion'),
  };
  if (context.provider !== undefined) {
    normalized.provider = requireContextField(context.provider, 'provider');
  }
  if (context.extra !== undefined) {
    normalized.extra = {};
    for (const [key, value] of Object.entries(context.extra).sort(([left], [right]) => left.localeCompare(right))) {
      normalized.extra[requireContextField(key, 'extra key')] = requireContextField(value, `extra.${key}`);
    }
  }
  return normalized;
}

function requireContextField(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SecretCell context ${name} is required`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }
  return value;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
