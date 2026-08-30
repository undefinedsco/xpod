import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const publicHeader = path.join(repoRoot, 'qlever/rdf_protocol/include/xpod_rdf_physical_backend.h');
const facadeHeader = path.join(repoRoot, 'qlever/qlever_adapter/include/xpod_qlever_adapter.h');
const facadeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverExecutor.hpp');
const executorSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverExecutor.cpp');
const physicalValueIdContextBridge = path.join(
  repoRoot,
  'qlever/qlever_adapter/src/XpodQleverPhysicalValueIdContextBridge.hpp',
);
const nativeCheckTimeoutMs = 120_000;

type MutationKind = 'insert' | 'delete';

interface HarnessMutation {
  kind: MutationKind;
  quad: string;
}

function preparedNetDeltaHarness(
  initialQuads: readonly string[],
  mutations: readonly HarnessMutation[],
): HarnessMutation[] {
  const transactionalState = new Set(initialQuads);
  const initialSeen = new Map<string, boolean>();

  for (const mutation of mutations) {
    if (!initialSeen.has(mutation.quad)) {
      initialSeen.set(mutation.quad, transactionalState.has(mutation.quad));
    }
    if (mutation.kind === 'insert') {
      transactionalState.add(mutation.quad);
    } else {
      transactionalState.delete(mutation.quad);
    }
  }

  const orderedQuads = [...initialSeen.keys()].sort();
  const net: HarnessMutation[] = [];
  for (const quad of orderedQuads) {
    const initiallyExists = initialSeen.get(quad) ?? false;
    const finallyExists = transactionalState.has(quad);
    if (!initiallyExists && finallyExists) {
      net.push({ kind: 'insert', quad });
    } else if (initiallyExists && !finallyExists) {
      net.push({ kind: 'delete', quad });
    }
  }
  return net;
}

function requireCompiler(name: 'c++'): string {
  try {
    execFileSync('/usr/bin/env', [name, '--version'], { stdio: 'ignore' });
    return name;
  } catch {
    throw new Error(`${name} compiler is required for native QLever adapter facade syntax check`);
  }
}

