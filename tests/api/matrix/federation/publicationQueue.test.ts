import { describe, expect, it, vi } from 'vitest';
import { InMemoryMatrixOutboundStore, MatrixOutbox, type MatrixOutboundBatch } from '../../../../src/api/matrix/federation/outboundQueue';
import { decodeOutboundBatch, encodeOutboundBatch } from '../../../../src/api/matrix/federation/outboundBatches';

const scope = 'https://pod.example/owner/';
const owner = `${scope}profile/card#me`;
const issuer = 'https://issuer.example/';
const binding = { purpose: 'membership' as const, credentialRef: 'taskcred_publication', version: 1, issuer };
const event = { event_id: '$publication', room_id: '!fixture', sender: owner,
  type: 'co.undefineds.membership.authority', state_key: '', content: binding,
  origin_server_ts: 1, prev_events: [], auth_events: [], depth: 1, hashes: { sha256: 'fixture' } };
const actor = (version: number) => ({ webId: owner, podUrl: scope, taskCredential: { ...binding, version } });
const old: MatrixOutboundBatch = { txnId: 'old', origin: 'pod.example', destination: 'peer.example',
  pdus: [ event ], edus: [], createdAt: 1, attempts: 0, actor: actor(1) };

async function fixture() {
  const store = new InMemoryMatrixOutboundStore();
  await store.put(scope, old);
  const send = vi.fn(async() => ({ status: 'delivered' as const }));
  const box = new MatrixOutbox({ store, send: send as never, now: () => 2, newTransactionId: () => 'new' });
  const input = { scope, origin: old.origin, destination: old.destination, pdus: [ event ], actor: actor(2) };
  return { store, box, input, send };
}

describe('publication-only queue named authority recovery', () => {
  it('persists the new actor before removing the old single-event batch', async() => {
    const { store, box, input, send } = await fixture();
    const remove = vi.spyOn(store, 'removePublicationExact');
    const put = vi.spyOn(store, 'put');
    await box.enqueue(input);
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(await store.pending(scope)).toEqual([ { ...old, txnId: 'new', createdAt: 2, actor: actor(2) } ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('recovers an unknown put outcome by reading the actual new complete batch', async() => {
    const { store, box, input } = await fixture();
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementationOnce(async(s, batch) => { await put(s, batch); throw new Error('Lost put response'); });
    await box.enqueue(input);
    expect((await store.pending(scope)).map(batch => batch.txnId)).toEqual([ 'new' ]);
  });

  it('keeps the old batch when a successful put did not persist the new actor/PDU', async() => {
    const { store, box, input } = await fixture();
    vi.spyOn(store, 'put').mockResolvedValue(undefined);
    const remove = vi.spyOn(store, 'removePublicationExact');
    await expect(box.enqueue(input)).rejects.toMatchObject({ status: 409 });
    expect(await store.pending(scope)).toEqual([ old ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('resumes cleanup without another new transaction after interruption', async() => {
    const { store, box, input } = await fixture();
    vi.spyOn(store, 'removePublicationExact').mockRejectedValueOnce(new Error('Cleanup interrupted'));
    await expect(box.enqueue(input)).rejects.toThrow('Cleanup interrupted');
    expect((await store.pending(scope)).map(batch => batch.txnId)).toEqual([ 'old', 'new' ]);
    await box.enqueue(input);
    expect((await store.pending(scope)).map(batch => batch.txnId)).toEqual([ 'new' ]);
  });

  it('refuses a mixed old batch before changing anything', async() => {
    const { store, box, input } = await fixture();
    const mixed = { ...old, pdus: [ event, { ...event, event_id: '$unrelated' } ] };
    await store.put(scope, mixed);
    const put = vi.spyOn(store, 'put');
    const remove = vi.spyOn(store, 'removePublicationExact');
    await expect(box.enqueue(input)).rejects.toMatchObject({ status: 409 });
    expect(await store.pending(scope)).toEqual([ mixed ]);
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps ordinary O1 events out of publication singleton batches', async() => {
    const { store, box } = await fixture();
    await box.enqueue({ scope, origin: old.origin, destination: old.destination,
      pdus: [ { ...event, event_id: '$ordinary', type: 'm.room.message', content: { body: 'ordinary' } } ],
      actor: { webId: owner, podUrl: scope, taskCredential: { credentialRef: binding.credentialRef, version: 1 } } });
    expect((await store.pending(scope)).map(batch => batch.pdus.length)).toEqual([ 1, 1 ]);
  });

  it('roundtrips the complete nonsecret publication marker through the durable batch decoder', () => {
    const encoded = encodeOutboundBatch(old);
    const record = { key: 'fixture', kind: 'outbound', bucket: '2026/10/03', resource: `${scope}batch.ttl`,
      subject: `${scope}batch.ttl#self`, ...encoded };
    expect(decodeOutboundBatch(record as never)?.actor).toEqual(actor(1));
    for (const taskCredential of [ { ...binding, issuer: '' }, { ...binding, purpose: 'execution' },
      { purpose: 'membership', issuer, credentialRef: binding.credentialRef } ]) {
      const bad = { ...record, metadata: { ...record.metadata, actor: { ...actor(1), taskCredential } } };
      expect(() => decodeOutboundBatch(bad as never)).toThrow();
    }
  });
});


describe('publication late delivery results', () => {
  for (const outcome of [ { status: 'deferred', reason: '503' },
    { status: 'delivered', pdus: { '$publication': { error: 'retry' } } } ] as const) {
    it(`does not resurrect a removed old authority after ${outcome.status}`, async() => {
      const store = new InMemoryMatrixOutboundStore();
      await store.put(scope, old);
      let finish!: (value: unknown) => void;
      let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const send = vi.fn(async() => { started(); return await new Promise(resolve => { finish = resolve; }); });
      const box = new MatrixOutbox({ store, send: send as never, now: () => 2, newTransactionId: () => 'new' });
      const flushing = box.flush({ scope });
      await began;
      await box.enqueue({ scope, origin: old.origin, destination: old.destination, pdus: [ event ], actor: actor(2) });
      finish(outcome);
      await flushing;
      expect((await store.pending(scope)).map(batch => batch.actor)).toEqual([ actor(2) ]);
    });
  }
});


it('fails closed when another foreign authority batch appears during final cleanup', async() => {
  const { store, box, input } = await fixture();
  const remove = store.removePublicationExact.bind(store);
  vi.spyOn(store, 'removePublicationExact').mockImplementationOnce(async(s, expected) => {
    await remove(s, expected);
    await store.put(s, { ...old, txnId: 'late-foreign' });
  });
  await expect(box.enqueue(input)).rejects.toMatchObject({ status: 409 });
  expect((await store.pending(scope)).map(batch => batch.txnId)).toEqual([ 'late-foreign', 'new' ]);
});
