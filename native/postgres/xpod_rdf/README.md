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
- `xpod_rdf.execute_plan_json(text)`, a private plan execution ABI for
  scope-safe SQL compiled by `PostgresRdfEngine`. It is currently the native
  extension entry point for required BGP joins and count / numeric aggregates;
  the implementation still executes compiled PostgreSQL SQL and is a stable
  boundary for later custom join / aggregate algorithms.
- `xpod_rdf_perm`, a custom index access method prototype that stores entries
  in the PostgreSQL index relation and supports build, insert, scan, bitmap
  scan, vacuum cleanup, planner path generation, ordered build, a metapage
  global-order guard, block-level lower-bound seeking, page-level min/max
  pruning, page-local lower-bound seeking on sorted pages, metapage-backed
  prefix distinct / fanout stats, and prefix-stats-aware planner cost
  estimates.
- `xpod_rdf.term_id_ops`, a bigint operator class for RDF term id columns. It
  also registers common PostgreSQL integer literal operators (`bigint`
  compared with `integer` / `smallint`) and decodes those scan keys back to
  int64 term ids.
- `xpod_rdf.perm_index_stats(regclass)`, an internal observability hook used
  by `PostgresRdfEngine.storageStats()` to report the custom index layout,
  sorted state, page tuple counts, item bytes, free bytes, and compression
  status. Schema version 2 also reports exact prefix stats when the index was
  built or appended in sorted order.
- `xpod_rdf.perm_index_probe(regclass, bigint, bigint, bigint, bigint)`, a
  private prefix-equality probe for `xpod_rdf_perm`. It reads the native index
  relation directly and reports block seek, page skip, page visit, entry match,
  and posting counts. The probe is an observability and next-step hot-operator
  building block; it does not return user query rows and therefore does not
  bypass PostgreSQL heap visibility checks.

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
The version 2 metapage stores distinct counts for the leading 1..4 key
prefixes. Cost estimation uses those exact counts while the index remains
globally sorted; out-of-order appends clear the exact-prefix flag and fall back
to conservative costs. Planner smoke tests cover both bigint-typed parameters
and plain integer literals such as `subject_id = 42`; other non-bigint
right-hand types remain outside the current opfamily and should not be used for
RDF term ids.

The current extension ABI is intentionally narrower than the final
product-grade hot operator set. Range/text filters, DISTINCT, and stable
ordering/pagination still belong to the `PostgresRdfEngine` PG RDF-3X /
engine-sql path. Required BGP joins and aggregate operators now enter the
extension through `execute_plan_json`, but this is not yet a custom C join /
aggregate executor and must not be counted as a final native performance gate.
`perm_index_probe` proves the extension can now inspect `xpod_rdf_perm` pages
without routing through planner SQL, but it is still an internal probe rather
than the final MVCC-safe scan / join / aggregate executor.
