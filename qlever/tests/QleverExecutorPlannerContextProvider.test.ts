import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  fakeEncodedIriManagerHeader,
  fakeExportIdsHeader,
  fakeExternalValuesHeader,
  fakeExternalValuesParsedQueryHeader,
  fakeJoinHeader,
  fakeRdfParserHeader,
  fakeSparqlTripleHeader,
  fakeTokenizerCtreHeader,
} from './qleverFakeHeaders';
import { qleverNativeIncludeArgs } from './qleverTestEnv';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSource = path.join(repoRoot, 'qlever/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverExecutor.cpp');
const bridgeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp');
const plannerContextProviderSource = path.join(
  repoRoot,
  'qlever/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp',
);

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever executor planner context provider', () => {
  it('lets bounded query allocation evict reusable QLever cache entries', async () => {
    const source = await readFile(plannerContextProviderSource, 'utf8');

    expect(source).toContain('cache->makeRoomAsMuchAsPossible');
    expect(source).toContain('MAKE_ROOM_SLACK_FACTOR *');
    expect(source).toMatch(
      /QueryResultCache cache_;\s+ad_utility::AllocatorWithLimit<Id> allocator_;/,
    );
  });

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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
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

  it('refreshes provider-owned planner snapshots after update mutations', async () => {
    expect(hasCxx(), 'c++ compiler is required for native planner context refresh check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-qec-provider-refresh-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
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
#include <string_view>
#include "XpodQleverPhysicalIndex.hpp"
#include "XpodQleverPlannerRequestContext.hpp"
class QueryExecutionContext {
 public:
  int bind_count = 0;
  bool saw_refreshed_facts = false;
  bool saw_cleared_stats = false;
  bool saw_physical_index = false;
  void setXpodPlannerRequestContext(const xpod::qlever::PlannerRequestContext& context) {
    ++bind_count;
    saw_refreshed_facts =
        context.request != nullptr &&
        std::string_view(context.request->snapshot.facts_version.data,
                         context.request->snapshot.facts_version.size) == "facts-v2";
    saw_cleared_stats =
        context.request != nullptr &&
        context.request->snapshot.stats_version.data == nullptr &&
        context.request->snapshot.stats_version.size == 0;
  }
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    saw_physical_index = index != nullptr &&
                         index->context().backend.valid() &&
                         index->context().request != nullptr;
  }
};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_refresh_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_refresh_smoke');
      await writeFile(smoke, `
#include <string_view>
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

  static const char facts_v1[] = "facts-v1";
  static const char stats_v1[] = "stats-v1";
  static const char facts_v2[] = "facts-v2";
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_v1, 8};
  request.snapshot.stats_version = {stats_v1, 8};
  auto context = provider->current(request);
  if (context.qec == nullptr) return 1;
  if (context.native == nullptr) return 2;
  if (context.native->request != &request) return 3;
  context.qec->bind_count = 0;
  context.qec->saw_refreshed_facts = false;
  context.qec->saw_cleared_stats = false;
  context.qec->saw_physical_index = false;

  xpod_rdf_mutation_result mutation_result = {};
  mutation_result.facts_version = {facts_v2, 8};
  if (!xpod::qlever::refreshPlannerContextAfterMutation(
          context, *context.native->request, mutation_result)) {
    return 4;
  }
  if (context.native->request == &request) return 5;
  if (std::string_view(context.native->request->snapshot.facts_version.data,
                       context.native->request->snapshot.facts_version.size) != "facts-v2") {
    return 6;
  }
  if (context.native->request->snapshot.stats_version.data != nullptr) return 7;
  if (context.native->request->snapshot.stats_version.size != 0) return 8;
  request.snapshot.facts_version = {};
  request.snapshot.stats_version = {};
  if (std::string_view(context.native->request->snapshot.facts_version.data,
                       context.native->request->snapshot.facts_version.size) != "facts-v2") {
    return 9;
  }
  if (context.qec->bind_count != 1) return 10;
  if (!context.qec->saw_refreshed_facts) return 11;
  if (!context.qec->saw_cleared_stats) return 12;
  if (!context.qec->saw_physical_index) return 13;

  context.qec->bind_count = 0;
  context.qec->saw_physical_index = false;
  mutation_result.facts_version = {};
  if (!xpod::qlever::refreshPlannerContextAfterMutation(
          context, *context.native->request, mutation_result)) {
    return 14;
  }
  if (context.native->request->snapshot.facts_version.data != nullptr) return 15;
  if (context.native->request->snapshot.facts_version.size != 0) return 16;
  if (context.native->request->snapshot.stats_version.data != nullptr) return 17;
  if (context.native->request->snapshot.stats_version.size != 0) return 18;
  if (context.qec->bind_count != 1) return 19;
  if (!context.qec->saw_physical_index) return 20;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
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

  it('guards update refresh against reusing exact statistics from stale facts', async () => {
    const provider = await readFile(plannerContextProviderSource, 'utf8');
    const bridge = await readFile(bridgeSource, 'utf8');

    expect(provider).toContain('refreshPlannerContextAfterMutation');
    expect(provider).toContain('snapshot.stats_version = {}');
    expect(provider).toContain('refreshPlannerRequestContext(*context, storage->request)');
    expect(provider).toMatch(/XpodPlannerRequestContextApplier<\s*QueryExecutionContext,/);
    expect(provider).not.toContain('std::unordered_map');
    expect(bridge).toContain('refreshPlannerContextAfterMutation(');
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
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
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
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), fakeExportIdsHeader, 'utf8');
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
#include <cstdint>
namespace ad_utility {
class MemorySize {
 public:
  static MemorySize bytes(uint64_t value) { return MemorySize(value); }
  uint64_t getBytes() const { return value_; }
 private:
  explicit MemorySize(uint64_t value) : value_(value) {}
  uint64_t value_;
};
template <typename T>
class AllocatorWithLimit {
 public:
  AllocatorWithLimit(uint64_t limit = 0) : limit_(limit) {}
  uint64_t limit() const { return limit_; }
 private:
  uint64_t limit_;
};
template <typename T>
AllocatorWithLimit<T> makeAllocatorWithLimit(MemorySize limit) {
  return AllocatorWithLimit<T>{limit.getBytes()};
}
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
#include <string>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  explicit Index(ad_utility::AllocatorWithLimit<Id>) {}
  void setOnDiskBase(const std::string&) {}
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
#include <functional>
#include <memory>
#include <string>
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
class QueryResultCache {
 public:
  void clearAll() {}
};
class QueryExecutionContext {
 public:
  enum struct DisableCaching { True, False, FromRuntimeParameter };
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index>,
      QueryResultCache*,
      ad_utility::AllocatorWithLimit<Id>,
      SortPerformanceEstimator,
      NamedResultCache*,
      std::shared_ptr<MaterializedViewsManager>,
      std::function<void(std::string)> = [](std::string) {},
      bool = false,
      bool = false,
      DisableCaching = DisableCaching::FromRuntimeParameter) {}
  void clearCacheUnpinnedOnly() {}
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
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
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
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
#include <cstdint>
namespace ad_utility {
class MemorySize {
 public:
  static MemorySize bytes(uint64_t value) { return MemorySize(value); }
  uint64_t getBytes() const { return value_; }
 private:
  explicit MemorySize(uint64_t value) : value_(value) {}
  uint64_t value_;
};
template <typename T>
class AllocatorWithLimit {
 public:
  AllocatorWithLimit(uint64_t limit = 0) : limit_(limit) {}
  uint64_t limit() const { return limit_; }
 private:
  uint64_t limit_;
};
template <typename T>
AllocatorWithLimit<T> makeAllocatorWithLimit(MemorySize limit) {
  return AllocatorWithLimit<T>{limit.getBytes()};
}
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
#include <string>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  explicit Index(ad_utility::AllocatorWithLimit<Id>) {}
  void setOnDiskBase(const std::string& value) { on_disk_base_ = value; }
  const std::string& getOnDiskBase() const { return on_disk_base_; }
 private:
  std::string on_disk_base_;
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
#include <functional>
#include <memory>
#include <string>
#include "XpodQleverPhysicalIndex.hpp"
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
class QueryResultCache {
 public:
  void clearAll() {}
};
class QueryExecutionContext {
 public:
  enum struct DisableCaching { True, False, FromRuntimeParameter };
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index> index,
      QueryResultCache* cache,
      ad_utility::AllocatorWithLimit<Id> allocator,
      SortPerformanceEstimator,
      NamedResultCache* named_cache,
      std::shared_ptr<MaterializedViewsManager> materialized_views,
      std::function<void(std::string)> = [](std::string) {},
      bool = false,
      bool = false,
      DisableCaching disable_caching = DisableCaching::FromRuntimeParameter)
      : constructed(index != nullptr && cache != nullptr &&
                    named_cache != nullptr && materialized_views != nullptr),
        memory_limit(allocator.limit()),
        disable_caching(disable_caching == DisableCaching::True),
        index_(std::move(index)) {}
  bool constructed = false;
  bool received_physical_index = false;
  uint64_t memory_limit = 0;
  bool disableCaching() const { return disable_caching; }
  bool onDiskBaseReady() const {
    return index_ != nullptr && !index_->getOnDiskBase().empty();
  }
  void clearCacheUnpinnedOnly() {}
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    received_physical_index = index != nullptr &&
                              index->context().backend.valid() &&
                              index->context().request != nullptr;
  }
 private:
  bool disable_caching = false;
  std::shared_ptr<const Index> index_;
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
  auto cached_provider = xpod::qlever::createQueryPlannerContextProvider(
      physical, 4096,
      xpod::qlever::QueryExecutionContextCacheMode::Cached);
  auto uncached_provider = xpod::qlever::createQueryPlannerContextProvider(
      physical, 4096,
      xpod::qlever::QueryExecutionContextCacheMode::Uncached);

  xpod_qlever_query_request request = {};
  auto context = cached_provider->current(request);
  if (context.qec == nullptr) return 1;
  if (context.native == nullptr) return 2;
  if (!context.qec->constructed) return 3;
  if (!context.qec->received_physical_index) return 4;
  if (context.native->request != &request) return 5;
  if (!context.qec->onDiskBaseReady()) return 6;
  if (context.qec->memory_limit != 4096) return 7;
  if (context.qec->disableCaching()) return 8;

  context = uncached_provider->current(request);
  if (context.qec == nullptr || !context.qec->disableCaching()) return 9;
  context = cached_provider->current(request);
  if (context.qec == nullptr || context.qec->disableCaching()) return 10;
  context = uncached_provider->current(request);
  if (context.qec == nullptr || !context.qec->disableCaching()) return 11;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
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

  it('clears pinned owned QLever cache entries before the owned index is destroyed', async () => {
    expect(hasCxx(), 'c++ compiler is required for native owned cache lifecycle check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-owned-qec-cache-lifecycle-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
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
#include <cstdint>
namespace ad_utility {
class MemorySize {
 public:
  static MemorySize bytes(uint64_t value) { return MemorySize(value); }
  uint64_t getBytes() const { return value_; }
 private:
  explicit MemorySize(uint64_t value) : value_(value) {}
  uint64_t value_;
};
template <typename T>
class AllocatorWithLimit {
 public:
  AllocatorWithLimit(uint64_t limit = 0) : limit_(limit) {}
 private:
  uint64_t limit_;
};
template <typename T>
AllocatorWithLimit<T> makeAllocatorWithLimit(MemorySize limit) {
  return AllocatorWithLimit<T>{limit.getBytes()};
}
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
#include <string>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  inline static bool alive = false;
  explicit Index(ad_utility::AllocatorWithLimit<Id>) { alive = true; }
  ~Index() { alive = false; }
  void setOnDiskBase(const std::string&) {}
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
#include <functional>
#include <memory>
#include <string>
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
inline bool qlever_cache_destructor_saw_destroyed_index = false;
class QueryResultCache {
 public:
  ~QueryResultCache() {
    if (pinned_entries_ + unpinned_entries_ > 0 && !Index::alive) {
      qlever_cache_destructor_saw_destroyed_index = true;
    }
  }
  void seedPinnedAndUnpinned() {
    pinned_entries_ = 1;
    unpinned_entries_ = 1;
  }
  void clearAll() {
    pinned_entries_ = 0;
    unpinned_entries_ = 0;
  }
  void clearUnpinnedOnly() { unpinned_entries_ = 0; }
 private:
  int pinned_entries_ = 0;
  int unpinned_entries_ = 0;
};
class QueryExecutionContext {
 public:
  enum struct DisableCaching { True, False, FromRuntimeParameter };
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index>,
      QueryResultCache* cache,
      ad_utility::AllocatorWithLimit<Id>,
      SortPerformanceEstimator,
      NamedResultCache*,
      std::shared_ptr<MaterializedViewsManager>,
      std::function<void(std::string)> = [](std::string) {},
      bool = false,
      bool = false,
      DisableCaching = DisableCaching::FromRuntimeParameter)
      : cache_(cache) {
    cache_->seedPinnedAndUnpinned();
  }
  void clearCacheUnpinnedOnly() { cache_->clearUnpinnedOnly(); }
 private:
  QueryResultCache* cache_;
};
`, 'utf8');

      const smoke = path.join(root, 'planner_context_provider_owned_qec_cache_lifecycle_smoke.cpp');
      const binary = path.join(root, 'planner_context_provider_owned_qec_cache_lifecycle_smoke');
      await writeFile(smoke, `
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerContextProvider.hpp"

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend physical(&raw_backend);
  {
    auto provider = xpod::qlever::createQueryPlannerContextProvider(physical);
    xpod_qlever_query_request request = {};
    provider->current(request);
  }
  if (qlever_cache_destructor_saw_destroyed_index) return 1;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });

      const source = await readFile(plannerContextProviderSource, 'utf8');
      expect(source).toContain('~OwnedPlannerContextProvider() noexcept');
      expect(source).toContain('cache_.clearAll();');
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
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), fakeExportIdsHeader, 'utf8');
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeExternalValuesParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ExternalValuesQuery.h'), '#pragma once\n#include "parser/ParsedQuery.h"\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/RdfParser.h'), fakeRdfParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), '#pragma once\n#include <string>\n#include <vector>\n#include "parser/ParsedQuery.h"\nclass EncodedIriManager;\nnamespace ad_utility { class BlankNodeManager; }\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string) { return ParsedQuery::minimalSelect(); } static std::vector<ParsedQuery> parseUpdate(ad_utility::BlankNodeManager*, EncodedIriManager*, std::string) { return {}; } };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/TokenizerCtre.h'), fakeTokenizerCtreHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), `
#pragma once
#include <stdexcept>
namespace ad_utility {
struct SharedCancellationHandle {};
class CancellationException : public std::runtime_error {
 public:
  CancellationException() : std::runtime_error("cancelled") {}
};
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/AllocatorWithLimit.h'), `
#pragma once
#include <stdexcept>
namespace ad_utility::detail {
class AllocationExceedsLimitException : public std::runtime_error {
 public:
  AllocationExceedsLimitException() : std::runtime_error("memory limit") {}
};
}
namespace ad_utility {
template <typename T>
class AllocatorWithLimit {};
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() { return {}; }
}
`, 'utf8');
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
      await writeFile(path.join(qleverSource, 'src/engine/ExternalValues.h'), fakeExternalValuesHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), `
#pragma once
#include <cstddef>
#include <memory>
#include <string>
#include <vector>
#include "engine/Operation.h"
#include "engine/Result.h"
#include "global/Id.h"
class QueryExecutionContext;
enum class LimitOffsetHandling { NONE };
class QueryExecutionTree {
 public:
  QueryExecutionTree() = default;
  QueryExecutionTree(QueryExecutionContext*, std::shared_ptr<Operation> root)
      : root_(std::move(root)) {}
  explicit QueryExecutionTree(std::shared_ptr<Operation> root)
      : root_(std::move(root)) {}
  bool isEmpty() const { return root_ == nullptr; }
  std::shared_ptr<Operation> getRootOperation() const { return root_; }
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return root_ == nullptr ? 0 : root_->getResultWidth(); }
  const std::vector<ColumnIndex>& resultSortedOn() const { return root_->getResultSortedOn(); }
  LimitOffsetHandling handlesLimitOffset() const {
    return LimitOffsetHandling::NONE;
  }
  std::shared_ptr<const Result> getResult(bool requestLaziness = false) const {
    if (root_ == nullptr) return nullptr;
    return root_->getResult(requestLaziness);
  }
 private:
  std::shared_ptr<Operation> root_;
  std::string descriptor_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Result.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
class QueryExecutionTree;
class ExternalValues;
struct ColumnIndexAndTypeInfo { ColumnIndex columnIndex_; };
using VariableToColumnMap = std::vector<std::pair<Variable, ColumnIndexAndTypeInfo>>;
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
  virtual void getExternalValues(std::vector<ExternalValues*>&) {}
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    static const VariableToColumnMap empty{};
    return empty;
  }
  std::shared_ptr<const Result> getResult(bool requestLaziness) {
    (void)requestLaziness;
    return std::make_shared<Result>(computeResult());
  }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
  virtual Result computeResult() {
    IdTable table(getResultWidth());
    return {std::move(table), resultSortedOn(), LocalVocab{}};
  }
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
#pragma once
#include <string>
#include <variant>
#include <vector>
#include "engine/QueryExecutionContext.h"
#include "engine/Operation.h"
#include "index/Permutation.h"
#include "parser/SparqlTriple.h"
class GraphFilter {
 public:
  struct AllTag {};
  using FilterType =
      std::variant<AllTag, TripleComponent, std::vector<TripleComponent>>;
  bool areAllGraphsAllowed() const { return true; }
  const FilterType& xpodPhysicalFilterType() const { return filter_; }
 private:
  FilterType filter_{AllTag{}};
};
class IndexScan final : public Operation {
 public:
  explicit IndexScan(QueryExecutionContext* qec = nullptr)
      : qec_(qec),
        subject_(Variable{"?s"}),
        predicate_(Variable{"?p"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::SPO) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  const std::vector<ColumnIndex>& additionalColumns() const { return additional_columns_; }
  const std::vector<Variable>& additionalVariables() const { return additional_variables_; }
  const GraphFilter& graphsToFilter() const { return graph_filter_; }
  const VariableToColumnMap& getExternallyVisibleVariableColumns() const override {
    variable_columns_.clear();
    variable_columns_.push_back({Variable{"?s"}, {0}});
    variable_columns_.push_back({Variable{"?p"}, {1}});
    variable_columns_.push_back({Variable{"?o"}, {2}});
    return variable_columns_;
  }
  std::string getDescriptor() const override { return "executor QEC planner scan"; }
  size_t getResultWidth() const override { return 3; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
  Result computeResult() override {
    (void)qec_;
    IdTable table(3);
    table.push_back({Id::fromBits(10), Id::fromBits(20), Id::fromBits(30)});
    return {std::move(table), resultSortedOn(), LocalVocab{}};
  }
 private:
  QueryExecutionContext* qec_;
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
  std::vector<ColumnIndex> additional_columns_;
  std::vector<Variable> additional_variables_;
  GraphFilter graph_filter_;
  mutable VariableToColumnMap variable_columns_;
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
    return QueryExecutionTree(qec_, std::make_shared<IndexScan>(qec_));
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
  template <typename Allocator>
  IdTable(size_t width, Allocator) : width_(width) {}
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
      await writeFile(path.join(qleverSource, 'src/global/RuntimeParameters.h'), `
#pragma once
struct RuntimeParameters {
  bool stripColumns_ = false;
  bool disableCaching_ = false;
};
template <auto Parameter, typename Value>
void setRuntimeParameter(Value) {}
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
        ...qleverNativeIncludeArgs(repoRoot, qleverSource),
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
  }, 15_000);
});
