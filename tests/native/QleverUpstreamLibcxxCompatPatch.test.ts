import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const comparatorPatchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-libcxx-string-sort-comparator.patch',
);
const stringUtilsPatchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-libcxx-string-utils.patch',
);

const comparatorFixture = `#pragma once
#include <cstdint>
#include <string>
#include <string_view>
class LocaleManager {
 public:
  /**
   * A strong typedef for a string that contains unicode collation weights for
   * another string. The actual storage can be a \`std::string\` or a
   * \`std::string_view\`.
   */
  // TODO<GCC12> As soon as we have constexpr std::string, this class can
  //  become constexpr.
  using U8String = std::basic_string<uint8_t>;
  using U8StringView = std::basic_string_view<uint8_t>;

  CPP_template(typename T)(requires ad_utility::SimilarToAny<
                           T, U8String, U8StringView>) class SortKeyImpl {
   public:
    SortKeyImpl() = default;
    explicit SortKeyImpl(U8StringView sortKey) : sortKey_(sortKey) {}
    [[nodiscard]] constexpr const T& get() const noexcept { return sortKey_; }
    constexpr T& get() noexcept { return sortKey_; }

    // Comparison of sort key is done lexicographically on the byte values
    // of member \`sortKey_\`
    template <typename U>
    [[nodiscard]] int compare(const SortKeyImpl<U>& rhs) const noexcept {
      return U8StringView{sortKey_}.compare(U8StringView{rhs.sortKey_});
    }

    QL_DEFINE_DEFAULTED_THREEWAY_OPERATOR_LOCAL(SortKeyImpl, sortKey_)

    /// Is this sort key a prefix of another sort key. Note: This does not imply
    /// any guarantees on the relation of the underlying strings.
    bool starts_with(const SortKeyImpl& rhs) const noexcept {
      return ql::starts_with(get(), rhs.get());
    }

    /// Return the number of bytes in the \`SortKey\`
    std::string::size_type size() const noexcept { return get().size(); }

   private:
    T sortKey_;
  };
  using SortKey = SortKeyImpl<std::basic_string<uint8_t>>;
  using SortKeyView = SortKeyImpl<std::basic_string_view<uint8_t>>;

  /// Copy constructor
  LocaleManager(const LocaleManager& rhs)
};
`;

const stringUtilsFixture = `#pragma once
#include <cstddef>
#include <string>
#include <string_view>
std::string insertThousandSeparator(const std::string_view str,
                                    const char separatorSymbol = ' ');

// A "constant-time" comparison for strings.
// Implementation based on https://stackoverflow.com/a/25374036
// Basically for 2 strings of equal length this function will always
// take the same time to compute regardless of how many characters are
// matching. This is to prevent analysing the secret comparison string
// by analysing response times to incrementally figure out individual
// characters. An equally safe, but slower method to achieve the same thing
// would be to compute cryptographically secure hashes (like SHA-3 for example)
// and compare the hashes instead of the actual strings.
inline QL_CONSTEXPR bool constantTimeEquals(std::string_view view1,
                                            std::string_view view2) {
  using byte_view = std::basic_string_view<volatile std::byte>;
  auto impl = [](byte_view str1, byte_view str2) {
    if (str1.length() != str2.length()) {
      return false;
    }
    volatile std::byte mismatchFound{0};
    for (size_t i = 0; i < str1.length(); ++i) {
      // In C++20 compound assignment of volatile variables causes a warning,
      // so we can't use 'mismatchFound |=' until compiling with C++23 where it
      // is fine again. mismatchFound can be interpreted as bool and "is false"
      // until the first mismatch in the strings is found.
      mismatchFound = mismatchFound | (str1[i] ^ str2[i]);
    }
    return !static_cast<bool>(mismatchFound);
  };
  auto toVolatile = [](std::string_view view) constexpr -> byte_view {
    // Casting is safe because both types have the same size
    static_assert(sizeof(std::string_view::value_type) ==
                  sizeof(byte_view::value_type));
    return {
        static_cast<const std::byte*>(static_cast<const void*>(view.data())),
        view.size()};
  };
  return impl(toVolatile(view1), toVolatile(view2));
}

// _________________________________________________________________________
`;

describe('QLever upstream libc++ compatibility patch assets', () => {
  it('rewrites uint8_t sort-key strings to char-backed std strings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-libcxx-sort-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const target = path.join(qleverSource, 'src/index/StringSortComparator.h');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, comparatorFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        comparatorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(target, 'utf8');
      expect(patched).toContain('using U8String = std::string;');
      expect(patched).toContain('using U8StringView = std::string_view;');
      expect(patched).toContain('using SortKey = SortKeyImpl<std::string>;');
      expect(patched).toContain('using SortKeyView = SortKeyImpl<std::string_view>;');
      expect(patched).not.toContain('basic_string<uint8_t>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rewrites constant-time compare away from volatile std::byte string_view', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-libcxx-stringutils-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const target = path.join(qleverSource, 'src/util/StringUtils.h');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, stringUtilsFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        stringUtilsPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(target, 'utf8');
      expect(patched).toContain('const volatile unsigned char* bytes1');
      expect(patched).toContain('const volatile unsigned char* bytes2');
      expect(patched).not.toContain('basic_string_view<volatile std::byte>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
