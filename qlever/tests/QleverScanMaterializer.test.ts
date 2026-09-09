import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const materializerHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverScanMaterializer.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever scan materializer', () => {
  it('folds physical GeoSPARQL WKT POINT literals into inline QLever GeoPoint ids', () => {
    const source = readFileSync(materializerHeader, 'utf8');

    expect(source).toContain('GEO_WKT_LITERAL');
    expect(source).toContain('GeoPoint::parseFromLiteral');
    expect(source).toContain('Id::makeFromGeoPoint');
  });

  it('materializes Xpod quad batches into QLever permutation row order', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan materializer check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-materializer-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeFromInt(int64_t value) { return Id(9000000ULL + static_cast<uint64_t>(value)); }
  static Id makeFromDouble(double value) { return Id(9100000ULL + static_cast<uint64_t>(value * 10)); }
  static Id makeFromBool(bool value) { return Id(value ? 9200001ULL : 9200000ULL); }
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

      const smoke = path.join(root, 'scan_materializer_smoke.cpp');
      const binary = path.join(root, 'scan_materializer_smoke');
      await writeFile(smoke, `
#include "XpodQleverScanMaterializer.hpp"

int main() {
  xpod_rdf_quad_key rows[2] = {
    {10, 20, 30, 40},
    {11, 21, 31, 41},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;

  xpod::qlever::ScanRowBuffer buffer;
  xpod::qlever::appendBatch(buffer, Permutation::Enum::POS, batch);

  if (buffer.width != 3) return 1;
  if (buffer.rows.size() != 6) return 2;
  if (buffer.rows[0] != 20 || buffer.rows[1] != 30 || buffer.rows[2] != 10) return 3;
  if (buffer.rows[3] != 21 || buffer.rows[4] != 31 || buffer.rows[5] != 11) return 4;

  xpod::qlever::ScanRowBuffer ops;
  xpod::qlever::appendBatch(ops, Permutation::Enum::OPS, batch);
  if (ops.rows[0] != 30 || ops.rows[1] != 20 || ops.rows[2] != 10) return 5;

  xpod::qlever::ScanRowBuffer with_graph;
  xpod::qlever::appendBatch(
      with_graph,
      Permutation::Enum::SPO,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH,
      batch);
  if (with_graph.width != 2) return 6;
  if (with_graph.rows.size() != 4) return 7;
  if (with_graph.rows[0] != 10 || with_graph.rows[1] != 40) return 8;
  if (with_graph.rows[2] != 11 || with_graph.rows[3] != 41) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(materializerHeader),
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

  it('materializes scan rows as QLever id bits through the backend codec', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan materializer check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-id-materializer-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeFromInt(int64_t value) { return Id(9000000ULL + static_cast<uint64_t>(value)); }
  static Id makeFromDouble(double value) { return Id(9100000ULL + static_cast<uint64_t>(value * 10)); }
  static Id makeFromBool(bool value) { return Id(value ? 9200001ULL : 9200000ULL); }
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

      const smoke = path.join(root, 'scan_id_materializer_smoke.cpp');
      const binary = path.join(root, 'scan_id_materializer_smoke');
      await writeFile(smoke, `
#include "XpodQleverScanMaterializer.hpp"
#include "global/Id.h"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.encode_qlever_id = encode;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_quad_key rows[1] = {
    {10, 20, 30, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;

  xpod::qlever::QleverIdRowBuffer buffer;
  xpod_rdf_status status = xpod::qlever::appendEncodedBatch(
      buffer, physical, Permutation::Enum::SOP, batch);
  if (status != XPOD_RDF_STATUS_OK) return 1;
  if (buffer.width != 3) return 2;
  if (buffer.rows.size() != 3) return 3;
  if (buffer.rows[0] != 1010 || buffer.rows[1] != 1030 || buffer.rows[2] != 1020) return 4;

  xpod::qlever::QleverIdRowBuffer graph_buffer;
  status = xpod::qlever::appendEncodedBatch(
      graph_buffer,
      physical,
      Permutation::Enum::SPO,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH,
      batch);
  if (status != XPOD_RDF_STATUS_OK) return 5;
  if (graph_buffer.width != 2) return 6;
  if (graph_buffer.rows.size() != 2) return 7;
  if (graph_buffer.rows[0] != 1010 || graph_buffer.rows[1] != 1040) return 8;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(materializerHeader),
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

  it('preserves typed literal scan values as physical term ids', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan materializer check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-typed-literal-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeFromInt(int64_t value) { return Id(9000000ULL + static_cast<uint64_t>(value)); }
  static Id makeFromDouble(double value) { return Id(9100000ULL + static_cast<uint64_t>(value * 10)); }
  static Id makeFromBool(bool value) { return Id(value ? 9200001ULL : 9200000ULL); }
  uint64_t getBits() const { return bits_; }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`, 'utf8');

      const smoke = path.join(root, 'scan_typed_literal_materializer_smoke.cpp');
      const binary = path.join(root, 'scan_typed_literal_materializer_smoke');
      await writeFile(smoke, `
#include "XpodQleverScanMaterializer.hpp"
#include "global/Id.h"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve(
    void*,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_term) {
  if (key != 30 && key != 31) return XPOD_RDF_STATUS_NOT_FOUND;
  static const char integer_value[] = "2";
  static const char decimal_value[] = "1.5";
  static const char integer_datatype[] = "http://www.w3.org/2001/XMLSchema#integer";
  static const char decimal_datatype[] = "http://www.w3.org/2001/XMLSchema#decimal";
  out_term->kind = XPOD_RDF_TERM_LITERAL;
  out_term->value = key == 30
      ? xpod_rdf_bytes{integer_value, 1}
      : xpod_rdf_bytes{decimal_value, 3};
  out_term->datatype_iri = key == 30
      ? xpod_rdf_bytes{integer_datatype, sizeof(integer_datatype) - 1}
      : xpod_rdf_bytes{decimal_datatype, sizeof(decimal_datatype) - 1};
  out_term->language = {nullptr, 0};
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.encode_qlever_id = encode;
  backend.resolve_term = resolve;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_quad_key rows[2] = {
    {10, 20, 30, 40},
    {10, 20, 31, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;

  xpod::qlever::QleverIdRowBuffer buffer;
  xpod_rdf_status status = xpod::qlever::appendEncodedBatch(
      buffer, physical, Permutation::Enum::SPO, batch);
  if (status != XPOD_RDF_STATUS_OK) return 1;
  if (buffer.rows.size() != 6) return 2;
  if (buffer.rows[0] != 1010) return 3;
  if (buffer.rows[1] != 1020) return 4;
  if (buffer.rows[2] != 1030) return 5;
  if (buffer.rows[5] != 1031) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(materializerHeader),
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

  it('uses batch ValueId projection even when the object slot is requested', () => {
    const source = readFileSync(materializerHeader, 'utf8');

    expect(source).not.toContain(
      'if ((normalized_needed_slots & XPOD_RDF_SLOT_OBJECT) == 0 && width != 0)',
    );
    expect(source).toContain('if (width != 0)');
  });

});
