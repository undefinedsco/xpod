# FTS/VEC Multi-Consumer Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FTS/VEC journal delivery independently durable per consumer, checkpoint successful resource state, and repair derived indexes from a complete Pod authority snapshot.

**Architecture:** Keep `derived_index_change_journal` as one immutable event log, add registered-consumer, per-event delivery, and per-resource checkpoint tables, and claim work in `(consumer, Pod)` order. Preserve `replayPending(listener)` through a reserved legacy consumer while configured consumers expose stable IDs and replay independently.

**Tech Stack:** TypeScript, PostgreSQL 17, PGlite, `PostgresRdfSqlExecutor`, Vitest, Components.js JSON-LD configuration, Bun.

---

## File Map

- Modify `src/storage/PostgresDerivedIndexJournal.ts` — durable-consumer contract, schema migration, event fan-out, claims, replay, checkpoints, reconcile, lifecycle.
- Modify `src/storage/RdfDerivedIndexingListener.ts` — stable `consumerId` exposed to the journal.
- Modify `src/index.ts` — export the durable-consumer type.
- Modify `config/cloud.json` — configure the stable FTS/VEC consumer ID explicitly.
- Modify `tests/storage/PostgresDerivedIndexJournal.test.ts` — PGlite and live PG17 acceptance tests.
- Modify `tests/storage/RdfDerivedIndexingListener.test.ts` — consumer identity contract.
- Modify `docs/COMPONENTS.md` — document durable derived-index delivery and reconciliation.
- Generate `dist/components/*.jsonld` through the existing build command; do not hand-edit generated files.

### Task 1: Add the Stable Durable-Consumer Contract

**Files:**
- Modify: `src/storage/PostgresDerivedIndexJournal.ts`
- Modify: `src/storage/RdfDerivedIndexingListener.ts`
- Modify: `src/index.ts`
- Test: `tests/storage/RdfDerivedIndexingListener.test.ts`
- Test: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Write failing consumer identity tests**

Add to `tests/storage/RdfDerivedIndexingListener.test.ts`:

```ts
it('exposes a stable durable consumer identity', () => {
  const listener = createListener({
    rdfEngine: engineMock(),
    resourceStore: { getRepresentation: vi.fn() } as any,
  });
  expect(listener.consumerId).toBe('rdf-fts-vec-v1');
});

it('accepts an explicit durable consumer generation', () => {
  const listener = createListener({
    rdfEngine: engineMock(),
    resourceStore: { getRepresentation: vi.fn() } as any,
    consumerId: 'rdf-fts-vec-v2',
  });
  expect(listener.consumerId).toBe('rdf-fts-vec-v2');
});
```

Extend `createListener()` with `options.consumerId` as its final constructor argument.

Add to `tests/storage/PostgresDerivedIndexJournal.test.ts`:

```ts
it('rejects empty and duplicate configured consumer IDs', () => {
  const db = new PGlite();
  expect(() => createJournal({
    executor: new PgliteRdfSqlExecutor(db),
    consumers: [consumer('', [])],
  })).toThrow('non-empty consumerId');
  expect(() => createJournal({
    executor: new PgliteRdfSqlExecutor(db),
    consumers: [consumer('search-v1', []), consumer('search-v1', [])],
  })).toThrow('Duplicate derived-index consumerId: search-v1');
});
```

Add this concrete helper at the bottom of the same test file:

```ts
function consumer(
  consumerId: string,
  delivered: string[],
  options: { failOnce?: boolean } = {},
): DurableResourceChangeConsumer {
  let shouldFail = options.failOnce ?? false;
  return {
    consumerId,
    onResourceChanged: async (change) => {
      delivered.push(change.path);
      if (shouldFail) {
        shouldFail = false;
        throw new Error(`${consumerId} unavailable`);
      }
    },
  };
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun run test -- tests/storage/RdfDerivedIndexingListener.test.ts tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: FAIL because `consumerId` and the durable consumer type do not exist.

- [ ] **Step 3: Implement the minimal public contract**

In `src/storage/PostgresDerivedIndexJournal.ts` define and use:

```ts
export interface DurableResourceChangeConsumer extends ResourceChangeListener {
  readonly consumerId: string;
}

