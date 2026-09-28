/**
 * Control records: the keyed facts the protocol needs that no entity owns.
 *
 * An inbound transaction's receipt (`origin`, `txnId`, what the first attempt answered) and an
 * outbound delivery batch both have to survive a restart, and both are looked up by key rather
 * than by walking a room. The register settled what carries them: the models `taskResource`, which
 * is already keyed, has a status, an opaque `metadata` column and two timestamps.
 *
 * **Where they live follows the models convention for records that accumulate** — the one messages
 * and deliveries already use: inside a parent directory, split by day, one document per day holding
 * that day's records as fragments (`src/message.schema.ts`: `{parent.dir}/{yyyy}/{MM}/{dd}/
 * messages.ttl#{key}`). Control records are the same kind of thing, so they are
 * `<pod>/.data/task/{yyyy}/{MM}/{dd}/transactions.ttl#<key>`: the models task base, the models date
 * buckets, and one subject per record.
 *
 * **What that costs, measured earlier and accepted deliberately** (2026-09-27, contract §6.3): a
 * shared document cannot be *created once per key*, and `If-Match` is not a version check on this
 * storage (the Pod's ETag is `DC.modified` in milliseconds, so two writes inside one millisecond
 * share it). Reserving a key is therefore **best effort**: two callers racing for the same key can
 * both be told they claimed it. What is guaranteed instead is what the protocol actually needs —
 * the record is written, and a replay is answered from it rather than processed again:
 *
 * - the write is an idempotent insert of one subject, so a lost race leaves one record, not two;
 * - a reader that finds the record answers from it;
 * - accepting an event is idempotent by event id, so two processors of one transaction write the
 *   same events, and the only difference is which response the record ends up holding.
 *
 * A strictly single winner would need one document per key (`If-None-Match: *` is airtight, and was
 * measured to be); that layout is what the user rejected in favour of the standard one, and the
 * place that genuinely needs a single winner — reserving a *local* event identity, where two
 * winners would derive two different event ids — is served by the identity database's unique key,
 * not by this carrier.
 *
 * Replacing a record (attaching a response, marking that a sender reused a transaction id for a
 * different payload) and deleting one need no condition: they are ordinary writes on one subject.
 */
import { createHash } from 'node:crypto';
import { buildPodResourceIriForResource } from '@undefineds.co/drizzle-solid';
import { dateParts, taskResource, TaskStatus, type TaskStatusType } from '@undefineds.co/models';
import { MatrixError } from './MatrixError';
import type { MatrixPodWrite } from './podAccess';

/** A control record's payload, as it is kept in the row's opaque `metadata`. */
export type MatrixControlRecordMetadata = Record<string, unknown>;

/** Whether a record exists yet, or is already there. */
export interface MatrixControlRecordWrite {
  record: MatrixControlRecord;
  /**
   * Whether this call wrote it. Concurrent callers may both see `true` — see the module note; the
   * record itself is written once either way.
   */
  created: boolean;
}

/** One keyed control record, decoded from its row. */
export interface MatrixControlRecord {
  key: string;
  /** The day bucket the record lives in, as `yyyy/MM/dd`. */
  bucket: string;
  /** The document that holds it. */
  resource: string;
  /** The record's own subject IRI. */
  subject: string;
  status: TaskStatusType;
  metadata: MatrixControlRecordMetadata;
  createdAt?: string;
  updatedAt?: string;
}

export interface WriteControlRecordInput {
  key: string;
  /** When the record is about: its day bucket follows from this. */
  at: Date | string | number;
  /** What this record is for, in one line; `taskResource.instruction` is required by the schema. */
  instruction: string;
  status: TaskStatusType;
  metadata: MatrixControlRecordMetadata;
}

/** The Pod a record belongs to: its root, and the authority to write it. */
export interface MatrixControlRecordTarget {
  /** Pod root. Kept so a record can never be read or written across Pods. */
  scope: string;
  write: MatrixPodWrite;
}

/**
 * How many day buckets a lookup looks back through, today first.
 *
 * This is the retention window, in days: a record older than this is not found, and a peer retrying
 * that late is treated as a new transaction (which is safe — accepting is idempotent by event id —
 * but produces a fresh receipt). Two days is comfortably longer than a sender's retry window, and
 * keeps a lookup to at most three document reads.
 */
export const CONTROL_RECORD_LOOKBACK_DAYS = 2;

/** The document name a day's records share, under the models task base. */
const CONTROL_RECORD_DOCUMENT = 'transactions.ttl';

/** The day bucket a moment belongs to, in the models spelling (`yyyy/MM/dd`). */
export function controlRecordBucket(at: Date | string | number): string {
  const { yyyy, MM, dd } = dateParts(at);
  return `${yyyy}/${MM}/${dd}`;
}

