#ifndef XPOD_RDF_SQLITE_BACKEND_H
#define XPOD_RDF_SQLITE_BACKEND_H

#include <stddef.h>
#include <stdint.h>

#include "xpod_rdf_physical_backend.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct xpod_rdf_sqlite_backend_config {
  xpod_rdf_bytes database_path;
  uint8_t read_only;
  uint8_t require_text_search;
  uint8_t require_vector_search;
} xpod_rdf_sqlite_backend_config;

xpod_rdf_status xpod_rdf_sqlite_backend_create(
    const xpod_rdf_sqlite_backend_config* config,
    xpod_rdf_backend_v1** out_backend);

void xpod_rdf_sqlite_backend_destroy(xpod_rdf_backend_v1* backend);

xpod_rdf_status xpod_qlever_backend_provider_create(
    const xpod_rdf_bytes* config_json,
    xpod_rdf_backend_v1** out_backend);

void xpod_qlever_backend_provider_destroy(xpod_rdf_backend_v1* backend);

#ifdef __cplusplus
}
#endif

#endif
