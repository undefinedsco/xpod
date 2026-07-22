import type { EncryptedCredentialSecret } from './KeyWrapper';

export interface GatewayPrincipal {
  webId: string;
}

export type ProviderSecret = Record<string, unknown>;

export interface CredentialVault {
  seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<EncryptedCredentialSecret>;

  open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    encrypted: EncryptedCredentialSecret,
  ): Promise<ProviderSecret>;

  rewrap(
    principal: GatewayPrincipal,
    encrypted: EncryptedCredentialSecret,
  ): Promise<EncryptedCredentialSecret>;
}

export class CredentialVaultError extends Error {
  public constructor(message = 'Credential secret could not be decrypted') {
    super(message);
    this.name = 'CredentialVaultError';
  }
}
