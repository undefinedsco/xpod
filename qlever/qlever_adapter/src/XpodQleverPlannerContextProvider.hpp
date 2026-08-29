#ifndef XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP
#define XPOD_QLEVER_PLANNER_CONTEXT_PROVIDER_HPP

#include "XpodQleverPlannerRequestContext.hpp"
#include "xpod_qlever_adapter.h"

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
namespace xpod::qlever {
class XpodQleverPhysicalIndex;
}

#include "engine/QueryExecutionContext.h"

#if __has_include("global/Constants.h")
#include "global/Constants.h"
#define XPOD_QLEVER_HAS_CACHE_EVICTING_ALLOCATOR 1
#else
#define XPOD_QLEVER_HAS_CACHE_EVICTING_ALLOCATOR 0
#endif

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

enum class QueryExecutionContextCacheMode {
  Cached,
  Uncached,
};

class QueryPlannerContextProvider {
 public:
  virtual ~QueryPlannerContextProvider() = default;
  virtual PlannerContextHandle current(
      const xpod_qlever_query_request& request) = 0;
};

namespace detail {

struct PlannerRequestRefreshStorage {
  xpod_qlever_query_request request = {};
  std::vector<char> facts_version;
};

inline xpod_rdf_bytes storedBytesView(
    const std::vector<char>& storage) noexcept {
  return {storage.empty() ? nullptr : storage.data(), storage.size()};
}

inline void storeBytes(
    std::vector<char>& storage,
    xpod_rdf_bytes bytes) {
  if (bytes.data == nullptr || bytes.size == 0) {
    storage.clear();
    return;
  }
  storage.assign(bytes.data, bytes.data + bytes.size);
}

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
      xpod::rdf::PhysicalBackend backend,
      uint64_t = 0,
      QueryExecutionContextCacheMode =
          QueryExecutionContextCacheMode::Cached) noexcept
      : planner_context_{backend, nullptr, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    refreshPlannerRequestContext(planner_context_, request);
    planner_context_.qec = nullptr;
    return {nullptr, &planner_context_, &refresh_storage_};
  }

 private:
  PlannerRequestContext planner_context_;
  PlannerRequestRefreshStorage refresh_storage_;
};

template <typename Context>
class DefaultPlannerContextProvider<Context, true, true> final
    : public QueryPlannerContextProvider {
 public:
  explicit DefaultPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend,
      uint64_t = 0,
      QueryExecutionContextCacheMode =
          QueryExecutionContextCacheMode::Cached) noexcept
      : planner_context_{backend, nullptr, nullptr} {}

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    refreshPlannerRequestContext(planner_context_, request);
    planner_context_.qec = &context_;
    if constexpr (!HasXpodPhysicalIndexSetter<Context>::value) {
      return {nullptr, &planner_context_, &refresh_storage_};
    }
    XpodPlannerRequestContextApplier<
        Context,
        HasXpodPlannerRequestContextSetter<Context>::value>::apply(
            context_, planner_context_);
    XpodPhysicalIndexApplier<
        Context,
        HasXpodPhysicalIndexSetter<Context>::value>::apply(
            context_, planner_context_);
    return {&context_, &planner_context_, &refresh_storage_};
  }

 private:
  PlannerRequestContext planner_context_;
  PlannerRequestRefreshStorage refresh_storage_;
  Context context_;
};

#if XPOD_QLEVER_HAS_OWNED_QEC_DEPS
inline ad_utility::AllocatorWithLimit<Id> allocatorForMemoryLimit(
    uint64_t memory_limit_bytes,
    QueryResultCache* cache) {
  if (memory_limit_bytes == 0) {
    return ad_utility::makeUnlimitedAllocator<Id>();
  }
#if XPOD_QLEVER_HAS_CACHE_EVICTING_ALLOCATOR
  return ad_utility::AllocatorWithLimit<Id>{
      ad_utility::makeAllocationMemoryLeftThreadsafeObject(
          ad_utility::MemorySize::bytes(memory_limit_bytes)),
      [cache](ad_utility::MemorySize requested) {
        if (cache != nullptr) {
          cache->makeRoomAsMuchAsPossible(
              MAKE_ROOM_SLACK_FACTOR * requested);
        }
      }};
#else
  (void)cache;
  return ad_utility::makeAllocatorWithLimit<Id>(
      ad_utility::MemorySize::bytes(memory_limit_bytes));
#endif
}

