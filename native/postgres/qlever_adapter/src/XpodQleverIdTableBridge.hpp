#ifndef XPOD_QLEVER_ID_TABLE_BRIDGE_HPP
#define XPOD_QLEVER_ID_TABLE_BRIDGE_HPP

#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/idTable/IdTable.h"

namespace xpod::qlever {

inline IdTable toQleverIdTable(const QleverIdRowBuffer& buffer) {
  IdTable table(buffer.width);
  std::vector<Id> row;
  row.reserve(buffer.width);
  for (size_t offset = 0; offset < buffer.rows.size();
       offset += buffer.width) {
    row.clear();
    for (uint32_t column = 0; column < buffer.width; ++column) {
      row.push_back(toQleverId(buffer.rows[offset + column]));
    }
    table.push_back(row);
  }
  return table;
}

}  // namespace xpod::qlever
#endif

#endif
