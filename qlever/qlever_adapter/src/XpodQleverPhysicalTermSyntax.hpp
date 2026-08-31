#ifndef XPOD_QLEVER_PHYSICAL_TERM_SYNTAX_HPP
#define XPOD_QLEVER_PHYSICAL_TERM_SYNTAX_HPP

#include <algorithm>
#include <optional>
#include <string_view>

namespace xpod::qlever {

inline bool physicalIriRefValueIsValid(std::string_view value) noexcept {
  return !value.empty() &&
         std::none_of(value.begin(), value.end(), [](unsigned char character) {
           return character <= 0x20 || character == '<' || character == '>' ||
                  character == '"' || character == '{' || character == '}' ||
                  character == '|' || character == '^' || character == '`' ||
                  character == '\\';
         });
}

inline bool physicalAsciiAlpha(char character) noexcept {
  return (character >= 'A' && character <= 'Z') ||
         (character >= 'a' && character <= 'z');
}

inline bool physicalAsciiDigit(char character) noexcept {
  return character >= '0' && character <= '9';
}

inline bool physicalLanguageTagIsValid(std::string_view language) noexcept {
  if (language.empty()) {
    return false;
  }
  size_t index = 0;
  while (index < language.size() && physicalAsciiAlpha(language[index])) {
    ++index;
  }
  if (index == 0) {
    return false;
  }
  while (index < language.size()) {
    if (language[index++] != '-') {
      return false;
    }
    const size_t subtag_start = index;
    while (index < language.size() &&
           (physicalAsciiAlpha(language[index]) ||
            physicalAsciiDigit(language[index]))) {
      ++index;
    }
    if (index == subtag_start) {
      return false;
    }
  }
  return true;
}

inline std::optional<std::string_view> physicalLanguageFromSuffix(
    std::string_view suffix) noexcept {
  if (suffix.empty() || suffix.front() != '@') {
    return std::nullopt;
  }
  const std::string_view language = suffix.substr(1);
  if (!physicalLanguageTagIsValid(language)) {
    return std::nullopt;
  }
  return language;
}

inline std::optional<std::string_view> physicalDatatypeIriFromSuffix(
    std::string_view suffix) noexcept {
  if (suffix.size() < 5 || suffix.substr(0, 3) != "^^<" ||
      suffix.back() != '>') {
    return std::nullopt;
  }
  const std::string_view datatype_iri = suffix.substr(3, suffix.size() - 4);
  if (!physicalIriRefValueIsValid(datatype_iri)) {
    return std::nullopt;
  }
  return datatype_iri;
}

}  // namespace xpod::qlever

#endif
