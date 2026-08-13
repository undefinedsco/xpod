#ifndef XPOD_QLEVER_VALUE_ID_BRIDGE_HPP
#define XPOD_QLEVER_VALUE_ID_BRIDGE_HPP

#include <cstdint>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

inline Id toQleverId(uint64_t qlever_id_bits) {
  return Id::fromBits(qlever_id_bits);
}

}  // namespace xpod::qlever
#endif

#endif
