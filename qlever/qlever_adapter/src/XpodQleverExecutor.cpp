#include "XpodQleverExecutor.hpp"
#include "XpodBackedVectorSearch.hpp"

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "XpodQleverBridge.hpp"
#include "XpodQleverPlannerContextProvider.hpp"
#include "global/RuntimeParameters.h"
#endif

#include <new>
#include <sstream>
#include <string_view>
#include <vector>

namespace xpod::qlever {

namespace {

constexpr std::string_view kSparqlJsonMediaType =
    "application/sparql-results+json";

std::string_view bytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr) {
    return {};
  }
  return {bytes.data, bytes.size};
}

void writeJsonControlEscape(std::ostringstream& out, unsigned char c) {
  constexpr char hex[] = "0123456789abcdef";
  out << "\\u00" << hex[c >> 4] << hex[c & 0x0f];
}

void writeJsonString(std::ostringstream& out, std::string_view value) {
  out << '"';
  for (char c : value) {
    switch (c) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          writeJsonControlEscape(out, static_cast<unsigned char>(c));
        } else {
          out << c;
        }
        break;
    }
  }
  out << '"';
}

void writeTermBinding(std::ostringstream& out, const xpod_rdf_term& term) {
  out << '{';
  switch (term.kind) {
    case XPOD_RDF_TERM_IRI:
      out << "\"type\":\"uri\",\"value\":";
      writeJsonString(out, bytesView(term.value));
      break;
    case XPOD_RDF_TERM_BLANK:
      out << "\"type\":\"bnode\",\"value\":";
      writeJsonString(out, bytesView(term.value));
      break;
    case XPOD_RDF_TERM_LITERAL:
      out << "\"type\":\"literal\",\"value\":";
      writeJsonString(out, bytesView(term.value));
      if (term.language.data != nullptr && term.language.size != 0) {
        out << ",\"xml:lang\":";
        writeJsonString(out, bytesView(term.language));
      } else if (term.datatype_iri.data != nullptr &&
                 term.datatype_iri.size != 0) {
        out << ",\"datatype\":";
        writeJsonString(out, bytesView(term.datatype_iri));
      }
      break;
  }
  out << '}';
}

bool acceptsSparqlJson(const xpod_qlever_query_request& request) noexcept {
  std::string_view accept = bytesView(request.accept_media_type);
  return accept.empty() ||
         accept.find(kSparqlJsonMediaType) != std::string_view::npos ||
         accept.find("application/*") != std::string_view::npos ||
         accept.find("*/*") != std::string_view::npos;
}

void setVectorQueryResult(
    xpod_qlever_query_result& out_result,
    xpod_rdf_status status,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) noexcept {
  out_result.status = status;
  out_result.result_json = {result_storage.data(), result_storage.size()};
  out_result.result_media_type = status == XPOD_RDF_STATUS_OK
                                     ? xpod_rdf_bytes{kSparqlJsonMediaType.data(),
                                                     kSparqlJsonMediaType.size()}
                                     : xpod_rdf_bytes{nullptr, 0};
  out_result.profile_json = {profile_storage.data(), profile_storage.size()};
  out_result.error_message = {error_storage.data(), error_storage.size()};
}

