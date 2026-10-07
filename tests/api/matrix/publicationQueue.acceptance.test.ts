import { describe, expect, it, vi } from 'vitest';
import { InMemoryMatrixOutboundStore, MatrixOutbox } from '../../../src/api/matrix/federation/outboundQueue';

const scope = 'https://owner.example/pod/';
const base = { scope, origin: 'owner.example', destination: 'peer.example' };
const owner = `${scope}profile/card#me`;
const binding = { purpose: 'membership' as const, credentialRef: 'root-current-grant', version: 1,
  issuer: 'https://issuer.example/' };
const oldActor = { webId: owner, podUrl: scope, taskCredential: binding };
const newActor = { ...oldActor, taskCredential: { ...binding, version: 2 } };
const pdu = { event_id: '$root-published', room_id: '!root-source', sender: owner,
  type: 'co.undefineds.membership.authority', state_key: '', origin_server_ts: 1790985600000,
  content: binding, prev_events: [], auth_events: [], depth: 1 };
function fixture() {
  const store = new InMemoryMatrixOutboundStore();
  let sequence = 0;
  const queue = new MatrixOutbox({ store, send: async() => { throw new Error('No network in queue decision acceptance'); },
    now: () => 1790985600000, newTransactionId: () => `root-txn-${++sequence}` });
  return { store, queue };
}

// This acceptance covers the public queue decision and durable readback contract with an
// injected carrier. It does not claim real Pod HTTP, background authentication, or delivery.
describe('root publication queue named-authority recovery', () => {
  it('moves a singleton original event to the newly approved version instead of swallowing it by event id', async() => {
    const { store, queue } = fixture();
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ pdu ] });
    await queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] });
    const batches = await store.pending(scope);
    expect(batches).toHaveLength(1);
    expect(batches[0].actor).toEqual(newActor);
    expect(batches[0].pdus).toEqual([ pdu ]);
  });

  it('recovers a lost new-batch response without losing the only durable original event', async() => {
    const { store, queue } = fixture();
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ pdu ] });
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementationOnce(async(s, batch) => {
      await put(s, batch);
      throw new Error('Root lost durable put response');
    });
    // A failed response may be recovered immediately by exact durable readback. Both a proven
    // success and a retryable failure are legal; silently losing the event or retaining only G1 is not.
    await queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] }).catch(() => undefined);
    expect((await store.pending(scope)).some(batch => batch.pdus.some(event => (event as typeof pdu).event_id === pdu.event_id))).toBe(true);
    await queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] });
    const recovered = await store.pending(scope);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].actor).toEqual(newActor);
  });

  it('does not remove the old batch when the carrier accepts without persisting the new batch', async() => {
    const { store, queue } = fixture();
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ pdu ] });
    vi.spyOn(store, 'put').mockResolvedValueOnce(undefined);
    await expect(queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] })).rejects.toBeDefined();
    const pending = await store.pending(scope);
    expect(pending).toHaveLength(1);
    expect(pending[0].actor).toEqual(oldActor);
  });

  it('retries obsolete-batch cleanup after its first removal fails', async() => {
    const { store, queue } = fixture();
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ pdu ] });
    vi.spyOn(store, 'removePublicationExact').mockRejectedValueOnce(new Error('Root interrupted cleanup'));
    await expect(queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] })).rejects.toThrow('interrupted cleanup');
    expect((await store.pending(scope)).some(batch => batch.actor?.taskCredential?.version === 2)).toBe(true);
    await queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] });
    expect((await store.pending(scope)).map(batch => batch.actor)).toEqual([ newActor ]);
  });

  it('refuses a mixed legacy batch without changing any other event authority', async() => {
    const { store, queue } = fixture();
    const mixed = { txnId: 'root-legacy-mixed', origin: base.origin, destination: base.destination,
      actor: oldActor, pdus: [ pdu, { ...pdu, event_id: '$other-event', type: 'm.room.message', content: { body: 'untouched' } } ],
      edus: [], createdAt: 1, attempts: 0 };
    await store.put(scope, mixed);
    await expect(queue.enqueue({ ...base, actor: newActor, pdus: [ pdu ] })).rejects.toBeDefined();
    expect(await store.pending(scope)).toEqual([ mixed ]);
  });

  it('keeps publication batches separate from ordinary work under the same grant', async() => {
    const { store, queue } = fixture();
    const ordinaryActor = { webId: owner, podUrl: scope, taskCredential: { credentialRef: binding.credentialRef, version: 1 } };
    await queue.enqueue({ ...base, actor: ordinaryActor,
      pdus: [ { ...pdu, event_id: '$ordinary', type: 'm.room.message', content: { body: 'keep' } } ] });
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ pdu ] });
    const batches = await store.pending(scope);
    expect(batches).toHaveLength(2);
    expect(batches.every(batch => batch.pdus.length === 1)).toBe(true);
  });
});
