# Local RDF index persistence and startup recovery

## Evidence

The real Web login reaches the Cloud WebID and the correct managed Local Pod.
DPoP succeeds, but the Settings SPARQL request receives 403. Debug logging shows
the authorization target is the canonical managed URL, not the transport alias.
The ACR and its metadata are present in the durable SQLite `quints` table, yet
`ManagedAcpRepository` cannot read them through `SolidRdfDataAccessor`.

The CLI default term-id index is under `.xpod/runtime/legacy-css`, outside the
configured SQLite data volume. Recreating the container removes that index.
The primary accessor does not initialize the compatibility migration bridge,
so existing ACR data is not recovered before permission checks. This is a
storage lifecycle bug, not an expired refresh token or a missing profile link.

## Repair plan

1. Derive the default Local/Standalone index path from the configured durable
   SQLite location; explicit index configuration continues to win. Keep
   embedded runtime isolation and Cloud PostgreSQL behavior unchanged.
2. Reuse the existing shadow backfill implementation before Local primary
   reads. Automatic backfill may populate a pristine index only; it must not
   clear a populated primary index or resurrect data after an intentional
   deletion. Explicit administrative backfill remains explicit.
3. Lock the behavior with restart, legacy ACR read, non-empty index preservation,
   intentional-empty preservation, and concurrent initialization regressions.
4. Rebuild one immutable service image for all three modes, retain volumes, then
   verify the actual Web-created key and Chat path. Do not modify Pod ACLs to
   make the test pass. QLever stays disabled.

## Implementation and verification

- `resolveDefaultRdfIndexPath` in `src/runtime/database-url.ts` derives the
  index directory from the configured RDF SQLite endpoint. CLI, direct CSS,
  and embedded bootstrap reuse it; non-SQLite and explicit-path behavior is
  unchanged.
- Local primary initialization awaits the existing `ShadowRdfQuintStore`.
  A namespaced migration marker records pending/completed state; automatic
  copying is idempotent, never clears primary data, and skips an already-written
  index. Concurrent initialization cannot read a partially restored index.
- Regression evidence: 67 auth/storage tests, 107 RDF engine/index/accessor
  tests, and 42 runtime-path tests passed. TypeScript, Components.js metadata,
  UI build/type/lint and the full integration suite passed before the final
  path change; the full suite is rerun for the combined result.
- Real Web and same-image three-mode results must be recorded separately after
  installing the combined build. These test results alone are not release or
  real Web acceptance evidence.
