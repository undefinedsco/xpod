#include "xpod_rdf_physical_backend.h"

#include <dlfcn.h>

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace {

using Create = xpod_rdf_status (*)(const xpod_rdf_bytes*, xpod_rdf_backend_v1**);
using Destroy = void (*)(xpod_rdf_backend_v1*);

struct CallbackEvidence {
  uint64_t calls = 0;
  uint64_t successes = 0;
  std::string status = "missing";
};

struct CandidateRows {
  std::vector<xpod_rdf_candidate> rows;
  std::vector<xpod_rdf_text_term_key> matched_terms;
  std::vector<uint8_t> has_matched_terms;
};

struct CaseEvidence {
  std::string status = "failed";
  uint64_t rows = 0;
  std::string digest;
};

struct Fixture {
  xpod_rdf_term_key text_exact = 0;
  xpod_rdf_term_key text_prefix = 0;
  xpod_rdf_term_key text_entity = 0;
  xpod_rdf_retrieval_point_key text_exact_retrieval_point = 0;
  xpod_rdf_retrieval_point_key text_prefix_retrieval_point = 0;
  xpod_rdf_retrieval_point_key text_entity_retrieval_point = 0;
  xpod_rdf_term_key text_entity_resource_term = 0;
  xpod_rdf_text_term_key text_prefix_matched_term = 0;
  xpod_rdf_term_key entity = 0;
  xpod_rdf_term_key graph_allow = 0;
  xpod_rdf_term_key graph_deny = 0;
  xpod_rdf_source_node_key source_allow = 0;
  xpod_rdf_source_node_key source_deny = 0;
  xpod_rdf_term_key scope_inside_term = 0;
  xpod_rdf_term_key scope_outside_term = 0;
  std::string model;
  std::string wrong_model;
  std::string text_query;
  std::string prefix_query;
  std::string entity_query;
  std::vector<double> text_scores;
  std::vector<double> prefix_scores;
  std::vector<double> entity_scores;
  std::string stale_snapshot;
  std::vector<xpod_rdf_term_key> cosine_order;
  std::vector<double> cosine_scores;
  std::vector<xpod_rdf_term_key> dot_order;
  std::vector<double> dot_scores;
  std::vector<xpod_rdf_term_key> euclidean_order;
  std::vector<double> euclidean_scores;
  std::vector<xpod_rdf_term_key> tie_order;
  std::vector<double> tie_scores;
  double scope_inside_score = 0.0;
  std::vector<std::string> fixtureExpected_indexes;
  std::string expected_scorer;
  std::string seed_artifact_path;
  std::string seed_bootstrap_consumption_state = "consumed-by-contract-bootstrap";
  std::string seed_provider_consumption_state = "deferred-until-callback-support";
  bool seedArtifactConsumed = false;
};

struct ContractFailure {
  std::string reason;
  int code = 2;
};

struct ProviderHandle {
  void* library = nullptr;
  Destroy destroy = nullptr;
  xpod_rdf_backend_v1* backend = nullptr;

  ~ProviderHandle() {
    if (backend != nullptr && destroy != nullptr) {
      destroy(backend);
    }
    if (library != nullptr) {
      dlclose(library);
    }
  }

  ProviderHandle() = default;
  ProviderHandle(const ProviderHandle&) = delete;
  ProviderHandle& operator=(const ProviderHandle&) = delete;
};

std::map<std::string, CallbackEvidence> coverage;
std::map<std::string, CaseEvidence> cases;
std::set<std::string> provider_scorers;

[[noreturn]] void fail(
    const std::string& backend,
    const std::string& reason,
    int code = 2);
[[noreturn]] void failWithFixture(
    const std::string& backend,
    const Fixture& fixture,
    const std::string& reason,
    int code = 2);

xpod_rdf_bytes bytes(const std::string& value) {
  return {value.data(), value.size()};
}

std::string copyBytes(xpod_rdf_bytes value) {
  return value.data == nullptr ? std::string() : std::string(value.data, value.size);
}

std::string readFile(const char* path, const std::string& label) {
  std::ifstream in(path);
  if (!in) {
    fail(label, std::string("fixture file missing: ") + path);
  }
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

std::string jsonEscape(const std::string& input) {
  std::ostringstream out;
  const char hexDigits[] = "0123456789abcdef";
  for (const unsigned char c : input) {
    if (c < 0x20) {
      out << "\\u00" << hexDigits[c >> 4] << hexDigits[c & 0x0f];
      continue;
    }
    switch (c) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      default: out << c; break;
    }
  }
  return out.str();
}

std::string blockFor(const std::string& json, const std::string& key, const std::string& label) {
  const std::string needle = '"' + key + "\": {";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing object " + key);
  }
  size_t brace = json.find('{', start);
  int depth = 0;
  for (size_t index = brace; index < json.size(); ++index) {
    if (json[index] == '{') ++depth;
    if (json[index] == '}') --depth;
    if (depth == 0) {
      return json.substr(brace, index - brace + 1);
    }
  }
  fail(label, "fixture object was not closed: " + key);
}

