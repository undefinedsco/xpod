export interface KeyWrapContext {
  webId: string;
  credentialIri: string;
  provider: string;
}

export interface WrappedDataKey {
  algorithm: string;
  keyId: string;
  keyVersion?: string;
  wrappedDek: string;
  metadata?: Record<string, string>;
}

export interface EncryptedCredentialSecret extends WrappedDataKey {
  algorithm: 'AES-256-GCM';
  aadPurpose: string;
  aadVersion: string;
  ciphertext: string;
  nonce: string;
  webId: string;
  credentialIri: string;
  provider: string;
  dekWrapAlgorithm: string;
}

export interface KeyWrapper {
  wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey>;
  unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array>;
}
