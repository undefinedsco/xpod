import type { CredentialVault, GatewayPrincipal, ProviderSecret } from './CredentialVault';
import { CredentialVaultError } from './CredentialVault';
import type { EncryptedCredentialSecret } from './KeyWrapper';
import {
  SecretCellVault,
  type SecretCellContext,
  type SecretCellEnvelope,
  type SecretCellWrappedDataKey,
} from '../../../security/secret-cell';

const PREDICATE = 'https://undefineds.co/ns#encryptedSecret';
const FIELD = 'providerCredentialSecret';
const SCHEMA_VERSION = 'v1';

export class SecretCellCredentialVault implements CredentialVault {
  private readonly vault: SecretCellVault;

  public constructor(options: { vault: SecretCellVault }) {
    this.vault = options.vault;
  }

  public async seal(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    secret: ProviderSecret,
  ): Promise<EncryptedCredentialSecret> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = new TextEncoder().encode(JSON.stringify(secret));
      const envelope = await this.vault.seal(
        plaintext,
        secretCellContext(principal.webId, credentialIri, provider),
      );
      return encryptedRecordFromEnvelope(envelope);
    } catch {
      throw new CredentialVaultError('Credential secret could not be encrypted');
    } finally {
      plaintext?.fill(0);
    }
  }

  public async open(
    principal: GatewayPrincipal,
    credentialIri: string,
    provider: string,
    encrypted: EncryptedCredentialSecret,
  ): Promise<ProviderSecret> {
    let plaintext: Uint8Array | undefined;
    try {
      assertCredentialContext(principal.webId, credentialIri, provider, encrypted);
      plaintext = await this.vault.open(
        envelopeFromEncryptedRecord(encrypted),
        secretCellContext(principal.webId, credentialIri, provider),
      );
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('decrypted credential secret is not an object');
      }
      return parsed as ProviderSecret;
    } catch {
      throw new CredentialVaultError();
    } finally {
      plaintext?.fill(0);
    }
  }

  public async rewrap(
    principal: GatewayPrincipal,
    encrypted: EncryptedCredentialSecret,
  ): Promise<EncryptedCredentialSecret> {
    try {
      assertCredentialContext(principal.webId, encrypted.credentialIri, encrypted.provider, encrypted);
      const envelope = await this.vault.rewrap(
        envelopeFromEncryptedRecord(encrypted),
        secretCellContext(principal.webId, encrypted.credentialIri, encrypted.provider),
      );
      return encryptedRecordFromEnvelope(envelope);
    } catch {
      throw new CredentialVaultError('Credential secret could not be rewrapped');
    }
  }

  public needsRewrap(encrypted: EncryptedCredentialSecret): boolean {
    return this.vault.needsRewrap(encrypted.keyId);
  }
}

function secretCellContext(ownerWebId: string, resourceIri: string, provider: string): SecretCellContext {
  return {
    ownerWebId,
    resourceIri,
    predicate: PREDICATE,
    field: FIELD,
    schemaVersion: SCHEMA_VERSION,
    provider,
  };
}

function assertCredentialContext(
  webId: string,
  credentialIri: string,
  provider: string,
  encrypted: EncryptedCredentialSecret,
): void {
  if (
    encrypted.webId !== webId
    || encrypted.credentialIri !== credentialIri
    || encrypted.provider !== provider
  ) {
    throw new Error('credential encryption context mismatch');
  }
}

function encryptedRecordFromEnvelope(envelope: SecretCellEnvelope): EncryptedCredentialSecret {
  return {
    algorithm: envelope.algorithm,
    aadPurpose: envelope.aadPurpose,
    aadVersion: envelope.aadVersion,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    webId: envelope.context.ownerWebId,
    credentialIri: envelope.context.resourceIri,
    provider: envelope.context.provider ?? '',
    dekWrapAlgorithm: envelope.wrappedDek.algorithm,
    keyId: envelope.wrappedDek.keyId,
    wrappedDek: envelope.wrappedDek.ciphertext,
    metadata: {
      secretCellWrapNonce: envelope.wrappedDek.nonce,
      secretCellWrapPurpose: envelope.wrappedDek.aadPurpose,
      secretCellWrapVersion: envelope.wrappedDek.aadVersion,
      predicate: envelope.context.predicate,
      field: envelope.context.field,
      schemaVersion: envelope.context.schemaVersion,
    },
  };
}

function envelopeFromEncryptedRecord(encrypted: EncryptedCredentialSecret): SecretCellEnvelope {
  const metadata = encrypted.metadata;
  if (
    !metadata?.secretCellWrapNonce
    || !metadata.secretCellWrapPurpose
    || !metadata.secretCellWrapVersion
    || !metadata.predicate
    || !metadata.field
    || !metadata.schemaVersion
  ) {
    throw new Error('SecretCell encrypted record metadata is incomplete');
  }
  return {
    algorithm: encrypted.algorithm,
    aadPurpose: encrypted.aadPurpose as SecretCellEnvelope['aadPurpose'],
    aadVersion: encrypted.aadVersion as SecretCellEnvelope['aadVersion'],
    context: {
      ownerWebId: encrypted.webId,
      resourceIri: encrypted.credentialIri,
      predicate: metadata.predicate,
      field: metadata.field,
      schemaVersion: metadata.schemaVersion,
      provider: encrypted.provider,
    },
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    wrappedDek: {
      algorithm: encrypted.dekWrapAlgorithm as SecretCellWrappedDataKey['algorithm'],
      keyId: encrypted.keyId,
      aadPurpose: metadata.secretCellWrapPurpose as SecretCellWrappedDataKey['aadPurpose'],
      aadVersion: metadata.secretCellWrapVersion as SecretCellWrappedDataKey['aadVersion'],
      nonce: metadata.secretCellWrapNonce,
      ciphertext: encrypted.wrappedDek,
    },
  };
}
