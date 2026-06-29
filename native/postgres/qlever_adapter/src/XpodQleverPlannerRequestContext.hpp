#ifndef XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP
#define XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP

#include "XpodPhysicalBackend.hpp"

class QueryExecutionContext;
struct xpod_qlever_query_request;
struct xpod_rdf_cancellation;

namespace xpod::qlever {

struct PlannerRequestContext {
  xpod::rdf::PhysicalBackend backend;
  const xpod_qlever_query_request* request = nullptr;
  const xpod_rdf_cancellation* cancellation = nullptr;
};

struct PlannerContextHandle {
  QueryExecutionContext* qec = nullptr;
  const PlannerRequestContext* native = nullptr;
};

}  // namespace xpod::qlever

#endif
