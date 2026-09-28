/**
 * Control records: the keyed facts the protocol needs that no entity owns.
 *
 * An inbound transaction's receipt (`origin`, `txnId`, what the first attempt answered) and an
 * outbound delivery batch both have to survive a restart, and both are looked up by key rather
 * than by walking a room. The register settles what carries them: the models `taskResource`, which
 * is already keyed, has a status, an opaque `metadata` column and two timestamps. Nothing new is
 * modelled here.
 *
 * **What was measured, and why this file is not a thin wrapper** (2026-09-27, real deployment):
 *
 * - `PATCH` with `If-None-Match: *` on a document that does not exist answers **201**, and two
 *   concurrent attempts on the same document answer **201 and 412** — one winner, decided by the
 *   server, with the condition and the write inside the same per-resource lock.
 * - `If-Match` is **not** a version check on this storage. The Pod's ETag is
 *   `"<DC.modified in ms>-<content type>"`, not a content hash, so two writes inside the same
 *   millisecond produce the *same* ETag: two concurrent conditional writes both answered **205**
 *   and the ETag did not move. A compare-and-swap built on `If-Match` would therefore hand the
 *   same reservation to two callers whenever they raced within a millisecond — which is exactly
 *   when a race happens.
 *
 * So the only condition this storage makes airtight is *create-once*, and it is document-scoped:
 * one record per document, named after its key. That is why a record's `id` is
 * `<hash>.ttl#self` rather than the schema's `index.ttl#{key}` default — a single shared document
 * could only gate its own first key. The row is still a `taskResource` under the models task base,
 * and its layout (the `id`) is the only thing the caller chooses.
 *
 * Two more things about this storage had to be measured before the carrier could work (same
 * deployment, same day):
 *
 * - **A document written by SPARQL `PATCH` cannot be deleted while its container does not exist.**
 *   `PATCH` happily creates `…/.data/task/<key>.ttl` in a Pod where `.data/task/` is absent — the
 *   document reads back fine — but `DELETE` on it then answers **404** and leaves it in place, so
 *   the key could never be reserved again. Creating the container first (a conditional `PUT` of the
 *   BasicContainer; 201, or 409 when it is already there) makes `DELETE` answer 205 and the key
 *   reservable again. `ensureContainer` below does that before every first write.
 * - **`db.deleteByResource` is not "forget this record".** It removes the row's triples and leaves
 *   the document behind, which is exactly the state that answers the next `If-None-Match: *` with
 *   412 — a released transaction could never be retried. Releasing therefore deletes the document,
 *   which is the same unit the reservation was made in.
 *
 * Replacing a record (attaching a response, marking a conflict) needs no condition: only the caller
 * that won the create-once race ever does it.
 */
import { createHash } from 'node:crypto';
import { buildPodResourceIriForResource } from '@undefineds.co/drizzle-solid';
import { taskResource, TaskStatus, type TaskStatusType } from '@undefineds.co/models';
import { MatrixError } from './MatrixError';
import type { MatrixPodWrite } from './podAccess';

/** A control record's payload, as it is kept in the row's opaque `metadata`. */
export type MatrixControlRecordMetadata = Record<string, unknown>;

/** One keyed control record, decoded from its row. */
export interface MatrixControlRecord {
  key: string;
  /** The document that holds it; one record per document is what makes reserving atomic. */
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
 * The document and subject a key maps to.
 *
 * The key is hashed because a peer chooses half of it (a transaction id is an arbitrary path
 * segment): the document name has to be one path segment whatever arrives, and it must be stable
 * across restarts. What the record is *about* stays in its metadata, readable in the Pod.
 */
export function controlRecordAddress(podUrl: string, key: string): { id: string; resource: string; subject: string } {
  const name = createHash('sha256').update(key).digest('hex');
  const id = `${name}.ttl#self`;
  const subject = buildPodResourceIriForResource(podUrl, taskResource, id);
  return { id, resource: subject.split('#')[0], subject };
}

/**
 * Claim a key, or hand back the record that already holds it.
 *
 * `created` is the whole point: exactly one caller is told it may do the work. The loser is given
 * the winner's record — a replay is answered from the first attempt, never processed again.
 */
export async function createControlRecord(
  target: MatrixControlRecordTarget,
  input: WriteControlRecordInput,
): Promise<{ record: MatrixControlRecord; created: boolean }> {
  const { id, resource, subject } = controlRecordAddress(target.scope, input.key);
  await ensureContainer(target, containerOf(resource));
  const db = target.write.db;
  const response = await target.write.fetch(resource, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/sparql-update',
      // The condition is the reservation. A 412 means somebody else's claim is already there.
      'If-None-Match': '*',
    },
    body: db.insert(taskResource).values({
      id,
      instruction: input.instruction,
      workspace: target.scope,
      status: input.status,
      metadata: input.metadata,
    } as never).toSPARQL().query,
  });

  if (response.status === 412) {
    // The winner's write is committed, but a reader can still arrive before it is visible: a race
    // measured against a real Pod had the losing side's first read come back empty. Waiting a few
    // milliseconds for the record the Pod just told us exists is the difference between answering
    // the peer and failing a transaction that was in fact recorded.
    const existing = await readWithRetry(target, input.key);
    if (!existing) {
      // It exists and stayed unreadable: refuse rather than pretend the reservation succeeded, or
      // overwrite a document this code does not understand.
      throw new MatrixError(500, 'M_UNKNOWN', `Control record ${input.key} exists but could not be read`);
    }
    return { record: existing, created: false };
  }
  if (response.status >= 300) {
    throw new MatrixError(502, 'M_UNKNOWN',
      `Could not write the control record ${input.key}: ${response.status} ${response.statusText}`);
  }
  return {
    record: { key: input.key, resource, subject, status: input.status, metadata: input.metadata },
    created: true,
  };
}

