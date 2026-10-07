/**
 * Control records: the keyed facts the protocol needs that no entity owns.
 *
 * An inbound transaction's receipt (`origin`, `txnId`, what the first attempt answered) and an
 * outbound delivery batch both have to survive a restart, and both are looked up by key rather
 * than by walking a room. The register settled what carries them: the models `taskResource`, which
 * is already keyed, has a status, an opaque `metadata` column and two timestamps.
 *
 * **Where they live follows the models convention for records that accumulate** — the one messages
 * and deliveries already use: inside a parent directory, split by day (`src/message.schema.ts`:
 * `{parent.dir}/{yyyy}/{MM}/{dd}/messages.ttl#{key}`). Control records are the same kind of thing,
 * so they live in `<pod>/.data/task/{yyyy}/{MM}/{dd}/`, the models task base under the models date
 * buckets — **one document per record** (`<sha256(key)>.ttl#self`), and the day directory is a real
 * container listing them.
 *
 * The document granularity is not cosmetic. A day document holding several *rows* was measured to
 * lose data on a real Pod (2026-09-27): drizzle-solid writes an `object` column's value as its own
 * subject, and that subject is derived from the row's position rather than from the row's identity
 * (`<document>#metadata-1`), so two rows in one document write their `metadata` to the *same*
 * subject and the triples merge. Two records — an inbound receipt and a delivery batch — came back
 * as one record whose `kind` was `["inbound-transaction","outbound-batch"]`. One record per document
 * keeps every nested subject its own. The day directory still gives what the layout was for: a
 * client that owns its own sync state can list (and subscribe to) a day and see its records.
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
 *
 * **The day directories are created as containers before anything is written into them**, and that
 * is not cosmetic: a document written into a path whose containers do not exist is invisible to the
 * Solid ways of finding it — the container answers 404, so nothing lists it and nothing can
 * subscribe to it. Measured on a real Pod (2026-09-27): a document written into
 * `.data/task/2026/09/28/` read back by URL, while `GET` of `2026/` and `2026/09/28/` both answered
 * 404. A client that owns its own sync state discovers records by listing them; without the
 * containers there is nothing to list.
 */
import { createHash } from 'node:crypto';
import { Parser, DataFactory, termToId, type Quad } from 'n3';
import { Parser as SparqlParser, Generator as SparqlGenerator } from 'sparqljs';
import { buildPodResourceIriForResource, drizzle } from '@undefineds.co/drizzle-solid';
import { isDeepStrictEqual } from 'node:util';
import { dateParts, taskResource, TaskStatus, type TaskStatusType } from '@undefineds.co/models';
import { MatrixError } from './MatrixError';
import type { MatrixPodWrite } from './podAccess';
import { isSolidAuth } from '../auth/AuthContext';
import type { MatrixStoreContext } from './types';
import { parseMembershipAuthorityBinding, type MembershipAuthorityBinding } from './canonicalRoomSource';

/**
 * What a record is for.
 *
 * The kind is part of the document name (`txn-…` / `outbound-…`) inside the day directory. One
 * directory per day keeps the models convention; the prefix lets a lister pick the records it wants
 * from the container listing it already has, without reading the ones it does not — which is what
 * keeps enumerating a queue bounded by the queue rather than by everything the day holds.
 */
export type MatrixControlRecordKind = 'txn' | 'outbound';

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
  /** What the record is for; see `MatrixControlRecordKind`. */
  kind: MatrixControlRecordKind;
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
  kind: MatrixControlRecordKind;
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

/** The subject every record document describes: one record, one document, one subject. */
const CONTROL_RECORD_SUBJECT = 'self';

/** `ldp:contains`, which is how a container answers "what is in me". */
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

/**
 * Day directories this process has already prepared.
 *
 * A local accelerator, rebuilt on restart: the write that prepares a container is conditional, so
 * forgetting only costs a request, and remembering cannot make a wrong one.
 */
const preparedContainers = new Set<string>();

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
 * The key is hashed for the document name: half of it is chosen by a peer (a transaction id is an
 * arbitrary string), and a document name has to be one path segment whatever arrives. Hashing also
 * keeps two keys apart in the same day, and the kind prefix keeps the two kinds of record apart.
 * What the record is *about* stays in its metadata.
 */
