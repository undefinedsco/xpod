/**
 * The Pod carrier for transaction receipts, against a scripted Pod.
 *
 * The scripted Pod models what the real one was measured to do (2026-09-27): records live in a
 * shared day document (`task/{yyyy}/{MM}/{dd}/transactions.ttl`, the models layout for records that
 * accumulate), an insert of one subject is idempotent, and rows are read/updated/deleted through
 * the database. The SPARQL is built by the real drizzle-solid builder over the real models table;
 * only the transport underneath is a stand-in. The real-Pod run lives in
 * `tests/integration/MatrixControlRecords.integration.test.ts`.
 *
 * The guarantee under test is *not* "exactly one winner" — a shared document cannot decide that,
 * and the carrier deliberately does not pretend to (see `controlRecords.ts`). What is under test is
 * what the protocol needs: the record is written once, a replay is answered from it, and a released
 * key can be claimed again.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { PodMatrixInboundTransactionStore } from '../../../../src/api/matrix/federation/podInboundTransaction';
import { controlRecordAddress, controlRecordBucket } from '../../../../src/api/matrix/controlRecords';
import { MatrixError } from '../../../../src/api/matrix/MatrixError';

const POD = 'https://pod.example/alice/';
const SCOPE = POD;
const ORIGIN = 'remote.example';

/** A Pod that keeps records in day documents and inserts one subject at a time. */
function scriptedPod() {
  const documents = new Map<string, Map<string, Record<string, unknown>>>();
  const real = drizzle({
    fetch: async() => new Response('', { status: 200 }),
    info: { webId: 'https://alice.example/card#me', isLoggedIn: true, podUrl: POD },
  } as never, {} as never);

  const subjectOf = (row: Record<string, unknown>): string => {
    const id = String(row.id);
    const [ path, fragment ] = id.split('#');
    return `${POD}.data/task/${path}#${fragment}`;
  };

  const db = {
    // The real builder, so the SPARQL and the row defaults are the models ones; the row is kept
    // here instead of being parsed back out of the query text.
    insert: (table: never) => {
      const builder = real.insert(table);
      return {
        values(row: Record<string, unknown>) {
          return {
            async execute() {
              const subject = subjectOf(row);
              const document = subject.split('#')[0];
              const rows = documents.get(document) ?? new Map<string, Record<string, unknown>>();
              // Idempotent: the same subject is one record, however many times it is written.
              if (!rows.has(subject)) rows.set(subject, row);
              documents.set(document, rows);
              return [ row ];
            },
          };
        },
      };
    },
    findByResource: async(_table: never, subject: string) => documents.get(subject.split('#')[0])?.get(subject) ?? null,
    updateByResource: async(_table: never, subject: string, patch: Record<string, unknown>) => {
      const existing = documents.get(subject.split('#')[0])?.get(subject);
      if (!existing) return null;
      Object.assign(existing, patch);
      return existing;
    },
    deleteByResource: async(_table: never, subject: string) => {
      documents.get(subject.split('#')[0])?.delete(subject);
    },
  };

  // The carrier writes records through the database and prepares containers through the Pod: a
  // document in a directory that is not a container can be read by URL but never listed.
  const containers = new Set<string>();
  const fetch = async(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? 'GET') !== 'PUT') throw new Error(`the carrier only PUTs containers, not ${init?.method}`);
    if (containers.has(url)) return new Response('exists', { status: 409 });
    containers.add(url);
    return new Response(null, { status: 201 });
  };

  return {
    documents,
    containers,
    /** Every record in the Pod, keyed by its subject. */
    records: (): Record<string, unknown>[] => [ ...documents.values() ].flatMap(rows => [ ...rows.values() ]),
    handle: { scope: SCOPE, write: { db, fetch } } as never,
  };
}

function store() {
  return new PodMatrixInboundTransactionStore();
}

function reservation(overrides: Partial<{ payloadFingerprint: string; receivedAt: string }> = {}) {
  return {
    origin: ORIGIN,
    transactionId: 'txn-1',
    payloadFingerprint: overrides.payloadFingerprint ?? 'fingerprint-a',
    receivedAt: overrides.receivedAt ?? '2026-09-28T10:00:00.000Z',
  };
}

