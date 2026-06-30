import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-libcxx-normalized-string.patch',
);

const normalizedStringFixture = `#pragma once
#include <string>
#include <string_view>
struct NormalizedChar {
  char c_;

  QL_DEFINE_DEFAULTED_THREEWAY_OPERATOR_LOCAL(NormalizedChar, c_)
};

// A bespoke string representation that ensures the content
// is correctly encoded and does not contain invalid characters
using NormalizedString = std::basic_string<NormalizedChar>;

// A string view representation of above described normalized strings
using NormalizedStringView = std::basic_string_view<NormalizedChar>;

// Returns the given NormalizedStringView as a string_view.
inline std::string_view asStringViewUnsafe(
    NormalizedStringView normalizedStringView) {
  return {reinterpret_cast<const char*>(normalizedStringView.data()),
          normalizedStringView.size()};
}
inline NormalizedStringView asNormalizedStringViewUnsafe(
    std::string_view input) {
  return {reinterpret_cast<const NormalizedChar*>(input.data()), input.size()};
}

#endif  // QLEVER_SRC_PARSER_NORMALIZEDSTRING_H
`;

describe('QLever upstream normalized string libc++ patch asset', () => {
  it('rewrites normalized strings to char-backed std strings and views', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-normalized-string-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const target = path.join(qleverSource, 'src/parser/NormalizedString.h');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, normalizedStringFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(target, 'utf8');
      expect(patched).toContain('constexpr operator char() const noexcept');
      expect(patched).toContain('using NormalizedString = std::string;');
      expect(patched).toContain('using NormalizedStringView = std::string_view;');
      expect(patched).toContain('return normalizedStringView;');
      expect(patched).toContain('return input;');
      expect(patched).not.toContain('basic_string<NormalizedChar>');
      expect(patched).not.toContain('basic_string_view<NormalizedChar>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
