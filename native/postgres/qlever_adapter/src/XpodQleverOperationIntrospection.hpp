#ifndef XPOD_QLEVER_OPERATION_INTROSPECTION_HPP
#define XPOD_QLEVER_OPERATION_INTROSPECTION_HPP

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"

namespace xpod::qlever {

struct QleverOperationNodeInfo {
  std::string descriptor;
  size_t result_width = 0;
  std::vector<ColumnIndex> sorted_by;
  std::vector<QleverOperationNodeInfo> children;
};

inline QleverOperationNodeInfo inspectQleverExecutionTree(
    QueryExecutionTree& tree) {
  QleverOperationNodeInfo info;
  info.descriptor = tree.getDescriptor();
  info.result_width = tree.getResultWidth();
  info.sorted_by = tree.resultSortedOn();
  return info;
}

inline QleverOperationNodeInfo inspectQleverOperation(Operation& operation) {
  QleverOperationNodeInfo info;
  info.descriptor = operation.getDescriptor();
  info.result_width = operation.getResultWidth();
  info.sorted_by = operation.getResultSortedOn();
  for (QueryExecutionTree* child : operation.getChildren()) {
    if (child != nullptr) {
      info.children.push_back(inspectQleverExecutionTree(*child));
    }
  }
  return info;
}

}  // namespace xpod::qlever
#endif

#endif
