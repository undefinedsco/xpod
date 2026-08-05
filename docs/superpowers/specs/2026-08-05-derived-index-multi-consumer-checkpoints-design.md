# FTS/VEC Multi-Consumer Checkpoint Design

**Date:** 2026-08-05

**Status:** Approved

## Goal

Make PostgreSQL-backed FTS/VEC derivation durable, Pod-ordered, independently
retryable per consumer, replayable after restart, and repairable from the Pod's
authoritative resource list. A future derived-index consumer must be able to
join without changing the resource-write path.

## Current Problem

`PostgresDerivedIndexJournal` stores delivery state directly on each event.
Configured listeners are wrapped into one sequential aggregate listener, so the
journal cannot tell which consumer completed an event. If a later consumer
fails, an earlier consumer runs again. A newly configured consumer also cannot
claim events already marked `done`.

`reconcilePod()` currently appends only `update` events for paths supplied by
the caller. It does not compare those paths with prior successful deliveries,
so it cannot delete stale FTS/VEC rows for authority resources that disappeared
while event delivery was unavailable.

## Selected Approach

Keep one immutable, Pod-scoped event log and move mutable delivery state into a
per-consumer table keyed by `(consumer_id, event_id)`. Store a per-consumer,
per-resource checkpoint after successful delivery. Reconciliation compares the
authority snapshot with active checkpoints and appends both repair updates and
missing-resource deletes.

This approach was selected over two alternatives:

1. **One cursor per consumer.** A single numeric cursor cannot represent a
   failed event followed by later independent work without either blocking the
   whole consumer globally or adding another sparse retry structure.
2. **One event table per consumer.** Duplicating immutable event payloads makes
   schema evolution, ordering, retention, and auditing harder. One event plus
   many deliveries keeps resource-write recording atomic and shared.

## Data Model

The existing `derived_index_change_journal` remains the immutable event log.
Its current delivery columns remain during the compatibility migration but are
no longer authoritative after per-consumer rows are installed.

### `derived_index_consumers`

| Column | Meaning |
| --- | --- |
| `consumer_id TEXT PRIMARY KEY` | Stable, explicit consumer identity |
| `created_at BIGINT NOT NULL` | Registration time |

Registration is idempotent. Registering a consumer inserts missing delivery
rows for all retained events. No event compaction is introduced in this change,
so a future consumer can replay retained history before reconciliation repairs
its current authority state.

### `derived_index_event_deliveries`

| Column | Meaning |
| --- | --- |
| `consumer_id TEXT NOT NULL` | References the registered consumer |
| `event_id BIGINT NOT NULL` | References the immutable event |
| `stage TEXT NOT NULL` | `pending`, `processing`, or `done` |
| `attempts INTEGER NOT NULL` | Failed attempts for this consumer only |
| `available_at BIGINT NOT NULL` | Earliest retry time |
| `lease_until BIGINT` | Expiring claim lease |
| `last_error TEXT` | Last consumer-specific error |
| primary key | `(consumer_id, event_id)` |

Claims are Pod-ordered per consumer: a delivery is eligible only when that same
consumer has no earlier non-`done` delivery in the event's Pod. A failure blocks
only later deliveries for the same `(consumer, Pod)` pair. Other consumers and
other Pods continue.

### `derived_index_resource_checkpoints`

| Column | Meaning |
| --- | --- |
| `consumer_id TEXT NOT NULL` | Consumer whose derived state was updated |
| `pod_scope_id TEXT NOT NULL` | Pod ordering and reconciliation boundary |
| `resource_path TEXT NOT NULL` | Authority resource identity |
| `last_event_id BIGINT NOT NULL` | Last successfully applied event |
| `last_action TEXT NOT NULL` | `create`, `update`, or `delete` |
| `updated_at BIGINT NOT NULL` | Successful delivery time |
| `deleted_at BIGINT` | Tombstone time for an applied delete |
| primary key | `(consumer_id, pod_scope_id, resource_path)` |

Successful `create` or `update` clears `deleted_at`. Successful `delete` keeps a
tombstone so repeated reconciliation does not emit the same delete forever.

## Public Contract

Configured durable consumers implement `ResourceChangeListener` and expose a
stable non-empty `consumerId`. Duplicate IDs are rejected during construction.
`RdfDerivedIndexingListener` exposes `rdf-fts-vec-v1` by default; its constructor
permits an explicit ID for a separately configured future generation.

`replayPending(listener)` remains supported as the compatibility entry point.
It uses the reserved consumer ID `legacy-resource-change-listener-v1`, preserving
existing callers while moving them onto the same delivery/checkpoint mechanism.
The legacy consumer is registered on `open()` only when there are no configured
durable consumers. When configured consumers exist, calling `replayPending()`
registers the legacy consumer lazily and backfills its retained history before
claiming work. This prevents an unused compatibility consumer from leaving every
production event permanently pending.

