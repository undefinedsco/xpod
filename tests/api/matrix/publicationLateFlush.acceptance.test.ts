import { describe, expect, it } from 'vitest';
import { InMemoryMatrixOutboundStore, MatrixOutbox } from '../../../src/api/matrix/federation/outboundQueue';
import type { MatrixDeliveryOutcome } from '../../../src/api/matrix/federation/outboundTransaction';

const scope = 'https://root.example/late-flush/';
const base = { scope, origin: 'root.example', destination: 'peer.example' };
const binding = { purpose: 'membership' as const, credentialRef: 'root-flush-grant', version: 1, issuer: 'https://issuer.example/' };
const oldActor = { webId: `${scope}profile/card#me`, podUrl: scope, taskCredential: binding };
const newActor = { ...oldActor, taskCredential: { ...binding, version: 2 } };
const event = { event_id: '$root-flush-fixed', sender: oldActor.webId, room_id: '!root-late',
  type: 'co.undefineds.membership.authority', state_key: '', origin_server_ts: 1790985600000, content: binding };

describe('root late publication sender cannot resurrect a retired authority', () => {
  it.each([ 'retry', 'partial-refusal' ] as const)('does not recreate G1 after G2 replaces it when the old request returns %s', async(kind) => {
    const store = new InMemoryMatrixOutboundStore();
    let release!: (outcome: MatrixDeliveryOutcome) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<MatrixDeliveryOutcome>(resolve => { release = resolve; });
    let sequence = 0;
    const queue = new MatrixOutbox({ store, newTransactionId: () => `root-flush-${++sequence}`,
      now: () => 1790985600000, send: async() => { started(); return response; } });
    await queue.enqueue({ ...base, actor: oldActor, pdus: [ event ] });
    const oldBatch = (await store.pending(scope))[0];
    const flushing = queue.flush({ scope });
    await entered;
    await queue.enqueue({ ...base, actor: newActor, pdus: [ event ] });
    expect((await store.pending(scope)).map(batch => batch.actor)).toEqual([ newActor ]);
    release({ origin: base.origin, destination: base.destination, txnId: oldBatch.txnId,
      status: kind === 'retry' ? 'retry' : 'delivered', reason: 'Root controlled late response',
      ...(kind === 'partial-refusal' ? { pdus: { [event.event_id]: { error: 'late missing dependency' } } } : {}) });
    await flushing;
    const final = await store.pending(scope);
    expect(final).toHaveLength(1);
    expect(final[0].actor).toEqual(newActor);
    expect(final[0].pdus).toEqual([ event ]);
  });
});
