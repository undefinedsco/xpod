#ifndef XPOD_QLEVER_SCAN_MATERIALIZER_HPP
#define XPOD_QLEVER_SCAN_MATERIALIZER_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_rdf_physical_backend.h"

#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "index/Permutation.h"

namespace xpod::qlever {

struct ScanRowBuffer {
  uint32_t width = 3;
  size_t row_count = 0;
  std::vector<xpod_rdf_term_key> rows;
};

struct QleverIdRowBuffer {
  uint32_t width = 3;
  size_t row_count = 0;
  std::vector<uint64_t> rows;
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

inline uint32_t slotMask(char slot) noexcept {
  switch (slot) {
    case 'S':
      return XPOD_RDF_SLOT_SUBJECT;
    case 'P':
      return XPOD_RDF_SLOT_PREDICATE;
    case 'O':
      return XPOD_RDF_SLOT_OBJECT;
    default:
      return 0;
  }
}

inline uint32_t normalizeNeededSlots(uint32_t needed_slots) noexcept {
  return needed_slots;
}

inline uint32_t countNeededSlots(uint32_t needed_slots) noexcept {
  uint32_t normalized = normalizeNeededSlots(needed_slots);
  uint32_t count = 0;
  for (uint32_t slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
       }) {
    if ((normalized & slot) != 0) {
      ++count;
    }
  }
  return count;
}

inline void appendBatch(
    ScanRowBuffer& buffer,
    Permutation::Enum permutation,
    uint32_t needed_slots,
    const xpod_rdf_quad_batch& batch) {
  const char* slots = permutationSlots(permutation);
  uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  buffer.width = countNeededSlots(normalized_needed_slots);
  buffer.row_count += batch.row_count;
  buffer.rows.reserve(buffer.rows.size() + batch.row_count * buffer.width);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_quad_key& row = batch.rows[i];
    for (uint32_t column = 0; column < 3; ++column) {
      if ((normalized_needed_slots & slotMask(slots[column])) == 0) {
        continue;
      }
      buffer.rows.push_back(slotValue(row, slots[column]));
    }
  }
}

inline void appendBatch(
    ScanRowBuffer& buffer,
    Permutation::Enum permutation,
    const xpod_rdf_quad_batch& batch) {
  appendBatch(
      buffer, permutation,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT,
      batch);
}

inline xpod_rdf_status appendEncodedValue(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    xpod_rdf_term_key term) {
  uint64_t bits = 0;
  xpod_rdf_status status = backend.encodeQleverId(term, bits);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  buffer.rows.push_back(bits);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendEncodedBatch(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    Permutation::Enum permutation,
    uint32_t needed_slots,
    const xpod_rdf_quad_batch& batch) {
  const char* slots = permutationSlots(permutation);
  uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  buffer.width = countNeededSlots(normalized_needed_slots);
  buffer.row_count += batch.row_count;
  buffer.rows.reserve(buffer.rows.size() + batch.row_count * buffer.width);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_quad_key& row = batch.rows[i];
    for (uint32_t column = 0; column < 3; ++column) {
      if ((normalized_needed_slots & slotMask(slots[column])) == 0) {
        continue;
      }
      xpod_rdf_status status =
          appendEncodedValue(buffer, backend, slotValue(row, slots[column]));
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendEncodedBatch(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    Permutation::Enum permutation,
    const xpod_rdf_quad_batch& batch) {
  return appendEncodedBatch(
      buffer, backend, permutation,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT,
      batch);
}

}  // namespace xpod::qlever
#endif

#endif
