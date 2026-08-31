#ifndef XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP
#define XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP

#include "XpodPhysicalBackend.hpp"

class QueryExecutionContext;
struct xpod_qlever_query_request;
struct xpod_rdf_cancellation;

namespace xpod::qlever {

namespace detail {
struct PlannerRequestRefreshStorage;
}

struct PlannerRequestContext {
  xpod::rdf::PhysicalBackend backend;
  const xpod_qlever_query_request* request = nullptr;
  const xpod_rdf_cancellation* cancellation = nullptr;
  xpod_rdf_backend_capabilities capabilities = {};
  xpod_rdf_status capabilities_status = XPOD_RDF_STATUS_UNSUPPORTED;
  QueryExecutionContext* qec = nullptr;
};

struct PlannerContextHandle {
  QueryExecutionContext* qec = nullptr;
  const PlannerRequestContext* native = nullptr;
  detail::PlannerRequestRefreshStorage* refresh_storage = nullptr;
};

}  // namespace xpod::qlever

#endif