export function controlRecordAddress(
  podUrl: string,
  kind: MatrixControlRecordKind,
  key: string,
  bucket: string,
): { id: string; resource: string; subject: string } {
  const name = createHash('sha256').update(key).digest('hex');
  const id = `${bucket}/${kind}-${name}.ttl#${CONTROL_RECORD_SUBJECT}`;
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
  const existing = await readControlRecord(target, input.kind, input.key, { at: input.at });
  if (existing) return { record: existing, created: false };

  const bucket = controlRecordBucket(input.at);
  const { id, resource, subject } = controlRecordAddress(target.scope, input.kind, input.key, bucket);
  await ensureDayContainers(target, resource, bucket);
  await target.write.db.insert(taskResource).values({
    id,
    instruction: input.instruction,
    workspace: target.scope,
    status: input.status,
    metadata: input.metadata,
  } as never).execute();
  return {
    record: { key: input.key, kind: input.kind, bucket, resource, subject, status: input.status, metadata: input.metadata },
    created: true,
  };
}

/** Read the record under a key, or `undefined` when there is none in the retention window. */
export async function readControlRecord(
  target: MatrixControlRecordTarget,
  kind: MatrixControlRecordKind,
  key: string,
  options: { at?: Date | string | number; days?: number } = {},
): Promise<MatrixControlRecord | undefined> {
  for (const bucket of controlRecordBuckets(options.at ?? Date.now(), options.days)) {
    const { resource, subject } = controlRecordAddress(target.scope, kind, key, bucket);
    const row = await target.write.db.findByResource(taskResource, subject) as Record<string, unknown> | null;
    if (row) return decodeControlRecord(key, kind, bucket, resource, subject, row);
  }
  return undefined;
}

/**
 * Every record of one kind in the window, read from the day directories that hold them.
 *
 * This is the enumeration a client (or a deployment's own queue) needs after a restart. It is
 * bounded by what it enumerates: one container listing per day in the window — a single request,
 * because a container answers with all its members at once — and one document read per *matching*
 * member, picked by the name prefix the kind gives it.
 */
export async function listControlRecords(
  target: MatrixControlRecordTarget,
  kind: MatrixControlRecordKind,
  options: { at?: Date | string | number; days?: number } = {},
): Promise<MatrixControlRecord[]> {
  const records: MatrixControlRecord[] = [];
  for (const bucket of controlRecordBuckets(options.at ?? Date.now(), options.days)) {
    const { resource, subject } = controlRecordAddress(target.scope, kind, '', bucket);
    const container = resource.slice(0, resource.lastIndexOf(bucket)) + `${bucket}/`;
    const response = await target.write.fetch(container, { method: 'GET', headers: { Accept: 'text/turtle' }});
    // A day with nothing in it is not an error: it is a day with nothing in it.
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new MatrixError(502, 'M_UNKNOWN',
        `Could not list ${container}: ${response.status} ${response.statusText}`);
    }
    for (const member of await containedDocuments(await response.text(), container)) {
      if (!isRecordDocument(member, kind)) continue;
      const subject = `${member}#${CONTROL_RECORD_SUBJECT}`;
      const row: Record<string, unknown> | null = await target.write.db.findByResource(taskResource, subject);
      if (!row) continue;
      records.push(decodeControlRecord('', kind, bucket, member, subject, row));
    }
  }
  return records;
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

const namedPublicationAuthorities = new WeakSet<object>();
export interface NamedPublicationControlAuthority {
  kind: 'named-publication';
  webId: string;
  podUrl: string;
  binding: MembershipAuthorityBinding;
  beforeRequest: () => Promise<void>;
}
export async function createNamedPublicationControlAuthority(input: NamedPublicationControlAuthority): Promise<NamedPublicationControlAuthority> {
  if (!parseMembershipAuthorityBinding(input.binding) || !input.webId || !input.podUrl || typeof input.beforeRequest !== 'function') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'A complete named publication authority is required');
  }
  await input.beforeRequest();
  const authority = Object.freeze({ ...input, binding: Object.freeze({ ...input.binding }) });
  namedPublicationAuthorities.add(authority);
  return authority;
}
export type PublicationControlAuthority = MatrixStoreContext | NamedPublicationControlAuthority;

/** Publication-only exact deletion; ordinary record removal retains its existing semantics. */
export async function deletePublicationControlRecordExactly(target: MatrixControlRecordTarget,
  expected: MatrixControlRecord, caller: PublicationControlAuthority): Promise<void> {
  await mutatePublicationControlRecordExactly(target, expected, caller);
}

export async function transitionPublicationControlRecordExactly(target: MatrixControlRecordTarget,
  expected: MatrixControlRecord, next: WriteControlRecordInput, caller: PublicationControlAuthority): Promise<boolean> {
  if (next.kind !== expected.kind || controlRecordBucket(next.at) !== expected.bucket) {
    throw new MatrixError(409, 'M_CONFLICT', 'Publication transition must retain its original day bucket');
  }
  return await mutatePublicationControlRecordExactly(target, expected, caller, next);
}

