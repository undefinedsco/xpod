#ifndef XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP
#define XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_qlever_adapter.h"

#include <memory>
#include <type_traits>
#include <utility>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/QueryExecutionContext.h"

namespace xpod::qlever {

class QueryPlannerContextProvider {
 public:
  virtual ~QueryPlannerContextProvider() = default;
  virtual QueryExecutionContext* current(
      const xpod_qlever_query_request& request) = 0;
};

namespace detail {

template <typename T, typename = void>
struct IsComplete : std::false_type {};

template <typename T>
struct IsComplete<T, decltype(void(sizeof(T)))> : std::true_type {};

template <typename T, bool Complete>
struct IsDefaultConstructibleIfComplete : std::false_type {};

template <typename T>
struct IsDefaultConstructibleIfComplete<T, true>
    : std::is_default_constructible<T> {};

template <typename Context, typename = void>
struct HasXpodRequestContextSetter : std::false_type {};

template <typename Context>
struct HasXpodRequestContextSetter<
    Context,
    decltype(void(std::declval<Context&>().setXpodRequestContext(
        std::declval<const xpod_qlever_query_request&>())))> : std::true_type {};

template <typename Context, bool HasSetter>
struct XpodRequestContextApplier {
  static void apply(
      Context& context,
      const xpod_qlever_query_request& request) {
    (void)context;
    (void)request;
  }
};

template <typename Context>
struct XpodRequestContextApplier<Context, true> {
  static void apply(
      Context& context,
      const xpod_qlever_query_request& request) {
    context.setXpodRequestContext(request);
  }
};

template <typename Context, bool IsComplete, bool IsDefaultConstructible>
class DefaultPlannerContextProvider final : public QueryPlannerContextProvider {
 public:
  QueryExecutionContext* current(
      const xpod_qlever_query_request& request) override {
    (void)request;
    return nullptr;
  }
};

template <typename Context>
class DefaultPlannerContextProvider<Context, true, true> final
    : public QueryPlannerContextProvider {
 public:
  QueryExecutionContext* current(
      const xpod_qlever_query_request& request) override {
    XpodRequestContextApplier<
        Context,
        HasXpodRequestContextSetter<Context>::value>::apply(context_, request);
    return &context_;
  }

 private:
  Context context_;
};

using DefaultQueryExecutionContextProvider = DefaultPlannerContextProvider<
    QueryExecutionContext,
    IsComplete<QueryExecutionContext>::value,
    IsDefaultConstructibleIfComplete<
        QueryExecutionContext,
        IsComplete<QueryExecutionContext>::value>::value>;

}  // namespace detail

inline std::unique_ptr<QueryPlannerContextProvider>
createQueryPlannerContextProvider(xpod::rdf::PhysicalBackend backend) {
  (void)backend;
  return std::make_unique<detail::DefaultQueryExecutionContextProvider>();
}

}  // namespace xpod::qlever

#endif

#endif
