# xpod_rdf PostgreSQL Extension

`xpod_rdf` is the native PostgreSQL acceleration surface for Xpod RDF storage.
It is private to `PostgresRdfEngine`; applications should keep using the Pod /
SPARQL / models APIs.

The first native cut provides:

- `xpod_rdf.version()`
- `xpod_rdf.capabilities()`
- `xpod_rdf_perm`, a custom index access method prototype that stores entries
  in the PostgreSQL index relation and supports build, insert, scan, bitmap
  scan, vacuum cleanup, planner path generation, ordered build, and page-level
  min/max pruning with page-local lower-bound seeking on sorted pages.
- `xpod_rdf.term_id_ops`, a bigint operator class for RDF term id columns.

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
index DDL, ordered index-relation storage, page pruning, and page-local
bound-prefix seek before replacing tuple-level page scans with RDF-specific
postings blocks and compressed suffix/TID streams.
