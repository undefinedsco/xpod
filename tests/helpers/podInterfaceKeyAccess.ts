import { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { createTestSolidSessions } from './solidSessions';
import type { SolidAuthContext } from '../../src/api/auth/AuthContext';
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

  public async list(): Promise<PodInterfaceKeyRecord[]> {
    return [ ...this.records.values() ];
  }

  public async write(record: Omit<PodInterfaceKeyRecord, 'createdAt' | 'updatedAt'>): Promise<void> {
    this.records.set(record.ownerWebId, { ...record, createdAt: new Date(0), updatedAt: new Date(0) });
  }

  public async remove(ownerWebId: string): Promise<void> {
    this.records.delete(ownerWebId);
  }
}

/** A caller the API authenticated with its own API key: the owner's interface key rides along. */
export type OwnerInterfaceKeyAuth = SolidAuthContext & {
  clientId: string;
  clientSecret: string;
  viaApiKey: true;
};

/**
 * Real Pod access for an integration test: the actual provider, the actual token exchange, and
 * the owner's actual interface key. Only the request that carries the key is built here.
 *
 * The API stores no key of its own (`docs/pod-interface-key.md` decision 7), so the credential
 * travels with the request: `auth` is the shape `ClientCredentialsAuthenticator` produces once a
 * caller has presented its API key, and `OwnerPodAccess` exchanges it for a Pod token this
 * process can prove. No access token is attached on purpose - the one an exchange yields is
 * bound to the key pair that asked for it, which is exactly what a caller cannot hand over.
 */
export async function createInterfaceKeyPodAccess(input: {
  webId: string;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  publicBaseUrl?: string;
}): Promise<{ podAccess: OwnerPodAccess; auth: OwnerInterfaceKeyAuth }> {
  return {
    podAccess: new OwnerPodAccess({
      sessions: createTestSolidSessions({
        tokenEndpoint: input.tokenEndpoint,
        ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
      }),
    }),
    auth: {
      type: 'solid',
      webId: input.webId,
      accountId: input.webId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      viaApiKey: true,
      tokenType: 'DPoP',
    },
  };
}
