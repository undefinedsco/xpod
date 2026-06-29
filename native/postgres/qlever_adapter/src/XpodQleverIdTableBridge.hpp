#ifndef XPOD_QLEVER_ID_TABLE_BRIDGE_HPP
#define XPOD_QLEVER_ID_TABLE_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/idTable/IdTable.h"

namespace xpod::qlever {

struct QleverIdTableResult {
  xpod_rdf_status status;
  IdTable table;
};

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

inline QleverIdTableResult executeScanToQleverIdTable(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input) {
  QleverIdRowBuffer rows;
  rows.width = 3;
  xpod_rdf_status status = executeScanToQleverIds(backend, input, rows);
  if (status != XPOD_RDF_STATUS_OK) {
    return {status, IdTable(rows.width)};
  }
  return {XPOD_RDF_STATUS_OK, toQleverIdTable(rows)};
}

}  // namespace xpod::qlever
#endif

#endif
