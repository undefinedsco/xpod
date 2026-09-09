#ifndef XPOD_QLEVER_LOCAL_VOCAB_LITERAL_BRIDGE_HPP
#define XPOD_QLEVER_LOCAL_VOCAB_LITERAL_BRIDGE_HPP

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#include "global/Id.h"
#include "index/LocalVocab.h"

#include <string_view>
#include <utility>

namespace xpod::qlever {

inline Id bridgeLocalVocabLiteralId(
    LocalVocab& local_vocab,
    std::string_view value,
    const LocalVocabContext& context) {
  LocalVocabEntry entry =
      LocalVocabEntry::literalWithoutQuotes(value, context);
  return Id::makeFromLocalVocabIndex(
      local_vocab.getIndexAndAddIfNotContained(std::move(entry)));
}

}  // namespace xpod::qlever
#endif

#endif
