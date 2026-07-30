import {
  type SecretCellContext,
  type SecretCellVault,
  type SecretCellWrappedDataKey,
} from '../../../security/secret-cell';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from './KeyWrapper';

export interface SecretCellKeyWrapperOptions {
  vault: SecretCellVault;
  predicate: string;
  field: string;
  schemaVersion: string;
}

/**
 * Compatibility adapter for callers that still compose WebCryptoCredentialVault.
 * Production container wiring uses SecretCellCredentialVault directly.
 */
export class SecretCellKeyWrapper implements KeyWrapper {
  private readonly vault: SecretCellVault;
  private readonly predicate: string;
  private readonly field: string;
  private readonly schemaVersion: string;

  public constructor(options: SecretCellKeyWrapperOptions) {
    this.vault = options.vault;
    this.predicate = options.predicate;
    this.field = options.field;
    this.schemaVersion = options.schemaVersion;
  }

  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    const secretCellContext = this.toSecretCellContext(context);
    const wrapped = await this.vault.wrapDataKey(dek, secretCellContext);
    return {
      algorithm: wrapped.algorithm,
      keyId: wrapped.keyId,
      wrappedDek: Buffer.from(JSON.stringify(wrapped)).toString('base64url'),
      metadata: {
        aadPurpose: wrapped.aadPurpose,
        aadVersion: wrapped.aadVersion,
        nonce: wrapped.nonce,
        predicate: secretCellContext.predicate,
        field: secretCellContext.field,
        schemaVersion: secretCellContext.schemaVersion,
        provider: secretCellContext.provider ?? '',
      },
    };
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    if (wrapped.algorithm !== 'xpod-secret-cell-root-hkdf-aes-256-gcm') {
      throw new Error('unsupported SecretCell key wrapper algorithm');
    }
    return await this.vault.unwrapDataKey(this.decodeWrappedDataKey(wrapped), this.toSecretCellContext(context));
  }

  private toSecretCellContext(context: KeyWrapContext): SecretCellContext {
    return {
      ownerWebId: context.webId,
      resourceIri: context.credentialIri,
      predicate: this.predicate,
      field: this.field,
      schemaVersion: this.schemaVersion,
      provider: context.provider,
    };
  }

  private decodeWrappedDataKey(wrapped: WrappedDataKey): SecretCellWrappedDataKey {
    const parsed = JSON.parse(Buffer.from(wrapped.wrappedDek, 'base64url').toString('utf8')) as SecretCellWrappedDataKey;
    return {
      algorithm: parsed.algorithm,
      keyId: parsed.keyId,
      aadPurpose: parsed.aadPurpose,
      aadVersion: parsed.aadVersion,
      nonce: parsed.nonce,
      ciphertext: parsed.ciphertext,
    };
  }
}