uint64_t uintField(const std::string& json, const std::string& key, const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing integer field " + key);
  }
  size_t pos = start + needle.size();
  while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
  return std::stoull(json.substr(pos));
}

bool nullableUintField(
    const std::string& json,
    const std::string& key,
    const std::string& label,
    uint64_t& out) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing nullable integer field " + key);
  }
  size_t pos = start + needle.size();
  while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
  if (json.compare(pos, 4, "null") == 0) {
    out = 0;
    return false;
  }
  out = std::stoull(json.substr(pos));
  return true;
}

double doubleField(const std::string& json, const std::string& key, const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing numeric field " + key);
  }
  size_t pos = start + needle.size();
  while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
  return std::stod(json.substr(pos));
}

std::string stringField(const std::string& json, const std::string& key, const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing string field " + key);
  }
  size_t quote = json.find('"', start + needle.size());
  if (quote == std::string::npos) fail(label, "fixture string was not quoted: " + key);
  ++quote;
  std::string value;
  for (; quote < json.size(); ++quote) {
    if (json[quote] == '"') return value;
    value.push_back(json[quote]);
  }
  fail(label, "fixture string was not closed: " + key);
}

std::vector<xpod_rdf_term_key> uintArrayField(
    const std::string& json,
    const std::string& key,
    const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing integer array field " + key);
  }
  const size_t open = json.find('[', start);
  const size_t close = json.find(']', open);
  if (open == std::string::npos || close == std::string::npos) {
    fail(label, "fixture array was not closed: " + key);
  }
  std::vector<xpod_rdf_term_key> values;
  std::stringstream in(json.substr(open + 1, close - open - 1));
  std::string item;
  while (std::getline(in, item, ',')) {
    if (item.find_first_not_of(" \n\r\t") != std::string::npos) {
      values.push_back(static_cast<xpod_rdf_term_key>(std::stoull(item)));
    }
  }
  return values;
}

std::vector<double> doubleArrayField(
    const std::string& json,
    const std::string& key,
    const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing score array field " + key);
  }
  const size_t open = json.find('[', start);
  const size_t close = json.find(']', open);
  if (open == std::string::npos || close == std::string::npos) {
    fail(label, "fixture score array was not closed: " + key);
  }
  std::vector<double> values;
  std::stringstream in(json.substr(open + 1, close - open - 1));
  std::string item;
  while (std::getline(in, item, ',')) {
    if (item.find_first_not_of(" \n\r\t") != std::string::npos) {
      values.push_back(std::stod(item));
    }
  }
  return values;
}

std::vector<std::string> stringArrayField(
    const std::string& json,
    const std::string& key,
    const std::string& label) {
  const std::string needle = '"' + key + "\":";
  const size_t start = json.find(needle);
  if (start == std::string::npos) {
    fail(label, "fixture missing string array field " + key);
  }
  const size_t open = json.find('[', start);
  const size_t close = json.find(']', open);
  if (open == std::string::npos || close == std::string::npos) {
    fail(label, "fixture string array was not closed: " + key);
  }
  std::vector<std::string> values;
  size_t pos = open + 1;
  while (pos < close) {
    const size_t quote = json.find('"', pos);
    if (quote == std::string::npos || quote >= close) break;
    const size_t end = json.find('"', quote + 1);
    if (end == std::string::npos || end > close) fail(label, "bad string array " + key);
    values.push_back(json.substr(quote + 1, end - quote - 1));
    pos = end + 1;
  }
  return values;
}

