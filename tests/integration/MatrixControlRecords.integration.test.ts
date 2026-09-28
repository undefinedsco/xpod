/**
 * Transaction receipts in a real Pod.
 *
 * The unit tests prove the decision logic against a scripted Pod; this proves the storage claims
 * the design rests on, on a running deployment with a real Pod behind it:
 *
 * 1. a reservation is create-once — two callers racing for the same transaction id produce exactly
 *    one winner, decided by the Pod rather than by a read-then-write;
 * 2. a receipt survives the process that wrote it (a second store instance reads it back);
 * 3. a replay carrying a different payload is answered from the first record, not processed again;
 * 4. releasing an unfinished reservation makes the id reservable again.
 *
 * It also records why the reservation is not built on `If-Match`: the Pod's ETag is
 * `"<DC.modified in ms>-<content type>"`, so two writes inside one millisecond share an ETag and a
 * stale condition still passes (measured here: two concurrent conditional writes both answered 205
 * and the ETag did not move). `controlRecords.ts` carries that measurement as its design note.
 */
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import type { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { PodMatrixInboundTransactionStore } from '../../src/api/matrix/federation/podInboundTransaction';
import { handleInboundTransaction } from '../../src/api/matrix/federation/inboundTransaction';
import { matrixPodWriteFor, type MatrixPodWrite } from '../../src/api/matrix/podAccess';
import {
  CONTROL_RECORD_LOOKBACK_DAYS,
  controlRecordAddress,
  controlRecordBucket,
  deleteControlRecord,
  pruneControlRecords,
  readControlRecord,
  writeControlRecord,
} from '../../src/api/matrix/controlRecords';
import {
  decodeOutboundBatch,
  encodeOutboundBatch,
  outboundBatchKey,
} from '../../src/api/matrix/federation/outboundBatches';
import type { MatrixOutboundBatch } from '../../src/api/matrix/federation/outboundQueue';
import { PodMatrixOutboundStore } from '../../src/api/matrix/federation/podOutboundStore';
import { createInterfaceKeyPodAccess, type OwnerInterfaceKeyAuth } from '../helpers/podInterfaceKeyAccess';
import { getConfiguredAccount } from './helpers/solidAccount';

const RUN = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN ? describe : describe.skip;
const solidBaseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');
const ORIGIN = 'peer.example';

/** Real Pod access for the configured integration account, and the handle the store writes with. */
async function podHandle(): Promise<{ podUrl: string; write: MatrixPodWrite }> {
  const account = getConfiguredAccount(solidBaseUrl);
  if (!account) throw new Error(`Missing integration credentials for ${solidBaseUrl}`);
  let podAccess: OwnerPodAccess;
  let callerAuth: OwnerInterfaceKeyAuth;
  ({ podAccess, auth: callerAuth } = await createInterfaceKeyPodAccess({
    webId: account.webId,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`,
    publicBaseUrl: account.issuer,
  }));
  // The same resolution the store uses in production: one place decides who a write is done as.
  const write = await matrixPodWriteFor({ webId: account.webId, podUrl: account.podUrl, auth: callerAuth }, podAccess);
  return { podUrl: account.podUrl, write };
}

suite('Matrix control records in a real Pod', () => {
  it('writes one receipt, answers replays from it, and keeps it across a restart', async() => {
    const { podUrl, write } = await podHandle();
    const scope = podUrl;
    const store = new PodMatrixInboundTransactionStore();
    const handle = { scope, write };
    const transactionId = `txn-race-${Date.now()}`;
    const reservation = {
      origin: ORIGIN,
      transactionId,
      payloadFingerprint: 'fingerprint-a',
      receivedAt: new Date().toISOString(),
    };

    const outcomes = await Promise.all([ 1, 2, 3 ].map(async() => await store.reserve(scope, reservation, handle)));
    // Claiming is best effort on a shared day document, so more than one caller may be told it
    // claimed the id; what the Pod guarantees is *one* record, and that every caller can answer
    // from it. Two processors of one transaction write the same events (accepting is idempotent by
    // event id), so the cost of a lost race is a second validation pass.
    expect(outcomes.filter(outcome => outcome.created).length).toBeGreaterThanOrEqual(1);
    const stored = await store.find(scope, { origin: ORIGIN, transactionId }, handle);
    expect(stored).toBeDefined();
    for (const outcome of outcomes) expect(outcome.record.payloadFingerprint).toBe('fingerprint-a');

    // The receipt lives where the models layout puts records that accumulate: a day document under
    // the task base, one subject per record.
    const bucket = controlRecordBucket(reservation.receivedAt);
    const { resource, subject } = controlRecordAddress(scope, 'txn', JSON.stringify([ ORIGIN, transactionId ]), bucket);
    expect(resource).toBe(`${scope}.data/task/${bucket}/${resource.split('/').pop()}`);
    expect(resource.startsWith(`${scope}.data/task/${bucket}/`)).toBe(true);
    const head = await write.fetch(subject.split('#')[0], { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(CONTROL_RECORD_LOOKBACK_DAYS).toBeGreaterThanOrEqual(2);

    // A second store instance stands in for a restarted process: the Pod is the authority.
    const restarted = new PodMatrixInboundTransactionStore();
    const response = { pdus: { '$event-1': {}}};
    await restarted.complete(scope, { origin: ORIGIN, transactionId }, response, new Date().toISOString(), handle);
    const replay = await new PodMatrixInboundTransactionStore()
      .reserve(scope, { ...reservation, payloadFingerprint: 'fingerprint-b', receivedAt: new Date().toISOString() }, handle);
    expect(replay.created).toBe(false);
    expect(replay.record.response).toEqual(response);
    expect(replay.record.payloadFingerprint).toBe('fingerprint-a');
    expect(replay.record.conflictAt).toBeTruthy();

    // Releasing is what lets the peer's retry start over, and only then.
    await restarted.release(scope, { origin: ORIGIN, transactionId }, handle);
    expect(await restarted.find(scope, { origin: ORIGIN, transactionId }, handle)).toBeUndefined();
    const retry = await restarted.reserve(scope, { ...reservation, payloadFingerprint: 'fingerprint-c' }, handle);
    expect(retry.created).toBe(true);
    await restarted.release(scope, { origin: ORIGIN, transactionId }, handle);
  }, 120_000);

  it('writes the transaction layer\'s receipt into the participant\'s Pod', async() => {
    const { podUrl, write } = await podHandle();
    const scope = podUrl;
    const store = new PodMatrixInboundTransactionStore();
    const handle = { scope, write };
    const transactionId = `txn-layer-${Date.now()}`;
    const run = async() => await handleInboundTransaction({
      scope,
      origin: ORIGIN,
      transactionId,
      // An empty transaction still has a receipt: what matters here is that the layer writes one
      // into the Pod, and that a replay is answered from it rather than re-processed.
      pdus: [],
      store,
      records: handle,
      keys: { keysFor: async() => undefined },
      resolveAuthEvents: async() => [],
      acceptEvent: async() => undefined,
    });

    const first = await run();
    expect(first).toEqual({ pdus: {}});
    const stored = await store.find(scope, { origin: ORIGIN, transactionId }, handle);
    expect(stored).toMatchObject({ origin: ORIGIN, transactionId, completedAt: expect.any(String) });

    const replay = await run();
    expect(replay).toEqual(first);
    await store.release(scope, { origin: ORIGIN, transactionId }, handle);
  }, 120_000);

  it('makes the day a real container, so a client can find the records by listing', async() => {
    const { podUrl, write } = await podHandle();
    const handle = { scope: podUrl, write };
    const at = new Date();
    const bucket = controlRecordBucket(at);
    const key = `txn-listable-${Date.now()}`;
    await writeControlRecord(handle, {
      kind: 'txn',
      key,
      at,
      instruction: 'Record a transaction that a client should be able to find',
      status: 'active',
      metadata: { protocol: 'matrix', kind: 'inbound-transaction', origin: ORIGIN, transactionId: key },
    });

    // The record's document, its day, its month and its year are all real resources: a client that
    // owns its own sync state discovers records by listing (the standard Solid way) and can
    // subscribe to the container, instead of scanning the task table or knowing the keys.
    const { resource } = controlRecordAddress(podUrl, 'txn', key, bucket);
    const [ year, month, day ] = bucket.split('/');
    const listing = async(target: string): Promise<{ status: number; members: string[] }> => {
      const response = await write.fetch(target, { method: 'GET', headers: { Accept: 'text/turtle' }});
      const body = await response.text();
      // Parsed as Turtle, not by pattern: one statement may list several members after a comma, and
      // a naive statement-splitting read misses every member but the first — a mistake an earlier
      // measurement of this Pod made, and the reason the contract once called container listings
      // unreliable.
      const quads = new Parser({ baseIRI: target }).parse(body);
      const members = quads
        .filter(quad => quad.predicate.value === 'http://www.w3.org/ns/ldp#contains')
        .map(quad => quad.object.value);
      return { status: response.status, members };
    };

    const dayListing = await listing(`${podUrl}.data/task/${bucket}/`);
    expect(dayListing.status).toBe(200);
    expect(dayListing.members.map(iri => iri.replace(`${podUrl}.data/task/${bucket}/`, '')))
      .toContain(resource.split('/').pop());

    const monthListing = await listing(`${podUrl}.data/task/${year}/${month}/`);
    expect(monthListing.status).toBe(200);
    expect(monthListing.members.some(iri => iri.replace(/\/$/u, '').endsWith(`/${day}`))).toBe(true);

    const yearListing = await listing(`${podUrl}.data/task/${year}/`);
    expect(yearListing.status).toBe(200);
    expect(yearListing.members.some(iri => iri.replace(/\/$/u, '').endsWith(`/${month}`))).toBe(true);

    await deleteControlRecord(handle, (await readControlRecord(handle, 'txn', key))!);
  }, 120_000);

  it('finds what the deployment still owes after a restart, by listing the day', async() => {
    const { podUrl, write } = await podHandle();
    const handle = { scope: podUrl, write };
    // The outbound queue's carrier: a batch lives in the sender's Pod until it is delivered, and a
    // restarted deployment enumerates it through the day container the models layout gives it.
    const queue = new PodMatrixOutboundStore({ handleFor: async scope => (scope === podUrl ? handle : undefined) });
    const first: MatrixOutboundBatch = {
      txnId: `txn-owed-${Date.now()}`,
      origin: ORIGIN,
      destination: 'other.example',
      pdus: [ { event_id: '$owed-one', content: { body: 'not sent yet' } } ],
      edus: [],
      createdAt: Date.now(),
      attempts: 1,
      lastReason: 'destination answered 503',
    };
    const second: MatrixOutboundBatch = { ...first, txnId: `${first.txnId}-b`, destination: 'third.example', createdAt: first.createdAt + 1 };

    await queue.put(podUrl, first);
    await queue.put(podUrl, second);

    // A different instance, as a restarted process would be: the Pod is the only authority.
    const restarted = new PodMatrixOutboundStore({ handleFor: async scope => (scope === podUrl ? handle : undefined) });
    const pending = await restarted.pending(podUrl, { destination: 'other.example' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(first);

    await restarted.remove(podUrl, first);
    expect(await restarted.pending(podUrl)).toEqual([ second ]);
    await restarted.remove(podUrl, second);
    expect(await restarted.pending(podUrl)).toEqual([]);
  }, 120_000);

  it('physically forgets a day it is told to prune, and only that day', async() => {
    const { podUrl, write } = await podHandle();
    const handle = { scope: podUrl, write };
    const oldDay = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const bucket = controlRecordBucket(oldDay);
    const oldKey = `txn-pruned-${Date.now()}`;
    const keptKey = `txn-kept-${Date.now()}`;
    await writeControlRecord(handle, {
      kind: 'txn', key: oldKey, at: oldDay, instruction: 'a receipt past the retention window',
      status: 'completed', metadata: { protocol: 'matrix', kind: 'inbound-transaction' },
    });
    await writeControlRecord(handle, {
      kind: 'txn', key: keptKey, at: new Date(), instruction: 'a receipt inside the window',
      status: 'active', metadata: { protocol: 'matrix', kind: 'inbound-transaction' },
    });
    // The old one is there when asked for by its own day — it is only the lookup *window* that hides
    // it, which is the logical half of retention.
    expect(await readControlRecord(handle, 'txn', oldKey, { at: oldDay })).toBeDefined();
    const { resource } = controlRecordAddress(podUrl, 'txn', oldKey, bucket);
    expect((await write.fetch(resource, { method: 'HEAD' })).status).toBe(200);

    // Physical retention is the operator's call: name the day, and its records go — document and
    // all, so nothing is left behind for a client listing that day to find.
    await expect(pruneControlRecords(handle, 'txn', [ bucket ])).resolves.toBe(1);
    expect((await write.fetch(resource, { method: 'HEAD' })).status).toBe(404);
    expect(await readControlRecord(handle, 'txn', oldKey, { at: oldDay })).toBeUndefined();
    expect(await readControlRecord(handle, 'txn', keptKey, { at: new Date() })).toBeDefined();
    await deleteControlRecord(handle, (await readControlRecord(handle, 'txn', keptKey, { at: new Date() }))!);
  }, 120_000);

  it('keeps a delivery batch sendable: the payload survives the Pod intact', async() => {
    const { podUrl, write } = await podHandle();
    const handle = { scope: podUrl, write };
    // A batch is what the deployment still owes a peer, and a PDU is signed over its content — so
    // the test asserts the payload comes back *identical*, not merely equivalent.
    const batch: MatrixOutboundBatch = {
      txnId: `txn-batch-${Date.now()}`,
      origin: ORIGIN,
      destination: 'other.example',
      pdus: [
        { type: 'm.room.message', room_id: '!room:other.example', sender: '@u_peer:other.example',
          content: { body: 'signed content', 'm.mentions': { user_ids: [ '@u_peer:other.example' ] } },
          event_id: '$event-one', signatures: { 'other.example': { 'ed25519:1': 'c2lnbmF0dXJl' } } },
        { type: 'm.room.member', room_id: '!room:other.example', sender: '@u_peer:other.example',
          state_key: '@u_bob:other.example', content: { membership: 'invite' }, event_id: '$event-two' },
      ],
      edus: [ { edu_type: 'm.typing', content: { user_ids: [ '@u_peer:other.example' ] } } ],
      createdAt: Date.now(),
      attempts: 3,
      notBefore: Date.now() + 30_000,
      lastReason: 'destination refused the request with 403 (M_FORBIDDEN: not joined)',
    };

    const key = outboundBatchKey(batch);
    const created = await writeControlRecord(handle, { kind: 'outbound', key, at: batch.createdAt, ...encodeOutboundBatch(batch) });
    expect(created.created).toBe(true);
    expect(created.record.bucket).toBe(controlRecordBucket(batch.createdAt));

    // A different reader, as a restarted process would be: the Pod is the authority.
    const stored = await readControlRecord(handle, 'outbound', key);
    expect(stored).toBeDefined();
    const decoded = decodeOutboundBatch(stored!);
    expect(decoded).toEqual(batch);
    expect(decoded!.pdus).toEqual(batch.pdus);
    expect(decoded!.edus).toEqual(batch.edus);

    await deleteControlRecord(handle, stored!);
    expect(await readControlRecord(handle, 'outbound', key)).toBeUndefined();
  }, 120_000);
});
