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
CREATE INDEX IF NOT EXISTS idx_pod_usage_account_id ON identity_pod_usage (account_id);

-- Pod lookup by baseUrl (JSONB index)
-- These GIN indexes significantly speed up JSON field queries used for resource-to-pod mapping
CREATE INDEX IF NOT EXISTS idx_pod_base_url ON identity_pod USING GIN ((payload->'baseUrl'));
CREATE INDEX IF NOT EXISTS idx_pod_account_id ON identity_pod USING GIN ((payload->'accountId'));

-- Edge node pod lookup
CREATE INDEX IF NOT EXISTS idx_edge_node_pod_base_url ON identity_edge_node_pod (base_url);

-- Optional: If you experience slow LIKE queries on baseUrl, create a trigram index
-- Requires the pg_trgm extension
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_pod_base_url_trgm ON identity_pod USING GIN ((payload->>'baseUrl') gin_trgm_ops);
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
