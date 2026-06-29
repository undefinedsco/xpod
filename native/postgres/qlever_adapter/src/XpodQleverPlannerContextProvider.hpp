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
  virtual PlannerContextHandle current(
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
      xpod::rdf::PhysicalBackend backend) noexcept
      : planner_context_{backend, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    planner_context_.request = &request;
    return {nullptr, &planner_context_};
  }

 private:
  PlannerRequestContext planner_context_;
};

template <typename Context>
class DefaultPlannerContextProvider<Context, true, true> final
    : public QueryPlannerContextProvider {
 public:
  explicit DefaultPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend) noexcept
      : planner_context_{backend, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    planner_context_.request = &request;
    if constexpr (!HasXpodPlannerRequestContextSetter<Context>::value) {
      return {nullptr, &planner_context_};
    }
    XpodPlannerRequestContextApplier<
        Context,
        HasXpodPlannerRequestContextSetter<Context>::value>::apply(
            context_, planner_context_);
    return {&context_, &planner_context_};
  }

 private:
  PlannerRequestContext planner_context_;
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