describe('native QLever adapter facade', () => {
  it('declares a C ABI facade without exposing QLever or C++ types', () => {
    expect(existsSync(facadeHeader)).toBe(true);
    const header = readFileSync(facadeHeader, 'utf8');

    expect(header).toContain('#include "xpod_rdf_physical_backend.h"');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_qlever_adapter_config');
    expect(header).toContain('typedef enum xpod_qlever_execution_policy');
    expect(header).toContain('XPOD_QLEVER_EXECUTION_NATIVE_ONLY = 0');
    expect(header).toContain('XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED = 1');
    expect(header).toContain('xpod_qlever_execution_policy execution_policy');
    expect(header).toContain('typedef struct xpod_qlever_backend_provider_config');
    expect(header).toContain('const xpod_qlever_backend_provider_config* backend_provider');
    expect(header).toContain('typedef struct xpod_qlever_query_request');
    expect(header).toContain('typedef enum xpod_qlever_request_operation');
    expect(header).toContain('XPOD_QLEVER_REQUEST_EXECUTE = 0');
    expect(header).toContain('XPOD_QLEVER_REQUEST_PREPARE_UPDATE = 1');
    expect(header).toContain('xpod_qlever_request_operation operation');
    expect(header).toContain('typedef struct xpod_qlever_vector_query');
    expect(header).toContain('const xpod_qlever_vector_query* vector_query');
    expect(header).toContain('xpod_rdf_bytes provider');
    expect(header).toContain('xpod_rdf_bytes model_version');
    expect(header).toContain('xpod_rdf_bytes input_kind');
    expect(header).toContain('xpod_rdf_bytes projection_policy_version');
    expect(header).toContain('xpod_rdf_graph_scope graph_scope');
    expect(header).toContain('xpod_rdf_source_scope source_scope');
    expect(header).toContain('xpod_rdf_bytes accept_media_type');
    expect(header).toContain('xpod_rdf_bytes result_media_type');
    expect(header).toContain('xpod_qlever_adapter_query_request');
    expect(header).toContain('xpod_qlever_adapter_create');
    expect(header).toContain('xpod_qlever_adapter_destroy');
    expect(header).toContain('xpod_qlever_adapter_abi_version');
    expect(header).toContain('xpod_qlever_adapter_inline_term_bits');
    expect(header).toContain('uint8_t* out_is_inline');

    expect(header).not.toMatch(/std::|namespace\s+|template\s*</);
    expect(header).not.toMatch(/IndexImpl|PermutationPtr|RuntimeInformation/);
  });

  it('defaults zero-initialized adapters to native-only and rejects unknown policies', () => {
    const source = readFileSync(facadeSource, 'utf8');

    expect(source).toContain(
      'config->execution_policy != XPOD_QLEVER_EXECUTION_NATIVE_ONLY &&',
    );
    expect(source).toContain(
      'config->execution_policy != XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED',
    );
    expect(source).toMatch(
      /config->execution_policy\s*==\s*XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED/,
    );
  });

  it('projects persisted RDF literals with QLever native inline codecs', () => {
    const source = readFileSync(facadeSource, 'utf8');

    expect(source).toContain('#include "XpodQleverScanMaterializer.hpp"');
    expect(source).toContain('inlineTypedLiteralBits(*term)');
    expect(source).toContain('*out_is_inline = 1');
  });

  it('compares decoded physical literals through QLever inline typed value ids', () => {
    const source = readFileSync(physicalValueIdContextBridge, 'utf8');

    expect(source).toContain('inlineTypedLiteralIdFromEntry');
    expect(source).toContain('inlineTypedLiteralComparisonBits(term)');
    expect(source).toContain('normalizeInlineIdForComparison(id)');
    expect(source).toContain('relationalValueFromPhysicalId(left, index, context)');
    expect(source).toContain('relationalValueFromQleverId(left, qlever_index, local_vocab, context)');
    expect(source).toContain('compareRelationalValueOrder(*left_value, *right_value)');
    expect(source).toContain('valueIdComparators::compareIds<');
    expect(source).not.toContain('if (*left_entry < *right_entry)');
  });

  it('executes physical and inline typed literal comparisons with QLever value semantics', async () => {
    const cxx = requireCompiler('c++');

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-value-'));
    try {
      const fakeQlever = path.join(root, 'qlever');
      await mkdir(path.join(fakeQlever, 'global'), { recursive: true });
      await mkdir(path.join(fakeQlever, 'engine/sparqlExpressions'), { recursive: true });
      await writeFile(
        path.join(fakeQlever, 'global/ValueIdComparators.h'),
        '#pragma once\n',
        'utf8',
      );
      await writeFile(
        path.join(fakeQlever, 'engine/sparqlExpressions/SparqlExpressionTypes.h'),
        '#pragma once\n',
        'utf8',
      );

      const smoke = path.join(root, 'physical_value_compare_smoke.cpp');
      const binary = path.join(root, 'physical_value_compare_smoke');
      await writeFile(smoke, `
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#define XPOD_QLEVER_ADAPTER_ENABLE_QLEVER 1
#define XPOD_QLEVER_PHYSICAL_INDEX_HPP
#define XPOD_QLEVER_SCAN_MATERIALIZER_HPP
#define XPOD_QLEVER_VALUE_ID_BRIDGE_HPP

#include "xpod_rdf_physical_backend.h"

enum class Datatype { VocabIndex, BlankNodeIndex, LocalVocabIndex, EncodedVal, Int };

class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits, Datatype::VocabIndex); }
  static Id makeFromInt(int64_t value) {
    return Id(9000000ULL + static_cast<uint64_t>(value), Datatype::Int);
  }
  static Id makeFromLocalVocabIndex(const void* entry) {
    return Id(reinterpret_cast<uintptr_t>(entry), Datatype::LocalVocabIndex);
  }
  uint64_t getBits() const { return bits_; }
  Datatype getDatatype() const { return datatype_; }
  uint64_t getLocalVocabIndex() const { return bits_; }
  bool operator==(const Id& other) const {
    return bits_ == other.bits_ && datatype_ == other.datatype_;
  }
  bool operator!=(const Id& other) const { return !(*this == other); }
 private:
  Id(uint64_t bits, Datatype datatype) : bits_(bits), datatype_(datatype) {}
  uint64_t bits_;
  Datatype datatype_;
};

inline bool operator<(const Id& left, const Id& right) {
  return left.getBits() < right.getBits();
}

inline bool toBoolNotUndef(bool value) { return value; }

namespace valueIdComparators {
enum class ComparisonForIncompatibleTypes { CompareByType };
enum class Comparison { LT, GT };
using ComparisonResult = bool;

template <ComparisonForIncompatibleTypes>
bool compareIds(const Id& left, const Id& right, Comparison comparison) {
  if (comparison == Comparison::LT) {
    return left.getBits() < right.getBits();
  }
  return left.getBits() > right.getBits();
}
}

namespace ad_utility::triple_component {
class Iri {
 public:
  static Iri fromIrirefWithoutBrackets(std::string value) {
    return Iri(std::move(value));
  }
  const std::string& value() const { return value_; }
 private:
  explicit Iri(std::string value) : value_(std::move(value)) {}
  std::string value_;
};

class LiteralOrIri {
 public:
  static LiteralOrIri iriref(std::string value) {
    LiteralOrIri result;
    result.is_iri_ = true;
    result.value_ = std::move(value);
    return result;
  }
  static LiteralOrIri literalWithoutQuotes(
      std::string value,
      std::optional<std::variant<Iri, std::string>> descriptor = std::nullopt) {
    LiteralOrIri result;
    result.value_ = std::move(value);
    if (descriptor.has_value() && std::holds_alternative<Iri>(*descriptor)) {
      result.datatype_ = std::get<Iri>(*descriptor).value();
    }
    return result;
  }
  bool isLiteral() const { return !is_iri_; }
  std::string_view getLiteralContent() const { return value_; }
  bool hasDatatype() const { return !datatype_.empty(); }
  std::string_view getDatatype() const { return datatype_; }
  bool hasLanguageTag() const { return false; }
  std::string_view getLanguageTag() const { return {}; }
 private:
  bool is_iri_ = false;
  std::string value_;
  std::string datatype_;
};
}

inline std::string_view asStringViewUnsafe(std::string_view value) {
  return value;
}

class LocalVocabContext {};
class LocalVocab {
 public:
  const int& getWord(uint64_t) const { return word_; }
 private:
  int word_ = 0;
};
class Index {
 public:
  int getImpl() const { return 0; }
};

namespace xpod::qlever {
class XpodQleverPhysicalIndex;
}

class QueryExecutionContext {
 public:
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return physical_;
  }
  const Index& getIndex() const { return index_; }
  const LocalVocabContext& getLocalVocabContext() const { return context_; }
  const xpod::qlever::XpodQleverPhysicalIndex* physical_ = nullptr;
  Index index_;
  LocalVocabContext context_;
};

namespace sparqlExpression {
struct EvaluationContext {
  QueryExecutionContext& _qec;
  LocalVocab& _localVocab;
};
}

class LocalVocabEntry {
 public:
  LocalVocabEntry(
      ad_utility::triple_component::LiteralOrIri value,
      const LocalVocabContext&)
      : value_(std::move(value)) {}
  const ad_utility::triple_component::LiteralOrIri& asLiteralOrIri() const {
    return value_;
  }
 private:
  ad_utility::triple_component::LiteralOrIri value_;
};

namespace ql::exportIds {
inline ad_utility::triple_component::LiteralOrIri getLiteralOrIriFromVocabIndex(
    int, const Id&, const LocalVocab&) {
  return ad_utility::triple_component::LiteralOrIri::literalWithoutQuotes("unused");
}
}

namespace xpod::qlever {
struct xpod_qlever_query_request {
  xpod_rdf_snapshot snapshot = {};
};
}

namespace xpod::rdf {
class PhysicalBackend {};
}

namespace xpod::qlever {
struct PlannerRequestContext {
  xpod::rdf::PhysicalBackend backend;
  const xpod_qlever_query_request* request = nullptr;
};
struct XpodQleverResolveTermsResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_term> terms;
  std::vector<xpod_rdf_status> statuses;
};
class XpodQleverPhysicalIndex {
 public:
  const PlannerRequestContext& plannerRequestContext() const {
    return planner_context_;
  }
  xpod_rdf_status compareQleverIds(
      uint64_t left, uint64_t right, int32_t& out) const {
    out = left < right ? -1 : (left > right ? 1 : 0);
    return XPOD_RDF_STATUS_OK;
  }
  XpodQleverResolveTermsResult resolveTerms(
      const xpod_rdf_term_key* keys,
      size_t count) const {
    XpodQleverResolveTermsResult result{XPOD_RDF_STATUS_OK, {}, {}};
    for (size_t index = 0; index < count; ++index) {
      const bool is_ten = keys[index] == 10;
      result.terms.push_back({
          XPOD_RDF_TERM_LITERAL,
          is_ten ? xpod_rdf_bytes{"10", 2} : xpod_rdf_bytes{"2", 1},
          {"http://www.w3.org/2001/XMLSchema#integer", 40},
          {}
      });
      result.statuses.push_back(XPOD_RDF_STATUS_OK);
    }
    return result;
  }
  xpod_rdf_status decodeQleverId(uint64_t bits, xpod_rdf_term_key& out) const {
    if (bits == 1002) {
      out = 2;
      return XPOD_RDF_STATUS_OK;
    }
    if (bits == 1010) {
      out = 10;
      return XPOD_RDF_STATUS_OK;
    }
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
 private:
  PlannerRequestContext planner_context_;
};
namespace detail {
template <typename Component>
bool qleverComponentIsVariable(const Component&) { return true; }
}
template <typename Component>
xpod_rdf_status qleverComponentToPhysicalTermKey(
    const PlannerRequestContext&, const Component&, xpod_rdf_term_key&) {
  return XPOD_RDF_STATUS_UNSUPPORTED;
}
inline xpod_rdf_status encodePhysicalTermAsQleverId(
    const xpod::rdf::PhysicalBackend&, xpod_rdf_term_key,
    const xpod_rdf_snapshot*, uint64_t&) {
  return XPOD_RDF_STATUS_UNSUPPORTED;
}
inline std::optional<uint64_t> inlineTypedLiteralBits(
    const xpod_rdf_term& term) {
  std::string_view lexical(term.value.data, term.value.size);
  if (lexical == "2") return Id::makeFromInt(2).getBits();
  if (lexical == "10") return Id::makeFromInt(10).getBits();
  return std::nullopt;
}
inline std::optional<uint64_t> inlineTypedLiteralComparisonBits(
    const xpod_rdf_term& term) {
  return inlineTypedLiteralBits(term);
}
inline std::optional<Id> normalizeInlineIdForComparison(Id id) {
  return id;
}
inline Id toQleverId(uint64_t bits) { return Id::fromBits(bits); }
}

#include "XpodQleverPhysicalValueIdContextBridge.hpp"

int main() {
  xpod::qlever::XpodQleverPhysicalIndex physical;
  Index qleverIndex;
  LocalVocab localVocab;
  LocalVocabContext context;

  int32_t compare = *xpod::qlever::comparePhysicalValueIds(
      Id::fromBits(1002), Id::fromBits(1010), &physical, qleverIndex,
      localVocab, context);
  if (compare >= 0) return 1;

  compare = *xpod::qlever::comparePhysicalValueIds(
      Id::fromBits(1010), Id::fromBits(1002), &physical, qleverIndex,
      localVocab, context);
  if (compare <= 0) return 2;

  compare = *xpod::qlever::comparePhysicalValueIds(
      Id::fromBits(1002), Id::makeFromInt(2), &physical, qleverIndex,
      localVocab, context);
  if (compare != 0) return 3;

  compare = *xpod::qlever::comparePhysicalValueIds(
      Id::makeFromInt(10), Id::fromBits(1002), &physical, qleverIndex,
      localVocab, context);
  if (compare <= 0) return 4;

  return 0;
}
`, 'utf8');

      execFileSync(cxx, [
        '-std=c++20',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', fakeQlever,
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compiles the facade translation unit against the physical backend ABI', async () => {
    expect(existsSync(publicHeader)).toBe(true);
    expect(existsSync(facadeSource)).toBe(true);

    const cxx = requireCompiler('c++');
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-'));
    try {
      const smoke = path.join(root, 'adapter_smoke.cpp');
      await writeFile(smoke, `#include <stddef.h>\n#include "qlever/qlever_adapter/include/xpod_qlever_adapter.h"\nint main() {\n  xpod_qlever_adapter_config config = {};\n  config.backend = nullptr;\n  config.memory_limit_bytes = 0;\n  config.enable_runtime_profile = 1;\n  xpod_qlever_query_request request = {};\n  request.operation = XPOD_QLEVER_REQUEST_PREPARE_UPDATE;\n  return config.backend == nullptr &&\n      config.memory_limit_bytes == 0 &&\n      config.enable_runtime_profile == 1 &&\n      request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE &&\n      xpod_qlever_adapter_abi_version() == XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION ? 0 : 1;\n}\n`, 'utf8');

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', repoRoot,
        '-fsyntax-only',
        facadeSource,
      ], { stdio: 'pipe' });

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', repoRoot,
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-fsyntax-only',
        smoke,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes the QLever adapter facade in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'qlever/scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter facade');
  }, nativeCheckTimeoutMs);

  it('has a product-provided document loader boundary for SPARQL LOAD', () => {
    const protocolHeader = readFileSync(publicHeader, 'utf8');
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(protocolHeader).toContain('xpod_rdf_load_document_fn');
    expect(bridgeSource).toContain('parseSimpleLoadUpdate(');
    expect(bridgeSource).toContain('consumeSparqlKeyword(rest, "silent")');
    expect(bridgeSource).toContain('load_update.silent');
    expect(bridgeSource).toContain('backend.loadDocument(');
    expect(bridgeSource).toContain('parseNTriplesLoadDocument(');
    expect(bridgeSource).toContain('unsupported SPARQL LOAD');
  });

  it('scopes LOAD blank nodes to one document parse', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridgeSource).toContain('makeLoadBlankNodeScope()');
    expect(bridgeSource).toContain(
      'const std::string blank_node_scope = makeLoadBlankNodeScope();',
    );
    expect(bridgeSource).toContain(
      'scopeLoadBlankNode(owned.subject, blank_node_scope);',
    );
    expect(bridgeSource).toContain(
      'scopeLoadBlankNode(owned.object, blank_node_scope);',
    );
    expect(bridgeSource).toContain(
      'const bool is_blank_node = value.rfind("_:", 0) == 0;',
    );
    expect(bridgeSource).toContain(
      'out_term.term.kind = is_blank_node ? XPOD_RDF_TERM_BLANK : XPOD_RDF_TERM_IRI;',
    );
  });

  it('executes bounded graph CLEAR/DROP through a physical graph-management path', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridgeSource).toContain('parseSimpleClearOrDropGraphUpdate(');
    expect(bridgeSource).toContain('executeSimpleGraphManagementUpdate(');
    expect(bridgeSource).toContain('backend.scanPermutation(');
    expect(bridgeSource).toContain('collectScopedGraphRows(');
    expect(bridgeSource).toContain('graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;');
    expect(bridgeSource).toContain('graph_scope.exact_graph = graph_key;');
    expect(bridgeSource).toContain('backend.applyMutation(');
    expect(bridgeSource).not.toContain('rewriteGraphManagementToDeleteWhere(');
  });

  it('executes bounded CREATE GRAPH as a native no-op graph-management path', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridgeSource).toContain('parseSimpleCreateGraphUpdate(');
    expect(bridgeSource).toContain('executeSimpleGraphCreateUpdate(');
    expect(bridgeSource).toContain('SPARQL Graph Create');
    expect(bridgeSource).toContain('{"inserted":0,"deleted":0}');
  });

  it('executes bounded ADD/COPY/MOVE GRAPH through a physical graph-copy path', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridgeSource).toContain('parseSimpleAddCopyMoveGraphUpdate(');
    expect(bridgeSource).toContain('executeSimpleGraphCopyUpdate(');
    expect(bridgeSource).toContain('source_graph_iri');
    expect(bridgeSource).toContain('target_graph_iri');
    expect(bridgeSource).toContain('buildGraphDeleteMutations(');
    expect(bridgeSource).toContain('buildGraphInsertMutations(');
    expect(bridgeSource).toContain('collectScopedGraphRows(');
    expect(bridgeSource).toContain('graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;');
    expect(bridgeSource).toContain('graph_scope.exact_graph = graph_key;');
    expect(bridgeSource).toContain('backend.applyMutation(');
  });

  it('wraps SPARQL Update sequences in physical backend transactions when available', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridgeSource).toContain('backend_.beginTransaction(request.snapshot)');
    expect(bridgeSource).toContain('backend_.commitTransaction()');
    expect(bridgeSource).toContain('backend_.rollbackTransaction()');
    expect(bridgeSource).toMatch(/transaction\.beginTransaction\(request, error_storage\)[\s\S]*for \(ParsedQuery& parsed_update : parsed_updates\)/);
    expect(bridgeSource).toMatch(/if \(!transaction\.commit\(error_storage\)\)/);
  });

  it('prepares SPARQL Update sequences with staged backend mutations and rollback only', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );
    const preparedStart = bridgeSource.indexOf(
      'xpod_rdf_status executePreparedBridgeUpdate(',
    );
    const bridgeUpdateStart = bridgeSource.indexOf(
      'xpod_rdf_status executeBridgeUpdate(',
      preparedStart,
    );

    expect(preparedStart).toBeGreaterThanOrEqual(0);
    expect(bridgeUpdateStart).toBeGreaterThan(preparedStart);
    const preparedSource = bridgeSource.slice(preparedStart, bridgeUpdateStart);
    expect(preparedSource).toContain('/*require_transaction=*/true');
    expect(preparedSource).toContain('backend.applyMutation(');
    expect(preparedSource).toContain('refreshPlannerContextAfterMutation(');
    expect(preparedSource).toContain('collectPreparedNetDelta(');
    expect(preparedSource).toContain('rememberPreparedInitialState(');
    expect(preparedSource.indexOf('rememberPreparedInitialState(')).toBeLessThan(
      preparedSource.indexOf('backend.applyMutation('),
    );
    expect(preparedSource).not.toContain('final_request');
    expect(preparedSource).toContain('transaction.rollback(error_storage)');
    expect(preparedSource).not.toContain('transaction.commit(error_storage)');
    expect(bridgeSource).toContain(
      'prepared update requires backend transactions',
    );
    expect(bridgeSource).toContain('lookupPreparedQuad(');
    expect(bridgeSource).toContain('backend.countScan(scan, count)');
    expect(bridgeSource).toContain(
      'candidate.last_mutation->mutation.kind == XPOD_RDF_MUTATION_INSERT',
    );
    expect(bridgeSource).toContain('PreparedNetMutation');
    expect(bridgeSource).toContain('executePreparedSimpleLoadUpdate(');
    expect(bridgeSource).toContain('prepared LOAD requires a request-provided document');
    expect(preparedSource.indexOf('parseSimpleLoadUpdate(update, load_update)')).toBeLessThan(
      preparedSource.indexOf('isUnsupportedPreparedUpdateLifecycle(update)'),
    );
  });

  it('computes prepared net delta from pre-apply initial state and post-apply final state', () => {
    expect(preparedNetDeltaHarness(
      [],
      [
        { kind: 'insert', quad: 'urn:q' },
        { kind: 'delete', quad: 'urn:q' },
      ],
    )).toEqual([]);
    expect(preparedNetDeltaHarness(
      [],
      [
        { kind: 'delete', quad: 'urn:q' },
        { kind: 'insert', quad: 'urn:q' },
      ],
    )).toEqual([{ kind: 'insert', quad: 'urn:q' }]);
    expect(preparedNetDeltaHarness(
      ['urn:q'],
      [{ kind: 'insert', quad: 'urn:q' }],
    )).toEqual([]);
    expect(preparedNetDeltaHarness(
      [],
      [{ kind: 'delete', quad: 'urn:q' }],
    )).toEqual([]);
    expect(preparedNetDeltaHarness(
      ['urn:q'],
      [
        { kind: 'delete', quad: 'urn:q' },
        { kind: 'insert', quad: 'urn:q' },
      ],
    )).toEqual([]);
    expect(preparedNetDeltaHarness(
      ['urn:q'],
      [
        { kind: 'insert', quad: 'urn:q' },
        { kind: 'delete', quad: 'urn:q' },
      ],
    )).toEqual([{ kind: 'delete', quad: 'urn:q' }]);
  });

  it('escapes arbitrary JSON control characters in native result writers', () => {
    const bridgeSource = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );
    const executorSourceText = readFileSync(executorSource, 'utf8');

    for (const source of [bridgeSource, executorSourceText]) {
      expect(source).toContain("if (static_cast<unsigned char>(c) < 0x20)");
      expect(source).toContain('writeJsonControlEscape');
      expect(source).toContain('"\\\\u00"');
    }
  });

  it('loads a physical backend from a native provider library', async () => {
    expect(existsSync(executorSource)).toBe(true);

    const cxx = requireCompiler('c++');
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-provider-'));
    try {
      const providerSource = path.join(root, 'provider.cpp');
      const providerLibrary = path.join(root, process.platform === 'darwin' ? 'libprovider.dylib' : 'libprovider.so');
      const smoke = path.join(root, 'adapter_provider_smoke.cpp');
      const binary = path.join(root, 'adapter_provider_smoke');
      await writeFile(providerSource, `
#include "xpod_rdf_physical_backend.h"

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_vector_search(
    void*,
    const xpod_rdf_vector_search_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void*,
    const xpod_rdf_vector_search_request*,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  xpod_rdf_candidate row = {};
  row.has_resource_term = 1;
  row.resource_term = 99;
  row.score = 0.88;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 5;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status resolve_term(
    void*,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_term) {
  if (key != 99) return XPOD_RDF_STATUS_NOT_FOUND;
  out_term->kind = XPOD_RDF_TERM_IRI;
  out_term->value = {"urn:dynamic", 11};
  return XPOD_RDF_STATUS_OK;
}

extern "C" xpod_rdf_status xpod_qlever_backend_provider_create(
    const xpod_rdf_bytes*,
    xpod_rdf_backend_v1** out_backend) {
  if (out_backend == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  auto* backend = new xpod_rdf_backend_v1{};
  backend->abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend->struct_size = sizeof(xpod_rdf_backend_v1);
  backend->get_capabilities = get_capabilities;
  backend->estimate_vector_search = estimate_vector_search;
  backend->vector_search = vector_search;
  backend->resolve_term = resolve_term;
  *out_backend = backend;
  return XPOD_RDF_STATUS_OK;
}

extern "C" void xpod_qlever_backend_provider_destroy(xpod_rdf_backend_v1* backend) {
  delete backend;
}
`, 'utf8');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

int main() {
  xpod_qlever_backend_provider_config provider = {};
  const char path[] = ${JSON.stringify(providerLibrary)};
  provider.library_path = {path, sizeof(path) - 1};

  xpod_qlever_adapter_config config = {};
  config.backend_provider = &provider;
  config.enable_runtime_profile = 1;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  double values[2] = {0.4, 0.6};
  xpod_qlever_vector_query vector_query = {};
  vector_query.vector = values;
  vector_query.dimensions = 2;
  vector_query.provider = {"xpod", 4};
  vector_query.model = {"embed-provider", 14};
  vector_query.model_version = {"2026-08-12", 10};
  vector_query.input_kind = {"entity-card", 11};
  vector_query.projection_policy_version = {"policy-v1", 9};
  vector_query.metric = XPOD_RDF_VECTOR_COSINE;
  vector_query.limit = 2;
  vector_query.resource_variable = {"entity", 6};

  xpod_qlever_query_request request = {};
  request.vector_query = &vector_query;

  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view body(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK || result.status != XPOD_RDF_STATUS_OK) return 2;
  if (body.find("urn:dynamic") == std::string_view::npos) return 3;

  xpod_qlever_adapter_release_result(adapter, &result);
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fPIC',
        process.platform === 'darwin' ? '-dynamiclib' : '-shared',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        providerSource,
        '-o',
        providerLibrary,
      ], { stdio: 'pipe' });
      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        facadeSource,
        executorSource,
        smoke,
        ...(process.platform === 'linux' ? ['-ldl'] : []),
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeCheckTimeoutMs);

  it('executes the Xpod vector query binding through the C ABI facade', async () => {
    expect(existsSync(executorSource)).toBe(true);

    const cxx = requireCompiler('c++');
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-vector-query-'));
    try {
      const smoke = path.join(root, 'adapter_vector_query_smoke.cpp');
      const binary = path.join(root, 'adapter_vector_query_smoke');
      await writeFile(smoke, `
#include <cstring>
#include <string_view>
#include "xpod_qlever_adapter.h"

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string_view(actual.data, actual.size) == expected;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_vector_search(
    void*,
    const xpod_rdf_vector_search_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request->dimensions != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->vector[0] != 0.25 || request->vector[1] != 0.75) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->provider, "xpod")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->model, "embed-v1")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->model_version, "2026-08-12")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->input_kind, "entity-card")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->projection_policy_version, "policy-v1")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->metric != XPOD_RDF_VECTOR_COSINE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->limit != 4) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.has_resource_term = 1;
  row.resource_term = 42;
  row.score = 0.99;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 3;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status resolve_term(
    void*,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_term) {
  if (key != 42) return XPOD_RDF_STATUS_NOT_FOUND;
  out_term->kind = XPOD_RDF_TERM_IRI;
  out_term->value = {"urn:entity", 10};
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.get_capabilities = get_capabilities;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  backend.resolve_term = resolve_term;

  xpod_qlever_adapter_config config = {};
  config.backend = &backend;
  config.enable_runtime_profile = 1;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  double values[2] = {0.25, 0.75};
  xpod_qlever_vector_query vector_query = {};
  vector_query.vector = values;
  vector_query.dimensions = 2;
  vector_query.provider = {"xpod", 4};
  vector_query.model = {"embed-v1", 8};
  vector_query.model_version = {"2026-08-12", 10};
  vector_query.input_kind = {"entity-card", 11};
  vector_query.projection_policy_version = {"policy-v1", 9};
  vector_query.metric = XPOD_RDF_VECTOR_COSINE;
  vector_query.limit = 4;
  vector_query.resource_variable = {"entity", 6};

  xpod_qlever_query_request request = {};
  request.vector_query = &vector_query;

  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view body(result.result_json.data, result.result_json.size);
  std::string_view media(result.result_media_type.data, result.result_media_type.size);
  if (status != XPOD_RDF_STATUS_OK || result.status != XPOD_RDF_STATUS_OK) return 2;
  if (media != "application/sparql-results+json") return 3;
  if (body.find("\\\"entity\\\"") == std::string_view::npos) return 4;
  if (body.find("urn:entity") == std::string_view::npos) return 5;

  xpod_qlever_adapter_release_result(adapter, &result);
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        facadeSource,
        executorSource,
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delegates C ABI query execution to an internal executor seam', async () => {
    expect(existsSync(executorHeader)).toBe(true);
    expect(existsSync(executorSource)).toBe(true);
    expect(readFileSync(facadeSource, 'utf8')).toContain('XpodQleverExecutor');

    const cxx = requireCompiler('c++');
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-executor-'));
    try {
      const smoke = path.join(root, 'adapter_query_smoke.cpp');
      const binary = path.join(root, 'adapter_query_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;

  xpod_qlever_adapter_config config = {};
  config.backend = &backend;
  config.memory_limit_bytes = 0;
  config.enable_runtime_profile = 1;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  xpod_qlever_query_result result = {};
  xpod_rdf_bytes query = {"SELECT * WHERE { ?s ?p ?o }", 27};
  xpod_rdf_status status = xpod_qlever_adapter_query(adapter, query, &result);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (result.status != XPOD_RDF_STATUS_UNSUPPORTED) return 3;
  if (error.find("stub QLever executor") == std::string_view::npos) return 4;

  xpod_qlever_adapter_release_result(adapter, &result);
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        facadeSource,
        executorSource,
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
