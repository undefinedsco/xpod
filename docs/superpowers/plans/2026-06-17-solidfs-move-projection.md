# SolidFS Move Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement recoverable SolidFS file/folder move projection using the existing SolidFS journal and RDF term dictionary rewrite, without introducing a full relative-GSPO resolver.

**Architecture:** Extend SolidFS change types with `moved`, let existing journal persist and replay move entries, and add an RDF engine `rewriteTerms` capability that rewrites safe URI terms at dictionary level before falling back to explicit remap/reconcile. Keep `.meta`/hydration/parser coverage as visible note-style metadata and keep index artifacts internal.

**Tech Stack:** TypeScript, Bun, Vitest, SQLite via `SqliteRuntime`, PostgreSQL/PGlite async executor, RDFJS/N3, existing SolidFS and RDF engine modules.

---

## File structure

Modify these focused areas only:

- `src/solidfs/types.ts`
  - Extend `SolidFsChangeType` and `SolidFsChange` with move metadata.
  - Add minimal materialization/hydration metadata types used by workspace prompt/tool contracts.
- `src/solidfs/SolidFsSyncJournal.ts`
  - Normalize `previousPath` for move changes.
  - Include previous path/resource in operation id hashing.
  - Treat moved entries like committed file operations, not deleted tombstones.
- `src/solidfs/RdfIndexSolidFsSyncer.ts`
  - Handle `moved` by calling RDF term rewrite when available and then updating text/vector source projection.
  - Keep content re-parse only for normal created/updated changes.
- `src/storage/rdf/types.ts`
  - Add `RdfTermRewriteInput`, `RdfTermRewriteResult`, and `rewriteTerms?` to `RdfEngineLike`.
- `src/storage/rdf/RdfTermDictionary.ts`
  - Add SQLite term rewrite helper for named-node URI terms.
- `src/storage/rdf/RdfQuadIndex.ts`
  - Expose `rewriteTerms` through file-backed index and bump data version.
- `src/storage/rdf/SolidRdfEngine.ts`
  - Forward `rewriteTerms` to the index.
- `src/storage/rdf/PostgresRdfEngine.ts`
  - Add PostgreSQL term rewrite/remap implementation.
- `src/solidfs/SolidFsMetaNotes.ts` (new)
  - Build `.meta` note Turtle snippets or plain data objects for file metadata and parser coverage.
- `src/solidfs/WorkspacePrompt.ts` (new)
  - Produce the static workspace semantics prompt and a dynamic summary block.
- Tests:
  - `tests/solidfs/SolidFsSyncJournal.test.ts`
  - `tests/solidfs/RdfIndexSolidFsSyncer.test.ts`
  - `tests/storage/rdf/RdfQuadIndex.test.ts`
  - `tests/storage/rdf/PostgresRdfEngine.test.ts`
  - `tests/solidfs/SolidFsMetaNotes.test.ts` (new)
  - `tests/solidfs/WorkspacePrompt.test.ts` (new)

Do not modify unrelated RDF/QLever work unless a test shows a direct integration break.

Do not make all GSPO subject/object/source terms relative, and do not add a mandatory full-IRI resolver to the RDF query hot path. This plan implements URI projection moves through file identity, existing SolidFS journal replay, and controlled term dictionary rewrite.

---

### Task 1: Extend SolidFS change model for moves

**Files:**
- Modify: `src/solidfs/types.ts`
- Modify: `src/solidfs/SolidFsSyncJournal.ts`
- Test: `tests/solidfs/SolidFsSyncJournal.test.ts`

- [ ] **Step 1: Write failing journal test for moved entries**

Append this test near the existing journal transaction tests in `tests/solidfs/SolidFsSyncJournal.test.ts`:

```ts
  it('persists and replays moved entries with previous path and shared transaction id', async () => {
    await mkdir(path.join(workspaceRoot, 'new'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'new', 'data.ttl'), '<#me> <https://schema.org/name> "Moved" .\n', 'utf8');

    const journal = openJournal();
    const change: SolidFsChange = {
      type: 'moved',
      previousPath: 'old/data.ttl',
      previousResource: 'https://pod.example/alice/projects/demo/old/data.ttl',
      path: 'new/data.ttl',
      resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      source: 'filesystem',
      sourcePath: path.join(workspaceRoot, 'new', 'data.ttl'),
      contentType: 'text/turtle',
      projection: 'direct',
      sourceVersion: 'etag-new',
    };
    const manifest: SolidFsManifest = {
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: workspaceRoot,
      projection: 'direct',
      entries: [],
    };

    await journal.recordLocalCommitted(change, manifest, 'solidfs_tx_move');

    const replayed: SolidFsChange[] = [];
    const result = await journal.replayPending({
      async sync(next): Promise<void> {
        replayed.push(next);
      },
    });

    expect(result).toEqual({ attempted: 1, completed: 1, failed: 0, reconcileRequired: 0 });
    expect(replayed).toEqual([
      expect.objectContaining({
        type: 'moved',
        previousPath: 'old/data.ttl',
        previousResource: 'https://pod.example/alice/projects/demo/old/data.ttl',
        path: 'new/data.ttl',
        resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      }),
    ]);
    expect(journal.listOperations()[0]).toMatchObject({
      txId: 'solidfs_tx_move',
      stage: 'done',
    });
    journal.close();
  });
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bunx vitest --run tests/solidfs/SolidFsSyncJournal.test.ts -t "moved entries"
```

