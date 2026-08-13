import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverIdTableBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever IdTable bridge', () => {
  it('converts QLever id-bit row buffers into an upstream IdTable', async () => {
    expect(hasCxx(), 'c++ compiler is required for native IdTable bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-idtable-bridge-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
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

      const smoke = path.join(root, 'idtable_bridge_smoke.cpp');
      const binary = path.join(root, 'idtable_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverIdTableBridge.hpp"

int main() {
  xpod::qlever::QleverIdRowBuffer rows;
  rows.width = 3;
  rows.rows = {11, 12, 13, 21, 22, 23};

  IdTable table = xpod::qlever::toQleverIdTable(rows);
  if (table.numColumns() != 3) return 1;
  if (table.numRows() != 2) return 2;
  if (table(0, 0).getBits() != 11 || table(0, 2).getBits() != 13) return 3;
  if (table(1, 0).getBits() != 21 || table(1, 2).getBits() != 23) return 4;
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

  it('executes a physical scan and returns a QLever IdTable', async () => {
    expect(hasCxx(), 'c++ compiler is required for native IdTable bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-idtable-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
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

      const smoke = path.join(root, 'scan_idtable_smoke.cpp');
      const binary = path.join(root, 'scan_idtable_smoke');
      await writeFile(smoke, `
#include "XpodQleverIdTableBridge.hpp"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static size_t resolved_key_count = 0;
static size_t prefetched_key_count = 0;
static size_t batch_encoded_key_count = 0;

static xpod_rdf_status encode_qlever_ids(
    void*, const xpod_rdf_term_key* terms, size_t term_count,
    const xpod_rdf_snapshot*, uint64_t* out_bits) {
  batch_encoded_key_count += term_count;
  for (size_t index = 0; index < term_count; ++index) {
    out_bits[index] = terms[index] + 2000;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status prefetch_qlever_ids(
    void*, const xpod_rdf_term_key*, size_t key_count,
    const xpod_rdf_snapshot*) {
  prefetched_key_count += key_count;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void*, const xpod_rdf_term_key*, size_t key_count,
    const xpod_rdf_snapshot*, xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  resolved_key_count += key_count;
  for (size_t index = 0; index < key_count; ++index) {
    out_terms[index].kind = XPOD_RDF_TERM_IRI;
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  xpod_rdf_quad_key rows[2] = {
    {10, 20, 30, 40},
    {11, 20, 31, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  return on_batch(callback_user_data, &batch);
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.encode_qlever_id = encode;
  backend.encode_qlever_ids = encode_qlever_ids;
  backend.prefetch_qlever_ids = prefetch_qlever_ids;
  backend.resolve_terms = resolve_terms;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::OPS;
  input.needed_slots = XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_SUBJECT;

  auto result = xpod::qlever::executeScanToQleverIdTable(physical, input);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.table.numColumns() != 2 || result.table.numRows() != 2) return 2;
  if (result.table(0, 0).getBits() != 2020) return 3;
  if (result.table(0, 1).getBits() != 2010) return 4;
  if (result.table(1, 0).getBits() != 2020) return 7;
  if (result.table(1, 1).getBits() != 2011) return 8;
  if (batch_encoded_key_count != 4 || prefetched_key_count != 0 ||
      resolved_key_count != 0) return 9;

  input.needed_slots = 0;
  auto zero_width = xpod::qlever::executeScanToQleverIdTable(physical, input);
  if (zero_width.status != XPOD_RDF_STATUS_OK) return 5;
  if (zero_width.table.numColumns() != 0 || zero_width.table.numRows() != 2) return 6;
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
});
