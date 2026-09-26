import { getLoggerFor } from 'global-logger-factory';
import type { CredentialVault } from '../credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../credentials/KeyWrapper';
import type { PodInterfaceKeyRecord, PodInterfaceKeyRepositoryPort } from '../../../identity/drizzle/PodInterfaceKeyRepository';

/** The owner's own Pod interface credential: the same kind of key a browser holds. */
export interface PodInterfaceCredential {
  clientId: string;
  clientSecret: string;
}

/**
 * Grants, or withdraws, the interface key server-side components use for an owner.
 *
 * The browser is where a Pod credential is created, so it is also where the decision to let
 * Xpod use it is made; this is the API that decision arrives through.
 */
export interface PodInterfaceKeyGrant {
  saveKey(owner: string, credential: PodInterfaceCredential): Promise<void>;
  forgetKey(owner: string): Promise<void>;
  hasKey(owner: string): Promise<boolean>;
}

/** Reads back the interface key an owner granted. */
export interface PodInterfaceKeySource {
  read(owner: string): Promise<PodInterfaceCredential | undefined>;
}

/** Everything a component needs to hold and use an owner's interface key. */
export interface PodInterfaceKeyAccess extends PodInterfaceKeySource, PodInterfaceKeyGrant {}

export const POD_INTERFACE_KEY_CORRUPT_PREFIX = 'pod_interface_key_corrupt';

export interface PodInterfaceKeyStoreOptions {
  repository: PodInterfaceKeyRepositoryPort;
  vault: CredentialVault;
  /** Vault identity the secret is sealed under. */
  credentialIri?: string;
}

const CREDENTIAL_IRI = 'urn:xpod:pod-interface-key';
const CREDENTIAL_PROVIDER = 'solid';

/**
 * Keeps the owner's Pod interface key for server-side use.
 *
 * The key is what opens the Pod, so it is sealed with the credential vault rather than kept in
 * the Pod. Storing it here is what lets a background component reach the Pod through the
 * standard interface as the owner, instead of asking the Solid server to trust its position.
 */
export class PodInterfaceKeyStore implements PodInterfaceKeyAccess {
  private readonly logger = getLoggerFor(this);
  private readonly repository: PodInterfaceKeyRepositoryPort;
  private readonly vault: CredentialVault;
  private readonly credentialIri: string;

  public constructor(options: PodInterfaceKeyStoreOptions) {
    this.repository = options.repository;
    this.vault = options.vault;
    this.credentialIri = options.credentialIri ?? CREDENTIAL_IRI;
  }

  /** Every owner with a stored key, for the migration into the task layer. */
  public async listOwners(): Promise<string[]> {
    const records = await this.repository.list();
    return records.map((record) => record.ownerWebId);
  }

  /** Store, or rotate, the owner's interface key. */
  public async saveKey(ownerWebId: string, credential: PodInterfaceCredential): Promise<void> {
    const sealed = await this.vault.seal(
      { webId: ownerWebId },
      this.credentialIri,
      CREDENTIAL_PROVIDER,
      { clientSecret: credential.clientSecret },
    );
    await this.repository.write({
      ownerWebId,
      clientId: credential.clientId,
      sealedSecret: JSON.stringify(sealed),
    });
    this.logger.debug(`Stored Pod interface key for ${ownerWebId}`);
  }

  public async forgetKey(ownerWebId: string): Promise<void> {
    await this.repository.remove(ownerWebId);
  }

  public async hasKey(ownerWebId: string): Promise<boolean> {
    return await this.repository.read(ownerWebId) !== undefined;
  }

  public async read(ownerWebId: string): Promise<PodInterfaceCredential | undefined> {
    const record = await this.repository.read(ownerWebId);
    return record ? await this.open(record) : undefined;
  }

  private async open(record: PodInterfaceKeyRecord): Promise<PodInterfaceCredential> {
    const sealed = parseSealedSecret(record.sealedSecret, record.ownerWebId);
    const opened = await this.vault.open(
      { webId: record.ownerWebId },
      this.credentialIri,
      CREDENTIAL_PROVIDER,
      sealed,
    );
    const clientSecret = opened.clientSecret;
    if (typeof clientSecret !== 'string' || !clientSecret) {
      throw new Error(`${POD_INTERFACE_KEY_CORRUPT_PREFIX}:${record.ownerWebId}`);
    }
    return { clientId: record.clientId, clientSecret };
  }
}

function parseSealedSecret(value: string, ownerWebId: string): EncryptedCredentialSecret {
  try {
    return JSON.parse(value) as EncryptedCredentialSecret;
  } catch {
    throw new Error(`${POD_INTERFACE_KEY_CORRUPT_PREFIX}:${ownerWebId}`);
  }
}
