import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeParsedQueryHeader, fakeThrowingSparqlParserHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

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

describe('QLever executor factory', () => {
  it('uses the upstream bridge executor branch when QLever support is compiled in', async () => {
    expect(hasCxx(), 'c++ compiler is required for native executor factory check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-executor-factory-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), fakeThrowingSparqlParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), '#pragma once\n', 'utf8');
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
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  uint64_t getBits() const { return bits_; }
  uint64_t bits_;
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
class LocalVocab {};
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
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'enabled_executor_smoke.cpp');
      const binary = path.join(root, 'enabled_executor_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "urn:p") return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 20;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
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
  static const char o[] = "value";
  static const char datatype[] = "http://www.w3.org/2001/XMLSchema#string";
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = XPOD_RDF_STATUS_OK;
    if (keys[i] == 10) {
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {s, 5};
    } else if (keys[i] == 20) {
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {p, 5};
    } else if (keys[i] == 30) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {o, 5};
      out_terms[i].datatype_iri = {datatype, 40};
    } else {
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
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

struct ScanState {
  bool saw_context = false;
};

static xpod_rdf_status scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->snapshot.snapshot_token.size != 7) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(request->snapshot.snapshot_token.data, request->snapshot.snapshot_token.size) != "snap-v1") return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  if (std::string_view(request->access_scope->principal.data, request->access_scope->principal.size) != "urn:alice") return XPOD_RDF_STATUS_PERMISSION_DENIED;
  state->saw_context = true;
  xpod_rdf_quad_key rows[1] = {{10, 20, 30, 40}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  ScanState scan_state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &scan_state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.lookup_terms = lookup_terms;
  backend.resolve_terms = resolve_terms;
  backend.estimate_scan = estimate_scan;
  backend.scan_permutation = scan;

  xpod_qlever_adapter_config config = {};
  config.backend = &backend;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  xpod_qlever_query_result result = {};
  xpod_rdf_bytes query = {"SELECT ?s ?p ?o WHERE { ?s <urn:p> ?o }", 39};
  xpod_rdf_access_scope access = {};
  access.principal = {"urn:alice", 9};
  xpod_qlever_query_request request = {};
  request.sparql = query;
  request.snapshot.snapshot_token = {"snap-v1", 7};
  request.access_scope = &access;
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view body(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 2;
  if (result.status != XPOD_RDF_STATUS_OK) return 3;
  if (body.find("\\"head\\":{\\"vars\\":[\\"s\\",\\"p\\",\\"o\\"]}") == std::string_view::npos) return 4;
  if (body.find("\\"s\\":{\\"type\\":\\"uri\\",\\"value\\":\\"urn:s\\"}") == std::string_view::npos) return 5;
  if (body.find("\\"o\\":{\\"type\\":\\"literal\\",\\"value\\":\\"value\\"") == std::string_view::npos) return 8;
  if (body.find("1010") != std::string_view::npos) return 9;
  if (profile.find("\\"kind\\":\\"PermutationScan\\"") == std::string_view::npos) return 10;
  if (profile.find("\\"outputRows\\":1") == std::string_view::npos) return 11;
  if (profile.find("\\"descriptor\\":\\"xpod scan ?s ?p ?o\\"") == std::string_view::npos) return 12;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_rdf_bytes unsupported_query = {"ASK { ?s ?p ?o }", 16};
  status = xpod_qlever_adapter_query(adapter, unsupported_query, &result);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 6;
  if (error.find("unsupported QLever bridge query") == std::string_view::npos) return 7;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_rdf_bytes broken_query = {"BROKEN { ?s ?p ?o }", 20};
  status = xpod_qlever_adapter_query(adapter, broken_query, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 13;
  if (error.find("failed to parse QLever bridge query") == std::string_view::npos) return 14;

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
