import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  executeQuery,
  executeStatement,
  isDatabaseSqlite,
  type IdentityDatabase,
} from '../../identity/drizzle/db';

export interface MatrixTransactionReservation {
  eventId: string;
  createdAt: number;
  contentHash: string;
}

/**
 * The transaction key a stored event belongs to, rebuilt from the event itself.
 *
 * A reservation is addressed by this key, and the key names the device that sent it — the one part
 * of it an event does not otherwise carry, which is why the row stores `txnDevice`. Rebuilding it
 * here is what lets a carrier that keeps reservations per key (rather than an id index) answer
 * "which reservation does this event belong to" with one point lookup: the four lookups in
 * `PodMatrixStore` all hold the whole event.
 *
 * Returns `undefined` for an event that never came from a reserved transaction (a received event, a
 * state event written outside one), which is not an error: it simply has no receipt.
 */
export function reservationKeyForEvent(event: {
  roomId?: string;
  type?: string;
  txnId?: string;
  txnDevice?: string;
}): string | undefined {
  const { roomId, type, txnId, txnDevice } = event;
  if (!roomId || !type || !txnId || !txnDevice) return undefined;
  return JSON.stringify([ txnDevice, roomId, type, txnId ]);
}

/** Operational references only: event bodies and room state remain authoritative in the Pod. */
/**
 * What a caller has when it asks "which reservation produced this event".
 *
 * The whole event, not just its id: a reservation is addressed by
 * `[txnDevice, roomId, type, txnId]` (`reservationKeyForEvent`), and the id alone cannot rebuild
 * that. A carrier that keeps records by key can then answer with one point lookup, while one that
 * keeps an id index (the identity database today) reads `eventId` and ignores the rest.
 */
export interface MatrixReservationLookup {
  eventId: string;
  roomId?: string;
  type?: string;
  txnId?: string;
  txnDevice?: string;
}

/**
 * The Pod a reservation is written to, when the carrier needs one.
 *
 * Passed per call rather than resolved from the scope, because a reservation is written on the
 * **caller's** path: a client session writing its own Pod must carry the session's authority, and a
 * deployment writing for a participant must carry that participant's grant. Guessing one from the
 * scope gets the first case wrong — measured: wiring the service handle in made every caller write
 * fail with 403 on a real stack.
 */
export type MatrixReservationAuthority = import('./controlRecords').MatrixControlRecordTarget;

/**
 * An exact, rebuildable operational reference to one committed event.
 *
 * The Pod holds the authoritative body; this cursor entry only names where the event lives so a
 * pull can fetch it by exact IRI instead of scanning the whole room history. `sequence` is the
 * journal's per-scope discovery order used for paging; `createdAt` is the event's own time, used
 * only for a stable `(createdAt, id)` snapshot, never as a discovery cutoff.
 */
export interface MatrixEventReference {
  scope: string;
  roomId: string;
  eventId: string;
  /** The exact message IRI in the Pod, when known (registered after the durable write). */
  messageIri?: string;
  createdAt: number;
  sequence: number;
}

export interface ListEventReferencesOptions {
  /** Exclusive lower bound: return references with `sequence > afterSequence`. */
  afterSequence?: number;
  /** Inclusive fixed upper bound for a stable snapshot page; new references are excluded. */
  throughSequence?: number;
  /** Bound on the page size. */
  limit: number;
  /** Restrict to one room when the caller knows which room changed. */
  roomId?: string;
}

/**
 * The durable reconciliation checkpoint: where one bounded, resumable source scan has reached.
 *
 * It is operational and rebuildable, never payload/authority/membership truth: it bounds the
 * receiver scope, the current index epoch, the source boundary and a fixed view, and carries a
 * bounded `(createdAt, exactIRI)` source cursor. A completed scan rotates to a fresh
 * `scanGeneration` from the beginning, so `createdAt` is never a permanent watermark and a row
 * discovered days late is still reachable.
 */
export interface MatrixReconcileCheckpoint {
  scope: string;
  sourceUri: string;
  epoch: string;
  scanGeneration: number;
  revision: number;
  view?: string;
  roomCursor?: string;
  bucketCursor?: string;
  lastCreatedAt?: number;
  /** Absolute full source identity of the last consumed row (never an event logical id). */
  lastSourceIri?: string;
  startedAt: number;
  lastCompletedAt?: number;
}

export interface BeginMatrixReconcileScan {
  sourceUri: string;
  view?: string;
  /** Expected current epoch; a mismatch is a stale scan and is rejected. */
  epoch?: string;
}

/** A paired source keyset position: a finite event time and the absolute full source identity. */
export interface MatrixReconcileSourceKey {
  createdAt: number;
  sourceIri: string;
}

/**
 * The bounded source cursor of the last row a page consumed. A room/bucket marker may carry no
 * per-row keyset at all (a declared coarse boundary); a keyset position is always the pair
 * `(createdAt, sourceIri)` of the last source row, never an event's logical id.
 */
export interface MatrixReconcileScanCursor {
  roomId?: string;
  bucket?: string;
  /** Both parts present together; a lone timestamp or IRI is rejected before any mutation. */
  last?: MatrixReconcileSourceKey;
}

/**
 * One page of exact references plus the compare-and-swap identity of the checkpoint it was built
 * from. The reference publication and the checkpoint advance happen in one transaction, so a
 * half-written page advances nothing and a lost CAS publishes nothing.
 */
export interface MatrixReferencePage {
  sourceUri: string;
  epoch: string;
  scanGeneration: number;
  revision: number;
  references: readonly Omit<MatrixEventReference, 'scope' | 'sequence'>[];
  /** Last source row consumed; ignored when `complete`. */
  next?: MatrixReconcileScanCursor;
  /** Completing the authorized-history pass rotates to a fresh generation from the beginning. */
  complete: boolean;
  /**
   * A serialized cycle view to bind atomically with the first published page. Only accepted while
   * the checkpoint has no bound view AND no source/room/bucket cursor; otherwise it must equal the
   * already-bound view or the page fails with zero effects.
   */
  view?: string;
}

/** The serialized cycle view a source binds on its first page. */
export interface MatrixReconcileCycleView {
  version: 1;
  upper: { createdAt: number; sourceIri: string } | null;
  observation: string | null;
}

/** Parse a serialized cycle view, rejecting anything that is not the declared shape. */
export function parseReconcileCycleView(view: string): MatrixReconcileCycleView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(view);
  } catch {
    throw new Error('Reconcile cycle view is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Reconcile cycle view has an unsupported version');
  }
  const { upper, observation } = parsed as { upper?: unknown; observation?: unknown };
  if (observation !== null && typeof observation !== 'string') {
    throw new Error('Reconcile cycle view observation must be a string or null');
  }
  if (upper !== null) {
    if (!upper || typeof upper !== 'object') {
      throw new Error('Reconcile cycle view upper must be a keyset or null');
    }
    const keyset = upper as { createdAt?: unknown; sourceIri?: unknown };
    if (typeof keyset.createdAt !== 'number' || !Number.isFinite(keyset.createdAt)) {
      throw new Error('Reconcile cycle view upper time must be finite');
    }
    if (typeof keyset.sourceIri !== 'string' || keyset.sourceIri.length === 0) {
      throw new Error('Reconcile cycle view upper needs a source IRI');
    }
    validateReconcileSourceIri(keyset.sourceIri);
  }
  return { version: 1, upper: (upper ?? null) as MatrixReconcileCycleView['upper'], observation: observation as string | null };
}

export interface MatrixReferencePageResult {
  /** False for a stale epoch or a lost CAS; nothing was published in that case. */
  advanced: boolean;
  checkpoint: MatrixReconcileCheckpoint;
  references: MatrixEventReference[];
}

