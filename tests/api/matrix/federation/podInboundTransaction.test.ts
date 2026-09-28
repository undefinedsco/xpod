/**
 * The Pod carrier for transaction receipts, against a scripted Pod.
 *
 * The scripted Pod models the two facts the real one was measured to have (2026-09-27): a
 * conditional create (`If-None-Match: *`) succeeds once and answers 412 afterwards, and rows are
 * read/updated/deleted through the database. The SPARQL the store sends is built by the real
 * drizzle-solid builder over the real models table, so the row layout under test is the models
 * one; only the transport is a stand-in. The real-Pod run lives in
 * `tests/integration/MatrixControlRecords.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { PodMatrixInboundTransactionStore } from '../../../../src/api/matrix/federation/podInboundTransaction';
import { controlRecordAddress } from '../../../../src/api/matrix/controlRecords';
import { MatrixError } from '../../../../src/api/matrix/MatrixError';

const POD = 'https://pod.example/alice/';
const SCOPE = POD;
const ORIGIN = 'remote.example';

/** A Pod that keeps one document per record, enforces create-once, and needs its container. */
function scriptedPod() {
  const documents = new Map<string, Record<string, unknown>>();
  const containers = new Set<string>();
  let pending: Record<string, unknown> | undefined;
  const real = drizzle({
    fetch: async() => new Response('', { status: 200 }),
    info: { webId: 'https://alice.example/card#me', isLoggedIn: true, podUrl: POD },
  } as never, {} as never);

  const fetch = async(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    // A container has to exist before a record can live (and later be deleted) in it.
    if (method === 'PUT') {
      if (containers.has(url)) return new Response('exists', { status: 409 });
      containers.add(url);
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      if (!documents.has(url)) return new Response('missing', { status: 404 });
      documents.delete(url);
      return new Response(null, { status: 205 });
    }
    if (method !== 'PATCH') return new Response('unsupported', { status: 405 });
    const condition = new Headers(init?.headers).get('If-None-Match');
    if (condition !== '*') return new Response('unsupported condition', { status: 400 });
    if (documents.has(url)) return new Response('exists', { status: 412 });
    if (!pending) throw new Error('the scripted Pod was asked to create a document nobody built');
    documents.set(url, pending);
    return new Response(null, { status: 201 });
  };

  const db = {
    // The real builder, so the SPARQL and the row defaults are the models ones; the row is kept
    // here instead of being parsed back out of the query text.
    insert: (table: never) => {
      const builder = real.insert(table);
      return {
        values(row: Record<string, unknown>) {
          pending = row;
          return builder.values(row as never);
        },
      };
    },
    findByResource: async(_table: never, subject: string) => documents.get(subject.split('#')[0]) ?? null,
    updateByResource: async(_table: never, subject: string, patch: Record<string, unknown>) => {
      const document = documents.get(subject.split('#')[0]);
      if (!document) return null;
      Object.assign(document, patch);
      return document;
    },
    deleteByResource: async(_table: never, subject: string) => {
      documents.delete(subject.split('#')[0]);
    },
  };

  return { documents, containers, handle: { scope: SCOPE, write: { db, fetch } } as never };
}

function store() {
  return new PodMatrixInboundTransactionStore();
}

function reservation(overrides: Partial<{ payloadFingerprint: string; receivedAt: string }> = {}) {
  return {
    origin: ORIGIN,
    transactionId: 'txn-1',
    payloadFingerprint: overrides.payloadFingerprint ?? 'fingerprint-a',
    receivedAt: overrides.receivedAt ?? '2026-09-27T10:00:00.000Z',
  };
}

describe('a Pod-backed transaction store', () => {
  it('records a first attempt in the Pod and hands the key to exactly one caller', async () => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ origin: ORIGIN, transactionId: 'txn-1', response: { pdus: {}}});

    // The record is a document in the participant's own Pod, named after the key.
    const { resource } = controlRecordAddress(POD, JSON.stringify([ ORIGIN, 'txn-1' ]));
    expect(pod.documents.has(resource)).toBe(true);
    // The container is prepared first: without it the document could never be deleted again.
    expect(pod.containers.has(resource.slice(0, resource.lastIndexOf('/') + 1))).toBe(true);
    expect(pod.documents.get(resource)).toMatchObject({
      instruction: `Record the inbound Matrix transaction ${ORIGIN}/txn-1`,
      workspace: POD,
      status: 'active',
    });
  });

  it('gives a replay the winner\'s record instead of a second claim', async () => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    const replay = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(replay.created).toBe(false);
    expect(replay.record.receivedAt).toBe(first.record.receivedAt);
  });

  it('has one winner when two callers reserve the same id at once', async () => {
    const pod = scriptedPod();
    const outcomes = await Promise.all([ 1, 2 ].map(async() => await store().reserve(SCOPE, reservation(), pod.handle)));
    expect(outcomes.filter(outcome => outcome.created)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.created)).toHaveLength(1);
  });

  it('marks a reused transaction id whose payload differs, and keeps the first record', async () => {
    const pod = scriptedPod();
    await store().reserve(SCOPE, reservation(), pod.handle);
    const conflicting = await store().reserve(SCOPE, reservation({
      payloadFingerprint: 'fingerprint-b',
      receivedAt: '2026-09-27T10:00:05.000Z',
    }), pod.handle);
    expect(conflicting.created).toBe(false);
    expect(conflicting.record.payloadFingerprint).toBe('fingerprint-a');
    expect(conflicting.record.conflictAt).toBe('2026-09-27T10:00:05.000Z');
  });

  it('answers a replay from the first response once the attempt completed', async () => {
    const pod = scriptedPod();
    const first = await store().reserve(SCOPE, reservation(), pod.handle);
    const response = { pdus: { '$event-1': {}, '$event-2': { error: 'not authorised' } } };
    await store().complete(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, response, '2026-09-27T10:00:01.000Z', pod.handle);

    // A different store instance, as a restarted process would be: the Pod is the authority.
    const replay = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(replay.created).toBe(false);
    expect(replay.record.response).toEqual(response);
    expect(replay.record.completedAt).toBe('2026-09-27T10:00:01.000Z');
    expect(replay.record.receivedAt).toBe(first.record.receivedAt);
  });

  it('forgets an unfinished reservation, so the peer\'s retry may try again', async () => {
    const pod = scriptedPod();
    await store().reserve(SCOPE, reservation(), pod.handle);
    await store().release(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, pod.handle);
    expect(await store().find(SCOPE, { origin: ORIGIN, transactionId: 'txn-1' }, pod.handle)).toBeUndefined();
    const retry = await store().reserve(SCOPE, reservation(), pod.handle);
    expect(retry.created).toBe(true);
  });

  it('refuses to guess which Pod a record belongs to', async () => {
    const pod = scriptedPod();
    await expect(store().reserve(SCOPE, reservation()))
      .rejects.toThrow(/needs the resolved Pod handle/u);
    await expect(store().reserve('https://pod.example/bob/', reservation(), pod.handle))
      .rejects.toThrow(/does not match the resolved Pod/u);
  });

  it('reports a Pod that refuses the write rather than pretending it reserved', async () => {
    const pod = scriptedPod();
    const handle = pod.handle as { scope: string; write: { db: unknown } };
    const refusing = {
      scope: SCOPE,
      write: { db: handle.write.db, fetch: async() => new Response('no', { status: 403 }) },
    } as never;
    await expect(store().reserve(SCOPE, reservation(), refusing)).rejects.toThrow(MatrixError);
    await expect(store().reserve(SCOPE, reservation(), refusing)).rejects.toThrow(/403/u);
  });
});
