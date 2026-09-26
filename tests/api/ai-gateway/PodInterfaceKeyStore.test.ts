import { describe, expect, it, vi } from 'vitest';
import { PodInterfaceKeyStore } from '../../../src/api/ai-gateway/pod/PodInterfaceKeyStore';
import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import type {
  PodInterfaceKeyRecord,
  PodInterfaceKeyRepositoryPort,
} from '../../../src/identity/drizzle/PodInterfaceKeyRepository';

const OWNER = 'https://pod.example/alice/profile/card#me';
const CREDENTIAL = { clientId: 'xpod-alice', clientSecret: 'super-secret-value' };

class FakeRepository implements PodInterfaceKeyRepositoryPort {
  public record?: PodInterfaceKeyRecord;

  public async read(ownerWebId: string): Promise<PodInterfaceKeyRecord | undefined> {
    return this.record?.ownerWebId === ownerWebId ? this.record : undefined;
  }

  public async list(): Promise<PodInterfaceKeyRecord[]> {
    return this.record ? [ this.record ] : [];
  }

  public async write(record: Omit<PodInterfaceKeyRecord, 'createdAt' | 'updatedAt'>): Promise<void> {
    this.record = { ...record, createdAt: new Date(0), updatedAt: new Date(0) };
  }

  public async remove(ownerWebId: string): Promise<void> {
    if (this.record?.ownerWebId === ownerWebId) {
      this.record = undefined;
    }
  }
}

function createStore() {
  const repository = new FakeRepository();
  const vault = new PlaintextCredentialVault();
  const seal = vi.spyOn(vault, 'seal');
  return { repository, vault, seal, store: new PodInterfaceKeyStore({ repository, vault }) };
}

describe('PodInterfaceKeyStore', () => {
  it('seals the secret under the owner before storing it', async () => {
    const { repository, seal, store } = createStore();

    await store.saveKey(OWNER, CREDENTIAL);

    expect(seal).toHaveBeenCalledWith(
      { webId: OWNER },
      'urn:xpod:pod-interface-key',
      'solid',
      { clientSecret: CREDENTIAL.clientSecret },
    );
    expect(repository.record).toMatchObject({ ownerWebId: OWNER, clientId: CREDENTIAL.clientId });
    const envelope = JSON.parse(repository.record!.sealedSecret) as {
      webId: string;
      provider: string;
      credentialIri: string;
    };
    expect(envelope).toMatchObject({
      webId: OWNER,
      provider: 'solid',
      credentialIri: 'urn:xpod:pod-interface-key',
    });
    // The key opens the Pod, so what is persisted is the vault's envelope and not the raw pair.
    expect(repository.record!.sealedSecret).not.toContain(`${CREDENTIAL.clientId}:${CREDENTIAL.clientSecret}`);
  });

  it('reads back the credential it stored', async () => {
    const { store } = createStore();

    await store.saveKey(OWNER, CREDENTIAL);
    expect(await store.read(OWNER)).toEqual(CREDENTIAL);
    expect(await store.hasKey(OWNER)).toBe(true);
    expect(await store.read('https://pod.example/bob/profile/card#me')).toBeUndefined();
  });

  it('lists the owners it holds a key for, for the move into the task layer', async () => {
    const { store } = createStore();

    await store.saveKey(OWNER, CREDENTIAL);
    expect(await store.listOwners()).toEqual([ OWNER ]);

    await store.forgetKey(OWNER);
    expect(await store.listOwners()).toEqual([]);
  });

  it('rotates the stored key in place', async () => {
    const { repository, store } = createStore();

    await store.saveKey(OWNER, CREDENTIAL);
    await store.saveKey(OWNER, { clientId: 'xpod-alice-2', clientSecret: 'rotated-secret' });

    expect(repository.record).toMatchObject({ ownerWebId: OWNER, clientId: 'xpod-alice-2' });
    expect(await store.read(OWNER)).toEqual({ clientId: 'xpod-alice-2', clientSecret: 'rotated-secret' });
  });

  it('withdraws the key', async () => {
    const { repository, store } = createStore();

    await store.saveKey(OWNER, CREDENTIAL);
    await store.forgetKey(OWNER);

    expect(repository.record).toBeUndefined();
    expect(await store.hasKey(OWNER)).toBe(false);
    expect(await store.read(OWNER)).toBeUndefined();
  });

  it('reports an unreadable envelope instead of returning a useless credential', async () => {
    const { repository, store } = createStore();
    await store.saveKey(OWNER, CREDENTIAL);

    repository.record = { ...repository.record!, sealedSecret: 'not-json' };
    await expect(store.read(OWNER)).rejects.toThrow(`pod_interface_key_corrupt:${OWNER}`);
  });

  it('reports an envelope with no secret in it', async () => {
    const { repository, vault, store } = createStore();
    await store.saveKey(OWNER, CREDENTIAL);

    // A readable envelope that carries no secret is not a credential, whatever it decrypts to.
    const empty = await vault.seal({ webId: OWNER }, 'urn:xpod:pod-interface-key', 'solid', {});
    repository.record = { ...repository.record!, sealedSecret: JSON.stringify(empty) };
    await expect(store.read(OWNER)).rejects.toThrow(`pod_interface_key_corrupt:${OWNER}`);
  });
});
