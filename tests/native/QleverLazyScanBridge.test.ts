import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const lazyScanBridgeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverLazyScanBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeMinimalQleverHeaders(root: string): Promise<string> {
  const qleverSource = path.join(root, 'qlever');
  await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
  await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  uint64_t getBits() const { return bits_; }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
class LocalVocab {};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  bool empty() const { return rows_.empty(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : table_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  const IdTable& idTable() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/CompressedRelation.h'), `
#pragma once
#include <memory>
#include <optional>
#include "engine/idTable/IdTable.h"

namespace ad_utility {
template <typename T, typename Details>
class InputRangeFromGet {
 public:
  virtual ~InputRangeFromGet() = default;
  virtual std::optional<T> get() = 0;
  Details& details() { return details_; }
 private:
  Details details_;
};

template <typename T, typename Details>
class InputRangeTypeErased {
 public:
  InputRangeTypeErased() = default;
  explicit InputRangeTypeErased(std::unique_ptr<InputRangeFromGet<T, Details>> impl)
      : impl_(std::move(impl)) {}
  std::optional<T> get() {
    if (!impl_) return std::nullopt;
    return impl_->get();
  }
  Details& details() { return impl_->details(); }
  bool has_value() const { return impl_ != nullptr; }
 private:
  std::unique_ptr<InputRangeFromGet<T, Details>> impl_;
};
}

class CompressedRelationReader {
 public:
  struct LazyScanMetadata {
    size_t numBlocksRead_ = 0;
    size_t numBlocksAll_ = 0;
    size_t numElementsRead_ = 0;
    size_t numElementsYielded_ = 0;
  };
  using IdTableGeneratorInputRange =
      ad_utility::InputRangeTypeErased<IdTable, LazyScanMetadata>;
};
`, 'utf8');
  return qleverSource;
}

describe('QLever lazy scan bridge', () => {
  it('adapts lower lazy scan blocks to a QLever IdTable generator range', async () => {
    expect(hasCxx(), 'c++ compiler is required for native lazy scan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-scan-bridge-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'lazy_scan_bridge_smoke.cpp');
      const binary = path.join(root, 'lazy_scan_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverLazyScanBridge.hpp"

int main() {
  xpod::qlever::QleverIdTableBlocksResult lower = {};
  lower.status = XPOD_RDF_STATUS_OK;
  IdTable first(2);
  first.push_back({Id::fromBits(11), Id::fromBits(33)});
  IdTable second(2);
  second.push_back({Id::fromBits(12), Id::fromBits(34)});
  second.push_back({Id::fromBits(13), Id::fromBits(35)});
  lower.blocks.push_back(std::move(first));
  lower.blocks.push_back(std::move(second));

  auto adapted = xpod::qlever::toQleverLazyScanRange(std::move(lower));
  if (adapted.status != XPOD_RDF_STATUS_OK) return 1;
  auto block1 = adapted.blocks.get();
  if (!block1.has_value()) return 2;
  if (block1->numColumns() != 2 || block1->numRows() != 1) return 3;
  if ((*block1)(0, 0).getBits() != 11 || (*block1)(0, 1).getBits() != 33) return 4;
  auto block2 = adapted.blocks.get();
  if (!block2.has_value()) return 5;
  if (block2->numColumns() != 2 || block2->numRows() != 2) return 6;
  if ((*block2)(1, 0).getBits() != 13 || (*block2)(1, 1).getBits() != 35) return 7;
  auto done = adapted.blocks.get();
  if (done.has_value()) return 8;
  auto& details = adapted.blocks.details();
  if (details.numBlocksAll_ != 2) return 9;
  if (details.numBlocksRead_ != 2) return 10;
  if (details.numElementsRead_ != 3 || details.numElementsYielded_ != 3) return 11;

  xpod::qlever::QleverIdTableBlocksResult unsupported = {};
  unsupported.status = XPOD_RDF_STATUS_UNSUPPORTED;
  auto unsupportedRange = xpod::qlever::toQleverLazyScanRange(std::move(unsupported));
  if (unsupportedRange.status != XPOD_RDF_STATUS_UNSUPPORTED) return 12;
  if (unsupportedRange.blocks.has_value()) return 13;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(lazyScanBridgeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
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