/** Read the record under a key, or `undefined` when there is none. */
export async function readControlRecord(
  target: MatrixControlRecordTarget,
  key: string,
): Promise<MatrixControlRecord | undefined> {
  const { resource, subject } = controlRecordAddress(target.scope, key);
  const row = await target.write.db.findByResource(taskResource, subject) as Record<string, unknown> | null;
  if (!row) return undefined;
  return decodeControlRecord(key, resource, subject, row);
}

/**
 * Read a record that a 412 just proved exists, giving the Pod a moment to make it visible.
 *
 * Bounded on purpose: five attempts over roughly a tenth of a second. A caller that waits longer
 * than that is not waiting for a write to settle, it is waiting on a broken deployment, and the
 * peer is better served by a loud failure than by a request that never answers.
 */
async function readWithRetry(
  target: MatrixControlRecordTarget,
  key: string,
  attempts = 5,
  delayMs = 25,
): Promise<MatrixControlRecord | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    const record = await readControlRecord(target, key);
    if (record || attempt >= attempts) return record;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

/**
 * Replace a record's status and metadata.
 *
 * Only the caller that created the record does this (attaching a first response, marking that a
 * sender reused a transaction id for a different payload), so it is an ordinary write: there is no
 * second writer to lose a race against.
 */
export async function updateControlRecord(
  target: MatrixControlRecordTarget,
  key: string,
  input: { status: TaskStatusType; metadata: MatrixControlRecordMetadata },
): Promise<void> {
  const { subject } = controlRecordAddress(target.scope, key);
  const updated = await target.write.db.updateByResource(taskResource, subject, {
    status: input.status,
    metadata: input.metadata,
  } as never);
  if (!updated) {
    throw new MatrixError(500, 'M_UNKNOWN', `Control record ${key} disappeared before it could be updated`);
  }
}

/**
 * Forget a record: used to release a reservation whose work did not finish.
 *
 * The document goes, not just the row inside it. A row-less document still exists as far as the
 * next `If-None-Match: *` is concerned, so a "released" key would be permanently unreservable.
 */
export async function deleteControlRecord(target: MatrixControlRecordTarget, key: string): Promise<void> {
  const { resource } = controlRecordAddress(target.scope, key);
  const response = await target.write.fetch(resource, { method: 'DELETE' });
  // Already gone is the state we wanted; anything else that failed is worth reporting.
  if (response.status >= 300 && response.status !== 404) {
    throw new MatrixError(502, 'M_UNKNOWN',
      `Could not release the control record ${key}: ${response.status} ${response.statusText}`);
  }
}

/**
 * Make sure the container a record's document lives in exists.
 *
 * Not an optimization: without it the document cannot be deleted later (see the module note), so a
 * release would leave a key reserved for ever. The write is conditional and its 409 ("it is already
 * there") is the expected answer on every call after the first, which is why this needs no memory
 * of its own — a deployment that forgot would only risk an extra request, never a wrong one.
 */
async function ensureContainer(target: MatrixControlRecordTarget, container: string): Promise<void> {
  const response = await target.write.fetch(container, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      'If-None-Match': '*',
    },
    body: '',
  });
  if (response.status >= 300 && response.status !== 409 && response.status !== 412) {
    throw new MatrixError(502, 'M_UNKNOWN',
      `Could not prepare ${container} for control records: ${response.status} ${response.statusText}`);
  }
}

/** The container a document lives in: everything up to its last path segment. */
function containerOf(resource: string): string {
  return resource.slice(0, resource.lastIndexOf('/') + 1);
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
  resource: string,
  subject: string,
  row: Record<string, unknown>,
): MatrixControlRecord {
  const metadata = isRecord(row.metadata) ? { ...row.metadata } : {};
  delete metadata['@id'];
  delete metadata.id;
  return {
    key,
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
