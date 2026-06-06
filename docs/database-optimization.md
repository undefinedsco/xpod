# Database Performance Optimization

## Recommended Indexes

For production deployments with PostgreSQL, it's highly recommended to create the following indexes to improve query performance:

```sql
-- Quadstore backend optimization
-- Quadstore uses a key-value storage model where RDF quads are encoded into keys.
-- The 'key' column stores encoded representations of (Graph, Subject, Predicate, Object) combinations.
-- A B-tree index on 'key' already exists (created automatically), but you may want to tune it:
-- Note: The default index on 'key' column in the quadstore table is usually sufficient.
-- For very large datasets, consider partitioning or using a BRIN index instead of B-tree.

-- Pod usage queries by account
CREATE INDEX IF NOT EXISTS idx_usage_account_id ON identity_usage (account_id);

-- Pod lookup by identity_store account/pod payload fields
CREATE INDEX IF NOT EXISTS idx_identity_store_pod_base_url
  ON identity_store (container, (jsonb_extract_path_text(payload, 'baseUrl')))
  WHERE container = 'pod';
CREATE INDEX IF NOT EXISTS idx_identity_store_pod_account_id
  ON identity_store (container, (jsonb_extract_path_text(payload, 'accountId')))
  WHERE container = 'pod';

-- Optional: If you experience slow LIKE queries on baseUrl, create a trigram index
-- Requires the pg_trgm extension
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_identity_store_pod_base_url_trgm
--   ON identity_store USING GIN ((jsonb_extract_path_text(payload, 'baseUrl')) gin_trgm_ops)
--   WHERE container = 'pod';
```

These indexes significantly improve:
- SPARQL query performance: Quadstore internally implements a "full index" approach by encoding quads into multiple sorted keys. The default `key` index is usually sufficient.
- Pod usage aggregation by account: Speeds up queries that sum storage/bandwidth by account.
- Resource identifier to Pod/Account mapping: GIN indexes on JSONB fields enable fast lookups.
- Edge node routing performance: Direct index on `base_url` for fast prefix matching.

## Quadstore Index Architecture

Quadstore uses a key-value storage model where:
- Each RDF quad (Graph, Subject, Predicate, Object) is encoded into multiple keys with different orderings
- The `quadstore` table has a simple schema: `(id, key, value)`
- The `key` column stores binary-encoded representations that naturally support different access patterns
- A single B-tree index on `key` enables efficient range scans for all SPARQL query patterns

This design is more efficient than traditional RDBMS approaches with separate GSPO, GPOS, etc. tables.