/** The buckets a lookup should try, newest first. */
export function controlRecordBuckets(at: Date | string | number, days = CONTROL_RECORD_LOOKBACK_DAYS): string[] {
  const buckets: string[] = [];
  const moment = at instanceof Date ? at : new Date(at);
  const start = Number.isFinite(moment.getTime()) ? moment.getTime() : Date.now();
  for (let back = 0; back <= days; back += 1) {
    buckets.push(controlRecordBucket(new Date(start - back * 24 * 60 * 60 * 1000)));
  }
  return buckets;
}

/**
 * The document and subject a key maps to in one bucket.
 *
 * The key is hashed for the fragment: half of it is chosen by a peer (a transaction id is an
 * arbitrary string), and a fragment has to survive whatever arrives. What the record is *about*
 * stays in its metadata, where it can be read.
 */
export function controlRecordAddress(podUrl: string, key: string, bucket: string): {
  id: string;
  resource: string;
  subject: string;
} {
  const fragment = `t_${createHash('sha256').update(key).digest('hex')}`;
  const id = `${bucket}/${CONTROL_RECORD_DOCUMENT}#${fragment}`;
  const subject = buildPodResourceIriForResource(podUrl, taskResource, id);
  return { id, resource: subject.split('#')[0], subject };
}

/**
 * Write a record for a key, or hand back the one that is already there.
 *
 * Not a compare-and-swap: see the module note. The read-then-write is what makes the common case
 * (a replay) answer from the record, and the insert itself is idempotent, so a race cannot produce
 * two records.
 */
export async function writeControlRecord(
  target: MatrixControlRecordTarget,
  input: WriteControlRecordInput,
): Promise<MatrixControlRecordWrite> {
  const existing = await readControlRecord(target, input.key, { at: input.at });
  if (existing) return { record: existing, created: false };

  const bucket = controlRecordBucket(input.at);
  const { id, resource, subject } = controlRecordAddress(target.scope, input.key, bucket);
  await target.write.db.insert(taskResource).values({
    id,
    instruction: input.instruction,
    workspace: target.scope,
    status: input.status,
    metadata: input.metadata,
  } as never).execute();
  return {
    record: { key: input.key, bucket, resource, subject, status: input.status, metadata: input.metadata },
    created: true,
  };
}

/** Read the record under a key, or `undefined` when there is none in the retention window. */
export async function readControlRecord(
  target: MatrixControlRecordTarget,
  key: string,
  options: { at?: Date | string | number; days?: number } = {},
): Promise<MatrixControlRecord | undefined> {
  for (const bucket of controlRecordBuckets(options.at ?? Date.now(), options.days)) {
    const { resource, subject } = controlRecordAddress(target.scope, key, bucket);
    const row = await target.write.db.findByResource(taskResource, subject) as Record<string, unknown> | null;
    if (row) return decodeControlRecord(key, bucket, resource, subject, row);
  }
  return undefined;
}

/**
 * Replace a record's status and metadata.
 *
 * Takes the record itself rather than its key: a record knows its own subject, and looking it up
 * again would mean re-deriving a day bucket for something already in hand — which is how a record
 * written just before midnight gets "lost" by a caller looking in today's bucket.
 *
 * Only the caller that wrote the record does this (attaching a first response, marking that a
 * sender reused a transaction id for a different payload), so it is an ordinary write.
 */
export async function updateControlRecord(
  target: MatrixControlRecordTarget,
  record: MatrixControlRecord,
  input: { status: TaskStatusType; metadata: MatrixControlRecordMetadata },
): Promise<void> {
  const updated = await target.write.db.updateByResource(taskResource, record.subject, {
    status: input.status,
    metadata: input.metadata,
  } as never);
  if (!updated) {
    throw new MatrixError(500, 'M_UNKNOWN', `Control record ${record.key} disappeared before it could be updated`);
  }
}

/**
 * Forget a record: used to release a reservation whose work did not finish.
 *
 * The subject goes, not the document: the document is the day's shared record file, and somebody
 * else's record may well be in it.
 */
export async function deleteControlRecord(
  target: MatrixControlRecordTarget,
  record: MatrixControlRecord,
): Promise<void> {
  await target.write.db.deleteByResource(taskResource, record.subject);
}

/**
 * Decode a stored row.
 *
 * drizzle-solid writes a nested object as its own subject, so `metadata` comes back with `@id` and
 * `id` added; they are the row's bookkeeping rather than the record's payload, and are dropped
 * here so a round trip is stable.
 */
function decodeControlRecord(
  key: string,
  bucket: string,
  resource: string,
  subject: string,
  row: Record<string, unknown>,
): MatrixControlRecord {
  const metadata = isRecord(row.metadata) ? { ...row.metadata } : {};
  delete metadata['@id'];
  delete metadata.id;
  return {
    key,
    bucket,
    resource,
    subject,
    status: (typeof row.status === 'string' ? row.status : TaskStatus.OPEN) as TaskStatusType,
    metadata,
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
