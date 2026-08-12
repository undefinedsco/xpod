import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const lazyScanBridgeHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverLazyScanBridge.hpp');

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
#include <stdexcept>
#include <vector>
#include "global/Id.h"
inline bool xpod_test_throw_on_id_table_push_back = false;
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  bool empty() const { return rows_.empty(); }
  void push_back(const std::vector<Id>& row) {
    if (xpod_test_throw_on_id_table_push_back) {
      throw std::runtime_error("forced IdTable allocation failure");
    }
    rows_.push_back(row);
  }
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
  it('closes the cursor immediately and rethrows when materialization throws', async () => {
    expect(hasCxx(), 'c++ compiler is required for native lazy scan cursor exception check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-scan-throw-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'lazy_scan_throw_smoke.cpp');
      const binary = path.join(root, 'lazy_scan_throw_smoke');
      await writeFile(smoke, `
#include <stdexcept>
#include <vector>
#include "XpodQleverLazyScanBridge.hpp"

struct BackendState {
  int open_calls = 0;
  int next_calls = 0;
  int close_calls = 0;
  xpod_rdf_backend_v1 raw_backend = {};
  xpod_rdf_quad_key row = {11, 22, 33, 44};
};

static xpod_rdf_status open_scan_cursor(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_scan_cursor** out) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->open_calls;
  *out = reinterpret_cast<xpod_rdf_scan_cursor*>(state);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status next_scan_cursor(
    void* user_data,
    xpod_rdf_scan_cursor*,
    xpod_rdf_quad_batch* out) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->next_calls;
  *out = {&state->row, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  return XPOD_RDF_STATUS_OK;
}

static void close_scan_cursor(void* user_data, xpod_rdf_scan_cursor*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->close_calls;
}

int main() {
  BackendState state;
  state.raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  state.raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  state.raw_backend.backend_user_data = &state;
  state.raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  state.raw_backend.open_scan_cursor = open_scan_cursor;
  state.raw_backend.next_scan_cursor = next_scan_cursor;
  state.raw_backend.close_scan_cursor = close_scan_cursor;
  xpod::rdf::PhysicalBackend physical(&state.raw_backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;
  input.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  auto range = xpod::qlever::toQleverLazyScanRange(
      physical, input, ad_utility::makeUnlimitedAllocator<Id>());
  if (range.status != XPOD_RDF_STATUS_OK) return 1;

  xpod_test_throw_on_id_table_push_back = true;
  try {
    (void)range.blocks.get();
    return 2;
  } catch (const std::runtime_error&) {
  }
  xpod_test_throw_on_id_table_push_back = false;
  if (state.open_calls != 1 || state.next_calls != 1) return 3;
  if (state.close_calls != 1) return 4;
  if (range.blocks.get().has_value()) return 5;
  if (state.close_calls != 1 || state.next_calls != 1) return 6;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('deep-copies scan request state for cursor-backed lazy scans', async () => {
    expect(hasCxx(), 'c++ compiler is required for native lazy scan request ownership check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-scan-owned-request-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'lazy_scan_owned_request_smoke.cpp');
      const binary = path.join(root, 'lazy_scan_owned_request_smoke');
      await writeFile(smoke, `
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include "XpodQleverLazyScanBridge.hpp"

struct FakeCursor {
  const xpod_rdf_scan_request* request = nullptr;
  bool done = false;
};

struct BackendState {
  int open_calls = 0;
  int next_calls = 0;
  int close_calls = 0;
  FakeCursor cursor;
  xpod_rdf_backend_v1 raw_backend = {};
  xpod_rdf_quad_key row = {101, 202, 303, 404};
};

static bool bytesEqual(xpod_rdf_bytes bytes, const char* expected) {
  return bytes.size == std::strlen(expected) &&
         std::memcmp(bytes.data, expected, bytes.size) == 0;
}

static uint8_t is_cancelled(void* user_data) {
  return user_data == reinterpret_cast<void*>(0xCAFE) ? 0 : 1;
}

static int validateRequest(const xpod_rdf_scan_request* request) {
  if (request == nullptr) return 10;
  if (!bytesEqual(request->snapshot.facts_version, "facts-original")) return 11;
  if (!bytesEqual(request->snapshot.stats_version, "stats-original")) return 12;
  if (!bytesEqual(request->snapshot.snapshot_token, "token-original")) return 13;
  if (request->cancellation == nullptr) return 14;
  if (request->cancellation->cancellation_user_data != reinterpret_cast<void*>(0xCAFE)) return 15;
  if (request->cancellation->is_cancelled != is_cancelled) return 16;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_SET) return 17;
  if (!bytesEqual(request->graph_scope.iri_prefix, "graph-prefix-original")) return 18;
  if (request->graph_scope.graph_set_size != 2 ||
      request->graph_scope.graph_set[0] != 501 ||
      request->graph_scope.graph_set[1] != 502) return 19;
  if (!bytesEqual(request->source_scope.workspace, "workspace-original")) return 20;
  if (!bytesEqual(request->source_scope.source_uri, "source-uri-original")) return 21;
  if (!bytesEqual(request->source_scope.source_uri_prefix, "source-prefix-original")) return 22;
  if (!bytesEqual(request->source_scope.local_path, "local-path-original")) return 23;
  if (!bytesEqual(request->source_scope.local_path_prefix, "local-prefix-original")) return 24;
  if (request->access_scope == nullptr) return 25;
  if (!bytesEqual(request->access_scope->principal, "principal-original")) return 26;
  if (!bytesEqual(request->access_scope->permission_version, "permission-original")) return 27;
  if (request->access_scope->allowed_graphs_size != 2 ||
      request->access_scope->allowed_graphs[0] != 601 ||
      request->access_scope->allowed_graphs[1] != 602) return 28;
  if (request->access_scope->denied_graphs_size != 1 ||
      request->access_scope->denied_graphs[0] != 603) return 29;
  if (request->access_scope->allowed_graph_prefixes_size != 1 ||
      !bytesEqual(request->access_scope->allowed_graph_prefixes[0], "allow-prefix-original")) return 30;
  if (request->access_scope->denied_graph_prefixes_size != 1 ||
      !bytesEqual(request->access_scope->denied_graph_prefixes[0], "deny-prefix-original")) return 31;
  if (request->access_scope->allowed_sources_size != 1 ||
      request->access_scope->allowed_sources[0] != 701) return 32;
  if (request->access_scope->denied_sources_size != 1 ||
      request->access_scope->denied_sources[0] != 702) return 33;
  if (request->slot_range_count != 1 ||
      request->slot_ranges[0].slot != XPOD_RDF_SLOT_OBJECT ||
      request->slot_ranges[0].range.lower != 801 ||
      request->slot_ranges[0].range.upper != 802) return 34;
  if (request->block_metadata_count != 1 ||
      request->block_metadata[0].block_id != 901 ||
      request->block_metadata[0].first_quad.subject != 902 ||
      request->block_metadata[0].last_quad.object != 903) return 35;
  if (!bytesEqual(request->block_metadata_version, "block-version-original")) return 36;
  return 0;
}

static xpod_rdf_status open_scan_cursor(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_cursor** out) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->open_calls;
  const int validation = validateRequest(request);
  if (validation != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->cursor.request = request;
  state->cursor.done = false;
  *out = reinterpret_cast<xpod_rdf_scan_cursor*>(&state->cursor);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status next_scan_cursor(
    void* user_data,
    xpod_rdf_scan_cursor* cursor,
    xpod_rdf_quad_batch* out) {
  volatile char stack_noise[8192];
  for (size_t i = 0; i < sizeof(stack_noise); ++i) {
    stack_noise[i] = static_cast<char>(i);
  }
  (void)stack_noise;
  auto* state = static_cast<BackendState*>(user_data);
  ++state->next_calls;
  auto* fake = reinterpret_cast<FakeCursor*>(cursor);
  const int validation = validateRequest(fake->request);
  if (validation != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (fake->done) return XPOD_RDF_STATUS_DONE;
  fake->done = true;
  *out = {&state->row, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  return XPOD_RDF_STATUS_OK;
}

static void close_scan_cursor(void* user_data, xpod_rdf_scan_cursor* cursor) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->close_calls;
  auto* fake = reinterpret_cast<FakeCursor*>(cursor);
  if (validateRequest(fake->request) != 0) {
    state->close_calls += 100;
  }
}

static xpod_rdf_bytes bytes(std::string& value) {
  return {value.data(), value.size()};
}

static xpod::qlever::QleverLazyScanRangeResult makeOwnedRange(BackendState& state) {
  state.raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  state.raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  state.raw_backend.backend_user_data = &state;
  state.raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  state.raw_backend.open_scan_cursor = open_scan_cursor;
  state.raw_backend.next_scan_cursor = next_scan_cursor;
  state.raw_backend.close_scan_cursor = close_scan_cursor;
  xpod::rdf::PhysicalBackend physical(&state.raw_backend);

  std::string facts = "facts-original";
  std::string stats = "stats-original";
  std::string token = "token-original";
  xpod_rdf_snapshot snapshot = {bytes(facts), bytes(stats), bytes(token)};
  xpod_rdf_cancellation cancellation = {reinterpret_cast<void*>(0xCAFE), is_cancelled};
  std::string graph_prefix = "graph-prefix-original";
  std::vector<xpod_rdf_term_key> graph_set = {501, 502};
  xpod_rdf_graph_scope graph_scope = {
      XPOD_RDF_GRAPH_SCOPE_SET, 0, bytes(graph_prefix),
      graph_set.data(), graph_set.size()};

  std::string workspace = "workspace-original";
  std::string source_uri = "source-uri-original";
  std::string source_prefix = "source-prefix-original";
  std::string local_path = "local-path-original";
  std::string local_prefix = "local-prefix-original";
  xpod_rdf_source_scope source_scope = {};
  source_scope.workspace = bytes(workspace);
  source_scope.source_uri = bytes(source_uri);
  source_scope.source_uri_prefix = bytes(source_prefix);
  source_scope.local_path = bytes(local_path);
  source_scope.local_path_prefix = bytes(local_prefix);

  std::string principal = "principal-original";
  std::string permission = "permission-original";
  std::string allow_prefix_value = "allow-prefix-original";
  std::string deny_prefix_value = "deny-prefix-original";
  xpod_rdf_bytes allow_prefix = bytes(allow_prefix_value);
  xpod_rdf_bytes deny_prefix = bytes(deny_prefix_value);
  std::vector<xpod_rdf_term_key> allowed_graphs = {601, 602};
  std::vector<xpod_rdf_term_key> denied_graphs = {603};
  std::vector<xpod_rdf_source_node_key> allowed_sources = {701};
  std::vector<xpod_rdf_source_node_key> denied_sources = {702};
  xpod_rdf_access_scope access_scope = {};
  access_scope.principal = bytes(principal);
  access_scope.allowed_graphs = allowed_graphs.data();
  access_scope.allowed_graphs_size = allowed_graphs.size();
  access_scope.denied_graphs = denied_graphs.data();
  access_scope.denied_graphs_size = denied_graphs.size();
  access_scope.allowed_graph_prefixes = &allow_prefix;
  access_scope.allowed_graph_prefixes_size = 1;
  access_scope.denied_graph_prefixes = &deny_prefix;
  access_scope.denied_graph_prefixes_size = 1;
  access_scope.allowed_sources = allowed_sources.data();
  access_scope.allowed_sources_size = allowed_sources.size();
  access_scope.denied_sources = denied_sources.data();
  access_scope.denied_sources_size = denied_sources.size();
  access_scope.permission_version = bytes(permission);

  xpod_rdf_slot_term_range slot_range = {};
  slot_range.slot = XPOD_RDF_SLOT_OBJECT;
  slot_range.range.lower = 801;
  slot_range.range.upper = 802;
  slot_range.range.has_lower = 1;
  slot_range.range.has_upper = 1;

  xpod_rdf_scan_block_metadata block = {};
  block.block_id = 901;
  block.first_quad.subject = 902;
  block.last_quad.object = 903;
  std::string block_version = "block-version-original";

  xpod::qlever::ScanRequestInput input = {};
  input.snapshot = &snapshot;
  input.cancellation = &cancellation;
  input.permutation = Permutation::Enum::SPO;
  input.graph_scope = graph_scope;
  input.source_scope = &source_scope;
  input.access_scope = &access_scope;
  input.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  input.slot_ranges.push_back(slot_range);
  input.block_metadata.push_back(block);
  input.block_metadata_version = bytes(block_version);

  auto range = xpod::qlever::toQleverLazyScanRange(
      physical, input, ad_utility::makeUnlimitedAllocator<Id>());

  facts = "facts-mutated";
  stats = "stats-mutated";
  token = "token-mutated";
  cancellation = {reinterpret_cast<void*>(0xBAD), nullptr};
  graph_prefix = "graph-prefix-mutated";
  graph_set[0] = 999;
  workspace = "workspace-mutated";
  source_uri = "source-uri-mutated";
  source_prefix = "source-prefix-mutated";
  local_path = "local-path-mutated";
  local_prefix = "local-prefix-mutated";
  principal = "principal-mutated";
  permission = "permission-mutated";
  allow_prefix_value = "allow-prefix-mutated";
  deny_prefix_value = "deny-prefix-mutated";
  allowed_graphs[0] = 999;
  denied_graphs[0] = 999;
  allowed_sources[0] = 999;
  denied_sources[0] = 999;
  input.slot_ranges[0].range.lower = 999;
  input.block_metadata[0].block_id = 999;
  block_version = "block-version-mutated";
  return range;
}

int main() {
  BackendState state;
  auto range = makeOwnedRange(state);
  if (range.status != XPOD_RDF_STATUS_OK) return 1;
  auto block = range.blocks.get();
  if (!block.has_value()) return 2;
  if (block->numRows() != 1 || block->numColumns() != 2) return 3;
  if (state.open_calls != 1 || state.next_calls != 1) return 4;
  if (range.blocks.get().has_value()) return 5;
  if (state.close_calls != 1) return 6;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('pulls cursor-backed lazy scan batches only when the range is consumed', async () => {
    expect(hasCxx(), 'c++ compiler is required for native lazy scan cursor check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-scan-cursor-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'lazy_scan_cursor_smoke.cpp');
      const binary = path.join(root, 'lazy_scan_cursor_smoke');
      await writeFile(smoke, `
#include <stdexcept>
#include <vector>
#include "XpodQleverLazyScanBridge.hpp"

struct FakeCursor {
  size_t index = 0;
};

struct BackendState {
  int open_calls = 0;
  int next_calls = 0;
  int close_calls = 0;
  xpod_rdf_status next_error = XPOD_RDF_STATUS_OK;
  std::vector<std::vector<xpod_rdf_quad_key>> batches;
  FakeCursor cursor;
  xpod_rdf_backend_v1 raw_backend = {};
};

static xpod_rdf_status open_scan_cursor(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_cursor** out) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->open_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  state->cursor.index = 0;
  *out = reinterpret_cast<xpod_rdf_scan_cursor*>(&state->cursor);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status next_scan_cursor(
    void* user_data,
    xpod_rdf_scan_cursor* cursor,
    xpod_rdf_quad_batch* out) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->next_calls;
  if (state->next_error != XPOD_RDF_STATUS_OK) return state->next_error;
  auto* fake = reinterpret_cast<FakeCursor*>(cursor);
  if (fake->index >= state->batches.size()) return XPOD_RDF_STATUS_DONE;
  auto& rows = state->batches[fake->index++];
  *out = {rows.data(), rows.size(), XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, rows.size()};
  return XPOD_RDF_STATUS_OK;
}

static void close_scan_cursor(void* user_data, xpod_rdf_scan_cursor*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->close_calls;
}

static xpod::qlever::QleverLazyScanRangeResult makeRange(BackendState& state) {
  state.raw_backend = {};
  state.raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  state.raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  state.raw_backend.backend_user_data = &state;
  state.raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  state.raw_backend.open_scan_cursor = open_scan_cursor;
  state.raw_backend.next_scan_cursor = next_scan_cursor;
  state.raw_backend.close_scan_cursor = close_scan_cursor;
  xpod::rdf::PhysicalBackend physical(&state.raw_backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;
  input.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  return xpod::qlever::toQleverLazyScanRange(
      physical, input, ad_utility::makeUnlimitedAllocator<Id>());
}

int main() {
  BackendState state;
  state.batches = {
      {{11, 22, 33, 44}},
      {{12, 23, 34, 45}},
      {{13, 24, 35, 46}},
  };
  {
    auto range = makeRange(state);
    if (range.status != XPOD_RDF_STATUS_OK) return 1;
    if (state.open_calls != 0 || state.next_calls != 0) return 2;
    auto first = range.blocks.get();
    if (!first.has_value()) return 3;
    if (first->numRows() != 1 || first->numColumns() != 2) return 4;
    if ((*first)(0, 0).getBits() != 11 || (*first)(0, 1).getBits() != 33) return 5;
    if (state.open_calls != 1 || state.next_calls != 1) return 6;
  }
  if (state.close_calls != 1 || state.next_calls != 1) return 7;

  BackendState exhausted;
  exhausted.batches = {{{21, 22, 23, 24}}, {{31, 32, 33, 34}}, {{41, 42, 43, 44}}};
  {
    auto range = makeRange(exhausted);
    if (!range.blocks.get().has_value()) return 8;
    if (!range.blocks.get().has_value()) return 9;
    if (!range.blocks.get().has_value()) return 10;
    if (range.blocks.get().has_value()) return 11;
    if (exhausted.next_calls != 4) return 12;
    if (range.blocks.details().numBlocksRead_ != 3) return 13;
    if (range.blocks.details().numElementsRead_ != 3 ||
        range.blocks.details().numElementsYielded_ != 3) return 14;
  }
  if (exhausted.close_calls != 1) return 15;

  BackendState failing;
  failing.batches = {{{51, 52, 53, 54}}};
  failing.next_error = XPOD_RDF_STATUS_BACKEND_ERROR;
  try {
    auto range = makeRange(failing);
    (void)range.blocks.get();
    return 16;
  } catch (const std::runtime_error&) {
  }
  if (failing.close_calls != 1 || failing.next_calls != 1) return 17;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