/**
 * A reconciliation source boundary is an absolute HTTP(S) URL and nothing else: no embedded
 * credentials, no query and no fragment, so it can never smuggle an authority or a scope selector.
 */
export function validateReconcileSourceUri(sourceUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUri);
  } catch {
    throw new Error('Reconcile source must be an absolute URI');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Reconcile source must be an HTTP(S) URI');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('Reconcile source must not carry credentials, a query or a fragment');
  }
}

/**
 * A source-row keyset identity: an absolute, full HTTP(S) source IRI with no embedded credentials or
 * query. A source-appropriate fragment is allowed (it names the row within a source document), but a
 * bare event logical id is not a source identity and is rejected.
 */
export function validateReconcileSourceIri(sourceIri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceIri);
  } catch {
    throw new Error('Reconcile source IRI must be an absolute URI');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Reconcile source IRI must be an HTTP(S) URI');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '') {
    throw new Error('Reconcile source IRI must not carry credentials or a query');
  }
}

function checkpointKey(scope: string, sourceUri: string): string {
  return `${scope}\u0000${sourceUri}`;
}

/**
 * A reference page is bounded and its CAS identity is a pair of safe non-negative counters. Every
 * reference and the paired source cursor are validated before any mutation, so an invalid page
 * rejects with no partial publication; an oversized page is rejected rather than truncated.
 */
function validateReferencePage(page: MatrixReferencePage): void {
  validateReconcileSourceUri(page.sourceUri);
  if (page.view !== undefined) {
    parseReconcileCycleView(page.view);
  }
  if (!Number.isSafeInteger(page.scanGeneration) || page.scanGeneration < 0) {
    throw new Error('Reconcile scanGeneration must be a non-negative integer');
  }
  if (!Number.isSafeInteger(page.revision) || page.revision < 0) {
    throw new Error('Reconcile revision must be a non-negative integer');
  }
  if (page.references.length > MAX_REFERENCE_PAGE) {
    throw new Error(`Reference page exceeds the ${MAX_REFERENCE_PAGE} reference cap`);
  }
  for (const reference of page.references) {
    if (typeof reference.roomId !== 'string' || reference.roomId.length === 0) {
      throw new Error('Reconcile reference needs a room id');
    }
    if (typeof reference.eventId !== 'string' || reference.eventId.length === 0) {
      throw new Error('Reconcile reference needs an event id');
    }
    if (!Number.isFinite(reference.createdAt)) {
      throw new Error('Reconcile reference time must be finite');
    }
  }
  const last = page.next?.last;
  if (last !== undefined) {
    if (typeof last.createdAt !== 'number' || !Number.isFinite(last.createdAt)) {
      throw new Error('Reconcile cursor time must be a finite number');
    }
    if (typeof last.sourceIri !== 'string' || last.sourceIri.length === 0) {
      throw new Error('Reconcile cursor needs an absolute source IRI');
    }
    validateReconcileSourceIri(last.sourceIri);
  }
  // An incomplete page must carry a real resumption position: either a complete paired keyset, or a
  // declared non-empty room/bucket boundary. An absent or empty cursor on an unfinished page is
  // rejected before any mutation, because it would advance `revision` while wiping the cursor and
  // silently lose the rest of the source.
  if (!page.complete) {
    const cursor = page.next;
    const boundary = typeof cursor?.roomId === 'string' && cursor.roomId.length > 0
      ? cursor.roomId
      : typeof cursor?.bucket === 'string' && cursor.bucket.length > 0
        ? cursor.bucket
        : undefined;
    if (last === undefined && boundary === undefined) {
      throw new Error('An incomplete reconcile page needs a paired source cursor or a room/bucket boundary');
    }
  }
}

/**
 * Bind (or verify) the cycle view for one page.
 *
 * A page may supply a view only to bind it on the *first* page of a cycle: the checkpoint must have
 * no bound view AND no source/room/bucket cursor yet. Once bound, the view is immutable — a later
 * page that supplies a different view is rejected with zero effects, and a page that omits it keeps
 * the bound one. Returns the checkpoint to advance from, or `undefined` when the view conflicts.
 */
function bindCycleView(
  current: MatrixReconcileCheckpoint,
  page: MatrixReferencePage,
): MatrixReconcileCheckpoint | undefined {
  if (page.view === undefined) {
    return current;
  }
  // Validate before any mutation, even though the caller normally validated already.
  parseReconcileCycleView(page.view);
  const unbound = current.view === undefined
    && current.lastCreatedAt === undefined && current.lastSourceIri === undefined
    && current.roomCursor === undefined && current.bucketCursor === undefined;
  if (unbound) {
    return { ...current, view: page.view };
  }
  return current.view === page.view ? current : undefined;
}

/**
 * Advance a checkpoint by one page. A completed pass rotates to a fresh generation that starts from
 * the beginning (dropping the cursor), so an event discovered late is reachable on the next cycle.
 */
function advanceReconcileCheckpoint(
  current: MatrixReconcileCheckpoint,
  page: MatrixReferencePage,
): MatrixReconcileCheckpoint {
  if (page.complete) {
    // A completed cycle rotates to a new generation and clears its view, so the next cycle re-observes.
    return {
      scope: current.scope,
      sourceUri: current.sourceUri,
      epoch: current.epoch,
      scanGeneration: current.scanGeneration + 1,
      revision: current.revision + 1,
      startedAt: Date.now(),
      lastCompletedAt: Date.now(),
    };
  }
  const cursor = page.next;
  return {
    scope: current.scope,
    sourceUri: current.sourceUri,
    epoch: current.epoch,
    scanGeneration: current.scanGeneration,
    revision: current.revision + 1,
    ...(current.view === undefined ? {} : { view: current.view }),
    ...(cursor?.roomId === undefined ? {} : { roomCursor: cursor.roomId }),
    ...(cursor?.bucket === undefined ? {} : { bucketCursor: cursor.bucket }),
    ...(cursor?.last === undefined ? {} : { lastCreatedAt: cursor.last.createdAt, lastSourceIri: cursor.last.sourceIri }),
    startedAt: current.startedAt,
    ...(current.lastCompletedAt === undefined ? {} : { lastCompletedAt: current.lastCompletedAt }),
  };
}

/** Start a fresh generation from the beginning of the authorized history. */
function newReconcileCheckpoint(
  scope: string,
  scan: BeginMatrixReconcileScan,
  epoch: string,
  existing: MatrixReconcileCheckpoint | undefined,
): MatrixReconcileCheckpoint {
  return {
    scope,
    sourceUri: scan.sourceUri,
    epoch,
    scanGeneration: (existing?.scanGeneration ?? 0) + 1,
    revision: 0,
    ...(scan.view === undefined ? (existing?.view === undefined ? {} : { view: existing.view }) : { view: scan.view }),
    startedAt: Date.now(),
    ...(existing?.lastCompletedAt === undefined ? {} : { lastCompletedAt: existing.lastCompletedAt }),
  };
}

