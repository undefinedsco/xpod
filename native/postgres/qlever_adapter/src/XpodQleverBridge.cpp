#include "XpodQleverBridge.hpp"
#include "XpodBackedIndexScan.hpp"
#include "XpodCandidateBridge.hpp"
#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverPermutationMap.hpp"
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

#include <sstream>
#include <string_view>

namespace xpod::qlever {

bool bridgeCompiledWithQlever() noexcept { return true; }

namespace {

std::string_view bytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr) {
    return {};
  }
  return {bytes.data, bytes.size};
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

void writeIdTableJson(std::ostringstream& out, const IdTable& table) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"columns\":[\"s\",\"p\",\"o\"],\"rows\":[";
  for (size_t row = 0; row < table.numRows(); ++row) {
    if (row != 0) {
      out << ',';
    }
    out << '[';
    for (size_t column = 0; column < table.numColumns(); ++column) {
      if (column != 0) {
        out << ',';
      }
      out << table(row, column).getBits();
    }
    out << ']';
  }
  out << "]}";
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

  if (bytesView(sparql) != "SELECT * WHERE { ?s ?p ?o }") {
    error_storage = "unsupported QLever bridge query";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;
  XpodBackedIndexScan scan(
      backend, input, {0}, 3, "xpod scan ?s ?p ?o", 1, 0);
  QleverResultWithStatus result = scan.computeResult(false);
  if (result.status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever scan failed";
    setResult(out_result, result.status, result_storage, profile_storage,
              error_storage);
    return result.status;
  }

  std::ostringstream json;
  writeIdTableJson(json, result.result.idTable());
  result_storage = json.str();
  profile_storage =
      "{\"engine\":\"xpod-qlever-bridge\",\"profile\":\"native-events\"}";
  setResult(out_result, XPOD_RDF_STATUS_OK, result_storage, profile_storage,
            error_storage);
  return XPOD_RDF_STATUS_OK;
}

}  // namespace xpod::qlever
