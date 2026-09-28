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

describe('the Pod handle a caller outside the store needs', () => {
  it('resolves the authority once per context and hands back the same fetch', async () => {
    // Everything a request touches must go through one Pod identity: the control-record carrier
    // makes its own HTTP writes (a reservation is a conditional request), and it has to use the
    // fetch the database was built over rather than resolving a second one.
    const calls: { owner: string; context: PodAccessRequestContext }[] = [];
    const podFetch: typeof fetch = async() => new Response('', { status: 200 });
    const store = new PodMatrixStore({
      podAccess: {
        async getPodFetch(owner, context) {
          calls.push({ owner, context: context ?? {} });
          return podFetch;
        },
      },
      journal: new InMemoryMatrixEventJournal(),
    });

    const context = { webId: WEB_ID, podUrl: POD, service: {} };
    const first = await store.podWriteFor(context);
    const second = await store.podWriteFor(context);
    expect(second.fetch).toBe(podFetch);
    expect(second.db).toBe(first.db);
    // One exchange, not one per caller: the context is the unit of authority.
    expect(calls).toHaveLength(1);
    expect(calls[0].context.taskCredential).toEqual({});
  });

  it('refuses a database that was injected without the fetch it stands for', async () => {
    // Half an authority is worse than none: reads would work and a conditional write would have
    // nothing to go through, which is exactly the write a reservation is.
    const store = new PodMatrixStore({ journal: new InMemoryMatrixEventJournal() });
    await expect(store.podWriteFor({ webId: WEB_ID, podUrl: POD, auth: { type: 'solid', webId: WEB_ID, clientId: 'device-a' }, _matrixDb: {} } as never))
      .rejects.toThrow(/carries no Pod fetch/u);
  });

  it('does not borrow a session for work the deployment does on its own behalf', async () => {
    const { store, calls } = storeWith(async() => undefined);
    await expect(store.podWriteFor({ webId: WEB_ID, podUrl: POD, service: {} }))
      .rejects.toThrow(/holds no grant for/u);
    expect(calls).toEqual([ { owner: WEB_ID, context: { taskCredential: {}, podBaseUrl: POD } } ]);
  });

  it('resolves which Pod a control record belongs to together with its authority', async () => {
    const { store } = storeWith(async() => async() => new Response('', { status: 200 }));
    const handle = await store.controlRecordHandleFor({ webId: WEB_ID, podUrl: POD, service: {} });
    expect(handle.scope).toBe(POD);
    // Scope and authority come from the same resolution: a record cannot be aimed at one Pod and
    // written with another's authority.
    expect(handle.write.fetch).toBeTypeOf('function');
  });

  it('refuses a control record for a context that names no Pod', async () => {
    const { store } = storeWith(async() => async() => new Response('', { status: 200 }));
    await expect(store.controlRecordHandleFor({ webId: WEB_ID, service: {} }))
      .rejects.toThrow(/needs the Pod it belongs to/u);
  });
});
