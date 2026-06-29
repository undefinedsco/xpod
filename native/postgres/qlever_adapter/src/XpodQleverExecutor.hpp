#ifndef XPOD_QLEVER_EXECUTOR_HPP
#define XPOD_QLEVER_EXECUTOR_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_qlever_adapter.h"

#include <memory>
#include <string>

namespace xpod::qlever {

struct QueryExecutionOptions {
  uint64_t memory_limit_bytes;
  bool enable_runtime_profile;
};

class QueryExecutor {
 public:
  virtual ~QueryExecutor() = default;

  virtual xpod_rdf_status execute(
      xpod_rdf_bytes sparql,
      xpod_qlever_query_result& out_result,
      std::string& result_storage,
      std::string& profile_storage,
      std::string& error_storage) = 0;
};

std::unique_ptr<QueryExecutor> createQueryExecutor(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionOptions options);

}  // namespace xpod::qlever

#endif
