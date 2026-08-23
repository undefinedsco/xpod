export interface GatewayPrincipal {
  webId: string;
}

export type ProviderSecret = Record<string, unknown>;

export interface StoredCredentialSecret {
  webId: string;
  credentialIri: string;
  provider: string;
  secret: ProviderSecret;
}

export interface CredentialVault {
  seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<StoredCredentialSecret>;

  open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    stored: StoredCredentialSecret,
  ): Promise<ProviderSecret>;
}

export class CredentialVaultError extends Error {
  public constructor(message = 'Credential secret could not be read') {
    super(message);
    this.name = 'CredentialVaultError';
  }
}
