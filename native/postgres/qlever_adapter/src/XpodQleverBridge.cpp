#include "XpodQleverBridge.hpp"
#include "XpodBackedIndexScan.hpp"
#include "XpodCandidateBridge.hpp"
#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverPermutationMap.hpp"
#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverResultBridge.hpp"
#include "XpodQleverScanBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#if !XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#error "XpodQleverBridge.cpp must only be compiled when XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1"
#endif

#include "engine/IndexScan.h"
#include "engine/QueryExecutionContext.h"
#include "engine/QueryPlanner.h"
#include "engine/RuntimeInformation.h"
#include "index/Index.h"
#include "libqlever/Qlever.h"
#include "parser/SparqlParser.h"

#include <exception>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace xpod::qlever {

bool bridgeCompiledWithQlever() noexcept { return true; }

namespace {

std::string_view bytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr) {
    return {};
  }
  return {bytes.data, bytes.size};
}

xpod_rdf_status parseBridgeQuery(
    std::string_view query,
    std::string& error_storage,
    BridgeQueryPlan& out_plan) {
  try {
    auto parsed = SparqlParser::parseQuery(nullptr, std::string(query));
    auto plan = planParsedQuery(parsed);
    if (!plan.has_value()) {
      error_storage = "unsupported QLever bridge query";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    out_plan = *plan;
    return XPOD_RDF_STATUS_OK;
  } catch (const std::exception& error) {
    error_storage = "failed to parse QLever bridge query: ";
    error_storage += error.what();
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } catch (...) {
    error_storage = "failed to parse QLever bridge query";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
}

void setResult(
    xpod_qlever_query_result& out_result,
    xpod_rdf_status status,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) noexcept {
  out_result.status = status;
  out_result.result_json = {result_storage.data(), result_storage.size()};
  out_result.profile_json = {profile_storage.data(), profile_storage.size()};
  out_result.error_message = {error_storage.data(), error_storage.size()};
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
        out << c;
        break;
    }
  }
  out << '"';
}

xpod_rdf_status resolveIdTableTerms(
    xpod::rdf::PhysicalBackend backend,
    const IdTable& table,
    std::vector<xpod_rdf_term>& out_terms,
    std::string& error_storage) {
  std::vector<xpod_rdf_term_key> keys;
  keys.reserve(table.numRows() * table.numColumns());
  for (size_t row = 0; row < table.numRows(); ++row) {
    for (size_t column = 0; column < table.numColumns(); ++column) {
      xpod_rdf_term_key key = 0;
      xpod_rdf_status status = backend.decodeQleverId(
          table(row, column).getBits(), key);
      if (status != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to decode QLever result id";
        return status;
      }
      keys.push_back(key);
    }
  }

  out_terms.resize(keys.size());
  std::vector<xpod_rdf_status> statuses(keys.size());
  xpod_rdf_snapshot snapshot = {};
  xpod_rdf_status status = backend.resolveTerms(
      keys.data(), keys.size(), snapshot, out_terms.data(), statuses.data());
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve QLever result terms";
    return status;
  }
  for (xpod_rdf_status term_status : statuses) {
    if (term_status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to resolve one or more QLever result terms";
      return term_status;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

void writeTermBinding(std::ostringstream& out, const xpod_rdf_term& term) {
  out << '{';
  if (term.kind == XPOD_RDF_TERM_IRI) {
    out << "\"type\":\"uri\",\"value\":";
    writeJsonString(out, bytesView(term.value));
  } else if (term.kind == XPOD_RDF_TERM_BLANK) {
    out << "\"type\":\"bnode\",\"value\":";
    writeJsonString(out, bytesView(term.value));
  } else {
    out << "\"type\":\"literal\",\"value\":";
    writeJsonString(out, bytesView(term.value));
    if (term.language.size != 0) {
      out << ",\"xml:lang\":";
      writeJsonString(out, bytesView(term.language));
    } else if (term.datatype_iri.size != 0) {
      out << ",\"datatype\":";
      writeJsonString(out, bytesView(term.datatype_iri));
    }
  }
  out << '}';
}

void writeSparqlJson(std::ostringstream& out, const IdTable& table,
                     const std::vector<xpod_rdf_term>& terms) {
  static constexpr const char* variables[3] = {"s", "p", "o"};
  out << "{\"engine\":\"xpod-qlever-bridge\",\"head\":{\"vars\":[\"s\",\"p\",\"o\"]},\"results\":{\"bindings\":[";
  size_t term_index = 0;
  for (size_t row = 0; row < table.numRows(); ++row) {
    if (row != 0) {
      out << ',';
    }
    out << '{';
    for (size_t column = 0; column < table.numColumns(); ++column) {
      if (column != 0) {
        out << ',';
      }
      out << '"' << variables[column] << "\":";
      writeTermBinding(out, terms[term_index++]);
    }
    out << '}';
  }
  out << "]}}";
}


void writeScanProfileJson(std::ostringstream& out, std::string_view descriptor,
                          uint64_t output_rows) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"root\":{\"kind\":\"PermutationScan\",\"descriptor\":";
  writeJsonString(out, descriptor);
  out << ",\"outputRows\":" << output_rows << "}}";
}

}  // namespace

xpod_rdf_status executeBridgeQuery(
    xpod::rdf::PhysicalBackend backend,
    xpod_rdf_bytes sparql,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  result_storage.clear();
  profile_storage.clear();
  error_storage.clear();

  std::string_view query = bytesView(sparql);
  BridgeQueryPlan plan;
  xpod_rdf_status parse_status = parseBridgeQuery(query, error_storage, plan);
  if (parse_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, parse_status, result_storage, profile_storage,
              error_storage);
    return parse_status;
  }
  (void)plan;

  XpodBackedIndexScan scan(
      backend, plan.scan, plan.sorted_by, plan.result_width, plan.descriptor,
      1, 0);
  QleverResultWithStatus result = scan.computeResult(false);
  if (result.status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever scan failed";
    setResult(out_result, result.status, result_storage, profile_storage,
              error_storage);
    return result.status;
  }

  std::vector<xpod_rdf_term> terms;
  xpod_rdf_status resolve_status = resolveIdTableTerms(
      backend, result.result.idTable(), terms, error_storage);
  if (resolve_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, resolve_status, result_storage, profile_storage,
              error_storage);
    return resolve_status;
  }

  std::ostringstream json;
  writeSparqlJson(json, result.result.idTable(), terms);
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(profile, plan.descriptor,
                       result.result.idTable().numRows());
  profile_storage = profile.str();
  setResult(out_result, XPOD_RDF_STATUS_OK, result_storage, profile_storage,
            error_storage);
  return XPOD_RDF_STATUS_OK;
}

}  // namespace xpod::qlever
