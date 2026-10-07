/**
 * The Pod carrier for event reservations, against a scripted Pod.
 *
 * The scripted Pod is the same shape the sibling carriers are tested against: one record per
 * document in a day directory, container listings that name their members, and rows read and
 * updated through the database. What is under test is the boundary this class draws — reservations
 * in the Pod, ordering delegated — and the two failure modes that matter: no handle refuses, and a
 * record without a usable receipt is loud rather than a plausible-looking wrong answer.
 */
import { describe, expect, it } from 'vitest';
import { PodMatrixEventJournal } from '../../../src/api/matrix/PodMatrixEventJournal';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import type { MatrixControlRecordTarget } from '../../../src/api/matrix/controlRecords';

const POD = 'https://pod.example/alice/';
const SCOPE = POD;
const KEY = JSON.stringify([ 'XPODDEVICE', '!room:pod.example', 'm.room.message', 'txn-1' ]);

function scriptedPod(): { handle: MatrixControlRecordTarget; documents: Map<string, Record<string, unknown>> } {
  const documents = new Map<string, Record<string, unknown>>();
  const containers = new Set<string>();
  const db = {
    insert: () => ({ values: (row: Record<string, unknown>) => ({ execute: async() => {
      const [ path, fragment ] = String(row.id).split('#');
      documents.set(`${POD}.data/task/${path}#${fragment}`, row);
      return [ row ];
    } }) }),
    findByResource: async(_table: never, subject: string) => documents.get(subject) ?? null,
    updateByResource: async(_table: never, subject: string, patch: Record<string, unknown>) => {
      const existing = documents.get(subject);
      if (!existing) return null;
      Object.assign(existing, patch);
      return existing;
    },
    deleteByResource: async(_table: never, subject: string) => { documents.delete(subject); },
  };
  const fetch = async(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      if (containers.has(url)) return new Response('exists', { status: 409 });
      containers.add(url);
      return new Response(null, { status: 201 });
    }
    if (method === 'GET') {
      const members = [ ...documents.keys() ].filter(subject => subject.split('#')[0].startsWith(url));
      if (members.length === 0) return new Response('missing', { status: 404 });
      const list = members.map(subject => `<${subject.split('#')[0]}>`).join(', ');
      return new Response(`@prefix ldp: <http://www.w3.org/ns/ldp#>. <> ldp:contains ${list}.`,
        { status: 200, headers: { 'Content-Type': 'text/turtle' } });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { handle: { scope: SCOPE, write: { db, fetch } } as never, documents };
}

function journal() {
  return new PodMatrixEventJournal({ sequences: new InMemoryMatrixEventJournal() });
}

const HANDLE = (scope: string, write: unknown): MatrixControlRecordTarget => ({ scope, write }) as never;
/**
 * A moment inside the lookup window.
 *
 * The reservation's timestamp picks its day bucket, and `findReservation` looks back from *now*:
 * a fixed calendar date drifts out of the window as wall-clock time moves on, which is the
 * retention policy under test, not a fixture accident. Pinning this to the current clock keeps
 * the test about the boundary it names while leaving the production window untouched.
 */
const RECENT = Date.now();
const CANDIDATE = { eventId: '$reserved', createdAt: RECENT, contentHash: 'hash-a' };
const LOOKUP = { eventId: '$reserved', roomId: '!room:pod.example', type: 'm.room.message', txnId: 'txn-1', txnDevice: 'XPODDEVICE' };

describe('a Pod-backed event journal', () => {
  it('keeps a reservation in the Pod and returns the same one to a retry', async() => {
    const pod = scriptedPod();
    const first = await journal().reserveTransaction(SCOPE, KEY, CANDIDATE, pod.handle);
    expect(first).toEqual(CANDIDATE);

    // A second instance, as a restarted process would be: the Pod is the authority, and a retry
    // carrying a later proposal still adopts the reservation it finds.
    const retried = await journal().reserveTransaction(SCOPE, KEY, { ...CANDIDATE, createdAt: CANDIDATE.createdAt + 5_000 }, pod.handle);
    expect(retried).toEqual(CANDIDATE);
    expect(pod.documents.size).toBe(1);
  });

  it('finds the reservation from the event alone, and only for the transaction that owns it', async() => {
    const pod = scriptedPod();
    await journal().reserveTransaction(SCOPE, KEY, CANDIDATE, pod.handle);

    expect(await journal().findReservation(SCOPE, LOOKUP, pod.handle)).toEqual(CANDIDATE);
    // A different transaction id, or an event that never came from one, has no receipt — which must
    // stay distinguishable from "somebody else's receipt".
    expect(await journal().findReservation(SCOPE, { ...LOOKUP, txnId: 'other' }, pod.handle)).toBeUndefined();
    expect(await journal().findReservation(SCOPE, { eventId: '$peer' }, pod.handle)).toBeUndefined();
    expect((await journal().findReservations(SCOPE, [ LOOKUP, { eventId: '$peer' } ], pod.handle)).size).toBe(1);
  });

  it('replaces a reservation whose output was never written', async() => {
    const pod = scriptedPod();
    await journal().reserveTransaction(SCOPE, KEY, CANDIDATE, pod.handle);
    await journal().replaceReservation(SCOPE, KEY, { ...CANDIDATE, eventId: '$replacement', contentHash: 'hash-b' }, pod.handle);
    expect(await journal().findReservation(SCOPE, LOOKUP, pod.handle)).toEqual({ ...CANDIDATE, eventId: '$replacement', contentHash: 'hash-b' });
    await expect(journal().replaceReservation(SCOPE, 'no-such-key', CANDIDATE, pod.handle)).rejects.toThrow(/No reservation/u);
  });

  it('leaves ordering with the deployment, where it can be rebuilt from the Pod', async() => {
    const pod = scriptedPod();
    const instance = journal();
    expect(await instance.registerEvent(SCOPE, '!room:pod.example', '$one')).toBe(1);
    expect(await instance.registerEvents(SCOPE, '!room:pod.example', [ '$one', '$two' ])).toEqual([ 1, 2 ]);
    expect(await instance.getHighWatermark(SCOPE)).toBe(2);
  });

  it('refuses a scope it holds no grant for, and a record it cannot read', async() => {
    await expect(journal().reserveTransaction(SCOPE, KEY, CANDIDATE)).rejects.toThrow(/needs the caller's authority/u);
    const pod = scriptedPod();
    // A row under the record's subject that is not a reservation: loud, not a plausible answer.
    await journal().reserveTransaction(SCOPE, KEY, CANDIDATE, pod.handle);
    for (const [ subject, row ] of pod.documents) pod.documents.set(subject, { ...row, metadata: { unrelated: true } });
    await expect(journal().findReservation(SCOPE, LOOKUP, pod.handle)).rejects.toThrow(/no usable receipt/u);
  });
});