Fixture parseFixture(const std::string& json, const std::string& label) {
  Fixture fixture;
  const std::string stableTermKeys = blockFor(json, "stableTermKeys", label);
  const std::string stableSourceNodeKeys = blockFor(json, "stableSourceNodeKeys", label);
  const std::string seedArtifact = blockFor(json, "seedArtifact", label);
  fixture.seed_bootstrap_consumption_state =
      stringField(seedArtifact, "bootstrapConsumptionState", label);
  fixture.seed_provider_consumption_state =
      stringField(seedArtifact, "providerConsumptionState", label);
  fixture.text_exact = uintField(stableTermKeys, "text_exact", label);
  fixture.text_prefix = uintField(stableTermKeys, "text_prefix", label);
  fixture.text_entity = uintField(stableTermKeys, "text_entity", label);
  fixture.entity = uintField(stableTermKeys, "entity", label);
  fixture.graph_allow = uintField(stableTermKeys, "graph_allow", label);
  fixture.graph_deny = uintField(stableTermKeys, "graph_deny", label);
  fixture.source_allow = uintField(stableSourceNodeKeys, "source_allow", label);
  fixture.source_deny = uintField(stableSourceNodeKeys, "source_deny", label);
  fixture.scope_inside_term = uintField(stableTermKeys, "scope_inside_term", label);
  fixture.scope_outside_term = uintField(stableTermKeys, "scope_outside_term", label);

  const auto textExact = blockFor(json, "text_exact", label);
  fixture.text_query = stringField(textExact, "query", label);
  fixture.text_scores = doubleArrayField(textExact, "expected_scores", label);
  fixture.text_exact_retrieval_point = static_cast<xpod_rdf_retrieval_point_key>(
      uintField(textExact, "expected_retrieval_point", label));
  uint64_t nullable = 0;
  if (nullableUintField(textExact, "expected_resource_term", label, nullable) ||
      nullableUintField(textExact, "expected_matched_term", label, nullable)) {
    fail(label, "text exact record fixture must not expect resource or matched terms");
  }
  const auto textPrefix = blockFor(json, "text_prefix", label);
  fixture.prefix_query = stringField(textPrefix, "query", label);
  fixture.prefix_scores = doubleArrayField(textPrefix, "expected_scores", label);
  fixture.text_prefix_retrieval_point = static_cast<xpod_rdf_retrieval_point_key>(
      uintField(textPrefix, "expected_retrieval_point", label));
  if (nullableUintField(textPrefix, "expected_resource_term", label, nullable)) {
    fail(label, "text prefix record fixture must not expect a resource term");
  }
  if (!nullableUintField(textPrefix, "expected_matched_term", label, nullable)) {
    fail(label, "text prefix fixture must expect a matched term");
  }
  fixture.text_prefix_matched_term = static_cast<xpod_rdf_text_term_key>(nullable);
  const auto textEntity = blockFor(json, "text_entity_restriction", label);
  fixture.entity_query = stringField(textEntity, "query", label);
  fixture.entity_scores = doubleArrayField(textEntity, "expected_scores", label);
  fixture.text_entity_retrieval_point = static_cast<xpod_rdf_retrieval_point_key>(
      uintField(textEntity, "expected_retrieval_point", label));
  if (uintField(textEntity, "required_entity", label) != fixture.entity ||
      !nullableUintField(textEntity, "expected_resource_term", label, nullable) ||
      nullable != fixture.entity ||
      nullableUintField(textEntity, "expected_matched_term", label, nullable)) {
    fail(label, "entity restriction keys do not derive from stableTermKeys");
  }
  fixture.text_entity_resource_term = fixture.entity;

  const auto cosine = blockFor(json, "vector_cosine", label);
  fixture.model = stringField(cosine, "model", label);
  fixture.cosine_order = uintArrayField(cosine, "expected_order", label);
  fixture.cosine_scores = doubleArrayField(cosine, "expected_scores", label);
  const auto dot = blockFor(json, "vector_dot", label);
  fixture.dot_order = uintArrayField(dot, "expected_order", label);
  fixture.dot_scores = doubleArrayField(dot, "expected_scores", label);
  const auto euclidean = blockFor(json, "vector_euclidean", label);
  fixture.euclidean_order = uintArrayField(euclidean, "expected_order", label);
  fixture.euclidean_scores = doubleArrayField(euclidean, "expected_scores", label);
  const auto wrongModel = blockFor(json, "vector_model_validation", label);
  fixture.wrong_model = stringField(wrongModel, "model", label);
  const auto tie = blockFor(json, "threshold_limit_deterministic_tie_order", label);
  fixture.tie_order = uintArrayField(tie, "expected_order", label);
  fixture.tie_scores = doubleArrayField(tie, "expected_scores", label);
  const auto scope = blockFor(json, "graph_source_access_scope_before_limit", label);
  if (uintField(scope, "scope_inside_term", label) != fixture.scope_inside_term ||
      uintField(scope, "scope_outside_term", label) != fixture.scope_outside_term ||
      uintField(scope, "graph_allow", label) != fixture.graph_allow ||
      uintField(scope, "graph_deny", label) != fixture.graph_deny ||
      uintField(scope, "source_allow", label) != fixture.source_allow ||
      uintField(scope, "source_deny", label) != fixture.source_deny) {
    fail(label, "scope-before-limit fixture keys do not derive from stableTermKeys");
  }
  if (doubleField(scope, "scope_outside_score", label) <=
      doubleField(scope, "scope_inside_score", label)) {
    fail(label, "scope-before-limit fixture lacks better out-of-scope candidate");
  }
  fixture.scope_inside_score = doubleField(scope, "scope_inside_score", label);
  fixture.stale_snapshot =
      stringField(blockFor(json, "snapshot_fail_closed", label), "snapshot_token", label);
  const auto provenance = blockFor(json, "scorer_model_index_provenance", label);
  fixture.expected_scorer = stringField(provenance, "expected_provider_scorer", label);
  fixture.fixtureExpected_indexes = stringArrayField(provenance, "expected_fixture_indexes", label);
  if (fixture.cosine_order.empty() || fixture.dot_order.empty() ||
      fixture.euclidean_order.empty() || fixture.tie_order.size() < 2 ||
      fixture.tie_scores.size() != fixture.tie_order.size() ||
      fixture.text_scores.size() != 1 || fixture.prefix_scores.size() != 1 ||
      fixture.entity_scores.size() != 1) {
    fail(label, "fixture expected order/score cases must be non-empty");
  }
  return fixture;
}

