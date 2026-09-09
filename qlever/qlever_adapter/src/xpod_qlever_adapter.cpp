#include "xpod_qlever_adapter.h"

#include "XpodPhysicalBackend.hpp"
#include "XpodQleverExecutor.hpp"
#include "XpodQleverScanMaterializer.hpp"

#include <memory>
#include <new>
#include <sstream>
#include <string>
#include <utility>

#if defined(_WIN32)
#else
#include <dlfcn.h>
#endif

namespace {

std::string bytesToString(xpod_rdf_bytes bytes) {
  if (bytes.data == nullptr || bytes.size == 0) {
    return {};
  }
  return {bytes.data, bytes.size};
}

std::string jsonString(std::string_view value) {
  std::ostringstream out;
  out << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (character < 0x20) {
          constexpr char digits[] = "0123456789abcdef";
          out << "\\u00" << digits[character >> 4] << digits[character & 0x0f];
        } else {
          out << static_cast<char>(character);
        }
    }
  }
  out << '"';
  return out.str();
}

struct LoadedBackendProvider {
  xpod_rdf_backend_v1* backend = nullptr;
  xpod_qlever_backend_provider_destroy_fn destroy = nullptr;
  void* library_handle = nullptr;
};

xpod_rdf_status loadBackendProvider(
    const xpod_qlever_backend_provider_config& config,
    LoadedBackendProvider& out_provider) {
#if defined(_WIN32)
  (void)config;
  (void)out_provider;
  return XPOD_RDF_STATUS_UNSUPPORTED;
#else
  const std::string library_path = bytesToString(config.library_path);
  if (library_path.empty()) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  void* handle = dlopen(library_path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  const std::string create_symbol = bytesToString(config.create_symbol).empty()
                                        ? "xpod_qlever_backend_provider_create"
                                        : bytesToString(config.create_symbol);
  const std::string destroy_symbol = bytesToString(config.destroy_symbol).empty()
                                         ? "xpod_qlever_backend_provider_destroy"
                                         : bytesToString(config.destroy_symbol);

  auto* create_raw = dlsym(handle, create_symbol.c_str());
  auto* destroy_raw = dlsym(handle, destroy_symbol.c_str());
  if (create_raw == nullptr || destroy_raw == nullptr) {
    dlclose(handle);
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  auto create = reinterpret_cast<xpod_qlever_backend_provider_create_fn>(
      create_raw);
  auto destroy = reinterpret_cast<xpod_qlever_backend_provider_destroy_fn>(
      destroy_raw);
  xpod_rdf_backend_v1* backend = nullptr;
  xpod_rdf_status status = create(&config.config_json, &backend);
  if (status != XPOD_RDF_STATUS_OK || backend == nullptr) {
    dlclose(handle);
    return status == XPOD_RDF_STATUS_OK ? XPOD_RDF_STATUS_BACKEND_ERROR
                                        : status;
  }
  if (backend->abi_version != XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION) {
    destroy(backend);
    dlclose(handle);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  out_provider.backend = backend;
  out_provider.destroy = destroy;
  out_provider.library_handle = handle;
  return XPOD_RDF_STATUS_OK;
#endif
}

}  // namespace

struct xpod_qlever_adapter {
  xpod_qlever_adapter(
      LoadedBackendProvider provider,
      uint64_t memory_limit,
      bool runtime_profile,
      xpod::qlever::QueryExecutionPolicy execution_policy)
      : provider_(provider),
        backend(provider_.backend),
        memory_limit_bytes(memory_limit),
        enable_runtime_profile(runtime_profile),
        executor(xpod::qlever::createQueryExecutor(
            backend,
            {memory_limit_bytes, enable_runtime_profile, execution_policy})) {
    xpod_rdf_backend_capabilities capabilities = {};
    if (backend.getCapabilities(capabilities) == XPOD_RDF_STATUS_OK) {
      backend_name = bytesToString(capabilities.backend_name);
    }
  }

  ~xpod_qlever_adapter() {
    if (provider_.destroy != nullptr && provider_.backend != nullptr) {
      provider_.destroy(provider_.backend);
      provider_.backend = nullptr;
    }
#if defined(_WIN32)
#else
    if (provider_.library_handle != nullptr) {
      dlclose(provider_.library_handle);
      provider_.library_handle = nullptr;
    }
#endif
  }

  LoadedBackendProvider provider_;
  xpod::rdf::PhysicalBackend backend;
  uint64_t memory_limit_bytes;
  bool enable_runtime_profile;
  std::string backend_name;
  std::unique_ptr<xpod::qlever::QueryExecutor> executor;
  std::string result_storage;
  std::string profile_storage;
  std::string error_storage;
};

extern "C" uint32_t xpod_qlever_adapter_abi_version(void) {
  return XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_inline_term_bits(
    const xpod_rdf_term* term,
    uint64_t* out_bits,
    uint8_t* out_is_inline) {
  if (term == nullptr || out_bits == nullptr || out_is_inline == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_bits = 0;
  *out_is_inline = 0;
#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
  const std::optional<uint64_t> bits =
      xpod::qlever::inlineTypedLiteralBits(*term);
  if (bits.has_value()) {
    *out_bits = *bits;
    *out_is_inline = 1;
  }
  return XPOD_RDF_STATUS_OK;
#else
  return XPOD_RDF_STATUS_UNSUPPORTED;
#endif
}

extern "C" xpod_rdf_status xpod_qlever_adapter_create(
    const xpod_qlever_adapter_config* config,
    xpod_qlever_adapter** out_adapter) {
  if (out_adapter == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_adapter = nullptr;
  if (config == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (config->backend != nullptr && config->backend_provider != nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (config->execution_policy != XPOD_QLEVER_EXECUTION_NATIVE_ONLY &&
      config->execution_policy != XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  LoadedBackendProvider provider;
  if (config->backend != nullptr) {
    if (config->backend->abi_version != XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    provider.backend = config->backend;
  } else if (config->backend_provider != nullptr) {
    xpod_rdf_status provider_status = loadBackendProvider(
        *config->backend_provider, provider);
    if (provider_status != XPOD_RDF_STATUS_OK) {
      return provider_status;
    }
  } else {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  try {
    xpod_qlever_adapter* adapter = new xpod_qlever_adapter(
        provider,
        config->memory_limit_bytes,
        config->enable_runtime_profile != 0,
        config->execution_policy ==
                XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED
            ? xpod::qlever::QueryExecutionPolicy::CompatibilityAllowed
            : xpod::qlever::QueryExecutionPolicy::NativeOnly);
    *out_adapter = adapter;
    return XPOD_RDF_STATUS_OK;
  } catch (const std::bad_alloc&) {
    if (provider.destroy != nullptr && provider.backend != nullptr) {
      provider.destroy(provider.backend);
    }
#if defined(_WIN32)
#else
    if (provider.library_handle != nullptr) {
      dlclose(provider.library_handle);
    }
#endif
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
}

extern "C" void xpod_qlever_adapter_destroy(xpod_qlever_adapter* adapter) {
  delete adapter;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_query_request(
    xpod_qlever_adapter* adapter,
    const xpod_qlever_query_request* request,
    xpod_qlever_query_result* out_result) {
  if (adapter == nullptr || request == nullptr || out_result == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  const xpod_rdf_status status = adapter->executor->execute(
      *request,
      *out_result,
      adapter->result_storage,
      adapter->profile_storage,
      adapter->error_storage);
  if (!adapter->profile_storage.empty() &&
      adapter->profile_storage.front() == '{' &&
      !adapter->backend_name.empty()) {
    adapter->profile_storage.insert(
        1, "\"backend\":" + jsonString(adapter->backend_name) + ",");
    out_result->profile_json = {
        adapter->profile_storage.data(), adapter->profile_storage.size()};
  }
  return status;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_query(
    xpod_qlever_adapter* adapter,
    xpod_rdf_bytes sparql,
    xpod_qlever_query_result* out_result) {
  xpod_qlever_query_request request = {};
  request.sparql = sparql;
  return xpod_qlever_adapter_query_request(adapter, &request, out_result);
}

extern "C" xpod_rdf_status xpod_qlever_adapter_lookup_terms(
    xpod_qlever_adapter* adapter,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (adapter == nullptr || (term_count > 0 && terms == nullptr) ||
      (term_count > 0 && out_keys == nullptr) ||
      (term_count > 0 && out_statuses == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  const xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& lookup_snapshot =
      snapshot == nullptr ? empty_snapshot : *snapshot;
  for (size_t index = 0; index < term_count; ++index) {
    out_keys[index] = 0;
    out_statuses[index] = adapter->backend.lookupTerm(
        terms[index], lookup_snapshot, out_keys[index]);
  }
  return XPOD_RDF_STATUS_OK;
}

extern "C" xpod_rdf_status xpod_qlever_adapter_resolve_source_scope(
    xpod_qlever_adapter* adapter,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_resolved_source_scope* out_scope) {
  if (adapter == nullptr || source_scope == nullptr || out_scope == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }

  const xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& lookup_snapshot =
      snapshot == nullptr ? empty_snapshot : *snapshot;
  return adapter->backend.resolveSourceScope(
      *source_scope, lookup_snapshot, *out_scope);
}

extern "C" void xpod_qlever_adapter_release_result(
    xpod_qlever_adapter* adapter,
    xpod_qlever_query_result* result) {
  if (result == nullptr) {
    return;
  }
  result->status = XPOD_RDF_STATUS_OK;
  result->result_json = {nullptr, 0};
  result->result_media_type = {nullptr, 0};
  result->profile_json = {nullptr, 0};
  result->error_message = {nullptr, 0};
  if (adapter != nullptr) {
    adapter->result_storage.clear();
    adapter->profile_storage.clear();
    adapter->error_storage.clear();
  }
}
