/**
 * The outbound queue as control records: one batch, one record.
 *
 * The register settled that a delivery batch belongs in the Pod — "只落水位/进度救不回队列——队列里那批
 * **尚未发出**的事件本身就是记录的内容" — and this is the payload half of that carrier: how a
 * `MatrixOutboundBatch` becomes a models `taskResource` row and back. The enumeration half (which
 * records a Pod still owes) is *not* here, because what a real Pod can answer was measured first
 * and the answer is not yet settled — see the control-records contract §9.
 *
 * What the mapping has to preserve is the *payload*: after a restart the batch must be sendable
 * again exactly as it was, because a PDU is signed over its content and the peer verifies it. So
 * the PDUs and EDUs travel verbatim in `metadata`, and the record keeps the queue's own bookkeeping
 * (`attempts`, `notBefore`, `lastReason`) alongside them.
 *
 * The record's `status` is `open` for every batch: the batch's existence *is* "this deployment
 * still owes a transaction". Progress is not a status here — `attempts`/`notBefore` carry it —
 * because a status would have to be rewritten on every retry, and rewriting is what makes two
 * writers race.
 */
import { TaskStatus, type TaskStatusType } from '@undefineds.co/models';
import { MatrixError } from '../MatrixError';
import type { MatrixControlRecord, MatrixControlRecordMetadata } from '../controlRecords';
import type { MatrixOutboundBatch } from './outboundQueue';

/** The `metadata.kind` that marks a task row as a delivery batch rather than anything else. */
export const OUTBOUND_BATCH_KIND = 'outbound-batch';

/**
 * The record key for a batch.
 *
 * A batch is identified by its transaction id — the peer's dedup key, which the queue never
 * re-mints mid-flight — but the key names the queue as well: two destinations, or two origins this
 * deployment hosts, can use the same transaction id without being the same batch.
 */
export function outboundBatchKey(batch: Pick<MatrixOutboundBatch, 'origin' | 'destination' | 'txnId'>): string {
  return JSON.stringify([ batch.origin, batch.destination, batch.txnId ]);
}

/** The row a batch is stored as. */
export function encodeOutboundBatch(batch: MatrixOutboundBatch): {
  instruction: string;
  status: TaskStatusType;
  metadata: MatrixControlRecordMetadata;
} {
  return {
    instruction: `Deliver transaction ${batch.txnId} from ${batch.origin} to ${batch.destination}`,
    status: TaskStatus.OPEN,
    metadata: {
      protocol: 'matrix',
      kind: OUTBOUND_BATCH_KIND,
      txnId: batch.txnId,
      origin: batch.origin,
      destination: batch.destination,
      // The payload, verbatim: a PDU is signed over its content, so re-encoding it is not an option.
      pdus: batch.pdus,
      edus: batch.edus,
      createdAt: batch.createdAt,
      attempts: batch.attempts,
      // The actor reference (O1), not a credential: the live session is still resolved per attempt.
      // Persisting it is what keeps an explicit named grant ref/version attached across a reload,
      // so a background send cannot quietly fall back to a different active grant.
      ...(batch.actor === undefined ? {} : { actor: batch.actor }),
      ...(batch.notBefore === undefined ? {} : { notBefore: batch.notBefore }),
      ...(batch.lastReason === undefined ? {} : { lastReason: batch.lastReason }),
    },
  };
}

/**
 * The batch a record holds, or `undefined` when the record is not one.
 *
 * A record whose payload does not decode is an error rather than a skip: dropping it would lose
 * events the deployment owes a peer, and the queue has no other copy of them.
 */