export const LEGACY_DERIVED_INDEX_CONSUMER_ID = 'legacy-resource-change-listener-v1';
```

Change `PostgresDerivedIndexJournalOptions.consumers` and the positional constructor
parameter to `DurableResourceChangeConsumer[]`. Validate trimmed non-empty IDs and
reject duplicates before acquiring a pool.

In `src/storage/RdfDerivedIndexingListener.ts` add the final constructor parameter
and property:

```ts
public readonly consumerId: string;

// final constructor argument
consumerId = 'rdf-fts-vec-v1',

this.consumerId = consumerId;
```

Export `DurableResourceChangeConsumer` and the legacy constant from `src/index.ts`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
bun run test -- tests/storage/RdfDerivedIndexingListener.test.ts tests/storage/PostgresDerivedIndexJournal.test.ts
bun run build:ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add src/storage/PostgresDerivedIndexJournal.ts src/storage/RdfDerivedIndexingListener.ts src/index.ts tests/storage/RdfDerivedIndexingListener.test.ts tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "🔑 Give derived-index consumers durable identities" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: focused derived-index tests; bun run build:ts"
```

### Task 2: Install and Migrate Per-Consumer Delivery State

**Files:**
- Modify: `src/storage/PostgresDerivedIndexJournal.ts`
- Test: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Write failing schema and migration tests**

Add tests that seed the legacy table before `open()` and assert exact delivery
rows after migration:

```ts
it('migrates legacy done and pending events into the reserved consumer', async () => {
  const db = new PGlite();
  const executor = new PgliteRdfSqlExecutor(db);
  await createLegacyJournalSchema(executor);
  await executor.exec(`
    INSERT INTO derived_index_change_journal
      (pod_scope_id, resource_path, action, is_container, occurred_at, stage)
    VALUES
      ('alice', '/alice/done.md', 'update', FALSE, 1, 'done'),
      ('alice', '/alice/pending.md', 'update', FALSE, 2, 'pending')
  `);
  const journal = createJournal({ executor });
  await journal.open();
  expect(await deliveryStages(executor, LEGACY_DERIVED_INDEX_CONSUMER_ID)).toEqual([
    ['/alice/done.md', 'done'],
    ['/alice/pending.md', 'pending'],
  ]);
});

it('registers a future consumer with pending retained history', async () => {
  const executor = new PgliteRdfSqlExecutor(new PGlite());
  const first = createJournal({ executor, resolvePodScope: () => 'alice' });
  await first.open();
  await first.recordResourceChange(event('/alice/history.md'));
  await first.replayPending({ onResourceChanged: async () => undefined });
  await first.close();

  const delivered: string[] = [];
  const second = createJournal({
    executor,
    consumers: [consumer('search-v2', delivered)],
  });
  await second.open();
  expect(await deliveryStages(executor, 'search-v2')).toEqual([
    ['/alice/history.md', 'pending'],
  ]);
  await second.close();
});
```

Use these concrete test helpers:

```ts
async function createLegacyJournalSchema(executor: PostgresRdfSqlExecutor): Promise<void> {
  await executor.exec(`
    CREATE TABLE derived_index_change_journal (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      pod_scope_id TEXT NOT NULL,
      resource_path TEXT NOT NULL,
      action TEXT NOT NULL,
      is_container BOOLEAN NOT NULL,
      occurred_at BIGINT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at BIGINT NOT NULL DEFAULT 0,
      lease_until BIGINT,
      last_error TEXT
    )
  `);
}

async function deliveryStages(
  executor: PostgresRdfSqlExecutor,
  consumerId: string,
): Promise<Array<[string, string]>> {
  const rows = await executor.query<{ resource_path: string; stage: string }>(`
    SELECT event.resource_path, delivery.stage
    FROM derived_index_event_deliveries delivery
    JOIN derived_index_change_journal event ON event.id = delivery.event_id
    WHERE delivery.consumer_id = $1
    ORDER BY event.id
  `, [consumerId]);
  return rows.map((row) => [row.resource_path, row.stage]);
}
```

The future-consumer test must record and finish one legacy event, close that
journal, reopen with `consumer('search-v2', delivered)`, and assert
`deliveryStages(executor, 'search-v2')` equals `[['/alice/history.md', 'pending']]`.

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: FAIL because the three new tables do not exist.