template <typename Context>
class OwnedPlannerContextProvider final : public QueryPlannerContextProvider {
 public:
  explicit OwnedPlannerContextProvider(
      xpod::rdf::PhysicalBackend backend,
      uint64_t memory_limit_bytes = 0,
      QueryExecutionContextCacheMode cache_mode =
          QueryExecutionContextCacheMode::Cached)
      : planner_context_{backend, nullptr, nullptr},
        allocator_{allocatorForMemoryLimit(memory_limit_bytes, &cache_)},
        index_{std::make_shared<Index>(allocator_)},
        materialized_views_{std::make_shared<MaterializedViewsManager>()},
        context_{
            std::shared_ptr<const Index>{index_},
            &cache_,
            allocator_,
            SortPerformanceEstimator{},
            &named_cache_,
            materialized_views_,
            [](std::string) {},
            false,
            false,
            cache_mode == QueryExecutionContextCacheMode::Uncached
                ? Context::DisableCaching::True
                : Context::DisableCaching::False} {
    index_->setOnDiskBase(
        (std::filesystem::temp_directory_path() / "xpod-qlever").string());
  }

  ~OwnedPlannerContextProvider() noexcept override { cache_.clearAll(); }

  PlannerContextHandle current(
      const xpod_qlever_query_request& request) override {
    context_.clearCacheUnpinnedOnly();
    refreshPlannerRequestContext(planner_context_, request);
    planner_context_.qec = &context_;
    if constexpr (!HasXpodPhysicalIndexSetter<Context>::value) {
      return {nullptr, &planner_context_, &refresh_storage_};
    }
    XpodPlannerRequestContextApplier<
        Context,
        HasXpodPlannerRequestContextSetter<Context>::value>::apply(
            context_, planner_context_);
    XpodPhysicalIndexApplier<
        Context,
        HasXpodPhysicalIndexSetter<Context>::value>::apply(
            context_, planner_context_);
    return {&context_, &planner_context_, &refresh_storage_};
  }

 private:
  PlannerRequestContext planner_context_;
  PlannerRequestRefreshStorage refresh_storage_;
  QueryResultCache cache_;
  ad_utility::AllocatorWithLimit<Id> allocator_;
  std::shared_ptr<Index> index_;
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

#if XPOD_QLEVER_HAS_OWNED_QEC_DEPS
using QueryExecutionContextProvider =
    OwnedPlannerContextProvider<QueryExecutionContext>;
#else
using QueryExecutionContextProvider = DefaultQueryExecutionContextProvider;
#endif

}  // namespace detail

inline bool refreshPlannerContextAfterMutation(
    PlannerContextHandle& handle,
    const xpod_qlever_query_request& base_request,
    const xpod_rdf_mutation_result& mutation_result) {
  if (handle.native == nullptr) {
    return false;
  }
  auto* context = const_cast<PlannerRequestContext*>(handle.native);
  detail::PlannerRequestRefreshStorage* storage = handle.refresh_storage;
  if (storage == nullptr) {
    return false;
  }

  storage->request = base_request;
  detail::storeBytes(storage->facts_version, mutation_result.facts_version);
  storage->request.snapshot.facts_version =
      detail::storedBytesView(storage->facts_version);
  storage->request.snapshot.stats_version = {};
  detail::refreshPlannerRequestContext(*context, storage->request);
  context->qec = handle.qec;

  if (handle.qec != nullptr) {
    detail::XpodPlannerRequestContextApplier<
        QueryExecutionContext,
        detail::HasXpodPlannerRequestContextSetter<
            QueryExecutionContext>::value>::apply(
                *handle.qec, *context);
    detail::XpodPhysicalIndexApplier<
        QueryExecutionContext,
        detail::HasXpodPhysicalIndexSetter<
            QueryExecutionContext>::value>::apply(
                *handle.qec, *context);
  }
  handle.native = context;
  return true;
}

inline std::unique_ptr<QueryPlannerContextProvider>
createQueryPlannerContextProvider(
    xpod::rdf::PhysicalBackend backend,
    uint64_t memory_limit_bytes = 0,
    QueryExecutionContextCacheMode cache_mode =
        QueryExecutionContextCacheMode::Cached) {
  return std::make_unique<detail::QueryExecutionContextProvider>(
      backend, memory_limit_bytes, cache_mode);
}

}  // namespace xpod::qlever

#endif

#endif
