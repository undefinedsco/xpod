#ifndef XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP
#define XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP

#include "XpodQleverPlannerRequestContext.hpp"

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
struct HasXpodPlannerRequestContextSetter : std::false_type {};

template <typename Context>
struct HasXpodPlannerRequestContextSetter<
    Context,
    decltype(void(std::declval<Context&>().setXpodPlannerRequestContext(
        std::declval<const PlannerRequestContext&>())))> : std::true_type {};

template <typename Context, bool HasSetter>
struct XpodPlannerRequestContextApplier {
  static void apply(
      Context& context,
      const PlannerRequestContext& planner_context) {
    (void)context;
    (void)planner_context;
  }
};

template <typename Context>
struct XpodPlannerRequestContextApplier<Context, true> {
  static void apply(
      Context& context,
      const PlannerRequestContext& planner_context) {
    context.setXpodPlannerRequestContext(planner_context);
  }
};

template <typename Context, bool IsComplete, bool IsDefaultConstructible>
class DefaultPlannerContextProvider final : public QueryPlannerContextProvider {
 public:
  explicit DefaultPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend) noexcept {
    (void)backend;
  }

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
  explicit DefaultPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend) noexcept
      : backend_(backend) {}

  QueryExecutionContext* current(
      const xpod_qlever_query_request& request) override {
    PlannerRequestContext planner_context{backend_, &request};
    XpodPlannerRequestContextApplier<
        Context,
        HasXpodPlannerRequestContextSetter<Context>::value>::apply(
            context_, planner_context);
    return &context_;
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
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
  return std::make_unique<detail::DefaultQueryExecutionContextProvider>(
      backend);
}

}  // namespace xpod::qlever

#endif

#endif