Fixture parseSeedArtifact(const std::string& json, const std::string& label) {
  return parseFixture(json, label);
}

void requireSeedArtifactMatchesFixture(
    const Fixture& seed,
    const Fixture& fixture,
    const std::string& label) {
  const bool matches =
      seed.text_exact == fixture.text_exact &&
      seed.text_prefix == fixture.text_prefix &&
      seed.text_entity == fixture.text_entity &&
      seed.entity == fixture.entity &&
      seed.graph_allow == fixture.graph_allow &&
      seed.graph_deny == fixture.graph_deny &&
      seed.source_allow == fixture.source_allow &&
      seed.source_deny == fixture.source_deny &&
      seed.scope_inside_term == fixture.scope_inside_term &&
      seed.scope_outside_term == fixture.scope_outside_term &&
      seed.text_exact_retrieval_point == fixture.text_exact_retrieval_point &&
      seed.text_prefix_retrieval_point == fixture.text_prefix_retrieval_point &&
      seed.text_entity_retrieval_point == fixture.text_entity_retrieval_point &&
      seed.text_entity_resource_term == fixture.text_entity_resource_term &&
      seed.text_prefix_matched_term == fixture.text_prefix_matched_term &&
      seed.model == fixture.model &&
      seed.wrong_model == fixture.wrong_model;
  if (!matches) {
    failWithFixture(label, fixture, "seed artifact stable keys mismatch");
  }
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

uint64_t fnv1a(const std::vector<xpod_rdf_candidate>& rows) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (const auto& row : rows) {
    for (uint64_t value : {
             static_cast<uint64_t>(row.source_node),
             static_cast<uint64_t>(row.retrieval_point),
             static_cast<uint64_t>(row.resource_term)}) {
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

xpod_rdf_status collectCandidates(void* opaque, const xpod_rdf_candidate_batch* batch) {
  if (opaque == nullptr || batch == nullptr ||
      (batch->row_count != 0 && batch->rows == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* out = static_cast<CandidateRows*>(opaque);
  out->rows.insert(out->rows.end(), batch->rows, batch->rows + batch->row_count);
  for (size_t index = 0; index < batch->row_count; ++index) {
    if (batch->matched_terms != nullptr && batch->has_matched_terms != nullptr) {
      out->matched_terms.push_back(batch->matched_terms[index]);
      out->has_matched_terms.push_back(batch->has_matched_terms[index]);
    } else {
      out->matched_terms.push_back(0);
      out->has_matched_terms.push_back(0);
    }
  }
  if (batch->scorer.size != 0) provider_scorers.insert(copyBytes(batch->scorer));
  for (size_t index = 0; index < batch->row_count; ++index) {
    const std::string scorer = copyBytes(batch->rows[index].scorer);
    if (!scorer.empty()) provider_scorers.insert(scorer);
  }
  return XPOD_RDF_STATUS_OK;
}

uint8_t cancellationFlag(void* opaque) {
  return *static_cast<bool*>(opaque) ? 1 : 0;
}

void record(const std::string& name, xpod_rdf_status status) {
  auto& item = coverage[name];
  item.status = "exercised";
  ++item.calls;
  if (status == XPOD_RDF_STATUS_OK) ++item.successes;
}

void markUnsupported(const std::string& name) {
  auto& item = coverage[name];
  item.status = "unsupported";
}

void printStringArray(const std::vector<std::string>& values) {
  std::cout << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << '"' << jsonEscape(values[index]) << '"';
  }
  std::cout << ']';
}

void printStringSet(const std::set<std::string>& values) {
  std::cout << '[';
  size_t index = 0;
  for (const auto& value : values) {
    if (index++ != 0) std::cout << ',';
    std::cout << '"' << jsonEscape(value) << '"';
  }
  std::cout << ']';
}

void emitEvidence(
    const std::string& backend,
    const std::string& status,
    const std::string& reason,
    const Fixture* fixture) {
  const char* callbacks[] = {
      "estimate_text_search",
      "estimate_vector_search",
      "text_search",
      "vector_search"};
  const char* caseNames[] = {
      "cancellation",
      "estimate_rows_stats_version",
      "graph_source_access_scope_before_limit",
      "scorer_model_index_provenance",
      "snapshot_fail_closed",
      "text_entity_restriction",
      "text_exact",
      "text_prefix",
      "threshold_limit_deterministic_tie_order",
      "vector_cosine",
      "vector_dimension_validation",
      "vector_dot",
      "vector_euclidean",
      "vector_model_validation"};
  std::cout << "{\"schemaVersion\":1,\"backend\":\"" << jsonEscape(backend)
            << "\",\"status\":\"" << status << "\"";
  if (!reason.empty()) std::cout << ",\"reason\":\"" << jsonEscape(reason) << '"';
  std::cout << ",\"callbackCoverage\":{";
  for (size_t index = 0; index < sizeof(callbacks) / sizeof(callbacks[0]); ++index) {
    if (index != 0) std::cout << ',';
    const auto found = coverage.find(callbacks[index]);
    const CallbackEvidence evidence =
        found == coverage.end() ? CallbackEvidence{} : found->second;
    std::cout << '"' << callbacks[index] << "\":{\"status\":\""
              << evidence.status << "\",\"calls\":" << evidence.calls
              << ",\"successes\":" << evidence.successes << '}';
  }
  std::cout << "},\"cases\":{";
  for (size_t index = 0; index < sizeof(caseNames) / sizeof(caseNames[0]); ++index) {
    if (index != 0) std::cout << ',';
    const auto found = cases.find(caseNames[index]);
    const CaseEvidence item = found == cases.end() ? CaseEvidence{} : found->second;
    std::cout << '"' << caseNames[index] << "\":{\"status\":\""
              << item.status << "\",\"rows\":" << item.rows;
    if (!item.digest.empty()) std::cout << ",\"digest\":\"" << item.digest << '"';
    std::cout << '}';
  }
  std::cout << "},\"provenance\":{\"providerReturned\":{\"scorers\":";
  printStringSet(provider_scorers);
  std::cout << ",\"models\":{\"status\":\"abi_unavailable\"},"
            << "\"indexes\":{\"status\":\"abi_unavailable\"}},"
            << "\"fixtureExpected\":{\"indexes\":";
  if (fixture == nullptr) {
    std::cout << "[]";
  } else {
    printStringArray(fixture->fixtureExpected_indexes);
  }
  std::cout << "},\"seedArtifact\":{\"state\":\"prepared\","
            << "\"bootstrapConsumptionState\":\"";
  if (fixture == nullptr) {
    std::cout
        << "consumed-by-contract-bootstrap\","
        << "\"providerConsumptionState\":\"deferred-until-callback-support\","
        << "\"path\":\"\"";
  } else {
    std::cout << jsonEscape(fixture->seed_bootstrap_consumption_state)
              << "\",\"providerConsumptionState\":\""
              << jsonEscape(fixture->seedArtifactConsumed ? "consumed" : fixture->seed_provider_consumption_state) << "\",\"path\":\""
              << jsonEscape(fixture->seed_artifact_path) << '"';
  }
  std::cout << "}}}\n";
}

[[noreturn]] void fail(
    const std::string& backend,
    const std::string& reason,
    int code) {
  emitEvidence(backend, "failed", reason, nullptr);
  std::cerr << "candidate contract failure: " << reason << '\n';
  std::exit(code);
}

[[noreturn]] void failWithFixture(
    const std::string& backend,
    const Fixture& fixture,
    const std::string& reason,
    int code) {
  (void)backend;
  (void)fixture;
  throw ContractFailure{reason, code};
}

void requireProvider(xpod_rdf_backend_v1* backend, const std::string& label) {
  (void)label;
  if (backend == nullptr ||
      backend->abi_version != XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION ||
      backend->struct_size < sizeof(xpod_rdf_backend_v1)) {
    throw ContractFailure{"provider returned incompatible ABI", 2};
  }
}

void requireCandidateCallbacks(
    xpod_rdf_backend_v1* backend,
    const Fixture& fixture,
    const std::string& label) {
  std::vector<std::string> missing;
  if (backend->text_search == nullptr) {
    markUnsupported("text_search");
    missing.emplace_back("text_search");
  }
  if (backend->estimate_text_search == nullptr) {
    markUnsupported("estimate_text_search");
    missing.emplace_back("estimate_text_search");
  }
  if (backend->vector_search == nullptr) {
    markUnsupported("vector_search");
    missing.emplace_back("vector_search");
  }
  if (backend->estimate_vector_search == nullptr) {
    markUnsupported("estimate_vector_search");
    missing.emplace_back("estimate_vector_search");
  }
  if (!missing.empty()) {
    std::sort(missing.begin(), missing.end());
    std::ostringstream reason;
    reason << "optional candidate callbacks unsupported:";
    for (const auto& name : missing) reason << ' ' << name;
    failWithFixture(label, fixture, reason.str());
  }
}

xpod_rdf_status runText(
    xpod_rdf_backend_v1* backend,
    const xpod_rdf_text_search_request& request,
    CandidateRows& rows) {
  const xpod_rdf_status status = backend->text_search(
      backend->backend_user_data, &request, collectCandidates, &rows);
  record("text_search", status);
  return status;
}

xpod_rdf_status estimateText(
    xpod_rdf_backend_v1* backend,
    const xpod_rdf_text_search_request& request,
    xpod_rdf_estimate& estimate) {
  const xpod_rdf_status status = backend->estimate_text_search(
      backend->backend_user_data, &request, &estimate);
  record("estimate_text_search", status);
  return status;
}

xpod_rdf_status runVector(
    xpod_rdf_backend_v1* backend,
    const xpod_rdf_vector_search_request& request,
    CandidateRows& rows) {
  const xpod_rdf_status status = backend->vector_search(
      backend->backend_user_data, &request, collectCandidates, &rows);
  record("vector_search", status);
  return status;
}

xpod_rdf_status estimateVector(
    xpod_rdf_backend_v1* backend,
    const xpod_rdf_vector_search_request& request,
    xpod_rdf_estimate& estimate) {
  const xpod_rdf_status status = backend->estimate_vector_search(
      backend->backend_user_data, &request, &estimate);
  record("estimate_vector_search", status);
  return status;
}

void passCase(const std::string& name, const CandidateRows& rows) {
  cases[name] = {"ok", rows.rows.size(), hex(fnv1a(rows.rows))};
}

void passCase(const std::string& name) {
  cases[name] = {"ok", 0, ""};
}

void requireStatus(
    const std::string& name,
    xpod_rdf_status status,
    const Fixture& fixture,
    const std::string& label) {
  if (status != XPOD_RDF_STATUS_OK) {
    failWithFixture(label, fixture, name + " returned " + statusName(status));
  }
}

void requireResourceTermOrderAndScores(
    const std::string& name,
    const CandidateRows& rows,
    const std::vector<xpod_rdf_term_key>& expected_order,
    const std::vector<double>& expected_scores,
    const Fixture& fixture,
    const std::string& label) {
  if (expected_order.empty() || rows.rows.size() < expected_order.size() ||
      expected_scores.size() != expected_order.size()) {
    failWithFixture(label, fixture, name + " had insufficient non-vacuous rows");
  }
  for (size_t index = 0; index < expected_order.size(); ++index) {
    const auto& candidate = rows.rows[index];
    if (!candidate.has_resource_term ||
        candidate.resource_term != expected_order[index] ||
        std::fabs(candidate.score - expected_scores[index]) > 0.000001) {
      failWithFixture(label, fixture, name + " expected_order/expected_scores mismatch");
    }
  }
}

void requireEntityOrderAndScores(
    const std::string& name,
    const CandidateRows& rows,
    const std::vector<xpod_rdf_term_key>& expected_order,
    const std::vector<double>& expected_scores,
    const Fixture& fixture,
    const std::string& label) {
  requireResourceTermOrderAndScores(
      name, rows, expected_order, expected_scores, fixture, label);
}

void requireTextRecordOrderAndScores(
    const std::string& name,
    const CandidateRows& rows,
    const std::vector<xpod_rdf_retrieval_point_key>& expected_order,
    const std::vector<double>& expected_scores,
    const Fixture& fixture,
    const std::string& label) {
  if (expected_order.empty() || rows.rows.size() < expected_order.size() ||
      expected_scores.size() != expected_order.size()) {
    failWithFixture(label, fixture, name + " had insufficient non-vacuous rows");
  }
  for (size_t index = 0; index < expected_order.size(); ++index) {
    const auto& candidate = rows.rows[index];
    if (!candidate.has_retrieval_point ||
        candidate.retrieval_point != expected_order[index] ||
        candidate.has_resource_term ||
        std::fabs(candidate.score - expected_scores[index]) > 0.000001) {
      failWithFixture(label, fixture, name + " expected_order/expected_scores mismatch");
    }
  }
}

void requireMatchedTerms(
    xpod_rdf_backend_v1* backend,
    const std::string& name,
    const CandidateRows& rows,
    const std::vector<xpod_rdf_text_term_key>& expected_terms,
    const std::string& expected_prefix,
    const Fixture& fixture,
    const std::string& label) {
  if (expected_terms.empty() || rows.matched_terms.size() < expected_terms.size() ||
      rows.has_matched_terms.size() < expected_terms.size()) {
    failWithFixture(label, fixture, name + " had insufficient matched terms");
  }
  for (size_t index = 0; index < expected_terms.size(); ++index) {
    if (rows.has_matched_terms[index] == 0 ||
        rows.matched_terms[index] != expected_terms[index]) {
      failWithFixture(label, fixture, name + " expected_matched_term mismatch");
    }
    if (backend->resolve_text_term != nullptr) {
      xpod_rdf_bytes resolved = {};
      const xpod_rdf_status status = backend->resolve_text_term(
          backend->backend_user_data, rows.matched_terms[index], nullptr, &resolved);
      if (status != XPOD_RDF_STATUS_OK ||
          copyBytes(resolved).rfind(expected_prefix, 0) != 0) {
        failWithFixture(label, fixture, name + " matched term resolve mismatch");
      }
    }
  }
}

void exerciseCandidateContract(
    xpod_rdf_backend_v1* backend,
    const Fixture& fixture,
    const Fixture& seed,
    const std::string& label) {
  xpod_rdf_text_search_request text = {};
  text.query = bytes(fixture.text_query);
  text.limit = 10;
  text.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_RECORD;
  CandidateRows exactRows;
  requireStatus("text_exact", runText(backend, text, exactRows), fixture, label);
  requireTextRecordOrderAndScores(
      "seed artifact text_exact",
      exactRows,
      {seed.text_exact_retrieval_point},
      seed.text_scores,
      fixture,
      label);
  passCase("text_exact", exactRows);

  xpod_rdf_estimate textEstimate = {};
  requireStatus("estimate_text_search", estimateText(backend, text, textEstimate), fixture, label);
  if (textEstimate.rows == 0 || textEstimate.stats_version.size == 0) {
    failWithFixture(label, fixture, "estimate rows/stats_version missing");
  }

  text.query = bytes(fixture.prefix_query);
  CandidateRows prefixRows;
  requireStatus("text_prefix", runText(backend, text, prefixRows), fixture, label);
  requireTextRecordOrderAndScores(
      "seed artifact text_prefix",
      prefixRows,
      {seed.text_prefix_retrieval_point},
      seed.prefix_scores,
      fixture,
      label);
  requireMatchedTerms(
      backend,
      "seed artifact text_prefix",
      prefixRows,
      {seed.text_prefix_matched_term},
      seed.prefix_query.substr(0, seed.prefix_query.size() - 1),
      fixture,
      label);
  passCase("text_prefix", prefixRows);

  text.query = bytes(fixture.entity_query);
  text.required_entities = &fixture.entity;
  text.required_entities_size = 1;
  text.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_ENTITY;
  CandidateRows entityRows;
  requireStatus("text_entity_restriction", runText(backend, text, entityRows), fixture, label);
  requireEntityOrderAndScores(
      "text_entity_restriction",
      entityRows,
      {seed.text_entity_resource_term},
      seed.entity_scores,
      fixture,
      label);
  passCase("text_entity_restriction", entityRows);

  const double vectorValues[3] = {1.0, 0.0, 0.0};
  xpod_rdf_vector_search_request vector = {};
  vector.vector = vectorValues;
  vector.dimensions = 3;
  vector.model = bytes(fixture.model);
  vector.limit = 10;
  vector.metric = XPOD_RDF_VECTOR_COSINE;
  CandidateRows cosineRows;
  requireStatus("vector_cosine", runVector(backend, vector, cosineRows), fixture, label);
  requireResourceTermOrderAndScores(
      "seed artifact vector_cosine", cosineRows, seed.cosine_order, seed.cosine_scores, fixture, label);
  passCase("vector_cosine", cosineRows);

  xpod_rdf_estimate vectorEstimate = {};
  requireStatus(
      "estimate_vector_search", estimateVector(backend, vector, vectorEstimate), fixture, label);
  if (vectorEstimate.rows == 0 || vectorEstimate.stats_version.size == 0) {
    failWithFixture(label, fixture, "vector estimate rows/stats_version missing");
  }
  passCase("estimate_rows_stats_version");

  vector.metric = XPOD_RDF_VECTOR_DOT;
  CandidateRows dotRows;
  requireStatus("vector_dot", runVector(backend, vector, dotRows), fixture, label);
  requireResourceTermOrderAndScores(
      "seed artifact vector_dot", dotRows, seed.dot_order, seed.dot_scores, fixture, label);
  passCase("vector_dot", dotRows);

  vector.metric = XPOD_RDF_VECTOR_EUCLIDEAN;
  CandidateRows euclideanRows;
  requireStatus("vector_euclidean", runVector(backend, vector, euclideanRows), fixture, label);
  requireResourceTermOrderAndScores(
      "vector_euclidean",
      euclideanRows,
      seed.euclidean_order,
      seed.euclidean_scores,
      fixture,
      label);
  passCase("vector_euclidean", euclideanRows);

  vector.metric = XPOD_RDF_VECTOR_COSINE;
  vector.dimensions = 2;
  if (estimateVector(backend, vector, vectorEstimate) == XPOD_RDF_STATUS_OK) {
    failWithFixture(label, fixture, "vector dimension validation did not fail closed");
  }
  passCase("vector_dimension_validation");

  vector.dimensions = 3;
  vector.model = bytes(fixture.wrong_model);
  if (estimateVector(backend, vector, vectorEstimate) == XPOD_RDF_STATUS_OK) {
    failWithFixture(label, fixture, "vector model validation did not fail closed");
  }
  passCase("vector_model_validation");

  vector.model = bytes(fixture.model);
  vector.limit = 2;
  vector.has_threshold = 1;
  vector.threshold = 0.5;
  CandidateRows firstTie;
  CandidateRows secondTie;
  requireStatus(
      "threshold_limit_deterministic_tie_order",
      runVector(backend, vector, firstTie),
      fixture,
      label);
  requireStatus(
      "threshold_limit_deterministic_tie_order",
      runVector(backend, vector, secondTie),
      fixture,
      label);
  requireResourceTermOrderAndScores(
      "threshold_limit_deterministic_tie_order",
      firstTie,
      seed.tie_order,
      seed.tie_scores,
      fixture,
      label);
  xpod_rdf_estimate thresholdEstimate = {};
  requireStatus(
      "threshold_limit_deterministic_tie_order estimate",
      estimateVector(backend, vector, thresholdEstimate),
      fixture,
      label);
  if (thresholdEstimate.rows != seed.cosine_order.size()) {
    failWithFixture(label, fixture, "seed artifact vector threshold estimate rows mismatch");
  }
  if (hex(fnv1a(firstTie.rows)) != hex(fnv1a(secondTie.rows))) {
    failWithFixture(label, fixture, "deterministic tie order mismatch");
  }
  passCase("threshold_limit_deterministic_tie_order", firstTie);

  xpod_rdf_access_scope allowed = {};
  allowed.mode = XPOD_RDF_ACCESS_READ;
  allowed.authorization_model = XPOD_RDF_AUTH_WAC;
  allowed.allowed_graphs = &fixture.graph_allow;
  allowed.allowed_graphs_size = 1;
  allowed.denied_graphs = &fixture.graph_deny;
  allowed.denied_graphs_size = 1;
  vector.limit = 1;
  vector.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  vector.graph_scope.exact_graph = fixture.graph_allow;
  vector.source_scope.has_source_node = 1;
  vector.source_scope.source_node = fixture.source_allow;
  vector.access_scope = &allowed;
  CandidateRows scopedRows;
  requireStatus(
      "graph_source_access_scope_before_limit",
      runVector(backend, vector, scopedRows),
      fixture,
      label);
  requireResourceTermOrderAndScores(
      "graph_source_access_scope_before_limit",
      scopedRows,
      {seed.scope_inside_term},
      {seed.scope_inside_score},
      fixture,
      label);
  const auto& candidate = scopedRows.rows[0];
  if (candidate.resource_term == fixture.scope_outside_term) {
    failWithFixture(label, fixture, "scope outside candidate won before scope filtering");
  }
  if (!candidate.has_source_node ||
      candidate.source_node != fixture.source_allow) {
    failWithFixture(label, fixture, "scope source did not return expected source_node");
  }
  passCase("graph_source_access_scope_before_limit", scopedRows);

  vector.snapshot.snapshot_token = bytes(fixture.stale_snapshot);
  if (estimateVector(backend, vector, vectorEstimate) == XPOD_RDF_STATUS_OK) {
    failWithFixture(label, fixture, "snapshot fail-closed did not reject stale snapshot");
  }
  passCase("snapshot_fail_closed");

  bool cancelled = true;
  xpod_rdf_cancellation cancellation = {&cancelled, cancellationFlag};
  text.cancellation = &cancellation;
  CandidateRows cancelledRows;
  if (runText(backend, text, cancelledRows) != XPOD_RDF_STATUS_CANCELLED) {
    failWithFixture(label, fixture, "cancellation was not honored");
  }
  passCase("cancellation");

  if (provider_scorers.count(fixture.expected_scorer) == 0) {
    failWithFixture(label, fixture, "provider-returned scorer provenance missing");
  }
  passCase("scorer_model_index_provenance");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr
        << "usage: candidate-contract-runner PROVIDER CONFIG_JSON BACKEND_LABEL FIXTURE_JSON SEED_JSON\n";
    return 64;
  }

  const std::string label = argv[3];
  Fixture fixture = parseFixture(readFile(argv[4], label), label);
  fixture.seed_artifact_path = std::string(argv[5]);
  Fixture seed = parseSeedArtifact(readFile(argv[5], label), label);
  ProviderHandle provider;
  provider.library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (provider.library == nullptr) fail(label, dlerror());
  auto create = reinterpret_cast<Create>(
      dlsym(provider.library, "xpod_qlever_backend_provider_create"));
  provider.destroy = reinterpret_cast<Destroy>(
      dlsym(provider.library, "xpod_qlever_backend_provider_destroy"));
  if (create == nullptr || provider.destroy == nullptr) {
    emitEvidence(label, "failed", "provider entry points missing", &fixture);
    std::cerr << "candidate contract failure: provider entry points missing\n";
    return 2;
  }

  const std::string configJson = argv[2];
  const xpod_rdf_bytes config = bytes(configJson);
  const xpod_rdf_status createStatus = create(&config, &provider.backend);
  if (createStatus != XPOD_RDF_STATUS_OK) {
    emitEvidence(
        label,
        "failed",
        std::string("provider_create returned ") + statusName(createStatus),
        &fixture);
    std::cerr << "candidate contract failure: provider_create returned "
              << statusName(createStatus) << '\n';
    return 2;
  }
  try {
    requireProvider(provider.backend, label);
    requireSeedArtifactMatchesFixture(seed, fixture, label);
    requireCandidateCallbacks(provider.backend, fixture, label);
    exerciseCandidateContract(provider.backend, fixture, seed, label);
    fixture.seedArtifactConsumed = true;
    emitEvidence(label, "ok", "", &fixture);
  } catch (const ContractFailure& failure) {
    emitEvidence(label, "failed", failure.reason, &fixture);
    std::cerr << "candidate contract failure: " << failure.reason << '\n';
    return failure.code;
  }
  return 0;
}