Expected: TypeScript/Vitest fails because `SolidFsChangeType` does not include `moved` and `previousPath` is not in `SolidFsChange`.

- [ ] **Step 3: Extend `src/solidfs/types.ts`**

Replace the existing change type and interface with this shape:

```ts
export type SolidFsChangeType = 'created' | 'updated' | 'deleted' | 'moved' | 'moved_prefix';

export interface SolidFsChange {
  path: string;
  resource?: string;
  /** Previous local path for move operations. */
  previousPath?: string;
  /** Previous Solid resource URI for move operations. */
  previousResource?: string;
  /** Prefix source for moved_prefix operations. P1 only; P0 writers should not emit it. */
  previousPrefix?: string;
  /** Prefix target for moved_prefix operations. P1 only; P0 writers should not emit it. */
  prefix?: string;
  source: SolidFsEntrySource;
  sourcePath: string;
  contentType?: string;
  projection: SolidFsProjection;
  type: SolidFsChangeType;
  sourceVersion?: string;
  contentHash?: string;
  projectionHints?: Record<string, unknown>;
}
```

- [ ] **Step 4: Normalize move fields in `SolidFsSyncJournal.ts`**

Change `normalizeChange` to preserve and normalize `previousPath`:

```ts
function normalizeChange(change: SolidFsChange): SolidFsChange {
  return {
    ...change,
    path: change.path.split(/[\\/]+/u).join(path.sep),
    previousPath: change.previousPath?.split(/[\\/]+/u).join(path.sep),
  };
}
```

Change `operationId` so moved entries do not collapse incorrectly:

```ts
function operationId(workspace: string, change: SolidFsChange, afterHash?: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspace,
      path: change.path,
      previousPath: change.previousPath,
      prefix: change.prefix,
      previousPrefix: change.previousPrefix,
      type: change.type,
      resource: change.resource,
      previousResource: change.previousResource,
      source: change.source,
      sourcePath: change.sourcePath,
      projection: change.projection,
      sourceVersion: change.sourceVersion,
      afterHash,
    }))
    .digest('hex')
    .slice(0, 32);
  return `sync_${digest}`;
}
```

- [ ] **Step 5: Run focused journal tests**

Run:

```bash
bunx vitest --run tests/solidfs/SolidFsSyncJournal.test.ts
```

Expected: all SolidFS journal tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/solidfs/types.ts src/solidfs/SolidFsSyncJournal.ts tests/solidfs/SolidFsSyncJournal.test.ts
git commit -m "🧭 Carry SolidFS move changes through the journal" -m "Extend SolidFS change metadata so move operations can be replayed by the existing per-Pod journal instead of a separate move log.

Constraint: Move replay must reuse SolidFS SyncJournal tx grouping and compaction.
Rejected: Separate MoveJournal | duplicates existing journal lifecycle.
Confidence: high
Scope-risk: narrow
Tested: bunx vitest --run tests/solidfs/SolidFsSyncJournal.test.ts"
```

---

### Task 2: Add RDF term rewrite contract

**Files:**
- Modify: `src/storage/rdf/types.ts`
- Modify: `src/storage/rdf/index.ts` to export the new term rewrite types if they are not already exported by the barrel.
- Test: type/build only in this task

- [ ] **Step 1: Add term rewrite types to `src/storage/rdf/types.ts`**

Insert near other RDF engine operation types:

```ts
export type RdfTermRewriteScope = 'graph' | 'source' | 'system' | 'safe_projection';
export type RdfTermRewriteMode = 'direct' | 'remap_existing' | 'safe';

export interface RdfTermRewriteInput {
  oldPrefix: string;
  newPrefix: string;
  /** Conservative scope. P0 callers should use graph/source/system only. */
  scope?: RdfTermRewriteScope;
  /** safe = direct when possible, remap when needed, skip unsafe mixed terms. */
  mode?: RdfTermRewriteMode;
  /** Optional exact source URI boundaries for system projection moves. */
  sources?: string[];
}

export interface RdfTermRewriteSkippedTerm {
  id: number;
  value: string;
  reason: 'not_named_node' | 'outside_scope' | 'mixed_usage' | 'collision_conflict';
}

export interface RdfTermRewriteResult {
  matchedTerms: number;
  rewrittenTerms: number;
  remappedTerms: number;
  skippedTerms: RdfTermRewriteSkippedTerm[];
  affectedQuads: number;
}
```

Then add the optional capability to `RdfEngineLike`:

```ts
  rewriteTerms?(input: RdfTermRewriteInput): RdfTermRewriteResult | Promise<RdfTermRewriteResult>;
```

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
bun run build:ts --pretty false
```

Expected: build passes because `rewriteTerms?` is optional and no implementation is required yet. Fix only type import/export errors in this task.

- [ ] **Step 3: Commit Task 2**