- [ ] **Step 3: Add idempotent schema creation**

Extend `initialize()` with:

```sql
CREATE TABLE IF NOT EXISTS derived_index_consumers (
  consumer_id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS derived_index_event_deliveries (
  consumer_id TEXT NOT NULL REFERENCES derived_index_consumers(consumer_id),
  event_id BIGINT NOT NULL REFERENCES derived_index_change_journal(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending', 'processing', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL DEFAULT 0,
  lease_until BIGINT,
  last_error TEXT,
  PRIMARY KEY (consumer_id, event_id)
);
CREATE INDEX IF NOT EXISTS derived_index_event_deliveries_pending
  ON derived_index_event_deliveries (consumer_id, stage, available_at, event_id);
CREATE TABLE IF NOT EXISTS derived_index_resource_checkpoints (
  consumer_id TEXT NOT NULL REFERENCES derived_index_consumers(consumer_id),
  pod_scope_id TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  last_event_id BIGINT NOT NULL REFERENCES derived_index_change_journal(id),
  last_action TEXT NOT NULL CHECK (last_action IN ('create', 'update', 'delete')),
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  PRIMARY KEY (consumer_id, pod_scope_id, resource_path)
);
```

- [ ] **Step 4: Implement registration and legacy migration transactionally**

Create a private `registerConsumer(consumerId, legacy = false)` transaction that:

```sql
INSERT INTO derived_index_consumers (consumer_id, created_at)
VALUES ($1, $2)
ON CONFLICT (consumer_id) DO NOTHING;

INSERT INTO derived_index_event_deliveries
  (consumer_id, event_id, stage, attempts, available_at, lease_until, last_error)
SELECT $1, id,
       CASE WHEN $3::boolean AND stage = 'done' THEN 'done' ELSE 'pending' END,
       CASE WHEN $3::boolean THEN attempts ELSE 0 END,
       CASE WHEN $3::boolean THEN available_at ELSE 0 END,
       NULL,
       CASE WHEN $3::boolean THEN last_error ELSE NULL END
FROM derived_index_change_journal
ON CONFLICT (consumer_id, event_id) DO NOTHING;
```

For legacy rows already `done`, seed checkpoints from the event in the same
transaction. After schema creation, register every configured consumer. Register
the legacy ID during `open()` only when the configured set is empty; otherwise
register it lazily on the first `replayPending()` call before claiming work.

- [ ] **Step 5: Run migration tests twice to prove idempotency**

Run twice:

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: both runs PASS with no duplicate delivery rows.

- [ ] **Step 6: Commit the schema migration**

```bash
git add src/storage/PostgresDerivedIndexJournal.ts tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "🗃️ Persist delivery state per derived-index consumer" \
  -m "Constraint: Existing event rows and legacy replay behavior must migrate in place." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: focused PGlite migration and idempotency tests"
```

### Task 3: Fan Out Events and Replay Consumers Independently

**Files:**
- Modify: `src/storage/PostgresDerivedIndexJournal.ts`
- Test: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Write failing independence and ordering tests**

Add tests with two consumers:

```ts
it('does not repeat a completed consumer when another consumer fails', async () => {
  const first: string[] = [];
  const second: string[] = [];
  const journal = createJournal({
    executor: new PgliteRdfSqlExecutor(new PGlite()),
    resolvePodScope: () => 'alice',
    retryDelayMs: 0,
    consumers: [
      consumer('fts-v1', first),
      consumer('vec-v1', second, { failOnce: true }),
    ],
  });
  await journal.open();
  await journal.recordResourceChange(event('/alice/a.md'));
  expect(await journal.replayConsumer('fts-v1')).toMatchObject({ delivered: 1, failed: 0 });
  expect(await journal.replayConsumer('vec-v1')).toMatchObject({ delivered: 0, failed: 1 });
  expect(await journal.replayConsumer('vec-v1')).toMatchObject({ delivered: 1, failed: 0 });
  expect(first).toEqual(['/alice/a.md']);
  expect(second).toEqual(['/alice/a.md', '/alice/a.md']);
});
```

Add this ordering test:

```ts
it('orders independently by consumer and Pod', async () => {
  const executor = new PgliteRdfSqlExecutor(new PGlite());
  const fts: string[] = [];
  const vec: string[] = [];
  const journal = createJournal({
    executor,
    resolvePodScope: (change) => change.path.split('/')[1]!,
    retryDelayMs: 60_000,
    consumers: [
      consumer('fts-v1', fts, { failOnce: true }),
      consumer('vec-v1', vec),
    ],
  });
  await journal.open();
  await journal.recordResourceChange(event('/alice/1'));
  await journal.recordResourceChange(event('/alice/2'));
  await journal.recordResourceChange(event('/bob/1'));
  expect(await journal.replayConsumer('fts-v1', 3)).toMatchObject({ delivered: 1, failed: 1 });
  expect(fts).toEqual(['/alice/1', '/bob/1']);
  expect(await journal.replayConsumer('vec-v1', 3)).toMatchObject({ delivered: 3, failed: 0 });
  expect(vec).toEqual(['/alice/1', '/alice/2', '/bob/1']);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: FAIL because `replayConsumer()` and per-consumer claims do not exist.

- [ ] **Step 3: Make event insertion and delivery fan-out one transaction**

Replace `append()` with a transaction that returns the event ID and executes one
idempotent delivery insert for each consumer active in the current process:

```sql
INSERT INTO derived_index_event_deliveries (consumer_id, event_id)
VALUES ($1, $2)
ON CONFLICT (consumer_id, event_id) DO NOTHING;
```

Use this helper for normal recording, RDF-source bootstrap, and reconciliation.

- [ ] **Step 4: Implement per-consumer claiming**

Change `claimNext(consumerId)` so lease recovery and selection are scoped to the
consumer. The eligibility predicate must be:

```sql
WHERE delivery.consumer_id = $1
  AND delivery.stage = 'pending'
  AND delivery.available_at <= $2
  AND NOT EXISTS (
    SELECT 1
    FROM derived_index_event_deliveries earlier_delivery
    JOIN derived_index_change_journal earlier_event
      ON earlier_event.id = earlier_delivery.event_id
    WHERE earlier_delivery.consumer_id = delivery.consumer_id
      AND earlier_event.pod_scope_id = event.pod_scope_id
      AND earlier_event.id < event.id
      AND earlier_delivery.stage <> 'done'
  )
ORDER BY event.id
LIMIT 1
FOR UPDATE SKIP LOCKED
```

- [ ] **Step 5: Implement explicit and legacy replay**

Store configured consumers in a `Map<string, DurableResourceChangeConsumer>`.
Implement `replayConsumer(consumerId, limit = 100)` using that map. Refactor a
private `replayDelivery(consumerId, listener, limit)` for both explicit replay
and:

```ts
public async replayPending(listener: ResourceChangeListener, limit = 100) {
  await this.registerConsumer(LEGACY_DERIVED_INDEX_CONSUMER_ID, true);
  return this.replayDelivery(LEGACY_DERIVED_INDEX_CONSUMER_ID, listener, limit);
}
```

- [ ] **Step 6: Run focused tests and typecheck**

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
bun run build:ts
```

Expected: PASS.

- [ ] **Step 7: Commit independent replay**

```bash
git add src/storage/PostgresDerivedIndexJournal.ts tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "🔁 Replay derived-index consumers independently" \
  -m "Constraint: Ordering is per consumer and Pod, not global." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: PGlite consumer isolation, ordering, retry, and typecheck"
```

### Task 4: Advance Checkpoints and Reconcile Authority Deletes

**Files:**
- Modify: `src/storage/PostgresDerivedIndexJournal.ts`
- Test: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Write failing checkpoint tests**

Add tests that query checkpoints through a test helper and prove:

```ts
it('advances only the successful consumer checkpoint', async () => {
  const executor = new PgliteRdfSqlExecutor(new PGlite());
  const journal = createJournal({
    executor,
    resolvePodScope: () => 'alice',
    consumers: [
      consumer('fts-v1', []),
      consumer('vec-v1', [], { failOnce: true }),
    ],
  });
  await journal.open();
  await journal.recordResourceChange(event('/alice/a.md'));
  await journal.replayConsumer('fts-v1');
  await journal.replayConsumer('vec-v1');
  expect(await checkpointAction(executor, 'fts-v1', 'alice', '/alice/a.md')).toBe('update');
  expect(await checkpointAction(executor, 'vec-v1', 'alice', '/alice/a.md')).toBeUndefined();
});
```

