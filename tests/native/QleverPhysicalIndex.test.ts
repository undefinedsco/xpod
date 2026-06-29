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
});