`pendingCount(podScopeId?, consumerId?)` counts non-complete delivery rows. With
no consumer ID it counts distinct events that remain incomplete for at least
one registered consumer. A journal with no configured consumers registers the
legacy consumer before accepting events, so existing manual replay callers keep
their current pending-count behavior.

## Recording and Registration Flow

1. `open()` creates the three new tables and indexes idempotently.
2. It registers every configured consumer, or the reserved legacy consumer when
   the configured set is empty.
3. Registration inserts missing deliveries for all retained events with
   `ON CONFLICT DO NOTHING`.
4. `recordResourceChange()` inserts one immutable event and one pending delivery
   for every consumer active in the current journal process in the same
   PostgreSQL transaction. Persisted but currently unconfigured consumers do not
   accumulate new pending rows; registration backfills retained history when
   they return.
5. Existing `rdf_sources` bootstrap inserts events through the same transaction
   helper, so every registered consumer receives bootstrap work.

This preserves one durable recorder around the cloud `ResourceStore`; no
in-process notification becomes authoritative.

## Delivery and Checkpoint Flow

For each consumer, replay performs the following loop:

1. Recover only that consumer's expired `processing` leases.
2. Claim the oldest eligible delivery using `FOR UPDATE SKIP LOCKED`.
3. Call the consumer outside the claim transaction.
4. On success, atomically mark the delivery `done` and upsert its resource
   checkpoint.
5. On failure, return only that delivery to `pending`, increment its attempts,
   set its retry time, and preserve the error text.

Delivery remains at-least-once because PostgreSQL cannot atomically commit an
external derived-index side effect with the delivery row. FTS/VEC operations
are source-replacement or source-deletion operations and must remain idempotent.

The automatic poller invokes replay separately for each configured consumer;
it never rebuilds an aggregate listener. A slow or failing consumer therefore
does not erase another consumer's progress.

## Reconciliation and Self-Healing

`reconcilePod(podScopeId, authorityPaths)` treats `authorityPaths` as the full
current resource set for that Pod:

1. Normalize and deduplicate the supplied paths.
2. Append an `update` event for every current authority path. This deliberately
   re-applies derived state even when the checkpoint looks current, repairing
   silent FTS/VEC drift.
3. For every active checkpoint path absent from the authority set, append one
   `delete` event.
4. Do not append another delete when the newest checkpoint is already a
   tombstone.
5. Create delivery rows for every consumer active in the current process as
   part of each append.

The authority snapshot must be supplied by the caller; the journal does not
scan Solid resources itself. Reconciliation is Pod-scoped and does not infer
Pod identity from resource strings.

## Compatibility Migration

Opening an existing database is non-destructive:

- existing events are retained;
- when no configured consumer exists, the legacy consumer is registered and
  each existing event receives a legacy delivery;
- when `replayPending()` is first invoked beside configured consumers, it
  registers the legacy consumer lazily and backfills retained events;
- for legacy migration, an old event whose stage is `done` seeds a `done`
  delivery and checkpoint, while `pending` and expired `processing` events seed
  pending deliveries;
- configured new consumers receive pending deliveries for all retained events.

The old event-level stage fields remain readable during this release but no
new claim logic depends on them. Their physical removal is a separate migration
after deployed readers no longer use the old schema.

## Error Handling and Invariants

- Consumer IDs are stable, non-empty, and unique within one journal instance.
- Event recording and delivery fan-out are one transaction.
- Delivery completion and checkpoint advancement are one transaction.
- A checkpoint never advances for a failed consumer call.
- A later event never overtakes an earlier failed event for the same consumer
  and Pod.
- Lease recovery cannot reset another consumer's claim.
- Reconciliation never deletes a path present in the authority snapshot.
- Closing waits for all in-flight per-consumer replays before pool release.

## Verification

Focused PGlite tests must prove:

- independent consumer success and retry state;
- per-consumer, per-Pod ordering;
- restart recovery of an expired lease;
- future-consumer registration and historical replay;
- compatibility replay through the reserved legacy consumer;
- checkpoint updates only after success;
- reconciliation repair updates and missing-resource deletes;
- repeated reconciliation does not duplicate tombstoned deletes;
- duplicate or empty consumer IDs fail closed;
- automatic polling keeps consumers independent.

A real PostgreSQL 17 test must execute the journal with
`PostgresRdfTextIndex` and `PostgresRdfVectorIndex`, verify persisted search
results, delete an authority resource through reconciliation, and verify both
derived indexes no longer return it.

Release verification requires `bun run build:ts`, the focused journal/index
tests, and `bun run test:integration`. The QLever primary-engine and deployment
gates remain downstream work and cannot use this design document alone as
completion evidence.

## Out of Scope

- Event compaction or retention policy.
- Exactly-once delivery across PostgreSQL and external side effects.
- A new message broker or dependency.
- Scanning Pod authority inside the journal.
- Changing FTS/VEC ranking, chunking, embedding, or credential semantics.
- Removing the old event-level delivery columns in the same release.
