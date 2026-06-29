#include "xpod_qlever_adapter.h"

#include <new>
#include <string>

struct xpod_qlever_adapter {
  xpod_rdf_backend_v1* backend;
  uint64_t memory_limit_bytes;
  bool enable_runtime_profile;
  std::string result_storage;
  std::string profile_storage;
  std::string error_storage;
};

extern "C" uint32_t xpod_qlever_adapter_abi_version(void) {
  return XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_create(
    const xpod_qlever_adapter_config* config,
    xpod_qlever_adapter** out_adapter) {
  if (out_adapter == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_adapter = nullptr;
  if (config == nullptr || config->backend == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (config->backend->abi_version != XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  try {
    xpod_qlever_adapter* adapter = new xpod_qlever_adapter();
    adapter->backend = config->backend;
    adapter->memory_limit_bytes = config->memory_limit_bytes;
    adapter->enable_runtime_profile = config->enable_runtime_profile != 0;
    *out_adapter = adapter;
    return XPOD_RDF_STATUS_OK;
  } catch (const std::bad_alloc&) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
}

extern "C" void xpod_qlever_adapter_destroy(xpod_qlever_adapter* adapter) {
  delete adapter;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_query(
    xpod_qlever_adapter* adapter,
    xpod_rdf_bytes sparql,
    xpod_qlever_query_result* out_result) {
  if (adapter == nullptr || out_result == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  adapter->result_storage.clear();
  adapter->profile_storage.clear();
  adapter->error_storage =
      "xpod_qlever_adapter_query is not wired to QLever executor yet";

  out_result->status = XPOD_RDF_STATUS_UNSUPPORTED;
  out_result->result_json = {adapter->result_storage.data(),
                             adapter->result_storage.size()};
  out_result->profile_json = {adapter->profile_storage.data(),
                              adapter->profile_storage.size()};
  out_result->error_message = {adapter->error_storage.data(),
                               adapter->error_storage.size()};

  (void)sparql;
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

extern "C" void xpod_qlever_adapter_release_result(
    xpod_qlever_adapter* adapter,
    xpod_qlever_query_result* result) {
  if (result == nullptr) {
    return;
  }
  result->status = XPOD_RDF_STATUS_OK;
  result->result_json = {nullptr, 0};
  result->profile_json = {nullptr, 0};
  result->error_message = {nullptr, 0};
  if (adapter != nullptr) {
    adapter->result_storage.clear();
    adapter->profile_storage.clear();
    adapter->error_storage.clear();
  }
}
