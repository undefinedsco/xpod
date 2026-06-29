#include "XpodQleverExecutor.hpp"

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "XpodQleverBridge.hpp"
#endif

#include <new>

namespace xpod::qlever {

class StubQueryExecutor final : public QueryExecutor {
 public:
  StubQueryExecutor(
      xpod::rdf::PhysicalBackend backend,
      QueryExecutionOptions options) noexcept
      : backend_(backend), options_(options) {}

  xpod_rdf_status execute(
      xpod_rdf_bytes sparql,
      xpod_qlever_query_result& out_result,
      std::string& result_storage,
      std::string& profile_storage,
      std::string& error_storage) override {
    result_storage.clear();
    profile_storage.clear();
    error_storage =
        "stub QLever executor is not wired to upstream QLever yet";

    out_result.status = XPOD_RDF_STATUS_UNSUPPORTED;
    out_result.result_json = {result_storage.data(), result_storage.size()};
    out_result.profile_json = {profile_storage.data(), profile_storage.size()};
    out_result.error_message = {error_storage.data(), error_storage.size()};

    (void)sparql;
    (void)backend_;
    (void)options_;
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  QueryExecutionOptions options_;
};

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
class BridgedQleverExecutor final : public QueryExecutor {
 public:
  BridgedQleverExecutor(
      xpod::rdf::PhysicalBackend backend,
      QueryExecutionOptions options) noexcept
      : backend_(backend), options_(options) {}

  xpod_rdf_status execute(
      xpod_rdf_bytes sparql,
      xpod_qlever_query_result& out_result,
      std::string& result_storage,
      std::string& profile_storage,
      std::string& error_storage) override {
    result_storage.clear();
    profile_storage.clear();
    error_storage =
        "upstream QLever bridge is compiled, but query execution is not wired "
        "to QLever yet";

    out_result.status = XPOD_RDF_STATUS_UNSUPPORTED;
    out_result.result_json = {result_storage.data(), result_storage.size()};
    out_result.profile_json = {profile_storage.data(), profile_storage.size()};
    out_result.error_message = {error_storage.data(), error_storage.size()};

    (void)sparql;
    (void)backend_;
    (void)options_;
    (void)bridgeCompiledWithQlever();
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  QueryExecutionOptions options_;
};
#endif

std::unique_ptr<QueryExecutor> createQueryExecutor(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionOptions options) {
#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
  return std::make_unique<BridgedQleverExecutor>(backend, options);
#else
  return std::make_unique<StubQueryExecutor>(backend, options);
#endif
}

}  // namespace xpod::qlever