```bash
git add src/storage/rdf/types.ts src/storage/rdf/index.ts
git commit -m "🧭 Define RDF term rewrite capability" -m "Expose a narrow engine contract for URI projection moves without forcing a full relative-GSPO resolver into query planning.

Constraint: Existing engines dictionary-encode G/S/P/O terms.
Rejected: Ad hoc SQL updates | bypasses cache invalidation and data-version semantics.
Confidence: high
Scope-risk: narrow
Tested: bun run build:ts --pretty false"
```

---

### Task 3: Implement SQLite/file-backed term dictionary rewrite

**Files:**
- Modify: `src/storage/rdf/RdfTermDictionary.ts`
- Modify: `src/storage/rdf/RdfQuadIndex.ts`
- Modify: `src/storage/rdf/SolidRdfEngine.ts`
- Test: `tests/storage/rdf/RdfQuadIndex.test.ts`

- [ ] **Step 1: Add failing test for direct dictionary rewrite**

Append to `tests/storage/rdf/RdfQuadIndex.test.ts` near source/index tests:

```ts
  it('rewrites safe named-node URI terms without rewriting quad rows', () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    index.replaceSource([
      quad(
        namedNode('https://pod.example/old/data.ttl#this'),
        namedNode('https://schema.org/name'),
        literal('Demo'),
        namedNode('https://pod.example/old/data.ttl'),
      ),
    ], {
      source: 'https://pod.example/old/data.ttl',
      workspace: 'https://pod.example/',
      localPath: 'old/data.ttl',
      contentType: 'text/turtle',
    });

    const before = index.scan({ pattern: { graph: namedNode('https://pod.example/old/data.ttl') } });
    expect(before.quads).toHaveLength(1);

    const result = index.rewriteTerms({
      oldPrefix: 'https://pod.example/old/',
      newPrefix: 'https://pod.example/new/',
      scope: 'safe_projection',
      mode: 'safe',
    });

    expect(result).toMatchObject({ matchedTerms: 2, rewrittenTerms: 2, remappedTerms: 0, affectedQuads: 0 });
    expect(index.scan({ pattern: { graph: namedNode('https://pod.example/old/data.ttl') } }).quads).toHaveLength(0);
    const after = index.scan({ pattern: { graph: namedNode('https://pod.example/new/data.ttl') } });
    expect(after.quads).toHaveLength(1);
    expect(after.quads[0].subject.value).toBe('https://pod.example/new/data.ttl#this');
    index.close();
  });
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts -t "rewrites safe named-node URI terms"
```

Expected: fails because `rewriteTerms` is not implemented.

- [ ] **Step 3: Add dictionary helper in `RdfTermDictionary.ts`**

Add imports if needed:

```ts
import type { RdfTermRewriteInput, RdfTermRewriteResult } from './types';
```

Add this public method to `RdfTermDictionary`:

```ts
  public rewriteNamedNodePrefix(input: RdfTermRewriteInput): RdfTermRewriteResult {
    const oldPrefix = input.oldPrefix;
    const newPrefix = input.newPrefix;
    if (!oldPrefix || oldPrefix === newPrefix) {
      return { matchedTerms: 0, rewrittenTerms: 0, remappedTerms: 0, skippedTerms: [], affectedQuads: 0 };
    }

    const rows = this.db.prepare<RdfTermRow>(`
      SELECT * FROM rdf_terms
      WHERE kind = 'iri'
        AND value LIKE ?
      ORDER BY id ASC
    `).all(`${oldPrefix}%`);

    let rewrittenTerms = 0;
    const skippedTerms: RdfTermRewriteResult['skippedTerms'] = [];
    const update = this.db.prepare(`
      UPDATE rdf_terms
      SET value = ?, value_head = ?, hash = ?, normalized_text = ?
      WHERE id = ?
    `);

    this.db.transaction(() => {
      for (const row of rows) {
        const nextValue = `${newPrefix}${row.value.slice(oldPrefix.length)}`;
        const nextIdentity = this.identity('iri', nextValue, null, null, nextValue, null);
        const existing = this.findId(nextIdentity);
        if (existing !== undefined && existing !== row.id) {
          skippedTerms.push({ id: row.id, value: row.value, reason: 'collision_conflict' });
          continue;
        }
        update.run(nextValue, nextIdentity.valueHead, nextIdentity.hash, nextIdentity.normalizedText, row.id);
        rewrittenTerms += 1;
      }
    })();

    this.termCache.clear();
    this.idCache.clear();
    return {
      matchedTerms: rows.length,
      rewrittenTerms,
      remappedTerms: 0,
      skippedTerms,
      affectedQuads: 0,
    };
  }
```

Keep this method inside `RdfTermDictionary` so it can call the existing private `identity(...)` and `findId(...)` helpers. Do not expose lower-level SQL mutation.

- [ ] **Step 4: Add `rewriteTerms` to `RdfQuadIndex.ts`**

Add imports for the new types. Add method on `RdfQuadIndex`:

```ts
  public rewriteTerms(input: RdfTermRewriteInput): RdfTermRewriteResult {
    const dictionary = this.requireDictionary();
    const result = dictionary.rewriteNamedNodePrefix(input);
    if (result.rewrittenTerms > 0 || result.remappedTerms > 0) {
      this.cardinalityCache.clear();
      this.bumpDataVersion();
    }
    return result;
  }
```