async function mutatePublicationControlRecordExactly(target: MatrixControlRecordTarget,
  expected: MatrixControlRecord, caller: PublicationControlAuthority, next?: WriteControlRecordInput): Promise<boolean> {
  if ('kind' in caller && caller.kind === 'named-publication') {
    if (!namedPublicationAuthorities.has(caller) || caller.podUrl !== target.scope) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Publication task authority was not minted for this scope');
    }
    await caller.beforeRequest();
  } else {
    const original = caller as MatrixStoreContext;
    if (original.service || !original.auth || !isSolidAuth(original.auth) || original.auth.webId !== original.webId
      || original.podUrl !== target.scope) throw new MatrixError(403, 'M_FORBIDDEN', 'Publication deletion requires the original caller');
  }
  const document = expected.subject.split('#')[0];
  const response = await target.write.fetch(document, { method: 'GET', redirect: 'error', headers: { Accept: 'text/turtle' } });
  if (response.status === 404 && !response.redirected && response.url === document) return !next;
  if (!response.ok || response.redirected || response.url !== document) {
    throw new MatrixError(409, 'M_CONFLICT', 'The publication record could not be read exactly');
  }
  const ttl = await response.clone().text();
  let served = false;
  const sealed: typeof fetch = async(input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (served || url !== document || String(init?.method ?? 'GET').toUpperCase() !== 'GET') {
      throw new MatrixError(409, 'M_CONFLICT', 'Publication record hydration must use the same original body');
    }
    served = true;
    return response.clone();
  };
  const db = drizzle({ fetch: sealed, info: { webId: caller.webId, podUrl: caller.podUrl, isLoggedIn: true } } as never,
    { podUrl: caller.podUrl, resourcePreparation: 'off', disableInteropDiscovery: true });
  const row = await db.findByIri(taskResource, expected.subject) as Record<string, unknown> | null;
  if (!row && next) return false;
  if (!row) throw new MatrixError(409, 'M_CONFLICT', 'Publication record has no matching ORM row');
  const hydrated = decodeControlRecord(expected.key, expected.kind, expected.bucket, expected.resource, expected.subject, row);
  if (next && (!hydrated || !isDeepStrictEqual(hydrated, expected))) return false;
  if (!hydrated || !isDeepStrictEqual(hydrated, expected)) throw new MatrixError(409, 'M_CONFLICT', 'Publication record changed before deletion');
  const raw = new Map<string, Quad>();
  const key = (q: Quad): string => `${termToId(q.subject)}|${termToId(q.predicate)}|${termToId(q.object)}`;
  for (const quad of new Parser({ baseIRI: document }).parse(ttl)) raw.set(key(quad), quad);
  const metadataPredicate = taskResource.getColumn('metadata')!.getPredicate(taskResource.config.namespace);
  const metadataEdges = [ ...raw.values() ].filter(q => q.subject.value === expected.subject && q.predicate.value === metadataPredicate);
  if (metadataEdges.length !== 1 || metadataEdges[0].object.termType !== 'NamedNode') {
    throw new MatrixError(409, 'M_CONFLICT', 'Publication metadata is ambiguous');
  }
  const subjects = [ expected.subject, metadataEdges[0].object.value ];
  const captured = [ ...raw.values() ].filter(q => subjects.includes(q.subject.value));
  const serialized = new SparqlParser().parse(db.insert(taskResource).values(row as never).toSPARQL().query) as unknown as {
    updates: Array<{ insert?: unknown[] }> };
  const emitted: Quad[] = [];
  const collect = (entries: unknown[]): void => {
    for (const entry of entries) {
      const pattern = entry as { triples?: Quad[]; patterns?: unknown[] };
      emitted.push(...pattern.triples ?? []);
      if (pattern.patterns) collect(pattern.patterns);
    }
  };
  for (const update of serialized.updates) collect(update.insert ?? []);
  const serializedSet = new Set(emitted.filter(q => subjects.includes(q.subject.value)).map(key));
  if (serializedSet.size !== captured.length || captured.some(q => !serializedSet.has(key(q)))) {
    throw new MatrixError(409, 'M_CONFLICT', 'Raw and ORM publication record terms differ');
  }
  const graph = DataFactory.namedNode(document);
  const where: unknown[] = [ { type: 'graph', name: graph, patterns: [ { type: 'bgp', triples: captured } ] } ];
  for (const [ index, subject ] of subjects.entries()) {
    const predicate = DataFactory.variable(`p${index}`), object = DataFactory.variable(`o${index}`);
    const expectedTerms = captured.filter(q => q.subject.value === subject).map(q => ({ type: 'operation', operator: '&&', args: [
      { type: 'operation', operator: 'sameterm', args: [ predicate, q.predicate ] },
      { type: 'operation', operator: 'sameterm', args: [ object, q.object ] },
    ] }));
    const allowed = expectedTerms.slice(1).reduce<unknown>((left, right) =>
      ({ type: 'operation', operator: '||', args: [ left, right ] }), expectedTerms[0]);
    where.push({ type: 'filter', expression: { type: 'operation', operator: 'notexists', args: [ {
      type: 'graph', name: graph, patterns: [ { type: 'bgp', triples: [ { subject: DataFactory.namedNode(subject), predicate, object } ] },
        { type: 'filter', expression: { type: 'operation', operator: '!', args: [ allowed ] } } ],
    } ] } });
  }
  let nextAddress: ReturnType<typeof controlRecordAddress> | undefined;
  let nextTriples: Quad[] = [];
  if (next) {
    nextAddress = controlRecordAddress(target.scope, next.kind, next.key, expected.bucket);
    const nextRow = { ...row, id: nextAddress.id, instruction: next.instruction, status: next.status, metadata: next.metadata };
    delete (nextRow as Record<string, unknown>)['@id'];
    const nextAst = new SparqlParser().parse(target.write.db.insert(taskResource).values(nextRow as never).toSPARQL().query) as unknown as { updates: Array<{ insert?: unknown[] }> };
    emitted.length = 0;
    for (const update of nextAst.updates) collect(update.insert ?? []);
    nextTriples = [ ...emitted ];
    if (!nextTriples.some(q => q.subject.value === nextAddress!.subject)) {
      throw new MatrixError(409, 'M_CONFLICT', 'Public ORM did not serialize the replacement publication record');
    }
    if (nextAddress.subject !== expected.subject) {
      // The fresh transaction cannot overwrite an unrelated pre-existing record or metadata.
      for (const [ index, subject ] of [ ...new Set(nextTriples.map(q => q.subject.value)) ].entries()) {
        where.push({ type: 'filter', expression: { type: 'operation', operator: 'notexists', args: [ {
          type: 'graph', name: DataFactory.namedNode(nextAddress.resource), patterns: [ { type: 'bgp', triples: [ {
            subject: DataFactory.namedNode(subject), predicate: DataFactory.variable(`newP${index}`), object: DataFactory.variable(`newO${index}`),
          } ] } ],
        } ] } });
      }
    }
  }
  const query = new SparqlGenerator().stringify({ type: 'update', prefixes: {}, updates: [ { updateType: 'insertdelete',
    delete: [ { type: 'graph', name: graph, triples: nextAddress?.subject === expected.subject
      ? captured : captured.filter(q => q.subject.value === expected.subject) } ],
    insert: nextAddress ? [ { type: 'graph', name: DataFactory.namedNode(nextAddress.resource), triples: nextTriples } ] : [], where,
  } ] } as never);
  const endpoint = `${document.slice(0, document.lastIndexOf('/') + 1)}-/sparql`;
  let updateError: unknown;
  try { await target.write.db.getDialect().executeOnResource(endpoint, { type: next ? 'UPDATE' : 'DELETE', query, prefixes: {} }, { mode: 'sparql', endpoint }); }
  catch (error) { updateError = error; }
  await target.write.db.getDialect().getSPARQLExecutor()?.invalidateHttpCache?.(document);
  if (nextAddress) {
    await target.write.db.getDialect().getSPARQLExecutor()?.invalidateHttpCache?.(nextAddress.resource);
    const proof = await target.write.fetch(nextAddress.resource, { method: 'GET', redirect: 'error', headers: { Accept: 'text/turtle' } });
    if (!proof.ok || proof.redirected || proof.url !== nextAddress.resource) {
      if (updateError) throw updateError;
      return false;
    }
    const actual = new Parser({ baseIRI: nextAddress.resource }).parse(await proof.text());
    const nextSubjects = new Set(nextTriples.map(q => q.subject.value));
    const actualSet = new Set(actual.filter(q => nextSubjects.has(q.subject.value)).map(key));
    const expectedSet = new Set(nextTriples.map(key));
    if (actualSet.size !== expectedSet.size || [ ...expectedSet ].some(term => !actualSet.has(term))) {
      if (updateError) throw updateError;
      return false;
    }
    if (nextAddress.subject === expected.subject) return true;
  }
  const readback = await target.write.fetch(document, { method: 'GET', redirect: 'error', headers: { Accept: 'text/turtle' } });
  if (readback.status === 404 && !readback.redirected && readback.url === document) return true;
  if (!readback.ok || readback.redirected || readback.url !== document) {
    if (updateError) throw updateError;
    throw new MatrixError(409, 'M_CONFLICT', 'Publication deletion could not be confirmed');
  }
  const remaining = new Parser({ baseIRI: document }).parse(await readback.text());
  if (remaining.some(q => q.subject.value === expected.subject)) {
    if (next) return false;
    if (updateError) throw updateError;
    throw new MatrixError(409, 'M_CONFLICT', 'Publication record changed or remained after conditional deletion');
  }
  return true;
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
  kind: MatrixControlRecordKind,
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
    kind,
    bucket,
    resource,
    subject,
    status: (typeof row.status === 'string' ? row.status : TaskStatus.OPEN) as TaskStatusType,
    metadata,
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
  };
}

