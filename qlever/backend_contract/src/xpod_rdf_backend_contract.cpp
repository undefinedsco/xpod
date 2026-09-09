#include "xpod_rdf_physical_backend.h"

#include <dlfcn.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

using Create = xpod_rdf_status (*)(const xpod_rdf_bytes*, xpod_rdf_backend_v1**);
using Destroy = void (*)(xpod_rdf_backend_v1*);

struct CallbackEvidence {
  uint64_t calls = 0;
  uint64_t successes = 0;
};

std::map<std::string, CallbackEvidence> coverage;

void record(const std::string& name, xpod_rdf_status status) {
  auto& evidence = coverage[name];
  ++evidence.calls;
  if (status == XPOD_RDF_STATUS_OK) ++evidence.successes;
}

void recordExpected(
    const std::string& name,
    xpod_rdf_status status,
    xpod_rdf_status expected) {
  auto& evidence = coverage[name];
  ++evidence.calls;
  if (status == expected) ++evidence.successes;
}

xpod_rdf_bytes bytes(const std::string& value) {
  return {value.data(), value.size()};
}

xpod_rdf_term iri(const std::string& value) {
  return {XPOD_RDF_TERM_IRI, bytes(value), {}, {}};
}

xpod_rdf_term literal(const std::string& value) {
  return {XPOD_RDF_TERM_LITERAL, bytes(value), {}, {}};
}

xpod_rdf_quad quad(
    const std::string& subject,
    const std::string& predicate,
    const std::string& object,
    const std::string& graph) {
  return {iri(subject), iri(predicate), literal(object), iri(graph), 1};
}

const char* statusName(xpod_rdf_status status) {
  switch (status) {
    case XPOD_RDF_STATUS_OK: return "ok";
    case XPOD_RDF_STATUS_NOT_FOUND: return "not_found";
    case XPOD_RDF_STATUS_UNSUPPORTED: return "unsupported";
    case XPOD_RDF_STATUS_CANCELLED: return "cancelled";
    case XPOD_RDF_STATUS_PERMISSION_DENIED: return "permission_denied";
    case XPOD_RDF_STATUS_STALE_STATS: return "stale_stats";
    case XPOD_RDF_STATUS_DONE: return "done";
    case XPOD_RDF_STATUS_BACKEND_ERROR: return "backend_error";
  }
  return "unknown";
}

std::string copyBytes(xpod_rdf_bytes value) {
  return value.data == nullptr ? std::string() : std::string(value.data, value.size);
}

struct Rows {
  std::vector<xpod_rdf_quad_key> rows;
};

