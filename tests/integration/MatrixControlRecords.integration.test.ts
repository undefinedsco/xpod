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
import type { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { PodMatrixInboundTransactionStore } from '../../src/api/matrix/federation/podInboundTransaction';
import { handleInboundTransaction } from '../../src/api/matrix/federation/inboundTransaction';
import { matrixPodWriteFor, type MatrixPodWrite } from '../../src/api/matrix/podAccess';
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
  it('gives a reservation exactly one winner and keeps the receipt after a restart', async() => {
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
    expect(outcomes.filter(outcome => outcome.created)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.created)).toHaveLength(2);
    // Every caller sees the same record: the winner's, not their own attempt.
    const winner = outcomes.find(outcome => outcome.created)!;
    for (const loser of outcomes.filter(outcome => !outcome.created)) {
      expect(loser.record.receivedAt).toBe(winner.record.receivedAt);
      expect(loser.record.payloadFingerprint).toBe('fingerprint-a');
    }

    // A second store instance stands in for a restarted process: the Pod is the authority.
    const restarted = new PodMatrixInboundTransactionStore();
    const response = { pdus: { '$event-1': {}}};
    await restarted.complete(scope, { origin: ORIGIN, transactionId }, response, new Date().toISOString(), handle);
    const replay = await new PodMatrixInboundTransactionStore()
      .reserve(scope, { ...reservation, payloadFingerprint: 'fingerprint-b' }, handle);
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
});
