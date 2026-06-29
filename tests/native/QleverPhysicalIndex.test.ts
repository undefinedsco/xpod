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
