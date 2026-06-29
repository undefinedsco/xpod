#ifndef XPOD_RDF_PHYSICAL_BACKEND_H
#define XPOD_RDF_PHYSICAL_BACKEND_H

#include <stddef.h>
#include <stdint.h>

#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 1
#define XPOD_RDF_PHYSICAL_BACKEND_VERSION_MAJOR 0
#define XPOD_RDF_PHYSICAL_BACKEND_VERSION_MINOR 3
#define XPOD_RDF_PHYSICAL_BACKEND_VERSION_PATCH 0

#ifdef __cplusplus
extern "C" {
#endif

typedef uint64_t xpod_rdf_term_key;
typedef uint64_t xpod_rdf_source_node_key;
typedef uint64_t xpod_rdf_retrieval_point_key;
typedef uint64_t xpod_rdf_profile_node_key;

typedef enum xpod_rdf_term_key_encoding {
  XPOD_RDF_TERM_KEY_ENCODING_OPAQUE = 0,
  XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS = 1
} xpod_rdf_term_key_encoding;

typedef struct xpod_rdf_bytes {
  const char* data;
  size_t size;
} xpod_rdf_bytes;

typedef enum xpod_rdf_status {
  XPOD_RDF_STATUS_OK = 0,
  XPOD_RDF_STATUS_NOT_FOUND = 1,
  XPOD_RDF_STATUS_UNSUPPORTED = 2,
  XPOD_RDF_STATUS_CANCELLED = 3,
  XPOD_RDF_STATUS_PERMISSION_DENIED = 4,
  XPOD_RDF_STATUS_STALE_STATS = 5,
  XPOD_RDF_STATUS_BACKEND_ERROR = 100
} xpod_rdf_status;

typedef enum xpod_rdf_term_kind {
  XPOD_RDF_TERM_IRI = 1,
  XPOD_RDF_TERM_BLANK = 2,
  XPOD_RDF_TERM_LITERAL = 3
} xpod_rdf_term_kind;

typedef struct xpod_rdf_term {
  xpod_rdf_term_kind kind;
  xpod_rdf_bytes value;
  xpod_rdf_bytes datatype_iri;
  xpod_rdf_bytes language;
} xpod_rdf_term;

typedef struct xpod_rdf_snapshot {
  xpod_rdf_bytes facts_version;
  xpod_rdf_bytes stats_version;
  xpod_rdf_bytes snapshot_token;
} xpod_rdf_snapshot;

typedef struct xpod_rdf_quad_key {
  xpod_rdf_term_key subject;
  xpod_rdf_term_key predicate;
  xpod_rdf_term_key object;
  xpod_rdf_term_key graph;
} xpod_rdf_quad_key;

typedef enum xpod_rdf_slot {
  XPOD_RDF_SLOT_SUBJECT = 1u << 0,
  XPOD_RDF_SLOT_PREDICATE = 1u << 1,
  XPOD_RDF_SLOT_OBJECT = 1u << 2,
  XPOD_RDF_SLOT_GRAPH = 1u << 3
} xpod_rdf_slot;

typedef enum xpod_rdf_permutation {
  XPOD_RDF_PERM_SPOG = 1,
  XPOD_RDF_PERM_SOPG = 2,
  XPOD_RDF_PERM_PSOG = 3,
  XPOD_RDF_PERM_POSG = 4,
  XPOD_RDF_PERM_OSPG = 5,
  XPOD_RDF_PERM_OPSG = 6,
  XPOD_RDF_PERM_GSPO = 7,
  XPOD_RDF_PERM_GPOS = 8
} xpod_rdf_permutation;

typedef struct xpod_rdf_quad_pattern {
  uint8_t has_subject;
  uint8_t has_predicate;
  uint8_t has_object;
  uint8_t has_graph;
  xpod_rdf_term_key subject;
  xpod_rdf_term_key predicate;
  xpod_rdf_term_key object;
  xpod_rdf_term_key graph;
} xpod_rdf_quad_pattern;

typedef enum xpod_rdf_graph_scope_kind {
  XPOD_RDF_GRAPH_SCOPE_ALL = 0,
  XPOD_RDF_GRAPH_SCOPE_EXACT = 1,
  XPOD_RDF_GRAPH_SCOPE_PREFIX = 2,
  XPOD_RDF_GRAPH_SCOPE_SET = 3
} xpod_rdf_graph_scope_kind;

typedef struct xpod_rdf_graph_scope {
  xpod_rdf_graph_scope_kind kind;
  xpod_rdf_term_key exact_graph;
  xpod_rdf_bytes iri_prefix;
  const xpod_rdf_term_key* graph_set;
  size_t graph_set_size;
} xpod_rdf_graph_scope;

typedef enum xpod_rdf_access_mode {
  XPOD_RDF_ACCESS_READ = 1,
  XPOD_RDF_ACCESS_WRITE = 2,
  XPOD_RDF_ACCESS_APPEND = 3,
  XPOD_RDF_ACCESS_CONTROL = 4
} xpod_rdf_access_mode;

typedef enum xpod_rdf_authorization_model {
  XPOD_RDF_AUTH_WAC = 1,
  XPOD_RDF_AUTH_ACP = 2,
  XPOD_RDF_AUTH_MIXED = 3
} xpod_rdf_authorization_model;

typedef struct xpod_rdf_access_scope {
  xpod_rdf_bytes principal;
  xpod_rdf_access_mode mode;
  xpod_rdf_authorization_model authorization_model;
  const xpod_rdf_term_key* allowed_graphs;
  size_t allowed_graphs_size;
  const xpod_rdf_term_key* denied_graphs;
  size_t denied_graphs_size;
  const xpod_rdf_bytes* allowed_graph_prefixes;
  size_t allowed_graph_prefixes_size;
  const xpod_rdf_bytes* denied_graph_prefixes;
  size_t denied_graph_prefixes_size;
  const xpod_rdf_source_node_key* allowed_sources;
  size_t allowed_sources_size;
  const xpod_rdf_source_node_key* denied_sources;
  size_t denied_sources_size;
  xpod_rdf_bytes permission_version;
} xpod_rdf_access_scope;

typedef struct xpod_rdf_source_scope {
  xpod_rdf_bytes workspace;
  xpod_rdf_source_node_key source_node;
  uint8_t has_source_node;
  xpod_rdf_bytes source_uri;
  xpod_rdf_bytes source_uri_prefix;
  xpod_rdf_bytes local_path;
  xpod_rdf_bytes local_path_prefix;
  uint8_t include_folders;
  uint8_t include_files;
} xpod_rdf_source_scope;

typedef enum xpod_rdf_scan_order_kind {
  XPOD_RDF_SCAN_ORDER_NATIVE = 0,
  XPOD_RDF_SCAN_ORDER_ASC = 1,
  XPOD_RDF_SCAN_ORDER_DESC = 2
} xpod_rdf_scan_order_kind;

typedef struct xpod_rdf_scan_order {
  uint32_t slots;
  xpod_rdf_scan_order_kind kind;
} xpod_rdf_scan_order;

typedef struct xpod_rdf_scan_request {
  xpod_rdf_snapshot snapshot;
  xpod_rdf_permutation permutation;
  xpod_rdf_quad_pattern pattern;
  xpod_rdf_graph_scope graph_scope;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
  xpod_rdf_scan_order order;
  uint64_t limit;
  uint64_t offset;
  uint32_t batch_size;
  uint32_t needed_slots;
} xpod_rdf_scan_request;

typedef struct xpod_rdf_quad_batch {
  const xpod_rdf_quad_key* rows;
  size_t row_count;
  uint32_t sorted_slots;
  uint64_t scanned_rows;
} xpod_rdf_quad_batch;

typedef xpod_rdf_status (*xpod_rdf_quad_batch_callback)(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch);

typedef enum xpod_rdf_estimate_confidence {
  XPOD_RDF_ESTIMATE_EXACT = 1,
  XPOD_RDF_ESTIMATE_FRESH = 2,
  XPOD_RDF_ESTIMATE_STALE = 3,
  XPOD_RDF_ESTIMATE_HEURISTIC = 4
} xpod_rdf_estimate_confidence;

typedef struct xpod_rdf_estimate {
  uint64_t rows;
  uint64_t distinct_subjects;
  uint64_t distinct_predicates;
  uint64_t distinct_objects;
  uint64_t distinct_graphs;
  double selectivity;
  double cpu_cost;
  double io_cost;
  double memory_cost;
  double startup_cost;
  xpod_rdf_estimate_confidence confidence;
  xpod_rdf_bytes stats_version;
  xpod_rdf_bytes reason;
} xpod_rdf_estimate;

typedef struct xpod_rdf_count_result {
  uint64_t count;
  xpod_rdf_estimate_confidence confidence;
} xpod_rdf_count_result;

typedef struct xpod_rdf_distinct_request {
  xpod_rdf_scan_request scan;
  uint32_t distinct_slots;
} xpod_rdf_distinct_request;

typedef struct xpod_rdf_term_tuple_batch {
  const xpod_rdf_term_key* terms;
  size_t row_count;
  uint32_t tuple_width;
} xpod_rdf_term_tuple_batch;

typedef xpod_rdf_status (*xpod_rdf_term_tuple_batch_callback)(
    void* callback_user_data,
    const xpod_rdf_term_tuple_batch* batch);

typedef struct xpod_rdf_join_fanout_request {
  xpod_rdf_snapshot snapshot;
  const xpod_rdf_quad_pattern* patterns;
  size_t pattern_count;
  uint32_t bound_slots;
  const xpod_rdf_access_scope* access_scope;
} xpod_rdf_join_fanout_request;

typedef struct xpod_rdf_text_search_request {
  xpod_rdf_snapshot snapshot;
  xpod_rdf_bytes query;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
  uint64_t limit;
  uint64_t offset;
  const xpod_rdf_term_key* required_entities;
  size_t required_entities_size;
} xpod_rdf_text_search_request;

typedef enum xpod_rdf_vector_metric {
  XPOD_RDF_VECTOR_COSINE = 1,
  XPOD_RDF_VECTOR_DOT = 2,
  XPOD_RDF_VECTOR_EUCLIDEAN = 3
} xpod_rdf_vector_metric;

typedef struct xpod_rdf_vector_search_request {
  xpod_rdf_snapshot snapshot;
  const double* vector;
  size_t dimensions;
  xpod_rdf_bytes model;
  xpod_rdf_vector_metric metric;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
  uint64_t limit;
  double threshold;
  uint8_t has_threshold;
} xpod_rdf_vector_search_request;

typedef struct xpod_rdf_source_range {
  uint64_t start_line;
  uint64_t end_line;
  uint64_t start_offset;
  uint64_t end_offset;
} xpod_rdf_source_range;

typedef struct xpod_rdf_candidate {
  xpod_rdf_source_node_key source_node;
  uint8_t has_source_node;
  xpod_rdf_retrieval_point_key retrieval_point;
  uint8_t has_retrieval_point;
  xpod_rdf_term_key resource_term;
  uint8_t has_resource_term;
  double score;
  xpod_rdf_source_range range;
  xpod_rdf_bytes scorer;
} xpod_rdf_candidate;

typedef struct xpod_rdf_candidate_batch {
  const xpod_rdf_candidate* rows;
  size_t row_count;
  uint64_t scanned_rows;
  xpod_rdf_bytes scorer;
} xpod_rdf_candidate_batch;

typedef xpod_rdf_status (*xpod_rdf_candidate_batch_callback)(
    void* callback_user_data,
    const xpod_rdf_candidate_batch* batch);

typedef enum xpod_rdf_profile_kind {
  XPOD_RDF_PROFILE_TERM_LOOKUP = 1,
  XPOD_RDF_PROFILE_PERMUTATION_SCAN = 2,
  XPOD_RDF_PROFILE_RDF_JOIN = 3,
  XPOD_RDF_PROFILE_TEXT_SEARCH = 4,
  XPOD_RDF_PROFILE_VECTOR_SEARCH = 5,
  XPOD_RDF_PROFILE_PATH_SCOPE = 6,
  XPOD_RDF_PROFILE_ACCESS_SCOPE = 7,
  XPOD_RDF_PROFILE_FUSION_RANK = 8,
  XPOD_RDF_PROFILE_SORT = 9,
  XPOD_RDF_PROFILE_TOP_K = 10,
  XPOD_RDF_PROFILE_MATERIALIZED_RESULT = 11,
  XPOD_RDF_PROFILE_CACHE = 12
} xpod_rdf_profile_kind;

typedef enum xpod_rdf_profile_status {
  XPOD_RDF_PROFILE_NOT_STARTED = 0,
  XPOD_RDF_PROFILE_RUNNING = 1,
  XPOD_RDF_PROFILE_COMPLETED = 2,
  XPOD_RDF_PROFILE_OPTIMIZED_OUT = 3,
  XPOD_RDF_PROFILE_FAILED = 4,
  XPOD_RDF_PROFILE_CANCELLED = 5
} xpod_rdf_profile_status;

typedef enum xpod_rdf_cache_status {
  XPOD_RDF_CACHE_DISABLED = 0,
  XPOD_RDF_CACHE_MISS = 1,
  XPOD_RDF_CACHE_HIT = 2,
  XPOD_RDF_CACHE_STORE = 3,
  XPOD_RDF_CACHE_BYPASS = 4
} xpod_rdf_cache_status;

typedef struct xpod_rdf_profile_event {
  xpod_rdf_profile_node_key node;
  xpod_rdf_profile_node_key parent;
  uint8_t has_parent;
  xpod_rdf_profile_kind kind;
  xpod_rdf_profile_status status;
  xpod_rdf_bytes descriptor;
  xpod_rdf_estimate estimate;
  uint64_t input_rows;
  uint64_t output_rows;
  uint64_t scanned_rows;
  uint64_t returned_rows;
  uint64_t batches;
  uint64_t duration_us;
  uint64_t operation_us;
  xpod_rdf_cache_status cache_status;
  xpod_rdf_bytes backend;
  xpod_rdf_bytes index_used;
  xpod_rdf_bytes details_json;
} xpod_rdf_profile_event;

typedef void (*xpod_rdf_profile_event_callback)(
    void* callback_user_data,
    const xpod_rdf_profile_event* event);

typedef xpod_rdf_status (*xpod_rdf_lookup_term_fn)(
    void* backend_user_data,
    const xpod_rdf_term* term,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_key);

typedef xpod_rdf_status (*xpod_rdf_resolve_term_fn)(
    void* backend_user_data,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_term);

typedef xpod_rdf_status (*xpod_rdf_lookup_terms_fn)(
    void* backend_user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses);

typedef xpod_rdf_status (*xpod_rdf_resolve_terms_fn)(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses);

typedef xpod_rdf_status (*xpod_rdf_scan_permutation_fn)(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data);

typedef xpod_rdf_status (*xpod_rdf_count_scan_fn)(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result);

typedef xpod_rdf_status (*xpod_rdf_distinct_scan_fn)(
    void* backend_user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_term_tuple_batch_callback on_batch,
    void* callback_user_data);

typedef xpod_rdf_status (*xpod_rdf_estimate_scan_fn)(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate);

typedef xpod_rdf_status (*xpod_rdf_estimate_join_fanout_fn)(
    void* backend_user_data,
    const xpod_rdf_join_fanout_request* request,
    xpod_rdf_estimate* out_estimate);

typedef xpod_rdf_status (*xpod_rdf_text_search_fn)(
    void* backend_user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data);

typedef xpod_rdf_status (*xpod_rdf_estimate_text_search_fn)(
    void* backend_user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate);

typedef xpod_rdf_status (*xpod_rdf_vector_search_fn)(
    void* backend_user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data);

typedef xpod_rdf_status (*xpod_rdf_estimate_vector_search_fn)(
    void* backend_user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate);

typedef xpod_rdf_status (*xpod_rdf_resolve_access_scope_fn)(
    void* backend_user_data,
    const xpod_rdf_bytes* principal,
    xpod_rdf_access_mode mode,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_access_scope* out_scope);

typedef xpod_rdf_status (*xpod_rdf_estimate_access_scope_fn)(
    void* backend_user_data,
    const xpod_rdf_access_scope* access_scope,
    const xpod_rdf_source_scope* source_scope,
    xpod_rdf_estimate* out_estimate);

typedef xpod_rdf_status (*xpod_rdf_encode_qlever_id_fn)(
    void* backend_user_data,
    xpod_rdf_term_key term,
    uint64_t* out_qlever_id_bits);

typedef xpod_rdf_status (*xpod_rdf_decode_qlever_id_fn)(
    void* backend_user_data,
    uint64_t qlever_id_bits,
    xpod_rdf_term_key* out_term);

typedef struct xpod_rdf_backend_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  void* backend_user_data;
  xpod_rdf_profile_event_callback on_profile_event;
  void* profile_user_data;
  xpod_rdf_lookup_term_fn lookup_term;
  xpod_rdf_resolve_term_fn resolve_term;
  xpod_rdf_scan_permutation_fn scan_permutation;
  xpod_rdf_count_scan_fn count_scan;
  xpod_rdf_distinct_scan_fn distinct_scan;
  xpod_rdf_estimate_scan_fn estimate_scan;
  xpod_rdf_estimate_join_fanout_fn estimate_join_fanout;
  xpod_rdf_text_search_fn text_search;
  xpod_rdf_estimate_text_search_fn estimate_text_search;
  xpod_rdf_vector_search_fn vector_search;
  xpod_rdf_estimate_vector_search_fn estimate_vector_search;
  xpod_rdf_resolve_access_scope_fn resolve_access_scope;
  xpod_rdf_estimate_access_scope_fn estimate_access_scope;
  xpod_rdf_term_key_encoding term_key_encoding;
  xpod_rdf_encode_qlever_id_fn encode_qlever_id;
  xpod_rdf_decode_qlever_id_fn decode_qlever_id;
  xpod_rdf_lookup_terms_fn lookup_terms;
  xpod_rdf_resolve_terms_fn resolve_terms;
} xpod_rdf_backend_v1;

#ifdef __cplusplus
}
#endif

#endif
