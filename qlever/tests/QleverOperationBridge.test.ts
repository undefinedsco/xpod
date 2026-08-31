import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const operationHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverOperationExecutor.hpp');
const bridgeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeFakeOperationQleverHeaders(root: string): Promise<string> {
  const qleverSource = path.join(root, 'qlever');
  await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
  await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cmath>
#include <cstdint>
#include <limits>
using ColumnIndex = uint64_t;
enum class Datatype { Undefined, LocalVocabIndex, TextRecordIndex, Int, Double };
class TextRecordIndex {
 public:
  static TextRecordIndex make(uint64_t value) { return TextRecordIndex(value); }
  uint64_t get() const { return value_; }
 private:
  explicit TextRecordIndex(uint64_t value) : value_(value) {}
  uint64_t value_;
};
class Id {
 public:
  static Id fromBits(uint64_t bits) {
    if ((bits >> 62) == 1) return Id(bits, Datatype::Int);
    if ((bits >> 62) == 2) return Id(bits, Datatype::Double);
    return Id(bits, Datatype::Undefined);
  }
  static Id makeUndefined() { return Id(UINT64_MAX, Datatype::Undefined); }
  static Id makeFromTextRecordIndex(TextRecordIndex index) {
    return Id(500000 + index.get(), Datatype::TextRecordIndex);
  }
  static Id makeFromLocalVocabIndex(uint64_t index) {
    return Id(index, Datatype::LocalVocabIndex);
  }
  static Id makeFromInt(int64_t value) {
    return Id(
        (1ULL << 62) |
            (static_cast<uint64_t>(value) & ((1ULL << 62) - 1)),
        Datatype::Int);
  }
  static Id makeFromDouble(double value) {
    constexpr uint64_t special = (1ULL << 62) - 16;
    if (std::isinf(value)) {
      return Id((2ULL << 62) | (special + (value < 0 ? 2 : 1)), Datatype::Double);
    }
    if (std::isnan(value)) {
      return Id((2ULL << 62) | (special + 3), Datatype::Double);
    }
    return Id(
        (2ULL << 62) | static_cast<uint64_t>(value * 1000),
        Datatype::Double);
  }
  uint64_t getBits() const { return bits_; }
  Datatype getDatatype() const { return datatype_; }
  uint64_t getLocalVocabIndex() const { return bits_; }
  bool isInt() const { return datatype_ == Datatype::Int; }
  bool isDouble() const { return datatype_ == Datatype::Double; }
  int64_t getInt() const {
    uint64_t payload = bits_ & ((1ULL << 62) - 1);
    if ((payload & (1ULL << 61)) != 0) {
      payload |= (3ULL << 62);
    }
    return static_cast<int64_t>(payload);
  }
  double getDouble() const {
    constexpr uint64_t special = (1ULL << 62) - 16;
    const uint64_t payload = bits_ & ((1ULL << 62) - 1);
    if (payload == special + 1) {
      return std::numeric_limits<double>::infinity();
    }
    if (payload == special + 2) {
      return -std::numeric_limits<double>::infinity();
    }
    if (payload == special + 3) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    return static_cast<double>(payload) / 1000;
  }
  friend bool operator<(const Id& left, const Id& right) {
    return left.bits_ < right.bits_;
  }
 private:
  Id(uint64_t bits, Datatype datatype) : bits_(bits), datatype_(datatype) {}
  uint64_t bits_;
  Datatype datatype_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/global/ValueId.h'), `
#pragma once
#include "global/Id.h"
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
#include <string>
#include <string_view>
#include <utility>
#include <vector>
class FakeLocalVocabWord {
 public:
  FakeLocalVocabWord() = default;
  FakeLocalVocabWord(std::string value, std::string datatype)
      : value_(std::move(value)), datatype_(std::move(datatype)) {}
  bool isIri() const { return false; }
  bool isLiteral() const { return !datatype_.empty(); }
  std::string_view getIriContent() const { return {}; }
  std::string_view getLiteralContent() const { return value_; }
  bool hasLanguageTag() const { return false; }
  bool hasDatatype() const { return !datatype_.empty(); }
  std::string_view getLanguageTag() const { return {}; }
  std::string_view getDatatype() const { return datatype_; }
 private:
  std::string value_;
  std::string datatype_;
};
class LocalVocab {
 public:
  LocalVocab() = default;
  LocalVocab(const LocalVocab&) = delete;
  LocalVocab& operator=(const LocalVocab&) = delete;
  LocalVocab(LocalVocab&&) noexcept = default;
  LocalVocab& operator=(LocalVocab&&) noexcept = default;
  LocalVocab clone() const {
    LocalVocab copy;
    copy.words_ = words_;
    return copy;
  }
  uint64_t addLiteral(std::string value, std::string datatype) {
    words_.emplace_back(std::move(value), std::move(datatype));
    return words_.size() - 1;
  }
  uint64_t getIndexAndAddIfNotContained(const FakeLocalVocabWord& word) {
    words_.push_back(word);
    return words_.size() - 1;
  }
  const FakeLocalVocabWord& getWord(uint64_t) const {
    if (!words_.empty()) return words_.front();
    static const FakeLocalVocabWord word;
    return word;
  }
 private:
  std::vector<FakeLocalVocabWord> words_;
};
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
  return qleverSource;
}

describe('QLever native physical operation bridge', () => {
  it('keeps query bridge delegated to the native physical operation executor', () => {
    const source = readFileSync(bridgeSource, 'utf8');

    expect(source).toContain('executeBridgeOperationPlan');
    expect(source).toContain('isBridgeCandidateRoot(plan.root.kind)');
    expect(source).toContain('writeCandidateSparqlJson');
    expect(source).not.toContain('QLever bridge query produced candidate rows');
    expect(source).not.toContain('collectFilterSubjectKeys');
    expect(source).not.toContain('filterResultBySubject');
  });

  it('orders QLever ids through the backend term comparator when ids are opaque', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation ordering bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-compare-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_compare_smoke.cpp');
      const binary = path.join(root, 'operation_compare_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

struct State {
  int scan_calls = 0;
  int compare_calls = 0;
  int resolve_calls = 0;
  bool semantic_order_scan = false;
  uint32_t requested_order_slots[XPOD_RDF_SCAN_ORDER_MAX_SLOTS] = {};
  xpod_rdf_scan_order_kind
      requested_order_kinds[XPOD_RDF_SCAN_ORDER_MAX_SLOTS] = {};
  size_t requested_order_count = 0;
  uint64_t requested_limit = 0;
  uint64_t requested_offset = 0;
};

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = 1000 - term;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_ids(
    void* user_data,
    uint64_t left_bits,
    uint64_t right_bits,
    int32_t* out_compare) {
  auto* state = static_cast<State*>(user_data);
  ++state->compare_calls;
  uint64_t left_term = 1000 - left_bits;
  uint64_t right_term = 1000 - right_bits;
  *out_compare = left_term < right_term ? -1 : (left_term > right_term ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void* user_data,
    const xpod_rdf_term_key*,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term*,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<State*>(user_data);
  ++state->resolve_calls;
  for (size_t index = 0; index < key_count; ++index) {
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<State*>(user_data);
  ++state->scan_calls;
  state->requested_order_count = request->order.count;
  for (size_t index = 0; index < request->order.count; ++index) {
    state->requested_order_slots[index] = request->order.slots[index];
    state->requested_order_kinds[index] = request->order.kinds[index];
  }
  state->requested_limit = request->limit;
  state->requested_offset = request->offset;
  if (state->semantic_order_scan) {
    std::vector<xpod_rdf_quad_key> rows;
    for (uint64_t term = request->offset + 1;
         term <= request->offset + request->limit; ++term) {
      rows.push_back({term, 20, 30, 0});
    }
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows.data();
    batch.row_count = rows.size();
    batch.sorted_slots = XPOD_RDF_SLOT_SUBJECT;
    return on_batch(callback_user_data, &batch);
  }
  std::vector<xpod_rdf_quad_key> rows(1000);
  for (size_t index = 0; index < rows.size(); ++index) {
    rows[index] = {((index * 541) % 1000) + 1, 20, 30, 0};
  }
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows.data();
  batch.row_count = rows.size();
  return on_batch(callback_user_data, &batch);
}

int main() {
  if (xpod::qlever::slotForColumn(
          Permutation::Enum::SPO, XPOD_RDF_SLOT_GRAPH, 0) !=
      XPOD_RDF_SLOT_GRAPH) return 43;

  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_OPAQUE;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = [](void*, uint64_t bits, xpod_rdf_term_key* out) {
    *out = 1000 - bits;
    return XPOD_RDF_STATUS_OK;
  };
  backend.resolve_terms = resolve_terms;
  backend.compare_qlever_ids = compare_ids;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan scan_node;
  scan_node.scan.permutation = Permutation::Enum::SPO;
  scan_node.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  scan_node.result_width = 3;
  plan.scans.push_back(scan_node);
  plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  plan.root.scan_indexes = {0};
  xpod::qlever::BridgeResultModifier modifier;
  modifier.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  modifier.columns = {0, 1, 2};
  modifier.descending = {false, false, false};
  plan.root.result_modifiers.push_back(modifier);
  xpod::qlever::BridgeResultModifier page;
  page.kind = xpod::qlever::BridgeResultModifierKind::LimitOffset;
  page.limit = 5;
  page.offset = 2;
  plan.root.result_modifiers.push_back(page);

  auto result = xpod::qlever::executeBridgeOperationPlan(physical, plan);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (state.scan_calls != 1) return 2;
  if (state.resolve_calls != 2) return 8;
  if (state.compare_calls == 0 || state.compare_calls >= 5000) return 3;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 3 || table.numRows() != 5) return 4;
  if (table(0, 0).getBits() != 997) return 5;
  if (table(1, 0).getBits() != 996) return 6;
  if (table(4, 0).getBits() != 993) return 7;

  state = {};
  state.semantic_order_scan = true;
  backend.get_capabilities = [](void*, xpod_rdf_backend_capabilities* out) {
    *out = {};
    out->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
    out->features = XPOD_RDF_BACKEND_FEATURE_SEMANTIC_ORDER_SCAN |
                    XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
                    XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET;
    return XPOD_RDF_STATUS_OK;
  };
  auto pushed = xpod::qlever::executeBridgeOperationPlan(physical, plan);
  if (pushed.status != XPOD_RDF_STATUS_OK) return 9;
  if (state.scan_calls != 1 || state.compare_calls != 0 ||
      state.resolve_calls != 1) return 10;
  if (state.requested_order_count != 3 ||
      state.requested_order_slots[0] != XPOD_RDF_SLOT_SUBJECT ||
      state.requested_order_slots[1] != XPOD_RDF_SLOT_PREDICATE ||
      state.requested_order_slots[2] != XPOD_RDF_SLOT_OBJECT ||
      state.requested_order_kinds[0] != XPOD_RDF_SCAN_ORDER_ASC ||
      state.requested_order_kinds[1] != XPOD_RDF_SCAN_ORDER_ASC ||
      state.requested_order_kinds[2] != XPOD_RDF_SCAN_ORDER_ASC ||
      state.requested_limit != 5 || state.requested_offset != 2) return 11;
  const IdTable& pushed_table = pushed.result.idTable();
  if (pushed_table.numRows() != 5 || pushed_table(0, 0).getBits() != 997 ||
      pushed_table(4, 0).getBits() != 993) return 12;

  state = {};
  plan.root.result_modifiers[0].columns = {0};
  plan.root.result_modifiers[0].descending = {false};
  plan.scans[0].scan.pattern.has_predicate = true;
  plan.scans[0].scan.pattern.predicate = 20;
  auto constrained = xpod::qlever::executeBridgeOperationPlan(physical, plan);
  if (constrained.status != XPOD_RDF_STATUS_OK) return 13;
  if (state.scan_calls != 1 || state.compare_calls == 0 ||
      state.resolve_calls != 2) return 14;
  if (state.requested_order_count != 0 || state.requested_limit != 0 ||
      state.requested_offset != 0) return 15;
  const IdTable& constrained_table = constrained.result.idTable();
  if (constrained_table.numRows() != 5 ||
      constrained_table(0, 0).getBits() != 997 ||
      constrained_table(4, 0).getBits() != 993) return 16;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
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

  it('keeps semantic numeric filters before ORDER BY and LIMIT modifiers', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation filter ordering bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-filter-page-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_filter_page_smoke.cpp');
      const binary = path.join(root, 'operation_filter_page_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <vector>

struct State {
  int scan_calls = 0;
  size_t requested_order_count = 0;
  uint64_t requested_limit = 0;
  uint64_t requested_offset = 0;
  size_t requested_filter_count = 0;
};

static uint64_t encode_term_bits(xpod_rdf_term_key term) {
  return term == 0 ? Id::makeUndefined().getBits() : term + 1000;
}

static xpod_rdf_term_key decode_term_bits(uint64_t bits) {
  return bits == Id::makeUndefined().getBits() ? 0 : bits - 1000;
}

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = encode_term_bits(term);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = decode_term_bits(bits);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_ids(
    void*,
    uint64_t left_bits,
    uint64_t right_bits,
    int32_t* out_compare) {
  if (left_bits == Id::makeUndefined().getBits() ||
      right_bits == Id::makeUndefined().getBits()) {
    if (left_bits == right_bits) {
      *out_compare = 0;
    } else {
      *out_compare = left_bits == Id::makeUndefined().getBits() ? -1 : 1;
    }
    return XPOD_RDF_STATUS_OK;
  }
  const xpod_rdf_term_key left = decode_term_bits(left_bits);
  const xpod_rdf_term_key right = decode_term_bits(right_bits);
  *out_compare = left < right ? -1 : (left > right ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_SEMANTIC_ORDER_SCAN |
      XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
      XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<State*>(user_data);
  state->scan_calls += 1;
  state->requested_order_count = request->order.count;
  state->requested_limit = request->limit;
  state->requested_offset = request->offset;
  state->requested_filter_count = request->filter_count;
  if (request->permutation != XPOD_RDF_PERM_SPOG ||
      !request->pattern.has_predicate ||
      request->pattern.predicate != 20 ||
      request->pattern.has_object) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_quad_key rows[4] = {
      {1, 20, 7, 40},
      {2, 20, 0, 40},
      {3, 20, 11, 40},
      {4, 20, 12, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 4;
  return on_batch(callback_user_data, &batch);
}

static xpod::qlever::BridgePhysicalPlan make_plan(
    xpod_rdf_term_key lower_bound,
    bool descending) {
  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan scan_node;
  scan_node.scan.permutation = Permutation::Enum::SPO;
  scan_node.scan.pattern.has_predicate = true;
  scan_node.scan.pattern.predicate = 20;
  scan_node.scan.needed_slots = XPOD_RDF_SLOT_OBJECT;
  scan_node.result_width = 1;
  plan.scans.push_back(scan_node);
  plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  plan.root.scan_indexes = {0};

  xpod::qlever::BridgeResultModifier duplicate_semantic_filter;
  duplicate_semantic_filter.kind =
      xpod::qlever::BridgeResultModifierKind::GreaterThanTerm;
  duplicate_semantic_filter.columns = {0};
  duplicate_semantic_filter.has_term_id_bits = true;
  duplicate_semantic_filter.term_id_bits = encode_term_bits(lower_bound);

  xpod::qlever::BridgeResultModifier order;
  order.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  order.columns = {0};
  order.descending = {descending};

  xpod::qlever::BridgeResultModifier page;
  page.kind = xpod::qlever::BridgeResultModifierKind::LimitOffset;
  page.limit = 1;
  page.offset = 0;

  plan.root.result_modifiers = {
      duplicate_semantic_filter,
      order,
      page,
  };
  return plan;
}

static int assert_single_decoded_row(
    const xpod::qlever::QleverResultWithStatus& result,
    xpod_rdf_term_key expected) {
  if (result.status != XPOD_RDF_STATUS_OK) return 20 + result.status;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 1 || table.numRows() != 1) return 2;
  const Id& actual = table(0, 0);
  if (actual.isInt()) {
    return actual.getInt() == static_cast<int64_t>(expected) ? 0 : 3;
  }
  const xpod_rdf_term_key actual_term = decode_term_bits(actual.getBits());
  if (actual_term != expected) return 3;
  return 0;
}

static int assert_scan_not_paged(const State& state) {
  if (state.scan_calls != 1) return 1;
  if (state.requested_order_count != 0) return 2;
  if (state.requested_limit != 0 || state.requested_offset != 0) return 3;
  if (state.requested_filter_count != 0) return 4;
  return 0;
}

int main() {
  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.compare_qlever_ids = compare_ids;
  backend.get_capabilities = get_capabilities;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  auto descending = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(8, true));
  if (assert_single_decoded_row(descending, 12) != 0) return 1;
  if (assert_scan_not_paged(state) != 0) return 2;

  state = {};
  auto ascending = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(8, false));
  if (assert_single_decoded_row(ascending, 11) != 0) return 3;
  if (assert_scan_not_paged(state) != 0) return 4;

  state = {};
  auto non_selective_descending = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(6, true));
  if (assert_single_decoded_row(non_selective_descending, 12) != 0) return 5;
  if (assert_scan_not_paged(state) != 0) return 6;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
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

  it('compares inline numeric FILTER constants against physical numeric literals', async () => {
    expect(hasCxx(), 'c++ compiler is required for inline numeric comparison bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-inline-numeric-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_inline_numeric_smoke.cpp');
      const binary = path.join(root, 'operation_inline_numeric_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <string>

struct State {
  int scan_calls = 0;
  int compare_calls = 0;
  int inline_compare_calls = 0;
  int resolve_calls = 0;
};

static uint64_t encode_term_bits(xpod_rdf_term_key term) {
  return term + 1000;
}

static xpod_rdf_term_key decode_term_bits(uint64_t bits) {
  return bits - 1000;
}

static bool is_inline_bits(uint64_t bits) {
  return (bits >> 62) != 0;
}

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = encode_term_bits(term);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  if (is_inline_bits(bits)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  *out_term = decode_term_bits(bits);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_ids(
    void* user_data,
    uint64_t left_bits,
    uint64_t right_bits,
    int32_t* out_compare) {
  auto* state = static_cast<State*>(user_data);
  ++state->compare_calls;
  if (is_inline_bits(left_bits) || is_inline_bits(right_bits)) {
    ++state->inline_compare_calls;
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const xpod_rdf_term_key left = decode_term_bits(left_bits);
  const xpod_rdf_term_key right = decode_term_bits(right_bits);
  *out_compare = left < right ? -1 : (left > right ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve(
    void* user_data,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_term) {
  auto* state = static_cast<State*>(user_data);
  ++state->resolve_calls;
  static const std::string datatype = "http://www.w3.org/2001/XMLSchema#integer";
  static const std::string value_7 = "7";
  static const std::string value_8 = "8";
  static const std::string value_11 = "11";
  static const std::string value_12 = "12";
  const std::string* value = nullptr;
  if (key == 7) value = &value_7;
  if (key == 8) value = &value_8;
  if (key == 11) value = &value_11;
  if (key == 12) value = &value_12;
  if (value == nullptr) return XPOD_RDF_STATUS_NOT_FOUND;
  out_term->kind = XPOD_RDF_TERM_LITERAL;
  out_term->value = {value->data(), value->size()};
  out_term->datatype_iri = {datatype.data(), datatype.size()};
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<State*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG ||
      !request->pattern.has_predicate ||
      request->pattern.predicate != 20 ||
      request->pattern.has_object) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_quad_key rows[2] = {
      {3, 20, 11, 40},
      {4, 20, 12, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  return on_batch(callback_user_data, &batch);
}

static xpod::qlever::BridgePhysicalPlan make_plan(
    uint64_t lower_bound_bits,
    bool descending) {
  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan scan_node;
  scan_node.scan.permutation = Permutation::Enum::SPO;
  scan_node.scan.pattern.has_predicate = true;
  scan_node.scan.pattern.predicate = 20;
  scan_node.scan.needed_slots = XPOD_RDF_SLOT_OBJECT;
  scan_node.result_width = 1;
  plan.scans.push_back(scan_node);
  plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  plan.root.scan_indexes = {0};

  xpod::qlever::BridgeResultModifier semantic_filter;
  semantic_filter.kind = xpod::qlever::BridgeResultModifierKind::GreaterThanTerm;
  semantic_filter.columns = {0};
  semantic_filter.has_term_id_bits = true;
  semantic_filter.term_id_bits = lower_bound_bits;

  xpod::qlever::BridgeResultModifier order;
  order.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  order.columns = {0};
  order.descending = {descending};

  xpod::qlever::BridgeResultModifier page;
  page.kind = xpod::qlever::BridgeResultModifierKind::LimitOffset;
  page.limit = 1;
  page.offset = 0;

  plan.root.result_modifiers = {semantic_filter, order, page};
  return plan;
}

static int assert_single_decoded_row(
    const xpod::qlever::QleverResultWithStatus& result,
    xpod_rdf_term_key expected) {
  if (result.status != XPOD_RDF_STATUS_OK) return 20 + result.status;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 1 || table.numRows() != 1) return 2;
  const Id& actual = table(0, 0);
  if (actual.isInt()) {
    return actual.getInt() == static_cast<int64_t>(expected) ? 0 : 3;
  }
  if (decode_term_bits(actual.getBits()) != expected) return 3;
  return 0;
}

int main() {
  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.compare_qlever_ids = compare_ids;
  backend.resolve_term = resolve;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  auto descending = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(Id::makeFromInt(8).getBits(), true));
  int descending_check = assert_single_decoded_row(descending, 12);
  if (descending_check != 0) return descending_check;
  if (state.scan_calls != 1) return 2;
  if (state.compare_calls == 0 || state.inline_compare_calls != 0) return 4;

  state = {};
  auto ascending = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(Id::makeFromInt(8).getBits(), false));
  int ascending_check = assert_single_decoded_row(ascending, 11);
  if (ascending_check != 0) return ascending_check;
  if (state.scan_calls != 1) return 6;
  if (state.compare_calls == 0 || state.inline_compare_calls != 0) return 8;

  state = {};
  auto decimal_bound = xpod::qlever::executeBridgeOperationPlan(
      physical, make_plan(Id::makeFromDouble(8.5).getBits(), false));
  int decimal_check = assert_single_decoded_row(decimal_bound, 11);
  if (decimal_check != 0) return decimal_check;
  if (state.compare_calls == 0 || state.inline_compare_calls != 0) return 11;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
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

  it('compares inline nonfinite and local-vocab numeric ids without backend fallback', async () => {
    expect(hasCxx(), 'c++ compiler is required for inline numeric id comparison check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-inline-special-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_inline_special_smoke.cpp');
      const binary = path.join(root, 'operation_inline_special_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <limits>

struct State {
  int compare_calls = 0;
};

static bool is_inline_bits(uint64_t bits) {
  return (bits >> 62) != 0;
}

static xpod_rdf_status compare_ids(
    void* user_data,
    uint64_t left_bits,
    uint64_t right_bits,
    int32_t*) {
  auto* state = static_cast<State*>(user_data);
  ++state->compare_calls;
  return is_inline_bits(left_bits) || is_inline_bits(right_bits)
      ? XPOD_RDF_STATUS_UNSUPPORTED
      : XPOD_RDF_STATUS_OK;
}

static int assert_compare(
    const xpod::rdf::PhysicalBackend& physical,
    const Id& left,
    const Id& right,
    const LocalVocab* local_vocab,
    int expected_sign) {
  int32_t compare = 0;
  xpod_rdf_status status = xpod::qlever::compareBridgeIds(
      physical, left, right, local_vocab, compare);
  if (status != XPOD_RDF_STATUS_OK) return 10 + status;
  if (expected_sign == 0 && compare != 0) return 20;
  if (expected_sign < 0 && compare >= 0) return 21;
  if (expected_sign > 0 && compare <= 0) return 22;
  return 0;
}

int main() {
  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.compare_qlever_ids = compare_ids;
  xpod::rdf::PhysicalBackend physical(&backend);

  const Id finite = Id::makeFromDouble(1.0);
  const Id positive_inf =
      Id::makeFromDouble(std::numeric_limits<double>::infinity());
  const Id negative_inf =
      Id::makeFromDouble(-std::numeric_limits<double>::infinity());
  const Id nan =
      Id::makeFromDouble(std::numeric_limits<double>::quiet_NaN());

  int check = assert_compare(physical, positive_inf, finite, nullptr, 1);
  if (check != 0) return check;
  check = assert_compare(physical, negative_inf, finite, nullptr, -1);
  if (check != 0) return check;
  check = assert_compare(physical, nan, nan, nullptr, 0);
  if (check != 0) return check;
  if (state.compare_calls != 0) return 30;

  LocalVocab vocab;
  const uint64_t local_index =
      vocab.addLiteral("8", "http://www.w3.org/2001/XMLSchema#integer");
  const Id local_eight = Id::makeFromLocalVocabIndex(local_index);
  const Id inline_eight = Id::makeFromInt(8);

  check = assert_compare(physical, local_eight, inline_eight, &vocab, 0);
  if (check != 0) return 40 + check;
  check = assert_compare(physical, inline_eight, local_eight, &vocab, 0);
  if (check != 0) return 60 + check;
  if (state.compare_calls != 0) return 31;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
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

  it('executes a hash-join physical plan without TS planner mediation', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-bridge-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_bridge_smoke.cpp');
      const binary = path.join(root, 'operation_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_ids(
    void*, uint64_t left, uint64_t right, int32_t* out_compare) {
  *out_compare = left < right ? -1 : (left > right ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

struct ScanState { int calls = 0; };

struct ProfileState {
  int calls = 0;
  xpod_rdf_profile_kind kinds[16] = {};
  xpod_rdf_profile_status statuses[16] = {};
  xpod_rdf_profile_node_key nodes[16] = {};
  xpod_rdf_profile_node_key parents[16] = {};
  uint8_t has_parents[16] = {};
  uint64_t output_rows[16] = {};
};

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  auto* state = static_cast<ProfileState*>(user_data);
  int index = state->calls++;
  if (index >= 16) return;
  state->kinds[index] = event->kind;
  state->statuses[index] = event->status;
  state->nodes[index] = event->node;
  state->parents[index] = event->parent;
  state->has_parents[index] = event->has_parent;
  state->output_rows[index] = event->output_rows;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t index = 0;
  for (; expected[index] != '\\0'; ++index) {
    if (index >= actual.size || actual.data[index] != expected[index]) {
      return false;
    }
  }
  return index == actual.size;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG |
      XPOD_RDF_PERM_CAP_SOPG |
      XPOD_RDF_PERM_CAP_PSOG |
      XPOD_RDF_PERM_CAP_POSG |
      XPOD_RDF_PERM_CAP_OSPG |
      XPOD_RDF_PERM_CAP_OPSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
      XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void*,
    const xpod_rdf_text_search_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (!bytes_equal(request->query, "native-first")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate row = {};
  row.has_retrieval_point = 1;
  row.retrieval_point = 101;
  row.has_retrieval_point_key = 1;
  row.retrieval_point_key = {"chunk-native-first", 18};
  row.has_resource_term = 1;
  row.resource_term = 11;
  row.score = 0.9;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 3;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status estimate_vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->dimensions != 2) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->provider, "xpod")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model, "embed-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model_version, "2026-08-12") ||
      !bytes_equal(request->input_kind, "entity-card") ||
      !bytes_equal(request->projection_policy_version, "policy-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request->dimensions != 2) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->provider, "xpod")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model, "embed-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model_version, "2026-08-12") ||
      !bytes_equal(request->input_kind, "entity-card") ||
      !bytes_equal(request->projection_policy_version, "policy-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate row = {};
  row.has_resource_term = 1;
  row.resource_term = 11;
  row.has_source_key = 1;
  row.source_key = {"source-vector", 13};
  row.score = 0.91;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 4;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<ScanState*>(user_data);
  state->calls += 1;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate) {
    if (request->pattern.predicate == 20 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {10, 20, 30, 40},
        {11, 20, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 110 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {11, 110, 111, 40},
        {10, 110, 112, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 130 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[1] = {
        {10, 130, 131, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 1;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 150 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[1] = {
        {10, 150, 151, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 1;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 170 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[3] = {
        {10, 170, 30, 40},
        {11, 170, 30, 40},
        {12, 170, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 3;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 180 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {10, 180, 30, 40},
        {10, 180, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 190 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[3] = {
        {10, 190, 30, 40},
        {10, 190, 31, 40},
        {11, 190, 30, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 3;
      return on_batch(callback_user_data, &batch);
    }
    if (!request->pattern.has_object) return XPOD_RDF_STATUS_BACKEND_ERROR;
    xpod_rdf_quad_key rows[1] = {};
    if (request->pattern.predicate == 50 && request->pattern.object == 60) {
      rows[0] = {10, 50, 60, 40};
    } else if (request->pattern.predicate == 70 && request->pattern.object == 80) {
      rows[0] = {10, 70, 80, 40};
    } else if (request->pattern.predicate == 90 && request->pattern.object == 100) {
      rows[0] = {30, 90, 100, 40};
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows;
    batch.row_count = 1;
    return on_batch(callback_user_data, &batch);
  }
  xpod_rdf_quad_key rows[4] = {
    {10, 20, 30, 40},
    {11, 20, 31, 40},
    {12, 20, 32, 40},
    {13, 20, 33, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 4;
  return on_batch(callback_user_data, &batch);
}

int main() {
  ScanState state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.compare_qlever_ids = compare_ids;
  backend.get_capabilities = get_capabilities;
  backend.scan_permutation = scan;
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan primary;
  primary.scan.permutation = Permutation::Enum::SPO;
  primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  primary.sorted_by = {0};
  primary.result_width = 3;
  primary.descriptor = "main scan";
  plan.scans.push_back(primary);

  xpod::qlever::BridgePhysicalScan filter;
  filter.scan.permutation = Permutation::Enum::SPO;
  filter.scan.pattern.has_predicate = true;
  filter.scan.pattern.predicate = 50;
  filter.scan.pattern.has_object = true;
  filter.scan.pattern.object = 60;
  filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  filter.descriptor = "filter scan";
  plan.scans.push_back(filter);

  xpod::qlever::BridgePhysicalScan second_filter;
  second_filter.scan.permutation = Permutation::Enum::SPO;
  second_filter.scan.pattern.has_predicate = true;
  second_filter.scan.pattern.predicate = 70;
  second_filter.scan.pattern.has_object = true;
  second_filter.scan.pattern.object = 80;
  second_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  second_filter.descriptor = "second filter scan";
  plan.scans.push_back(second_filter);

  plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  plan.root.scan_indexes = {0, 1, 2};
  plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;

  auto result = xpod::qlever::executeBridgeOperationPlan(physical, plan);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (state.calls != 3) return 2;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 3 || table.numRows() != 1) return 3;
  if (table(0, 0).getBits() != 1010) return 4;
  if (table(0, 1).getBits() != 1020) return 5;
  if (table(0, 2).getBits() != 1030) return 6;
  if (result.result.sortedBy().size() != 1 || result.result.sortedBy()[0] != 0) return 7;
  if (state.calls != 3) return 8;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan cross_slot_plan;
  xpod::qlever::BridgePhysicalScan cross_primary;
  cross_primary.scan.permutation = Permutation::Enum::SPO;
  cross_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  cross_primary.sorted_by = {0};
  cross_primary.result_width = 3;
  cross_primary.descriptor = "cross-slot primary scan";
  cross_slot_plan.scans.push_back(cross_primary);

  xpod::qlever::BridgePhysicalScan cross_filter;
  cross_filter.scan.permutation = Permutation::Enum::SPO;
  cross_filter.scan.pattern.has_predicate = true;
  cross_filter.scan.pattern.predicate = 90;
  cross_filter.scan.pattern.has_object = true;
  cross_filter.scan.pattern.object = 100;
  cross_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT;
  cross_filter.descriptor = "cross-slot subject filter scan";
  cross_slot_plan.scans.push_back(cross_filter);

  cross_slot_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  cross_slot_plan.root.scan_indexes = {0, 1};
  cross_slot_plan.root.join_slot = XPOD_RDF_SLOT_OBJECT;
  cross_slot_plan.root.join_slots = {XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_SUBJECT};

  auto cross_result = xpod::qlever::executeBridgeOperationPlan(physical, cross_slot_plan);
  if (cross_result.status != XPOD_RDF_STATUS_OK) return 9;
  if (state.calls != 2) return 10;
  const IdTable& cross_table = cross_result.result.idTable();
  if (cross_table.numColumns() != 3 || cross_table.numRows() != 1) return 11;
  if (cross_table(0, 0).getBits() != 1010) return 12;
  if (cross_table(0, 1).getBits() != 1020) return 13;
  if (cross_table(0, 2).getBits() != 1030) return 14;

  ProfileState profile;
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &profile;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan profile_plan;
  xpod::qlever::BridgePhysicalScan profile_primary;
  profile_primary.scan.permutation = Permutation::Enum::SPO;
  profile_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  profile_primary.sorted_by = {0};
  profile_primary.result_width = 3;
  profile_primary.descriptor = "profile primary scan";
  profile_primary.profile_node = 101;
  profile_primary.parent_profile_node = 100;
  profile_plan.scans.push_back(profile_primary);

  xpod::qlever::BridgePhysicalScan profile_filter;
  profile_filter.scan.permutation = Permutation::Enum::SPO;
  profile_filter.scan.pattern.has_predicate = true;
  profile_filter.scan.pattern.predicate = 50;
  profile_filter.scan.pattern.has_object = true;
  profile_filter.scan.pattern.object = 60;
  profile_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT;
  profile_filter.descriptor = "profile filter scan";
  profile_filter.profile_node = 102;
  profile_filter.parent_profile_node = 100;
  profile_plan.scans.push_back(profile_filter);

  profile_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  profile_plan.root.scan_indexes = {0, 1};
  profile_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  profile_plan.root.profile_node = 100;

  auto profile_result = xpod::qlever::executeBridgeOperationPlan(physical, profile_plan);
  if (profile_result.status != XPOD_RDF_STATUS_OK) return 15;
  if (profile.calls != 6) return 16;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 17;
  if (profile.nodes[0] != 100 || profile.has_parents[0]) return 18;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 19;
  if (profile.nodes[1] != 102 || !profile.has_parents[1] || profile.parents[1] != 100) return 20;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 21;
  if (profile.nodes[2] != 102 || !profile.has_parents[2] || profile.parents[2] != 100) return 22;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 23;
  if (profile.nodes[3] != 101 || !profile.has_parents[3] || profile.parents[3] != 100) return 24;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 25;
  if (profile.nodes[4] != 101 || !profile.has_parents[4] || profile.parents[4] != 100) return 26;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 27;
  if (profile.nodes[5] != 100 || profile.has_parents[5]) return 28;
  if (profile.output_rows[5] != 1) return 29;

  state.calls = 0;
  profile = {};
  xpod::qlever::BridgePhysicalPlan candidate_join_plan;
  xpod::qlever::BridgeTextCandidateSource text_source;
  text_source.setQuery("native-first");
  text_source.output_columns.push_back({
      "text",
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint,
  });
  text_source.output_columns.push_back({
      "entity",
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm,
  });
  text_source.profile_node = 202;
  text_source.parent_profile_node = 200;
  candidate_join_plan.text_sources.push_back(text_source);

  xpod::qlever::BridgePhysicalScan candidate_primary;
  candidate_primary.scan.permutation = Permutation::Enum::SPO;
  candidate_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  candidate_primary.sorted_by = {0};
  candidate_primary.result_width = 3;
  candidate_primary.descriptor = "candidate join primary scan";
  candidate_primary.profile_node = 203;
  candidate_primary.parent_profile_node = 200;
  candidate_join_plan.scans.push_back(candidate_primary);

  candidate_join_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  candidate_join_plan.root.use_candidate_join = true;
  candidate_join_plan.root.candidate_index = 0;
  candidate_join_plan.root.candidate_join_column =
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm;
  candidate_join_plan.root.candidate_project_columns.push_back({
      "text",
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint,
  });
  candidate_join_plan.root.scan_indexes = {0};
  candidate_join_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  candidate_join_plan.root.join_slots = {XPOD_RDF_SLOT_SUBJECT};
  candidate_join_plan.root.profile_node = 200;

  auto candidate_join_result = xpod::qlever::executeBridgeOperationPlan(physical, candidate_join_plan);
  if (candidate_join_result.status != XPOD_RDF_STATUS_OK) return 30;
  if (state.calls != 1) return 31;
  const IdTable& candidate_join_table = candidate_join_result.result.idTable();
  if (candidate_join_table.numColumns() != 4 || candidate_join_table.numRows() != 1) return 32;
  if (candidate_join_table(0, 0).getBits() != 0 ||
      candidate_join_table(0, 0).getDatatype() != Datatype::LocalVocabIndex) return 33;
  if (candidate_join_table(0, 1).getBits() != 1011) return 34;
  if (candidate_join_table(0, 2).getBits() != 1020) return 35;
  if (candidate_join_table(0, 3).getBits() != 1031) return 36;
  if (profile.calls != 6) return 37;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 38;
  if (profile.nodes[0] != 200 || profile.has_parents[0]) return 39;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 40;
  if (profile.nodes[1] != 202 || !profile.has_parents[1] || profile.parents[1] != 200) return 41;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 42;
  if (profile.nodes[2] != 202 || !profile.has_parents[2] || profile.parents[2] != 200) return 43;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 44;
  if (profile.nodes[3] != 203 || !profile.has_parents[3] || profile.parents[3] != 200) return 45;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 46;
  if (profile.nodes[4] != 203 || !profile.has_parents[4] || profile.parents[4] != 200) return 47;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 48;
  if (profile.nodes[5] != 200 || profile.has_parents[5]) return 49;
  if (profile.output_rows[5] != 1) return 50;

  state.calls = 0;
  profile = {};
  double vector_values[2] = {0.1, 0.2};
  xpod::qlever::BridgePhysicalPlan vector_join_plan;
  xpod::qlever::BridgeVectorCandidateSource vector_source;
  vector_source.request.vector = vector_values;
  vector_source.request.dimensions = 2;
  vector_source.request.provider = {"xpod", 4};
  vector_source.request.model = {"embed-v1", 8};
  vector_source.request.model_version = {"2026-08-12", 10};
  vector_source.request.input_kind = {"entity-card", 11};
  vector_source.request.projection_policy_version = {"policy-v1", 9};
  vector_source.request.metric = XPOD_RDF_VECTOR_COSINE;
  vector_source.request.limit = 2;
  vector_source.descriptor = "vector resource candidate";
  vector_source.profile_node = 302;
  vector_source.parent_profile_node = 300;
  vector_join_plan.vector_sources.push_back(vector_source);

  xpod::qlever::BridgePhysicalScan vector_primary;
  vector_primary.scan.permutation = Permutation::Enum::SPO;
  vector_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  vector_primary.sorted_by = {0};
  vector_primary.result_width = 3;
  vector_primary.descriptor = "vector candidate join primary scan";
  vector_primary.profile_node = 303;
  vector_primary.parent_profile_node = 300;
  vector_join_plan.scans.push_back(vector_primary);

  vector_join_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  vector_join_plan.root.use_candidate_join = true;
  vector_join_plan.root.candidate_source =
      xpod::qlever::BridgeCandidateSourceKind::Vector;
  vector_join_plan.root.candidate_index = 0;
  vector_join_plan.root.candidate_join_column =
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm;
  vector_join_plan.root.scan_indexes = {0};
  vector_join_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  vector_join_plan.root.join_slots = {XPOD_RDF_SLOT_SUBJECT};
  vector_join_plan.root.profile_node = 300;

  auto vector_join_result = xpod::qlever::executeBridgeOperationPlan(physical, vector_join_plan);
  if (vector_join_result.status != XPOD_RDF_STATUS_OK) return 50;
  if (state.calls != 1) return 51;
  const IdTable& vector_join_table = vector_join_result.result.idTable();
  if (vector_join_table.numColumns() != 3 || vector_join_table.numRows() != 1) return 52;
  if (vector_join_table(0, 0).getBits() != 1011) return 53;
  if (vector_join_table(0, 1).getBits() != 1020) return 54;
  if (vector_join_table(0, 2).getBits() != 1031) return 55;
  if (profile.calls != 6) return 56;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 57;
  if (profile.nodes[0] != 300 || profile.has_parents[0]) return 58;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_VECTOR_SEARCH || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 59;
  if (profile.nodes[1] != 302 || !profile.has_parents[1] || profile.parents[1] != 300) return 60;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_VECTOR_SEARCH || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 61;
  if (profile.nodes[2] != 302 || !profile.has_parents[2] || profile.parents[2] != 300) return 62;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 63;
  if (profile.nodes[3] != 303 || !profile.has_parents[3] || profile.parents[3] != 300) return 64;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 65;
  if (profile.nodes[4] != 303 || !profile.has_parents[4] || profile.parents[4] != 300) return 66;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 67;
  if (profile.nodes[5] != 300 || profile.has_parents[5]) return 68;
  if (profile.output_rows[5] != 1) return 69;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan rdf_projection_plan;
  xpod::qlever::BridgePhysicalScan rdf_projection_primary;
  rdf_projection_primary.scan.permutation = Permutation::Enum::SPO;
  rdf_projection_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  rdf_projection_primary.sorted_by = {0};
  rdf_projection_primary.result_width = 2;
  rdf_projection_primary.descriptor = "rdf projection primary scan";
  rdf_projection_plan.scans.push_back(rdf_projection_primary);

  xpod::qlever::BridgePhysicalScan rdf_projection_filter;
  rdf_projection_filter.scan.permutation = Permutation::Enum::SPO;
  rdf_projection_filter.scan.pattern.has_predicate = true;
  rdf_projection_filter.scan.pattern.predicate = 110;
  rdf_projection_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  rdf_projection_filter.sorted_by = {0};
  rdf_projection_filter.result_width = 2;
  rdf_projection_filter.descriptor = "rdf projection filter scan";
  rdf_projection_plan.scans.push_back(rdf_projection_filter);

  rdf_projection_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  rdf_projection_plan.root.scan_indexes = {0, 1};
  rdf_projection_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  rdf_projection_plan.root.join_slots = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_SUBJECT,
  };
  rdf_projection_plan.root.scan_project_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_OBJECT},
  };

  auto rdf_projection_result = xpod::qlever::executeBridgeOperationPlan(physical, rdf_projection_plan);
  if (rdf_projection_result.status != XPOD_RDF_STATUS_OK) return 70;
  if (state.calls != 2) return 71;
  const IdTable& rdf_projection_table = rdf_projection_result.result.idTable();
  if (rdf_projection_table.numColumns() != 3 || rdf_projection_table.numRows() != 2) return 72;
  if (rdf_projection_table(0, 0).getBits() != 1010) return 73;
  if (rdf_projection_table(0, 1).getBits() != 1030) return 74;
  if (rdf_projection_table(0, 2).getBits() != 1112) return 75;
  if (rdf_projection_table(1, 0).getBits() != 1011) return 76;
  if (rdf_projection_table(1, 1).getBits() != 1031) return 77;
  if (rdf_projection_table(1, 2).getBits() != 1111) return 78;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan multi_key_plan;
  xpod::qlever::BridgePhysicalScan multi_key_primary;
  multi_key_primary.scan.permutation = Permutation::Enum::SPO;
  multi_key_primary.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_key_primary.sorted_by = {0, 1};
  multi_key_primary.result_width = 3;
  multi_key_primary.descriptor = "multi-key primary scan";
  multi_key_plan.scans.push_back(multi_key_primary);

  xpod::qlever::BridgePhysicalScan multi_key_filter;
  multi_key_filter.scan.permutation = Permutation::Enum::SPO;
  multi_key_filter.scan.pattern.has_predicate = true;
  multi_key_filter.scan.pattern.predicate = 20;
  multi_key_filter.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_key_filter.sorted_by = {0, 1};
  multi_key_filter.result_width = 3;
  multi_key_filter.descriptor = "multi-key filter scan";
  multi_key_plan.scans.push_back(multi_key_filter);

  multi_key_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  multi_key_plan.root.scan_indexes = {0, 1};
  multi_key_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  multi_key_plan.root.join_slots = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_SUBJECT,
  };
  multi_key_plan.root.join_key_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE},
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE},
  };
  multi_key_plan.root.scan_project_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_OBJECT},
  };

  auto multi_key_result = xpod::qlever::executeBridgeOperationPlan(physical, multi_key_plan);
  if (multi_key_result.status != XPOD_RDF_STATUS_OK) return 79;
  if (state.calls != 2) return 80;
  const IdTable& multi_key_table = multi_key_result.result.idTable();
  if (multi_key_table.numColumns() != 4 || multi_key_table.numRows() != 2) return 81;
  if (multi_key_table(0, 0).getBits() != 1010) return 82;
  if (multi_key_table(0, 1).getBits() != 1020) return 83;
  if (multi_key_table(0, 2).getBits() != 1030) return 84;
  if (multi_key_table(0, 3).getBits() != 1030) return 85;
  if (multi_key_table(1, 0).getBits() != 1011) return 86;
  if (multi_key_table(1, 1).getBits() != 1020) return 87;
  if (multi_key_table(1, 2).getBits() != 1031) return 88;
  if (multi_key_table(1, 3).getBits() != 1031) return 89;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan limit_plan;
  xpod::qlever::BridgePhysicalScan limit_scan;
  limit_scan.scan.permutation = Permutation::Enum::SPO;
  limit_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  limit_scan.sorted_by = {0};
  limit_scan.result_width = 3;
  limit_scan.descriptor = "limit primary scan";
  limit_plan.scans.push_back(limit_scan);
  limit_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  limit_plan.root.scan_indexes = {0};
  limit_plan.root.has_limit = true;
  limit_plan.root.offset = 1;
  limit_plan.root.limit = 2;

  auto limit_result = xpod::qlever::executeBridgeOperationPlan(physical, limit_plan);
  if (limit_result.status != XPOD_RDF_STATUS_OK) return 90;
  if (state.calls != 1) return 91;
  const IdTable& limit_table = limit_result.result.idTable();
  if (limit_table.numColumns() != 3 || limit_table.numRows() != 2) return 92;
  if (limit_table(0, 0).getBits() != 1011) return 93;
  if (limit_table(0, 1).getBits() != 1020) return 94;
  if (limit_table(0, 2).getBits() != 1031) return 95;
  if (limit_table(1, 0).getBits() != 1012) return 96;
  if (limit_table(1, 1).getBits() != 1020) return 97;
  if (limit_table(1, 2).getBits() != 1032) return 98;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan distinct_plan;
  xpod::qlever::BridgePhysicalScan distinct_scan;
  distinct_scan.scan.permutation = Permutation::Enum::SPO;
  distinct_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  distinct_scan.sorted_by = {0};
  distinct_scan.result_width = 3;
  distinct_scan.descriptor = "distinct primary scan";
  distinct_plan.scans.push_back(distinct_scan);
  distinct_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  distinct_plan.root.scan_indexes = {0};
  distinct_plan.root.has_distinct = true;
  distinct_plan.root.distinct_columns = {1};

  auto distinct_result = xpod::qlever::executeBridgeOperationPlan(physical, distinct_plan);
  if (distinct_result.status != XPOD_RDF_STATUS_OK) return 99;
  if (state.calls != 1) return 100;
  const IdTable& distinct_table = distinct_result.result.idTable();
  if (distinct_table.numColumns() != 3 || distinct_table.numRows() != 1) return 101;
  if (distinct_table(0, 0).getBits() != 1010) return 102;
  if (distinct_table(0, 1).getBits() != 1020) return 103;
  if (distinct_table(0, 2).getBits() != 1030) return 104;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan order_plan;
  xpod::qlever::BridgePhysicalScan order_scan;
  order_scan.scan.permutation = Permutation::Enum::SPO;
  order_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  order_scan.sorted_by = {0};
  order_scan.result_width = 3;
  order_scan.descriptor = "order primary scan";
  order_plan.scans.push_back(order_scan);
  order_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  order_plan.root.scan_indexes = {0};
  xpod::qlever::BridgeResultModifier order_modifier;
  order_modifier.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  order_modifier.columns = {2, 0};
  order_modifier.descending = {true, false};
  order_plan.root.result_modifiers.push_back(order_modifier);

  auto order_result = xpod::qlever::executeBridgeOperationPlan(physical, order_plan);
  if (order_result.status != XPOD_RDF_STATUS_OK) return 105;
  if (state.calls != 1) return 106;
  const IdTable& order_table = order_result.result.idTable();
  if (order_table.numColumns() != 3 || order_table.numRows() != 4) return 107;
  if (!order_result.result.sortedBy().empty()) return 108;
  if (order_table(0, 0).getBits() != 1013) return 109;
  if (order_table(0, 2).getBits() != 1033) return 110;
  if (order_table(1, 0).getBits() != 1012) return 111;
  if (order_table(1, 2).getBits() != 1032) return 112;
  if (order_table(2, 0).getBits() != 1011) return 113;
  if (order_table(2, 2).getBits() != 1031) return 114;
  if (order_table(3, 0).getBits() != 1010) return 115;
  if (order_table(3, 2).getBits() != 1030) return 116;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan sort_plan;
  xpod::qlever::BridgePhysicalScan sort_scan;
  sort_scan.scan.permutation = Permutation::Enum::SPO;
  sort_scan.scan.pattern.has_predicate = true;
  sort_scan.scan.pattern.predicate = 110;
  sort_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  sort_scan.sorted_by = {};
  sort_scan.result_width = 3;
  sort_scan.descriptor = "sort primary scan";
  sort_plan.scans.push_back(sort_scan);
  sort_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sort_plan.root.scan_indexes = {0};
  xpod::qlever::BridgeResultModifier sort_modifier;
  sort_modifier.kind = xpod::qlever::BridgeResultModifierKind::InternalSort;
  sort_modifier.columns = {0};
  sort_plan.root.result_modifiers.push_back(sort_modifier);

  auto sort_result = xpod::qlever::executeBridgeOperationPlan(physical, sort_plan);
  if (sort_result.status != XPOD_RDF_STATUS_OK) return 117;
  if (state.calls != 1) return 118;
  const IdTable& sort_table = sort_result.result.idTable();
  if (sort_table.numColumns() != 3 || sort_table.numRows() != 2) return 119;
  if (sort_result.result.sortedBy().size() != 1 ||
      sort_result.result.sortedBy()[0] != 0) return 120;
  if (sort_table(0, 0).getBits() != 1010) return 121;
  if (sort_table(1, 0).getBits() != 1011) return 122;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan neutral_plan;
  neutral_plan.root.kind = xpod::qlever::BridgeOperationKind::NeutralElement;
  auto neutral_result = xpod::qlever::executeBridgeOperationPlan(physical, neutral_plan);
  if (neutral_result.status != XPOD_RDF_STATUS_OK) return 123;
  if (state.calls != 0) return 124;
  const IdTable& neutral_table = neutral_result.result.idTable();
  if (neutral_table.numColumns() != 0 || neutral_table.numRows() != 1) return 125;
  if (!neutral_result.result.sortedBy().empty()) return 126;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan union_plan;
  xpod::qlever::BridgePhysicalScan union_left;
  union_left.scan.permutation = Permutation::Enum::SPO;
  union_left.scan.pattern.has_predicate = true;
  union_left.scan.pattern.predicate = 20;
  union_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  union_left.result_width = 2;
  union_plan.scans.push_back(union_left);
  xpod::qlever::BridgePhysicalScan union_right;
  union_right.scan.permutation = Permutation::Enum::SPO;
  union_right.scan.pattern.has_predicate = true;
  union_right.scan.pattern.predicate = 110;
  union_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  union_right.result_width = 2;
  union_plan.scans.push_back(union_right);
  union_plan.root.kind = xpod::qlever::BridgeOperationKind::Union;
  union_plan.root.sorted_by = {0};
  union_plan.root.column_origins = {{ {0, 0}, {1, 1} }};
  xpod::qlever::BridgeOperationPlan union_left_root;
  union_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  union_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan union_right_root;
  union_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  union_right_root.scan_indexes = {1};
  union_plan.root.children = {union_left_root, union_right_root};
  auto union_result = xpod::qlever::executeBridgeOperationPlan(physical, union_plan);
  if (union_result.status != XPOD_RDF_STATUS_OK) return 127;
  if (state.calls != 2) return 128;
  const IdTable& union_table = union_result.result.idTable();
  if (union_table.numColumns() != 2 || union_table.numRows() != 4) return 129;
  if (union_table(0, 0).getBits() != 1010 || union_table(0, 1).getBits() != 1030) return 130;
  if (union_table(1, 0).getBits() != 1011 || union_table(1, 1).getBits() != 1031) return 131;
  if (union_table(2, 0).getBits() != 1011 || union_table(2, 1).getBits() != 1111) return 132;
  if (union_table(3, 0).getBits() != 1010 || union_table(3, 1).getBits() != 1112) return 133;
  if (union_result.result.sortedBy().size() != 1 || union_result.result.sortedBy()[0] != 0) return 134;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan sparse_union_plan;
  xpod::qlever::BridgePhysicalScan sparse_union_left;
  sparse_union_left.scan.permutation = Permutation::Enum::SPO;
  sparse_union_left.scan.pattern.has_predicate = true;
  sparse_union_left.scan.pattern.predicate = 20;
  sparse_union_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  sparse_union_left.result_width = 2;
  sparse_union_plan.scans.push_back(sparse_union_left);
  xpod::qlever::BridgePhysicalScan sparse_union_right;
  sparse_union_right.scan.permutation = Permutation::Enum::SPO;
  sparse_union_right.scan.pattern.has_predicate = true;
  sparse_union_right.scan.pattern.predicate = 150;
  sparse_union_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  sparse_union_right.result_width = 2;
  sparse_union_plan.scans.push_back(sparse_union_right);
  sparse_union_plan.root.kind = xpod::qlever::BridgeOperationKind::Union;
  sparse_union_plan.root.sorted_by = {0};
  sparse_union_plan.root.column_origins = {{
      {0, 0},
      {1, xpod::qlever::BRIDGE_NO_COLUMN},
      {xpod::qlever::BRIDGE_NO_COLUMN, 1},
  }};
  xpod::qlever::BridgeOperationPlan sparse_union_left_root;
  sparse_union_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sparse_union_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan sparse_union_right_root;
  sparse_union_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sparse_union_right_root.scan_indexes = {1};
  sparse_union_plan.root.children = {sparse_union_left_root, sparse_union_right_root};
  auto sparse_union_result = xpod::qlever::executeBridgeOperationPlan(physical, sparse_union_plan);
  if (sparse_union_result.status != XPOD_RDF_STATUS_OK) return 152;
  if (state.calls != 2) return 153;
  const IdTable& sparse_union_table = sparse_union_result.result.idTable();
  if (sparse_union_table.numColumns() != 3 || sparse_union_table.numRows() != 3) return 154;
  if (sparse_union_table(0, 0).getBits() != 1010 || sparse_union_table(0, 1).getBits() != 1030 ||
      sparse_union_table(0, 2).getBits() != Id::makeUndefined().getBits()) return 155;
  if (sparse_union_table(1, 0).getBits() != 1011 || sparse_union_table(1, 1).getBits() != 1031 ||
      sparse_union_table(1, 2).getBits() != Id::makeUndefined().getBits()) return 156;
  if (sparse_union_table(2, 0).getBits() != 1010 ||
      sparse_union_table(2, 1).getBits() != Id::makeUndefined().getBits() ||
      sparse_union_table(2, 2).getBits() != 1151) return 157;
  if (sparse_union_result.result.sortedBy().size() != 1 || sparse_union_result.result.sortedBy()[0] != 0) return 158;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan cartesian_plan;
  xpod::qlever::BridgePhysicalScan cartesian_left;
  cartesian_left.scan.permutation = Permutation::Enum::SPO;
  cartesian_left.scan.pattern.has_predicate = true;
  cartesian_left.scan.pattern.predicate = 20;
  cartesian_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  cartesian_left.result_width = 2;
  cartesian_plan.scans.push_back(cartesian_left);
  xpod::qlever::BridgePhysicalScan cartesian_right;
  cartesian_right.scan.permutation = Permutation::Enum::SPO;
  cartesian_right.scan.pattern.has_predicate = true;
  cartesian_right.scan.pattern.predicate = 110;
  cartesian_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  cartesian_right.result_width = 2;
  cartesian_plan.scans.push_back(cartesian_right);
  cartesian_plan.root.kind = xpod::qlever::BridgeOperationKind::CartesianProductJoin;
  xpod::qlever::BridgeOperationPlan cartesian_left_root;
  cartesian_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  cartesian_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan cartesian_right_root;
  cartesian_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  cartesian_right_root.scan_indexes = {1};
  cartesian_plan.root.children = {cartesian_left_root, cartesian_right_root};
  auto cartesian_result = xpod::qlever::executeBridgeOperationPlan(physical, cartesian_plan);
  if (cartesian_result.status != XPOD_RDF_STATUS_OK) return 135;
  if (state.calls != 2) return 136;
  const IdTable& cartesian_table = cartesian_result.result.idTable();
  if (cartesian_table.numColumns() != 4 || cartesian_table.numRows() != 4) return 137;
  if (cartesian_table(0, 0).getBits() != 1010 || cartesian_table(0, 1).getBits() != 1030 ||
      cartesian_table(0, 2).getBits() != 1011 || cartesian_table(0, 3).getBits() != 1111) return 138;
  if (cartesian_table(3, 0).getBits() != 1011 || cartesian_table(3, 1).getBits() != 1031 ||
      cartesian_table(3, 2).getBits() != 1010 || cartesian_table(3, 3).getBits() != 1112) return 139;
  if (!cartesian_result.result.sortedBy().empty()) return 140;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan minus_plan;
  xpod::qlever::BridgePhysicalScan minus_left;
  minus_left.scan.permutation = Permutation::Enum::SPO;
  minus_left.scan.pattern.has_predicate = true;
  minus_left.scan.pattern.predicate = 20;
  minus_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  minus_left.sorted_by = {0};
  minus_left.result_width = 2;
  minus_plan.scans.push_back(minus_left);
  xpod::qlever::BridgePhysicalScan minus_right;
  minus_right.scan.permutation = Permutation::Enum::SPO;
  minus_right.scan.pattern.has_predicate = true;
  minus_right.scan.pattern.predicate = 130;
  minus_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  minus_right.result_width = 2;
  minus_plan.scans.push_back(minus_right);
  minus_plan.root.kind = xpod::qlever::BridgeOperationKind::Minus;
  minus_plan.root.sorted_by = {0};
  minus_plan.root.matched_columns = {{ {0, 0} }};
  xpod::qlever::BridgeOperationPlan minus_left_root;
  minus_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  minus_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan minus_right_root;
  minus_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  minus_right_root.scan_indexes = {1};
  minus_plan.root.children = {minus_left_root, minus_right_root};
  auto minus_result = xpod::qlever::executeBridgeOperationPlan(physical, minus_plan);
  if (minus_result.status != XPOD_RDF_STATUS_OK) return 141;
  if (state.calls != 2) return 142;
  const IdTable& minus_table = minus_result.result.idTable();
  if (minus_table.numColumns() != 2 || minus_table.numRows() != 1) return 143;
  if (minus_table(0, 0).getBits() != 1011 || minus_table(0, 1).getBits() != 1031) return 144;
  if (minus_result.result.sortedBy().size() != 1 || minus_result.result.sortedBy()[0] != 0) return 145;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan optional_plan;
  xpod::qlever::BridgePhysicalScan optional_left;
  optional_left.scan.permutation = Permutation::Enum::SPO;
  optional_left.scan.pattern.has_predicate = true;
  optional_left.scan.pattern.predicate = 20;
  optional_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  optional_left.sorted_by = {0};
  optional_left.result_width = 2;
  optional_plan.scans.push_back(optional_left);
  xpod::qlever::BridgePhysicalScan optional_right;
  optional_right.scan.permutation = Permutation::Enum::SPO;
  optional_right.scan.pattern.has_predicate = true;
  optional_right.scan.pattern.predicate = 150;
  optional_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  optional_right.result_width = 2;
  optional_plan.scans.push_back(optional_right);
  optional_plan.root.kind = xpod::qlever::BridgeOperationKind::OptionalJoin;
  optional_plan.root.sorted_by = {0};
  optional_plan.root.matched_columns = {{ {0, 0} }};
  optional_plan.root.right_projection_columns = {1};
  xpod::qlever::BridgeOperationPlan optional_left_root;
  optional_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  optional_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan optional_right_root;
  optional_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  optional_right_root.scan_indexes = {1};
  optional_plan.root.children = {optional_left_root, optional_right_root};
  auto optional_result = xpod::qlever::executeBridgeOperationPlan(physical, optional_plan);
  if (optional_result.status != XPOD_RDF_STATUS_OK) return 146;
  if (state.calls != 2) return 147;
  const IdTable& optional_table = optional_result.result.idTable();
  if (optional_table.numColumns() != 3 || optional_table.numRows() != 2) return 148;
  if (optional_table(0, 0).getBits() != 1010 || optional_table(0, 1).getBits() != 1030 ||
      optional_table(0, 2).getBits() != 1151) return 149;
  if (optional_table(1, 0).getBits() != 1011 || optional_table(1, 1).getBits() != 1031 ||
      optional_table(1, 2).getBits() != Id::makeUndefined().getBits()) return 150;
  if (optional_result.result.sortedBy().size() != 1 || optional_result.result.sortedBy()[0] != 0) return 151;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan multi_plan;
  xpod::qlever::BridgePhysicalScan multi_left;
  multi_left.scan.permutation = Permutation::Enum::SPO;
  multi_left.scan.pattern.has_predicate = true;
  multi_left.scan.pattern.predicate = 180;
  multi_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_left.result_width = 3;
  multi_plan.scans.push_back(multi_left);
  xpod::qlever::BridgePhysicalScan multi_right;
  multi_right.scan.permutation = Permutation::Enum::SPO;
  multi_right.scan.pattern.has_predicate = true;
  multi_right.scan.pattern.predicate = 190;
  multi_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_right.result_width = 3;
  multi_plan.scans.push_back(multi_right);
  multi_plan.root.kind = xpod::qlever::BridgeOperationKind::MultiColumnJoin;
  multi_plan.root.matched_columns = {{ {0, 0}, {2, 2} }};
  multi_plan.root.right_projection_columns = {1};
  xpod::qlever::BridgeOperationPlan multi_left_root;
  multi_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan multi_right_root;
  multi_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_right_root.scan_indexes = {1};
  multi_plan.root.children = {multi_left_root, multi_right_root};
  auto multi_result = xpod::qlever::executeBridgeOperationPlan(physical, multi_plan);
  if (multi_result.status != XPOD_RDF_STATUS_OK) return 164;
  if (state.calls != 2) return 165;
  const IdTable& multi_table = multi_result.result.idTable();
  if (multi_table.numColumns() != 4 || multi_table.numRows() != 2) return 166;
  if (multi_table(0, 0).getBits() != 1010 || multi_table(0, 1).getBits() != 1180 ||
      multi_table(0, 2).getBits() != 1030 || multi_table(0, 3).getBits() != 1190) return 167;
  if (multi_table(1, 0).getBits() != 1010 || multi_table(1, 1).getBits() != 1180 ||
      multi_table(1, 2).getBits() != 1031 || multi_table(1, 3).getBits() != 1190) return 168;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan group_plan;
  xpod::qlever::BridgePhysicalScan group_scan;
  group_scan.scan.permutation = Permutation::Enum::SPO;
  group_scan.scan.pattern.has_predicate = true;
  group_scan.scan.pattern.predicate = 170;
  group_scan.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  group_scan.result_width = 2;
  group_plan.scans.push_back(group_scan);
  group_plan.root.kind = xpod::qlever::BridgeOperationKind::GroupBy;
  group_plan.root.projection_columns = {1};
  xpod::qlever::BridgeOperationPlan group_child_root;
  group_child_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  group_child_root.scan_indexes = {0};
  group_plan.root.children = {group_child_root};
  auto group_result = xpod::qlever::executeBridgeOperationPlan(physical, group_plan);
  if (group_result.status != XPOD_RDF_STATUS_OK) return 159;
  if (state.calls != 1) return 160;
  const IdTable& group_table = group_result.result.idTable();
  if (group_table.numColumns() != 1 || group_table.numRows() != 2) return 161;
  if (group_table(0, 0).getBits() != 1030) return 162;
  if (group_table(1, 0).getBits() != 1031) return 163;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('parameterizes projected multi-scan joins with deduplicated term tuple filters', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation tuple filter bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-tuple-filter-'));
    try {
      const qleverSource = await writeFakeOperationQleverHeaders(root);

      const smoke = path.join(root, 'operation_tuple_filter_smoke.cpp');
      const binary = path.join(root, 'operation_tuple_filter_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <iostream>
#include <vector>

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_ids(
    void*, uint64_t left, uint64_t right, int32_t* out_compare) {
  *out_compare = left < right ? -1 : (left > right ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

struct State {
  int scan_calls = 0;
  int filtered_scan_calls = 0;
  int profile_calls = 0;
  int scan_profile_events = 0;
  size_t filter_slot_count = 0;
  uint32_t filter_slots[4] = {};
  size_t filter_row_count = 0;
  std::vector<xpod_rdf_term_key> filter_terms;
  std::string last_join_details;
  bool advertise_filter = true;
  bool seed_empty = false;
  uint32_t max_batch_size = 4096;
  uint32_t max_term_tuple_filter_rows = 4096;
  bool advertise_paging = false;
  std::vector<size_t> seed_offsets;
};

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  auto* state = static_cast<State*>(user_data);
  state->profile_calls += 1;
  if (event->kind == XPOD_RDF_PROFILE_PERMUTATION_SCAN) {
    state->scan_profile_events += 1;
  }
  if (event->kind == XPOD_RDF_PROFILE_RDF_JOIN &&
      event->status == XPOD_RDF_PROFILE_COMPLETED) {
    state->last_join_details.assign(
        event->details_json.data,
        event->details_json.data + event->details_json.size);
  }
}

static xpod_rdf_status get_capabilities(
    void* user_data,
    xpod_rdf_backend_capabilities* out_capabilities) {
  auto* state = static_cast<State*>(user_data);
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = state->advertise_filter
      ? XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER
      : 0;
  if (state->advertise_paging) {
    out_capabilities->features |=
        XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
        XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET;
  }
  out_capabilities->max_batch_size = state->max_batch_size;
  out_capabilities->max_term_tuple_filter_rows =
      state->max_term_tuple_filter_rows;
  return XPOD_RDF_STATUS_OK;
}

static void capture_filter(State& state, const xpod_rdf_term_tuple_filter* filter) {
  if (filter == nullptr) return;
  state.filtered_scan_calls += 1;
  state.filter_slot_count = filter->slot_count;
  state.filter_row_count = filter->row_count;
  state.filter_terms.assign(
      filter->terms,
      filter->terms + filter->row_count * filter->slot_count);
  for (size_t index = 0; index < filter->slot_count && index < 4; ++index) {
    state.filter_slots[index] = filter->slots[index];
  }
}

static xpod_rdf_status emit_rows(
    const std::vector<xpod_rdf_quad_key>& rows,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows.data();
  batch.row_count = rows.size();
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<State*>(user_data);
  state->scan_calls += 1;
  capture_filter(*state, request->term_tuple_filter);
  if (request->pattern.has_predicate && request->pattern.predicate == 220) {
    state->seed_offsets.push_back(request->offset);
    if (state->seed_empty) {
      return emit_rows({}, on_batch, callback_user_data);
    }
    const std::vector<xpod_rdf_quad_key> candidates = {
        {11, 220, 31, 40},
        {11, 220, 33, 40},
        {12, 220, 32, 40},
    };
    const size_t begin = std::min(
        static_cast<size_t>(request->offset), candidates.size());
    const size_t end = request->limit == 0
        ? candidates.size()
        : std::min(
              candidates.size(),
              begin + static_cast<size_t>(request->limit));
    return emit_rows(
        std::vector<xpod_rdf_quad_key>(
            candidates.begin() + begin, candidates.begin() + end),
        on_batch, callback_user_data);
  }
  if (request->pattern.has_predicate && request->pattern.predicate == 230) {
    const std::vector<xpod_rdf_quad_key> candidates = {
        {11, 230, 41, 40},
        {12, 230, 42, 40},
        {13, 230, 43, 40},
    };
    if (request->term_tuple_filter == nullptr) {
      return emit_rows(candidates, on_batch, callback_user_data);
    }
    std::vector<xpod_rdf_quad_key> rows;
    for (const auto& candidate : candidates) {
      for (size_t index = 0;
           index < request->term_tuple_filter->row_count; ++index) {
        if (candidate.subject == request->term_tuple_filter->terms[index]) {
          rows.push_back(candidate);
          break;
        }
      }
    }
    return emit_rows(rows, on_batch, callback_user_data);
  }
  if (request->pattern.has_predicate && request->pattern.predicate == 240) {
    return emit_rows({
        {11, 240, 31, 40},
        {12, 240, 32, 40},
        {11, 240, 31, 40},
    }, on_batch, callback_user_data);
  }
  if (request->pattern.has_predicate && request->pattern.predicate == 250) {
    return emit_rows({
        {11, 250, 31, 40},
        {12, 250, 32, 40},
        {11, 250, 33, 40},
    }, on_batch, callback_user_data);
  }
  if (request->pattern.has_predicate && request->pattern.predicate == 260) {
    if (request->term_tuple_filter != nullptr) {
      std::vector<xpod_rdf_quad_key> rows;
      for (size_t index = 0;
           index < request->term_tuple_filter->row_count; ++index) {
        const xpod_rdf_term_key subject =
            request->term_tuple_filter->terms[index];
        if (subject == 41) rows.push_back({41, 260, 51, 40});
        if (subject == 42) rows.push_back({42, 260, 52, 40});
        if (subject == 43) rows.push_back({43, 260, 53, 40});
      }
      return emit_rows(rows, on_batch, callback_user_data);
    }
    return emit_rows({
        {41, 260, 51, 40},
        {42, 260, 52, 40},
        {43, 260, 53, 40},
    }, on_batch, callback_user_data);
  }
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod::qlever::BridgePhysicalPlan make_projected_join(
    xpod_rdf_term_key left_predicate,
    xpod_rdf_term_key right_predicate,
    std::vector<uint32_t> left_keys,
    std::vector<uint32_t> right_keys) {
  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan left;
  left.scan.permutation = Permutation::Enum::SPO;
  left.scan.pattern.has_predicate = true;
  left.scan.pattern.predicate = left_predicate;
  left.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  left.result_width = 3;
  plan.scans.push_back(left);

  xpod::qlever::BridgePhysicalScan right;
  right.scan.permutation = Permutation::Enum::SPO;
  right.scan.pattern.has_predicate = true;
  right.scan.pattern.predicate = right_predicate;
  right.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  right.result_width = 3;
  plan.scans.push_back(right);

  plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  plan.root.scan_indexes = {0, 1};
  plan.root.join_slot = left_keys.empty()
      ? static_cast<uint32_t>(XPOD_RDF_SLOT_SUBJECT)
      : left_keys.front();
  plan.root.join_slots = {
      left_keys.empty() ? static_cast<uint32_t>(XPOD_RDF_SLOT_SUBJECT)
                        : left_keys.front(),
      right_keys.empty() ? static_cast<uint32_t>(XPOD_RDF_SLOT_SUBJECT)
                         : right_keys.front()};
  plan.root.join_key_slots = {std::move(left_keys), std::move(right_keys)};
  plan.root.profile_node = 900;
  plan.root.scan_project_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_OBJECT},
  };
  return plan;
}

int main() {
  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.compare_qlever_ids = compare_ids;
  backend.get_capabilities = get_capabilities;
  backend.scan_permutation = scan;
  backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED;
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &state;
  xpod::rdf::PhysicalBackend physical(&backend);

  auto single_key = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  auto single_result = xpod::qlever::executeBridgeOperationPlan(physical, single_key);
  if (single_result.status != XPOD_RDF_STATUS_OK) return 1;
  if (state.scan_calls != 2) return 2;
  if (state.filtered_scan_calls != 1) return 3;
  if (state.scan_profile_events != 4) return 22;
  if (state.filter_slot_count != 1) return 4;
  if (state.filter_slots[0] != XPOD_RDF_SLOT_SUBJECT) return 5;
  if (state.filter_row_count != 2) return 6;
  if (state.filter_terms != std::vector<xpod_rdf_term_key>{11, 12}) return 7;
  std::cout << state.last_join_details << "\\n";
  const IdTable& single_table = single_result.result.idTable();
  if (single_table.numColumns() != 3 || single_table.numRows() != 3) return 8;

  state = {};
  auto multi_key = make_projected_join(
      240, 250,
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT});
  auto multi_result = xpod::qlever::executeBridgeOperationPlan(physical, multi_key);
  if (multi_result.status != XPOD_RDF_STATUS_OK) return 9;
  if (state.scan_calls != 2 || state.filtered_scan_calls != 1) return 10;
  if (state.filter_slot_count != 2) return 11;
  if (state.filter_slots[0] != XPOD_RDF_SLOT_SUBJECT ||
      state.filter_slots[1] != XPOD_RDF_SLOT_OBJECT) return 12;
  if (state.filter_row_count != 2) return 13;
  if (state.filter_terms != std::vector<xpod_rdf_term_key>{11, 31, 12, 32}) return 14;
  const IdTable& multi_table = multi_result.result.idTable();
  if (multi_table.numColumns() != 3 || multi_table.numRows() != 3) return 15;

  state = {};
  auto multi_column = make_projected_join(
      240, 250,
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT});
  xpod::qlever::BridgeOperationPlan multi_column_left;
  multi_column_left.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_column_left.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan multi_column_right;
  multi_column_right.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_column_right.scan_indexes = {1};
  multi_column.root.kind = xpod::qlever::BridgeOperationKind::MultiColumnJoin;
  multi_column.root.scan_indexes.clear();
  multi_column.root.join_key_slots.clear();
  multi_column.root.children = {multi_column_left, multi_column_right};
  multi_column.root.matched_columns = {{{0, 0}, {2, 2}}};
  multi_column.root.right_projection_columns = {1};
  multi_column.root.has_limit = true;
  multi_column.root.limit = 1;
  auto multi_column_result =
      xpod::qlever::executeBridgeOperationPlan(physical, multi_column);
  if (multi_column_result.status != XPOD_RDF_STATUS_OK) return 43;
  if (state.scan_calls != 2 || state.filtered_scan_calls != 1) return 44;
  if (state.filter_slot_count != 2 ||
      state.filter_slots[0] != XPOD_RDF_SLOT_SUBJECT ||
      state.filter_slots[1] != XPOD_RDF_SLOT_OBJECT) return 45;
  if (state.filter_terms !=
      std::vector<xpod_rdf_term_key>{11, 31, 12, 32}) return 46;
  if (multi_column_result.result.idTable().numRows() != 1) return 47;
  if (xpod::qlever::bridgeOperationDetailsJson().find(
          "\\"parameterized\\":true") == std::string::npos) return 48;

  state = {};
  state.seed_empty = true;
  auto empty = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  auto empty_result = xpod::qlever::executeBridgeOperationPlan(physical, empty);
  if (empty_result.status != XPOD_RDF_STATUS_OK) return 16;
  if (state.scan_calls != 1 || state.filtered_scan_calls != 0) return 17;
  if (empty_result.result.idTable().numRows() != 0) return 18;

  state = {};
  state.advertise_filter = false;
  auto fallback = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  auto fallback_result = xpod::qlever::executeBridgeOperationPlan(physical, fallback);
  if (fallback_result.status != XPOD_RDF_STATUS_OK) return 19;
  if (state.scan_calls != 2 || state.filtered_scan_calls != 0) return 20;
  if (fallback_result.result.idTable().numRows() != 3) return 21;
  std::cout << state.last_join_details << "\\n";

  state = {};
  state.max_term_tuple_filter_rows = 1;
  auto batched_filter = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  auto batched_filter_result =
      xpod::qlever::executeBridgeOperationPlan(physical, batched_filter);
  if (batched_filter_result.status != XPOD_RDF_STATUS_OK) return 49;
  if (state.scan_calls != 3 || state.filtered_scan_calls != 2) return 50;
  if (batched_filter_result.result.idTable().numRows() != 3) return 51;
  std::cout << state.last_join_details << "\\n";

  state = {};
  state.advertise_paging = true;
  state.max_term_tuple_filter_rows = 2;
  auto batched_seed = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  xpod::qlever::BridgeResultModifier order;
  order.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  order.columns = {0};
  order.descending = {false};
  xpod::qlever::BridgeResultModifier page;
  page.kind = xpod::qlever::BridgeResultModifierKind::LimitOffset;
  page.limit = 1;
  page.offset = 1;
  batched_seed.root.result_modifiers = {order, page};
  auto batched_seed_result =
      xpod::qlever::executeBridgeOperationPlan(physical, batched_seed);
  if (batched_seed_result.status != XPOD_RDF_STATUS_OK) return 52;
  if (state.seed_offsets != std::vector<size_t>{0, 2}) return 53;
  if (state.scan_calls != 4 || state.filtered_scan_calls != 2) return 54;
  const IdTable& batched_seed_table = batched_seed_result.result.idTable();
  if (batched_seed_table.numRows() != 1) return 55;
  if (batched_seed_table(0, 0).getBits() != 1011) return 56;
  if (state.last_join_details.find(
          "\\"seedBatches\\":2") == std::string::npos) return 57;
  if (state.last_join_details.find(
          "\\"peakSeedRows\\":2") == std::string::npos) return 58;
  std::cout << state.last_join_details << "\\n";

  state = {};
  state.advertise_paging = true;
  state.max_term_tuple_filter_rows = 2;
  auto ordered_seed = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  ordered_seed.scans[0].sorted_by = {0};
  page.offset = 1;
  ordered_seed.root.result_modifiers = {order, page};
  auto ordered_seed_result =
      xpod::qlever::executeBridgeOperationPlan(physical, ordered_seed);
  if (ordered_seed_result.status != XPOD_RDF_STATUS_OK) return 59;
  if (state.seed_offsets != std::vector<size_t>{0}) return 60;
  if (state.scan_calls != 2 || state.filtered_scan_calls != 1) return 61;
  if (ordered_seed_result.result.idTable().numRows() != 1) return 62;
  if (ordered_seed_result.result.idTable()(0, 0).getBits() != 1011) return 63;
  std::cout << state.last_join_details << "\\n";

  state = {};
  state.advertise_paging = true;
  state.max_term_tuple_filter_rows = 2;
  auto descending_seed = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  order.descending = {true};
  page.offset = 0;
  descending_seed.root.result_modifiers = {order, page};
  auto descending_seed_result =
      xpod::qlever::executeBridgeOperationPlan(physical, descending_seed);
  if (descending_seed_result.status != XPOD_RDF_STATUS_OK) return 64;
  if (state.seed_offsets != std::vector<size_t>{0, 2}) return 65;
  if (descending_seed_result.result.idTable().numRows() != 1) return 66;
  if (descending_seed_result.result.idTable()(0, 0).getBits() != 1012) return 67;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto zero_limit = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  order.descending = {false};
  page.limit = 0;
  zero_limit.root.result_modifiers = {order, page};
  auto zero_limit_result =
      xpod::qlever::executeBridgeOperationPlan(physical, zero_limit);
  if (zero_limit_result.status != XPOD_RDF_STATUS_OK) return 68;
  if (state.scan_calls != 0 || state.filtered_scan_calls != 0) return 69;
  if (zero_limit_result.result.idTable().numRows() != 0) return 70;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto three_scan = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  three_scan.scans.push_back(three_scan.scans[1]);
  three_scan.root.scan_indexes = {0, 1, 2};
  three_scan.root.join_key_slots.push_back({XPOD_RDF_SLOT_SUBJECT});
  three_scan.root.join_slots.push_back(XPOD_RDF_SLOT_SUBJECT);
  three_scan.root.scan_project_slots.push_back({XPOD_RDF_SLOT_OBJECT});
  auto three_scan_result =
      xpod::qlever::executeBridgeOperationPlan(physical, three_scan);
  if (three_scan_result.status != XPOD_RDF_STATUS_OK) return 30;
  if (state.scan_calls != 3 || state.filtered_scan_calls != 2) return 35;
  if (three_scan_result.result.idTable().numRows() != 3) return 36;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto chain = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  xpod::qlever::BridgePhysicalScan chain_right = chain.scans[1];
  chain_right.scan.pattern.predicate = 260;
  chain.scans.push_back(chain_right);
  xpod::qlever::BridgeOperationPlan chain_left;
  chain_left.kind = xpod::qlever::BridgeOperationKind::MultiColumnJoin;
  xpod::qlever::BridgeOperationPlan chain_seed_root;
  chain_seed_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  chain_seed_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan chain_middle_root;
  chain_middle_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  chain_middle_root.scan_indexes = {1};
  chain_left.children = {chain_seed_root, chain_middle_root};
  chain_left.matched_columns = {{{0, 0}}};
  chain_left.right_projection_columns = {2};
  xpod::qlever::BridgeOperationPlan chain_right_root;
  chain_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  chain_right_root.scan_indexes = {2};
  chain.root = {};
  chain.root.kind = xpod::qlever::BridgeOperationKind::MultiColumnJoin;
  chain.root.children = {chain_left, chain_right_root};
  chain.root.matched_columns = {{{3, 0}}};
  chain.root.right_projection_columns = {2};
  chain.root.profile_node = 901;
  auto chain_result =
      xpod::qlever::executeBridgeOperationPlan(physical, chain);
  if (chain_result.status != XPOD_RDF_STATUS_OK) return 37;
  if (state.scan_calls != 3 || state.filtered_scan_calls != 2) return 38;
  if (state.filter_terms != std::vector<xpod_rdf_term_key>{41, 42}) return 39;
  if (chain_result.result.idTable().numColumns() != 5 ||
      chain_result.result.idTable().numRows() != 3) return 40;
  std::cout << state.last_join_details << "\\n";

  state = {};
  state.advertise_filter = false;
  auto unsupported_chain_result =
      xpod::qlever::executeBridgeOperationPlan(physical, chain);
  if (unsupported_chain_result.status != XPOD_RDF_STATUS_OK) return 41;
  if (state.scan_calls != 3 || state.filtered_scan_calls != 0) return 42;

  state = {};
  auto empty_keys = make_projected_join(220, 230, {}, {});
  auto empty_keys_result =
      xpod::qlever::executeBridgeOperationPlan(physical, empty_keys);
  if (empty_keys_result.status != XPOD_RDF_STATUS_OK) return 31;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto arity_mismatch = make_projected_join(
      220, 230,
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_SUBJECT});
  auto arity_mismatch_result =
      xpod::qlever::executeBridgeOperationPlan(physical, arity_mismatch);
  if (arity_mismatch_result.status != XPOD_RDF_STATUS_OK) return 32;
  if (state.scan_calls != 2 || state.filtered_scan_calls != 0) return 33;
  if (arity_mismatch_result.result.idTable().numRows() != 0) return 34;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto too_wide = make_projected_join(
      240, 250,
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_GRAPH,
       XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_GRAPH,
       XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT});
  too_wide.scans[0].scan.needed_slots |= XPOD_RDF_SLOT_GRAPH;
  too_wide.scans[1].scan.needed_slots |= XPOD_RDF_SLOT_GRAPH;
  auto too_wide_result =
      xpod::qlever::executeBridgeOperationPlan(physical, too_wide);
  if (too_wide_result.status != XPOD_RDF_STATUS_OK) return 33;
  if (too_wide_result.result.idTable().numRows() != 3) return 34;
  std::cout << state.last_join_details << "\\n";

  state = {};
  auto composite_child = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  xpod::qlever::BridgePhysicalPlan composite = composite_child;
  composite.root.kind = xpod::qlever::BridgeOperationKind::Union;
  composite.root.column_origins = {{{0, 0}, {1, 1}, {2, 2}}};
  xpod::qlever::BridgeOperationPlan composite_scan_root;
  composite_scan_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  composite_scan_root.scan_indexes = {0};
  composite.root.children = {composite_child.root, composite_scan_root};
  composite.root.scan_indexes.clear();
  composite.root.scan_project_slots.clear();
  auto composite_result =
      xpod::qlever::executeBridgeOperationPlan(physical, composite);
  if (composite_result.status != XPOD_RDF_STATUS_OK) return 35;
  if (!xpod::qlever::bridgeOperationDetailsJson().empty()) return 36;

  state = {};
  auto unsupported_dependent = make_projected_join(
      220, 230, {XPOD_RDF_SLOT_SUBJECT}, {XPOD_RDF_SLOT_SUBJECT});
  unsupported_dependent.scans[1].scan.permutation = Permutation::Enum::POS;
  auto unsupported_result = xpod::qlever::executeBridgeOperationPlan(
      physical, unsupported_dependent);
  if (unsupported_result.status != XPOD_RDF_STATUS_UNSUPPORTED) return 23;
  if (state.scan_calls != 1 || state.filtered_scan_calls != 0) return 24;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      const stdout = execFileSync(binary, [], { encoding: 'utf8' });
      const details = stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(details).toEqual([
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 2,
          fallbackReason: null,
        },
        {
          parameterized: false,
          seedRows: 0,
          uniqueJoinTuples: 0,
          dependentBackendRows: 0,
          fallbackReason: 'backend-missing-term-tuple-filter',
        },
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 2,
          fallbackReason: null,
        },
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 2,
          fallbackReason: null,
          seedBatches: 2,
          peakSeedRows: 2,
        },
        {
          parameterized: true,
          seedRows: 2,
          uniqueJoinTuples: 1,
          dependentBackendRows: 1,
          fallbackReason: null,
          seedBatches: 1,
          peakSeedRows: 2,
        },
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 2,
          fallbackReason: null,
          seedBatches: 2,
          peakSeedRows: 2,
        },
        {
          parameterized: true,
          seedRows: 0,
          uniqueJoinTuples: 0,
          dependentBackendRows: 0,
          fallbackReason: null,
        },
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 4,
          fallbackReason: null,
        },
        {
          parameterized: true,
          seedRows: 3,
          uniqueJoinTuples: 2,
          dependentBackendRows: 2,
          fallbackReason: null,
        },
        {
          parameterized: false,
          seedRows: 0,
          uniqueJoinTuples: 0,
          dependentBackendRows: 0,
          fallbackReason: 'join-key-slots-empty',
        },
        {
          parameterized: false,
          seedRows: 0,
          uniqueJoinTuples: 0,
          dependentBackendRows: 0,
          fallbackReason: 'join-key-arity-mismatch',
        },
        {
          parameterized: false,
          seedRows: 0,
          uniqueJoinTuples: 0,
          dependentBackendRows: 0,
          fallbackReason: 'join-key-width-exceeds-four',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
