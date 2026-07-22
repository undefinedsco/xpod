import { webcrypto } from 'node:crypto';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from './KeyWrapper';

const LOCAL_MASTER_KEY_BYTES = 32;
const LOCAL_WRAP_NONCE_BYTES = 12;

export interface LocalSecureStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
}

export interface LocalKeychainWrapperOptions {
  secureStore: LocalSecureStore;
  keyId: string;
  keyVersion?: string;
}

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
      metadata: { nonce: encodeBase64Url(nonce) },
    };
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    if (wrapped.algorithm !== 'local-keychain-aes-256-gcm') {
      throw new Error('unsupported local keychain wrap algorithm');
    }
    const nonce = wrapped.metadata?.nonce;
    if (!nonce) {
      throw new Error('missing local keychain wrap nonce');
    }
    const masterKey = await this.getExistingMasterKey(wrapped.keyId);
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
  }

  private async getOrCreateMasterKey(): Promise<Uint8Array> {
    const existing = await this.secureStore.getSecret(this.keyId);
    if (existing) {
      return decodeBase64Url(existing);
    }
    const key = webcrypto.getRandomValues(new Uint8Array(LOCAL_MASTER_KEY_BYTES));
    await this.secureStore.setSecret(this.keyId, encodeBase64Url(key));
    return key;
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
