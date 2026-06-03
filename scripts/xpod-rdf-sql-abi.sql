-- H0 SQL ABI for PostgresRdfEngine acceleration.
--
-- This is intentionally a schema-local compatibility ABI, not the native
-- xpod_rdf extension. It lets self-hosted or managed PostgreSQL deployments
-- expose the cache.result operator without installing a C/Rust extension.
-- Run after the PostgresRdfEngine schema has created rdf_query_result_cache.

CREATE SCHEMA IF NOT EXISTS xpod_rdf;

CREATE OR REPLACE FUNCTION xpod_rdf.version()
RETURNS text
LANGUAGE SQL
AS $fn$
  SELECT '0.1.0-sql'::text
$fn$;

CREATE OR REPLACE FUNCTION xpod_rdf.capabilities()
RETURNS text
LANGUAGE SQL
AS $fn$
  SELECT 'cache.result'::text
$fn$;

CREATE OR REPLACE FUNCTION xpod_rdf.result_cache_probe(
  p_cache_key text,
  p_facts_data_version bigint
)
RETURNS TABLE(result_json text, row_count bigint)
LANGUAGE SQL
AS $fn$
  SELECT cache.result_json, cache.row_count
  FROM rdf_query_result_cache cache
  WHERE cache.cache_key = p_cache_key
    AND cache.facts_data_version = p_facts_data_version
$fn$;

CREATE OR REPLACE FUNCTION xpod_rdf.result_cache_store(
  p_cache_key text,
  p_facts_data_version bigint,
  p_query_shape text,
  p_result_json text,
  p_row_count bigint
)
RETURNS void
LANGUAGE SQL
AS $fn$
  INSERT INTO rdf_query_result_cache (
    cache_key,
    facts_data_version,
    query_shape,
    result_json,
    row_count,
    created_at
  )
  VALUES (p_cache_key, p_facts_data_version, p_query_shape, p_result_json, p_row_count, NOW())
  ON CONFLICT (cache_key, facts_data_version) DO UPDATE
  SET query_shape = EXCLUDED.query_shape,
      result_json = EXCLUDED.result_json,
      row_count = EXCLUDED.row_count,
      created_at = NOW()
$fn$;
