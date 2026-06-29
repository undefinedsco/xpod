#ifndef XPOD_QLEVER_ADAPTER_H
#define XPOD_QLEVER_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

#include "xpod_rdf_physical_backend.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct xpod_qlever_adapter xpod_qlever_adapter;

typedef struct xpod_qlever_adapter_config {
  xpod_rdf_backend_v1* backend;
  uint64_t memory_limit_bytes;
  uint8_t enable_runtime_profile;
} xpod_qlever_adapter_config;

typedef struct xpod_qlever_query_request {
  xpod_rdf_bytes sparql;
  xpod_rdf_snapshot snapshot;
  const xpod_rdf_cancellation* cancellation;
  xpod_rdf_graph_scope graph_scope;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
} xpod_qlever_query_request;

typedef struct xpod_qlever_query_result {
  xpod_rdf_status status;
  xpod_rdf_bytes result_json;
  xpod_rdf_bytes profile_json;
  xpod_rdf_bytes error_message;
} xpod_qlever_query_result;

uint32_t xpod_qlever_adapter_abi_version(void);

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

void xpod_qlever_adapter_release_result(
    xpod_qlever_adapter* adapter,
    xpod_qlever_query_result* result);

#ifdef __cplusplus
}
#endif

#endif
