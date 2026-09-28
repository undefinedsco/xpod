/**
 * The Pod carrier for the outbound queue, against a scripted Pod.
 *
 * The scripted Pod models what the real one was measured to do: records live one per document in a
 * day directory, the directory answers a container listing (Turtle, with several members on one
 * comma-separated `ldp:contains` statement — which is exactly what a naive parser gets wrong), and
 * rows are read and deleted through the database. The SPARQL and the row shape come from the real
 * drizzle-solid builder and the real models table; only the transport is a stand-in. The real-Pod
 * run is in `tests/integration/MatrixControlRecords.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { PodMatrixOutboundStore } from '../../../../src/api/matrix/federation/podOutboundStore';
import type { MatrixOutboundBatch } from '../../../../src/api/matrix/federation/outboundQueue';
import type { MatrixControlRecordTarget } from '../../../../src/api/matrix/controlRecords';

const POD = 'https://pod.example/alice/';
const ORIGIN = 'alice.example';
const PEER = 'bob.example';
const NOW = Date.parse('2026-09-28T10:00:00.000Z');

function batch(overrides: Partial<MatrixOutboundBatch> = {}): MatrixOutboundBatch {
  return {
    txnId: 'txn-1',
    origin: ORIGIN,
    destination: PEER,
    pdus: [ { event_id: '$one' } ],
    edus: [],
    createdAt: NOW,
    attempts: 0,
    ...overrides,
  };
}

/** A Pod that keeps one record per document in a day directory and answers container listings. */
function scriptedPod() {
  const documents = new Map<string, Record<string, unknown>>();
  const containers = new Set<string>();
  let listings = 0;
  const real = drizzle({
    fetch: async() => new Response('', { status: 200 }),
    info: { webId: 'https://alice.example/card#me', isLoggedIn: true, podUrl: POD },
  } as never, {} as never);

  const subjectOf = (row: Record<string, unknown>): string => {
    const [ path, fragment ] = String(row.id).split('#');
    return `${POD}.data/task/${path}#${fragment}`;
  };
  const documentOf = (subject: string): string => subject.split('#')[0];

  const db = {
    insert: (table: never) => {
      const builder = real.insert(table);
      return {
        values(row: Record<string, unknown>) {
          return {
            async execute() {
              const subject = subjectOf(row);
              if (!documents.has(subject)) documents.set(subject, row);
              return [ row ];
            },
          };
        },
      };
    },
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
      listings += 1;
      const members = [ ...documents.keys() ].filter(subject => documentOf(subject).startsWith(url));
      if (members.length === 0) return new Response('missing', { status: 404 });
      // Deliberately the shape a naive parser trips on: one statement, several objects.
      const list = members.map(subject => `<${documentOf(subject)}>`).join(', ');
      return new Response(
        `@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:BasicContainer; ldp:contains ${list}.`,
        { status: 200, headers: { 'Content-Type': 'text/turtle' } },
      );
    }
    throw new Error(`unexpected ${method}`);
  };

  const handle: MatrixControlRecordTarget = { scope: POD, write: { db, fetch } } as never;
  return { documents, containers, handle, listings: () => listings };
}

function store(input: {
  handle?: MatrixControlRecordTarget | undefined;
  scopes?: () => Promise<readonly string[]>;
  now?: () => number;
  lookbackDays?: number;
} = {}) {
  const pod = scriptedPod();
  const handles = new Map<string, MatrixControlRecordTarget>([[ POD, input.handle ?? pod.handle ]]);
  const instance = new PodMatrixOutboundStore({
    handleFor: async scope => handles.get(scope),
    ...(input.scopes ? { scopes: input.scopes } : {}),
    now: input.now ?? (() => NOW),
    ...(input.lookbackDays === undefined ? {} : { lookbackDays: input.lookbackDays }),
  });
  return { store: instance, pod };
}

