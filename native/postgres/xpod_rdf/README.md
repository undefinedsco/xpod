# xpod_rdf PostgreSQL Extension

`xpod_rdf` is the native PostgreSQL acceleration surface for Xpod RDF storage.
It is private to `PostgresRdfEngine`; applications should keep using the Pod /
SPARQL / models APIs.

The first native cut provides:

- `xpod_rdf.version()`
- `xpod_rdf.capabilities()`
- `xpod_rdf.scan_quads(...)` and `xpod_rdf.count_quads(...)`, the first
  native scan ABI for simple term-id and graph-prefix patterns.
  `PostgresRdfEngine` only uses this path for single-pattern exact / IN /
  graph-prefix scans without order, pagination, DISTINCT, or same-pattern
  variable equality constraints.
- `xpod_rdf_perm`, a custom index access method prototype that stores entries
  in the PostgreSQL index relation and supports build, insert, scan, bitmap
  scan, vacuum cleanup, planner path generation, ordered build, a metapage
  global-order guard, block-level lower-bound seeking, page-level min/max
  pruning, page-local lower-bound seeking on sorted pages, and prefix-aware
  planner cost estimates.
- `xpod_rdf.term_id_ops`, a bigint operator class for RDF term id columns. It
  also registers common PostgreSQL integer literal operators (`bigint`
  compared with `integer` / `smallint`) and decodes those scan keys back to
  int64 term ids.
- `xpod_rdf.perm_index_stats(regclass)`, an internal observability hook used
  by `PostgresRdfEngine.storageStats()` to report the custom index layout,
  sorted state, page tuple counts, item bytes, free bytes, and compression
  status.

Build inside an image with PostgreSQL server headers:

```bash
make PG_CONFIG=/path/to/pg_config
make install PG_CONFIG=/path/to/pg_config
```

Install in a database:

```sql
CREATE EXTENSION xpod_rdf;
```

The current custom index AM is intentionally a correctness and deployment
prototype. It proves native extension packaging, capability detection, custom
index DDL, ordered index-relation storage, metapage-backed block seeking, page
pruning, page-local bound-prefix seek, and delta-varint compressed posting
entries. Its reported layout is `compressed-posting-v1` with `compressed=true`:
ordered build groups duplicate full permutation keys into compressed TID
posting streams, while online insert still writes single tuple entries.
Planner smoke tests cover both bigint-typed parameters and plain integer
literals such as `subject_id = 42`; other non-bigint right-hand types remain
outside the current opfamily and should not be used for RDF term ids.

The current scan ABI is intentionally narrower than the final product-grade hot
operator set. Range/text filters, BGP joins, DISTINCT, stable
ordering/pagination, and aggregate operators still belong to the
`PostgresRdfEngine` PG RDF-3X / engine-sql path until they have native
correctness and benchmark gates.
