#ifndef XPOD_QLEVER_SCAN_MATERIALIZER_HPP
#define XPOD_QLEVER_SCAN_MATERIALIZER_HPP

#include "xpod_rdf_physical_backend.h"

#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "index/Permutation.h"

namespace xpod::qlever {

struct ScanRowBuffer {
  uint32_t width = 3;
  std::vector<xpod_rdf_term_key> rows;
};

inline xpod_rdf_term_key slotValue(
    const xpod_rdf_quad_key& row,
    char slot) noexcept {
  switch (slot) {
    case 'S':
      return row.subject;
    case 'P':
      return row.predicate;
    case 'O':
      return row.object;
    default:
      return 0;
  }
}

inline const char* permutationSlots(Permutation::Enum permutation) noexcept {
  switch (permutation) {
    case Permutation::Enum::PSO:
      return "PSO";
    case Permutation::Enum::POS:
      return "POS";
    case Permutation::Enum::SPO:
      return "SPO";
    case Permutation::Enum::SOP:
      return "SOP";
    case Permutation::Enum::OPS:
      return "OPS";
    case Permutation::Enum::OSP:
      return "OSP";
  }
  return "SPO";
}

inline void appendBatch(
    ScanRowBuffer& buffer,
    Permutation::Enum permutation,
    const xpod_rdf_quad_batch& batch) {
  const char* slots = permutationSlots(permutation);
  buffer.width = 3;
  buffer.rows.reserve(buffer.rows.size() + batch.row_count * buffer.width);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_quad_key& row = batch.rows[i];
    buffer.rows.push_back(slotValue(row, slots[0]));
    buffer.rows.push_back(slotValue(row, slots[1]));
    buffer.rows.push_back(slotValue(row, slots[2]));
  }
}

}  // namespace xpod::qlever
#endif

#endif
