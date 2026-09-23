import { PlaintextCredentialVault } from '../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { PodInterfaceKeyStore } from '../../src/api/ai-gateway/pod/PodInterfaceKeyStore';
import { createTestSolidSessions } from './solidSessions';
import type {
  PodInterfaceKeyRecord,
  PodInterfaceKeyRepositoryPort,
} from '../../src/identity/drizzle/PodInterfaceKeyRepository';

/** In-memory stand-in for the identity-db key store; the exchange and Pod traffic stay real. */
export class InMemoryInterfaceKeyRepository implements PodInterfaceKeyRepositoryPort {
  private readonly records = new Map<string, PodInterfaceKeyRecord>();

  public async read(ownerWebId: string): Promise<PodInterfaceKeyRecord | undefined> {
    return this.records.get(ownerWebId);
  }

  public async write(record: Omit<PodInterfaceKeyRecord, 'createdAt' | 'updatedAt'>): Promise<void> {
    this.records.set(record.ownerWebId, { ...record, createdAt: new Date(0), updatedAt: new Date(0) });
  }

  public async remove(ownerWebId: string): Promise<void> {
    this.records.delete(ownerWebId);
  }
}

/**
 * Real Pod access for an integration test: the actual provider, the actual vault envelope, and
 * the owner's actual client credentials. Only the key store's persistence is in memory.
 */
export async function createInterfaceKeyPodAccess(input: {
  webId: string;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  publicBaseUrl?: string;
}): Promise<{ podAccess: OwnerPodAccess; keys: PodInterfaceKeyStore }> {
  const keys = new PodInterfaceKeyStore({
    repository: new InMemoryInterfaceKeyRepository(),
    vault: new PlaintextCredentialVault(),
  });
  await keys.saveKey(input.webId, { clientId: input.clientId, clientSecret: input.clientSecret });
  return {
    keys,
    podAccess: new OwnerPodAccess({
      keys,
      sessions: createTestSolidSessions({
        tokenEndpoint: input.tokenEndpoint,
        ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
      }),
    }),
  };
}