xpod_rdf_status appendVectorResourceOutputColumn(
    std::vector<std::string_view>& variables,
    std::vector<xpod_rdf_term>& terms,
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    std::string& error_storage,
    xpod_rdf_bytes variable,
    bool has_key,
    xpod_rdf_term_key key) {
  std::string_view name = bytesView(variable);
  if (name.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  if (!has_key) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_term term = {};
  xpod_rdf_status status = backend.resolveTerm(key, snapshot, term);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve Xpod vector query candidate term";
    return status;
  }
  variables.push_back(name);
  terms.push_back(term);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status appendVectorRetrievalOutputColumn(
    std::vector<std::string_view>& variables,
    std::vector<xpod_rdf_term>& terms,
    xpod_rdf_bytes variable,
    const xpod::rdf::CandidateRow& candidate) {
  std::string_view name = bytesView(variable);
  if (name.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  if (!candidate.has_retrieval_point_key) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_LITERAL;
  term.value = {
      candidate.retrieval_point_key.data(),
      candidate.retrieval_point_key.size(),
  };
  variables.push_back(name);
  terms.push_back(term);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status executeVectorQueryExtension(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage,
    bool& handled) {
  handled = request.vector_query != nullptr;
  if (!handled) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  result_storage.clear();
  profile_storage.clear();
  error_storage.clear();

  if (!acceptsSparqlJson(request)) {
    error_storage = "vector query result media type is not acceptable";
    setVectorQueryResult(
        out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
        profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const xpod_qlever_vector_query& vector_query = *request.vector_query;
  if (vector_query.vector == nullptr || vector_query.dimensions == 0 ||
      vector_query.limit == 0 ||
      bytesView(vector_query.provider).empty() ||
      bytesView(vector_query.model).empty() ||
      bytesView(vector_query.model_version).empty() ||
      bytesView(vector_query.input_kind).empty() ||
      bytesView(vector_query.projection_policy_version).empty()) {
    error_storage = "invalid Xpod vector query binding";
    setVectorQueryResult(
        out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
        profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (bytesView(vector_query.retrieval_point_variable).empty() &&
      bytesView(vector_query.resource_variable).empty()) {
    error_storage = "Xpod vector query has no output variable";
    setVectorQueryResult(
        out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
        profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_vector_search_request vector_request = {};
  vector_request.snapshot = request.snapshot;
  vector_request.cancellation = request.cancellation;
  vector_request.vector = vector_query.vector;
  vector_request.dimensions = vector_query.dimensions;
  vector_request.provider = vector_query.provider;
  vector_request.model = vector_query.model;
  vector_request.model_version = vector_query.model_version;
  vector_request.input_kind = vector_query.input_kind;
  vector_request.projection_policy_version =
      vector_query.projection_policy_version;
  vector_request.metric = vector_query.metric;
  vector_request.graph_scope = request.graph_scope;
  vector_request.source_scope = request.source_scope;
  vector_request.access_scope = request.access_scope;
  vector_request.limit = vector_query.limit;
  vector_request.threshold = vector_query.threshold;
  vector_request.has_threshold = vector_query.has_threshold;

  XpodBackedVectorSearch vector_search(
      backend, vector_request, "XpodVectorQuery");
  XpodBackedCandidateResult candidate_result = vector_search.computeResult(false);
  if (candidate_result.status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod vector query candidate source failed";
    setVectorQueryResult(
        out_result, candidate_result.status, result_storage, profile_storage,
        error_storage);
    return candidate_result.status;
  }

  std::vector<std::string_view> output_variables;
  std::vector<std::vector<xpod_rdf_term>> rows;
  rows.reserve(candidate_result.candidates.rows.size());
  for (const xpod::rdf::CandidateRow& candidate :
       candidate_result.candidates.rows) {
    std::vector<std::string_view> row_variables;
    std::vector<xpod_rdf_term> row_terms;
    xpod_rdf_status append_status = appendVectorRetrievalOutputColumn(
        row_variables, row_terms, vector_query.retrieval_point_variable,
        candidate);
    if (append_status == XPOD_RDF_STATUS_OK) {
      append_status = appendVectorResourceOutputColumn(
          row_variables, row_terms, backend, request.snapshot, error_storage,
          vector_query.resource_variable, candidate.has_resource_term,
          candidate.resource_term);
    }
    if (append_status != XPOD_RDF_STATUS_OK) {
      if (error_storage.empty()) {
        error_storage = "Xpod vector query candidate row is missing output key";
      }
      setVectorQueryResult(
          out_result, append_status, result_storage, profile_storage,
          error_storage);
      return append_status;
    }
    if (output_variables.empty()) {
      output_variables = std::move(row_variables);
    }
    rows.push_back(std::move(row_terms));
  }

  std::ostringstream json;
  json << "{\"head\":{\"vars\":[";
  for (size_t i = 0; i < output_variables.size(); ++i) {
    if (i != 0) {
      json << ',';
    }
    writeJsonString(json, output_variables[i]);
  }
  json << "]},\"results\":{\"bindings\":[";
  for (size_t row_index = 0; row_index < rows.size(); ++row_index) {
    if (row_index != 0) {
      json << ',';
    }
    json << '{';
    for (size_t column = 0; column < output_variables.size(); ++column) {
      if (column != 0) {
        json << ',';
      }
      writeJsonString(json, output_variables[column]);
      json << ':';
      writeTermBinding(json, rows[row_index][column]);
    }
    json << '}';
  }
  json << "]}}";
  result_storage = json.str();

  std::ostringstream profile;
  profile << "{\"engine\":\"xpod-qlever-adapter\",\"root\":{"
          << "\"kind\":\"VectorSearch\","
          << "\"descriptor\":\"XpodVectorQuery\","
          << "\"outputRows\":" << rows.size() << ","
          << "\"scannedRows\":" << candidate_result.candidates.scanned_rows
          << "}}";
  profile_storage = profile.str();
  setVectorQueryResult(
      out_result, XPOD_RDF_STATUS_OK, result_storage, profile_storage,
      error_storage);
  return XPOD_RDF_STATUS_OK;
}

}  // namespace

class StubQueryExecutor final : public QueryExecutor {
 public:
  StubQueryExecutor(
      xpod::rdf::PhysicalBackend backend,
      QueryExecutionOptions options) noexcept
      : backend_(backend), options_(options) {}

  xpod_rdf_status execute(
      const xpod_qlever_query_request& request,
      xpod_qlever_query_result& out_result,
      std::string& result_storage,
      std::string& profile_storage,
      std::string& error_storage) override {
    bool handled_vector_query = false;
    xpod_rdf_status vector_status = executeVectorQueryExtension(
        backend_, request, out_result, result_storage, profile_storage,
        error_storage, handled_vector_query);
    if (handled_vector_query) {
      return vector_status;
    }

    result_storage.clear();
    profile_storage.clear();
    error_storage =
        "stub QLever executor is not wired to upstream QLever yet";

    out_result.status = XPOD_RDF_STATUS_UNSUPPORTED;
    out_result.result_json = {result_storage.data(), result_storage.size()};
    out_result.result_media_type = {nullptr, 0};
    out_result.profile_json = {profile_storage.data(), profile_storage.size()};
    out_result.error_message = {error_storage.data(), error_storage.size()};

    (void)request;
    (void)backend_;
    (void)options_;
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  QueryExecutionOptions options_;
};

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
class BridgedQleverExecutor final : public QueryExecutor {
 public:
  BridgedQleverExecutor(
      xpod::rdf::PhysicalBackend backend,
      QueryExecutionOptions options)
      : backend_(backend),
        options_(options) {
    setRuntimeParameter<&RuntimeParameters::stripColumns_>(true);
  }

  xpod_rdf_status execute(
      const xpod_qlever_query_request& request,
      xpod_qlever_query_result& out_result,
      std::string& result_storage,
      std::string& profile_storage,
      std::string& error_storage) override {
    result_storage.clear();
    profile_storage.clear();
    (void)bridgeCompiledWithQlever();
    auto planner_context_provider = createQueryPlannerContextProvider(
        backend_, options_.memory_limit_bytes,
        QueryExecutionContextCacheMode::Uncached);
    PlannerContextHandle planner_context =
        planner_context_provider == nullptr
            ? PlannerContextHandle{}
            : planner_context_provider->current(request);
    if (options_.policy == QueryExecutionPolicy::CompatibilityAllowed) {
      return executeBridgeQueryWithPlannerContext(
          backend_, planner_context, request, out_result, result_storage,
          profile_storage, error_storage);
    }
    return executeNativeQleverQueryWithPlannerContext(
        backend_, planner_context, request, out_result, result_storage,
        profile_storage, error_storage);
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  QueryExecutionOptions options_;
};
#endif

std::unique_ptr<QueryExecutor> createQueryExecutor(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionOptions options) {
#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
  return std::make_unique<BridgedQleverExecutor>(backend, options);
#else
  return std::make_unique<StubQueryExecutor>(backend, options);
#endif
}

}  // namespace xpod::qlever