describe('a Pod-backed outbound queue', () => {
  it('keeps a batch in the Pod and lists it back from the day directory', async() => {
    const { store: queue, pod } = store();
    await queue.put(POD, batch({ notBefore: NOW + 1_000, attempts: 2, lastReason: 'refused' }));

    // One document, in the day the batch was created in, named for its kind and key.
    const document = [ ...pod.documents.keys() ][0];
    expect(document).toContain(`${POD}.data/task/2026/09/28/outbound-`);
    // The containers existed before it: a document in a directory nobody made is unlistable.
    expect(pod.containers.has(`${POD}.data/task/2026/09/28/`)).toBe(true);

    const pending = await queue.pending(POD);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ txnId: 'txn-1', origin: ORIGIN, destination: PEER, attempts: 2,
      notBefore: NOW + 1_000, lastReason: 'refused' });
    expect(pending[0].pdus).toEqual([ { event_id: '$one' } ]);
  });

  it('filters by queue and orders by when the batch was created', async() => {
    const { store: queue } = store();
    await queue.put(POD, batch({ txnId: 'later', createdAt: NOW + 5_000 }));
    await queue.put(POD, batch({ txnId: 'earlier', createdAt: NOW + 1_000 }));
    await queue.put(POD, batch({ txnId: 'elsewhere', destination: 'carol.example', createdAt: NOW + 2_000 }));

    expect((await queue.pending(POD, { destination: PEER })).map(entry => entry.txnId)).toEqual([ 'earlier', 'later' ]);
    expect((await queue.pending(POD, { origin: ORIGIN, destination: 'carol.example' })).map(entry => entry.txnId))
      .toEqual([ 'elsewhere' ]);
    expect(await queue.pending(POD, { destination: 'nobody.example' })).toEqual([]);
  });

  it('forgets a delivered batch, and tolerates forgetting one twice', async() => {
    const { store: queue, pod } = store();
    const sent = batch();
    await queue.put(POD, sent);
    expect(await queue.pending(POD)).toHaveLength(1);

    await queue.remove(POD, sent);
    expect(await queue.pending(POD)).toEqual([]);
    expect(pod.documents.size).toBe(0);
    await expect(queue.remove(POD, sent)).resolves.toBeUndefined();
  });

  it('finds a batch from an earlier day, and gives up past the window', async() => {
    const { store: queue, pod } = store({ lookbackDays: 7 });
    await queue.put(POD, batch({ txnId: 'yesterday', createdAt: NOW - 20 * 60 * 60 * 1000 }));
    expect((await queue.pending(POD)).map(entry => entry.txnId)).toEqual([ 'yesterday' ]);

    // Past the window the batch is not enumerated at all — the documented cost of enumerating by
    // day, and the reason the window is days rather than hours.
    const beyond = store({ lookbackDays: 1 });
    const far = batch({ txnId: 'last-month', createdAt: NOW - 30 * 24 * 60 * 60 * 1000 });
    await beyond.store.put(POD, far);
    // It is in the Pod — the write is durable — but the queue's window does not reach it.
    expect(beyond.pod.documents.size).toBe(1);
    expect(await beyond.store.pending(POD)).toEqual([]);
    expect(await queue.pending(POD)).toHaveLength(1);
  });

  it('reads one listing per day in the window, not one per record', async() => {
    const { store: queue, pod } = store();
    await queue.put(POD, batch({ txnId: 'a' }));
    await queue.put(POD, batch({ txnId: 'b' }));
    await queue.put(POD, batch({ txnId: 'c' }));
    const before = pod.listings();
    expect(await queue.pending(POD)).toHaveLength(3);
    // Two days are empty and answer 404; the day with records answers once.
    expect(pod.listings() - before).toBe(8);
  });

  it('answers the scopes it serves, and otherwise only the ones it was asked about', async() => {
    const { store: queue } = store({ scopes: async() => [ POD, 'https://pod.example/bob/' ] });
    expect(await queue.scopes()).toEqual([ POD, 'https://pod.example/bob/' ]);

    const quiet = store();
    expect(await quiet.store.scopes()).toEqual([]);
    await quiet.store.pending(POD);
    expect(await quiet.store.scopes()).toEqual([ POD ]);
  });

  it('refuses a scope this deployment holds no grant for', async() => {
    const { store: queue } = store();
    await expect(queue.put('https://pod.example/bob/', batch())).rejects.toThrow(/holds no grant/u);
    await expect(queue.pending('https://pod.example/bob/')).rejects.toThrow(/holds no grant/u);
  });
});
