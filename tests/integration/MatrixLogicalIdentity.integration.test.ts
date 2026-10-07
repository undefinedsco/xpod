/**
 * Logical event identity in a real Pod.
 *
 * The unit tests prove the write path's decision against a scripted database; this proves the
 * storage claim on a running deployment with a real Pod behind it, over the real authenticated
 * transport:
 *
 * 1. one logical `(roomId, eventId)` occupies exactly one RDF message subject;
 * 2. a retry carried by another transaction, and one that lands on another day, reuses the first
 *    attempt's creation time and writes to the same day document;
 * 3. competing content under the same writer id is refused and the first subject is unchanged;
 * 4. a second store instance reads the first event back — the Pod, not a process-local index, owns
 *    the identity.
 *
 * It is deliberately not expressible against the in-memory row harness: the point is what the
 * serialized Turtle holds, inspected here by fetching the day document and parsing it.
 */
import { Parser, Store } from 'n3';
import { afterAll, describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import type { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../src/api/matrix/MatrixEventJournal';
import { matrixPodWriteFor } from '../../src/api/matrix/podAccess';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../../src/identity/drizzle/db';
import { createInterfaceKeyPodAccess, type OwnerInterfaceKeyAuth } from '../helpers/podInterfaceKeyAccess';
import { getConfiguredAccount } from './helpers/solidAccount';

const RUN = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN ? describe : describe.skip;
const solidBaseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');

async function realPod(): Promise<{
  webId: string;
  podUrl: string;
  podAccess: OwnerPodAccess;
  auth: OwnerInterfaceKeyAuth;
  canonicalSource: CanonicalRoomSource;
}> {
  const account = getConfiguredAccount(solidBaseUrl);
  if (!account) throw new Error(`Missing integration credentials for ${solidBaseUrl}`);
  const { podAccess, auth } = await createInterfaceKeyPodAccess({
    webId: account.webId,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`,
    publicBaseUrl: account.issuer,
  });
  const identityDbUrl = process.env.XPOD_INTEGRATION_IDENTITY_DB_URL;
  if (!identityDbUrl) throw new Error('Direct-store integration requires the running Gateway\'s real Pod registry');
  const canonicalSource = new CanonicalRoomSource({
    pods: new PodLookupRepository(getIdentityDatabase(identityDbUrl)),
    callerFetchFor: async context => (await matrixPodWriteFor(context, podAccess)).fetch,
  });
  return { webId: account.webId, podUrl: account.podUrl, podAccess, auth, canonicalSource };
}

/** The serialized Turtle of one day document, or `undefined` when it does not exist yet. */
async function readTurtle(write: { fetch: typeof fetch }, document: string): Promise<string | undefined> {
  const response = await write.fetch(document, { headers: { Accept: 'text/turtle' } });
  if (response.status === 404) return undefined;
  expect(response.status).toBe(200);
  return response.text();
}

/**
 * The metadata subjects that *are* this logical event, read back from the Pod.
 *
 * A raw substring count is wrong: a later event references an earlier one in `prev_events`/`auth_events`,
 * so the earlier id appears again without a second message existing. The message subject is the one
 * whose own serialized protocol event carries this id as `event_id`.
 */
async function messageSubjectsForEvent(
  write: { fetch: typeof fetch }, document: string, eventId: string,
): Promise<string[]> {
  const turtle = await readTurtle(write, document);
  if (turtle === undefined) return [];
  const graph = new Store();
  graph.addQuads(new Parser({ baseIRI: document }).parse(turtle));
  const protocols = 'https://undefineds.co/ns#protocols';
  const subjects = new Set<string>();
  for (const quad of graph.getQuads(null, protocols, null, null)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(quad.object.value);
    } catch {
      continue;
    }
    const matrix = (parsed as { matrix?: { event?: { event_id?: unknown } } }).matrix;
    if (matrix?.event?.event_id === eventId) subjects.add(quad.subject.value);
  }
  return [ ...subjects ];
}

suite('Matrix logical event identity in a real Pod', () => {
  afterAll(async() => { await closeAllIdentityConnections(); });
  it('keeps one RDF subject across different transactions, days and a restart, and refuses conflicts', async () => {
    const { webId, podUrl, podAccess, auth, canonicalSource } = await realPod();
    // The storage clock is injected, not faked globally: a faked `Date` would also backdate the DPoP
    // `iat` on the authenticated Pod fetch, which the issuer refuses (invalid_dpop_proof). Auth keeps
    // wall time; only event stamping and day bucketing move.
    let storageNow = new Date('2026-09-20T10:00:00.000Z').getTime();
    const clock = (): number => storageNow;
    const store = new PodMatrixStore({ podAccess, canonicalSource, journal: new InMemoryMatrixEventJournal(), clock });
    const context = { webId, podUrl, auth } as never;

    const room = await store.createRoom({}, context);
    const eventId = `$real-pod-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = await store.sendEvent(room.roomId, 'm.room.message', 'real-txn-a', { body: 'first' }, context, { msgid: eventId });

    // A retry under a different transaction, five seconds later the same day.
    storageNow = new Date('2026-09-20T10:00:05.000Z').getTime();
    const retry = await store.sendEvent(room.roomId, 'm.room.message', 'real-txn-b', { body: 'first' }, context, { msgid: eventId });
    // A retry that lands on the next day: the logical key is still one event, and it must stay in
    // the first attempt's day document rather than being re-bucketed.
    storageNow = new Date('2026-09-21T10:00:00.000Z').getTime();
    const crossDay = await store.sendEvent(room.roomId, 'm.room.message', 'real-txn-c', { body: 'first' }, context, { msgid: eventId });

    expect(retry.eventId).toBe(first.eventId);
    expect(crossDay.eventId).toBe(first.eventId);
    expect(crossDay.originServerTs).toBe(first.originServerTs);

    // Competing content under the same writer id is refused and nothing is overwritten.
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'real-txn-d', { body: 'second' }, context, { msgid: eventId }))
      .rejects.toMatchObject({ status: 409 });

    // A second store instance stands in for a restarted process: the Pod is the authority.
    const restarted = new PodMatrixStore({ podAccess, canonicalSource, journal: new InMemoryMatrixEventJournal(), clock });
    const replay = await restarted.sendEvent(room.roomId, 'm.room.message', 'real-txn-a', { body: 'first' }, context, { msgid: eventId });
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.originServerTs).toBe(first.originServerTs);

    // Inspect the persisted RDF: the day document holds exactly one message subject for this
    // logical event, and the competing body never reached it.
    const write = await matrixPodWriteFor(context, podAccess);
    const subject = messageResource.buildIri(podUrl, { id: first.resourceId });
    const document = subject.split('#')[0];
    const turtle = await (async () => {
      const response = await write.fetch(document, { headers: { Accept: 'text/turtle' } });
      expect(response.status).toBe(200);
      return await response.text();
    })();
    // One metadata subject carries the event as its own identity; the competing body never reached it.
    expect(await messageSubjectsForEvent(write, document, eventId)).toHaveLength(1);
    expect(turtle).toContain('first');
    expect(turtle).not.toContain('"second"');

    // The next day's document, if it exists, does not hold this event.
    const nextDayDocument = document.replace('/2026/09/20/', '/2026/09/21/');
    expect(await messageSubjectsForEvent(write, nextDayDocument, eventId)).toHaveLength(0);
  }, 300_000);

  it('keeps one RDF subject under 16-way concurrent different-transaction writes over 3 same-content and 3 competing-content rounds', async () => {
    const { webId, podUrl, podAccess, auth, canonicalSource } = await realPod();
    let storageNow = Date.parse('2026-09-20T11:00:00.000Z');
    const clock = (): number => storageNow;
    const store = new PodMatrixStore({ podAccess, canonicalSource, journal: new InMemoryMatrixEventJournal(), clock });
    const context = { webId, podUrl, auth } as never;

    const room = await store.createRoom({}, context);
    const write = await matrixPodWriteFor(context, podAccess);
    const documentFor = (resourceId: string): string => messageResource.buildIri(podUrl, { id: resourceId }).split('#')[0];

    // Same logical key, same content: 16 concurrent sends carried by 16 *different* transactions per
    // round, three rounds. Every attempt must adopt the same id and the same first creation time, and
    // the day document must hold exactly one subject/body for that key.
    const sameRounds: { eventId: string; resourceId: string; originServerTs: number }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const eventId = `$r02-same-${round}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const body = `same-body-${round}`;
      const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        store.sendEvent(room.roomId, 'm.room.message', `same-txn-${round}-${index}`, { body }, context, { msgid: eventId })));
      expect(new Set(results.map(result => result.eventId))).toEqual(new Set([ eventId ]));
      expect(new Set(results.map(result => result.originServerTs)).size).toBe(1);
      const document = documentFor(results[0]!.resourceId!);
      // Exactly one message subject *is* this event: the 16 concurrent attempts converged on one
      // deterministic resource id rather than inserting a second copy.
      expect(await messageSubjectsForEvent(write, document, eventId)).toHaveLength(1);
      expect(await readTurtle(write, document)).toContain(body);
      sameRounds.push({ eventId, resourceId: results[0]!.resourceId!, originServerTs: results[0]!.originServerTs });
    }

    // Same logical key, competing content: the first write wins, each of the 16 later attempts with a
    // different body is refused with 409, and the first body remains the only body in the document.
    for (let round = 0; round < 3; round += 1) {
      const eventId = `$r02-conflict-${round}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const firstBody = `first-body-${round}`;
      const competingBody = `competing-body-${round}`;
      const seed = await store.sendEvent(room.roomId, 'm.room.message', `seed-txn-${round}`, { body: firstBody }, context, { msgid: eventId });
      const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
        store.sendEvent(room.roomId, 'm.room.message', `conflict-txn-${round}-${index}`, { body: competingBody }, context, { msgid: eventId })));
      for (const attempt of attempts) {
        expect(attempt.status).toBe('rejected');
        if (attempt.status === 'rejected') expect((attempt.reason as { status?: number }).status).toBe(409);
      }
      const document = documentFor(seed.resourceId!);
      expect(await messageSubjectsForEvent(write, document, eventId)).toHaveLength(1);
      const turtle = await readTurtle(write, document);
      expect(turtle).toContain(firstBody);
      expect(turtle!).not.toContain(competingBody);
    }

    // Response loss on a completed write: the same transaction is replayed and must be answered from
    // the Pod, not written again. A restarted store instance proves the Pod owns the identity, not a
    // process-local index.
    const lost = sameRounds[2]!;
    const lostBody = 'same-body-2';
    const replayed = await store.sendEvent(room.roomId, 'm.room.message', 'same-txn-2-0', { body: lostBody }, context, { msgid: lost.eventId });
    expect(replayed.eventId).toBe(lost.eventId);
    expect(replayed.originServerTs).toBe(lost.originServerTs);

    const restarted = new PodMatrixStore({ podAccess, canonicalSource, journal: new InMemoryMatrixEventJournal(), clock });
    const afterRestart = await restarted.sendEvent(room.roomId, 'm.room.message', 'restart-txn', { body: lostBody }, context, { msgid: lost.eventId });
    expect(afterRestart.eventId).toBe(lost.eventId);
    expect(afterRestart.originServerTs).toBe(lost.originServerTs);
    const finalDocument = documentFor(afterRestart.resourceId!);
    // The replay and the restarted store both adopt the first attempt: still exactly one subject.
    expect(await messageSubjectsForEvent(write, finalDocument, lost.eventId)).toHaveLength(1);
    expect(await readTurtle(write, finalDocument)).toContain(lostBody);
  }, 900_000);
});