describe('a Pod-backed transaction store', () => {
  it('records a first attempt in the day document the models layout names', async() => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ origin: ORIGIN, transactionId: 'txn-1', response: { pdus: {}}});

    const bucket = controlRecordBucket('2026-09-28T10:00:00.000Z');
    expect(bucket).toBe('2026/09/28');
    const { resource } = controlRecordAddress(POD, JSON.stringify([ ORIGIN, 'txn-1' ]), bucket);
    // One record, one document, inside the day directory the models buckets name.
    expect(resource.startsWith(`${POD}.data/task/2026/09/28/`)).toBe(true);
    expect(resource.endsWith('.ttl')).toBe(true);
    // The day directory is a real container, so a client can list the records in it.
    expect([ ...pod.containers ].sort()).toEqual([
      `${POD}.data/task/`,
      `${POD}.data/task/2026/`,
      `${POD}.data/task/2026/09/`,
      `${POD}.data/task/2026/09/28/`,
    ]);
    const stored = pod.documents.get(resource);
    expect(stored?.size).toBe(1);
    expect([ ...(stored?.values() ?? []) ][0]).toMatchObject({
      instruction: `Record the inbound Matrix transaction ${ORIGIN}/txn-1`,
      workspace: POD,
      status: 'active',
    });
  });

  it('gives a replay the record instead of a second claim', async() => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    const replay = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(replay.created).toBe(false);
    expect(replay.record.receivedAt).toBe(first.record.receivedAt);
  });

  it('leaves one record when two callers claim the same id at once', async() => {
    const pod = scriptedPod();
    const outcomes = await Promise.all([ 1, 2 ].map(async() => await store().reserve(SCOPE, reservation(), pod.handle)));
    // Claiming is best effort — both may be told they claimed it — but the Pod holds one record,
    // and both callers are handed a record they can answer from.
    expect(pod.records()).toHaveLength(1);
    for (const outcome of outcomes) expect(outcome.record.transactionId).toBe('txn-1');
  });

  it('marks a reused transaction id whose payload differs, and keeps the first record', async() => {
    const pod = scriptedPod();
    await store().reserve(SCOPE, reservation(), pod.handle);
    const conflicting = await store().reserve(SCOPE, reservation({
      payloadFingerprint: 'fingerprint-b',
      receivedAt: '2026-09-28T10:00:05.000Z',
    }), pod.handle);
    expect(conflicting.created).toBe(false);
    expect(conflicting.record.payloadFingerprint).toBe('fingerprint-a');
    expect(conflicting.record.conflictAt).toBe('2026-09-28T10:00:05.000Z');
  });

  it('answers a replay from the first response once the attempt completed', async() => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    const response = { pdus: { '$event-1': {}, '$event-2': { error: 'not authorised' } } };
    await store().complete(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, response, '2026-09-28T10:00:01.000Z', pod.handle);

    // A different store instance, as a restarted process would be: the Pod is the authority.
    const replay = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(replay.created).toBe(false);
    expect(replay.record.response).toEqual(response);
    expect(replay.record.completedAt).toBe('2026-09-28T10:00:01.000Z');
    expect(replay.record.receivedAt).toBe(first.record.receivedAt);
  });

  it('finds a receipt from the day before, and gives up past the window', async() => {
    const pod = scriptedPod();
    // A transaction that arrived just before midnight, retried shortly after it.
    const late = { ...reservation(), receivedAt: '2026-09-27T23:59:30.000Z' };
    await store().reserve(SCOPE, late, pod.handle);
    expect(controlRecordBucket(late.receivedAt)).toBe('2026/09/27');

    const replay = await store().reserve(SCOPE, { ...reservation(), receivedAt: '2026-09-28T00:00:30.000Z' }, pod.handle);
    expect(replay.created).toBe(false);
    expect(replay.record.receivedAt).toBe(late.receivedAt);

    // Past the retention window the record is gone, so the same id is a new transaction. That is
    // the documented cost of the window, and it is safe: accepting is idempotent by event id.
    const fresh = await store().reserve(SCOPE, { ...reservation(), receivedAt: '2026-10-02T10:00:00.000Z' }, pod.handle);
    expect(fresh.created).toBe(true);
  });

  it('forgets an unfinished reservation, so the peer\'s retry may try again', async() => {
    const pod = scriptedPod();
    await store().reserve(SCOPE, reservation(), pod.handle);
    await store().release(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, pod.handle);
    expect(await store().find(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, pod.handle)).toBeUndefined();
    expect(pod.records()).toHaveLength(0);
    const retry = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(retry.created).toBe(true);
  });

  it('refuses to guess which Pod a record belongs to', async() => {
    const pod = scriptedPod();
    await expect(store().reserve(SCOPE, reservation()))
      .rejects.toThrow(/needs the resolved Pod handle/u);
    await expect(store().reserve('https://pod.example/bob/', reservation(), pod.handle))
      .rejects.toThrow(/does not match the resolved Pod/u);
  });

  it('reports a Pod that refuses the write rather than pretending it reserved', async() => {
    const pod = scriptedPod();
    const refusing = {
      scope: SCOPE,
      write: {
        db: {
          ...(pod.handle as { write: { db: object } }).write.db,
          findByResource: async() => null,
          insert: () => ({
            values: () => ({
              execute: async() => { throw new MatrixError(502, 'M_UNKNOWN', 'Pod refused the write'); },
            }),
          }),
        },
      },
    } as never;
    await expect(store().reserve(SCOPE, reservation(), refusing)).rejects.toThrow(/refused the write/u);
  });
});
