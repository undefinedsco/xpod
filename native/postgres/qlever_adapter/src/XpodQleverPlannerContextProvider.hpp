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

#if __has_include("engine/MaterializedViews.h") && \
    __has_include("engine/NamedResultCache.h") && \
    __has_include("engine/SortPerformanceEstimator.h") && \
    __has_include("index/Index.h") && \
    __has_include("util/AllocatorWithLimit.h")
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
#define XPOD_QLEVER_HAS_OWNED_QEC_DEPS 1
#else
#define XPOD_QLEVER_HAS_OWNED_QEC_DEPS 0
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

#if XPOD_QLEVER_HAS_OWNED_QEC_DEPS
template <typename Context, bool Complete>
struct IsOwnedQecConstructibleIfComplete : std::false_type {};

template <typename Context>
struct IsOwnedQecConstructibleIfComplete<Context, true>
    : std::conjunction<
          std::is_constructible<Index, ad_utility::AllocatorWithLimit<Id>>,
          std::is_default_constructible<QueryResultCache>,
          std::is_default_constructible<NamedResultCache>,
          std::is_default_constructible<MaterializedViewsManager>,
          std::is_constructible<
              Context,
              std::shared_ptr<const Index>,
              QueryResultCache*,
              ad_utility::AllocatorWithLimit<Id>,
              SortPerformanceEstimator,
              NamedResultCache*,
              std::shared_ptr<MaterializedViewsManager>>> {};
#else
template <typename Context, bool Complete>
struct IsOwnedQecConstructibleIfComplete : std::false_type {};
#endif

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
    if constexpr (!HasXpodPhysicalIndexSetter<Context>::value) {
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

#if XPOD_QLEVER_HAS_OWNED_QEC_DEPS
template <typename Context>
class OwnedPlannerContextProvider final : public QueryPlannerContextProvider {
 public:
  explicit OwnedPlannerContextProvider(xpod::rdf::PhysicalBackend backend)
      : planner_context_{backend, nullptr, nullptr},
        allocator_{ad_utility::makeUnlimitedAllocator<Id>()},
        index_{std::make_shared<Index>(allocator_)},
        materialized_views_{std::make_shared<MaterializedViewsManager>()},
        context_{
            std::shared_ptr<const Index>{index_},
            &cache_,
            allocator_,
            SortPerformanceEstimator{},
            &named_cache_,
            materialized_views_} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    refreshPlannerRequestContext(planner_context_, request);
    if constexpr (!HasXpodPhysicalIndexSetter<Context>::value) {
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
  ad_utility::AllocatorWithLimit<Id> allocator_;
  std::shared_ptr<Index> index_;
  QueryResultCache cache_;
  NamedResultCache named_cache_;
  std::shared_ptr<MaterializedViewsManager> materialized_views_;
  Context context_;
};
#endif

using DefaultQueryExecutionContextProvider = DefaultPlannerContextProvider<
    QueryExecutionContext,
    IsComplete<QueryExecutionContext>::value,
    IsDefaultConstructibleIfComplete<
        QueryExecutionContext,
        IsComplete<QueryExecutionContext>::value>::value>;

using QueryExecutionContextProvider = std::conditional_t<
    IsOwnedQecConstructibleIfComplete<
        QueryExecutionContext,
        IsComplete<QueryExecutionContext>::value>::value,
#if XPOD_QLEVER_HAS_OWNED_QEC_DEPS
    OwnedPlannerContextProvider<QueryExecutionContext>,
#else
    DefaultQueryExecutionContextProvider,
#endif
    DefaultQueryExecutionContextProvider>;

}  // namespace detail

inline std::unique_ptr<QueryPlannerContextProvider>
createQueryPlannerContextProvider(xpod::rdf::PhysicalBackend backend) {
  return std::make_unique<detail::QueryExecutionContextProvider>(
      backend);
}

}  // namespace xpod::qlever

#endif

#endif
