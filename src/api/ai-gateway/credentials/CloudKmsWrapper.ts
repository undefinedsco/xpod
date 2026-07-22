import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from './KeyWrapper';

export interface CloudKmsEncryptInput {
  keyArn: string;
  plaintext: Uint8Array;
  encryptionContext: Record<string, string>;
}

export interface CloudKmsDecryptInput {
  keyArn?: string;
  ciphertext: Uint8Array;
  encryptionContext: Record<string, string>;
}

export interface CloudKmsClient {
  encrypt(input: CloudKmsEncryptInput): Promise<{
    ciphertext: Uint8Array;
    keyId?: string;
    keyVersion?: string;
  }>;

  decrypt(input: CloudKmsDecryptInput): Promise<{
    plaintext: Uint8Array;
    keyId?: string;
    keyVersion?: string;
  }>;
}

export interface CloudKmsWrapperOptions {
  kmsClient: CloudKmsClient;
  keyArn: string;
}

export class CloudKmsWrapper implements KeyWrapper {
  private readonly kmsClient: CloudKmsClient;
  private readonly keyArn: string;

  public constructor(options: CloudKmsWrapperOptions) {
    this.kmsClient = options.kmsClient;
    this.keyArn = options.keyArn;
  }

  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    const encrypted = await this.kmsClient.encrypt({
      keyArn: this.keyArn,
      plaintext: dek,
      encryptionContext: kmsEncryptionContext(context),
    });

    return {
      algorithm: 'cloud-kms',
      keyId: encrypted.keyId ?? this.keyArn,
      keyVersion: encrypted.keyVersion,
      wrappedDek: Buffer.from(encrypted.ciphertext).toString('base64url'),
      metadata: { keyArn: this.keyArn },
    };
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    if (wrapped.algorithm !== 'cloud-kms') {
      throw new Error('unsupported cloud KMS wrap algorithm');
    }
    const decrypted = await this.kmsClient.decrypt({
      keyArn: wrapped.metadata?.keyArn ?? this.keyArn,
      ciphertext: new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url')),
      encryptionContext: kmsEncryptionContext(context),
    });
    return decrypted.plaintext;
  }
}

function kmsEncryptionContext(context: KeyWrapContext): Record<string, string> {
  return {
    webId: context.webId,
    credentialIri: context.credentialIri,
    provider: context.provider,
  };
}