- [ ] **Step 5: Forward from `SolidRdfEngine.ts`**

Add method:

```ts
  public rewriteTerms(input: RdfTermRewriteInput): RdfTermRewriteResult {
    return this.index.rewriteTerms(input);
  }
```

- [ ] **Step 6: Run focused and related tests**

Run:

```bash
bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts -t "rewrites safe named-node URI terms"
bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts
bun run build:ts --pretty false
```

Expected: all pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/storage/rdf/RdfTermDictionary.ts src/storage/rdf/RdfQuadIndex.ts src/storage/rdf/SolidRdfEngine.ts tests/storage/rdf/RdfQuadIndex.test.ts
git commit -m "🧭 Rewrite local RDF URI terms for moves" -m "Add a controlled dictionary-level rewrite path for file-backed RDF indexes so URI projection moves do not rewrite rdf_quads rows when no term collision exists.

Constraint: Term caches and facts data version must be invalidated through engine APIs.
Rejected: Direct SQL in SolidFS syncer | bypasses dictionary invariants.
Confidence: medium
Scope-risk: moderate
Tested: bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts
Tested: bun run build:ts --pretty false"
```

---

### Task 4: Implement PostgreSQL term rewrite

**Files:**
- Modify: `src/storage/rdf/PostgresRdfEngine.ts`
- Test: `tests/storage/rdf/PostgresRdfEngine.test.ts`

- [ ] **Step 1: Add failing PG rewrite test**

Append to `tests/storage/rdf/PostgresRdfEngine.test.ts` near other mutation/source tests:

```ts
  it('rewrites safe named-node URI terms in Postgres without changing quad membership', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    await engine.open();
    await engine.replaceSource([
      quad(
        namedNode('https://pod.example/old/data.ttl#this'),
        namedNode('https://schema.org/name'),
        literal('Demo'),
        namedNode('https://pod.example/old/data.ttl'),
      ),
    ], {
      source: 'https://pod.example/old/data.ttl',
      workspace: 'https://pod.example/',
      localPath: 'old/data.ttl',
      contentType: 'text/turtle',
    });

    const result = await engine.rewriteTerms({
      oldPrefix: 'https://pod.example/old/',
      newPrefix: 'https://pod.example/new/',
      scope: 'safe_projection',
      mode: 'safe',
    });

    expect(result).toMatchObject({ matchedTerms: 2, rewrittenTerms: 2, remappedTerms: 0, affectedQuads: 0 });
    const oldScan = await engine.scan({ pattern: { graph: namedNode('https://pod.example/old/data.ttl') } });
    expect(oldScan.quads).toHaveLength(0);
    const newScan = await engine.scan({ pattern: { graph: namedNode('https://pod.example/new/data.ttl') } });
    expect(newScan.quads).toHaveLength(1);
    expect(newScan.quads[0].subject.value).toBe('https://pod.example/new/data.ttl#this');
    await engine.close();
  });
```

- [ ] **Step 2: Run failing PG focused test**

Run:

```bash
bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts -t "rewrites safe named-node URI terms in Postgres"
```

Expected: fails because `PostgresRdfEngine.rewriteTerms` does not exist.

- [ ] **Step 3: Add identity helper for PG dictionary rows**

Inside `PostgresRdfTermDictionary`, add a public method:

```ts
  public clearCaches(): void {
    this.termCache.clear();
    this.idCache.clear();
  }

  public async identityForNamedNodeValue(value: string): Promise<RdfTermIdentity> {
    return this.identity('iri', value, null, null, value, null);
  }
```

This keeps hash/value_head calculation in the dictionary instead of duplicating it in the engine.

- [ ] **Step 4: Implement `PostgresRdfEngine.rewriteTerms`**

Add method on `PostgresRdfEngine`:

```ts
  public async rewriteTerms(input: RdfTermRewriteInput): Promise<RdfTermRewriteResult> {
    const executor = this.requireExecutor();
    const dictionary = this.requireTermDictionary();
    const oldPrefix = input.oldPrefix;
    const newPrefix = input.newPrefix;
    if (!oldPrefix || oldPrefix === newPrefix) {
      return { matchedTerms: 0, rewrittenTerms: 0, remappedTerms: 0, skippedTerms: [], affectedQuads: 0 };
    }

    const rows = await executor.query<PostgresRdfTermRow>(`
      SELECT *
      FROM rdf_terms
      WHERE kind = 'iri'
        AND value LIKE $1
      ORDER BY id ASC
    `, [`${oldPrefix}%`]);

    let rewrittenTerms = 0;
    const skippedTerms: RdfTermRewriteSkippedTerm[] = [];

    await executor.transaction(async (tx) => {
      const scopedDictionary = new PostgresRdfTermDictionary(tx);
      for (const row of rows) {
        const nextValue = `${newPrefix}${row.value.slice(oldPrefix.length)}`;
        const nextIdentity = await scopedDictionary.identityForNamedNodeValue(nextValue);
        const existing = await tx.query<{ id: number }>('SELECT id FROM rdf_terms WHERE hash = $1', [nextIdentity.hash]);
        const existingId = existing[0]?.id;
        if (existingId !== undefined && existingId !== row.id) {
          skippedTerms.push({ id: row.id, value: row.value, reason: 'collision_conflict' });
          continue;
        }
        await tx.exec(`
          UPDATE rdf_terms
          SET value = $1,
              value_head = $2,
              hash = $3,
              normalized_text = $4
          WHERE id = $5
        `, [nextValue, nextIdentity.valueHead, nextIdentity.hash, nextIdentity.normalizedText, row.id]);
        rewrittenTerms += 1;
      }
      if (rewrittenTerms > 0) {
        await this.bumpFactsDataVersion(tx);
      }
    });

    if (rewrittenTerms > 0) {
      dictionary.clearCaches();
    }

    return {
      matchedTerms: rows.length,
      rewrittenTerms,
      remappedTerms: 0,
      skippedTerms,
      affectedQuads: 0,
    };
  }
