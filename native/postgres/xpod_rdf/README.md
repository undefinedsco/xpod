# xpod_rdf PostgreSQL Extension

`xpod_rdf` is the native PostgreSQL acceleration surface for Xpod RDF storage.
It is private to `PostgresRdfEngine`; applications should keep using the Pod /
SPARQL / models APIs.

The first native cut provides:

- `xpod_rdf.version()`
- `xpod_rdf.capabilities()`
- `xpod_rdf_perm`, a custom index access method prototype that stores entries
  in the PostgreSQL index relation and supports build, insert, scan, bitmap
  scan, vacuum cleanup, planner path generation, ordered build, a metapage
  global-order guard, block-level lower-bound seeking, page-level min/max
  pruning, and page-local lower-bound seeking on sorted pages.
- `xpod_rdf.term_id_ops`, a bigint operator class for RDF term id columns.
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
pruning, and page-local bound-prefix seek before replacing tuple-level page
scans with RDF-specific postings blocks and compressed suffix/TID streams. Its
reported layout is `tuple-page-v1` with `compressed=false` until that postings
work lands.