export function decodeOutboundBatch(record: MatrixControlRecord): MatrixOutboundBatch | undefined {
  const metadata = record.metadata;
  if (metadata.kind !== OUTBOUND_BATCH_KIND) return undefined;
  const txnId = requireString(record, metadata, 'txnId');
  const origin = requireString(record, metadata, 'origin');
  const destination = requireString(record, metadata, 'destination');
  if (!Array.isArray(metadata.pdus) || !Array.isArray(metadata.edus)) {
    throw new MatrixError(500, 'M_UNKNOWN', `Outbound batch ${record.key} has no PDU payload`);
  }
  const createdAt = metadata.createdAt;
  const attempts = metadata.attempts;
  if (typeof createdAt !== 'number' || typeof attempts !== 'number') {
    throw new MatrixError(500, 'M_UNKNOWN', `Outbound batch ${record.key} is missing its bookkeeping`);
  }
  const actor = decodeActor(metadata.actor);
  return {
    txnId,
    origin,
    destination,
    pdus: metadata.pdus,
    edus: metadata.edus,
    createdAt,
    attempts,
    ...(actor === undefined ? {} : { actor }),
    ...(typeof metadata.notBefore === 'number' ? { notBefore: metadata.notBefore } : {}),
    ...(typeof metadata.lastReason === 'string' ? { lastReason: metadata.lastReason } : {}),
  };
}

/**
 * The persisted actor reference, or `undefined` when the record predates the field.
 *
 * A *present* actor is authorization data, so a malformed one must fail the read rather than quietly
 * become "no actor" (which would send signed as the deployment) or drop a named grant to the owner's
 * active grant (which would broaden what the credential may do). Only a missing field follows the
 * historical legacy policy.
 */
function decodeActor(value: unknown): MatrixOutboundBatch['actor'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted outbound actor is not an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'webId' && key !== 'podUrl' && key !== 'taskCredential') {
      throw new MatrixError(500, 'M_UNKNOWN', `Persisted outbound actor has an unknown field ${key}`);
    }
  }
  const webId = record.webId;
  if (typeof webId !== 'string' || webId.length === 0) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted outbound actor names no WebID');
  }
  const podUrl = record.podUrl;
  if (podUrl !== undefined && (typeof podUrl !== 'string' || podUrl.length === 0)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted outbound actor has a malformed Pod URL');
  }
  return {
    webId,
    ...(typeof podUrl === 'string' ? { podUrl } : {}),
    ...decodeTaskCredential(record.taskCredential),
  };
}

/** The task credential carried by a persisted actor, validated or refused; absence means active. */
function decodeTaskCredential(value: unknown): { taskCredential?: { credentialRef?: string; version?: number;
  purpose?: 'membership'; issuer?: string } } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted outbound actor has a malformed task credential');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'credentialRef' && key !== 'version' && key !== 'ownerGrant' && key !== 'purpose' && key !== 'issuer') {
      throw new MatrixError(500, 'M_UNKNOWN', `Persisted task credential has an unknown field ${key}`);
    }
  }
  if (record.ownerGrant !== undefined && record.ownerGrant !== true) {
    // The contract is `ownerGrant?: true`. A present `false` (or any other non-true value) is
    // malformed authorization data: treating it as the owner's active grant would silently broaden
    // what the persisted record may do, so a present-but-not-true marker is refused rather than
    // truthiness-coerced. Only `true` (or absence) means the active grant.
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted task credential has a malformed ownerGrant');
  }
  const credentialRef = record.credentialRef;
  if (credentialRef !== undefined && (typeof credentialRef !== 'string' || credentialRef.length === 0)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted task credential has a malformed credentialRef');
  }
  const version = record.version;
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted task credential has a malformed version');
  }
  const publication = record.purpose !== undefined || record.issuer !== undefined;
  if (publication && (record.purpose !== 'membership' || typeof record.issuer !== 'string' || record.issuer.trim().length === 0
    || typeof credentialRef !== 'string' || credentialRef.trim().length === 0 || version === undefined
    || Object.keys(record).length !== 4 || record.ownerGrant !== undefined)) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Persisted publication authority is malformed');
  }
  if (credentialRef === undefined) {
    // `{}` and `{ ownerGrant: true }` both mean the owner's active grant.
    return {};
  }
  return {
    taskCredential: {
      credentialRef,
      ...(version === undefined ? {} : { version: version as number }),
      ...(publication ? { purpose: 'membership' as const, issuer: record.issuer as string } : {}),
    },
  };
}

function requireString(record: MatrixControlRecord, metadata: MatrixControlRecordMetadata, field: string): string {
  const value = metadata[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new MatrixError(500, 'M_UNKNOWN', `Outbound batch ${record.key} has no ${field}`);
  }
  return value;
}
