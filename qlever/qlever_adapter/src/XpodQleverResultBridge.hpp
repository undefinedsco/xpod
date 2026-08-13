#ifndef XPOD_QLEVER_RESULT_BRIDGE_HPP
#define XPOD_QLEVER_RESULT_BRIDGE_HPP

#include "XpodQleverIdTableBridge.hpp"

#include <type_traits>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/Result.h"
#include "index/LocalVocab.h"

namespace xpod::qlever {

struct QleverResultWithStatus {
  xpod_rdf_status status;
  Result result;
};

template <typename ResultT>
auto qleverResultTableImpl(const ResultT& result, int)
    -> decltype(result.idTableView()) {
  return result.idTableView();
}

template <typename ResultT>
auto qleverResultTableImpl(const ResultT& result, long)
    -> decltype(result.idTable()) {
  return result.idTable();
}

template <typename ResultT>
decltype(auto) qleverResultTable(const ResultT& result) {
  return qleverResultTableImpl(result, 0);
}

using QleverResultTable = std::remove_cv_t<std::remove_reference_t<decltype(
    qleverResultTable(std::declval<const Result&>()))>>;

inline QleverResultWithStatus toQleverResult(
    QleverIdTableResult table_result,
    std::vector<ColumnIndex> sorted_by = {},
    LocalVocab local_vocab = {}) {
  return {
      table_result.status,
      Result(std::move(table_result.table), std::move(sorted_by),
             std::move(local_vocab)),
  };
}

}  // namespace xpod::qlever
#endif

#endif
