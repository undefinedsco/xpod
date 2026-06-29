#ifndef XPOD_QLEVER_RESULT_BRIDGE_HPP
#define XPOD_QLEVER_RESULT_BRIDGE_HPP

#include "XpodQleverIdTableBridge.hpp"

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

inline QleverResultWithStatus toQleverResult(
    QleverIdTableResult table_result,
    std::vector<ColumnIndex> sorted_by = {}) {
  return {
      table_result.status,
      Result(std::move(table_result.table), std::move(sorted_by),
             LocalVocab{}),
  };
}

}  // namespace xpod::qlever
#endif

#endif