```

- [ ] **Step 5: Run PG focused and full RDF engine tests**

Run:

```bash
bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts -t "rewrites safe named-node URI terms in Postgres"
bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts
bun run build:ts --pretty false
```

Expected: all pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/storage/rdf/PostgresRdfEngine.ts tests/storage/rdf/PostgresRdfEngine.test.ts
git commit -m "🧭 Rewrite Postgres RDF URI terms for moves" -m "Add the PG implementation of controlled URI term rewrite so cloud RDF projection moves can update distinct dictionary terms instead of rewriting the quad fact table.

Constraint: PG term identity hash remains unique and must be recomputed by the dictionary.
Rejected: Replacing sources by reparsing files | unnecessary for path-only moves with unchanged content hash.
Confidence: medium
Scope-risk: moderate
Tested: bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts
Tested: bun run build:ts --pretty false"
```

---

### Task 5: Handle moved changes in RDF/text/vector SolidFS syncer

**Files:**
- Modify: `src/solidfs/RdfIndexSolidFsSyncer.ts`
- Test: `tests/solidfs/RdfIndexSolidFsSyncer.test.ts`

- [ ] **Step 1: Add failing syncer test for moved projection**

Append to `tests/solidfs/RdfIndexSolidFsSyncer.test.ts`:

```ts
  it('rewrites RDF terms for moved changes without reparsing unchanged content', async () => {
    const rewriteTerms = vi.fn().mockResolvedValue({
      matchedTerms: 2,
      rewrittenTerms: 2,
      remappedTerms: 0,
      skippedTerms: [],
      affectedQuads: 0,
    });
    const syncLocalRdfDocument = vi.fn();
    const deleteLocalRdfIndex = vi.fn();
    const syncer = new RdfIndexSolidFsSyncer({
      index: {
        syncLocalRdfDocument,
        deleteLocalRdfIndex,
        rewriteTerms,
      } as any,
    });
    const manifest: SolidFsManifest = {
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: '/tmp/workspace',
      projection: 'direct',
      entries: [],
    };
    const change: SolidFsChange = {
      type: 'moved',
      previousPath: 'old/data.ttl',
      previousResource: 'https://pod.example/alice/projects/demo/old/data.ttl',
      path: 'new/data.ttl',
      resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      source: 'filesystem',
      sourcePath: '/tmp/workspace/new/data.ttl',
      contentType: 'text/turtle',
      projection: 'direct',
    };

    await syncer.sync(change, manifest);

    expect(rewriteTerms).toHaveBeenCalledWith({
      oldPrefix: 'https://pod.example/alice/projects/demo/old/data.ttl',
      newPrefix: 'https://pod.example/alice/projects/demo/new/data.ttl',
      scope: 'safe_projection',
      mode: 'safe',
    });
    expect(syncLocalRdfDocument).not.toHaveBeenCalled();
    expect(deleteLocalRdfIndex).not.toHaveBeenCalled();
  });
```

This test intentionally requires adding optional `rewriteTerms` to `LocalRdfIndexAccessor` in `src/storage/accessors/MixDataAccessor.ts`.

- [ ] **Step 2: Run failing test**

Run:

```bash
bunx vitest --run tests/solidfs/RdfIndexSolidFsSyncer.test.ts -t "rewrites RDF terms for moved changes"
```

Expected: fails because moved changes are treated like normal updates or ignored.

- [ ] **Step 3: Add move handling to syncer**

In `RdfIndexSolidFsSyncer.sync`, add this before deleted/created/updated logic:

```ts
    if (change.type === 'moved') {
      await this.syncMoved(change, workspace);
      return;
    }
```

Add method:

```ts
  private async syncMoved(change: SolidFsChange, workspace: SolidFsManifest): Promise<void> {
    const previousResource = change.previousResource ?? sourceFromWorkspace({ ...change, path: change.previousPath ?? change.path }, workspace);
    const nextResource = change.resource ?? sourceFromWorkspace(change, workspace);
    const rewriteCapable = this.index as LocalRdfIndexAccessor & {
      rewriteTerms?: (input: RdfTermRewriteInput) => MaybePromise<RdfTermRewriteResult>;
    };
    if (rewriteCapable.rewriteTerms && previousResource !== nextResource) {
      await rewriteCapable.rewriteTerms({
        oldPrefix: previousResource,
        newPrefix: nextResource,
        scope: 'safe_projection',
        mode: 'safe',
      });
    }

    if (this.textIndex && isTextIndexableChange(change)) {
      const previousSource = previousResource;
      await this.textIndex.deleteSource(previousSource);
      const text = await readFile(change.sourcePath, 'utf8');
      await this.textIndex.indexText(this.sourceInput(change, workspace), text);
    }

    if (this.vectorIndex && this.vectorizeText && isTextIndexableChange(change)) {
      const previousSource = previousResource;
      await this.vectorIndex.deleteSource(previousSource);
      const text = await readFile(change.sourcePath, 'utf8');
      const source = this.sourceInput(change, workspace);
      const chunks = await this.vectorizeText({ ...source, text });
      await this.vectorIndex.indexVector(source, chunks);
    }
  }
```

