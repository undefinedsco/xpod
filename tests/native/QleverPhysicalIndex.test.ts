import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const physicalIndexHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp');

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
  await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
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

describe('Xpod-backed QLever physical index seam', () => {
  it('exposes a QLever-shaped permutation access surface over the physical backend', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_smoke.cpp');
      const binary = path.join(root, 'physical_index_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int estimate_calls;
  int scan_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_subject != 1 || request->pattern.subject != 11) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_subject != 1 || request->pattern.subject != 11) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_quad_key row = {11, 22, 33, 44};
  xpod_rdf_quad_batch batch = {&row, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = physical.getCapabilities(context.capabilities);

  xpod::qlever::XpodQleverPhysicalIndex index(context);
  xpod::qlever::TripleKeyPattern pattern = {};
  pattern.has_subject = true;
  pattern.subject = 11;

  auto permutation = index.permutation(Permutation::Enum::SPO);
  auto estimate = permutation.estimate(pattern, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 1;
  if (estimate.estimate.rows != 1) return 2;

  auto scan = permutation.scan(pattern, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);
  if (scan.status != XPOD_RDF_STATUS_OK) return 3;
  if (scan.table.numColumns() != 2) return 4;
  if (scan.table.numRows() != 1) return 5;
  if (scan.table(0, 0).getBits() != 11) return 6;
  if (scan.table(0, 1).getBits() != 33) return 7;
  if (state.estimate_calls != 1) return 8;
  if (state.scan_calls != 1) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes exact count and distinct scans through the physical permutation seam', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical permutation stats check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-stats-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_stats_smoke.cpp');
      const binary = path.join(root, 'physical_index_stats_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int count_calls;
  int distinct_calls;
  int estimate_distinct_calls;
};

static xpod_rdf_status count_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->count_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_result->count = 7;
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status distinct_scan(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_term_tuple_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->distinct_calls;
  if (request->scan.permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->scan.pattern.has_predicate != 1 || request->scan.pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->distinct_slots != XPOD_RDF_SLOT_OBJECT) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_term_key rows[2] = {33, 44};
  xpod_rdf_term_tuple_batch batch = {rows, 2, 1};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status estimate_distinct(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_distinct_calls;
  if (request->scan.permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->scan.pattern.has_predicate != 1 || request->scan.pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->distinct_slots != XPOD_RDF_SLOT_OBJECT) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 5;
  out_estimate->distinct_objects = 5;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.count_scan = count_scan;
  raw_backend.distinct_scan = distinct_scan;
  raw_backend.estimate_distinct = estimate_distinct;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);
  xpod::qlever::TripleKeyPattern pattern = {};
  pattern.has_predicate = true;
  pattern.predicate = 22;

  auto permutation = index.permutation(Permutation::Enum::POS);
  auto count = permutation.count(pattern);
  if (count.status != XPOD_RDF_STATUS_OK) return 1;
  if (count.result.count != 7) return 2;

  auto distinct = permutation.distinct(pattern, XPOD_RDF_SLOT_OBJECT);
  if (distinct.status != XPOD_RDF_STATUS_OK) return 3;
  if (distinct.tuple_width != 1) return 4;
  if (distinct.row_count != 2) return 5;
  if (distinct.terms.size() != 2) return 6;
  if (distinct.terms[0] != 33 || distinct.terms[1] != 44) return 7;
  auto estimate = permutation.estimateDistinct(pattern, XPOD_RDF_SLOT_OBJECT);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 8;
  if (estimate.estimate.rows != 5) return 9;
  if (estimate.estimate.distinct_objects != 5) return 10;
  if (state.count_calls != 1) return 11;
  if (state.distinct_calls != 1) return 12;
  if (state.estimate_distinct_calls != 1) return 13;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes term dictionary lookup and resolution through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index dictionary check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-dict-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_dictionary_smoke.cpp');
      const binary = path.join(root, 'physical_index_dictionary_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int lookup_calls;
  int resolve_calls;
};

static xpod_rdf_status lookup_term(
    void* user_data,
    const xpod_rdf_term* term,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_key) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_calls;
  if (snapshot->facts_version.size != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (term->kind != XPOD_RDF_TERM_IRI || term->value.size != 5) return XPOD_RDF_STATUS_BACKEND_ERROR;
  *out_key = 101;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_term(
    void* user_data,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_term) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_calls;
  if (snapshot->facts_version.size != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (key != 101) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static const char iri[] = "urn:s";
  out_term->kind = XPOD_RDF_TERM_IRI;
  out_term->value = {iri, 5};
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.lookup_term = lookup_term;
  raw_backend.resolve_term = resolve_term;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  static const char facts_version[] = "facts-v1";
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_version, 8};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  static const char iri[] = "urn:s";
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_IRI;
  term.value = {iri, 5};

  xpod_rdf_term_key key = 0;
  if (index.lookupTerm(term, key) != XPOD_RDF_STATUS_OK) return 1;
  if (key != 101) return 2;

  xpod_rdf_term resolved = {};
  if (index.resolveTerm(key, resolved) != XPOD_RDF_STATUS_OK) return 3;
  if (resolved.kind != XPOD_RDF_TERM_IRI) return 4;
  if (resolved.value.size != 5) return 5;
  if (state.lookup_calls != 1) return 6;
  if (state.resolve_calls != 1) return 7;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes QLever id codec and comparator through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index id codec check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-id-codec-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_id_codec_smoke.cpp');
      const binary = path.join(root, 'physical_index_id_codec_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int encode_calls;
  int decode_calls;
  int compare_calls;
};

static xpod_rdf_status encode_qlever_id(
    void* user_data,
    xpod_rdf_term_key term,
    uint64_t* out_qlever_id_bits) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->encode_calls;
  *out_qlever_id_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode_qlever_id(
    void* user_data,
    uint64_t qlever_id_bits,
    xpod_rdf_term_key* out_term) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->decode_calls;
  *out_term = qlever_id_bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_qlever_ids(
    void* user_data,
    uint64_t left_qlever_id_bits,
    uint64_t right_qlever_id_bits,
    int32_t* out_compare) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->compare_calls;
  *out_compare = left_qlever_id_bits == right_qlever_id_bits
                     ? 0
                     : (left_qlever_id_bits > right_qlever_id_bits ? -1 : 1);
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.encode_qlever_id = encode_qlever_id;
  raw_backend.decode_qlever_id = decode_qlever_id;
  raw_backend.compare_qlever_ids = compare_qlever_ids;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  uint64_t qlever_id_bits = 0;
  if (index.encodeQleverId(42, qlever_id_bits) != XPOD_RDF_STATUS_OK) return 1;
  if (qlever_id_bits != 1042) return 2;

  xpod_rdf_term_key term = 0;
  if (index.decodeQleverId(1042, term) != XPOD_RDF_STATUS_OK) return 3;
  if (term != 42) return 4;

  int32_t compare = 0;
  if (index.compareQleverIds(2000, 1000, compare) != XPOD_RDF_STATUS_OK) return 5;
  if (compare != -1) return 6;
  if (state.encode_calls != 1) return 7;
  if (state.decode_calls != 1) return 8;
  if (state.compare_calls != 1) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes backend capability snapshot through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index capabilities check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-capabilities-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_capabilities_smoke.cpp');
      const binary = path.join(root, 'physical_index_capabilities_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = XPOD_RDF_STATUS_OK;
  context.capabilities.supported_permutations = XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_POSG;
  context.capabilities.features = XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES | XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  context.capabilities.max_batch_size = 512;

  xpod::qlever::XpodQleverPhysicalIndex index(context);
  if (index.capabilitiesStatus() != XPOD_RDF_STATUS_OK) return 1;
  const auto& capabilities = index.capabilities();
  if ((capabilities.supported_permutations & XPOD_RDF_PERM_CAP_SPOG) == 0) return 2;
  if ((capabilities.supported_permutations & XPOD_RDF_PERM_CAP_POSG) == 0) return 3;
  if ((capabilities.features & XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES) == 0) return 4;
  if ((capabilities.features & XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH) == 0) return 5;
  if (capabilities.max_batch_size != 512) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes histogram hints through the physical index seam', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index histogram check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-histogram-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_histogram_smoke.cpp');
      const binary = path.join(root, 'physical_index_histogram_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int histogram_calls;
};

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected, size_t size) {
  if (actual.size != size) return false;
  for (size_t i = 0; i < size; ++i) {
    if (actual.data[i] != expected[i]) return false;
  }
  return true;
}

static xpod_rdf_status histogram_hints(
    void* user_data,
    const xpod_rdf_histogram_request* request,
    xpod_rdf_histogram_hint_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->histogram_calls;
  if (!bytes_equal(request->snapshot.facts_version, "facts", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->cancellation == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || request->graph_scope.exact_graph != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.has_source_node != 1 || request->source_scope.source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr || request->access_scope->mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->slots != XPOD_RDF_SLOT_OBJECT) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->max_buckets != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_histogram_hint hint = {};
  hint.slots = XPOD_RDF_SLOT_OBJECT;
  hint.range.lower = 10;
  hint.range.upper = 20;
  hint.range.has_lower = 1;
  hint.range.has_upper = 1;
  hint.rows = 7;
  hint.distinct_terms = 3;
  hint.selectivity = 0.25;
  hint.confidence = XPOD_RDF_ESTIMATE_FRESH;
  xpod_rdf_histogram_hint_batch batch = {};
  batch.rows = &hint;
  batch.row_count = 1;
  batch.stats_version = {"stats-v1", 8};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.histogram_hints = histogram_hints;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {"facts", 5};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 99;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 55;
  request.access_scope = &access;
  xpod_rdf_cancellation cancellation = {};
  request.cancellation = &cancellation;
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod::qlever::TripleKeyPattern pattern = {};
  pattern.has_predicate = true;
  pattern.predicate = 22;

  auto result = index.histogramHints(pattern, XPOD_RDF_SLOT_OBJECT, 8);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.hints.size() != 1) return 2;
  if (result.hints[0].rows != 7 || result.hints[0].distinct_terms != 3) return 3;
  if (result.hints[0].range.lower != 10 || result.hints[0].range.upper != 20) return 4;
  if (result.stats_version.size != 8) return 5;
  if (state.histogram_calls != 1) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('fails closed when histogram hints are not in the capability snapshot', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index histogram capability check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-histogram-capability-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_histogram_capability_smoke.cpp');
      const binary = path.join(root, 'physical_index_histogram_capability_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int histogram_calls;
};

static xpod_rdf_status histogram_hints(
    void* user_data,
    const xpod_rdf_histogram_request*,
    xpod_rdf_histogram_hint_batch_callback,
    void*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->histogram_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.histogram_hints = histogram_hints;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = XPOD_RDF_STATUS_OK;
  context.capabilities.features = XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  auto result = index.histogramHints({}, XPOD_RDF_SLOT_OBJECT, 8);
  if (result.status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;
  if (!result.hints.empty()) return 2;
  if (state.histogram_calls != 0) return 3;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes text and vector candidate sources through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index candidate source check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-candidates-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_candidates_smoke.cpp');
      const binary = path.join(root, 'physical_index_candidates_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int estimate_text_calls;
  int text_calls;
  int estimate_vector_calls;
  int vector_calls;
};

static bool bytes_equal(xpod_rdf_bytes value, const char* expected, size_t size) {
  if (value.size != size) return false;
  for (size_t i = 0; i < size; ++i) {
    if (value.data[i] != expected[i]) return false;
  }
  return true;
}

static bool has_context(const xpod_rdf_text_search_request* request) {
  return bytes_equal(request->snapshot.facts_version, "facts", 5) &&
         request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT &&
         request->graph_scope.exact_graph == 99 &&
         request->source_scope.has_source_node == 1 &&
         request->source_scope.source_node == 55 &&
         request->access_scope != nullptr &&
         request->access_scope->mode == XPOD_RDF_ACCESS_READ;
}

static bool has_context(const xpod_rdf_vector_search_request* request) {
  return bytes_equal(request->snapshot.facts_version, "facts", 5) &&
         request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT &&
         request->graph_scope.exact_graph == 99 &&
         request->source_scope.has_source_node == 1 &&
         request->source_scope.source_node == 55 &&
         request->access_scope != nullptr &&
         request->access_scope->mode == XPOD_RDF_ACCESS_READ;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
      XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_text_calls;
  if (!has_context(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->query, "hello", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->text_calls;
  if (!has_context(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.resource_term = 101;
  row.has_resource_term = 1;
  row.score = 0.75;
  xpod_rdf_candidate_batch batch = {&row, 1, 1, {"text", 4}};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status estimate_vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_vector_calls;
  if (!has_context(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->dimensions != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 2;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->vector_calls;
  if (!has_context(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.resource_term = 202;
  row.has_resource_term = 1;
  row.score = 0.5;
  xpod_rdf_candidate_batch batch = {&row, 1, 1, {"vector", 6}};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.estimate_text_search = estimate_text_search;
  raw_backend.text_search = text_search;
  raw_backend.estimate_vector_search = estimate_vector_search;
  raw_backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {"facts", 5};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 99;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 55;
  request.access_scope = &access;
  xpod_rdf_cancellation cancellation = {};
  request.cancellation = &cancellation;
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod_rdf_text_search_request text_request = {};
  text_request.query = {"hello", 5};
  auto text = index.textSearch(text_request);
  auto text_estimate = text.estimate();
  if (text_estimate.status != XPOD_RDF_STATUS_OK) return 1;
  if (text_estimate.estimate.rows != 1) return 2;
  auto text_result = text.execute();
  if (text_result.status != XPOD_RDF_STATUS_OK) return 3;
  if (text_result.candidates.rows.size() != 1) return 4;
  if (text_result.candidates.rows[0].resource_term != 101) return 5;

  double query_vector[2] = {0.1, 0.2};
  xpod_rdf_vector_search_request vector_request = {};
  vector_request.vector = query_vector;
  vector_request.dimensions = 2;
  auto vector = index.vectorSearch(vector_request);
  auto vector_estimate = vector.estimate();
  if (vector_estimate.status != XPOD_RDF_STATUS_OK) return 6;
  if (vector_estimate.estimate.rows != 2) return 7;
  auto vector_result = vector.execute();
  if (vector_result.status != XPOD_RDF_STATUS_OK) return 8;
  if (vector_result.candidates.rows.size() != 1) return 9;
  if (vector_result.candidates.rows[0].resource_term != 202) return 10;

  if (state.estimate_text_calls != 1) return 11;
  if (state.text_calls != 1) return 12;
  if (state.estimate_vector_calls != 1) return 13;
  if (state.vector_calls != 1) return 14;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('maps QLever scan specifications through the physical index seam', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index scan specification check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-scan-spec-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_scan_spec_smoke.cpp');
      const binary = path.join(root, 'physical_index_scan_spec_smoke');
      await writeFile(smoke, `
#include <optional>
#include "XpodQleverPhysicalIndex.hpp"

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2)
      : col0_(col0), col1_(col1), col2_(col2) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
 private:
  T col0_;
  T col1_;
  T col2_;
};

struct BackendState {
  int estimate_calls;
  int scan_calls;
};

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_subject != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != XPOD_RDF_SLOT_SUBJECT) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_quad_key row = {11, 22, 33, 44};
  xpod_rdf_quad_batch batch = {&row, 1, XPOD_RDF_SLOT_SUBJECT, 1};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  ScanSpecification spec{Id::fromBits(22), Id::fromBits(33), std::nullopt};
  auto estimate = index.estimateScanSpecification(
      Permutation::Enum::POS,
      spec,
      XPOD_RDF_SLOT_SUBJECT);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 1;
  if (estimate.estimate.rows != 1) return 2;

  auto scan = index.scanScanSpecification(
      Permutation::Enum::POS,
      spec,
      XPOD_RDF_SLOT_SUBJECT);
  if (scan.status != XPOD_RDF_STATUS_OK) return 3;
  if (scan.table.numColumns() != 1) return 4;
  if (scan.table.numRows() != 1) return 5;
  if (scan.table(0, 0).getBits() != 11) return 6;

  auto permutation = index.permutation(Permutation::Enum::POS);
  auto scan_spec_and_blocks = permutation.getScanSpecAndBlocks(
      spec,
      XPOD_RDF_SLOT_SUBJECT);
  if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) return 7;
  auto direct_scan = permutation.scan(scan_spec_and_blocks);
  if (direct_scan.status != XPOD_RDF_STATUS_OK) return 8;
  if (direct_scan.table.numColumns() != 1) return 9;
  if (direct_scan.table.numRows() != 1) return 10;
  if (direct_scan.table(0, 0).getBits() != 11) return 11;
  if (state.estimate_calls != 1) return 12;
  if (state.scan_calls != 2) return 13;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes QLever-shaped scan-spec size estimates and exact counts', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index scan-spec size check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-scan-spec-size-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_scan_spec_size_smoke.cpp');
      const binary = path.join(root, 'physical_index_scan_spec_size_smoke');
      await writeFile(smoke, `
#include <optional>
#include "XpodQleverPhysicalIndex.hpp"

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2)
      : col0_(col0), col1_(col1), col2_(col2) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
 private:
  T col0_;
  T col1_;
  T col2_;
};

struct BackendState {
  int estimate_calls;
  int count_calls;
};

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_calls;
  if (request->permutation != XPOD_RDF_PERM_SOPG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_subject != 1 || request->pattern.subject != 11) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != XPOD_RDF_SLOT_PREDICATE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || request->graph_scope.exact_graph != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.has_source_node != 1 || request->source_scope.source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr || request->access_scope->mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 9;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status count_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->count_calls;
  if (request->permutation != XPOD_RDF_PERM_SOPG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_subject != 1 || request->pattern.subject != 11) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != XPOD_RDF_SLOT_PREDICATE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || request->graph_scope.exact_graph != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.has_source_node != 1 || request->source_scope.source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr || request->access_scope->mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_result->count = 7;
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.count_scan = count_scan;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 99;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 55;
  request.access_scope = &access;
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  ScanSpecification spec{Id::fromBits(11), Id::fromBits(33), std::nullopt};
  auto permutation = index.permutation(Permutation::Enum::SOP);
  auto scan_spec_and_blocks = permutation.getScanSpecAndBlocks(
      spec,
      XPOD_RDF_SLOT_PREDICATE);
  if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) return 1;

  auto bounds = permutation.getSizeEstimateForScan(scan_spec_and_blocks);
  if (bounds.status != XPOD_RDF_STATUS_OK) return 2;
  if (bounds.lower != 0) return 3;
  if (bounds.upper != 9) return 4;
  if (bounds.exact) return 5;
  if (bounds.confidence != XPOD_RDF_ESTIMATE_FRESH) return 6;

  auto exact = permutation.getResultSizeOfScan(scan_spec_and_blocks);
  if (exact.status != XPOD_RDF_STATUS_OK) return 7;
  if (exact.result.count != 7) return 8;
  if (exact.result.confidence != XPOD_RDF_ESTIMATE_EXACT) return 9;
  if (state.estimate_calls != 1) return 10;
  if (state.count_calls != 1) return 11;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes QLever-shaped scan-spec block metadata through the physical permutation seam', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index block metadata check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-block-metadata-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_block_metadata_smoke.cpp');
      const binary = path.join(root, 'physical_index_block_metadata_smoke');
      await writeFile(smoke, `
#include <optional>
#include "XpodQleverPhysicalIndex.hpp"

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2)
      : col0_(col0), col1_(col1), col2_(col2) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
 private:
  T col0_;
  T col1_;
  T col2_;
};

struct BackendState {
  int block_metadata_calls;
};

static xpod_rdf_status scan_block_metadata(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_block_metadata_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->block_metadata_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || request->graph_scope.exact_graph != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.has_source_node != 1 || request->source_scope.source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr || request->access_scope->mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_scan_block_metadata rows[2] = {};
  rows[0].block_id = 1001;
  rows[0].first_quad = {10, 22, 33, 99};
  rows[0].last_quad = {19, 22, 33, 99};
  rows[0].row_count = 10;
  rows[0].sorted_slots = XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  rows[1].block_id = 1002;
  rows[1].first_quad = {20, 22, 33, 99};
  rows[1].last_quad = {29, 22, 33, 99};
  rows[1].row_count = 10;
  rows[1].sorted_slots = XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  static const char version[] = "blocks-v1";
  xpod_rdf_scan_block_metadata_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.total_blocks = 2;
  batch.metadata_version = {version, 9};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.scan_block_metadata = scan_block_metadata;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 99;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 55;
  request.access_scope = &access;
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};

  xpod::qlever::XpodQleverPhysicalIndex index(context);
  ScanSpecification spec{Id::fromBits(22), Id::fromBits(33), std::nullopt};
  auto permutation = index.permutation(Permutation::Enum::POS);
  auto scan_spec_and_blocks = permutation.getScanSpecAndBlocks(
      spec,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH);
  if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) return 1;

  auto metadata = permutation.getMetadataAndBlocks(scan_spec_and_blocks);
  if (metadata.status != XPOD_RDF_STATUS_OK) return 2;
  if (!metadata.has_metadata) return 3;
  if (metadata.blocks.size() != 2) return 4;
  if (metadata.total_blocks != 2) return 5;
  if (metadata.metadata_version.size != 9) return 6;
  if (metadata.blocks[0].block_id != 1001) return 7;
  if (metadata.blocks[1].last_quad.subject != 29) return 8;
  if (state.block_metadata_calls != 1) return 9;

  xpod_rdf_backend_v1 unsupported_backend = {};
  unsupported_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  unsupported_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend unsupported_physical(&unsupported_backend);
  xpod::qlever::PlannerRequestContext unsupported_context{unsupported_physical, &request, request.cancellation};
  auto unsupported = xpod::qlever::XpodQleverPhysicalIndex(unsupported_context)
      .permutation(Permutation::Enum::POS)
      .getMetadataAndBlocks(scan_spec_and_blocks);
  if (unsupported.status != XPOD_RDF_STATUS_UNSUPPORTED) return 10;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('passes selected scan-spec blocks into a physical permutation scan', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index selected block scan check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-selected-block-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_selected_block_scan_smoke.cpp');
      const binary = path.join(root, 'physical_index_selected_block_scan_smoke');
      await writeFile(smoke, `
#include <optional>
#include "XpodQleverPhysicalIndex.hpp"

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2)
      : col0_(col0), col1_(col1), col2_(col2) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
 private:
  T col0_;
  T col1_;
  T col2_;
};

struct BackendState {
  int metadata_calls;
  int scan_calls;
};

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected, size_t size) {
  if (actual.size != size) return false;
  for (size_t i = 0; i < size; ++i) {
    if (actual.data[i] != expected[i]) return false;
  }
  return true;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_POSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA |
      XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_block_metadata(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_block_metadata_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->metadata_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_scan_block_metadata rows[2] = {};
  rows[0].block_id = 1001;
  rows[0].first_quad = {10, 22, 33, 99};
  rows[0].last_quad = {19, 22, 33, 99};
  rows[0].row_count = 10;
  rows[0].sorted_slots = XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  rows[1].block_id = 1002;
  rows[1].first_quad = {20, 22, 33, 99};
  rows[1].last_quad = {29, 22, 33, 99};
  rows[1].row_count = 10;
  rows[1].sorted_slots = XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  static const char version[] = "blocks-v1";
  xpod_rdf_scan_block_metadata_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.total_blocks = 2;
  batch.metadata_version = {version, 9};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_POSG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate != 1 || request->pattern.predicate != 22) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_object != 1 || request->pattern.object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata[0].block_id != 1001) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata[1].first_quad.subject != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->block_metadata_version, "blocks-v1", 9)) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_quad_key row = {11, 22, 33, 99};
  xpod_rdf_quad_batch batch = {&row, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH, 1};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_block_metadata = scan_block_metadata;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  ScanSpecification spec{Id::fromBits(22), Id::fromBits(33), std::nullopt};
  auto permutation = index.permutation(Permutation::Enum::POS);
  auto scan_spec_and_blocks = permutation.getScanSpecAndBlocks(
      spec,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH);
  if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) return 1;

  auto metadata = permutation.getMetadataAndBlocks(scan_spec_and_blocks);
  if (metadata.status != XPOD_RDF_STATUS_OK) return 2;
  if (metadata.blocks.size() != 2) return 3;

  auto scan = permutation.scanSelectedBlocks(
      scan_spec_and_blocks,
      metadata.blocks,
      metadata.metadata_version);
  if (scan.status != XPOD_RDF_STATUS_OK) return 4;
  if (scan.table.numColumns() != 2) return 5;
  if (scan.table.numRows() != 1) return 6;
  if (scan.table(0, 0).getBits() != 11) return 7;
  if (scan.table(0, 1).getBits() != 99) return 8;
  if (state.metadata_calls != 1) return 9;
  if (state.scan_calls != 1) return 10;

  auto empty = permutation.scanSelectedBlocks(
      scan_spec_and_blocks,
      {},
      metadata.metadata_version);
  if (empty.status != XPOD_RDF_STATUS_OK) return 11;
  if (empty.table.numColumns() != 2) return 12;
  if (empty.table.numRows() != 0) return 13;
  if (state.scan_calls != 1) return 14;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('fails closed for QLever scan specifications with unsupported graph filters', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index scan specification graph filter check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-scan-spec-graph-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_scan_spec_graph_smoke.cpp');
      const binary = path.join(root, 'physical_index_scan_spec_graph_smoke');
      await writeFile(smoke, `
#include <optional>
#include "XpodQleverPhysicalIndex.hpp"

class GraphFilter {
 public:
  explicit GraphFilter(bool all_graphs_allowed)
      : all_graphs_allowed_(all_graphs_allowed) {}
  bool areAllGraphsAllowed() const { return all_graphs_allowed_; }
 private:
  bool all_graphs_allowed_;
};

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2, GraphFilter graph_filter)
      : col0_(col0), col1_(col1), col2_(col2), graph_filter_(graph_filter) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
  const GraphFilter& graphFilter() const { return graph_filter_; }
 private:
  T col0_;
  T col1_;
  T col2_;
  GraphFilter graph_filter_;
};

struct BackendState {
  int estimate_calls;
  int scan_calls;
};

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback,
    void*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  ScanSpecification spec{Id::fromBits(22), std::nullopt, std::nullopt, GraphFilter(false)};
  auto estimate = index.estimateScanSpecification(
      Permutation::Enum::POS,
      spec,
      XPOD_RDF_SLOT_SUBJECT);
  if (estimate.status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;

  auto scan = index.scanScanSpecification(
      Permutation::Enum::POS,
      spec,
      XPOD_RDF_SLOT_SUBJECT);
  if (scan.status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (scan.table.numColumns() != 1) return 3;
  if (scan.table.numRows() != 0) return 4;
  if (state.estimate_calls != 0) return 5;
  if (state.scan_calls != 0) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes batch term dictionary lookup and resolution through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index batch dictionary check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-batch-dict-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_batch_dictionary_smoke.cpp');
      const binary = path.join(root, 'physical_index_batch_dictionary_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int lookup_calls;
  int resolve_calls;
};

static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_calls;
  if (snapshot->facts_version.size != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (term_count != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI || terms[1].kind != XPOD_RDF_TERM_LITERAL) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 101;
  out_keys[1] = 202;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  out_statuses[1] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void* user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_calls;
  if (snapshot->facts_version.size != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (key_count != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (keys[0] != 101 || keys[1] != 202) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static const char iri[] = "urn:s";
  static const char literal[] = "hello";
  out_terms[0].kind = XPOD_RDF_TERM_IRI;
  out_terms[0].value = {iri, 5};
  out_terms[1].kind = XPOD_RDF_TERM_LITERAL;
  out_terms[1].value = {literal, 5};
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  out_statuses[1] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.resolve_terms = resolve_terms;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  static const char facts_version[] = "facts-v1";
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_version, 8};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  static const char iri[] = "urn:s";
  static const char literal[] = "hello";
  xpod_rdf_term terms[2] = {};
  terms[0].kind = XPOD_RDF_TERM_IRI;
  terms[0].value = {iri, 5};
  terms[1].kind = XPOD_RDF_TERM_LITERAL;
  terms[1].value = {literal, 5};

  auto lookup = index.lookupTerms(terms, 2);
  if (lookup.status != XPOD_RDF_STATUS_OK) return 1;
  if (lookup.keys.size() != 2 || lookup.statuses.size() != 2) return 2;
  if (lookup.keys[0] != 101 || lookup.keys[1] != 202) return 3;
  if (lookup.statuses[0] != XPOD_RDF_STATUS_OK || lookup.statuses[1] != XPOD_RDF_STATUS_OK) return 4;

  auto resolved = index.resolveTerms(lookup.keys.data(), lookup.keys.size());
  if (resolved.status != XPOD_RDF_STATUS_OK) return 5;
  if (resolved.terms.size() != 2 || resolved.statuses.size() != 2) return 6;
  if (resolved.terms[0].kind != XPOD_RDF_TERM_IRI) return 7;
  if (resolved.terms[1].kind != XPOD_RDF_TERM_LITERAL) return 8;
  if (state.lookup_calls != 1) return 9;
  if (state.resolve_calls != 1) return 10;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes prefix range lookup through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index prefix range check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-prefix-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_prefix_smoke.cpp');
      const binary = path.join(root, 'physical_index_prefix_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int prefix_calls;
};

static xpod_rdf_status prefix_range(
    void* user_data,
    const xpod_rdf_prefix_range_request* request,
    xpod_rdf_term_range_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->prefix_calls;
  if (request->snapshot.facts_version.size != 8) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->prefix.size != 4) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->has_kind != 1 || request->kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_term_range rows[2] = {};
  rows[0].lower = 10;
  rows[0].upper = 20;
  rows[0].has_lower = 1;
  rows[0].has_upper = 1;
  rows[0].lower_inclusive = 1;
  rows[0].upper_exclusive = 1;
  rows[1].lower = 30;
  rows[1].upper = 40;
  rows[1].has_lower = 1;
  rows[1].has_upper = 1;
  rows[1].lower_inclusive = 1;
  rows[1].upper_exclusive = 1;
  xpod_rdf_term_range_batch batch = {rows, 2, XPOD_RDF_TERM_COLLATION_BYTEWISE};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.prefix_range = prefix_range;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  static const char facts_version[] = "facts-v1";
  static const char prefix[] = "urn:";
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_version, 8};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  auto ranges = index.prefixRanges({prefix, 4}, XPOD_RDF_TERM_IRI);
  if (ranges.status != XPOD_RDF_STATUS_OK) return 1;
  if (ranges.collation != XPOD_RDF_TERM_COLLATION_BYTEWISE) return 2;
  if (ranges.ranges.size() != 2) return 3;
  if (ranges.ranges[0].lower != 10 || ranges.ranges[0].upper != 20) return 4;
  if (ranges.ranges[1].lower != 30 || ranges.ranges[1].upper != 40) return 5;
  if (state.prefix_calls != 1) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes scoped join fanout estimates through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index join fanout check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-join-fanout-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_join_fanout_smoke.cpp');
      const binary = path.join(root, 'physical_index_join_fanout_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int join_fanout_calls;
};

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected, size_t size) {
  if (actual.size != size) return false;
  for (size_t i = 0; i < size; ++i) {
    if (actual.data[i] != expected[i]) return false;
  }
  return true;
}

static xpod_rdf_status estimate_join_fanout(
    void* user_data,
    const xpod_rdf_join_fanout_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->join_fanout_calls;
  if (!bytes_equal(request->snapshot.facts_version, "facts", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->cancellation == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || request->graph_scope.exact_graph != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.has_source_node != 1 || request->source_scope.source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr || request->access_scope->mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern_count != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->bound_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->patterns[0].has_subject != 1 || request->patterns[0].subject != 11) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->patterns[1].has_object != 1 || request->patterns[1].object != 33) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 13;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.estimate_join_fanout = estimate_join_fanout;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {"facts", 5};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 99;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 55;
  request.access_scope = &access;
  xpod_rdf_cancellation cancellation = {};
  request.cancellation = &cancellation;
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod::qlever::TripleKeyPattern left = {};
  left.has_subject = true;
  left.subject = 11;
  xpod::qlever::TripleKeyPattern right = {};
  right.has_object = true;
  right.object = 33;
  std::vector<xpod::qlever::TripleKeyPattern> patterns{left, right};

  auto result = index.estimateJoinFanout(
      patterns,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.estimate.rows != 13) return 2;
  if (result.estimate.confidence != XPOD_RDF_ESTIMATE_FRESH) return 3;
  if (state.join_fanout_calls != 1) return 4;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('exposes access and source scope resolution through the physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index scope check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-scope-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_scope_smoke.cpp');
      const binary = path.join(root, 'physical_index_scope_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int resolve_access_calls;
  int estimate_access_calls;
  int estimate_source_calls;
  int resolve_source_calls;
};

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected, size_t size) {
  if (actual.size != size) return false;
  for (size_t i = 0; i < size; ++i) {
    if (actual.data[i] != expected[i]) return false;
  }
  return true;
}

static xpod_rdf_status resolve_access_scope(
    void* user_data,
    const xpod_rdf_bytes* principal,
    xpod_rdf_access_mode mode,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_access_scope* out_scope) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_access_calls;
  if (!bytes_equal(*principal, "alice", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (mode != XPOD_RDF_ACCESS_READ) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(snapshot->facts_version, "facts", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static const xpod_rdf_term_key allowed_graphs[1] = {99};
  out_scope->principal = *principal;
  out_scope->mode = mode;
  out_scope->authorization_model = XPOD_RDF_AUTH_ACP;
  out_scope->allowed_graphs = allowed_graphs;
  out_scope->allowed_graphs_size = 1;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_access_scope(
    void* user_data,
    const xpod_rdf_access_scope* access_scope,
    const xpod_rdf_source_scope* source_scope,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_access_calls;
  if (access_scope->allowed_graphs_size != 1 || access_scope->allowed_graphs[0] != 99) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (source_scope->has_source_node != 1 || source_scope->source_node != 55) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 3;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_source_scope(
    void* user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_source_calls;
  if (!bytes_equal(snapshot->facts_version, "facts", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(source_scope->local_path_prefix, "/workspace/", 11)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 5;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_source_scope(
    void* user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_resolved_source_scope* out_scope) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_source_calls;
  if (!bytes_equal(snapshot->facts_version, "facts", 5)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(source_scope->local_path_prefix, "/workspace/", 11)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static const xpod_rdf_source_node_key source_nodes[2] = {55, 56};
  out_scope->source_nodes = source_nodes;
  out_scope->source_nodes_size = 2;
  out_scope->graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  out_scope->graph_scope.exact_graph = 99;
  out_scope->scope_version = {"scope-v1", 8};
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.resolve_access_scope = resolve_access_scope;
  raw_backend.estimate_access_scope = estimate_access_scope;
  raw_backend.estimate_source_scope = estimate_source_scope;
  raw_backend.resolve_source_scope = resolve_source_scope;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {"facts", 5};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod_rdf_source_scope source_scope = {};
  source_scope.has_source_node = 1;
  source_scope.source_node = 55;
  source_scope.local_path_prefix = {"/workspace/", 11};

  auto access = index.resolveAccessScope({"alice", 5}, XPOD_RDF_ACCESS_READ);
  if (access.status != XPOD_RDF_STATUS_OK) return 1;
  if (access.scope.mode != XPOD_RDF_ACCESS_READ) return 2;
  if (access.scope.authorization_model != XPOD_RDF_AUTH_ACP) return 3;

  auto access_estimate = index.estimateAccessScope(access.scope, source_scope);
  if (access_estimate.status != XPOD_RDF_STATUS_OK) return 4;
  if (access_estimate.estimate.rows != 3) return 5;

  auto source_estimate = index.estimateSourceScope(source_scope);
  if (source_estimate.status != XPOD_RDF_STATUS_OK) return 6;
  if (source_estimate.estimate.rows != 5) return 7;

  auto source = index.resolveSourceScope(source_scope);
  if (source.status != XPOD_RDF_STATUS_OK) return 8;
  if (source.scope.source_nodes_size != 2) return 9;
  if (source.scope.source_nodes[0] != 55 || source.scope.source_nodes[1] != 56) return 10;
  if (source.scope.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT || source.scope.graph_scope.exact_graph != 99) return 11;
  if (state.resolve_access_calls != 1) return 12;
  if (state.estimate_access_calls != 1) return 13;
  if (state.estimate_source_calls != 1) return 14;
  if (state.resolve_source_calls != 1) return 15;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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

  it('fails closed when scope features are not in the capability snapshot', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index scope capability check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-index-scope-capability-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_index_scope_capability_smoke.cpp');
      const binary = path.join(root, 'physical_index_scope_capability_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int resolve_access_calls;
  int estimate_access_calls;
  int estimate_source_calls;
  int resolve_source_calls;
};

static xpod_rdf_status resolve_access_scope(
    void* user_data,
    const xpod_rdf_bytes*,
    xpod_rdf_access_mode,
    const xpod_rdf_snapshot*,
    xpod_rdf_access_scope*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_access_calls;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_access_scope(
    void* user_data,
    const xpod_rdf_access_scope*,
    const xpod_rdf_source_scope*,
    xpod_rdf_estimate*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_access_calls;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_source_scope(
    void* user_data,
    const xpod_rdf_source_scope*,
    const xpod_rdf_snapshot*,
    xpod_rdf_estimate*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_source_calls;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_source_scope(
    void* user_data,
    const xpod_rdf_source_scope*,
    const xpod_rdf_snapshot*,
    xpod_rdf_resolved_source_scope*) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->resolve_source_calls;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.resolve_access_scope = resolve_access_scope;
  raw_backend.estimate_access_scope = estimate_access_scope;
  raw_backend.estimate_source_scope = estimate_source_scope;
  raw_backend.resolve_source_scope = resolve_source_scope;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = XPOD_RDF_STATUS_OK;
  context.capabilities.features = XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod_rdf_access_scope access_scope = {};
  xpod_rdf_source_scope source_scope = {};

  auto access = index.resolveAccessScope({"alice", 5}, XPOD_RDF_ACCESS_READ);
  if (access.status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;

  auto access_estimate = index.estimateAccessScope(access_scope, source_scope);
  if (access_estimate.status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;

  auto source_estimate = index.estimateSourceScope(source_scope);
  if (source_estimate.status != XPOD_RDF_STATUS_UNSUPPORTED) return 3;

  auto source = index.resolveSourceScope(source_scope);
  if (source.status != XPOD_RDF_STATUS_UNSUPPORTED) return 4;

  if (state.resolve_access_calls != 0) return 5;
  if (state.estimate_access_calls != 0) return 6;
  if (state.estimate_source_calls != 0) return 7;
  if (state.resolve_source_calls != 0) return 8;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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


  it('adapts physical lazy scans to QLever generator ranges', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical lazy range check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-lazy-range-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_lazy_range_smoke.cpp');
      const binary = path.join(root, 'physical_lazy_range_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  if (request->block_metadata_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_quad_key first_rows[1] = {{101, 202, 303, 404}};
  xpod_rdf_quad_batch first = {first_rows, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  xpod_rdf_status status = on_batch(callback_user_data, &first);
  if (status != XPOD_RDF_STATUS_OK) return status;
  xpod_rdf_quad_key second_rows[1] = {{102, 202, 304, 404}};
  xpod_rdf_quad_batch second = {second_rows, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  return on_batch(callback_user_data, &second);
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = physical.getCapabilities(context.capabilities);
  xpod::qlever::XpodQleverPhysicalIndex index(context);

  xpod::qlever::XpodQleverScanSpecAndBlocks scan_spec = {};
  scan_spec.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  xpod_rdf_scan_block_metadata selected_block = {};
  selected_block.block_id = 8001;

  auto range = index.permutation(Permutation::Enum::SPO)
      .lazyScanRange(scan_spec, {selected_block});
  if (range.status != XPOD_RDF_STATUS_OK) return 1;
  auto first = range.blocks.get();
  if (!first.has_value()) return 2;
  if (first->numColumns() != 2 || first->numRows() != 1) return 3;
  if ((*first)(0, 0).getBits() != 101 || (*first)(0, 1).getBits() != 303) return 4;
  auto second = range.blocks.get();
  if (!second.has_value()) return 5;
  if ((*second)(0, 0).getBits() != 102 || (*second)(0, 1).getBits() != 304) return 6;
  if (range.blocks.get().has_value()) return 7;
  auto& details = range.blocks.details();
  if (details.numBlocksAll_ != 2) return 8;
  if (details.numBlocksRead_ != 2) return 9;
  if (details.numElementsRead_ != 2 || details.numElementsYielded_ != 2) return 10;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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
  it('exposes a lower lazy scan seam that preserves backend batch boundaries', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical lazy scan check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-lazy-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'physical_lazy_scan_smoke.cpp');
      const binary = path.join(root, 'physical_lazy_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndex.hpp"

struct BackendState {
  int scan_calls;
  size_t last_block_count;
  uint64_t last_block_id;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status get_capabilities_without_block_restricted_scan(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  state->last_block_count = request->block_metadata_count;
  state->last_block_id = request->block_metadata_count > 0
      ? request->block_metadata[0].block_id
      : 0;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata[0].block_id != 7001) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_quad_key first_rows[1] = {{11, 22, 33, 44}};
  xpod_rdf_quad_batch first = {first_rows, 1, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 1};
  xpod_rdf_status status = on_batch(callback_user_data, &first);
  if (status != XPOD_RDF_STATUS_OK) return status;

  xpod_rdf_quad_key second_rows[2] = {
    {12, 22, 34, 44},
    {13, 22, 35, 44},
  };
  xpod_rdf_quad_batch second = {second_rows, 2, XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT, 2};
  return on_batch(callback_user_data, &second);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext context{physical, &request, request.cancellation};
  context.capabilities_status = physical.getCapabilities(context.capabilities);
  xpod::qlever::XpodQleverPhysicalIndex index(context);
  auto permutation = index.permutation(Permutation::Enum::SPO);

  xpod::qlever::XpodQleverScanSpecAndBlocks scan_spec = {};
  scan_spec.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  xpod_rdf_scan_block_metadata selected_block = {};
  selected_block.block_id = 7001;

  auto lazy = permutation.lazyScan(scan_spec, {selected_block});
  if (lazy.status != XPOD_RDF_STATUS_OK) return 1;
  if (lazy.blocks.size() != 2) return 2;
  if (lazy.blocks[0].numColumns() != 2 || lazy.blocks[0].numRows() != 1) return 3;
  if (lazy.blocks[1].numColumns() != 2 || lazy.blocks[1].numRows() != 2) return 4;
  if (lazy.blocks[0](0, 0).getBits() != 11) return 5;
  if (lazy.blocks[0](0, 1).getBits() != 33) return 6;
  if (lazy.blocks[1](1, 0).getBits() != 13) return 7;
  if (lazy.blocks[1](1, 1).getBits() != 35) return 8;
  if (state.scan_calls != 1) return 9;
  if (state.last_block_count != 1 || state.last_block_id != 7001) return 10;

  auto empty = permutation.lazyScan(scan_spec, {});
  if (empty.status != XPOD_RDF_STATUS_OK) return 11;
  if (!empty.blocks.empty()) return 12;
  if (state.scan_calls != 1) return 13;

  xpod_rdf_backend_v1 no_block_backend = raw_backend;
  no_block_backend.get_capabilities = get_capabilities_without_block_restricted_scan;
  xpod::rdf::PhysicalBackend no_block_physical(&no_block_backend);
  xpod_qlever_query_request no_block_request = {};
  xpod::qlever::PlannerRequestContext no_block_context{
      no_block_physical,
      &no_block_request,
      no_block_request.cancellation};
  no_block_context.capabilities_status =
      no_block_physical.getCapabilities(no_block_context.capabilities);
  xpod::qlever::XpodQleverPhysicalIndex no_block_index(no_block_context);
  auto unsupported = no_block_index.permutation(Permutation::Enum::SPO)
      .lazyScan(scan_spec, {selected_block});
  if (unsupported.status != XPOD_RDF_STATUS_UNSUPPORTED) return 14;
  if (!unsupported.blocks.empty()) return 15;
  if (state.scan_calls != 1) return 16;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(physicalIndexHeader),
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
