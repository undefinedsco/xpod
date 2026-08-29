import type { CredentialVault, GatewayPrincipal, ProviderSecret } from './CredentialVault';
import { CredentialVaultError } from './CredentialVault';
import type { EncryptedCredentialSecret } from './KeyWrapper';

const PLAINTEXT_ALGORITHM = 'PLAINTEXT' as const;

/**
 * Stores the user-owned provider configuration as plain JSON in the Pod.
 *
 * The record shape remains compatible with the existing credential schema so
 * encrypted records can coexist during migration, but no encryption or
 * deployment root key is involved.
 */
export class PlaintextCredentialVault implements CredentialVault {
  private readonly legacyVault?: CredentialVault;

  public constructor(options: { legacyVault?: CredentialVault } = {}) {
    this.legacyVault = options.legacyVault;
  }

  public async seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<EncryptedCredentialSecret> {
    const serialized = JSON.stringify(secret);
    return {
      algorithm: PLAINTEXT_ALGORITHM,
      // RDF literal readers may unescape nested JSON quotes. Keep the secret
      // payload opaque so the outer credential envelope remains valid JSON
      // after a Pod write/read roundtrip.
      encoding: 'base64',
      aadPurpose: 'xpod-provider-credential',
      aadVersion: 'v1',
      ciphertext: Buffer.from(serialized, 'utf8').toString('base64'),
      nonce: '',
      webId: principal.webId,
      credentialIri,
      provider,
      dekWrapAlgorithm: PLAINTEXT_ALGORITHM,
      keyId: 'plaintext',
      wrappedDek: '',
    };
  }

  public async open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    stored: EncryptedCredentialSecret,
  ): Promise<ProviderSecret> {
    if (stored.algorithm !== PLAINTEXT_ALGORITHM) {
      if (!this.legacyVault) {
        throw new CredentialVaultError('Legacy encrypted credential requires its previous decryption key');
      }
      return this.legacyVault.open(principal, credentialIri, provider, stored);
    }
    if (
      stored.webId !== principal.webId
      || stored.credentialIri !== credentialIri
      || stored.provider !== provider
    ) {
      throw new CredentialVaultError('Credential plaintext context mismatch');
    }
    try {
      const encoding = (stored as EncryptedCredentialSecret & { encoding?: unknown }).encoding;
      const serialized = encoding === 'base64'
        ? Buffer.from(stored.ciphertext, 'base64').toString('utf8')
        : stored.ciphertext;
      const parsed: unknown = JSON.parse(serialized);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('credential value is not an object');
      }
      return parsed as ProviderSecret;
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('Credential plaintext could not be read');
    }
  }

  public async rewrap(
    principal: GatewayPrincipal,
    stored: EncryptedCredentialSecret,
  ): Promise<EncryptedCredentialSecret> {
    if (stored.algorithm === PLAINTEXT_ALGORITHM) {
      await this.open(principal, stored.credentialIri, stored.provider, stored);
      return stored;
    }
    const secret = await this.open(principal, stored.credentialIri, stored.provider, stored);
    return this.seal(principal, stored.credentialIri, stored.provider, secret);
  }

  public needsRewrap(stored: EncryptedCredentialSecret): boolean {
    return stored.algorithm !== PLAINTEXT_ALGORITHM;
  }
}
