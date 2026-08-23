import type { CredentialVault, GatewayPrincipal, ProviderSecret } from './CredentialVault';
import { CredentialVaultError } from './CredentialVault';
import type { StoredCredentialSecret } from './CredentialVault';

export class PlaintextCredentialVault implements CredentialVault {
  public async seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<StoredCredentialSecret> {
    return {
      webId: principal.webId,
      credentialIri,
      provider,
      secret: structuredClone(secret),
    };
  }

  public async open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    stored: StoredCredentialSecret,
  ): Promise<ProviderSecret> {
    if (
      stored.webId !== principal.webId
      || stored.credentialIri !== credentialIri
      || stored.provider !== provider
    ) {
      throw new CredentialVaultError('Credential plaintext context mismatch');
    }
    if (!stored.secret || typeof stored.secret !== 'object' || Array.isArray(stored.secret)) {
      throw new CredentialVaultError('Credential plaintext could not be read');
    }
    return structuredClone(stored.secret);
  }
}