/** Map a stored checkpoint row, keeping absent optional bounds absent rather than zero. */
function mapReconcileCheckpoint(row: Record<string, unknown>): MatrixReconcileCheckpoint {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const instant = (value: unknown): number | undefined =>
    (value === null || value === undefined ? undefined : Number(value));
  const view = text(row.view);
  const roomCursor = text(row.room_cursor);
  const bucketCursor = text(row.bucket_cursor);
  const lastSourceIri = text(row.last_source_iri);
  const lastCreatedAt = instant(row.last_created_at);
  const lastCompletedAt = instant(row.last_completed_at);
  return {
    scope: String(row.scope),
    sourceUri: String(row.source_uri),
    epoch: String(row.epoch),
    scanGeneration: Number(row.scan_generation),
    revision: Number(row.revision),
    ...(view === undefined ? {} : { view }),
    ...(roomCursor === undefined ? {} : { roomCursor }),
    ...(bucketCursor === undefined ? {} : { bucketCursor }),
    ...(lastCreatedAt === undefined ? {} : { lastCreatedAt }),
    ...(lastSourceIri === undefined ? {} : { lastSourceIri }),
    startedAt: Number(row.started_at),
    ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }),
  };
}

/** Explicit page cap; a caller cannot ask for an unbounded reference page. */
const MAX_REFERENCE_PAGE = 4096;

/** Clamp a requested page size into the supported finite positive range. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.min(Math.floor(limit), MAX_REFERENCE_PAGE);
}

export interface MatrixEventJournal {  reserveTransaction(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixReservationAuthority,
  ): Promise<MatrixTransactionReservation>;
  /**
   * Replace an existing reservation entirely. Only valid for a reservation whose
   * output was never written, which callers must verify before taking one over:
   * an event's id is derived from the event, so a later attempt with different
   * content derives a different id and the reservation has to name the event
   * that will actually exist.
   */
  replaceReservation(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixReservationAuthority,
  ): Promise<void>;
  registerEvent(scope: string, roomId: string, eventId: string): Promise<number>;
  /**
   * Register a page of events in one pass. Sequences are assigned in input
   * order, exactly as sequential `registerEvent` calls would, but the journal
   * round-trips stay bounded instead of growing with the page size.
   */
  registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]>;
  /** Look up several receipts at once: recovery needs one per scanned event. */
  findReservations(
    scope: string,
    events: readonly MatrixReservationLookup[],
    authority?: MatrixReservationAuthority,
  ): Promise<Map<string, MatrixTransactionReservation>>;
  getHighWatermark(scope: string): Promise<number>;
  /**
   * Register an exact event reference after its durable Pod write. Idempotent per
   * `(scope, roomId, eventId)`: re-registering returns the existing sequence and never moves the
   * reference. This is discovery order, not a native-commit watermark.
   */
  registerReference(
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): Promise<MatrixEventReference>;
  /** A bounded page of references ordered by discovery sequence. */
  listReferences(scope: string, options: ListEventReferencesOptions): Promise<MatrixEventReference[]>;
  /**
   * The highest sequence with a **complete exact reference** for this scope. A legacy event-only
   * registration (no exact ref published yet) must never raise this watermark, so a feed token can
   * never advance past an event whose exact reference is not yet visible.
   */
  getPublishedReferenceWatermark(scope: string): Promise<number>;
  /** The durable operational-index epoch identity; a rebuilt index must return a new identity. */
  getEpoch(scope: string): Promise<string>;
  /** Change the epoch identity (detected SQL/index loss); old tokens become invalid. */
  bumpEpoch(scope: string): Promise<string>;
  findReservation(
    scope: string,
    event: MatrixReservationLookup,
    authority?: MatrixReservationAuthority,
  ): Promise<MatrixTransactionReservation | undefined>;
  /**
   * Begin (or reset) a durable reconciliation cycle for one source. A new cycle starts at the
   * beginning of the authorized history and keeps the previous completion time for observability.
   */
  beginReconcileScan(scope: string, scan: BeginMatrixReconcileScan): Promise<MatrixReconcileCheckpoint>;
  /** The durable checkpoint for one source, or undefined when no cycle has begun. */
  getReconcileCheckpoint(scope: string, sourceUri: string): Promise<MatrixReconcileCheckpoint | undefined>;
  /**
   * Publish a page of immutable exact references and advance the checkpoint in one transaction.
   * The compare-and-swap is `(scope, sourceUri, epoch, scanGeneration, revision)`: a stale epoch or
   * a lost CAS advances nothing, and a failed reference insert rolls the whole page back.
   */
  publishReferencePage(scope: string, page: MatrixReferencePage): Promise<MatrixReferencePageResult>;
}

/** Isolated tests only. Production cursors and reservations must survive process restarts. */
export class InMemoryMatrixEventJournal implements MatrixEventJournal {
  private readonly transactions = new Map<string, MatrixTransactionReservation>();
  private readonly events = new Map<string, number>();
  private readonly highWatermarks = new Map<string, number>();
  private readonly references = new Map<string, MatrixEventReference>();
  private readonly referenceOrder: MatrixEventReference[] = [];
  private readonly epochs = new Map<string, string>();
  /** Epoch each stored checkpoint was written under; a bump makes these checkpoints invisible. */
  private readonly checkpointEpochs = new Map<string, string>();
  private readonly checkpoints = new Map<string, MatrixReconcileCheckpoint>();
  private sequence = 0;

