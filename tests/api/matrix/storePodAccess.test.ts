import { describe, expect, it } from 'vitest';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import type { PodAccessRequestContext } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

const WEB_ID = 'https://alice.example/card#me';
const POD = 'https://pod.example/alice/';

/** A store whose Pod access is a spy: what it is asked for is what these tests are about. */
function storeWith(access: (owner: string, context: PodAccessRequestContext) => Promise<typeof fetch | undefined>) {
  const calls: { owner: string; context: PodAccessRequestContext }[] = [];
  const store = new PodMatrixStore({
    podAccess: {
      async getPodFetch(owner, context) {
        calls.push({ owner, context: context ?? {} });
        return await access(owner, context ?? {});
      },
    },
    journal: new InMemoryMatrixEventJournal(),
  });
  return { store, calls };
}

describe('who a Matrix write is done as', () => {
  it('refuses a context with no session and no deployment authority', async () => {
    const { store, calls } = storeWith(async () => undefined);
    await expect(store.listJoinedRooms({ webId: WEB_ID, podUrl: POD }))
      .rejects.toThrow(/Solid authentication is required/u);
    // Nothing is asked of the Pod accessor: there is nobody to ask for.
    expect(calls).toEqual([]);
  });

  it('asks the Pod for the participant\'s grant when the deployment works on its own behalf', async () => {
    const { store, calls } = storeWith(async () => undefined);
    // No grant is registered for this participant, so the store refuses and says whose Pod it is.
    await expect(store.listJoinedRooms({ webId: WEB_ID, podUrl: POD, service: {} }))
      .rejects.toThrow(/holds no grant for https:\/\/alice\.example\/card#me's Pod/u);
    // It asked with the task-layer grant, not with a session or a deployment-held key.
    expect(calls).toEqual([ {
      owner: WEB_ID,
      context: { taskCredential: {}, podBaseUrl: POD },
    } ]);
  });

  it('passes a named grant through, so a frozen credential can be honoured', async () => {
    const { store, calls } = storeWith(async () => undefined);
    await expect(store.listJoinedRooms({ webId: WEB_ID, podUrl: POD, service: { taskCredential: { credentialRef: 'grant-1', version: 3 } } }))
      .rejects.toThrow(/holds no grant/u);
    expect(calls[0].context.taskCredential).toEqual({ credentialRef: 'grant-1', version: 3 });
  });

  it('refuses a context that is both a caller session and deployment work', async () => {
    const { store, calls } = storeWith(async () => undefined);
    await expect(store.listJoinedRooms({
      webId: WEB_ID,
      podUrl: POD,
      auth: { type: 'solid', webId: WEB_ID, clientId: 'device-a' },
      service: {},
    })).rejects.toThrow(/cannot be both a caller session and deployment work/u);
    expect(calls).toEqual([]);
  });
});