Add imports for `RdfTermRewriteInput` and `RdfTermRewriteResult` from `../storage/rdf`. Add this optional method to `LocalRdfIndexAccessor` in `src/storage/accessors/MixDataAccessor.ts`:

```ts
  rewriteTerms?(input: RdfTermRewriteInput): Promise<RdfTermRewriteResult> | RdfTermRewriteResult;
```

- [ ] **Step 4: Run syncer tests**

Run:

```bash
bunx vitest --run tests/solidfs/RdfIndexSolidFsSyncer.test.ts
bun run build:ts --pretty false
```

Expected: all pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/solidfs/RdfIndexSolidFsSyncer.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts src/storage/accessors/MixDataAccessor.ts
git commit -m "🧭 Project SolidFS moves through RDF term rewrite" -m "Teach the RDF SolidFS syncer to treat moves as URI projection changes and reuse content-derived indexes unless text/vector source projection must be refreshed.

Constraint: Moved content should not be reparsed as a normal update when content hash is unchanged.
Rejected: Delete and replace source for every move | loses the term dictionary write-amplification benefit.
Confidence: medium
Scope-risk: moderate
Tested: bunx vitest --run tests/solidfs/RdfIndexSolidFsSyncer.test.ts
Tested: bun run build:ts --pretty false"
```

---

### Task 6: Add `.meta` note builders and workspace prompt helpers

**Files:**
- Create: `src/solidfs/SolidFsMetaNotes.ts`
- Create: `src/solidfs/WorkspacePrompt.ts`
- Modify: `src/solidfs/index.ts`
- Test: `tests/solidfs/SolidFsMetaNotes.test.ts`
- Test: `tests/solidfs/WorkspacePrompt.test.ts`

- [ ] **Step 1: Write failing `.meta` note tests**

Create `tests/solidfs/SolidFsMetaNotes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFileMetadataNote, buildParserCoverageNote } from '../../src/solidfs';

describe('SolidFS .meta notes', () => {
  it('builds file metadata note triples without exposing storage secrets', () => {
    const ttl = buildFileMetadataNote({
      subject: '#file',
      about: './report.pdf',
      title: 'File metadata',
      description: 'Remote PDF object, hydrate before reading full bytes.',
      mediaType: 'application/pdf',
      byteSize: 123456789,
      contentHash: 'sha256:abc',
      materializationClass: 'placeholder-r2',
    });

    expect(ttl).toContain('<#file> a udfs:Note');
    expect(ttl).toContain('sioc:about <./report.pdf>');
    expect(ttl).toContain('udfs:materializationClass "placeholder-r2"');
    expect(ttl).not.toContain('signed');
    expect(ttl).not.toContain('bucket');
    expect(ttl).not.toContain('cachePath');
  });

  it('builds parser coverage note with partial page coverage', () => {
    const ttl = buildParserCoverageNote({
      subject: '#parser-pdf-v1',
      about: './report.pdf',
      parserKind: 'pdf',
      parserVersion: 'pdf-v1',
      coverageUnit: 'page',
      coveredRange: '1-12',
      parsedUnits: 12,
      totalUnits: 240,
      status: 'partial',
    });

    expect(ttl).toContain('udfs:noteKind "parser-coverage"');
    expect(ttl).toContain('udfs:coveredRange "1-12"');
    expect(ttl).toContain('udfs:parsedUnits 12');
    expect(ttl).toContain('udfs:totalUnits 240');
  });
});
```

- [ ] **Step 2: Write failing workspace prompt tests**

Create `tests/solidfs/WorkspacePrompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildWorkspaceSemanticsPrompt, buildWorkspaceSummaryPrompt } from '../../src/solidfs';

