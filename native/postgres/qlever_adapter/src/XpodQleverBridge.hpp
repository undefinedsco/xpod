#ifndef XPOD_QLEVER_BRIDGE_HPP
#define XPOD_QLEVER_BRIDGE_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_qlever_adapter.h"

#include <string>

namespace xpod::qlever {

bool bridgeCompiledWithQlever() noexcept;

xpod_rdf_status executeBridgeQuery(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage);

}  // namespace xpod::qlever

#endif
