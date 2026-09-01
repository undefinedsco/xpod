#ifndef XPOD_QLEVER_ADAPTER_H
#define XPOD_QLEVER_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

#include "xpod_rdf_physical_backend.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct xpod_qlever_adapter xpod_qlever_adapter;

typedef xpod_rdf_status (*xpod_qlever_backend_provider_create_fn)(
    const xpod_rdf_bytes* config_json,
    xpod_rdf_backend_v1** out_backend);

typedef void (*xpod_qlever_backend_provider_destroy_fn)(
    xpod_rdf_backend_v1* backend);

typedef struct xpod_qlever_backend_provider_config {
  xpod_rdf_bytes library_path;
  xpod_rdf_bytes create_symbol;
  xpod_rdf_bytes destroy_symbol;
  xpod_rdf_bytes config_json;
} xpod_qlever_backend_provider_config;

typedef enum xpod_qlever_execution_policy {
  XPOD_QLEVER_EXECUTION_NATIVE_ONLY = 0,
  XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED = 1
} xpod_qlever_execution_policy;

typedef struct xpod_qlever_adapter_config {
  xpod_rdf_backend_v1* backend;
  const xpod_qlever_backend_provider_config* backend_provider;
  uint64_t memory_limit_bytes;
  uint8_t enable_runtime_profile;
  xpod_qlever_execution_policy execution_policy;
} xpod_qlever_adapter_config;

typedef struct xpod_qlever_vector_query {
  const double* vector;
  size_t dimensions;
  xpod_rdf_bytes provider;
  xpod_rdf_bytes model;
  xpod_rdf_bytes model_version;
  xpod_rdf_bytes input_kind;
  xpod_rdf_bytes projection_policy_version;
  xpod_rdf_vector_metric metric;
  uint64_t limit;
  double threshold;
  uint8_t has_threshold;
  xpod_rdf_bytes retrieval_point_variable;
  xpod_rdf_bytes resource_variable;
} xpod_qlever_vector_query;

typedef enum xpod_qlever_request_operation {
  XPOD_QLEVER_REQUEST_EXECUTE = 0,
  XPOD_QLEVER_REQUEST_PREPARE_UPDATE = 1,
  XPOD_QLEVER_REQUEST_QUERY_ONLY = 2
} xpod_qlever_request_operation;

typedef enum xpod_qlever_default_dataset {
  XPOD_QLEVER_DEFAULT_DATASET_PHYSICAL = 0,
  XPOD_QLEVER_DEFAULT_DATASET_EXACT_SOURCE = 1,
  XPOD_QLEVER_DEFAULT_DATASET_SCOPED_UNION = 2
} xpod_qlever_default_dataset;

typedef struct xpod_qlever_query_request {
  xpod_rdf_bytes sparql;
  xpod_rdf_snapshot snapshot;
  const xpod_rdf_cancellation* cancellation;
  xpod_rdf_graph_scope graph_scope;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
  xpod_rdf_bytes accept_media_type;
  const xpod_qlever_vector_query* vector_query;
  xpod_qlever_request_operation operation;
  xpod_qlever_default_dataset default_dataset;
  uint8_t has_load_document;
  xpod_rdf_bytes load_document_source_uri;
  xpod_rdf_bytes load_document_body;
  xpod_rdf_bytes load_document_media_type;
} xpod_qlever_query_request;

typedef struct xpod_qlever_query_result {
  xpod_rdf_status status;
  xpod_rdf_bytes result_json;
  xpod_rdf_bytes result_media_type;
  xpod_rdf_bytes profile_json;
  xpod_rdf_bytes error_message;
} xpod_qlever_query_result;

uint32_t xpod_qlever_adapter_abi_version(void);

xpod_rdf_status xpod_qlever_adapter_inline_term_bits(
    const xpod_rdf_term* term,
    uint64_t* out_bits,
    uint8_t* out_is_inline);

xpod_rdf_status xpod_qlever_adapter_create(
    const xpod_qlever_adapter_config* config,
    xpod_qlever_adapter** out_adapter);

void xpod_qlever_adapter_destroy(xpod_qlever_adapter* adapter);

xpod_rdf_status xpod_qlever_adapter_query_request(
    xpod_qlever_adapter* adapter,
    const xpod_qlever_query_request* request,
    xpod_qlever_query_result* out_result);

xpod_rdf_status xpod_qlever_adapter_query(
    xpod_qlever_adapter* adapter,
    xpod_rdf_bytes sparql,
    xpod_qlever_query_result* out_result);

xpod_rdf_status xpod_qlever_adapter_lookup_terms(
    xpod_qlever_adapter* adapter,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses);

xpod_rdf_status xpod_qlever_adapter_resolve_source_scope(
    xpod_qlever_adapter* adapter,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_resolved_source_scope* out_scope);

void xpod_qlever_adapter_release_result(
    xpod_qlever_adapter* adapter,
    xpod_qlever_query_result* result);

#ifdef __cplusplus
}
#endif

#endif