Add this exact helper:

```ts
async function checkpointAction(
  executor: PostgresRdfSqlExecutor,
  consumerId: string,
  podScopeId: string,
  resourcePath: string,
): Promise<string | undefined> {
  const rows = await executor.query<{ last_action: string }>(`
    SELECT last_action
    FROM derived_index_resource_checkpoints
    WHERE consumer_id = $1 AND pod_scope_id = $2 AND resource_path = $3
  `, [consumerId, podScopeId, resourcePath]);
  return rows[0]?.last_action;
}
```

Add a delete-success assertion that `last_action = 'delete'` and `deleted_at` is
non-null.

- [ ] **Step 2: Write failing reconciliation tests**

Add a reconciliation test that first delivers updates for `/alice/keep.md` and
`/alice/gone.md`, then calls:

```ts
await journal.reconcilePod('alice', ['/alice/keep.md', '/alice/new.md']);
```

Assert each consumer receives updates for `keep.md` and `new.md`, plus a delete
for `gone.md`. Replay them, reconcile again, and assert no second delete event is
appended for the tombstoned path.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: FAIL because completion does not write checkpoints and reconciliation
does not generate missing-resource deletes.

- [ ] **Step 4: Atomically complete delivery and checkpoint**

After the consumer call succeeds, execute one transaction containing:

```sql
UPDATE derived_index_event_deliveries
SET stage = 'done', lease_until = NULL, last_error = NULL
WHERE consumer_id = $1 AND event_id = $2;

INSERT INTO derived_index_resource_checkpoints
  (consumer_id, pod_scope_id, resource_path, last_event_id,
   last_action, updated_at, deleted_at)
VALUES ($1, $3, $4, $2, $5, $6,
        CASE WHEN $5 = 'delete' THEN $6 ELSE NULL END)
ON CONFLICT (consumer_id, pod_scope_id, resource_path) DO UPDATE
SET last_event_id = EXCLUDED.last_event_id,
    last_action = EXCLUDED.last_action,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at
WHERE derived_index_resource_checkpoints.last_event_id < EXCLUDED.last_event_id;
```

- [ ] **Step 5: Implement full-snapshot reconciliation**

Normalize `authorityPaths` into a `Set`. Query distinct active checkpoint paths
for the Pod, append `update` for every authority path, and append `delete` for
every checkpoint path absent from the set. Exclude paths whose newest checkpoint
is already tombstoned. Before appending a delete, reject an existing non-complete
delete event for the same Pod/path so concurrent or repeated reconciliation does
not create an in-flight delete storm.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
bun run build:ts
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint reconciliation**

```bash
git add src/storage/PostgresDerivedIndexJournal.ts tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "🧭 Reconcile derived indexes from Pod authority" \
  -m "Constraint: Checkpoints advance only after an idempotent consumer side effect succeeds." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: PGlite checkpoint, repair update, delete, and tombstone tests"
```

### Task 5: Make Automatic Polling and Cloud Wiring Consumer-Aware

**Files:**
- Modify: `src/storage/PostgresDerivedIndexJournal.ts`
- Modify: `config/cloud.json`
- Modify: `docs/COMPONENTS.md`
- Test: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Write failing automatic replay tests**

Create two configured consumers, make one fail once, and use `waitUntil()` to
assert the other reaches its checkpoint exactly once while the failing consumer
retries. Close the journal and assert no poller continues to deliver afterward.

- [ ] **Step 2: Run the automatic replay test and verify RED**

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: FAIL because `scheduleReplay()` still aggregates consumers.

- [ ] **Step 3: Replace the aggregate replay promise**

Replace one `replaying?: Promise<void>` with:

```ts
private readonly replaying = new Map<string, Promise<void>>();
```

For every configured consumer not already in the map, schedule its own
`replayConsumer(consumerId)` promise and remove only that entry in `finally`.
`close()` clears the timer and awaits `Promise.all(this.replaying.values())`.

- [ ] **Step 4: Wire the stable ID through Components.js configuration**