  public async reserveTransaction(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<MatrixTransactionReservation> {
    const identity = JSON.stringify([ scope, key ]);
    const reservation = this.transactions.get(identity) ?? { ...candidate };
    this.transactions.set(identity, reservation);
    return { ...reservation };
  }

  public async findReservation(scope: string, event: MatrixReservationLookup): Promise<MatrixTransactionReservation | undefined> {
    const key = reservationKeyForEvent(event);
    if (key) {
      const exact = this.transactions.get(JSON.stringify([ scope, key ]));
      if (exact) return { ...exact };
    }
    for (const [stored,value] of this.transactions) if (JSON.parse(stored)[0] === scope && value.eventId === event.eventId) return {...value};
    return undefined;
  }

  public async replaceReservation(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<void> {
    const identity = JSON.stringify([ scope, key ]);
    const existing = this.transactions.get(identity);
    if (existing) this.transactions.set(identity, { ...candidate });
  }

  public async registerEvent(scope: string, roomId: string, eventId: string): Promise<number> {
    const identity = JSON.stringify([ scope, roomId, eventId ]);
    const existing = this.events.get(identity);
    if (existing !== undefined) {
      return existing;
    }
    const sequence = ++this.sequence;
    this.events.set(identity, sequence);
    this.highWatermarks.set(scope, sequence);
    return sequence;
  }

  public async registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]> {
    const sequences: number[] = [];
    for (const eventId of eventIds) sequences.push(await this.registerEvent(scope, roomId, eventId));
    return sequences;
  }

  public async findReservations(scope: string, events: readonly MatrixReservationLookup[]): Promise<Map<string, MatrixTransactionReservation>> {
    const wanted = new Set(events.map(event => event.eventId));
    const found = new Map<string, MatrixTransactionReservation>();
    for (const [ key, value ] of this.transactions) {
      if (JSON.parse(key)[0] === scope && wanted.has(value.eventId)) found.set(value.eventId, { ...value });
    }
    return found;
  }

  public async getHighWatermark(scope: string): Promise<number> {
    return this.highWatermarks.get(scope) ?? 0;
  }

  public async registerReference(
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): Promise<MatrixEventReference> {
    return this.insertReference(scope, reference);
  }

  /** Synchronous idempotent reference insert; shared by `registerReference` and page publication. */
  private insertReference(
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): MatrixEventReference {
    const identity = JSON.stringify([ scope, reference.roomId, reference.eventId ]);
    const existing = this.references.get(identity);
    if (existing) {
      return { ...existing };
    }
    // Synchronous critical section: assign the sequence, record the exact reference and only then
    // publish the watermark, so a reader can never observe a watermark without the matching ref.
    const published = this.publishedWatermark(scope);
    const legacy = this.events.get(identity);
    // A legacy event-only registration can be discovered after its sequence is already behind an
    // acknowledged published watermark; it must be delivered above that watermark, not behind it.
    const sequence = legacy !== undefined && legacy > published
      ? legacy
      : Math.max(published, this.sequence) + 1;
    this.sequence = sequence;
    this.events.set(identity, sequence);
    const entry: MatrixEventReference = {
      scope,
      roomId: reference.roomId,
      eventId: reference.eventId,
      ...(reference.messageIri === undefined ? {} : { messageIri: reference.messageIri }),
      createdAt: reference.createdAt,
      sequence,
    };
    this.references.set(identity, entry);
    this.referenceOrder.push(entry);
    this.highWatermarks.set(scope, Math.max(this.highWatermarks.get(scope) ?? 0, sequence));
    return { ...entry };
  }

  private publishedWatermark(scope: string): number {
    let highest = 0;
    for (const reference of this.referenceOrder) {
      if (reference.scope === scope && reference.sequence > highest) {
        highest = reference.sequence;
      }
    }
    return highest;
  }

  public async getPublishedReferenceWatermark(scope: string): Promise<number> {
    return this.publishedWatermark(scope);
  }

  public async listReferences(scope: string, options: ListEventReferencesOptions): Promise<MatrixEventReference[]> {
    const after = Number.isFinite(options.afterSequence ?? 0) ? options.afterSequence ?? 0 : 0;
    const through = Number.isFinite(options.throughSequence ?? Number.MAX_SAFE_INTEGER)
      ? options.throughSequence ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    const limit = clampLimit(options.limit);
    return this.referenceOrder
      .filter(reference => reference.scope === scope
        && reference.sequence > after
        && reference.sequence <= through
        && (options.roomId === undefined || reference.roomId === options.roomId))
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(reference => ({ ...reference }));
  }

  public async getEpoch(scope: string): Promise<string> {
    let epoch = this.epochs.get(scope);
    if (!epoch) {
      epoch = randomUUID();
      this.epochs.set(scope, epoch);
    }
    return epoch;
  }

  public async bumpEpoch(scope: string): Promise<string> {
    const epoch = randomUUID();
    this.epochs.set(scope, epoch);
    return epoch;
  }

  public async beginReconcileScan(scope: string, scan: BeginMatrixReconcileScan): Promise<MatrixReconcileCheckpoint> {
    validateReconcileSourceUri(scan.sourceUri);
    const epoch = this.liveEpoch(scope);
    if (scan.epoch !== undefined && scan.epoch !== epoch) {
      throw new Error('Stale reconcile epoch; resync from the beginning');
    }
    const key = checkpointKey(scope, scan.sourceUri);
    const existing = this.checkpoints.get(key);
    const checkpoint = newReconcileCheckpoint(scope, scan, epoch, existing);
    this.checkpoints.set(key, checkpoint);
    this.checkpointEpochs.set(key, epoch);
    return { ...checkpoint };
  }

  public async getReconcileCheckpoint(scope: string, sourceUri: string): Promise<MatrixReconcileCheckpoint | undefined> {
    const key = checkpointKey(scope, sourceUri);
    if (this.checkpointEpochs.get(key) !== this.liveEpoch(scope)) {
      return undefined;
    }
    const checkpoint = this.checkpoints.get(key);
    return checkpoint ? { ...checkpoint } : undefined;
  }

  public async publishReferencePage(scope: string, page: MatrixReferencePage): Promise<MatrixReferencePageResult> {
    validateReferencePage(page);
    const key = checkpointKey(scope, page.sourceUri);
    // Synchronous critical section: no `await` between reading the checkpoint and committing the
    // page, so concurrent calls serialize and exactly one wins the CAS.
    const current = this.checkpoints.get(key);
    if (!current) {
      throw new Error('No reconcile checkpoint for this source; begin a scan first');
    }
    // A checkpoint written under a different (wiped) epoch is stale: the page advances nothing.
    if (this.checkpointEpochs.get(key) !== this.liveEpoch(scope)
      || current.epoch !== page.epoch || this.liveEpoch(scope) !== page.epoch
      || current.scanGeneration !== page.scanGeneration || current.revision !== page.revision) {
      return { advanced: false, checkpoint: { ...current }, references: [] };
    }
    const bound = bindCycleView(current, page);
    if (bound === undefined) {
      return { advanced: false, checkpoint: { ...current }, references: [] };
    }
    const references: MatrixEventReference[] = [];
    for (const reference of page.references) {
      references.push(this.insertReference(scope, reference));
    }
    const next = advanceReconcileCheckpoint(bound, page);
    this.checkpoints.set(key, next);
    return { advanced: true, checkpoint: { ...next }, references };
  }

  /** The live epoch for a scope, creating a fresh identity synchronously if none exists. */
  private liveEpoch(scope: string): string {
    let epoch = this.epochs.get(scope);
    if (!epoch) {
      epoch = randomUUID();
      this.epochs.set(scope, epoch);
    }
    return epoch;
  }
}

export class SqlMatrixEventJournal implements MatrixEventJournal {
  private initialization?: Promise<void>;

  public constructor(private readonly db: IdentityDatabase) {}

  public async reserveTransaction(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<MatrixTransactionReservation> {
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      INSERT INTO xpod_matrix_transactions (scope, transaction_key, event_id, created_at, content_hash)
      VALUES (${scope}, ${key}, ${candidate.eventId}, ${candidate.createdAt}, ${candidate.contentHash})
      ON CONFLICT (scope, transaction_key) DO NOTHING
    `);
    const result = await executeQuery<{ event_id: string; created_at: number | string; content_hash: string }>(this.db, sql`
      SELECT event_id, created_at, content_hash FROM xpod_matrix_transactions
      WHERE scope = ${scope} AND transaction_key = ${key}
    `);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Matrix transaction reservation disappeared');
    }
    return { eventId: row.event_id, createdAt: Number(row.created_at), contentHash: row.content_hash };
  }

  public async replaceReservation(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<void> {
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      UPDATE xpod_matrix_transactions
      SET event_id = ${candidate.eventId}, created_at = ${candidate.createdAt}, content_hash = ${candidate.contentHash}
      WHERE scope = ${scope} AND transaction_key = ${key}
    `);
  }

  public async findReservation(scope: string, event: MatrixReservationLookup): Promise<MatrixTransactionReservation | undefined> {
    await this.ensureInitialized();
    const result = await executeQuery<{event_id:string;created_at:number|string;content_hash:string}>(this.db,sql`
      SELECT event_id,created_at,content_hash FROM xpod_matrix_transactions WHERE scope=${scope} AND event_id=${event.eventId}
    `);
    const row=result.rows[0];
    return row ? {eventId:row.event_id,createdAt:Number(row.created_at),contentHash:row.content_hash} : undefined;
  }

  public async registerEvent(scope: string, roomId: string, eventId: string): Promise<number> {
    await this.ensureInitialized();
    // Registered references are immutable. A committed hit needs no write lock;
    // concurrent misses still converge through the unique constraint below.
    const existing = await this.findEventSequence(this.db, scope, roomId, eventId);
    if (existing !== undefined) {
      return existing;
    }
    if (isDatabaseSqlite(this.db)) {
      return this.insertEvent(this.db, scope, roomId, eventId);
    }
    // BIGSERIAL allocation alone is insufficient: a later sequence could commit first,
    // allowing readers to advance past an uncommitted event. Serialize writers until commit.
    return this.db.transaction(async (transaction: IdentityDatabase): Promise<number> => {
      await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
      return this.insertEvent(transaction, scope, roomId, eventId);
    });
  }

