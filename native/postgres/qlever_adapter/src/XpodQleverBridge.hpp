#ifndef XPOD_QLEVER_BRIDGE_HPP
#define XPOD_QLEVER_BRIDGE_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_qlever_adapter.h"

#include <string>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/QueryExecutionContext.h"
class QueryExecutionContext;
#endif

namespace xpod::qlever {

bool bridgeCompiledWithQlever() noexcept;

xpod_rdf_status executeBridgeQuery(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage);

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
xpod_rdf_status executeBridgeQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionContext* planner_context,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage);
#endif

}  // namespace xpod::qlever

#endif