xpod_rdf_status collectRows(void* opaque, const xpod_rdf_quad_batch* batch) {
  if (opaque == nullptr || batch == nullptr ||
      (batch->row_count != 0 && batch->rows == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto& rows = static_cast<Rows*>(opaque)->rows;
  rows.insert(rows.end(), batch->rows, batch->rows + batch->row_count);
  return XPOD_RDF_STATUS_OK;
}

struct TupleEvidence { uint64_t rows = 0; };
struct RangeEvidence { uint64_t ranges = 0; };

xpod_rdf_status collectTuples(void* opaque, const xpod_rdf_term_tuple_batch* batch) {
  if (opaque == nullptr || batch == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static_cast<TupleEvidence*>(opaque)->rows += batch->row_count;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status collectRanges(void* opaque, const xpod_rdf_term_range_batch* batch) {
  if (opaque == nullptr || batch == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  static_cast<RangeEvidence*>(opaque)->ranges += batch->range_count;
  return XPOD_RDF_STATUS_OK;
}

uint8_t cancellationFlag(void* opaque) {
  return *static_cast<bool*>(opaque) ? 1 : 0;
}

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "contract failure: " << message << '\n';
  std::exit(2);
}

void requireStatus(
    const char* callback,
    xpod_rdf_status actual,
    xpod_rdf_status expected = XPOD_RDF_STATUS_OK) {
  const std::string name(callback);
  record(name.substr(0, name.find(' ')), actual);
  if (actual != expected) {
    fail(std::string(callback) + " returned " + statusName(actual) +
         ", expected " + statusName(expected));
  }
}

void requireCallback(const char* name, const void* callback) {
  if (callback == nullptr) {
    fail(std::string("missing required callback ") + name);
  }
}

uint64_t fnv1a(const std::vector<xpod_rdf_quad_key>& input) {
  auto rows = input;
  std::sort(rows.begin(), rows.end(), [](const auto& left, const auto& right) {
    if (left.subject != right.subject) return left.subject < right.subject;
    if (left.predicate != right.predicate) return left.predicate < right.predicate;
    if (left.object != right.object) return left.object < right.object;
    return left.graph < right.graph;
  });
  uint64_t hash = UINT64_C(14695981039346656037);
  for (const auto& row : rows) {
    for (uint64_t value : {row.subject, row.predicate, row.object, row.graph}) {
      for (unsigned shift = 0; shift != 64; shift += 8) {
        hash ^= (value >> shift) & UINT64_C(0xff);
        hash *= UINT64_C(1099511628211);
      }
    }
  }
  return hash;
}

std::string hex(uint64_t value) {
  std::ostringstream out;
  out << std::hex << std::setfill('0') << std::setw(16) << value;
  return out.str();
}

xpod_rdf_scan_request baseScan() {
  xpod_rdf_scan_request request = {};
  request.permutation = XPOD_RDF_PERM_SPOG;
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  request.batch_size = 1;
  request.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
      XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;
  return request;
}

xpod_rdf_mutation_result mutate(
    xpod_rdf_backend_v1* backend,
    xpod_rdf_mutation_kind kind,
    const xpod_rdf_quad& value) {
  xpod_rdf_quad_mutation mutation = {kind, value};
  xpod_rdf_mutation_request request = {};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  request.mutations = &mutation;
  request.mutation_count = 1;
  xpod_rdf_mutation_result result = {};
  requireStatus(
      "apply_mutation",
      backend->apply_mutation(backend->backend_user_data, &request, &result));
  return result;
}

std::string currentVersion(xpod_rdf_backend_v1* backend) {
  xpod_rdf_mutation_request request = {};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  xpod_rdf_mutation_result result = {};
  requireStatus(
      "apply_mutation",
      backend->apply_mutation(backend->backend_user_data, &request, &result));
  return copyBytes(result.facts_version);
}

xpod_rdf_backend_v1* openBackend(Create create, const std::string& configJson) {
  const xpod_rdf_bytes config = bytes(configJson);
  xpod_rdf_backend_v1* backend = nullptr;
  requireStatus("provider_create", create(&config, &backend));
  if (backend == nullptr ||
      backend->abi_version != XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION ||
      backend->struct_size < sizeof(xpod_rdf_backend_v1)) {
    fail("provider returned incompatible ABI");
  }
  return backend;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 4) {
    std::cerr << "usage: contract-runner PROVIDER CONFIG_JSON BACKEND_LABEL\n";
    return 64;
  }
  void* library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (library == nullptr) fail(dlerror());
  auto create = reinterpret_cast<Create>(
      dlsym(library, "xpod_qlever_backend_provider_create"));
  auto destroy = reinterpret_cast<Destroy>(
      dlsym(library, "xpod_qlever_backend_provider_destroy"));
  if (create == nullptr || destroy == nullptr) fail("provider entry points missing");

  const std::string configJson = argv[2];
  xpod_rdf_backend_v1* backend = openBackend(create, configJson);

#define REQUIRE_CALLBACK(name) requireCallback(#name, reinterpret_cast<const void*>(backend->name))
  REQUIRE_CALLBACK(get_capabilities);
  REQUIRE_CALLBACK(lookup_term);
  REQUIRE_CALLBACK(resolve_term);
  REQUIRE_CALLBACK(lookup_terms);
  REQUIRE_CALLBACK(resolve_terms);
  REQUIRE_CALLBACK(encode_qlever_id);
  REQUIRE_CALLBACK(decode_qlever_id);
  REQUIRE_CALLBACK(compare_qlever_ids);
  REQUIRE_CALLBACK(scan_permutation);
  REQUIRE_CALLBACK(open_scan_cursor);
  REQUIRE_CALLBACK(next_scan_cursor);
  REQUIRE_CALLBACK(close_scan_cursor);
  REQUIRE_CALLBACK(count_scan);
  REQUIRE_CALLBACK(distinct_scan);
  REQUIRE_CALLBACK(estimate_scan);
  REQUIRE_CALLBACK(estimate_join_fanout);
  REQUIRE_CALLBACK(estimate_distinct);
  REQUIRE_CALLBACK(resolve_source_scope);
  REQUIRE_CALLBACK(estimate_source_scope);
  REQUIRE_CALLBACK(estimate_access_scope);
  REQUIRE_CALLBACK(apply_mutation);
  REQUIRE_CALLBACK(begin_transaction);
  REQUIRE_CALLBACK(commit_transaction);
  REQUIRE_CALLBACK(rollback_transaction);
#undef REQUIRE_CALLBACK

  xpod_rdf_backend_capabilities capabilities = {};
  requireStatus(
      "get_capabilities",
      backend->get_capabilities(
          backend->backend_user_data, &capabilities));
  const uint32_t requiredFeatures =
      XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_MUTATION |
      XPOD_RDF_BACKEND_FEATURE_TRANSACTIONS;
  const uint32_t requiredPermutations =
      XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_SOPG |
      XPOD_RDF_PERM_CAP_PSOG | XPOD_RDF_PERM_CAP_POSG |
      XPOD_RDF_PERM_CAP_OSPG | XPOD_RDF_PERM_CAP_OPSG |
      XPOD_RDF_PERM_CAP_GSPO | XPOD_RDF_PERM_CAP_GPOS;
  if ((capabilities.features & requiredFeatures) != requiredFeatures ||
      (capabilities.supported_permutations & requiredPermutations) !=
          requiredPermutations) {
    fail("backend capabilities omit required atomic features");
  }

  const xpod_rdf_quad first =
      quad("urn:xpod:s1", "urn:xpod:p", "one", "urn:xpod:g1");
  const xpod_rdf_quad second =
      quad("urn:xpod:s2", "urn:xpod:p", "two", "urn:xpod:g2");
  const xpod_rdf_quad batchMate =
      quad("urn:xpod:s4", "urn:xpod:p", "four", "urn:xpod:g1");
  const xpod_rdf_quad rolledBack =
      quad("urn:xpod:s3", "urn:xpod:p", "three", "urn:xpod:g1");
  mutate(backend, XPOD_RDF_MUTATION_INSERT, first);
  const auto initial = mutate(backend, XPOD_RDF_MUTATION_INSERT, batchMate);
  const std::string before = copyBytes(initial.facts_version);
  destroy(backend);
  backend = openBackend(create, configJson);

  xpod_rdf_term lookupTerms[4] = {
      iri("urn:xpod:s1"), iri("urn:xpod:p"), literal("one"), iri("urn:xpod:g1")};
  xpod_rdf_term_key keys[4] = {};
  xpod_rdf_status statuses[4] = {};
  requireStatus(
      "lookup_terms",
      backend->lookup_terms(
          backend->backend_user_data, lookupTerms, 4, nullptr, keys, statuses));
  for (const auto status : statuses) {
    if (status != XPOD_RDF_STATUS_OK) fail("lookup_terms item failed");
  }
  xpod_rdf_term resolved[4] = {};
  requireStatus(
      "resolve_terms",
      backend->resolve_terms(
          backend->backend_user_data, keys, 4, nullptr, resolved, statuses));
  for (const auto status : statuses) {
    if (status != XPOD_RDF_STATUS_OK) fail("resolve_terms item failed");
  }
  xpod_rdf_term_key single = 0;
  requireStatus(
      "lookup_term",
      backend->lookup_term(
          backend->backend_user_data, &lookupTerms[0], nullptr, &single));
  xpod_rdf_term singleResolved = {};
  requireStatus(
      "resolve_term",
      backend->resolve_term(
          backend->backend_user_data, single, nullptr, &singleResolved));

  uint64_t firstQleverId = 0;
  uint64_t secondQleverId = 0;
  requireStatus(
      "encode_qlever_id",
      backend->encode_qlever_id(
          backend->backend_user_data, keys[0], &firstQleverId));
  requireStatus(
      "encode_qlever_id",
      backend->encode_qlever_id(
          backend->backend_user_data, keys[1], &secondQleverId));
  xpod_rdf_term_key decoded = 0;
  requireStatus(
      "decode_qlever_id",
      backend->decode_qlever_id(
          backend->backend_user_data, firstQleverId, &decoded));
  if (decoded != keys[0]) fail("QLever id round-trip changed the term key");
  int32_t forwardCompare = 0;
  int32_t reverseCompare = 0;
  requireStatus(
      "compare_qlever_ids",
      backend->compare_qlever_ids(
          backend->backend_user_data, firstQleverId, secondQleverId,
          &forwardCompare));
  requireStatus(
      "compare_qlever_ids",
      backend->compare_qlever_ids(
          backend->backend_user_data, secondQleverId, firstQleverId,
          &reverseCompare));
  if (forwardCompare == 0 || reverseCompare == 0 ||
      (forwardCompare < 0) == (reverseCompare < 0)) {
    fail("QLever id comparison is not antisymmetric");
  }

  if (backend->prefix_range != nullptr) {
    xpod_rdf_prefix_range_request prefix = {};
    const std::string prefixText = "urn:xpod:";
    prefix.prefix = bytes(prefixText);
    RangeEvidence rangeEvidence;
    requireStatus(
        "prefix_range",
        backend->prefix_range(
            backend->backend_user_data, &prefix, collectRanges, &rangeEvidence));
    if (rangeEvidence.ranges == 0) fail("prefix_range returned no ranges");
  }

  auto all = baseScan();
  Rows rows;
  requireStatus(
      "scan_permutation",
      backend->scan_permutation(
          backend->backend_user_data, &all, collectRows, &rows));
  if (rows.rows.size() != 2) fail("scan_permutation fixture row count mismatch");
  xpod_rdf_count_result count = {};
  requireStatus(
      "count_scan",
      backend->count_scan(backend->backend_user_data, &all, &count));
  if (count.count != rows.rows.size()) fail("scan/count mismatch");
  const uint64_t canonicalDigest = fnv1a(rows.rows);
  for (int permutation = XPOD_RDF_PERM_SPOG;
       permutation <= XPOD_RDF_PERM_GPOS; ++permutation) {
    auto request = all;
    request.permutation = static_cast<xpod_rdf_permutation>(permutation);
    Rows permutationRows;
    requireStatus(
        "scan_permutation",
        backend->scan_permutation(
            backend->backend_user_data, &request, collectRows, &permutationRows));
    if (permutationRows.rows.size() != count.count ||
        fnv1a(permutationRows.rows) != canonicalDigest) {
      fail("permutation scan digest mismatch");
    }
  }
  xpod_rdf_distinct_request distinct = {};
  distinct.scan = all;
  distinct.distinct_slots = XPOD_RDF_SLOT_SUBJECT;
  TupleEvidence tupleEvidence;
  requireStatus(
      "distinct_scan",
      backend->distinct_scan(
          backend->backend_user_data, &distinct, collectTuples, &tupleEvidence));
  if (tupleEvidence.rows != 2) fail("distinct_scan content mismatch");
  xpod_rdf_estimate estimate = {};
  requireStatus(
      "estimate_scan",
      backend->estimate_scan(backend->backend_user_data, &all, &estimate));
  requireStatus(
      "estimate_distinct",
      backend->estimate_distinct(
          backend->backend_user_data, &distinct, &estimate));
  xpod_rdf_quad_pattern joinPatterns[2] = {};
  joinPatterns[0].has_predicate = 1;
  joinPatterns[0].predicate = keys[1];
  joinPatterns[1].has_predicate = 1;
  joinPatterns[1].predicate = keys[1];
  xpod_rdf_join_fanout_request joinRequest = {};
  joinRequest.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  joinRequest.patterns = joinPatterns;
  joinRequest.pattern_count = 2;
  joinRequest.bound_slots = XPOD_RDF_SLOT_SUBJECT;
  requireStatus(
      "estimate_join_fanout",
      backend->estimate_join_fanout(
          backend->backend_user_data, &joinRequest, &estimate));
  xpod_rdf_scan_cursor* cursor = nullptr;
  requireStatus(
      "open_scan_cursor",
      backend->open_scan_cursor(backend->backend_user_data, &all, &cursor));
  Rows cursorRows;
  size_t cursorBatches = 0;
  while (true) {
    xpod_rdf_quad_batch cursorBatch = {};
    xpod_rdf_status cursorStatus = backend->next_scan_cursor(
        backend->backend_user_data, cursor, &cursorBatch);
    record("next_scan_cursor", cursorStatus);
    if (cursorStatus == XPOD_RDF_STATUS_DONE) break;
    if (cursorStatus != XPOD_RDF_STATUS_OK) {
      fail(std::string("next_scan_cursor returned ") + statusName(cursorStatus));
    }
    ++cursorBatches;
    cursorRows.rows.insert(
        cursorRows.rows.end(), cursorBatch.rows,
        cursorBatch.rows + cursorBatch.row_count);
  }
  if (cursorBatches < 2 || fnv1a(cursorRows.rows) != canonicalDigest) {
    fail("cursor did not reproduce full multi-batch scan");
  }
  backend->close_scan_cursor(backend->backend_user_data, cursor);
  record("close_scan_cursor", XPOD_RDF_STATUS_OK);
  backend->close_scan_cursor(backend->backend_user_data, nullptr);
  record("close_scan_cursor", XPOD_RDF_STATUS_OK);

  bool cancelled = false;
  xpod_rdf_cancellation cancellation = {&cancelled, cancellationFlag};
  auto cancellableScan = all;
  cancellableScan.cancellation = &cancellation;
  xpod_rdf_scan_cursor* cancelledCursor = nullptr;
  requireStatus(
      "open_scan_cursor",
      backend->open_scan_cursor(
          backend->backend_user_data, &cancellableScan, &cancelledCursor));
  cancelled = true;
  xpod_rdf_quad_batch cancelledBatch = {};
  const xpod_rdf_status cancelledStatus = backend->next_scan_cursor(
      backend->backend_user_data, cancelledCursor, &cancelledBatch);
  recordExpected(
      "next_scan_cursor", cancelledStatus, XPOD_RDF_STATUS_CANCELLED);
  if (cancelledStatus != XPOD_RDF_STATUS_CANCELLED) {
    fail("cursor ignored cancellation between batches");
  }
  backend->close_scan_cursor(
      backend->backend_user_data, cancelledCursor);
  record("close_scan_cursor", XPOD_RDF_STATUS_OK);

  auto graphExact = baseScan();
  graphExact.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  graphExact.graph_scope.exact_graph = keys[3];
  xpod_rdf_count_result graphExactCount = {};
  requireStatus(
      "count_scan graph exact",
      backend->count_scan(
          backend->backend_user_data, &graphExact, &graphExactCount));
  requireStatus(
      "estimate_scan",
      backend->estimate_scan(
          backend->backend_user_data, &graphExact, &estimate));
  if (estimate.rows != graphExactCount.count) {
    fail("graph-scoped estimate/count mismatch");
  }
  graphExact.graph_scope.exact_graph = keys[0];
  xpod_rdf_count_result graphOtherCount = {};
  requireStatus(
      "count_scan graph other",
      backend->count_scan(
          backend->backend_user_data, &graphExact, &graphOtherCount));

  const std::string missingSource = "urn:xpod:missing-source";
  xpod_rdf_source_scope sourceScope = {};
  sourceScope.source_uri = bytes(missingSource);
  xpod_rdf_resolved_source_scope resolvedSource = {};
  const xpod_rdf_status sourceStatus = backend->resolve_source_scope(
      backend->backend_user_data, &sourceScope, nullptr, &resolvedSource);
  record("resolve_source_scope", sourceStatus);
  if (sourceStatus != XPOD_RDF_STATUS_OK ||
      resolvedSource.source_nodes_size != 0) {
    fail(std::string("resolve_source_scope returned ") + statusName(sourceStatus));
  }
  const xpod_rdf_status sourceEstimateStatus = backend->estimate_source_scope(
      backend->backend_user_data, &sourceScope, nullptr, &estimate);
  if (sourceEstimateStatus != XPOD_RDF_STATUS_NOT_FOUND &&
      sourceEstimateStatus != XPOD_RDF_STATUS_OK) {
    fail(std::string("estimate_source_scope returned ") +
         statusName(sourceEstimateStatus));
  }
  if (sourceEstimateStatus == XPOD_RDF_STATUS_OK && estimate.rows != 0) {
    fail("missing source estimate was not fail-closed");
  }
  record("estimate_source_scope", sourceEstimateStatus);

  auto sourceFiltered = all;
  sourceFiltered.source_scope = sourceScope;
  Rows sourceRows;
  requireStatus(
      "scan_permutation",
      backend->scan_permutation(
          backend->backend_user_data, &sourceFiltered, collectRows, &sourceRows));
  xpod_rdf_count_result sourceCount = {};
  requireStatus(
      "count_scan",
      backend->count_scan(
          backend->backend_user_data, &sourceFiltered, &sourceCount));
  if (!sourceRows.rows.empty() || sourceCount.count != 0) {
    fail("missing source scope leaked rows");
  }

  const std::string missingPrincipal = "urn:xpod:missing-principal";
  const xpod_rdf_bytes principal = bytes(missingPrincipal);
  xpod_rdf_access_scope resolvedAccess = {};
  xpod_rdf_status accessStatus = XPOD_RDF_STATUS_UNSUPPORTED;
  const std::string seedPrincipal = "urn:xpod:contract-seed";
  const xpod_rdf_bytes seedPrincipalBytes = bytes(seedPrincipal);
  xpod_rdf_access_scope seededAccess = {};
  xpod_rdf_status seededAccessStatus = XPOD_RDF_STATUS_UNSUPPORTED;
  const std::string mixedPrincipal = "urn:xpod:contract-mixed";
  const xpod_rdf_bytes mixedPrincipalBytes = bytes(mixedPrincipal);
  xpod_rdf_access_scope mixedAccess = {};
  xpod_rdf_status mixedAccessStatus = XPOD_RDF_STATUS_UNSUPPORTED;
  const std::string broadDenyPrincipal = "urn:xpod:contract-broad-deny";
  const xpod_rdf_bytes broadDenyPrincipalBytes = bytes(broadDenyPrincipal);
  xpod_rdf_access_scope broadDenyAccess = {};
  xpod_rdf_status broadDenyStatus = XPOD_RDF_STATUS_UNSUPPORTED;
  if (backend->resolve_access_scope != nullptr) {
    accessStatus = backend->resolve_access_scope(
        backend->backend_user_data,
        &principal,
        XPOD_RDF_ACCESS_READ,
        nullptr,
        &resolvedAccess);
    recordExpected(
        "resolve_access_scope", accessStatus,
        XPOD_RDF_STATUS_PERMISSION_DENIED);
    if (accessStatus != XPOD_RDF_STATUS_PERMISSION_DENIED) {
      fail(std::string("resolve_access_scope returned ") +
           statusName(accessStatus));
    }
    seededAccessStatus = backend->resolve_access_scope(
        backend->backend_user_data,
        &seedPrincipalBytes,
        XPOD_RDF_ACCESS_READ,
        nullptr,
        &seededAccess);
    requireStatus("resolve_access_scope", seededAccessStatus);
    if (seededAccess.allowed_graphs_size != 1 ||
        seededAccess.allowed_graphs[0] != 4 ||
        seededAccess.allowed_sources_size != 1 ||
        seededAccess.allowed_sources[0] != 1 ||
        seededAccess.allowed_graph_prefixes_size != 1 ||
        copyBytes(seededAccess.allowed_graph_prefixes[0]) != "urn:xpod:g" ||
        seededAccess.denied_graph_prefixes_size != 1 ||
        copyBytes(seededAccess.denied_graph_prefixes[0]) !=
            "urn:xpod:blocked" ||
        copyBytes(seededAccess.permission_version) != "contract-1") {
      fail("seeded access scope did not round-trip exact/source/prefix rules");
    }
    mixedAccessStatus = backend->resolve_access_scope(
        backend->backend_user_data,
        &mixedPrincipalBytes,
        XPOD_RDF_ACCESS_READ,
        nullptr,
        &mixedAccess);
    recordExpected(
        "resolve_access_scope", mixedAccessStatus,
        XPOD_RDF_STATUS_UNSUPPORTED);
    if (mixedAccessStatus != XPOD_RDF_STATUS_UNSUPPORTED) {
      fail("mixed permission versions did not fail closed");
    }
    broadDenyStatus = backend->resolve_access_scope(
        backend->backend_user_data,
        &broadDenyPrincipalBytes,
        XPOD_RDF_ACCESS_READ,
        nullptr,
        &broadDenyAccess);
    recordExpected(
        "resolve_access_scope", broadDenyStatus,
        XPOD_RDF_STATUS_PERMISSION_DENIED);
    if (broadDenyStatus != XPOD_RDF_STATUS_PERMISSION_DENIED) {
      fail("broad deny did not fail closed");
    }
  }
  xpod_rdf_access_scope allowedAccess = {};
  allowedAccess.mode = XPOD_RDF_ACCESS_READ;
  allowedAccess.authorization_model = XPOD_RDF_AUTH_WAC;
  allowedAccess.principal = bytes(seedPrincipal);
  const std::string contractPermissionVersion = "contract-1";
  allowedAccess.permission_version = bytes(contractPermissionVersion);
  allowedAccess.allowed_graphs = &keys[3];
  allowedAccess.allowed_graphs_size = 1;
  auto allowedScan = all;
  allowedScan.access_scope = &allowedAccess;
  Rows allowedRows;
  requireStatus(
      "scan_permutation",
      backend->scan_permutation(
          backend->backend_user_data, &allowedScan, collectRows, &allowedRows));
  if (allowedRows.rows.size() != 2) fail("allowed access scope lost rows");

  xpod_rdf_access_scope deniedAccess = {};
  deniedAccess.mode = XPOD_RDF_ACCESS_READ;
  deniedAccess.authorization_model = XPOD_RDF_AUTH_WAC;
  deniedAccess.denied_graphs = &keys[3];
  deniedAccess.denied_graphs_size = 1;
  auto deniedScan = all;
  deniedScan.access_scope = &deniedAccess;
  Rows deniedRows;
  requireStatus(
      "scan_permutation",
      backend->scan_permutation(
          backend->backend_user_data, &deniedScan, collectRows, &deniedRows));
  xpod_rdf_count_result deniedCount = {};
  requireStatus(
      "count_scan",
      backend->count_scan(
          backend->backend_user_data, &deniedScan, &deniedCount));
  if (!deniedRows.rows.empty() || deniedCount.count != 0) {
    fail("denied access scope leaked rows");
  }
  const xpod_rdf_status accessEstimateStatus = backend->estimate_access_scope(
      backend->backend_user_data, &allowedAccess, nullptr, &estimate);
  requireStatus("estimate_access_scope", accessEstimateStatus);
  if (estimate.rows != allowedRows.rows.size()) {
    fail("allowed access estimate/scan mismatch");
  }
  const std::string accessEstimateReason = copyBytes(estimate.reason);
  requireStatus(
      "estimate_access_scope",
      backend->estimate_access_scope(
          backend->backend_user_data, &deniedAccess, nullptr, &estimate));
  if (estimate.rows != 0) fail("denied access estimate leaked rows");

  requireStatus(
      "begin_transaction",
      backend->begin_transaction(backend->backend_user_data, nullptr));
  mutate(backend, XPOD_RDF_MUTATION_INSERT, second);
  requireStatus(
      "commit_transaction",
      backend->commit_transaction(backend->backend_user_data));
  const std::string afterCommit = currentVersion(backend);

  requireStatus(
      "begin_transaction",
      backend->begin_transaction(backend->backend_user_data, nullptr));
  mutate(backend, XPOD_RDF_MUTATION_INSERT, rolledBack);
  requireStatus(
      "rollback_transaction",
      backend->rollback_transaction(backend->backend_user_data));
  const std::string afterRollback = currentVersion(backend);

  std::vector<std::string> optional;
  if (backend->text_search == nullptr) optional.emplace_back("text_search");
  if (backend->estimate_text_search == nullptr) {
    optional.emplace_back("estimate_text_search");
  }
  if (backend->vector_search == nullptr) optional.emplace_back("vector_search");
  if (backend->estimate_vector_search == nullptr) {
    optional.emplace_back("estimate_vector_search");
  }
  if (backend->prefix_range == nullptr) optional.emplace_back("prefix_range");
  if (backend->resolve_access_scope == nullptr) {
    optional.emplace_back("resolve_access_scope");
  }
  std::sort(optional.begin(), optional.end());

  std::cout << "{\"schemaVersion\":1,\"backend\":\"" << argv[3]
            << "\",\"callbackCoverage\":{";
  const char* callbackNames[] = {
      "apply_mutation", "begin_transaction", "close_scan_cursor", "commit_transaction",
      "compare_qlever_ids", "count_scan", "decode_qlever_id", "distinct_scan",
      "encode_qlever_id", "estimate_access_scope", "estimate_distinct",
      "estimate_join_fanout", "estimate_scan", "estimate_source_scope",
      "get_capabilities", "lookup_term", "lookup_terms", "next_scan_cursor",
      "open_scan_cursor", "resolve_source_scope", "resolve_term", "resolve_terms",
      "rollback_transaction", "scan_permutation"};
  for (size_t index = 0; index < std::size(callbackNames); ++index) {
    const auto evidence = coverage.find(callbackNames[index]);
    if (evidence == coverage.end() || evidence->second.successes == 0) {
      fail(std::string("required callback lacked successful exercise: ") +
           callbackNames[index]);
    }
    if (index != 0) std::cout << ',';
    std::cout << '"' << callbackNames[index]
              << "\":{\"status\":\"exercised\",\"calls\":"
              << evidence->second.calls << ",\"successes\":"
              << evidence->second.successes << '}';
  }
  std::cout << "},\"rowDigest\":\"" << hex(canonicalDigest)
            << "\",\"scopeOutcomes\":{\"accessDenied\":\""
            << statusName(accessStatus) << "\",\"graphExact\":\""
            << graphExactCount.count << "\",\"graphOther\":\""
            << graphOtherCount.count << "\",\"sourceMissing\":\"empty"
            << "\",\"accessSeed\":\"" << statusName(seededAccessStatus)
            << "\",\"accessMixed\":\"" << statusName(mixedAccessStatus)
            << "\",\"accessBroadDeny\":\"" << statusName(broadDenyStatus)
            << "\",\"accessEstimateReason\":\""
            << accessEstimateReason
            << "\"},\"versions\":{\"before\":\""
            << before << "\",\"afterCommit\":\"" << afterCommit
            << "\",\"afterRollback\":\"" << afterRollback
            << "\"},\"unsupportedOptionalLeaves\":[";
  for (size_t index = 0; index < optional.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << '"' << optional[index] << '"';
  }
  std::cout << "]}\n";

  destroy(backend);
  dlclose(library);
  return 0;
}
