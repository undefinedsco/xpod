import { webcrypto } from 'node:crypto';
import type { CredentialVault, GatewayPrincipal, ProviderSecret } from './CredentialVault';
import { CredentialVaultError } from './CredentialVault';
import type { EncryptedCredentialSecret, KeyWrapContext, KeyWrapper, WrappedDataKey } from './KeyWrapper';

const AES_GCM_ALGORITHM = 'AES-256-GCM' as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;

export interface CredentialVaultLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface WebCryptoCredentialVaultOptions {
  keyWrapper: KeyWrapper;
  logger?: CredentialVaultLogger;
}

export class WebCryptoCredentialVault implements CredentialVault {
  private readonly keyWrapper: KeyWrapper;
  private readonly logger?: CredentialVaultLogger;

  public constructor(options: WebCryptoCredentialVaultOptions) {
    this.keyWrapper = options.keyWrapper;
    this.logger = options.logger;
  }

  public async seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<EncryptedCredentialSecret> {
    const context = this.createContext(principal, credentialIri, provider);
    const dek = webcrypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const key = await importAesGcmKey(dek, ['encrypt']);
    const plaintext = new TextEncoder().encode(JSON.stringify(secret));
    const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aadFor(context) },
      key,
      plaintext,
    ));
    const wrapped = await this.keyWrapper.wrapDek(context, dek);

    return {
      algorithm: AES_GCM_ALGORITHM,
      ciphertext: encodeBase64Url(ciphertext),
      nonce: encodeBase64Url(nonce),
      webId: context.webId,
      credentialIri: context.credentialIri,
      provider: context.provider,
      dekWrapAlgorithm: wrapped.algorithm,
      keyId: wrapped.keyId,
      keyVersion: wrapped.keyVersion,
      wrappedDek: wrapped.wrappedDek,
      metadata: wrapped.metadata,
    };
  }

  public async open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    encrypted: EncryptedCredentialSecret,
  ): Promise<ProviderSecret> {
    try {
      const context = this.assertContext(principal, credentialIri, provider, encrypted);
      const wrapped = wrappedDataKeyFromEncrypted(encrypted);
      const dek = await this.keyWrapper.unwrapDek(context, wrapped);
      const key = await importAesGcmKey(dek, ['decrypt']);
      const plaintext = new Uint8Array(await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decodeBase64Url(encrypted.nonce),
          additionalData: aadFor(context),
        },
        key,
        decodeBase64Url(encrypted.ciphertext),
      ));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('decrypted credential secret is not an object');
      }
      return parsed as ProviderSecret;
    } catch (error) {
      this.logOpenFailure(principal, credentialIri, provider, error);
      throw new CredentialVaultError();
    }
  }

  public async rewrap(
    principal: GatewayPrincipal,
    encrypted: EncryptedCredentialSecret,
  ): Promise<EncryptedCredentialSecret> {
    try {
      const context = this.assertContext(principal, encrypted.credentialIri, encrypted.provider, encrypted);
      const dek = await this.keyWrapper.unwrapDek(context, wrappedDataKeyFromEncrypted(encrypted));
      const wrapped = await this.keyWrapper.wrapDek(context, dek);
      return {
        ...encrypted,
        dekWrapAlgorithm: wrapped.algorithm,
        keyId: wrapped.keyId,
        keyVersion: wrapped.keyVersion,
        wrappedDek: wrapped.wrappedDek,
        metadata: wrapped.metadata,
      };
    } catch (error) {
      this.logRewrapFailure(principal, encrypted, error);
      throw new CredentialVaultError('Credential secret could not be rewrapped');
    }
  }

  private createContext(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
  ): KeyWrapContext {
    return {
      webId: principal.webId,
      credentialIri,
      provider,
    };
  }

  private assertContext(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    encrypted: EncryptedCredentialSecret,
  ): KeyWrapContext {
    const context = this.createContext(principal, credentialIri, provider);
    if (
      encrypted.algorithm !== AES_GCM_ALGORITHM
      || encrypted.webId !== context.webId
      || encrypted.credentialIri !== context.credentialIri
      || encrypted.provider !== context.provider
    ) {
      throw new Error('credential encryption context mismatch');
    }
    return context;
  }

  private logOpenFailure(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    error: unknown,
  ): void {
    this.logger?.warn('Failed to open encrypted credential secret', {
      webId: principal.webId,
      credentialIri,
      provider,
      reason: safeErrorName(error),
    });
  }

  private logRewrapFailure(
    principal: GatewayPrincipal,
    encrypted: EncryptedCredentialSecret,
    error: unknown,
  ): void {
    this.logger?.warn('Failed to rewrap encrypted credential secret', {
      webId: principal.webId,
      credentialIri: encrypted.credentialIri,
      provider: encrypted.provider,
      reason: safeErrorName(error),
    });
  }
}

function wrappedDataKeyFromEncrypted(encrypted: EncryptedCredentialSecret): WrappedDataKey {
  return {
    algorithm: encrypted.dekWrapAlgorithm,
    keyId: encrypted.keyId,
    keyVersion: encrypted.keyVersion,
    wrappedDek: encrypted.wrappedDek,
    metadata: encrypted.metadata,
  };
}

function aadFor(context: KeyWrapContext): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    webId: context.webId,
    credentialIri: context.credentialIri,
    provider: context.provider,
  }));
}

async function importAesGcmKey(
  keyMaterial: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return await webcrypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyMaterial),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
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

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