describe('workspace prompt helpers', () => {
  it('explains placeholders and explicit hydration', () => {
    const prompt = buildWorkspaceSemanticsPrompt();
    expect(prompt).toContain('Xpod SolidFS materialized workspace');
    expect(prompt).toContain('Do not assume placeholder bytes are the real content');
    expect(prompt).toContain('Hydration has cost');
    expect(prompt).toContain('Search/vector/index artifacts are internal');
  });

  it('renders dynamic workspace summary', () => {
    const prompt = buildWorkspaceSummaryPrompt({
      root: '/workspace/demo',
      authority: 'cloud-object-store',
      files: 100,
      bylineLocalFiles: 90,
      remotePlaceholders: 10,
      hydratedRemoteObjects: 2,
      freeLocalCacheBytes: 1024,
      maxHydrateBytesWithoutConfirmation: 2048,
      tools: ['stat', 'read_meta', 'hydrate'],
    });

    expect(prompt).toContain('Root: /workspace/demo');
    expect(prompt).toContain('Remote placeholders: 10');
    expect(prompt).toContain('hydrate');
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bunx vitest --run tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
```

Expected: fails because files/functions do not exist.

- [ ] **Step 4: Implement `src/solidfs/SolidFsMetaNotes.ts`**

```ts
export type SolidFsMaterializationClass = 'byline-local' | 'placeholder-r2' | 'hydrated-r2';
export type SolidFsParserCoverageStatus = 'none' | 'partial' | 'complete' | 'stale' | 'failed';

export interface FileMetadataNoteInput {
  subject: string;
  about: string;
  title: string;
  description: string;
  mediaType?: string;
  byteSize?: number;
  contentHash?: string;
  materializationClass: SolidFsMaterializationClass;
}

export interface ParserCoverageNoteInput {
  subject: string;
  about: string;
  parserKind: string;
  parserVersion: string;
  coverageUnit: 'page' | 'line' | 'byte' | 'section' | 'symbol' | 'rdf-resource';
  coveredRange: string;
  parsedUnits: number;
  totalUnits?: number;
  status: SolidFsParserCoverageStatus;
}

const PREFIXES = '@prefix dct: <http://purl.org/dc/terms/> .\n@prefix sioc: <http://rdfs.org/sioc/ns#> .\n@prefix udfs: <https://vocab.undefineds.co/udfs#> .\n\n';

export function buildFileMetadataNote(input: FileMetadataNoteInput): string {
  const lines = [
    `${term(input.subject)} a udfs:Note ;`,
    `  sioc:about ${term(input.about)} ;`,
    `  dct:title ${literal(input.title)} ;`,
    `  dct:description ${literal(input.description)} ;`,
    '  udfs:noteKind "file-metadata" ;',
  ];
  if (input.mediaType) lines.push(`  udfs:mediaType ${literal(input.mediaType)} ;`);
  if (input.byteSize !== undefined) lines.push(`  udfs:byteSize ${input.byteSize} ;`);
  if (input.contentHash) lines.push(`  udfs:contentHash ${literal(input.contentHash)} ;`);
  lines.push(`  udfs:materializationClass ${literal(input.materializationClass)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

export function buildParserCoverageNote(input: ParserCoverageNoteInput): string {
  const lines = [
    `${term(input.subject)} a udfs:Note ;`,
    `  sioc:about ${term(input.about)} ;`,
    '  dct:title "Parser coverage" ;',
    `  dct:description ${literal(`Parsed ${input.coveredRange}.`)} ;`,
    '  udfs:noteKind "parser-coverage" ;',
    `  udfs:parserKind ${literal(input.parserKind)} ;`,
    `  udfs:parserVersion ${literal(input.parserVersion)} ;`,
    `  udfs:coverageUnit ${literal(input.coverageUnit)} ;`,
    `  udfs:coveredRange ${literal(input.coveredRange)} ;`,
    `  udfs:parsedUnits ${input.parsedUnits} ;`,
  ];
  if (input.totalUnits !== undefined) lines.push(`  udfs:totalUnits ${input.totalUnits} ;`);
  lines.push(`  udfs:status ${literal(input.status)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

function term(value: string): string {
  return value.startsWith('<') || value.startsWith('_:') ? value : `<${value}>`;
}

function literal(value: string): string {
  return JSON.stringify(value);
}
```

- [ ] **Step 5: Implement `src/solidfs/WorkspacePrompt.ts`**

```ts
export interface WorkspaceSummaryPromptInput {
  root: string;
  authority: 'local-filesystem' | 'cloud-object-store';
  files: number;
  bylineLocalFiles: number;
  remotePlaceholders: number;
  hydratedRemoteObjects: number;
  freeLocalCacheBytes?: number;
  maxHydrateBytesWithoutConfirmation?: number;
  tools: string[];
}

export function buildWorkspaceSemanticsPrompt(): string {
  return `## Workspace Semantics\n\nYou are operating inside an Xpod SolidFS materialized workspace.\n\n- Directory entries are complete: \`ls\` and \`find\` show the workspace tree.\n- Text/by-line files are materialized locally and can be read with normal tools.\n- Large binary/media/remote-object files may appear as placeholders.\n- Placeholder metadata is available through \`.meta\` and workspace tools.\n- Do not assume placeholder bytes are the real content.\n- Hydration has cost; inspect metadata before choosing metadata, thumbnail, range-read, or full hydration.\n- Writes are tracked by the SolidFS journal and must be committed or rolled back by runtime.\n- Search/vector/index artifacts are internal; use search/parser tools rather than looking for index files.\n`;
}

export function buildWorkspaceSummaryPrompt(input: WorkspaceSummaryPromptInput): string {
  return [
    '## Current Workspace',
    '',
    `Root: ${input.root}`,
    `Authority: ${input.authority}`,
    `Files: ${input.files}`,
    `Text/by-line local files: ${input.bylineLocalFiles}`,
    `Remote placeholders: ${input.remotePlaceholders}`,
    `Hydrated remote objects: ${input.hydratedRemoteObjects}`,
    input.freeLocalCacheBytes === undefined ? undefined : `Free local cache bytes: ${input.freeLocalCacheBytes}`,
    input.maxHydrateBytesWithoutConfirmation === undefined ? undefined : `Max hydrate bytes without confirmation: ${input.maxHydrateBytesWithoutConfirmation}`,
    `Available tools: ${input.tools.join(', ')}`,
    '',
  ].filter((line): line is string => line !== undefined).join('\n');
}
```

- [ ] **Step 6: Export from `src/solidfs/index.ts`**

Add:

```ts
export * from './SolidFsMetaNotes';
export * from './WorkspacePrompt';
```

- [ ] **Step 7: Run tests and build**

Run:

```bash
bunx vitest --run tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
bun run build:ts --pretty false
```

Expected: pass.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/solidfs/SolidFsMetaNotes.ts src/solidfs/WorkspacePrompt.ts src/solidfs/index.ts tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
git commit -m "🧭 Describe SolidFS materialization for agents" -m "Add reusable .meta note and workspace prompt helpers so Agent runtime can reason about placeholders, parser coverage, and hydration cost without exposing index artifacts.

Constraint: .meta is visible resource description; index artifacts remain internal.
Rejected: Auto-hydrate large files on read | hides cost and can consume unbounded disk/network.
Confidence: high
Scope-risk: narrow
Tested: bunx vitest --run tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
Tested: bun run build:ts --pretty false"
```

---

### Task 7: Integration verification and documentation alignment

**Files:**
- Modify: `docs/solidfs-spec.md`
- Modify: `docs/rdf-engine-spec.md`
- Test: focused suites plus build

- [ ] **Step 1: Update `docs/solidfs-spec.md`**

Add a subsection under Sync Journal / Outbox:

```md
### Move projection entries

Folder/file move uses the existing SolidFS SyncJournal. P0 records expanded
`moved` entries with `previousPath` / `previousResource` and the new `path` /
`resource`; multi-file directory moves share one `tx_id`. P1 may add
`moved_prefix` as a compressed representation for very large directory moves,
but it must replay through the same journal lifecycle.

Move replay updates storage/object locators first, then projection syncers update
RDF/text/vector state. RDF URI projection refresh should call the RDF engine
`rewriteTerms(...)` capability where safe instead of reparsing unchanged content
or rewriting all quad rows.
```

- [ ] **Step 2: Update `docs/rdf-engine-spec.md`**

Add a subsection near the term dictionary / move projection discussion:

```md
### Term dictionary rewrite for SolidFS move

Because `rdf_quads` stores graph, subject, predicate and object as term ids,
SolidFS move projection should update distinct URI terms through the RDF engine
`rewriteTerms(...)` API when safe. This preserves standard URI semantics while
reducing write amplification from affected quads to affected URI terms. The API
must recompute term identity fields, invalidate caches, bump facts data version,
and skip unsafe user-authored absolute IRI terms unless provenance proves they
are Xpod-generated projection terms.
```

- [ ] **Step 3: Run focused verification**

Run:

```bash
bunx vitest --run tests/solidfs/SolidFsSyncJournal.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts
bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts -t "rewrites safe named-node URI terms in Postgres"
bun run build:ts --pretty false
```

Expected: all pass.

- [ ] **Step 4: Run required integration regression before final claim**

Run:

```bash
bun run test:integration
```

Expected: integration lite and full suites pass. Any failure must be triaged before completion is claimed; caused failures are fixed in this feature branch, unrelated pre-existing failures are recorded with exact test names and logs.

- [ ] **Step 5: Commit docs and final alignment**

```bash
git add docs/solidfs-spec.md docs/rdf-engine-spec.md
git commit -m "🧭 Document SolidFS move projection lifecycle" -m "Align SolidFS and RDF engine docs with the implemented move journal and term dictionary rewrite behavior.

Constraint: Move projection must remain recoverable through existing SolidFS journal semantics.
Confidence: high
Scope-risk: narrow
Tested: bun run test:integration
Tested: bun run build:ts --pretty false"
```

---

## Final verification checklist

Before marking implementation complete, run and record:

```bash
bunx vitest --run tests/solidfs/SolidFsSyncJournal.test.ts
bunx vitest --run tests/solidfs/RdfIndexSolidFsSyncer.test.ts
bunx vitest --run tests/solidfs/SolidFsMetaNotes.test.ts tests/solidfs/WorkspacePrompt.test.ts
bunx vitest --run tests/storage/rdf/RdfQuadIndex.test.ts
bunx vitest --run tests/storage/rdf/PostgresRdfEngine.test.ts
bun run build:ts --pretty false
bun run test:integration
```

Completion evidence must prove:

- `moved` changes persist and replay through existing SolidFS SyncJournal.
- No second journal is introduced.
- SQLite/file-backed RDF term rewrite works for safe named-node URI terms.
- PostgreSQL RDF term rewrite works for safe named-node URI terms.
- Move syncer uses term rewrite and does not reparse unchanged RDF content as a normal update.
- `.meta` note helpers emit visible metadata without storage secrets.
- Workspace prompt explains complete directory tree, by-line local files, placeholders, explicit hydration, journaled writes, and internal indexes.
- Required integration tests pass.
