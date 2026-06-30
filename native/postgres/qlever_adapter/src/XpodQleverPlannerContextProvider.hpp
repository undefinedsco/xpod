#ifndef XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP
#define XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP

#include "XpodQleverPlannerRequestContext.hpp"
#include "xpod_qlever_adapter.h"

#include <memory>
#include <type_traits>
#include <utility>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
namespace xpod::qlever {
class XpodQleverPhysicalIndex;
}

#include "engine/QueryExecutionContext.h"

#if __has_include("engine/Result.h") && \
    __has_include("engine/idTable/IdTable.h") && \
    __has_include("global/Id.h") && \
    __has_include("index/LocalVocab.h") && \
    __has_include("index/Permutation.h")
#include "XpodQleverPhysicalIndex.hpp"
#define XPOD_QLEVER_HAS_CONTEXT_PHYSICAL_INDEX 1
#else
#define XPOD_QLEVER_HAS_CONTEXT_PHYSICAL_INDEX 0
#endif

namespace xpod::qlever {

class QueryPlannerContextProvider {
 public:
  virtual ~QueryPlannerContextProvider() = default;
  virtual PlannerContextHandle current(
      const xpod_qlever_query_request& request) = 0;
};

namespace detail {

inline void refreshPlannerRequestContext(
    PlannerRequestContext& context,
    const xpod_qlever_query_request& request) noexcept {
  context.request = &request;
  context.cancellation = request.cancellation;
  context.capabilities = {};
  context.capabilities_status =
      context.backend.getCapabilities(context.capabilities);
}

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

template <typename Context, typename = void>
struct HasXpodPhysicalIndexSetter : std::false_type {};

#if XPOD_QLEVER_HAS_CONTEXT_PHYSICAL_INDEX
template <typename Context>
struct HasXpodPhysicalIndexSetter<
    Context,
    decltype(void(std::declval<Context&>().setXpodPhysicalIndex(
        std::declval<std::shared_ptr<const XpodQleverPhysicalIndex>>())))>
    : std::true_type {};
#endif

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

template <typename Context, bool HasSetter>
struct XpodPhysicalIndexApplier {
  static void apply(
      Context& context,
      const PlannerRequestContext& planner_context) {
    (void)context;
    (void)planner_context;
  }
};

#if XPOD_QLEVER_HAS_CONTEXT_PHYSICAL_INDEX
template <typename Context>
struct XpodPhysicalIndexApplier<Context, true> {
  static void apply(
      Context& context,
      const PlannerRequestContext& planner_context) {
    context.setXpodPhysicalIndex(
        std::make_shared<const XpodQleverPhysicalIndex>(planner_context));
  }
};
#endif

template <typename Context, bool IsComplete, bool IsDefaultConstructible>
class DefaultPlannerContextProvider final : public QueryPlannerContextProvider {
 public:
  explicit DefaultPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend) noexcept
      : planner_context_{backend, nullptr, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    refreshPlannerRequestContext(planner_context_, request);
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
      : planner_context_{backend, nullptr, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    refreshPlannerRequestContext(planner_context_, request);
    if constexpr (!HasXpodPlannerRequestContextSetter<Context>::value &&
                  !HasXpodPhysicalIndexSetter<Context>::value) {
      return {nullptr, &planner_context_};
    }
    XpodPlannerRequestContextApplier<
        Context,
        HasXpodPlannerRequestContextSetter<Context>::value>::apply(
            context_, planner_context_);
    XpodPhysicalIndexApplier<
        Context,
        HasXpodPhysicalIndexSetter<Context>::value>::apply(
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
