\echo Use "CREATE EXTENSION xpod_rdf" to load this file. \quit

CREATE SCHEMA IF NOT EXISTS xpod_rdf;

CREATE FUNCTION xpod_rdf.version()
RETURNS text
AS 'MODULE_PATHNAME', 'xpod_rdf_version'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION xpod_rdf.capabilities()
RETURNS text
AS 'MODULE_PATHNAME', 'xpod_rdf_capabilities'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION xpod_rdf.term_id_cmp(bigint, bigint)
RETURNS integer
AS 'MODULE_PATHNAME', 'xpod_rdf_term_id_cmp'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE FUNCTION xpod_rdf.perm_handler(internal)
RETURNS index_am_handler
AS 'MODULE_PATHNAME', 'xpod_rdf_perm_handler'
LANGUAGE C STRICT;

CREATE ACCESS METHOD xpod_rdf_perm
TYPE INDEX
HANDLER xpod_rdf.perm_handler;

CREATE OPERATOR FAMILY xpod_rdf.term_id_family
USING xpod_rdf_perm;

CREATE OPERATOR CLASS xpod_rdf.term_id_ops
DEFAULT FOR TYPE bigint
USING xpod_rdf_perm
FAMILY xpod_rdf.term_id_family AS
  OPERATOR 1 < (bigint, bigint),
  OPERATOR 2 <= (bigint, bigint),
  OPERATOR 3 = (bigint, bigint),
  OPERATOR 4 >= (bigint, bigint),
  OPERATOR 5 > (bigint, bigint),
  FUNCTION 1 xpod_rdf.term_id_cmp(bigint, bigint);

CREATE FUNCTION xpod_rdf.result_cache_probe(
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

CREATE FUNCTION xpod_rdf.result_cache_store(
  p_cache_key text,
  p_facts_data_version bigint,
  p_query_shape text,
  p_scope_hash text,
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
    scope_hash,
    result_json,
    row_count,
    created_at
  )
  VALUES (p_cache_key, p_facts_data_version, p_query_shape, p_scope_hash, p_result_json, p_row_count, NOW())
  ON CONFLICT (cache_key, facts_data_version) DO UPDATE
  SET query_shape = EXCLUDED.query_shape,
      scope_hash = EXCLUDED.scope_hash,
      result_json = EXCLUDED.result_json,
      row_count = EXCLUDED.row_count,
      created_at = NOW()
$fn$;
