import { webcrypto } from 'node:crypto';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from './KeyWrapper';

const LOCAL_MASTER_KEY_BYTES = 32;
const LOCAL_WRAP_NONCE_BYTES = 12;

export const LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE = 'xpod.ai-gateway.local-keychain-dek-wrap';
export const LOCAL_KEYCHAIN_WRAP_AAD_VERSION = 'v1';

export interface LocalSecureStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  getOrCreateSecret?(key: string, create: () => Promise<string>): Promise<string>;
}

export interface LocalKeychainWrapperOptions {
  secureStore: LocalSecureStore;
  keyId: string;
  keyVersion?: string;
}

/**
 * @deprecated Compatibility-only adapter. Production Xpod bootstrap uses the
 * generic Pod SecretCell keyring configured through XPOD_SECRET_CELL_*.
 */
export class LocalKeychainWrapper implements KeyWrapper {
  private readonly secureStore: LocalSecureStore;
  private readonly keyId: string;
  private readonly keyVersion?: string;

  public constructor(options: LocalKeychainWrapperOptions) {
    this.secureStore = options.secureStore;
    this.keyId = options.keyId;
    this.keyVersion = options.keyVersion;
  }

  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    const masterKey = await this.getOrCreateMasterKey();
    try {
      const nonce = webcrypto.getRandomValues(new Uint8Array(LOCAL_WRAP_NONCE_BYTES));
      const cryptoKey = await importMasterKey(masterKey, ['encrypt']);
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: localWrapAad(context, this.keyId) },
        cryptoKey,
        dek,
      ));

      return {
        algorithm: 'local-keychain-aes-256-gcm',
        keyId: this.keyId,
        keyVersion: this.keyVersion,
        wrappedDek: encodeBase64Url(ciphertext),
        metadata: {
          nonce: encodeBase64Url(nonce),
          purpose: LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE,
          version: LOCAL_KEYCHAIN_WRAP_AAD_VERSION,
        },
      };
    } finally {
      // This wipes only the decoded master-key bytes owned by this wrapper call.
      // The secure-store string and WebCrypto internal/native copies are outside
      // JavaScript's reliable zeroization boundary.
      masterKey.fill(0);
    }
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    if (wrapped.algorithm !== 'local-keychain-aes-256-gcm') {
      throw new Error('unsupported local keychain wrap algorithm');
    }
    const nonce = wrapped.metadata?.nonce;
    if (!nonce) {
      throw new Error('missing local keychain wrap nonce');
    }
    if (
      wrapped.metadata?.purpose !== LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE
      || wrapped.metadata?.version !== LOCAL_KEYCHAIN_WRAP_AAD_VERSION
    ) {
      throw new Error('local keychain wrap domain mismatch');
    }
    const masterKey = await this.getExistingMasterKey(wrapped.keyId);
    try {
      const cryptoKey = await importMasterKey(masterKey, ['decrypt']);
      const dek = await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decodeBase64Url(nonce),
          additionalData: localWrapAad(context, wrapped.keyId),
        },
        cryptoKey,
        decodeBase64Url(wrapped.wrappedDek),
      );
      return new Uint8Array(dek);
    } finally {
      masterKey.fill(0);
    }
  }

  private async getOrCreateMasterKey(): Promise<Uint8Array> {
    if (this.secureStore.getOrCreateSecret) {
      return decodeBase64Url(await this.secureStore.getOrCreateSecret(
        this.keyId,
        async () => generateMasterKeySecret(),
      ));
    }
    return decodeBase64Url(await getOrCreateLocalSecret(this.secureStore, this.keyId));
  }

  private async getExistingMasterKey(keyId: string): Promise<Uint8Array> {
    const existing = await this.secureStore.getSecret(keyId);
    if (!existing) {
      throw new Error('missing local keychain master key');
    }
    return decodeBase64Url(existing);
  }
}

async function importMasterKey(keyMaterial: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return await webcrypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyMaterial),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

function localWrapAad(context: KeyWrapContext, keyId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    purpose: LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE,
    version: LOCAL_KEYCHAIN_WRAP_AAD_VERSION,
    keyId,
    webId: context.webId,
    credentialIri: context.credentialIri,
    provider: context.provider,
  }));
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

const localMasterKeyInitializers = new Map<string, Promise<string>>();

async function getOrCreateLocalSecret(secureStore: LocalSecureStore, keyId: string): Promise<string> {
  const existing = await secureStore.getSecret(keyId);
  if (existing) {
    return existing;
  }

  const running = localMasterKeyInitializers.get(keyId);
  if (running) {
    return await running;
  }

  const created = (async (): Promise<string> => {
    const existingInsideSingleflight = await secureStore.getSecret(keyId);
    if (existingInsideSingleflight) {
      return existingInsideSingleflight;
    }
    const secret = generateMasterKeySecret();
    await secureStore.setSecret(keyId, secret);
    return secret;
  })();
  localMasterKeyInitializers.set(keyId, created);
  try {
    return await created;
  } finally {
    if (localMasterKeyInitializers.get(keyId) === created) {
      localMasterKeyInitializers.delete(keyId);
    }
  }
}

function generateMasterKeySecret(): string {
  const key = webcrypto.getRandomValues(new Uint8Array(LOCAL_MASTER_KEY_BYTES));
  try {
    return encodeBase64Url(key);
  } finally {
    key.fill(0);
  }
}
