#ifndef XPOD_QLEVER_PERMUTATION_MAP_HPP
#define XPOD_QLEVER_PERMUTATION_MAP_HPP

#include "xpod_rdf_physical_backend.h"

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "index/Permutation.h"

namespace xpod::qlever {

inline xpod_rdf_permutation toXpodPermutation(
    Permutation::Enum permutation) noexcept {
  switch (permutation) {
    case Permutation::Enum::PSO:
      return XPOD_RDF_PERM_PSOG;
    case Permutation::Enum::POS:
      return XPOD_RDF_PERM_POSG;
    case Permutation::Enum::SPO:
      return XPOD_RDF_PERM_SPOG;
    case Permutation::Enum::SOP:
      return XPOD_RDF_PERM_SOPG;
    case Permutation::Enum::OPS:
      return XPOD_RDF_PERM_OPSG;
    case Permutation::Enum::OSP:
      return XPOD_RDF_PERM_OSPG;
  }
  return XPOD_RDF_PERM_SPOG;
}

}  // namespace xpod::qlever
#endif

#endif
