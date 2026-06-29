#ifndef XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP
#define XPOD_QLEVER_PLANNER_REQUEST_CONTEXT_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_qlever_adapter.h"

namespace xpod::qlever {

struct PlannerRequestContext {
  xpod::rdf::PhysicalBackend backend;
  const xpod_qlever_query_request* request;
};

}  // namespace xpod::qlever

#endif
