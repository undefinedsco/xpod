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
- `xpod_rdf.execute_plan_json(text)`, a private legacy plan execution ABI for
  scope-safe SQL compiled by `PostgresRdfEngine`. It remains installed for ABI
  compatibility, but ordinary BGP joins and count / numeric aggregates no
  longer route through this wrapper.
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
- `xpod_rdf.perm_index_scan(regclass, bigint, bigint, bigint, bigint)`, a
  private leading-prefix scan for `xpod_rdf_perm`. It reads native index pages
  and compressed postings directly, returning heap TIDs plus permutation keys.
  `PostgresRdfEngine` only uses it for narrow exact-id single-pattern scans,
  then joins back to `rdf_quads` by `ctid` and rechecks all quad columns so heap
  visibility and stale-index safety remain PostgreSQL-owned.
- `xpod_rdf.perm_index_scan_any(regclass, bigint[], bigint[], bigint[], bigint[])`,
  a private leading-prefix array scan for `xpod_rdf_perm`. It deduplicates each
  contiguous prefix array, enumerates the prefix combinations, reuses the same
  native page scan as `perm_index_scan`, and lets `PostgresRdfEngine` route
  supported single-pattern `$in` term-id queries through custom index pages plus
  heap recheck.
- `xpod_rdf.perm_index_count(...)` and `xpod_rdf.perm_index_count_any(...)`,
  private leading-prefix count operators for `xpod_rdf_perm`. They reuse the
  native page scan, apply complete graph/subject/predicate/object id filters,
  and recheck PostgreSQL heap visibility before returning a scalar count.
  `PostgresRdfEngine` uses them only for non-DISTINCT single-pattern `COUNT`
  aggregates. Supported exact-id BGP grouped / numeric aggregate queries can
  use `bgp_join` as the input row stream, but the aggregate calculation itself
  remains outer PostgreSQL SQL.
- `xpod_rdf.subject_star_join(...)`, a conservative native subject-star join
  prototype. It seeds from one custom permutation index, probes the remaining
  constant-predicate edges through `PSO`, and rechecks heap visibility before
  returning term ids. `PostgresRdfEngine` only routes narrow subject-star shapes
  through it, then can apply outer SQL term/range filters, ordering,
  pagination, grouping, and numeric aggregation over that row stream. Native
  aggregate execution is still future work.
- `xpod_rdf.bgp_join(...)`, a conservative native exact-id required-BGP row
  stream for up to four patterns and eight variables. `PostgresRdfEngine` can
  apply outer SQL ordering, pagination, grouping, and numeric aggregation over
  that stream, but native index-level early stop and native aggregate execution
  are still future work.
- `xpod_rdf.values_join(...)`, a conservative native VALUES-constrained
  exact-id required-BGP row stream. It pre-binds one tuple VALUES source to the
  BGP variable slots before scanning custom indexes. Multi-source VALUES,
  ordering, pagination, grouping, and numeric aggregation still remain outer
  PostgreSQL SQL.
- `xpod_rdf.bgp_count(...)`, a narrow native count summary over the same
  exact-id required-BGP row stream. It supports non-grouped `COUNT` and
  single-variable `COUNT DISTINCT` without materializing every binding row back
  into outer SQL. Grouped and numeric aggregates remain outer PostgreSQL SQL.

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
product-grade hot operator set. Range/text filters, DISTINCT, broad joins, and
stable ordering/pagination still belong to the `PostgresRdfEngine` PG RDF-3X /
engine-sql path. `perm_index_probe` proves the extension can inspect
`xpod_rdf_perm` pages without routing through planner SQL. `perm_index_scan` is
the first direct custom-index query-row path; `perm_index_scan_any` extends that
foundation to `$in` prefix scans; `perm_index_count(_any)` is the first scalar
custom-index aggregate path; `subject_star_join` is the first narrow native join
prototype; `values_join` is the first narrow native VALUES+BGP path; `bgp_count`
is the first narrow non-subject-star BGP count summary path. They are still
selective foundations and not a general native join / aggregate executor.
