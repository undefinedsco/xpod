#include "xpod_qlever_adapter.h"

#include "XpodPhysicalBackend.hpp"
#include "XpodQleverExecutor.hpp"

#include <memory>
#include <new>
#include <string>

struct xpod_qlever_adapter {
  xpod_qlever_adapter(
      xpod_rdf_backend_v1* raw_backend,
      uint64_t memory_limit,
      bool runtime_profile)
      : backend(raw_backend),
        memory_limit_bytes(memory_limit),
        enable_runtime_profile(runtime_profile),
        executor(xpod::qlever::createQueryExecutor(
            backend,
            {memory_limit_bytes, enable_runtime_profile})) {}

  xpod::rdf::PhysicalBackend backend;
  uint64_t memory_limit_bytes;
  bool enable_runtime_profile;
  std::unique_ptr<xpod::qlever::QueryExecutor> executor;
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
    xpod_qlever_adapter* adapter = new xpod_qlever_adapter(
        config->backend,
        config->memory_limit_bytes,
        config->enable_runtime_profile != 0);
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

  return adapter->executor->execute(
      sparql,
      *out_result,
      adapter->result_storage,
      adapter->profile_storage,
      adapter->error_storage);
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
