#ifndef XPOD_QLEVER_TEXT_RECORD_ID_BRIDGE_HPP
#define XPOD_QLEVER_TEXT_RECORD_ID_BRIDGE_HPP

#include <cstdint>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

inline Id retrievalPointToQleverId(uint64_t retrieval_point) {
  return Id::makeFromTextRecordIndex(TextRecordIndex::make(retrieval_point));
}

}  // namespace xpod::qlever
#endif

#endif
