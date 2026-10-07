import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_BATCH_KIND,
  decodeOutboundBatch,
  encodeOutboundBatch,
  outboundBatchKey,
} from '../../../../src/api/matrix/federation/outboundBatches';
import type { MatrixOutboundBatch } from '../../../../src/api/matrix/federation/outboundQueue';
import type { MatrixControlRecord } from '../../../../src/api/matrix/controlRecords';
import { MatrixError } from '../../../../src/api/matrix/MatrixError';

const BATCH: MatrixOutboundBatch = {
  txnId: 'txn-1',
  origin: 'alice.example',
  destination: 'bob.example',
  pdus: [
    { type: 'm.room.message', room_id: '!r:alice.example', sender: '@u_alice:alice.example',
      content: { body: 'hello', 'm.mentions': { user_ids: [ '@u_bob:bob.example' ] } }, event_id: '$one' },
    { type: 'm.room.member', room_id: '!r:alice.example', sender: '@u_alice:alice.example', state_key: '@u_bob:bob.example',
      content: { membership: 'invite' }, event_id: '$two' },
  ],
  edus: [ { edu_type: 'm.typing', content: { user_ids: [ '@u_alice:alice.example' ] } } ],
  createdAt: 1_700_000_000_000,
  attempts: 2,
  notBefore: 1_700_000_030_000,
  lastReason: 'destination refused the request with 403 (M_FORBIDDEN: not joined)',
};

function recordOf(batch: MatrixOutboundBatch): MatrixControlRecord {
  const encoded = encodeOutboundBatch(batch);
  return {
    key: outboundBatchKey(batch),
    kind: 'outbound',
    bucket: '2026/09/28',
    resource: 'https://pod.example/alice/.data/task/2026/09/28/transactions.ttl',
    subject: 'https://pod.example/alice/.data/task/abc.ttl#self',
    status: encoded.status,
    metadata: encoded.metadata,
  };
}

describe('a delivery batch as a control record', () => {
  it('round-trips the payload a peer has to verify, verbatim', () => {
    const decoded = decodeOutboundBatch(recordOf(BATCH));
    expect(decoded).toEqual(BATCH);
    // Signed content cannot be re-encoded: the PDUs come back exactly as they were queued.
    expect(decoded!.pdus).toBe(BATCH.pdus);
    expect(decoded!.edus).toBe(BATCH.edus);
  });

  it('leaves absent optional bookkeeping absent instead of inventing defaults', () => {
    const minimal: MatrixOutboundBatch = {
      txnId: 'txn-2', origin: 'alice.example', destination: 'bob.example',
      pdus: [ { event_id: '$one' } ], edus: [], createdAt: 1, attempts: 0,
    };
    const decoded = decodeOutboundBatch(recordOf(minimal));
    expect(decoded).toEqual(minimal);
    expect('notBefore' in decoded!).toBe(false);
    expect('lastReason' in decoded!).toBe(false);
  });

  it('keys a batch by its queue and transaction, not by the transaction alone', () => {
    const base = { origin: 'alice.example', destination: 'bob.example', txnId: 'txn-1' };
    expect(outboundBatchKey(base)).toBe(outboundBatchKey({ ...base }));
    expect(outboundBatchKey(base)).not.toBe(outboundBatchKey({ ...base, destination: 'carol.example' }));
    expect(outboundBatchKey(base)).not.toBe(outboundBatchKey({ ...base, origin: 'dave.example' }));
  });

  it('preserves the explicit actor reference, including a named grant ref and version', () => {
    const batch: MatrixOutboundBatch = {
      ...BATCH,
      actor: {
        webId: 'https://alice.example/profile/card#me',
        podUrl: 'https://pods.example/alice/',
        taskCredential: { credentialRef: 'taskcred_9', version: 4 },
      },
    };
    const decoded = decodeOutboundBatch(recordOf(batch));
    expect(decoded).toEqual(batch);
    // A reference, not a credential: no bearer/session material is ever persisted.
    expect(JSON.stringify(recordOf(batch).metadata)).not.toMatch(/accessToken|clientSecret|dpop/iu);
  });

  it('refuses a present but malformed actor rather than downgrading its authority', () => {
    const record = recordOf(BATCH);
    const badActors: unknown[] = [
      { webId: 42 },
      { webId: '' },
      { webId: 'https://alice.example/card#me', podUrl: 7 },
      { webId: 'https://alice.example/card#me', taskCredential: 'grant-A' },
      { webId: 'https://alice.example/card#me', taskCredential: { credentialRef: '' } },
      { webId: 'https://alice.example/card#me', taskCredential: { credentialRef: 'grant-A', version: 0 } },
      { webId: 'https://alice.example/card#me', taskCredential: { credentialRef: 'grant-A', version: 1.5 } },
      { webId: 'https://alice.example/card#me', taskCredential: { ownerGrant: 'yes' } },
      // `ownerGrant?: true` is the contract; a present `false` must not be read as the active grant.
      { webId: 'https://alice.example/card#me', taskCredential: { ownerGrant: false } },
      { webId: 'https://alice.example/card#me', taskCredential: { ownerGrant: 0 } },
      { webId: 'https://alice.example/card#me', taskCredential: { credentialRef: 'grant-A', extra: 1 } },
      null,
    ];
    for (const actor of badActors) {
      expect(() => decodeOutboundBatch({ ...record, metadata: { ...record.metadata, actor } }), String(JSON.stringify(actor)))
        .toThrow(MatrixError);
    }
  });

  it('keeps the signed legacy path only when the actor field is entirely absent', () => {
    const record = recordOf(BATCH);
    const withoutActor = { ...record, metadata: { ...record.metadata } };
    delete (withoutActor.metadata as Record<string, unknown>).actor;
    expect(decodeOutboundBatch(withoutActor)).toEqual(BATCH);
  });

  it('describes the batch as owed work, with the payload under the protocol namespace', () => {
    const encoded = encodeOutboundBatch(BATCH);
    expect(encoded.status).toBe('open');
    expect(encoded.instruction).toContain('txn-1');
    expect(encoded.metadata).toMatchObject({ protocol: 'matrix', kind: OUTBOUND_BATCH_KIND,
      origin: 'alice.example', destination: 'bob.example', attempts: 2 });
  });

  it('is not a batch when the record is something else', () => {
    const record = recordOf(BATCH);
    expect(decodeOutboundBatch({ ...record, metadata: { kind: 'inbound-transaction' } })).toBeUndefined();
    expect(decodeOutboundBatch({ ...record, metadata: {} })).toBeUndefined();
  });

  it('refuses a batch whose payload cannot be sent rather than dropping it', () => {
    const record = recordOf(BATCH);
    // A record the deployment owes a peer, with nothing to send: silently skipping it would lose
    // events, and the queue has no other copy.
    expect(() => decodeOutboundBatch({ ...record, metadata: { ...record.metadata, pdus: undefined } }))
      .toThrow(/no PDU payload/u);
    expect(() => decodeOutboundBatch({ ...record, metadata: { ...record.metadata, attempts: undefined } }))
      .toThrow(MatrixError);
    expect(() => decodeOutboundBatch({ ...record, metadata: { ...record.metadata, destination: '' } }))
      .toThrow(/no destination/u);
  });
});