  public async registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]> {
    await this.ensureInitialized();
    if (eventIds.length === 0) return [];
    const unique = [...new Set(eventIds)];
    const known = await this.sequencesFor(this.db, scope, roomId, unique);
    const missing = unique.filter(eventId => !known.has(eventId));
    if (missing.length > 0) {
      if (isDatabaseSqlite(this.db)) {
        await this.insertEvents(this.db, scope, roomId, missing);
      } else {
        // One lock for the whole page instead of one per event; commit order is
        // still serialized so the high watermark cannot pass an uncommitted page.
        await this.db.transaction(async (transaction: IdentityDatabase): Promise<void> => {
          await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
          await this.insertEvents(transaction, scope, roomId, missing);
        });
      }
      for (const [ eventId, sequence ] of await this.sequencesFor(this.db, scope, roomId, missing)) {
        known.set(eventId, sequence);
      }
    }
    return eventIds.map(eventId => {
      const sequence = known.get(eventId);
      if (sequence === undefined) throw new Error('Matrix event registration disappeared');
      return sequence;
    });
  }

  public async findReservations(scope: string, events: readonly MatrixReservationLookup[]): Promise<Map<string, MatrixTransactionReservation>> {
    await this.ensureInitialized();
    const found = new Map<string, MatrixTransactionReservation>();
    const eventIds = events.map(event => event.eventId);
    if (eventIds.length === 0) return found;
    const result = await executeQuery<{ event_id: string; created_at: number | string; content_hash: string }>(this.db, sql`
      SELECT event_id, created_at, content_hash FROM xpod_matrix_transactions
      WHERE scope = ${scope} AND event_id IN (${sql.join([...new Set(eventIds)].map(id => sql`${id}`), sql`, `)})
    `);
    for (const row of result.rows) {
      found.set(row.event_id, { eventId: row.event_id, createdAt: Number(row.created_at), contentHash: row.content_hash });
    }
    return found;
  }

  private async sequencesFor(db: IdentityDatabase, scope: string, roomId: string, eventIds: readonly string[]): Promise<Map<string, number>> {
    const sequences = new Map<string, number>();
    if (eventIds.length === 0) return sequences;
    const result = await executeQuery<{ event_id: string; sequence: number | string }>(db, sql`
      SELECT event_id, sequence FROM xpod_matrix_events
      WHERE scope = ${scope} AND room_id = ${roomId}
        AND event_id IN (${sql.join([...eventIds].map(id => sql`${id}`), sql`, `)})
    `);
    for (const row of result.rows) sequences.set(row.event_id, this.toSequence(row.sequence));
    return sequences;
  }

  private async insertEvents(db: IdentityDatabase, scope: string, roomId: string, eventIds: readonly string[]): Promise<void> {
    // Values are bound as parameters, so embedded quotes cannot break out.
    const rows = eventIds.map(eventId => sql`(${scope}, ${roomId}, ${eventId})`);
    await executeStatement(db, sql`
      INSERT INTO xpod_matrix_events (scope, room_id, event_id)
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
  }

  public async getHighWatermark(scope: string): Promise<number> {
    await this.ensureInitialized();
    const result = await executeQuery<{ sequence: number | string }>(this.db, sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_events WHERE scope = ${scope}
    `);
    return this.toSequence(result.rows[0]?.sequence ?? 0);
  }