Add to the `RdfDerivedIndexingListener` entry in `config/cloud.json`:

```json
"consumerId": "rdf-fts-vec-v1"
```

Update the existing configuration assertion to require this exact value. Run
the generator; do not edit `dist/components` manually:

```bash
bun run build:components
```

- [ ] **Step 5: Document operations and recovery**

Add a concise `docs/COMPONENTS.md` section naming the three tables, stable
consumer IDs, Pod-ordering boundary, at-least-once/idempotency requirement, and
the rule that `reconcilePod()` receives a complete authority snapshot.

- [ ] **Step 6: Run focused tests and component/type builds**

```bash
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts tests/storage/RdfDerivedIndexingListener.test.ts
bun run build:ts
bun run build:components
```

Expected: all commands PASS.

- [ ] **Step 7: Commit runtime wiring and docs**

```bash
git add src/storage/PostgresDerivedIndexJournal.ts config/cloud.json docs/COMPONENTS.md tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "⚙️ Run cloud derived consumers on durable checkpoints" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: focused tests, TypeScript build, Components.js generation"
```

### Task 6: Prove Real PostgreSQL FTS/VEC Recovery and Full Regression

**Files:**
- Modify: `tests/storage/PostgresDerivedIndexJournal.test.ts`

- [ ] **Step 1: Extend the live PG17 test before implementation claims**

After indexing `doc.md`, supply an empty authority snapshot and replay the
configured `rdf-fts-vec-v1` consumer:

```ts
await journal.reconcilePod('https://pod.example/alice/', []);
expect(await journal.replayConsumer('rdf-fts-vec-v1')).toMatchObject({
  delivered: 1,
  failed: 0,
});
expect(await textIndex.search({
  query: 'postgres retrieval',
  workspace: 'https://pod.example/alice/',
})).toEqual([]);
expect(await vectorIndex.search({
  embedding: [1, 0],
  workspace: 'https://pod.example/alice/',
})).toEqual([]);
```

Reopen the journal against the same database and assert zero pending deliveries
and one delete tombstone for the configured consumer.

- [ ] **Step 2: Run the live test against isolated PostgreSQL 17**

Create a temporary PG17 container/database using the repository's existing test
image, set `XPOD_DERIVED_INDEX_PG_DSN`, then run:

```bash
XPOD_DERIVED_INDEX_PG_DSN="$XPOD_TEST_PG_DSN" \
  bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts
```

Expected: the live test runs rather than skips, FTS and VEC inserts/searches pass,
reconciliation deletes both, and the process exits 0. Remove only the temporary
container and test database created by this step.

- [ ] **Step 3: Run the complete required regression sequence**

Run sequentially:

```bash
bun run build:ts
bun run build:components
bun run test -- tests/storage/PostgresDerivedIndexJournal.test.ts tests/storage/RdfDerivedIndexingListener.test.ts tests/storage/rdf/PostgresRdfTextIndex.test.ts tests/storage/rdf/PostgresRdfVectorIndex.test.ts
bun run test:integration
```

Expected: every command exits 0. If integration credentials are stale, repair
the isolated test credentials and rerun; do not convert a failure into a skip.

- [ ] **Step 4: Inspect final scope and generated output**

```bash
git status --short
git diff --check
git diff --stat
```

Confirm every changed line belongs to the approved design, no `.env`, secret,
root-level test database, or unrelated worktree change is staged, and the
pre-existing test timing edit is either intentionally included with evidence or
left untouched.

- [ ] **Step 5: Commit final live acceptance evidence**

```bash
git add tests/storage/PostgresDerivedIndexJournal.test.ts
git commit -m "✅ Prove PostgreSQL FTS/VEC replay and self-healing" \
  -m "Constraint: The acceptance must execute real PostgreSQL 17 without a skip." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: real PG17 FTS/VEC lifecycle; build:ts; build:components; full integration"
```

## Downstream Handoff

After this plan passes, return to the active RDF rollout plan. Do not claim the
overall goal complete until the exact components revision passes the one-off
SealOS 2M c1/c8 gate, Xpod's QLever-primary configuration passes full integration,
both repositories are merged intentionally, the production deployment is
healthy, and production probes prove QLever serves the supported request matrix.
