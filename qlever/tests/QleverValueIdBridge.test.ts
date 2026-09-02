import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverValueIdBridge.hpp');
const localVocabBridgeHeader = path.join(
  repoRoot,
  'qlever/qlever_adapter/src/XpodQleverLocalVocabLiteralBridge.hpp',
);

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever ValueId bridge', () => {
  it('turns encoded id bits into upstream QLever Id values', async () => {
    expect(hasCxx(), 'c++ compiler is required for native ValueId bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-value-id-bridge-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
class LocalVocabIndex {
 public:
  static LocalVocabIndex make(uint64_t value) { return LocalVocabIndex(value); }
  uint64_t get() const { return value_; }
 private:
  explicit LocalVocabIndex(uint64_t value) : value_(value) {}
  uint64_t value_;
};
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeFromLocalVocabIndex(LocalVocabIndex index) {
    return Id(index.get());
  }
  uint64_t getBits() const { return bits_; }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "global/Id.h"
class LocalVocabContext {};
class LocalVocabEntry {
 public:
  static LocalVocabEntry literalWithoutQuotes(
      std::string_view value, const LocalVocabContext&) {
    return LocalVocabEntry(std::string(value));
  }
  const std::string& value() const { return value_; }
  bool operator==(const LocalVocabEntry& other) const {
    return value_ == other.value_;
  }
 private:
  explicit LocalVocabEntry(std::string value) : value_(std::move(value)) {}
  std::string value_;
};
class LocalVocab {
 public:
  LocalVocabIndex getIndexAndAddIfNotContained(LocalVocabEntry entry) {
    for (size_t index = 0; index < words_.size(); ++index) {
      if (words_[index] == entry) return LocalVocabIndex::make(index);
    }
    words_.push_back(std::move(entry));
    return LocalVocabIndex::make(words_.size() - 1);
  }
  const LocalVocabEntry& getWord(LocalVocabIndex index) const {
    return words_.at(index.get());
  }
 private:
  std::vector<LocalVocabEntry> words_;
};
`, 'utf8');

      const smoke = path.join(root, 'value_id_bridge_smoke.cpp');
      const binary = path.join(root, 'value_id_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverValueIdBridge.hpp"
#include "XpodQleverLocalVocabLiteralBridge.hpp"

int main() {
  Id id = xpod::qlever::toQleverId(12345);
  if (id.getBits() != 12345) return 1;
  LocalVocab vocab;
  LocalVocabContext context;
  Id literal = xpod::qlever::bridgeLocalVocabLiteralId(
      vocab, "chunk-101", context);
  if (vocab.getWord(LocalVocabIndex::make(literal.getBits())).value() !=
      "chunk-101") return 2;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(bridgeHeader),
        '-I', path.dirname(localVocabBridgeHeader),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