  private async insertEvent(db: IdentityDatabase, scope: string, roomId: string, eventId: string): Promise<number> {
    await executeStatement(db, sql`
      INSERT INTO xpod_matrix_events (scope, room_id, event_id) VALUES (${scope}, ${roomId}, ${eventId})
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
    const sequence = await this.findEventSequence(db, scope, roomId, eventId);
    if (sequence === undefined) {
      throw new Error('Matrix event registration disappeared');
    }
    return sequence;
  }

  private async findEventSequence(db: IdentityDatabase, scope: string, roomId: string, eventId: string): Promise<number | undefined> {
    const result = await executeQuery<{ sequence: number | string }>(db, sql`
      SELECT sequence FROM xpod_matrix_events WHERE scope = ${scope} AND room_id = ${roomId} AND event_id = ${eventId}
    `);
    return result.rows[0] ? this.toSequence(result.rows[0].sequence) : undefined;
  }

  private toSequence(value: number | string): number {
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Matrix event sequence exceeds the supported cursor range');
    }
    return sequence;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    if (isDatabaseSqlite(this.db)) {
      await this.createTables(this.db);
      return;
    }
    // Honor the shared identity database's readiness before opening a transaction.
    await executeQuery(this.db, sql`SELECT 1`);
    await this.db.transaction(async (transaction: IdentityDatabase): Promise<void> => {
      // IF NOT EXISTS alone races on PostgreSQL catalog types during cold starts.
      await executeQuery(transaction, sql`SELECT pg_advisory_xact_lock(hashtext('xpod_matrix_journal_schema'))`);
      await this.createTables(transaction);
    });
  }

  private async createTables(db: IdentityDatabase): Promise<void> {
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_transactions (
        scope TEXT NOT NULL,
        transaction_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (scope, transaction_key)
      )
    `);
    await executeStatement(db, sql`CREATE INDEX IF NOT EXISTS xpod_matrix_transaction_event ON xpod_matrix_transactions (scope, event_id)`);
    const sequenceType = isDatabaseSqlite(db)
      ? sql.raw('INTEGER PRIMARY KEY AUTOINCREMENT')
      : sql.raw('BIGSERIAL PRIMARY KEY');
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_events (
        sequence ${sequenceType},
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        UNIQUE (scope, room_id, event_id)
      )
    `);
    // Exact operational cursor references. Bodies stay in the Pod; these are rebuildable discovery
    // order (registration order, not a native-commit watermark).
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_event_refs (
        sequence BIGINT NOT NULL,
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        message_iri TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (scope, room_id, event_id),
        UNIQUE (scope, sequence)
      )
    `);
    await executeStatement(db, sql`CREATE INDEX IF NOT EXISTS xpod_matrix_event_refs_page ON xpod_matrix_event_refs (scope, sequence)`);
    await executeStatement(db, sql`CREATE INDEX IF NOT EXISTS xpod_matrix_event_refs_created ON xpod_matrix_event_refs (scope, room_id, created_at, event_id)`);
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_journal_epoch (
        scope TEXT PRIMARY KEY,
        epoch TEXT NOT NULL
      )
    `);
    // Durable reconciliation checkpoints. Operational and rebuildable: they bound where a bounded
    // source scan is, never payload, authority or membership truth.
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_reconcile_checkpoint (
        scope TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        epoch TEXT NOT NULL,
        scan_generation BIGINT NOT NULL,
        revision BIGINT NOT NULL,
        view TEXT,
        room_cursor TEXT,
        bucket_cursor TEXT,
        last_created_at BIGINT,
        last_source_iri TEXT,
        started_at BIGINT NOT NULL,
        last_completed_at BIGINT,
        PRIMARY KEY (scope, source_uri)
      )
    `);
  }

  public async registerReference(
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): Promise<MatrixEventReference> {
    await this.ensureInitialized();
    const existing = await this.findReference(this.db, scope, reference.roomId, reference.eventId);
    if (existing) {
      return existing;
    }
    // The discovery sequence and the exact reference must be published together: a reader that sees
    // the sequence must also see the reference, or it would advance past an unpublished ref forever.
    if (isDatabaseSqlite(this.db)) {
      // Drizzle SQLite transaction callbacks are synchronous; awaited statements inside them do not
      // form a transaction. Use synchronous transaction statements on this connection instead.
      this.insertReferenceSqlite(scope, reference);
    } else {
      await this.db.transaction(async(transaction: IdentityDatabase): Promise<void> => {
        await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
        const eventSequence = await this.insertEvent(transaction, scope, reference.roomId, reference.eventId);
        const publishedResult = await executeQuery<{ sequence: number | string }>(transaction, sql`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_event_refs WHERE scope = ${scope}
        `);
        const published = this.toSequence(publishedResult.rows[0]?.sequence ?? 0);
        // A legacy event-only sequence behind the acknowledged watermark is delivered above it.
        const sequence = Math.max(eventSequence, published + 1);
        await executeStatement(transaction, sql`
          INSERT INTO xpod_matrix_event_refs (sequence, scope, room_id, event_id, message_iri, created_at)
          VALUES (${sequence}, ${scope}, ${reference.roomId}, ${reference.eventId},
            ${reference.messageIri ?? null}, ${reference.createdAt})
          ON CONFLICT (scope, room_id, event_id) DO NOTHING
        `);
      });
    }
    // Return the actually stored first reference, never the (possibly different) retry proposal.
    const stored = await this.findReference(this.db, scope, reference.roomId, reference.eventId);
    if (!stored) {
      throw new Error('Matrix event reference registration disappeared');
    }
    return stored;
  }

  /**
   * SQLite atomic reference publication.
   *
   * SQLite drizzle's `run`/`all` are synchronous, so a `BEGIN IMMEDIATE … COMMIT` block with no
   * awaits is a real transaction on this connection and cannot interleave with other work. If the
   * exact-reference insert aborts (for example a trigger), the legacy event row rolls back with it
   * and no visible sequence is left behind.
   */
  private insertReferenceSqlite(
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): void {
    const db = this.sqliteHandle();
    db.run(sql.raw('BEGIN IMMEDIATE'));
    try {
      this.writeReferenceSqlite(db, scope, reference);
      db.run(sql.raw('COMMIT'));
    } catch (error) {
      try {
        db.run(sql.raw('ROLLBACK'));
      } catch {
        // The connection may already have rolled back; the original error is what matters.
      }
      throw error;
    }
  }

  /**
   * The connection's synchronous SQLite handle. `run`/`all` execute immediately, so a
   * `BEGIN IMMEDIATE … COMMIT` block with no awaits is a real transaction on this connection and
   * cannot interleave with other work.
   */
  private sqliteHandle(): {
    run: (query: unknown) => unknown;
    all: (query: unknown) => Array<Record<string, unknown>>;
  } {
    return this.db as unknown as {
      run: (query: unknown) => unknown;
      all: (query: unknown) => Array<Record<string, unknown>>;
    };
  }

  /**
   * Insert one immutable exact reference at the next published sequence, assuming the caller already
   * holds a transaction. Idempotent per `(scope, roomId, eventId)`; a legacy event-only sequence
   * behind the acknowledged watermark is delivered above it.
   */
  private writeReferenceSqlite(
    db: { run: (query: unknown) => unknown; all: (query: unknown) => Array<Record<string, unknown>> },
    scope: string,
    reference: Omit<MatrixEventReference, 'scope' | 'sequence'>,
  ): void {
    db.run(sql`
      INSERT INTO xpod_matrix_events (scope, room_id, event_id)
      VALUES (${scope}, ${reference.roomId}, ${reference.eventId})
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
    const eventRows = db.all(sql`
      SELECT sequence FROM xpod_matrix_events
      WHERE scope = ${scope} AND room_id = ${reference.roomId} AND event_id = ${reference.eventId}
    `);
    const eventSequence = this.toSequence((eventRows[0]?.sequence ?? 0) as number | string);
    const publishedRows = db.all(sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_event_refs WHERE scope = ${scope}
    `);
    const published = this.toSequence((publishedRows[0]?.sequence ?? 0) as number | string);
    const sequence = Math.max(eventSequence, published + 1);
    db.run(sql`
      INSERT INTO xpod_matrix_event_refs (sequence, scope, room_id, event_id, message_iri, created_at)
      VALUES (${sequence}, ${scope}, ${reference.roomId}, ${reference.eventId},
        ${reference.messageIri ?? null}, ${reference.createdAt})
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
  }

  /** Read a stored reference synchronously, inside an already-open SQLite transaction. */
  private readReferenceSqlite(
    db: { all: (query: unknown) => Array<Record<string, unknown>> },
    scope: string,
    roomId: string,
    eventId: string,
  ): MatrixEventReference | undefined {
    const rows = db.all(sql`
      SELECT sequence, message_iri, created_at FROM xpod_matrix_event_refs
      WHERE scope = ${scope} AND room_id = ${roomId} AND event_id = ${eventId}
    `);
    const row = rows[0];
    if (!row) return undefined;
    return {
      scope,
      roomId,
      eventId,
      ...(typeof row.message_iri === 'string' ? { messageIri: row.message_iri } : {}),
      createdAt: Number(row.created_at),
      sequence: this.toSequence(row.sequence as number | string),
    };
  }

  /**
   * Read one checkpoint synchronously, inside an already-open SQLite transaction. The optional
   * `joinEpoch` adds an inner join on the current epoch row so a checkpoint written under a now-wiped
   * epoch reads as absent rather than as a stale-but-present row.
   */
  private readCheckpointSqlite(
    db: { all: (query: unknown) => Array<Record<string, unknown>> },
    scope: string,
    sourceUri: string,
    joinEpoch = false,
  ): MatrixReconcileCheckpoint | undefined {
    const rows = joinEpoch
      ? db.all(sql`
          SELECT c.scope, c.source_uri, c.epoch, c.scan_generation, c.revision, c.view, c.room_cursor,
            c.bucket_cursor, c.last_created_at, c.last_source_iri, c.started_at, c.last_completed_at
          FROM xpod_matrix_reconcile_checkpoint c
          JOIN xpod_matrix_journal_epoch e ON e.scope = c.scope AND e.epoch = c.epoch
          WHERE c.scope = ${scope} AND c.source_uri = ${sourceUri}
        `)
      : db.all(sql`
          SELECT scope, source_uri, epoch, scan_generation, revision, view, room_cursor, bucket_cursor,
            last_created_at, last_source_iri, started_at, last_completed_at
          FROM xpod_matrix_reconcile_checkpoint WHERE scope = ${scope} AND source_uri = ${sourceUri}
        `);
    return rows[0] ? mapReconcileCheckpoint(rows[0]) : undefined;
  }

  /** Read the current epoch synchronously, inside an already-open SQLite transaction. */
  private readEpochSqlite(
    db: { all: (query: unknown) => Array<Record<string, unknown>>; run: (query: unknown) => unknown },
    scope: string,
  ): string {
    const rows = db.all(sql`SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope}`);
    if (typeof rows[0]?.epoch === 'string') {
      return rows[0].epoch;
    }
    const epoch = randomUUID();
    db.run(sql`
      INSERT INTO xpod_matrix_journal_epoch (scope, epoch) VALUES (${scope}, ${epoch})
      ON CONFLICT (scope) DO NOTHING
    `);
    const stored = db.all(sql`SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope}`);
    return typeof stored[0]?.epoch === 'string' ? stored[0].epoch : epoch;
  }

  /** Upsert one checkpoint synchronously, inside an already-open SQLite transaction. */
  private writeCheckpointSqlite(
    db: { run: (query: unknown) => unknown },
    checkpoint: MatrixReconcileCheckpoint,
  ): void {
    db.run(sql`
      INSERT INTO xpod_matrix_reconcile_checkpoint
        (scope, source_uri, epoch, scan_generation, revision, view, room_cursor, bucket_cursor,
          last_created_at, last_source_iri, started_at, last_completed_at)
      VALUES (${checkpoint.scope}, ${checkpoint.sourceUri}, ${checkpoint.epoch}, ${checkpoint.scanGeneration},
        ${checkpoint.revision}, ${checkpoint.view ?? null}, ${checkpoint.roomCursor ?? null},
        ${checkpoint.bucketCursor ?? null}, ${checkpoint.lastCreatedAt ?? null}, ${checkpoint.lastSourceIri ?? null},
        ${checkpoint.startedAt}, ${checkpoint.lastCompletedAt ?? null})
      ON CONFLICT (scope, source_uri) DO UPDATE SET
        epoch = excluded.epoch, scan_generation = excluded.scan_generation, revision = excluded.revision,
        view = excluded.view, room_cursor = excluded.room_cursor, bucket_cursor = excluded.bucket_cursor,
        last_created_at = excluded.last_created_at, last_source_iri = excluded.last_source_iri, started_at = excluded.started_at,
        last_completed_at = excluded.last_completed_at
    `);
  }

  public async beginReconcileScan(scope: string, scan: BeginMatrixReconcileScan): Promise<MatrixReconcileCheckpoint> {
    await this.ensureInitialized();
    validateReconcileSourceUri(scan.sourceUri);
    if (isDatabaseSqlite(this.db)) {
      const db = this.sqliteHandle();
      db.run(sql.raw('BEGIN IMMEDIATE'));
      try {
        // The live epoch is read under the same write lock, so a concurrent bump cannot slip between
        // the check and the write.
        const epoch = this.readEpochSqlite(db, scope);
        if (scan.epoch !== undefined && scan.epoch !== epoch) {
          throw new Error('Stale reconcile epoch; resync from the beginning');
        }
        const existing = this.readCheckpointSqlite(db, scope, scan.sourceUri);
        const checkpoint = newReconcileCheckpoint(scope, scan, epoch, existing);
        this.writeCheckpointSqlite(db, checkpoint);
        db.run(sql.raw('COMMIT'));
        return checkpoint;
      } catch (error) {
        try {
          db.run(sql.raw('ROLLBACK'));
        } catch {
          // The connection may already have rolled back; the original error is what matters.
        }
        throw error;
      }
    }
    return this.db.transaction(async (transaction: IdentityDatabase): Promise<MatrixReconcileCheckpoint> => {
      const epoch = await this.readEpochForUpdate(transaction, scope);
      if (scan.epoch !== undefined && scan.epoch !== epoch) {
        throw new Error('Stale reconcile epoch; resync from the beginning');
      }
      const current = await this.readCheckpointForUpdate(transaction, scope, scan.sourceUri);
      const checkpoint = newReconcileCheckpoint(scope, scan, epoch, current);
      await this.writeCheckpoint(transaction, checkpoint);
      return checkpoint;
    });
  }

  public async getReconcileCheckpoint(scope: string, sourceUri: string): Promise<MatrixReconcileCheckpoint | undefined> {
    await this.ensureInitialized();
    if (isDatabaseSqlite(this.db)) {
      // Join the live epoch so a checkpoint written under a wiped epoch reads as absent, matching
      // the memory carrier and the stale-epoch rejection in publishReferencePage.
      return this.readCheckpointSqlite(this.sqliteHandle(), scope, sourceUri, true);
    }
    const result = await executeQuery<Record<string, unknown>>(this.db, sql`
      SELECT scope, source_uri, epoch, scan_generation, revision, view, room_cursor, bucket_cursor,
        last_created_at, last_source_iri, started_at, last_completed_at
      FROM xpod_matrix_reconcile_checkpoint WHERE scope = ${scope} AND source_uri = ${sourceUri}
    `);
    return result.rows[0] ? mapReconcileCheckpoint(result.rows[0]) : undefined;
  }

  public async publishReferencePage(scope: string, page: MatrixReferencePage): Promise<MatrixReferencePageResult> {
    await this.ensureInitialized();
    validateReferencePage(page);
    if (isDatabaseSqlite(this.db)) {
      return this.publishReferencePageSqlite(scope, page);
    }
    return this.db.transaction(async (transaction: IdentityDatabase): Promise<MatrixReferencePageResult> => {
      // The current epoch is read under the same transaction, so a concurrent bump/wipe cannot
      // invalidate a check made before the lock.
      const liveEpoch = await this.readEpochForUpdate(transaction, scope);
      const current = await this.readCheckpointForUpdate(transaction, scope, page.sourceUri);
      if (!current) {
        throw new Error('No reconcile checkpoint for this source; begin a scan first');
      }
      if (current.epoch !== page.epoch || liveEpoch !== page.epoch
        || current.scanGeneration !== page.scanGeneration || current.revision !== page.revision) {
        return { advanced: false, checkpoint: current, references: [] };
      }
      const bound = bindCycleView(current, page);
      if (bound === undefined) {
        return { advanced: false, checkpoint: current, references: [] };
      }
      await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
      const references: MatrixEventReference[] = [];
      for (const reference of page.references) {
        const eventSequence = await this.insertEvent(transaction, scope, reference.roomId, reference.eventId);
        const publishedResult = await executeQuery<{ sequence: number | string }>(transaction, sql`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_event_refs WHERE scope = ${scope}
        `);
        const published = this.toSequence(publishedResult.rows[0]?.sequence ?? 0);
        const sequence = Math.max(eventSequence, published + 1);
        await executeStatement(transaction, sql`
          INSERT INTO xpod_matrix_event_refs (sequence, scope, room_id, event_id, message_iri, created_at)
          VALUES (${sequence}, ${scope}, ${reference.roomId}, ${reference.eventId},
            ${reference.messageIri ?? null}, ${reference.createdAt})
          ON CONFLICT (scope, room_id, event_id) DO NOTHING
        `);
        const stored = await this.findReference(transaction, scope, reference.roomId, reference.eventId);
        if (!stored) throw new Error('Matrix event reference registration disappeared');
        references.push(stored);
      }
      const next = advanceReconcileCheckpoint(bound, page);
      await this.writeCheckpoint(transaction, next);
      return { advanced: true, checkpoint: next, references };
    });
  }

  /**
   * SQLite page publication: the current-epoch read, the reference inserts and the checkpoint CAS
   * share one `BEGIN IMMEDIATE … COMMIT`, so a trigger abort rolls back every reference in the page
   * and the checkpoint never moves, a concurrent epoch bump is observed after the lock (stale epoch
   * advances nothing), and two connected consumers serialize on the write lock (one CAS wins).
   */
  private publishReferencePageSqlite(
    scope: string,
    page: MatrixReferencePage,
  ): MatrixReferencePageResult {
    const db = this.sqliteHandle();
    db.run(sql.raw('BEGIN IMMEDIATE'));
    try {
      const liveEpoch = this.readEpochSqlite(db, scope);
      // A checkpoint whose stored epoch no longer matches the current epoch is stale: it is read as
      // absent (not thrown), so a wiped epoch can never be advanced by a page built against it.
      const current = this.readCheckpointSqlite(db, scope, page.sourceUri, true);
      if (!current) {
        const stored = this.readCheckpointSqlite(db, scope, page.sourceUri);
        if (!stored) {
          throw new Error('No reconcile checkpoint for this source; begin a scan first');
        }
        db.run(sql.raw('ROLLBACK'));
        return { advanced: false, checkpoint: stored, references: [] };
      }
      if (current.epoch !== page.epoch || liveEpoch !== page.epoch
        || current.scanGeneration !== page.scanGeneration || current.revision !== page.revision) {
        db.run(sql.raw('ROLLBACK'));
        return { advanced: false, checkpoint: current, references: [] };
      }
      const bound = bindCycleView(current, page);
      if (bound === undefined) {
        db.run(sql.raw('ROLLBACK'));
        return { advanced: false, checkpoint: current, references: [] };
      }
      const references: MatrixEventReference[] = [];
      for (const reference of page.references) {
        this.writeReferenceSqlite(db, scope, reference);
        const stored = this.readReferenceSqlite(db, scope, reference.roomId, reference.eventId);
        if (!stored) throw new Error('Matrix event reference registration disappeared');
        references.push(stored);
      }
      const next = advanceReconcileCheckpoint(bound, page);
      this.writeCheckpointSqlite(db, next);
      db.run(sql.raw('COMMIT'));
      return { advanced: true, checkpoint: next, references };
    } catch (error) {
      try {
        db.run(sql.raw('ROLLBACK'));
      } catch {
        // The connection may already have rolled back; the original error is what matters.
      }
      throw error;
    }
  }

  private async readCheckpointForUpdate(
    transaction: IdentityDatabase,
    scope: string,
    sourceUri: string,
  ): Promise<MatrixReconcileCheckpoint | undefined> {
    const result = await executeQuery<Record<string, unknown>>(transaction, sql`
      SELECT scope, source_uri, epoch, scan_generation, revision, view, room_cursor, bucket_cursor,
        last_created_at, last_source_iri, started_at, last_completed_at
      FROM xpod_matrix_reconcile_checkpoint WHERE scope = ${scope} AND source_uri = ${sourceUri}
      FOR UPDATE
    `);
    return result.rows[0] ? mapReconcileCheckpoint(result.rows[0]) : undefined;
  }

  /**
   * Read (creating if absent) the current epoch inside the surrounding transaction, taking the epoch
   * row lock. Lock order is always epoch → checkpoint → events, matching `beginReconcileScan`,
   * `publishReferencePage` and `bumpEpoch`, so no deadlock cycle is introduced.
   */
  private async readEpochForUpdate(transaction: IdentityDatabase, scope: string): Promise<string> {
    const selected = await executeQuery<{ epoch: string }>(transaction, sql`
      SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope} FOR UPDATE
    `);
    if (typeof selected.rows[0]?.epoch === 'string') {
      return selected.rows[0].epoch;
    }
    const epoch = randomUUID();
    await executeStatement(transaction, sql`
      INSERT INTO xpod_matrix_journal_epoch (scope, epoch) VALUES (${scope}, ${epoch})
      ON CONFLICT (scope) DO NOTHING
    `);
    const stored = await executeQuery<{ epoch: string }>(transaction, sql`
      SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope} FOR UPDATE
    `);
    return stored.rows[0]?.epoch ?? epoch;
  }

  private async writeCheckpoint(db: IdentityDatabase, checkpoint: MatrixReconcileCheckpoint): Promise<void> {
    await executeStatement(db, sql`
      INSERT INTO xpod_matrix_reconcile_checkpoint
        (scope, source_uri, epoch, scan_generation, revision, view, room_cursor, bucket_cursor,
          last_created_at, last_source_iri, started_at, last_completed_at)
      VALUES (${checkpoint.scope}, ${checkpoint.sourceUri}, ${checkpoint.epoch}, ${checkpoint.scanGeneration},
        ${checkpoint.revision}, ${checkpoint.view ?? null}, ${checkpoint.roomCursor ?? null},
        ${checkpoint.bucketCursor ?? null}, ${checkpoint.lastCreatedAt ?? null}, ${checkpoint.lastSourceIri ?? null},
        ${checkpoint.startedAt}, ${checkpoint.lastCompletedAt ?? null})
      ON CONFLICT (scope, source_uri) DO UPDATE SET
        epoch = excluded.epoch, scan_generation = excluded.scan_generation, revision = excluded.revision,
        view = excluded.view, room_cursor = excluded.room_cursor, bucket_cursor = excluded.bucket_cursor,
        last_created_at = excluded.last_created_at, last_source_iri = excluded.last_source_iri, started_at = excluded.started_at,
        last_completed_at = excluded.last_completed_at
    `);
  }

  public async getPublishedReferenceWatermark(scope: string): Promise<number> {
    await this.ensureInitialized();
    const result = await executeQuery<{ sequence: number | string }>(this.db, sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_event_refs WHERE scope = ${scope}
    `);
    return this.toSequence(result.rows[0]?.sequence ?? 0);
  }

  private async findReference(
    db: IdentityDatabase,
    scope: string,
    roomId: string,
    eventId: string,
  ): Promise<MatrixEventReference | undefined> {
    const result = await executeQuery<{ sequence: number | string; message_iri: string | null; created_at: number | string }>(
      db,
      sql`
        SELECT sequence, message_iri, created_at FROM xpod_matrix_event_refs
        WHERE scope = ${scope} AND room_id = ${roomId} AND event_id = ${eventId}
      `,
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      scope,
      roomId,
      eventId,
      ...(typeof row.message_iri === 'string' ? { messageIri: row.message_iri } : {}),
      createdAt: Number(row.created_at),
      sequence: this.toSequence(row.sequence),
    };
  }

  public async listReferences(scope: string, options: ListEventReferencesOptions): Promise<MatrixEventReference[]> {
    await this.ensureInitialized();
    const after = Number.isFinite(options.afterSequence ?? 0) ? options.afterSequence ?? 0 : 0;
    const through = Number.isFinite(options.throughSequence ?? Number.MAX_SAFE_INTEGER)
      ? options.throughSequence ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    const limit = clampLimit(options.limit);
    const roomFilter = options.roomId === undefined ? sql`` : sql` AND room_id = ${options.roomId}`;
    const result = await executeQuery<{
      sequence: number | string; room_id: string; event_id: string; message_iri: string | null; created_at: number | string;
    }>(this.db, sql`
      SELECT sequence, room_id, event_id, message_iri, created_at FROM xpod_matrix_event_refs
      WHERE scope = ${scope} AND sequence > ${after} AND sequence <= ${through}${roomFilter}
      ORDER BY sequence ASC
      LIMIT ${limit}
    `);
    return result.rows.map(row => ({
      scope,
      roomId: row.room_id,
      eventId: row.event_id,
      ...(typeof row.message_iri === 'string' ? { messageIri: row.message_iri } : {}),
      createdAt: Number(row.created_at),
      sequence: this.toSequence(row.sequence),
    }));
  }

  public async getEpoch(scope: string): Promise<string> {
    await this.ensureInitialized();
    const result = await executeQuery<{ epoch: string }>(this.db, sql`
      SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope}
    `);
    if (result.rows[0]?.epoch) {
      return String(result.rows[0].epoch);
    }
    // A fresh operational index gets a new random identity, never 0.
    const epoch = randomUUID();
    await executeStatement(this.db, sql`
      INSERT INTO xpod_matrix_journal_epoch (scope, epoch) VALUES (${scope}, ${epoch})
      ON CONFLICT (scope) DO NOTHING
    `);
    const stored = await executeQuery<{ epoch: string }>(this.db, sql`
      SELECT epoch FROM xpod_matrix_journal_epoch WHERE scope = ${scope}
    `);
    return stored.rows[0]?.epoch ?? epoch;
  }

  public async bumpEpoch(scope: string): Promise<string> {
    await this.ensureInitialized();
    const epoch = randomUUID();
    await executeStatement(this.db, sql`
      INSERT INTO xpod_matrix_journal_epoch (scope, epoch) VALUES (${scope}, ${epoch})
      ON CONFLICT (scope) DO UPDATE SET epoch = ${epoch}
    `);
    return epoch;
  }
}
