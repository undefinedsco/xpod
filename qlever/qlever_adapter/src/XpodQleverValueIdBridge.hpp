#ifndef XPOD_QLEVER_VALUE_ID_BRIDGE_HPP
#define XPOD_QLEVER_VALUE_ID_BRIDGE_HPP

#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

inline Id toQleverId(uint64_t qlever_id_bits) {
  return Id::fromBits(qlever_id_bits);
}

template <typename VocabT, typename = void>
struct BridgeHasAddLiteral : std::false_type {};

template <typename VocabT>
struct BridgeHasAddLiteral<
    VocabT,
    std::void_t<decltype(std::declval<VocabT&>().addLiteral(
        std::declval<std::string>(), std::declval<std::string>()))>>
    : std::true_type {};

template <typename T, typename IndexT, typename = void>
struct BridgeHasMakeFromLocalVocabIndex : std::false_type {};

template <typename T, typename IndexT>
struct BridgeHasMakeFromLocalVocabIndex<
    T, IndexT,
    std::void_t<decltype(T::makeFromLocalVocabIndex(
        std::declval<IndexT>()))>>
    : std::true_type {};

template <
    typename T, typename IndexT,
    typename std::enable_if<
        BridgeHasMakeFromLocalVocabIndex<T, IndexT>::value,
                            int>::type = 0>
inline T bridgeLocalVocabIndexId(IndexT index) {
  return T::makeFromLocalVocabIndex(index);
}

template <
    typename T, typename IndexT,
    typename std::enable_if<
        !BridgeHasMakeFromLocalVocabIndex<T, IndexT>::value,
                            int>::type = 0>
inline T bridgeLocalVocabIndexId(IndexT index) {
  return T::fromBits(static_cast<uint64_t>(index));
}

template <
    typename VocabT,
    typename std::enable_if<BridgeHasAddLiteral<VocabT>::value, int>::type = 0>
inline std::optional<Id> bridgeLocalVocabLiteralId(
    VocabT& local_vocab, const std::string& value) {
  return bridgeLocalVocabIndexId<Id>(local_vocab.addLiteral(
      value, "http://www.w3.org/2001/XMLSchema#string"));
}

template <
    typename VocabT,
    typename std::enable_if<!BridgeHasAddLiteral<VocabT>::value, int>::type = 0>
inline std::optional<Id> bridgeLocalVocabLiteralId(
    VocabT& local_vocab, const std::string& value) {
  (void)local_vocab;
  (void)value;
  return std::nullopt;
}

}  // namespace xpod::qlever
#endif

#endif