/** The members a container says it holds, parsed as Turtle. */
async function containedDocuments(body: string, container: string): Promise<string[]> {
  return new Parser({ baseIRI: container }).parse(body)
    .filter(quad => quad.predicate.value === LDP_CONTAINS)
    .map(quad => quad.object.value);
}

/** Whether a container member is a record document of this kind. */
function isRecordDocument(iri: string, kind: MatrixControlRecordKind): boolean {
  const name = iri.split('/').pop() ?? '';
  return name.startsWith(`${kind}-`) && name.endsWith('.ttl');
}

/**
 * Forget whole days of records, outermost policy left to the caller.
 *
 * The lookup window (see `CONTROL_RECORD_LOOKBACK_DAYS`) is the *logical* retention: a record older
 * than it is not found, so a retry that late is treated as new. This is the *physical* half — the
 * documents themselves — and it is deliberately not scheduled here: how long an operator keeps
 * receipts for is their decision, so they name the days, and this deletes what those days hold.
 *
 * The document goes with the record: a day directory listing is how a client finds records, and an
 * empty document left behind would keep appearing in it. `deleteResourceWithDocument` is the
 * database's own "delete the row and its file" operation, so nothing here bypasses drizzle-solid.
 */
export async function pruneControlRecords(
  target: MatrixControlRecordTarget,
  kind: MatrixControlRecordKind,
  buckets: readonly string[],
): Promise<number> {
  let pruned = 0;
  for (const bucket of buckets) {
    const { resource, subject } = controlRecordAddress(target.scope, kind, '', bucket);
    const container = resource.slice(0, resource.lastIndexOf(bucket)) + `${bucket}/`;
    const response = await target.write.fetch(container, { method: 'GET', headers: { Accept: 'text/turtle' }});
    // A day with nothing in it is not an error: it is a day with nothing in it.
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new MatrixError(502, 'M_UNKNOWN',
        `Could not list ${container} to prune it: ${response.status} ${response.statusText}`);
    }
    const base = resource.slice(0, resource.lastIndexOf(bucket));
    for (const member of await containedDocuments(await response.text(), container)) {
      if (!isRecordDocument(member, kind)) continue;
      const subject = `${member}#${CONTROL_RECORD_SUBJECT}`;
      const row: Record<string, unknown> | null = await target.write.db.findByResource(taskResource, subject);
      if (!row) continue;
      await target.write.db.deleteResourceWithDocument(taskResource, {
        id: `${member.slice(base.length)}#${CONTROL_RECORD_SUBJECT}`,
        url: member,
      });
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * Make the containers a record's document lives in exist, outermost first.
 *
 * The chain starts at the models task base and ends at the day itself; nothing above the base is
 * touched. Each step is a conditional `PUT` of a `BasicContainer`, and "it is already there" is the
 * expected answer on every call after the first, which is why this needs no authority of its own.
 */
async function ensureDayContainers(
  target: MatrixControlRecordTarget,
  resource: string,
  bucket: string,
): Promise<void> {
  const base = resource.slice(0, resource.lastIndexOf(bucket));
  const chain = [ base ];
  for (const part of bucket.split('/')) chain.push(`${chain[chain.length - 1]}${part}/`);
  for (const current of chain) {
    if (preparedContainers.has(current)) continue;
    const response = await target.write.fetch(current, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        'If-None-Match': '*',
      },
      body: '',
    });
    // 201 created it; 409/412 means somebody (or an earlier call) already had.
    if (response.status >= 300 && response.status !== 409 && response.status !== 412) {
      throw new MatrixError(502, 'M_UNKNOWN',
        `Could not prepare ${current} for control records: ${response.status} ${response.statusText}`);
    }
    preparedContainers.add(current);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
