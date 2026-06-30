import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeJoinHeader, fakeParsedQueryHeader, fakeQueryExecutionTreeHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverExecutor.cpp');
const bridgeSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever executor planner context provider', () => {
  it('keeps a native planner request context when the upstream context cannot receive the Xpod request', async () => {
    expect(hasCxx(), 'c++ compiler is required for native planner context provider check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-qec-provider-no-setter-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
class QueryExecutionContext {};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_no_setter_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_no_setter_smoke');
      await writeFile(smoke, `
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerContextProvider.hpp"

uint8_t always_cancelled(void*) { return 1; }

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_POSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES |
      XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE;
  out_capabilities->max_batch_size = 2048;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  xpod::rdf::PhysicalBackend physical(&raw_backend);
  auto provider = xpod::qlever::createQueryPlannerContextProvider(physical);
  xpod_rdf_cancellation cancellation = {};
  cancellation.is_cancelled = always_cancelled;
  xpod_qlever_query_request request = {};
  request.cancellation = &cancellation;
  auto context = provider->current(request);
  if (context.qec != nullptr) return 1;
  if (context.native == nullptr) return 2;
  if (context.native->request != &request) return 3;
  if (!context.native->backend.valid()) return 4;
  if (context.native->cancellation != &cancellation) return 5;
  if (context.native->capabilities_status != XPOD_RDF_STATUS_OK) return 6;
  if ((context.native->capabilities.supported_permutations & XPOD_RDF_PERM_CAP_POSG) == 0) return 7;
  if ((context.native->capabilities.features & XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES) == 0) return 8;
  if (context.native->capabilities.max_batch_size != 2048) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
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

  it('feeds a physical index into upstream contexts that expose a physical setter', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical context provider check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-qec-physical-provider-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
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
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), '#pragma once\nclass LocalVocab {};\n', 'utf8');
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
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include "XpodQleverPhysicalIndex.hpp"
class QueryExecutionContext {
 public:
  bool received_physical_index = false;
  uint64_t estimated_rows = 0;
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    auto estimate = index->permutation(Permutation::Enum::SPO).estimate();
    received_physical_index = index->context().backend.valid() &&
                              index->context().request != nullptr &&
                              estimate.status == XPOD_RDF_STATUS_OK;
    estimated_rows = estimate.estimate.rows;
  }
};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_physical_index_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_physical_index_smoke');
      await writeFile(smoke, `
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerContextProvider.hpp"

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 42;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.estimate_scan = estimate_scan;
  xpod::rdf::PhysicalBackend physical(&raw_backend);
  auto provider = xpod::qlever::createQueryPlannerContextProvider(physical);

  xpod_qlever_query_request request = {};
  auto context = provider->current(request);
  if (context.qec == nullptr) return 1;
  if (context.native == nullptr) return 2;
  if (!context.qec->received_physical_index) return 3;
  if (context.qec->estimated_rows != 42) return 4;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
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

  it('does not expose a non-default upstream context without the Xpod physical index hook', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical context provider check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-owned-qec-no-physical-hook-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
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
      await writeFile(path.join(qleverSource, 'src/util/AllocatorWithLimit.h'), `
#pragma once
namespace ad_utility {
template <typename T>
class AllocatorWithLimit {};
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() { return {}; }
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), `
#pragma once
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  explicit Index(ad_utility::AllocatorWithLimit<Id>) {}
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), '#pragma once\nclass LocalVocab {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  IdTable(size_t width, ad_utility::AllocatorWithLimit<Id>) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
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
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/SortPerformanceEstimator.h'), '#pragma once\nclass SortPerformanceEstimator {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/NamedResultCache.h'), '#pragma once\nclass NamedResultCache {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/MaterializedViews.h'), '#pragma once\nclass MaterializedViewsManager {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
class QueryResultCache {};
class QueryExecutionContext {
 public:
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index>,
      QueryResultCache*,
      ad_utility::AllocatorWithLimit<Id>,
      SortPerformanceEstimator,
      NamedResultCache*,
      std::shared_ptr<MaterializedViewsManager>) {}
};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_owned_qec_no_physical_hook_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_owned_qec_no_physical_hook_smoke');
      await writeFile(smoke, `
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerContextProvider.hpp"

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend physical(&raw_backend);
  auto provider = xpod::qlever::createQueryPlannerContextProvider(physical);

  xpod_qlever_query_request request = {};
  auto context = provider->current(request);
  if (context.qec != nullptr) return 1;
  if (context.native == nullptr) return 2;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
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

  it('constructs a non-default upstream QueryExecutionContext when standard QLever dependencies are available', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical context provider check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-owned-qec-provider-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
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
      await writeFile(path.join(qleverSource, 'src/util/AllocatorWithLimit.h'), `
#pragma once
namespace ad_utility {
template <typename T>
class AllocatorWithLimit {};
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() { return {}; }
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), `
#pragma once
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  explicit Index(ad_utility::AllocatorWithLimit<Id>) {}
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), '#pragma once\nclass LocalVocab {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  IdTable(size_t width, ad_utility::AllocatorWithLimit<Id>) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
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
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/SortPerformanceEstimator.h'), `
#pragma once
class SortPerformanceEstimator {};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/NamedResultCache.h'), `
#pragma once
class NamedResultCache {};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/MaterializedViews.h'), `
#pragma once
class MaterializedViewsManager {};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include "XpodQleverPhysicalIndex.hpp"
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
class QueryResultCache {};
class QueryExecutionContext {
 public:
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index> index,
      QueryResultCache* cache,
      ad_utility::AllocatorWithLimit<Id>,
      SortPerformanceEstimator,
      NamedResultCache* named_cache,
      std::shared_ptr<MaterializedViewsManager> materialized_views)
      : constructed(index != nullptr && cache != nullptr &&
                    named_cache != nullptr && materialized_views != nullptr) {}
  bool constructed = false;
  bool received_physical_index = false;
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    received_physical_index = index != nullptr &&
                              index->context().backend.valid() &&
                              index->context().request != nullptr;
  }
};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_owned_qec_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_owned_qec_smoke');
      await writeFile(smoke, `
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerContextProvider.hpp"

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  xpod::rdf::PhysicalBackend physical(&raw_backend);
  auto provider = xpod::qlever::createQueryPlannerContextProvider(physical);

  xpod_qlever_query_request request = {};
  auto context = provider->current(request);
  if (context.qec == nullptr) return 1;
  if (context.native == nullptr) return 2;
  if (!context.qec->constructed) return 3;
  if (!context.qec->received_physical_index) return 4;
  if (context.native->request != &request) return 5;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
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

  it('feeds an internal planner context into public adapter query execution', async () => {
    expect(hasCxx(), 'c++ compiler is required for native planner context provider check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-executor-qec-provider-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), '#pragma once\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string) { return ParsedQuery::minimalSelect(); } };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), '#pragma once\nnamespace ad_utility { struct SharedCancellationHandle {}; }\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include <string_view>
#include "xpod_qlever_adapter.h"
#include "XpodQleverPhysicalIndex.hpp"
#include "XpodQleverPlannerRequestContext.hpp"
class QueryExecutionContext {
 public:
  bool ready = false;
  bool received_physical_index = false;
  void setXpodPlannerRequestContext(const xpod::qlever::PlannerRequestContext& context) {
    ready = context.backend.valid() &&
            context.request != nullptr &&
            context.request->access_scope != nullptr &&
            std::string_view(context.request->snapshot.facts_version.data,
                             context.request->snapshot.facts_version.size) == "facts-v1";
  }
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    received_physical_index = index != nullptr && index->context().backend.valid();
  }
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
  std::vector<const QueryExecutionTree*> getChildren() const { return {}; }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/Operation.h"
#include "index/Permutation.h"
#include "parser/SparqlTriple.h"
class IndexScan final : public Operation {
 public:
  IndexScan()
      : subject_(Variable{"?s"}),
        predicate_(Variable{"?p"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::SPO) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  std::string getDescriptor() const override { return "executor QEC planner scan"; }
  size_t getResultWidth() const override { return 3; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), `
#pragma once
#include <memory>
#include "engine/IndexScan.h"
#include "engine/QueryExecutionContext.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"
class QueryPlanner {
 public:
  QueryPlanner(QueryExecutionContext* qec, ad_utility::SharedCancellationHandle)
      : qec_(qec) {}
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    if (qec_ == nullptr || !qec_->ready) {
      return QueryExecutionTree();
    }
    return QueryExecutionTree(std::make_shared<IndexScan>());
  }
 private:
  QueryExecutionContext* qec_;
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
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
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
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), '#pragma once\nclass LocalVocab {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');

      const smoke = path.join(root, 'executor_planner_context_provider_smoke.cpp');
      const binary = path.join(root, 'executor_planner_context_provider_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void*,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  static const char s[] = "urn:s";
  static const char p[] = "urn:p";
  static const char o[] = "urn:o";
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = XPOD_RDF_STATUS_OK;
    out_terms[i].kind = XPOD_RDF_TERM_IRI;
    if (keys[i] == 10) {
      out_terms[i].value = {s, 5};
    } else if (keys[i] == 20) {
      out_terms[i].value = {p, 5};
    } else if (keys[i] == 30) {
      out_terms[i].value = {o, 5};
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_quad_key rows[1] = {{10, 20, 30, 40}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.encode_qlever_id = encode;
  raw_backend.decode_qlever_id = decode;
  raw_backend.resolve_terms = resolve_terms;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan;

  xpod_qlever_adapter_config config = {};
  config.backend = &raw_backend;
  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  static const char facts_version[] = "facts-v1";
  xpod_rdf_access_scope access_scope = {};
  xpod_qlever_query_request request = {};
  request.sparql = {"SELECT * WHERE { ?s ?p ?o }", 27};
  request.snapshot.facts_version = {facts_version, 8};
  request.access_scope = &access_scope;
  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 2;
  if (profile.find("\\"descriptor\\":\\"executor QEC planner scan\\"") == std::string_view::npos) return 3;
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
        '-I', path.join(qleverSource, 'src'),
        adapterSource,
        executorSource,
        bridgeSource,
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
