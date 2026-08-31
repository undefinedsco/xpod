#include "XpodQleverBridge.hpp"
#include "XpodCandidateBridge.hpp"
#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverPermutationMap.hpp"
#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverOperationExecutor.hpp"
#include "XpodQleverOperationIntrospection.hpp"
#include "XpodQleverOperationPlanBridge.hpp"
#include "XpodQleverPlannerContextProvider.hpp"
#include "XpodQleverResultBridge.hpp"
#include "XpodQleverScanBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"
#ifndef XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
#define XPOD_QLEVER_ADAPTER_ENABLE_VECTOR 0
#endif
#if XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
#include "XpodQleverVectorIndexScan.hpp"
#endif

#if !XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#error "XpodQleverBridge.cpp must only be compiled when XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1"
#endif

#include "engine/IndexScan.h"
#if __has_include("engine/ExecuteUpdate.h")
#include "engine/ExecuteUpdate.h"
#define XPOD_QLEVER_HAS_PREPARED_GRAPH_UPDATE 1
#else
#define XPOD_QLEVER_HAS_PREPARED_GRAPH_UPDATE 0
#endif
#include "engine/QueryExecutionContext.h"
#include "engine/QueryPlanner.h"
#include "engine/RuntimeInformation.h"
#if __has_include("util/json.h")
#include "util/json.h"
#define XPOD_QLEVER_HAS_RUNTIME_INFORMATION_JSON 1
#else
#define XPOD_QLEVER_HAS_RUNTIME_INFORMATION_JSON 0
#endif
#if __has_include("global/ValueId.h")
#include "global/ValueId.h"
#define XPOD_QLEVER_HAS_VALUE_ID_DATATYPE 1
#else
#define XPOD_QLEVER_HAS_VALUE_ID_DATATYPE 0
#endif
#if __has_include("util/DateYearDuration.h")
#include "util/DateYearDuration.h"
#define XPOD_QLEVER_HAS_DATE_YEAR_DURATION 1
#else
#define XPOD_QLEVER_HAS_DATE_YEAR_DURATION 0
#endif
#include "index/EncodedIriManager.h"
#include "index/ExportIds.h"
#include "index/Index.h"
#include "libqlever/Qlever.h"
#include "parser/ExternalValuesQuery.h"
#include "parser/SparqlParser.h"
#include "parser/RdfParser.h"
#include "parser/TokenizerCtre.h"
#include "util/CancellationHandle.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <exception>
#include <iomanip>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_set>
#include <variant>
#include <vector>

namespace xpod::qlever {

bool bridgeCompiledWithQlever() noexcept { return true; }

namespace {

constexpr std::string_view kSparqlJsonMediaType =
    "application/sparql-results+json";
constexpr std::string_view kPreparedDeltaMediaType =
    "application/vnd.xpod.rdf-prepared-delta+json;version=1";
constexpr std::string_view kNTriplesMediaType = "application/n-triples";
constexpr std::string_view kTurtleMediaType = "text/turtle";
constexpr std::string_view kQleverDefaultGraphIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph";

void writeJsonString(std::ostringstream& out, std::string_view value);

enum class ExecutionMode {
  NativeQleverTree,
  NativeQleverUpdate,
  NativeQleverPreparedUpdate,
  CompatibilityBoundedPhysical,
  CompatibilityParameterizedJoin,
  CompatibilityOperationPlan,
  CompatibilityParsedBgp,
};

std::string_view executionModeName(ExecutionMode mode) noexcept {
  switch (mode) {
    case ExecutionMode::NativeQleverTree:
      return "native-qlever-tree";
    case ExecutionMode::NativeQleverUpdate:
      return "native-qlever-update";
    case ExecutionMode::NativeQleverPreparedUpdate:
      return "native-qlever-prepared-update";
    case ExecutionMode::CompatibilityBoundedPhysical:
      return "compatibility-bounded-physical";
    case ExecutionMode::CompatibilityParameterizedJoin:
      return "compatibility-parameterized-join";
    case ExecutionMode::CompatibilityParsedBgp:
      return "compatibility-parsed-bgp";
    case ExecutionMode::CompatibilityOperationPlan:
    default:
      return "compatibility-operation-plan";
  }
}

void writeExecutionModeJsonField(
    std::ostringstream& out,
    ExecutionMode mode) {
  out << "\"executionMode\":";
  writeJsonString(out, executionModeName(mode));
}

enum class BridgePlanOrigin {
  OperationPlan,
  ParsedBgp,
};

void setBridgePlanOrigin(
    BridgePlanOrigin* out_origin,
    BridgePlanOrigin origin) noexcept {
  if (out_origin != nullptr) {
    *out_origin = origin;
  }
}

ExecutionMode executionModeForPlanOrigin(BridgePlanOrigin origin) noexcept {
  switch (origin) {
    case BridgePlanOrigin::ParsedBgp:
      return ExecutionMode::CompatibilityParsedBgp;
    case BridgePlanOrigin::OperationPlan:
    default:
      return ExecutionMode::CompatibilityOperationPlan;
  }
}

std::string_view bytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr) {
    return {};
  }
  return {bytes.data, bytes.size};
}

// request-local monotonic diagnostics: disabled requests keep this pointer null,
// so stage helpers avoid steady_clock reads unless diagnostics were requested.
struct QleverDiagnosticsState {
  uint64_t parse_plan_ns = 0;
  uint64_t backend_scan_ns = 0;
  uint64_t id_table_materialization_ns = 0;
  uint64_t algebra_execution_ns = 0;
  uint64_t term_resolution_ns = 0;
  uint64_t serialization_ns = 0;
  uint64_t backend_scan_count = 0;
  uint64_t backend_rows = 0;
  uint64_t backend_bytes = 0;
  ExecutionMode execution_mode = ExecutionMode::CompatibilityOperationPlan;
  std::string filter_fallback_reason;
  std::string filter_fallback_expression;
};

thread_local QleverDiagnosticsState* active_diagnostics = nullptr;
thread_local QleverDiagnosticsState diagnostics_storage;
thread_local ExecutionMode current_execution_mode =
    ExecutionMode::CompatibilityOperationPlan;

ExecutionMode currentExecutionMode() noexcept {
  return current_execution_mode;
}

void syncDiagnosticsExecutionMode() noexcept {
  if (active_diagnostics != nullptr) {
    active_diagnostics->execution_mode = current_execution_mode;
  }
}

uint64_t monotonicNowNs() noexcept {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

uint64_t* diagnosticStageBucket(
    QleverDiagnosticsState& state,
    std::string_view stage) noexcept {
  if (stage == "parse-plan") {
    return &state.parse_plan_ns;
  }
  if (stage == "backend-scan") {
    return &state.backend_scan_ns;
  }
  if (stage == "id-table-materialization") {
    return &state.id_table_materialization_ns;
  }
  if (stage == "algebra-execution") {
    return &state.algebra_execution_ns;
  }
  if (stage == "term-resolution") {
    return &state.term_resolution_ns;
  }
  if (stage == "serialization") {
    return &state.serialization_ns;
  }
  return nullptr;
}

double nsToMs(uint64_t ns) noexcept {
  return static_cast<double>(ns) / 1'000'000.0;
}

void writeStageMsJson(std::ostringstream& out, const QleverDiagnosticsState& state) {
  out << "\"stageMs\":{"
      << "\"parse-plan\":" << nsToMs(state.parse_plan_ns) << ","
      << "\"backend-scan\":" << nsToMs(state.backend_scan_ns) << ","
      << "\"id-table-materialization\":"
      << nsToMs(state.id_table_materialization_ns) << ","
      << "\"algebra-execution\":" << nsToMs(state.algebra_execution_ns) << ","
      << "\"term-resolution\":" << nsToMs(state.term_resolution_ns) << ","
      << "\"serialization\":" << nsToMs(state.serialization_ns)
      << "}";
}

void writeNullableJsonString(std::ostringstream& out, std::string_view value) {
  if (value.empty()) {
    out << "null";
    return;
  }
  writeJsonString(out, value);
}

bool qleverDiagnosticsEnabledImpl() noexcept {
  return active_diagnostics != nullptr;
}

uint64_t qleverDiagnosticsStageStartImpl() noexcept {
  return qleverDiagnosticsEnabledImpl() ? monotonicNowNs() : 0;
}

void qleverDiagnosticsStageFinishImpl(
    const char* stage,
    uint64_t started_at_ns) noexcept {
  if (active_diagnostics == nullptr || started_at_ns == 0 ||
      stage == nullptr) {
    return;
  }
  uint64_t* bucket = diagnosticStageBucket(*active_diagnostics, stage);
  if (bucket == nullptr) {
    return;
  }
  *bucket += monotonicNowNs() - started_at_ns;
}

void recordQleverBackendBytesImpl(uint64_t bytes) noexcept;

void recordQleverBackendScanInvocationImpl() noexcept {
  if (active_diagnostics == nullptr) {
    return;
  }
  ++active_diagnostics->backend_scan_count;
}

void recordQleverBackendScanBatchImpl(
    const xpod_rdf_quad_batch& batch) noexcept {
  if (active_diagnostics == nullptr) {
    return;
  }
  active_diagnostics->backend_rows += batch.scanned_rows == 0
      ? static_cast<uint64_t>(batch.row_count)
      : batch.scanned_rows;
  recordQleverBackendBytesImpl(
      static_cast<uint64_t>(batch.row_count) * sizeof(xpod_rdf_quad_key));
}

void recordQleverBackendBytesImpl(uint64_t bytes) noexcept {
  if (active_diagnostics == nullptr) {
    return;
  }
  active_diagnostics->backend_bytes += bytes;
}

QleverDiagnosticsHooks diagnostics_hooks = {
    qleverDiagnosticsStageStartImpl,
    qleverDiagnosticsStageFinishImpl,
    recordQleverBackendScanBatchImpl,
    recordQleverBackendScanInvocationImpl,
    recordQleverBackendBytesImpl};

void xpodQleverDiagnosticsEnableImpl() noexcept {
  diagnostics_storage = {};
  active_diagnostics = &diagnostics_storage;
  activeQleverDiagnosticsHooks() = &diagnostics_hooks;
  syncDiagnosticsExecutionMode();
}

void xpodQleverDiagnosticsResetRequestStateImpl() noexcept {
  if (active_diagnostics == nullptr) {
    return;
  }
  diagnostics_storage = {};
  active_diagnostics = &diagnostics_storage;
  activeQleverDiagnosticsHooks() = &diagnostics_hooks;
  syncDiagnosticsExecutionMode();
}

void setCurrentExecutionMode(ExecutionMode mode) noexcept {
  current_execution_mode = mode;
  syncDiagnosticsExecutionMode();
}

void xpodQleverDiagnosticsResetImpl() noexcept {
  activeQleverDiagnosticsHooks() = nullptr;
  diagnostics_storage = {};
  active_diagnostics = nullptr;
}

void xpodQleverDiagnosticsDisableImpl() noexcept {
  activeQleverDiagnosticsHooks() = nullptr;
  active_diagnostics = nullptr;
}

void recordQleverPhysicalFilterFallback(
    const std::optional<BridgePhysicalFilterFallback>& fallback) {
  if (active_diagnostics == nullptr || !fallback.has_value()) {
    return;
  }
  if (!active_diagnostics->filter_fallback_reason.empty()) {
    return;
  }
  active_diagnostics->filter_fallback_reason = fallback->reason;
  active_diagnostics->filter_fallback_expression = fallback->expression;
}

std::string xpodQleverDiagnosticsJsonImpl() {
  if (active_diagnostics == nullptr) {
    return {};
  }
  std::ostringstream json;
  json << "{";
  writeExecutionModeJsonField(json, active_diagnostics->execution_mode);
  json << ",";
  writeStageMsJson(json, *active_diagnostics);
  json << ",\"backendScanCount\":"
       << active_diagnostics->backend_scan_count
       << ",\"backendRows\":" << active_diagnostics->backend_rows
       << ",\"backendBytes\":" << active_diagnostics->backend_bytes
       << ",\"filterFallbackReason\":";
  writeNullableJsonString(json, active_diagnostics->filter_fallback_reason);
  json << ",\"filterFallbackExpression\":";
  writeNullableJsonString(json, active_diagnostics->filter_fallback_expression);
  json << "}";
  return json.str();
}

std::string_view trimAsciiWhitespace(std::string_view value) noexcept {
  while (!value.empty() &&
         (value.front() == ' ' || value.front() == '\t')) {
    value.remove_prefix(1);
  }
  while (!value.empty() &&
         (value.back() == ' ' || value.back() == '\t')) {
    value.remove_suffix(1);
  }
  return value;
}

bool isZeroQValue(std::string_view value) noexcept {
  value = trimAsciiWhitespace(value);
  if (value.empty() || value.front() != '0') {
    return false;
  }
  value.remove_prefix(1);
  if (value.empty()) {
    return true;
  }
  if (value.front() != '.') {
    return false;
  }
  value.remove_prefix(1);
  while (!value.empty()) {
    if (value.front() != '0') {
      return false;
    }
    value.remove_prefix(1);
  }
  return true;
}

bool isQParameter(std::string_view name) noexcept {
  name = trimAsciiWhitespace(name);
  return name.size() == 1 && (name.front() == 'q' || name.front() == 'Q');
}

struct ParsedMediaRange {
  std::string_view media_type;
  bool acceptable = true;
};

ParsedMediaRange parseMediaRange(std::string_view value) noexcept {
  ParsedMediaRange range;
  value = trimAsciiWhitespace(value);
  size_t parameter = value.find(';');
  range.media_type = trimAsciiWhitespace(
      parameter == std::string_view::npos ? value : value.substr(0, parameter));
  while (parameter != std::string_view::npos) {
    value.remove_prefix(parameter + 1);
    parameter = value.find(';');
    std::string_view segment = trimAsciiWhitespace(
        parameter == std::string_view::npos ? value : value.substr(0, parameter));
    size_t equals = segment.find('=');
    if (equals == std::string_view::npos) {
      continue;
    }
    if (isQParameter(segment.substr(0, equals)) &&
        isZeroQValue(segment.substr(equals + 1))) {
      range.acceptable = false;
    }
  }
  return range;
}

bool mediaRangeMatches(
    std::string_view media_range,
    std::string_view result_media_type) noexcept {
  const size_t result_parameter = result_media_type.find(';');
  const std::string_view bare_result_media_type = trimAsciiWhitespace(
      result_parameter == std::string_view::npos
          ? result_media_type
          : result_media_type.substr(0, result_parameter));
  if (media_range == "*/*" || media_range == result_media_type ||
      media_range == bare_result_media_type) {
    return true;
  }
  size_t slash = media_range.find('/');
  if (slash == std::string_view::npos ||
      media_range.substr(slash + 1) != "*") {
    return false;
  }
  return bare_result_media_type.substr(0, slash) ==
             media_range.substr(0, slash) &&
         bare_result_media_type.size() > slash &&
         bare_result_media_type[slash] == '/';
}

bool acceptsResultMediaType(
    const xpod_qlever_query_request& request,
    std::string_view result_media_type) noexcept {
  std::string_view accept = bytesView(request.accept_media_type);
  if (accept.empty()) {
    return true;
  }
  while (!accept.empty()) {
    size_t comma = accept.find(',');
    ParsedMediaRange media_range = parseMediaRange(
        comma == std::string_view::npos ? accept : accept.substr(0, comma));
    if (media_range.acceptable &&
        mediaRangeMatches(media_range.media_type, result_media_type)) {
      return true;
    }
    if (comma == std::string_view::npos) {
      break;
    }
    accept.remove_prefix(comma + 1);
  }
  return false;
}

char asciiLower(char c) noexcept {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

std::string_view trimSparqlLeadingTrivia(std::string_view value) noexcept {
  while (true) {
    while (!value.empty() &&
           (value.front() == ' ' || value.front() == '\t' ||
            value.front() == '\n' || value.front() == '\r')) {
      value.remove_prefix(1);
    }
    if (value.empty() || value.front() != '#') {
      return value;
    }
    const size_t line_end = value.find_first_of("\r\n");
    if (line_end == std::string_view::npos) {
      return {};
    }
    value.remove_prefix(line_end);
  }
}

bool startsWithAsciiKeyword(
    std::string_view value,
    std::string_view keyword) noexcept {
  value = trimSparqlLeadingTrivia(value);
  if (value.size() < keyword.size()) {
    return false;
  }
  for (size_t i = 0; i < keyword.size(); ++i) {
    if (asciiLower(value[i]) != asciiLower(keyword[i])) {
      return false;
    }
  }
  if (value.size() == keyword.size()) {
    return true;
  }
  char next = value[keyword.size()];
  return next == ' ' || next == '\t' || next == '\n' || next == '\r';
}

std::string_view consumeSparqlPrologueDeclaration(
    std::string_view value,
    std::string_view keyword) noexcept {
  std::string_view original = value;
  if (!startsWithAsciiKeyword(value, keyword)) {
    return value;
  }
  value = trimSparqlLeadingTrivia(value);
  value.remove_prefix(keyword.size());
  size_t iri_begin = value.find('<');
  if (iri_begin == std::string_view::npos) {
    return original;
  }
  size_t iri_end = value.find('>', iri_begin + 1);
  if (iri_end == std::string_view::npos) {
    return original;
  }
  value.remove_prefix(iri_end + 1);
  return trimSparqlLeadingTrivia(value);
}

std::string_view stripSparqlUpdatePrologue(std::string_view value) noexcept {
  value = trimSparqlLeadingTrivia(value);
  while (true) {
    std::string_view next =
        consumeSparqlPrologueDeclaration(value, "prefix");
    if (next.data() != value.data() || next.size() != value.size()) {
      value = next;
      continue;
    }
    next = consumeSparqlPrologueDeclaration(value, "base");
    if (next.data() != value.data() || next.size() != value.size()) {
      value = next;
      continue;
    }
    return value;
  }
}

bool looksLikeSparqlUpdate(std::string_view value) noexcept {
  value = stripSparqlUpdatePrologue(value);
  return startsWithAsciiKeyword(value, "insert") ||
         startsWithAsciiKeyword(value, "delete") ||
         startsWithAsciiKeyword(value, "clear") ||
         startsWithAsciiKeyword(value, "drop") ||
         startsWithAsciiKeyword(value, "load") ||
         startsWithAsciiKeyword(value, "with") ||
         startsWithAsciiKeyword(value, "create") ||
         startsWithAsciiKeyword(value, "copy") ||
         startsWithAsciiKeyword(value, "move") ||
         startsWithAsciiKeyword(value, "add");
}

bool isUnsupportedPreparedUpdateLifecycle(std::string_view value) noexcept {
  value = stripSparqlUpdatePrologue(value);
  return startsWithAsciiKeyword(value, "load") ||
         startsWithAsciiKeyword(value, "create") ||
         startsWithAsciiKeyword(value, "drop") ||
         startsWithAsciiKeyword(value, "clear") ||
         startsWithAsciiKeyword(value, "copy") ||
         startsWithAsciiKeyword(value, "move") ||
         startsWithAsciiKeyword(value, "add");
}

void setResult(
    xpod_qlever_query_result& out_result,
    xpod_rdf_status status,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage,
    std::string_view result_media_type = kSparqlJsonMediaType) noexcept {
  out_result.status = status;
  out_result.result_json = {result_storage.data(), result_storage.size()};
  out_result.result_media_type =
      {result_media_type.data(), result_media_type.size()};
  out_result.profile_json = {profile_storage.data(), profile_storage.size()};
  out_result.error_message = {error_storage.data(), error_storage.size()};
}

xpod_rdf_status setQueryResult(
    xpod_qlever_query_result& out_result,
    xpod_rdf_status status,
    const xpod_qlever_query_request& request,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage,
    std::string_view result_media_type = kSparqlJsonMediaType) noexcept {
  if (status == XPOD_RDF_STATUS_OK &&
      !acceptsResultMediaType(request, result_media_type)) {
    result_storage.clear();
    profile_storage.clear();
    error_storage = "requested result media type is not acceptable";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage, result_media_type);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  setResult(out_result, status, result_storage, profile_storage, error_storage,
            result_media_type);
  return status;
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

template <typename IdT, typename = void>
struct HasQleverUndefinedValue : std::false_type {};

template <typename IdT>
struct HasQleverUndefinedValue<
    IdT, std::void_t<decltype(IdT::makeUndefined())>>
    : std::true_type {};

template <typename IdT>
bool isQleverUndefinedIdValue(const IdT& id) {
  if constexpr (HasQleverUndefinedValue<IdT>::value) {
    return id.getBits() == IdT::makeUndefined().getBits();
  }
  return false;
}

bool isQleverUndefinedId(const Id& id) {
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  return id.getDatatype() == Datatype::Undefined &&
         isQleverUndefinedIdValue(id);
#else
  return isQleverUndefinedIdValue(id);
#endif
}

struct ResolvedQleverBinding {
  xpod_rdf_term term = {};
  std::string value;
  std::string datatype_iri;
  std::string language;

  void refreshViews() noexcept {
    term.value = {value.data(), value.size()};
    term.datatype_iri = {datatype_iri.data(), datatype_iri.size()};
    term.language = {language.data(), language.size()};
  }

  void setLiteral(std::string literal_value, std::string datatype) {
    term.kind = XPOD_RDF_TERM_LITERAL;
    value = std::move(literal_value);
    datatype_iri = std::move(datatype);
    language.clear();
    refreshViews();
  }

  void setFromTerm(const xpod_rdf_term& resolved) {
    term.kind = resolved.kind;
    value = std::string(bytesView(resolved.value));
    datatype_iri = std::string(bytesView(resolved.datatype_iri));
    language = std::string(bytesView(resolved.language));
    refreshViews();
  }
};

template <typename IdT>
std::optional<ResolvedQleverBinding> inlineQleverBindingFromId(const IdT& id);

struct OwnedMutationTerm {
  xpod_rdf_term term = {};
  std::string value;
  std::string datatype_iri;
  std::string language;

  void refreshViews() noexcept {
    term.value = {value.data(), value.size()};
    term.datatype_iri = {datatype_iri.data(), datatype_iri.size()};
    term.language = {language.data(), language.size()};
  }
};

struct OwnedQuadMutation {
  xpod_rdf_quad_mutation mutation = {};
  OwnedMutationTerm subject;
  OwnedMutationTerm predicate;
  OwnedMutationTerm object;
  OwnedMutationTerm graph;

  void refreshViews() noexcept {
    subject.refreshViews();
    predicate.refreshViews();
    object.refreshViews();
    graph.refreshViews();
    mutation.quad.subject = subject.term;
    mutation.quad.predicate = predicate.term;
    mutation.quad.object = object.term;
    mutation.quad.graph = graph.term;
  }
};

std::string iriBackendValue(const TripleComponent::Iri& iri) {
  std::string value = iri.toStringRepresentation();
  if (value.size() >= 2 && value.front() == '<' && value.back() == '>') {
    value = value.substr(1, value.size() - 2);
  }
  return value;
}

xpod_rdf_status fillMutationTermFromComponent(
    const TripleComponent& component,
    OwnedMutationTerm& out_term,
    std::string& error_storage) {
  if (auto binding = termBindingFromValuesComponent(component);
      binding.has_value()) {
    out_term.term.kind = binding->kind;
    out_term.value = std::move(binding->value);
    out_term.datatype_iri = std::move(binding->datatype_iri);
    out_term.language = std::move(binding->language);
    out_term.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
  if (component.isString()) {
    std::string value = component.getString();
    const bool is_blank_node = value.rfind("_:", 0) == 0;
    out_term.term.kind = is_blank_node ? XPOD_RDF_TERM_BLANK : XPOD_RDF_TERM_IRI;
    out_term.value = is_blank_node ? value.substr(2) : std::move(value);
    out_term.datatype_iri.clear();
    out_term.language.clear();
    out_term.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  if (component.isId() &&
      component.getId().getDatatype() == Datatype::BlankNodeIndex) {
    out_term.term.kind = XPOD_RDF_TERM_BLANK;
    out_term.value =
        "qlever-blank-" +
        std::to_string(component.getId().getBlankNodeIndex().get());
    out_term.datatype_iri.clear();
    out_term.language.clear();
    out_term.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
#endif
  if (const auto* point =
          std::get_if<GeoPoint>(&component.getVariant())) {
    auto [value, datatype] = point->toStringAndType();
    out_term.term.kind = XPOD_RDF_TERM_LITERAL;
    out_term.value = std::move(value);
    out_term.datatype_iri = datatype;
    out_term.language.clear();
    out_term.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
#if XPOD_QLEVER_HAS_DATE_YEAR_DURATION
  if (const auto* date =
          std::get_if<DateYearOrDuration>(&component.getVariant())) {
    auto [value, datatype] = date->toStringAndType();
    out_term.term.kind = XPOD_RDF_TERM_LITERAL;
    out_term.value = std::move(value);
    out_term.datatype_iri = datatype;
    out_term.language.clear();
    out_term.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
#endif
  if (component.isId()) {
    if (auto binding = inlineQleverBindingFromId(component.getId());
        binding.has_value()) {
      out_term.term.kind = binding->term.kind;
      out_term.value = std::move(binding->value);
      out_term.datatype_iri = std::move(binding->datatype_iri);
      out_term.language = std::move(binding->language);
      out_term.refreshViews();
      return XPOD_RDF_STATUS_OK;
    }
  }
  error_storage = "unsupported SPARQL Update term";
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

std::string makeLoadBlankNodeScope() {
  static const uint64_t process_nonce = [] {
    std::random_device random;
    const uint64_t random_bits =
        (static_cast<uint64_t>(random()) << 32U) ^
        static_cast<uint64_t>(random());
    const uint64_t clock_bits = static_cast<uint64_t>(
        std::chrono::high_resolution_clock::now().time_since_epoch().count());
    return random_bits ^ clock_bits;
  }();
  static std::atomic<uint64_t> sequence{0};

  std::ostringstream scope;
  scope << std::hex << process_nonce << '-'
        << sequence.fetch_add(1, std::memory_order_relaxed);
  return scope.str();
}

void scopeLoadBlankNode(
    OwnedMutationTerm& term,
    std::string_view blank_node_scope) {
  if (term.term.kind != XPOD_RDF_TERM_BLANK) {
    return;
  }
  term.value += "-document-";
  term.value.append(blank_node_scope);
  term.refreshViews();
}

xpod_rdf_status fillMutationGraphFromUpdateGraph(
    const SparqlTripleSimpleWithGraph::Graph& graph,
    OwnedQuadMutation& out_mutation,
    std::string& error_storage) {
  if (std::holds_alternative<std::monostate>(graph)) {
    out_mutation.graph.term.kind = XPOD_RDF_TERM_IRI;
    out_mutation.graph.value = std::string(kQleverDefaultGraphIri);
    out_mutation.graph.datatype_iri.clear();
    out_mutation.graph.language.clear();
    out_mutation.mutation.quad.has_graph = 1;
    out_mutation.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
  if (const auto* iri = std::get_if<TripleComponent::Iri>(&graph)) {
    out_mutation.graph.term.kind = XPOD_RDF_TERM_IRI;
    out_mutation.graph.value = iriBackendValue(*iri);
    out_mutation.graph.datatype_iri.clear();
    out_mutation.graph.language.clear();
    out_mutation.mutation.quad.has_graph = 1;
    out_mutation.refreshViews();
    return XPOD_RDF_STATUS_OK;
  }
  error_storage = "unsupported INSERT DATA graph term";
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

std::string_view trimSparqlWhitespace(std::string_view value) noexcept {
  while (!value.empty() &&
         (value.front() == ' ' || value.front() == '\t' ||
          value.front() == '\n' || value.front() == '\r')) {
    value.remove_prefix(1);
  }
  while (!value.empty() &&
         (value.back() == ' ' || value.back() == '\t' ||
          value.back() == '\n' || value.back() == '\r')) {
    value.remove_suffix(1);
  }
  return value;
}

bool consumeSparqlKeyword(
    std::string_view& value,
    std::string_view keyword) noexcept {
  if (!startsWithAsciiKeyword(value, keyword)) {
    return false;
  }
  value = trimSparqlLeadingTrivia(value);
  value.remove_prefix(keyword.size());
  value = trimSparqlLeadingTrivia(value);
  return true;
}

bool parseAngleIri(std::string_view& value, std::string& out_iri) {
  value = trimSparqlLeadingTrivia(value);
  if (value.empty() || value.front() != '<') {
    return false;
  }
  const size_t end = value.find('>', 1);
  if (end == std::string_view::npos) {
    return false;
  }
  out_iri = std::string(value.substr(1, end - 1));
  value.remove_prefix(end + 1);
  value = trimSparqlLeadingTrivia(value);
  return true;
}

struct ParsedSimpleLoadUpdate {
  std::string source_iri;
  std::optional<std::string> target_graph_iri;
  bool silent = false;
};

enum class SimpleGraphManagementTarget {
  Graph,
  Default,
  Named,
  All,
};

struct ParsedSimpleGraphManagementUpdate {
  SimpleGraphManagementTarget target = SimpleGraphManagementTarget::Graph;
  std::string graph_iri;
  bool silent = false;
};

struct ParsedSimpleGraphCreateUpdate {
  std::string graph_iri;
  bool silent = false;
};

enum class SimpleGraphCopyOperation {
  Add,
  Copy,
  Move,
};

struct ParsedSimpleGraphCopyUpdate {
  SimpleGraphCopyOperation operation = SimpleGraphCopyOperation::Add;
  std::string source_graph_iri;
  std::string target_graph_iri;
  bool silent = false;
};

bool parseSimpleLoadUpdate(
    std::string_view update,
    ParsedSimpleLoadUpdate& out_update) {
  std::string_view rest = stripSparqlUpdatePrologue(update);
  if (!consumeSparqlKeyword(rest, "load")) {
    return false;
  }
  out_update.silent = consumeSparqlKeyword(rest, "silent");
  if (!parseAngleIri(rest, out_update.source_iri)) {
    return false;
  }
  if (consumeSparqlKeyword(rest, "into")) {
    if (!consumeSparqlKeyword(rest, "graph")) {
      return false;
    }
    std::string target_graph_iri;
    if (!parseAngleIri(rest, target_graph_iri)) {
      return false;
    }
    out_update.target_graph_iri = std::move(target_graph_iri);
  }
  rest = trimSparqlWhitespace(rest);
  return rest.empty() || rest == ";";
}

std::optional<std::string> sparqlPrefixIri(
    std::string_view update,
    std::string_view wanted_prefix) {
  std::string_view rest = trimSparqlLeadingTrivia(update);
  while (!rest.empty()) {
    std::string_view declaration = rest;
    if (consumeSparqlKeyword(declaration, "prefix")) {
      size_t prefix_length = 0;
      while (prefix_length < declaration.size()) {
        const char c = declaration[prefix_length];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-') {
          ++prefix_length;
          continue;
        }
        break;
      }
      if (prefix_length >= declaration.size() ||
          declaration[prefix_length] != ':') {
        return std::nullopt;
      }
      const std::string_view prefix = declaration.substr(0, prefix_length);
      declaration.remove_prefix(prefix_length + 1);
      std::string iri;
      if (!parseAngleIri(declaration, iri)) {
        return std::nullopt;
      }
      if (prefix == wanted_prefix) {
        return iri;
      }
      rest = declaration;
      continue;
    }
    std::string_view next = consumeSparqlPrologueDeclaration(rest, "base");
    if (next.data() != rest.data() || next.size() != rest.size()) {
      rest = next;
      continue;
    }
    break;
  }
  return std::nullopt;
}

bool parseGraphIri(
    std::string_view update,
    std::string_view& rest,
    std::string& out_iri) {
  if (parseAngleIri(rest, out_iri)) {
    return true;
  }
  rest = trimSparqlLeadingTrivia(rest);
  const size_t colon = rest.find(':');
  if (colon == std::string_view::npos) {
    return false;
  }
  size_t end = colon + 1;
  while (end < rest.size()) {
    const char c = rest[end];
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ';') {
      break;
    }
    ++end;
  }
  const std::string_view prefix = rest.substr(0, colon);
  const std::string_view local = rest.substr(colon + 1, end - colon - 1);
  std::optional<std::string> prefix_iri = sparqlPrefixIri(update, prefix);
  if (!prefix_iri.has_value()) {
    return false;
  }
  out_iri = std::move(*prefix_iri);
  out_iri.append(local);
  rest.remove_prefix(end);
  rest = trimSparqlLeadingTrivia(rest);
  return true;
}

bool parseGraphIriOperand(
    std::string_view update,
    std::string_view& rest,
    std::string& out_iri) {
  if (!consumeSparqlKeyword(rest, "graph")) {
    return false;
  }
  return parseGraphIri(update, rest, out_iri);
}

bool parseSimpleCreateGraphUpdate(
    std::string_view update,
    ParsedSimpleGraphCreateUpdate& out_update) {
  std::string_view rest = stripSparqlUpdatePrologue(update);
  if (!consumeSparqlKeyword(rest, "create")) {
    return false;
  }
  out_update.silent = consumeSparqlKeyword(rest, "silent");
  if (!parseGraphIriOperand(update, rest, out_update.graph_iri)) {
    return false;
  }
  rest = trimSparqlWhitespace(rest);
  return rest.empty() || rest == ";";
}

bool parseSimpleClearOrDropGraphUpdate(
    std::string_view update,
    ParsedSimpleGraphManagementUpdate& out_update) {
  std::string_view rest = stripSparqlUpdatePrologue(update);
  if (!consumeSparqlKeyword(rest, "clear") &&
      !consumeSparqlKeyword(rest, "drop")) {
    return false;
  }
  out_update.silent = consumeSparqlKeyword(rest, "silent");
  if (consumeSparqlKeyword(rest, "graph")) {
    out_update.target = SimpleGraphManagementTarget::Graph;
    if (!parseGraphIri(update, rest, out_update.graph_iri)) {
      return false;
    }
  } else if (consumeSparqlKeyword(rest, "default")) {
    out_update.target = SimpleGraphManagementTarget::Default;
  } else if (consumeSparqlKeyword(rest, "named")) {
    out_update.target = SimpleGraphManagementTarget::Named;
  } else if (consumeSparqlKeyword(rest, "all")) {
    out_update.target = SimpleGraphManagementTarget::All;
  } else {
    return false;
  }
  rest = trimSparqlWhitespace(rest);
  return rest.empty() || rest == ";";
}

bool parseSimpleAddCopyMoveGraphUpdate(
    std::string_view update,
    ParsedSimpleGraphCopyUpdate& out_update) {
  std::string_view rest = stripSparqlUpdatePrologue(update);
  if (consumeSparqlKeyword(rest, "add")) {
    out_update.operation = SimpleGraphCopyOperation::Add;
  } else if (consumeSparqlKeyword(rest, "copy")) {
    out_update.operation = SimpleGraphCopyOperation::Copy;
  } else if (consumeSparqlKeyword(rest, "move")) {
    out_update.operation = SimpleGraphCopyOperation::Move;
  } else {
    return false;
  }
  out_update.silent = consumeSparqlKeyword(rest, "silent");
  if (!parseGraphIriOperand(update, rest, out_update.source_graph_iri)) {
    return false;
  }
  if (!consumeSparqlKeyword(rest, "to")) {
    return false;
  }
  if (!parseGraphIriOperand(update, rest, out_update.target_graph_iri)) {
    return false;
  }
  rest = trimSparqlWhitespace(rest);
  return rest.empty() || rest == ";";
}

bool loadMediaTypeIsNTriples(std::string_view media_type) noexcept {
  media_type = trimAsciiWhitespace(media_type);
  const size_t parameter = media_type.find(';');
  media_type = trimAsciiWhitespace(
      parameter == std::string_view::npos
          ? media_type
          : media_type.substr(0, parameter));
  return media_type == kNTriplesMediaType;
}

bool loadMediaTypeIsTurtle(std::string_view media_type) noexcept {
  media_type = trimAsciiWhitespace(media_type);
  const size_t parameter = media_type.find(';');
  media_type = trimAsciiWhitespace(
      parameter == std::string_view::npos
          ? media_type
          : media_type.substr(0, parameter));
  return media_type == kTurtleMediaType ||
         media_type == "application/turtle";
}

template <typename Parser>
xpod_rdf_status parseQleverRdfLoadDocument(
    std::string_view document,
    const std::optional<std::string>& target_graph_iri,
    std::string_view format_name,
    std::vector<OwnedQuadMutation>& out_mutations,
    std::string& error_storage) {
  try {
    EncodedIriManager encoded_iri_manager;
    RdfStringParser<Parser> parser{&encoded_iri_manager};
    parser.setInputStream(document);
    std::vector<TurtleTriple> triples = parser.parseAndReturnAllTriples();
    const std::string blank_node_scope = makeLoadBlankNodeScope();
    out_mutations.reserve(out_mutations.size() + triples.size());
    for (const TurtleTriple& triple : triples) {
      OwnedQuadMutation owned;
      owned.mutation.kind = XPOD_RDF_MUTATION_INSERT;
      xpod_rdf_status status = fillMutationTermFromComponent(
          triple.subject_, owned.subject, error_storage);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      status = fillMutationTermFromComponent(
          triple.predicate_, owned.predicate, error_storage);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      status = fillMutationTermFromComponent(
          triple.object_, owned.object, error_storage);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      scopeLoadBlankNode(owned.subject, blank_node_scope);
      scopeLoadBlankNode(owned.object, blank_node_scope);
      owned.graph.term.kind = XPOD_RDF_TERM_IRI;
      owned.graph.value = target_graph_iri.has_value()
                              ? *target_graph_iri
                              : std::string(kQleverDefaultGraphIri);
      owned.graph.datatype_iri.clear();
      owned.graph.language.clear();
      owned.mutation.quad.has_graph = 1;
      owned.refreshViews();
      out_mutations.push_back(std::move(owned));
      out_mutations.back().refreshViews();
    }
    return XPOD_RDF_STATUS_OK;
  } catch (const std::exception& error) {
    error_storage = "unsupported SPARQL LOAD ";
    error_storage.append(format_name);
    error_storage.append(" document: ");
    error_storage += error.what();
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
}

xpod_rdf_status parseNTriplesLoadDocument(
    std::string_view document,
    const std::optional<std::string>& target_graph_iri,
    std::vector<OwnedQuadMutation>& out_mutations,
    std::string& error_storage) {
  return parseQleverRdfLoadDocument<NQuadParser<TokenizerCtre>>(
      document, target_graph_iri, "N-Triples", out_mutations,
      error_storage);
}

xpod_rdf_status parseTurtleLoadDocument(
    std::string_view document,
    const std::optional<std::string>& target_graph_iri,
    std::vector<OwnedQuadMutation>& out_mutations,
    std::string& error_storage) {
  return parseQleverRdfLoadDocument<TurtleParser<TokenizerCtre>>(
      document, target_graph_iri, "Turtle", out_mutations, error_storage);
}

bool updateTripleHasVariable(const SparqlTripleSimpleWithGraph& triple) {
  if (triple.s_.isVariable() || triple.p_.isVariable() ||
      triple.o_.isVariable()) {
    return true;
  }
  return std::visit(
      [](const auto& graph) {
        using GraphT = std::decay_t<decltype(graph)>;
        return std::is_same_v<GraphT, Variable>;
      },
      triple.g_);
}

bool updateTriplesHaveVariables(
    const updateClause::UpdateTriples& triples) {
  return std::any_of(
      triples.triples_.begin(), triples.triples_.end(),
      [](const SparqlTripleSimpleWithGraph& triple) {
        return updateTripleHasVariable(triple);
      });
}

template <typename Context, typename = void>
struct HasClearCacheUnpinnedOnly : std::false_type {};

template <typename Context>
struct HasClearCacheUnpinnedOnly<
    Context,
    decltype(void(std::declval<Context&>().clearCacheUnpinnedOnly()))>
    : std::true_type {};

template <typename Context>
void clearPlannerCacheAfterMutation(Context* qec) {
  if (qec == nullptr) {
    return;
  }
  if constexpr (HasClearCacheUnpinnedOnly<Context>::value) {
    qec->clearCacheUnpinnedOnly();
  }
}

[[maybe_unused]] bool graphUpdateHasVariables(
    const updateClause::GraphUpdate& graph_update) {
  return updateTriplesHaveVariables(graph_update.toDelete_) ||
         updateTriplesHaveVariables(graph_update.toInsert_);
}

[[maybe_unused]] bool updateHasWherePattern(const ParsedQuery& parsed_update) {
  return !parsed_update._rootGraphPattern._graphPatterns.empty() ||
         !parsed_update._rootGraphPattern._filters.empty();
}

std::optional<std::string> updateGraphVariableName(
    const SparqlTripleSimpleWithGraph::Graph& graph) {
  std::optional<std::string> name;
  std::visit(
      [&name](const auto& graph_value) {
        using GraphT = std::decay_t<decltype(graph_value)>;
        if constexpr (std::is_same_v<GraphT, Variable>) {
          name = bridgeVariableName(graph_value);
        }
      },
      graph);
  return name;
}

#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
std::string stripQleverTermAngles(std::string value) {
  if (value.size() >= 2 && value.front() == '<' && value.back() == '>') {
    return value.substr(1, value.size() - 2);
  }
  return value;
}

std::optional<ResolvedQleverBinding> localVocabBindingFromId(
    const Id& id,
    const LocalVocab* local_vocab) {
  if (local_vocab == nullptr) {
    return std::nullopt;
  }
  if (id.getDatatype() == Datatype::BlankNodeIndex) {
    BlankNodeIndex index = id.getBlankNodeIndex();
    if (!local_vocab->isBlankNodeIndexContained(index)) {
      return std::nullopt;
    }
    ResolvedQleverBinding binding;
    binding.term.kind = XPOD_RDF_TERM_BLANK;
    binding.value = "qlever-local-" + std::to_string(index.get());
    binding.refreshViews();
    return binding;
  }
  if (id.getDatatype() != Datatype::LocalVocabIndex) {
    return std::nullopt;
  }
  const auto& word = local_vocab->getWord(id.getLocalVocabIndex());
  ResolvedQleverBinding binding;
  if (word.isIri()) {
    binding.term.kind = XPOD_RDF_TERM_IRI;
    binding.value = std::string(word.getIriContent());
  } else if (word.isLiteral()) {
    binding.term.kind = XPOD_RDF_TERM_LITERAL;
    binding.value = std::string(word.getLiteralContent());
    if (word.hasLanguageTag()) {
      binding.language = std::string(word.getLanguageTag());
    } else if (word.hasDatatype()) {
      binding.datatype_iri =
          stripQleverTermAngles(std::string(word.getDatatype()));
    }
  } else {
    return std::nullopt;
  }
  binding.refreshViews();
  return binding;
}
#else
std::optional<ResolvedQleverBinding> localVocabBindingFromId(
    const Id&,
    const LocalVocab*) {
  return std::nullopt;
}
#endif

template <typename IdT, typename = void>
struct HasQleverIntValue : std::false_type {};

template <typename IdT>
struct HasQleverIntValue<
    IdT,
    std::void_t<decltype(IdT::makeFromInt(std::declval<const IdT&>().getInt()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverDoubleValue : std::false_type {};

template <typename IdT>
struct HasQleverDoubleValue<
    IdT,
    std::void_t<decltype(IdT::makeFromDouble(
        std::declval<const IdT&>().getDouble()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverBoolValue : std::false_type {};

template <typename IdT>
struct HasQleverBoolValue<
    IdT,
    std::void_t<decltype(IdT::makeFromBool(std::declval<const IdT&>().getBool())),
                decltype(std::declval<const IdT&>().getBoolLiteral())>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverZeroOneBoolValue : std::false_type {};

template <typename IdT>
struct HasQleverZeroOneBoolValue<
    IdT,
    std::void_t<decltype(IdT::makeBoolFromZeroOrOne(
        std::declval<const IdT&>().getBool()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverDateValue : std::false_type {};

template <typename IdT>
struct HasQleverDateValue<
    IdT,
    std::void_t<decltype(std::declval<const IdT&>().getDate().toStringAndType())>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverGeoPointValue : std::false_type {};

template <typename IdT>
struct HasQleverGeoPointValue<
    IdT,
    std::void_t<decltype(
        std::declval<const IdT&>().getGeoPoint().toStringAndType())>>
    : std::true_type {};

template <typename IdT>
std::optional<ResolvedQleverBinding> inlineQleverBindingFromId(const IdT& id) {
  const auto exportedBinding = [&]() -> std::optional<ResolvedQleverBinding> {
    const auto valueAndType =
        ql::exportIds::idToStringAndTypeForEncodedValue(id);
    if (!valueAndType.has_value() || valueAndType->second == nullptr) {
      return std::nullopt;
    }
    ResolvedQleverBinding binding;
    binding.setLiteral(valueAndType->first, valueAndType->second);
    return binding;
  };
  if constexpr (HasQleverIntValue<IdT>::value) {
    int64_t value = id.getInt();
    if (IdT::makeFromInt(value).getBits() == id.getBits()) {
      return exportedBinding();
    }
  }
  if constexpr (HasQleverDoubleValue<IdT>::value) {
    double value = id.getDouble();
    if (IdT::makeFromDouble(value).getBits() == id.getBits()) {
      return exportedBinding();
    }
  }
  if constexpr (HasQleverBoolValue<IdT>::value) {
    bool value = id.getBool();
    bool is_bool = IdT::makeFromBool(value).getBits() == id.getBits();
    if constexpr (HasQleverZeroOneBoolValue<IdT>::value) {
      is_bool = is_bool ||
                IdT::makeBoolFromZeroOrOne(value).getBits() == id.getBits();
    }
    if (is_bool) {
      return exportedBinding();
    }
  }
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  if constexpr (HasQleverDateValue<IdT>::value) {
    if (id.getDatatype() == Datatype::Date) {
      return exportedBinding();
    }
  }
  if constexpr (HasQleverGeoPointValue<IdT>::value) {
    if (id.getDatatype() == Datatype::GeoPoint) {
      return exportedBinding();
    }
  }
#endif
  return std::nullopt;
}

std::optional<xpod_rdf_retrieval_point_key> retrievalPointFromId(
    const Id& id) {
  static_cast<void>(id);
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  if (id.getDatatype() == Datatype::TextRecordIndex) {
    return id.getTextRecordIndex().get();
  }
#endif
  return std::nullopt;
}

std::optional<xpod_rdf_text_term_key> textTermFromId(const Id& id) {
  static_cast<void>(id);
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  if (id.getDatatype() == Datatype::WordVocabIndex) {
    return id.getWordVocabIndex().get();
  }
#endif
  return std::nullopt;
}

xpod_rdf_status resolveIdTableTerms(
    xpod::rdf::PhysicalBackend backend,
    const IdTable& table,
    const xpod_rdf_snapshot& snapshot,
    std::vector<ResolvedQleverBinding>& out_terms,
    std::string& error_storage,
    const LocalVocab* local_vocab = nullptr) {
  out_terms.clear();
  std::vector<xpod_rdf_term_key> keys;
  keys.reserve(table.numRows() * table.numColumns());
  std::vector<size_t> key_positions;
  key_positions.reserve(keys.capacity());
  std::vector<xpod_rdf_retrieval_point_key> retrieval_points;
  std::vector<size_t> retrieval_positions;
  std::vector<xpod_rdf_text_term_key> text_terms;
  std::vector<size_t> text_term_positions;
  for (size_t row = 0; row < table.numRows(); ++row) {
    for (size_t column = 0; column < table.numColumns(); ++column) {
      const Id& id = table(row, column);
      if (isQleverUndefinedId(id)) {
        continue;
      }
      if (auto text_term = textTermFromId(id); text_term.has_value()) {
        text_term_positions.push_back(out_terms.size());
        out_terms.push_back({});
        text_terms.push_back(*text_term);
        continue;
      }
      if (std::optional<ResolvedQleverBinding> inline_binding =
              inlineQleverBindingFromId(id);
          inline_binding.has_value()) {
        out_terms.push_back(std::move(*inline_binding));
        continue;
      }
      if (std::optional<ResolvedQleverBinding> local_vocab_binding =
              localVocabBindingFromId(id, local_vocab);
          local_vocab_binding.has_value()) {
        out_terms.push_back(std::move(*local_vocab_binding));
        continue;
      }
      if (auto retrieval_point = retrievalPointFromId(id);
          retrieval_point.has_value()) {
        retrieval_positions.push_back(out_terms.size());
        out_terms.push_back({});
        retrieval_points.push_back(*retrieval_point);
        continue;
      }
      xpod_rdf_term_key key = 0;
      xpod_rdf_status status = backend.decodeQleverId(id.getBits(), key);
      if (status != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to decode QLever result id";
        return status;
      }
      key_positions.push_back(out_terms.size());
      out_terms.push_back({});
      keys.push_back(key);
    }
  }

  if (!text_terms.empty()) {
    std::vector<xpod_rdf_bytes> terms(text_terms.size());
    std::vector<xpod_rdf_status> statuses(text_terms.size());
    xpod_rdf_status status = backend.resolveTextTerms(
        text_terms.data(), text_terms.size(), snapshot, terms.data(),
        statuses.data());
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to resolve QLever matched text-term ids";
      return status;
    }
    for (size_t index = 0; index < statuses.size(); ++index) {
      if (statuses[index] != XPOD_RDF_STATUS_OK) {
        error_storage =
            "failed to resolve one or more QLever matched text-term ids";
        return statuses[index];
      }
      ResolvedQleverBinding& binding =
          out_terms[text_term_positions[index]];
      binding.setLiteral(
          std::string(
              terms[index].data == nullptr ? "" : terms[index].data,
              terms[index].size),
          "");
    }
  }

  if (!retrieval_points.empty()) {
    std::vector<xpod_rdf_bytes> contents(retrieval_points.size());
    std::vector<xpod_rdf_status> statuses(retrieval_points.size());
    xpod_rdf_status status = backend.resolveRetrievalPoints(
        retrieval_points.data(), retrieval_points.size(), snapshot,
        contents.data(), statuses.data());
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to resolve QLever text record ids";
      return status;
    }
    for (size_t index = 0; index < statuses.size(); ++index) {
      if (statuses[index] != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to resolve one or more QLever text record ids";
        return statuses[index];
      }
      ResolvedQleverBinding& binding = out_terms[retrieval_positions[index]];
      binding.setLiteral(
          std::string(
              contents[index].data == nullptr ? "" : contents[index].data,
              contents[index].size),
          "");
    }
  }

  if (keys.empty()) {
    for (ResolvedQleverBinding& term : out_terms) {
      term.refreshViews();
    }
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<xpod_rdf_status> statuses(keys.size());
  std::vector<xpod_rdf_term> resolved_terms(keys.size());
  xpod_rdf_status status = backend.resolveTerms(
      keys.data(), keys.size(), snapshot, resolved_terms.data(),
      statuses.data());
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve QLever result terms";
    return status;
  }
  for (size_t index = 0; index < statuses.size(); ++index) {
    xpod_rdf_status term_status = statuses[index];
    if (term_status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to resolve one or more QLever result terms";
      return term_status;
    }
    out_terms[key_positions[index]].setFromTerm(resolved_terms[index]);
  }
  for (ResolvedQleverBinding& term : out_terms) {
    term.refreshViews();
  }
  return XPOD_RDF_STATUS_OK;
}

void copyResolvedBindingToMutationTerm(
    const ResolvedQleverBinding& binding,
    OwnedMutationTerm& out_term) {
  out_term.term.kind = binding.term.kind;
  out_term.value = binding.value;
  out_term.datatype_iri = binding.datatype_iri;
  out_term.language = binding.language;
  out_term.refreshViews();
}

enum class UpdateTemplateBindingKind {
  Constant,
  StrVariable,
};

struct UpdateTemplateBinding {
  std::string variable;
  UpdateTemplateBindingKind kind = UpdateTemplateBindingKind::Constant;
  ResolvedQleverBinding binding;
  std::string source_variable;
};

const UpdateTemplateBinding* updateTemplateBindingForVariable(
    const std::vector<UpdateTemplateBinding>& bindings,
    std::string_view variable) {
  for (const UpdateTemplateBinding& binding : bindings) {
    if (binding.variable == variable) {
      return &binding;
    }
  }
  return nullptr;
}

xpod_rdf_status fillMutationTermFromQleverId(
    xpod::rdf::PhysicalBackend backend,
    const Id& id,
    const xpod_rdf_snapshot& snapshot,
    OwnedMutationTerm& out_term,
    bool& has_value,
    std::string& error_storage,
    const LocalVocab* local_vocab = nullptr) {
  has_value = false;
  if (isQleverUndefinedId(id)) {
    return XPOD_RDF_STATUS_OK;
  }
  if (std::optional<ResolvedQleverBinding> inline_binding =
          inlineQleverBindingFromId(id);
      inline_binding.has_value()) {
    copyResolvedBindingToMutationTerm(*inline_binding, out_term);
    has_value = true;
    return XPOD_RDF_STATUS_OK;
  }
  if (std::optional<ResolvedQleverBinding> local_vocab_binding =
          localVocabBindingFromId(id, local_vocab);
      local_vocab_binding.has_value()) {
    copyResolvedBindingToMutationTerm(*local_vocab_binding, out_term);
    has_value = true;
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_term_key key = 0;
  xpod_rdf_status status = backend.decodeQleverId(id.getBits(), key);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to decode QLever update template id";
    return status;
  }

  xpod_rdf_term resolved_term = {};
  xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
  status = backend.resolveTerms(
      &key, 1, snapshot, &resolved_term, &term_status);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve QLever update template term";
    return status;
  }
  if (term_status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve one QLever update template term";
    return term_status;
  }

  ResolvedQleverBinding binding;
  binding.setFromTerm(resolved_term);
  copyResolvedBindingToMutationTerm(binding, out_term);
  has_value = true;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status fillBoundMutationTermFromTemplateBinding(
    xpod::rdf::PhysicalBackend backend,
    const UpdateTemplateBinding& binding,
    const BridgeQueryPlan& plan,
    const IdTable& table,
    size_t row,
    const xpod_rdf_snapshot& snapshot,
    OwnedMutationTerm& out_term,
    bool& has_value,
    std::string& error_storage,
    const LocalVocab* local_vocab = nullptr) {
  if (binding.kind == UpdateTemplateBindingKind::Constant) {
    copyResolvedBindingToMutationTerm(binding.binding, out_term);
    has_value = true;
    return XPOD_RDF_STATUS_OK;
  }

  if (binding.kind == UpdateTemplateBindingKind::StrVariable) {
    std::optional<ColumnIndex> source_column = outputColumnForVariable(
        plan.output_variables, binding.source_variable);
    if (!source_column.has_value() || *source_column >= table.numColumns()) {
      error_storage = "SPARQL Update STR() source variable is not bound by WHERE";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }

    OwnedMutationTerm source_term;
    bool has_source = false;
    xpod_rdf_status status = fillMutationTermFromQleverId(
        backend, table(row, *source_column), snapshot, source_term,
        has_source, error_storage, local_vocab);
    if (status != XPOD_RDF_STATUS_OK || !has_source) {
      has_value = false;
      return status;
    }

    ResolvedQleverBinding result;
    result.setLiteral(source_term.value, "");
    copyResolvedBindingToMutationTerm(result, out_term);
    has_value = true;
    return XPOD_RDF_STATUS_OK;
  }

  error_storage = "unsupported SPARQL Update template binding";
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

xpod_rdf_status fillBoundMutationTermFromComponent(
    xpod::rdf::PhysicalBackend backend,
    const TripleComponent& component,
    const BridgeQueryPlan& plan,
    const IdTable& table,
    const std::vector<UpdateTemplateBinding>& template_bindings,
    size_t row,
    const xpod_rdf_snapshot& snapshot,
    OwnedMutationTerm& out_term,
    bool& has_value,
    std::string& error_storage,
    const LocalVocab* local_vocab = nullptr) {
  if (!component.isVariable()) {
    has_value = true;
    xpod_rdf_status status =
        fillMutationTermFromComponent(component, out_term, error_storage);
    if (status == XPOD_RDF_STATUS_OK &&
        out_term.term.kind == XPOD_RDF_TERM_BLANK) {
      out_term.value += "-solution-" + std::to_string(row);
      out_term.refreshViews();
    }
    return status;
  }

  std::string variable = bridgeComponentVariableName(component);
  if (const UpdateTemplateBinding* template_binding =
          updateTemplateBindingForVariable(template_bindings, variable);
      template_binding != nullptr) {
    return fillBoundMutationTermFromTemplateBinding(
        backend, *template_binding, plan, table, row, snapshot, out_term,
        has_value, error_storage, local_vocab);
  }

  std::optional<ColumnIndex> column = outputColumnForVariable(
      plan.output_variables, variable);
  if (!column.has_value() || *column >= table.numColumns()) {
    error_storage = "SPARQL Update template variable is not bound by WHERE";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  return fillMutationTermFromQleverId(
      backend, table(row, *column), snapshot, out_term, has_value,
      error_storage, local_vocab);
}

xpod_rdf_status fillBoundMutationGraphFromUpdateGraph(
    xpod::rdf::PhysicalBackend backend,
    const SparqlTripleSimpleWithGraph::Graph& graph,
    const BridgeQueryPlan& plan,
    const IdTable& table,
    const std::vector<UpdateTemplateBinding>& template_bindings,
    size_t row,
    const xpod_rdf_snapshot& snapshot,
    OwnedQuadMutation& out_mutation,
    bool& has_value,
    std::string& error_storage,
    const LocalVocab* local_vocab = nullptr) {
  if (std::holds_alternative<std::monostate>(graph) ||
      std::holds_alternative<TripleComponent::Iri>(graph)) {
    has_value = true;
    return fillMutationGraphFromUpdateGraph(
        graph, out_mutation, error_storage);
  }

  std::optional<std::string> variable = updateGraphVariableName(graph);
  if (!variable.has_value()) {
    error_storage = "unsupported SPARQL Update graph term";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (const UpdateTemplateBinding* template_binding =
          updateTemplateBindingForVariable(template_bindings, *variable);
      template_binding != nullptr) {
    xpod_rdf_status status = fillBoundMutationTermFromTemplateBinding(
        backend, *template_binding, plan, table, row, snapshot,
        out_mutation.graph, has_value, error_storage, local_vocab);
    if (status != XPOD_RDF_STATUS_OK || !has_value) {
      return status;
    }
  } else {
  std::optional<ColumnIndex> column = outputColumnForVariable(
      plan.output_variables, *variable);
  if (!column.has_value() || *column >= table.numColumns()) {
    error_storage = "SPARQL Update graph variable is not bound by WHERE";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_status status = fillMutationTermFromQleverId(
      backend, table(row, *column), snapshot, out_mutation.graph, has_value,
      error_storage, local_vocab);
  if (status != XPOD_RDF_STATUS_OK || !has_value) {
    return status;
  }
  }
  if (out_mutation.graph.term.kind != XPOD_RDF_TERM_IRI) {
    error_storage = "SPARQL Update graph variable did not resolve to an IRI";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  out_mutation.mutation.quad.has_graph = 1;
  out_mutation.refreshViews();
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

enum class ConstructComponentRole {
  Subject,
  Predicate,
  Object,
};

void writeNTriplesEscapedString(std::ostringstream& out,
                                std::string_view value) {
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
}

bool writeNTriplesTerm(
    std::ostringstream& out,
    const xpod_rdf_term& term,
    ConstructComponentRole role) {
  if (term.kind == XPOD_RDF_TERM_IRI) {
    out << '<' << bytesView(term.value) << '>';
    return true;
  }
  if (term.kind == XPOD_RDF_TERM_BLANK &&
      role != ConstructComponentRole::Predicate) {
    std::string_view value = bytesView(term.value);
    if (value.rfind("_:", 0) == 0) {
      out << value;
    } else {
      out << "_:" << value;
    }
    return true;
  }
  if (term.kind == XPOD_RDF_TERM_LITERAL &&
      role == ConstructComponentRole::Object) {
    out << '"';
    writeNTriplesEscapedString(out, bytesView(term.value));
    out << '"';
    if (term.language.size != 0) {
      out << '@' << bytesView(term.language);
    } else if (term.datatype_iri.size != 0) {
      out << "^^<" << bytesView(term.datatype_iri) << '>';
    }
    return true;
  }
  return false;
}

template <typename GraphTermT, typename = void>
struct HasConstructTripleComponent : std::false_type {};

template <typename GraphTermT>
struct HasConstructTripleComponent<
    GraphTermT,
    std::void_t<decltype(std::declval<const GraphTermT&>().toTripleComponent())>>
    : std::true_type {};

template <typename GraphTermT>
std::optional<std::string> constructVariableName(const GraphTermT& term) {
  if constexpr (HasConstructTripleComponent<GraphTermT>::value) {
    TripleComponent component = term.toTripleComponent();
    if (component.isVariable()) {
      return bridgeComponentVariableName(component);
    }
  }
  return std::nullopt;
}

template <typename GraphTermT>
bool writeConstructConstant(
    std::ostringstream& out,
    const GraphTermT& term,
    ConstructComponentRole role) {
  std::string sparql = term.toSparql();
  if (role == ConstructComponentRole::Predicate) {
    if (sparql.empty() || sparql.front() != '<') {
      return false;
    }
  } else if (role == ConstructComponentRole::Subject) {
    if (sparql.rfind("_:", 0) != 0 &&
        (sparql.empty() || sparql.front() != '<')) {
      return false;
    }
  }
  out << sparql;
  return true;
}

template <typename GraphTermT>
bool writeConstructComponent(
    std::ostringstream& out,
    const GraphTermT& term,
    ConstructComponentRole role,
    const BridgeQueryPlan& plan,
    const std::vector<const xpod_rdf_term*>& resolved_cells,
    size_t row,
    size_t width) {
  std::string sparql = term.toSparql();
  if (sparql.rfind("_:", 0) == 0) {
    if (role == ConstructComponentRole::Predicate) {
      return false;
    }
    out << sparql << '_' << row;
    return true;
  }

  std::optional<std::string> variable = constructVariableName(term);
  if (!variable.has_value()) {
    return writeConstructConstant(out, term, role);
  }
  std::optional<ColumnIndex> column =
      outputColumnForVariable(plan.output_variables, *variable);
  if (!column.has_value() || *column >= width) {
    return false;
  }
  const xpod_rdf_term* resolved =
      resolved_cells[(row * width) + static_cast<size_t>(*column)];
  if (resolved == nullptr) {
    return false;
  }
  return writeNTriplesTerm(out, *resolved, role);
}

std::optional<size_t> writeConstructNTriples(
    std::ostringstream& out,
    const ParsedQuery& parsed,
    const BridgeQueryPlan& plan,
    const IdTable& table,
    const std::vector<ResolvedQleverBinding>& terms) {
  const size_t width = table.numColumns();
  if (plan.output_variables.size() != width) {
    return std::nullopt;
  }

  std::vector<const xpod_rdf_term*> resolved_cells(
      table.numRows() * width, nullptr);
  size_t term_index = 0;
  for (size_t row = 0; row < table.numRows(); ++row) {
    for (size_t column = 0; column < width; ++column) {
      if (isQleverUndefinedId(table(row, column))) {
        continue;
      }
      if (term_index >= terms.size()) {
        return std::nullopt;
      }
      resolved_cells[(row * width) + column] = &terms[term_index++].term;
    }
  }
  if (term_index != terms.size()) {
    return std::nullopt;
  }

  size_t triple_count = 0;
  std::unordered_set<std::string> emitted_triples;
  for (size_t row = 0; row < table.numRows(); ++row) {
    for (const auto& triple : parsed.constructClause().triples_) {
      std::ostringstream line;
      if (!writeConstructComponent(
              line, triple[0], ConstructComponentRole::Subject, plan,
              resolved_cells, row, width)) {
        continue;
      }
      line << ' ';
      if (!writeConstructComponent(
              line, triple[1], ConstructComponentRole::Predicate, plan,
              resolved_cells, row, width)) {
        continue;
      }
      line << ' ';
      if (!writeConstructComponent(
              line, triple[2], ConstructComponentRole::Object, plan,
              resolved_cells, row, width)) {
        continue;
      }
      std::string serialized = line.str() + " .\n";
      if (!emitted_triples.insert(serialized).second) {
        continue;
      }
      out << serialized;
      ++triple_count;
    }
  }
  return triple_count;
}

void writeSparqlHead(std::ostringstream& out,
                     const std::vector<std::string>& variables) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"head\":{\"vars\":[";
  for (size_t i = 0; i < variables.size(); ++i) {
    if (i != 0) {
      out << ',';
    }
    writeJsonString(out, variables[i]);
  }
  out << "]},\"results\":{\"bindings\":";
}

void writeEmptySparqlJson(
    std::ostringstream& out,
    const std::vector<std::string>& variables) {
  writeSparqlHead(out, variables);
  out << "[]}}";
}

void writeAskSparqlJson(std::ostringstream& out, bool result) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"head\":{},\"boolean\":"
      << (result ? "true" : "false") << '}';
}

void writeSparqlJson(
    std::ostringstream& out,
    const IdTable& table,
    const std::vector<ResolvedQleverBinding>& terms,
    const std::vector<std::string>& variables) {
  writeSparqlHead(out, variables);
  out << '[';
  size_t term_index = 0;
  for (size_t row = 0; row < table.numRows(); ++row) {
    if (row != 0) {
      out << ',';
    }
    out << '{';
    bool first_binding = true;
    for (size_t column = 0; column < table.numColumns(); ++column) {
      if (isQleverUndefinedId(table(row, column))) {
        continue;
      }
      if (!first_binding) {
        out << ',';
      }
      first_binding = false;
      out << '"' << variables[column] << "\":";
      writeTermBinding(out, terms[term_index++].term);
    }
    out << '}';
  }
  out << "]}}";
}

void writeScanProfileJson(
    std::ostringstream& out,
    std::string_view kind,
    std::string_view descriptor,
    uint64_t output_rows,
    std::string_view cache_status = {},
    std::string_view runtime_information = {},
    std::string_view details_json = {},
    std::optional<ExecutionMode> mode = std::nullopt) {
  const ExecutionMode resolved_mode = mode.value_or(currentExecutionMode());
  out << "{\"engine\":\"xpod-qlever-bridge\",";
  writeExecutionModeJsonField(out, resolved_mode);
  out << ",\"root\":{\"kind\":";
  writeJsonString(out, kind);
  out << ",\"descriptor\":";
  writeJsonString(out, descriptor);
  out << ",\"outputRows\":" << output_rows;
  if (!details_json.empty()) {
    out << ",\"details\":" << details_json;
  }
  if (!cache_status.empty()) {
    out << ",\"cacheStatus\":";
    writeJsonString(out, cache_status);
  }
  out << '}';
  if (!runtime_information.empty()) {
    out << ",\"runtimeInformation\":" << runtime_information;
  }
  out << '}';
}

void writeAskProfileJson(
    std::ostringstream& out,
    const BridgeQueryPlan& plan,
    uint64_t output_rows,
    std::string_view cache_status = {},
    std::string_view runtime_information = {},
    std::optional<ExecutionMode> mode = std::nullopt) {
  const ExecutionMode resolved_mode = mode.value_or(currentExecutionMode());
  out << "{\"engine\":\"xpod-qlever-bridge\",";
  writeExecutionModeJsonField(out, resolved_mode);
  out << ",\"root\":{\"kind\":\"Ask\",";
  out << "\"descriptor\":\"Ask\",\"outputRows\":" << output_rows;
  out << ",\"children\":[{\"kind\":";
  writeJsonString(out, profileKind(plan.root.kind));
  out << ",\"descriptor\":";
  writeJsonString(out, plan.descriptor);
  out << ",\"outputRows\":" << output_rows;
  if (!cache_status.empty()) {
    out << ",\"cacheStatus\":";
    writeJsonString(out, cache_status);
  }
  out << "}]}";
  if (!runtime_information.empty()) {
    out << ",\"runtimeInformation\":" << runtime_information;
  }
  out << '}';
}

template <typename Status>
auto cacheStatusString(const Status& status, int)
    -> decltype(toString(status), std::string{}) {
  return std::string(toString(status));
}

template <typename Status>
std::string cacheStatusString(const Status&, long) {
  return {};
}

template <typename Tree>
auto treeHandlesNoLimitOffset(const Tree& tree, int)
    -> decltype(tree.handlesLimitOffset(), bool{}) {
  using LimitOffsetHandling = decltype(tree.handlesLimitOffset());
  return tree.handlesLimitOffset() == LimitOffsetHandling::NONE;
}

template <typename Tree>
bool treeHandlesNoLimitOffset(const Tree&, long) {
  return true;
}

template <typename Operation>
auto operationCacheStatus(const std::shared_ptr<Operation>& operation, int)
    -> decltype(operation->getRuntimeInfoPointer()->cacheStatus_,
                std::string{}) {
  if (operation == nullptr) {
    return {};
  }
  auto runtime_info = operation->getRuntimeInfoPointer();
  return runtime_info == nullptr
      ? std::string{}
      : cacheStatusString(runtime_info->cacheStatus_, 0);
}

template <typename Operation>
std::string operationCacheStatus(const std::shared_ptr<Operation>&, long) {
  return {};
}

#if XPOD_QLEVER_HAS_RUNTIME_INFORMATION_JSON
template <typename Operation>
auto operationRuntimeInformationJson(
    const std::shared_ptr<Operation>& operation,
    int) -> decltype(operation->getRuntimeInfoPointer(), std::string{}) {
  if (operation == nullptr) {
    return {};
  }
  auto runtime_information = operation->getRuntimeInfoPointer();
  if (runtime_information == nullptr) {
    return {};
  }
  nlohmann::ordered_json runtime_information_json = *runtime_information;
  return runtime_information_json.dump();
}

template <typename Operation>
std::string operationRuntimeInformationJson(
    const std::shared_ptr<Operation>&,
    long) {
  return {};
}
#else
template <typename Operation>
std::string operationRuntimeInformationJson(
    const std::shared_ptr<Operation>&,
    int) {
  return {};
}
#endif

const std::vector<BridgeCandidateOutputColumn>* candidateOutputColumnsForRoot(
    const BridgePhysicalPlan& plan) noexcept {
  if (plan.root.kind != BridgeOperationKind::TextSearch ||
      plan.root.candidate_index >= plan.text_sources.size()) {
    return nullptr;
  }
  return &plan.text_sources[plan.root.candidate_index].output_columns;
}

xpod_rdf_status candidateRowsToIdTable(
    xpod::rdf::PhysicalBackend backend,
    const xpod::rdf::CandidateBuffer& candidates,
    const std::vector<BridgeCandidateOutputColumn>& columns,
    LocalVocab& local_vocab,
    IdTable& out_table) {
  std::vector<Id> row;
  row.reserve(columns.size());
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    row.clear();
    xpod_rdf_status status = appendCandidateProjection(
        backend, candidate, columns, local_vocab, row);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    out_table.push_back(row);
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status writeCandidateSparqlJson(
    xpod::rdf::PhysicalBackend backend,
    const BridgeQueryPlan& plan,
    const BridgePhysicalPlan& physical_plan,
    const BridgePhysicalResult& physical_result,
    const xpod_rdf_snapshot& snapshot,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage,
    ExecutionMode mode) {
  if (physical_result.kind != BridgePhysicalResultKind::CandidateRows ||
      !physical_result.candidates.has_value()) {
    error_storage =
        "QLever bridge candidate root did not produce candidate rows";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const std::vector<BridgeCandidateOutputColumn>* columns =
      candidateOutputColumnsForRoot(physical_plan);
  if (columns == nullptr) {
    error_storage = "unsupported QLever bridge candidate root";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (plan.output_variables.size() != columns->size()) {
    error_storage =
        "QLever bridge candidate columns do not match output variables";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  IdTable output_table = makeQleverIdTable(columns->size());
  LocalVocab local_vocab;
  xpod_rdf_status status = candidateRowsToIdTable(
      backend, physical_result.candidates->candidates, *columns,
      local_vocab, output_table);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to project QLever bridge candidate rows";
    return status;
  }

  std::vector<ResolvedQleverBinding> terms;
  status = resolveIdTableTerms(
      backend, output_table, snapshot, terms, error_storage, &local_vocab);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }

  std::ostringstream json;
  writeSparqlJson(json, output_table, terms, plan.output_variables);
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(
      profile, profileKind(plan.root.kind), plan.descriptor,
      output_table.numRows(), "computed", {}, {}, mode);
  profile_storage = profile.str();
  return XPOD_RDF_STATUS_OK;
}

template <typename TableT>
[[maybe_unused]] void appendIdTableRows(IdTable& target, const TableT& source) {
  std::vector<Id> row;
  row.reserve(source.numColumns());
  for (size_t row_index = 0; row_index < source.numRows(); ++row_index) {
    row.clear();
    for (size_t column = 0; column < source.numColumns(); ++column) {
      row.push_back(source(row_index, column));
    }
    target.push_back(row);
  }
}

template <typename VocabT>
auto mergeQleverLocalVocabOwnershipImpl(
    VocabT& target,
    const VocabT& source,
    int) -> decltype(target.mergeWith(source), void()) {
  target.mergeWith(source);
}

template <typename VocabT>
void mergeQleverLocalVocabOwnershipImpl(
    VocabT& target,
    const VocabT& source,
    long) {
  (void)target;
  (void)source;
}

[[maybe_unused]] void mergeQleverLocalVocabOwnership(
    LocalVocab& target,
    const LocalVocab& source) {
  mergeQleverLocalVocabOwnershipImpl(target, source, 0);
}

[[maybe_unused]] Id remapQleverLocalVocabId(
    const Id& id,
    const LocalVocab& source_vocab,
    LocalVocab& target_vocab) {
#if XPOD_QLEVER_HAS_VALUE_ID_DATATYPE
  if (id.getDatatype() == Datatype::LocalVocabIndex) {
    const auto& word = source_vocab.getWord(id.getLocalVocabIndex());
    return Id::makeFromLocalVocabIndex(
        target_vocab.getIndexAndAddIfNotContained(word));
  }
#else
  (void)source_vocab;
  (void)target_vocab;
#endif
  return id;
}

template <typename TableT>
[[maybe_unused]] void appendIdTableRowsWithLocalVocab(
    IdTable& target,
    const TableT& source,
    const LocalVocab& source_vocab,
    LocalVocab& target_vocab) {
  std::vector<Id> row;
  row.reserve(source.numColumns());
  for (size_t row_index = 0; row_index < source.numRows(); ++row_index) {
    row.clear();
    for (size_t column = 0; column < source.numColumns(); ++column) {
      row.push_back(remapQleverLocalVocabId(
          source(row_index, column), source_vocab, target_vocab));
    }
    target.push_back(row);
  }
  mergeQleverLocalVocabOwnership(target_vocab, source_vocab);
}

template <typename ResultT, typename = void>
struct HasIsFullyMaterialized : std::false_type {};

template <typename ResultT>
struct HasIsFullyMaterialized<
    ResultT,
    decltype(void(std::declval<const ResultT&>().isFullyMaterialized()))>
    : std::true_type {};

template <typename ResultT, typename = void>
struct HasLazyIdTables : std::false_type {};

template <typename ResultT>
struct HasLazyIdTables<
    ResultT,
    decltype(void(std::declval<const ResultT&>().idTables()))>
    : std::true_type {};

template <typename ResultT>
IdTable materializeQleverResultTable(
    const ResultT& result,
    size_t fallback_result_width,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  std::optional<IdTable> table;
  auto outputTable = [&table, &allocator](size_t width) -> IdTable& {
    if (!table.has_value()) {
      table = makeQleverIdTable(width, allocator);
    }
    return *table;
  };

  if constexpr (HasIsFullyMaterialized<ResultT>::value) {
    if (result.isFullyMaterialized()) {
      ScopedQleverDiagnosticsStage materialization_stage(
          "id-table-materialization");
      appendIdTableRows(outputTable(qleverResultTable(result).numColumns()),
                        qleverResultTable(result));
      return std::move(*table);
    }
  }
  if constexpr (HasLazyIdTables<ResultT>::value) {
    auto chunks = result.idTables();
    while (auto chunk = chunks.get()) {
      ScopedQleverDiagnosticsStage materialization_stage(
          "id-table-materialization");
      appendIdTableRows(outputTable(chunk->idTable_.numColumns()),
                        chunk->idTable_);
    }
    return table.has_value() ? std::move(*table)
                             : makeQleverIdTable(
                                   fallback_result_width, allocator);
  }
  ScopedQleverDiagnosticsStage materialization_stage(
      "id-table-materialization");
  appendIdTableRows(outputTable(qleverResultTable(result).numColumns()),
                    qleverResultTable(result));
  return std::move(*table);
}

template <typename ResultT>
IdTable materializeQleverResultTable(
    const ResultT& result,
    size_t fallback_result_width) {
  auto allocator = ad_utility::makeUnlimitedAllocator<Id>();
  return materializeQleverResultTable(
      result, fallback_result_width, allocator);
}

[[maybe_unused]] std::optional<IdTable> projectMaterializedTable(
    const IdTable& input,
    const std::vector<ColumnIndex>& columns) {
  for (ColumnIndex column : columns) {
    if (column >= input.numColumns()) {
      return std::nullopt;
    }
  }
  IdTable output = makeQleverIdTable(columns.size());
  std::vector<Id> row;
  row.reserve(columns.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    row.clear();
    for (ColumnIndex column : columns) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return output;
}

template <typename Tree, typename = void>
struct HasLazyTreeResult : std::false_type {};

template <typename Tree>
struct HasLazyTreeResult<
    Tree,
    decltype(void(std::declval<const Tree&>().getResult(true)))>
    : std::true_type {};

template <typename ResultT, typename = void>
struct HasCopyOfLocalVocab : std::false_type {};

template <typename ResultT>
struct HasCopyOfLocalVocab<
    ResultT,
    decltype(void(std::declval<const ResultT&>().getCopyOfLocalVocab()))>
    : std::true_type {};

template <typename ResultT, typename = void>
struct HasLocalVocabMethod : std::false_type {};

template <typename ResultT>
struct HasLocalVocabMethod<
    ResultT,
    decltype(void(std::declval<const ResultT&>().localVocab()))>
    : std::true_type {};

[[maybe_unused]] inline LocalVocab cloneQleverLocalVocab(const LocalVocab& local_vocab) {
  return local_vocab.clone();
}

template <typename ResultT>
LocalVocab copyQleverResultLocalVocab(const ResultT& result) {
  if constexpr (HasCopyOfLocalVocab<ResultT>::value &&
                HasIsFullyMaterialized<ResultT>::value) {
    if (result.isFullyMaterialized()) {
      return result.getCopyOfLocalVocab();
    }
  }
  if constexpr (HasLocalVocabMethod<ResultT>::value &&
                HasIsFullyMaterialized<ResultT>::value) {
    if (result.isFullyMaterialized()) {
      return cloneQleverLocalVocab(result.localVocab());
    }
  }
  return LocalVocab{};
}

struct MaterializedQleverResult {
  IdTable table;
  LocalVocab local_vocab;
};

template <typename ResultT>
MaterializedQleverResult materializeQleverResult(
    const ResultT& result,
    size_t fallback_result_width,
    const ad_utility::AllocatorWithLimit<Id>& allocator,
    LocalVocab local_vocab) {
  std::optional<IdTable> table;
  auto outputTable = [&table, &allocator](size_t width) -> IdTable& {
    if (!table.has_value()) {
      table = makeQleverIdTable(width, allocator);
    }
    return *table;
  };

  if constexpr (HasIsFullyMaterialized<ResultT>::value) {
    if (result.isFullyMaterialized()) {
      ScopedQleverDiagnosticsStage materialization_stage(
          "id-table-materialization");
      appendIdTableRows(outputTable(qleverResultTable(result).numColumns()),
                        qleverResultTable(result));
      return {std::move(*table), std::move(local_vocab)};
    }
  }
  if constexpr (HasLazyIdTables<ResultT>::value) {
    auto chunks = result.idTables();
    while (auto chunk = chunks.get()) {
      ScopedQleverDiagnosticsStage materialization_stage(
          "id-table-materialization");
      appendIdTableRowsWithLocalVocab(
          outputTable(chunk->idTable_.numColumns()), chunk->idTable_,
          chunk->localVocab_, local_vocab);
    }
    return {
        table.has_value() ? std::move(*table)
                          : makeQleverIdTable(fallback_result_width, allocator),
        std::move(local_vocab)};
  }
  ScopedQleverDiagnosticsStage materialization_stage(
      "id-table-materialization");
  appendIdTableRows(outputTable(qleverResultTable(result).numColumns()),
                    qleverResultTable(result));
  return {std::move(*table), std::move(local_vocab)};
}

template <typename ResultT>
MaterializedQleverResult materializeQleverResult(
    const ResultT& result,
    size_t fallback_result_width,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  return materializeQleverResult(
      result, fallback_result_width, allocator,
      copyQleverResultLocalVocab(result));
}

template <typename ResultT>
MaterializedQleverResult materializeQleverResultPreservingLocalVocab(
    const ResultT& result,
    size_t fallback_result_width,
    const ad_utility::AllocatorWithLimit<Id>& allocator,
    const LocalVocab& local_vocab) {
  return materializeQleverResult(
      result, fallback_result_width, allocator,
      cloneQleverLocalVocab(local_vocab));
}

template <typename ResultT>
MaterializedQleverResult materializeQleverResult(
    const ResultT& result,
    size_t fallback_result_width) {
  auto allocator = ad_utility::makeUnlimitedAllocator<Id>();
  return materializeQleverResult(result, fallback_result_width, allocator);
}

struct NativeQleverExecution {
  BridgeQueryPlan plan;
  IdTable table;
  LocalVocab local_vocab;
  std::string cache_status;
  std::string runtime_information;

  NativeQleverExecution(
      BridgeQueryPlan plan,
      IdTable table,
      LocalVocab local_vocab,
      std::string cache_status,
      std::string runtime_information)
      : plan(std::move(plan)),
        table(std::move(table)),
        local_vocab(std::move(local_vocab)),
        cache_status(std::move(cache_status)),
        runtime_information(std::move(runtime_information)) {}
};

template <typename ParsedQueryT, typename = void>
struct HasParsedOrderBy : std::false_type {};

template <typename ParsedQueryT>
struct HasParsedOrderBy<
    ParsedQueryT,
    std::void_t<decltype(std::declval<const ParsedQueryT&>()._orderBy)>>
    : std::true_type {};

template <typename SelectClauseT, typename = void>
struct HasSelectDistinct : std::false_type {};

template <typename SelectClauseT>
struct HasSelectDistinct<
    SelectClauseT,
    std::void_t<decltype(std::declval<const SelectClauseT&>().distinct_)>>
    : std::true_type {};

template <typename ParsedQueryT, typename = void>
struct HasParsedLimitOffset : std::false_type {};

template <typename ParsedQueryT>
struct HasParsedLimitOffset<
    ParsedQueryT,
    std::void_t<decltype(
        std::declval<const ParsedQueryT&>()._limitOffset.isUnconstrained())>>
    : std::true_type {};

template <typename ParsedQueryT>
inline bool appendParsedOrderByModifier(
    BridgeQueryPlan& plan,
    const ParsedQueryT& parsed) {
  if constexpr (HasParsedOrderBy<ParsedQueryT>::value) {
    if (parsed._orderBy.empty()) {
      return true;
    }
    BridgeResultModifier modifier;
    modifier.kind = BridgeResultModifierKind::OrderBy;
    modifier.columns.reserve(parsed._orderBy.size());
    modifier.descending.reserve(parsed._orderBy.size());
    for (const auto& order_key : parsed._orderBy) {
      std::optional<ColumnIndex> column = outputColumnForVariable(
          plan.output_variables, bridgeVariableName(order_key.variable_));
      if (!column.has_value()) {
        return false;
      }
      modifier.columns.push_back(*column);
      modifier.descending.push_back(order_key.isDescending_);
    }
    for (const BridgeResultModifier& existing : plan.root.result_modifiers) {
      if (existing.kind != BridgeResultModifierKind::OrderBy) {
        continue;
      }
      return existing.columns == modifier.columns &&
          existing.descending == modifier.descending;
    }
    plan.root.result_modifiers.push_back(std::move(modifier));
    if (plan.descriptor.find("OrderBy") == std::string::npos) {
      plan.descriptor += " + OrderBy";
    }
  }
  return true;
}

template <typename ParsedQueryT>
inline void appendParsedDistinctModifier(
    BridgeQueryPlan& plan,
    const ParsedQueryT& parsed,
    const std::optional<BridgeResultModifier>& selected_projection) {
  const auto& select = parsed.selectClause();
  using SelectClauseT = std::remove_cv_t<std::remove_reference_t<decltype(select)>>;
  if constexpr (HasSelectDistinct<SelectClauseT>::value) {
    if (!select.distinct_) {
      return;
    }
    BridgeResultModifier modifier;
    modifier.kind = BridgeResultModifierKind::Distinct;
    if (selected_projection.has_value()) {
      modifier.columns = selected_projection->columns;
    } else {
      modifier.columns.reserve(plan.output_variables.size());
      for (ColumnIndex column = 0; column < plan.output_variables.size();
           ++column) {
        modifier.columns.push_back(column);
      }
    }
    plan.root.result_modifiers.push_back(std::move(modifier));
    if (plan.descriptor.find("Distinct") == std::string::npos) {
      plan.descriptor += " + Distinct";
    }
  }
}

template <typename ParsedQueryT>
inline void appendParsedLimitOffsetModifier(
    BridgeQueryPlan& plan,
    const ParsedQueryT& parsed) {
  if constexpr (HasParsedLimitOffset<ParsedQueryT>::value) {
    if (parsed._limitOffset.isUnconstrained()) {
      return;
    }
    BridgeResultModifier modifier;
    modifier.kind = BridgeResultModifierKind::LimitOffset;
    modifier.limit = static_cast<size_t>(parsed._limitOffset.limitOrDefault());
    modifier.offset = static_cast<size_t>(parsed._limitOffset._offset);
    plan.root.result_modifiers.push_back(std::move(modifier));
    if (plan.descriptor.find("LimitOffset") == std::string::npos) {
      plan.descriptor += " + LimitOffset";
    }
  }
}

template <typename ParsedQueryT>
inline bool appendParsedPublicModifiers(
    BridgeQueryPlan& plan,
    const ParsedQueryT& parsed,
    std::optional<BridgeResultModifier>& selected_projection) {
  if (!appendParsedOrderByModifier(plan, parsed)) {
    return false;
  }
  appendParsedDistinctModifier(plan, parsed, selected_projection);
  appendParsedLimitOffsetModifier(plan, parsed);

  if (selected_projection.has_value()) {
    plan.root.result_modifiers.push_back(std::move(*selected_projection));
    selected_projection = std::nullopt;
  }
  return true;
}

inline bool hasProjectModifier(
    const std::vector<BridgeResultModifier>& modifiers) noexcept {
  return std::any_of(
      modifiers.begin(), modifiers.end(),
      [](const BridgeResultModifier& modifier) {
        return modifier.kind == BridgeResultModifierKind::Project;
      });
}

inline bool appendVisibleOutputProjection(
    BridgeQueryPlan& plan,
    size_t qlever_result_width) {
  if (plan.output_variables.size() > qlever_result_width) {
    return false;
  }
  plan.result_width = plan.output_variables.size();
  if (plan.output_variables.size() == qlever_result_width ||
      hasProjectModifier(plan.root.result_modifiers)) {
    return true;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::Project;
  modifier.columns.reserve(plan.output_variables.size());
  for (ColumnIndex column = 0; column < plan.output_variables.size();
       ++column) {
    modifier.columns.push_back(column);
  }
  plan.root.result_modifiers.push_back(std::move(modifier));
  return true;
}

[[maybe_unused]] inline bool isBridgeTermFilterModifier(
    const BridgeResultModifier& modifier) {
  return modifier.kind == BridgeResultModifierKind::EqualTerm ||
         modifier.kind == BridgeResultModifierKind::NotEqualTerm ||
         modifier.kind == BridgeResultModifierKind::InTerm ||
         modifier.kind == BridgeResultModifierKind::NotInTerm ||
         modifier.kind == BridgeResultModifierKind::GreaterThanTerm ||
         modifier.kind == BridgeResultModifierKind::GreaterThanOrEqualTerm ||
         modifier.kind == BridgeResultModifierKind::LessThanTerm ||
         modifier.kind == BridgeResultModifierKind::LessThanOrEqualTerm ||
         modifier.kind == BridgeResultModifierKind::AlwaysFalse ||
         modifier.kind == BridgeResultModifierKind::AnyOf ||
         modifier.kind == BridgeResultModifierKind::AllOf ||
         modifier.kind == BridgeResultModifierKind::Not ||
         modifier.kind == BridgeResultModifierKind::Exists ||
         modifier.kind == BridgeResultModifierKind::LanguageEqual ||
         modifier.kind == BridgeResultModifierKind::DatatypeEqual;
}

[[maybe_unused]] inline void removeBridgeTermFilterModifiers(
    BridgeOperationPlan& root) {
  root.result_modifiers.erase(
      std::remove_if(root.result_modifiers.begin(), root.result_modifiers.end(),
                     isBridgeTermFilterModifier),
      root.result_modifiers.end());
  for (BridgeOperationPlan& child : root.children) {
    removeBridgeTermFilterModifiers(child);
  }
}

inline void clearBridgeResultModifiers(BridgeOperationPlan& root) {
  root.result_modifiers.clear();
  for (BridgeOperationPlan& child : root.children) {
    clearBridgeResultModifiers(child);
  }
}

#if XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
bool hasReservedVectorSource(const ParsedQuery& query);
bool hasReservedVectorSource(const parsedQuery::GraphPattern& graph_pattern);

bool hasReservedVectorSource(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::visit(
      [](const auto& child) -> bool {
        using Child = std::decay_t<decltype(child)>;
        if constexpr (std::is_same_v<
                          Child, parsedQuery::ExternalValuesQuery>) {
          if (child.name_ == XpodQleverVectorIndexScan::kExternalValuesName) {
            return true;
          }
        }
        if constexpr (
            std::is_same_v<Child, parsedQuery::Optional> ||
            std::is_same_v<Child, parsedQuery::Minus> ||
            std::is_same_v<Child, parsedQuery::GroupGraphPattern>) {
          return hasReservedVectorSource(child._child);
        } else if constexpr (std::is_same_v<Child, parsedQuery::Union>) {
          return hasReservedVectorSource(child._child1) ||
                 hasReservedVectorSource(child._child2);
        } else if constexpr (std::is_same_v<Child, parsedQuery::Subquery>) {
          return hasReservedVectorSource(child.get());
        } else if constexpr (std::is_same_v<Child, parsedQuery::TransPath>) {
          return hasReservedVectorSource(child._childGraphPattern);
        } else if constexpr (std::is_same_v<Child, parsedQuery::Describe>) {
          return hasReservedVectorSource(child.whereClause_.get());
        } else if constexpr (std::is_base_of_v<
                                 parsedQuery::MagicServiceQuery, Child>) {
          return child.childGraphPattern_.has_value() &&
                 hasReservedVectorSource(*child.childGraphPattern_);
        } else {
          return false;
        }
      },
      static_cast<const parsedQuery::GraphPatternOperationVariant&>(
          operation));
}

bool hasReservedVectorSource(
    const parsedQuery::GraphPattern& graph_pattern) {
  return std::any_of(
      graph_pattern._graphPatterns.begin(),
      graph_pattern._graphPatterns.end(),
      [](const parsedQuery::GraphPatternOperation& operation) {
        return hasReservedVectorSource(operation);
      });
}

bool hasReservedVectorSource(const ParsedQuery& query) {
  return hasReservedVectorSource(query._rootGraphPattern);
}

xpod_rdf_status appendVectorQuerySource(
    const xpod_qlever_query_request& request,
    ParsedQuery& parsed,
    std::string& error_storage) {
  if (request.vector_query == nullptr) {
    return XPOD_RDF_STATUS_OK;
  }
  if (!parsed.hasSelectClause() && !parsed.hasAskClause()) {
    error_storage = "Xpod vector query binding requires SELECT or ASK";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (hasReservedVectorSource(parsed)) {
    error_storage =
        "SPARQL query already contains reserved ExternalValues marker "
        "XpodVectorQuery";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const xpod_qlever_vector_query& query = *request.vector_query;
  if (query.vector == nullptr || query.dimensions == 0 || query.limit == 0) {
    error_storage = "invalid Xpod vector query binding";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::vector<Variable> variables;
  auto append_output = [&](xpod_rdf_bytes variable) -> bool {
    std::string name = std::string(bytesView(variable));
    if (name.empty() || (name.front() != '?' && name.front() != '$')) {
      return false;
    }
    if (name.front() == '$') {
      name.front() = '?';
    }
    if (std::any_of(
            variables.begin(), variables.end(),
            [&name](const Variable& existing) {
              return existing.name() == name;
            })) {
      return false;
    }
    variables.emplace_back(std::move(name));
    return true;
  };
  bool appended_output = false;
  if (!bytesView(query.retrieval_point_variable).empty()) {
    if (!append_output(query.retrieval_point_variable)) {
      error_storage =
          "Xpod vector query output variables must be present and distinct";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    appended_output = true;
  }
  if (!bytesView(query.resource_variable).empty()) {
    if (!append_output(query.resource_variable)) {
      error_storage =
          "Xpod vector query output variables must be present and distinct";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    appended_output = true;
  }
  if (!appended_output) {
    error_storage =
        "Xpod vector query requires at least one output variable";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  parsedQuery::ExternalValuesQuery values_source;
  values_source.name_ =
      std::string(XpodQleverVectorIndexScan::kExternalValuesName);
  values_source.variables_ = std::move(variables);
  parsed._rootGraphPattern._graphPatterns.emplace_back(
      std::move(values_source));
  return XPOD_RDF_STATUS_OK;
}
#else
xpod_rdf_status appendVectorQuerySource(
    const xpod_qlever_query_request& request,
    ParsedQuery&,
    std::string& error_storage) {
  if (request.vector_query == nullptr) {
    return XPOD_RDF_STATUS_OK;
  }
  error_storage = "Xpod QLever vector operation is not enabled";
  return XPOD_RDF_STATUS_UNSUPPORTED;
}
#endif

xpod_rdf_status planBridgeParsedQuery(
    ParsedQuery& parsed,
    PlannerContextHandle planner_context,
    std::string& error_storage,
    BridgeQueryPlan& out_plan,
    bool prefer_direct_parsed_plan = false,
    BridgePlanOrigin* out_origin = nullptr) {
  std::optional<BridgeQueryPlan> plan;
  std::string planner_error;
  if (prefer_direct_parsed_plan) {
    plan = parsed.hasAskClause()
        ? planParsedAskQuery(parsed)
        : planParsedQuery(parsed);
    if (plan.has_value()) {
      setBridgePlanOrigin(out_origin, BridgePlanOrigin::ParsedBgp);
    }
  }
  if (!plan.has_value()) {
    try {
      plan = planQleverParsedQueryWithAvailablePlanner(planner_context, parsed);
      if (plan.has_value()) {
        setBridgePlanOrigin(out_origin, BridgePlanOrigin::OperationPlan);
      }
    } catch (const std::exception& error) {
      planner_error = error.what();
    } catch (...) {
      planner_error = "unknown planner error";
    }
  }
  if (!plan.has_value()) {
    if (parsed.hasAskClause()) {
      plan = planParsedAskQuery(parsed);
    } else {
      plan = planParsedQuery(parsed);
    }
    if (plan.has_value()) {
      setBridgePlanOrigin(out_origin, BridgePlanOrigin::ParsedBgp);
    }
  }
  if (!plan.has_value()) {
    error_storage = "unsupported QLever bridge query";
    if (!planner_error.empty()) {
      error_storage += "; QLever planner fallback failed earlier: ";
      error_storage += planner_error;
    }
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  std::optional<BridgeResultModifier> selected_projection;
  if (!parsed.hasAskClause() &&
      !appendParsedPublicModifiers(*plan, parsed, selected_projection)) {
    error_storage = "unsupported QLever public query modifiers";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  out_plan = *plan;
  return XPOD_RDF_STATUS_OK;
}


template <typename Planner>
struct HasMutableTreeRoot {
 private:
  template <typename Tree>
  static auto test(int) -> decltype(
      std::declval<Tree&>().isRoot() = true, std::true_type{});

  template <typename>
  static std::false_type test(...);

 public:
  static constexpr bool value = decltype(test<Planner>(0))::value;
};

template <typename Tree>
void markQleverTreeRoot(Tree& tree) {
  if constexpr (HasMutableTreeRoot<Tree>::value) {
    tree.isRoot() = true;
  }
}

template <typename Planner>
std::optional<NativeQleverExecution> executeQleverPlannerTree(
    const xpod::rdf::PhysicalBackend& backend,
    Planner& planner,
    ParsedQuery& parsed,
    const ad_utility::AllocatorWithLimit<Id>* allocator = nullptr) {
  const bool trace_native = std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr;
  if (trace_native) {
    std::fprintf(stderr, "xpod native planner: create tree\n");
  }
  using Tree = decltype(planner.createExecutionTree(parsed));
  Tree tree = [&]() {
    ScopedQleverDiagnosticsStage parse_plan_stage("parse-plan");
    return planner.createExecutionTree(parsed);
  }();
  if (tree.isEmpty()) {
    return std::nullopt;
  }
  markQleverTreeRoot(tree);
  if (trace_native) {
    std::fprintf(stderr, "xpod native planner: plan tree\n");
  }
  std::optional<BridgeQueryPlan> plan;
  {
    ScopedQleverDiagnosticsStage parse_plan_stage("parse-plan");
    plan = planQleverExecutionTree(tree);
    if (!plan.has_value()) {
      plan = planNativeQleverResultTree(tree);
      if (!plan.has_value()) {
        if (trace_native) {
          auto operation = tree.getRootOperation();
          std::fprintf(
              stderr, "xpod native planner: unsupported result shape=%s\n",
              operation == nullptr ? "<null>" : operation->getDescriptor().c_str());
        }
        return std::nullopt;
      }
    }
  }
  if (!plan->vector_sources.empty()) {
    if (trace_native) {
      std::fprintf(stderr, "xpod native planner: vector source is bridge-only\n");
    }
    return std::nullopt;
  }
  if (!plan->text_sources.empty() &&
      validateBackendFeatureCapability(
          backend, XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH) !=
          XPOD_RDF_STATUS_OK) {
    if (trace_native) {
      std::fprintf(stderr, "xpod native planner: TEXT_SEARCH unavailable\n");
    }
    return std::nullopt;
  }
  if (trace_native) {
    std::fprintf(
        stderr, "xpod native planner: plan ok width=%zu vars=%zu modifiers=%zu\n",
        plan->result_width, plan->output_variables.size(),
        plan->root.result_modifiers.size());
  }
  size_t qlever_result_width = plan->result_width;
  clearBridgeResultModifiers(plan->root);
  std::optional<BridgeResultModifier> selected_projection;
  std::optional<std::vector<std::string>> selected;
  if (parsed.hasSelectClause()) {
    selected = selectedVariablesFromParsedQuery(parsed);
  }
  if (selected.has_value()) {
    BridgeResultModifier projection;
    projection.kind = BridgeResultModifierKind::Project;
    projection.columns.reserve(selected->size());
    for (const std::string& variable : *selected) {
      std::optional<ColumnIndex> column =
          outputColumnForVariable(plan->output_variables, variable);
      if (!column.has_value()) {
        if (trace_native) {
          std::fprintf(
              stderr,
              "xpod native planner: selected variable missing=%s available=",
              variable.c_str());
          for (const std::string& available : plan->output_variables) {
            std::fprintf(stderr, "%s ", available.c_str());
          }
          std::fprintf(stderr, "\n");
        }
        return std::nullopt;
      }
      projection.columns.push_back(*column);
    }
    bool identity_projection =
        projection.columns.size() == plan->output_variables.size();
    if (identity_projection) {
      for (size_t column = 0; column < projection.columns.size(); ++column) {
        if (projection.columns[column] != column) {
          identity_projection = false;
          break;
        }
      }
    }
    if (!identity_projection) {
      selected_projection = std::move(projection);
    }
  }
  if (selected_projection.has_value()) {
    plan->root.result_modifiers.push_back(std::move(*selected_projection));
  }
  if (treeHandlesNoLimitOffset(tree, 0)) {
    appendParsedLimitOffsetModifier(*plan, parsed);
  }
  if (!appendVisibleOutputProjection(*plan, qlever_result_width)) {
    return std::nullopt;
  }
  if (selected.has_value()) {
    plan->output_variables = *selected;
    plan->result_width = plan->output_variables.size();
  }
  if constexpr (!HasLazyTreeResult<Tree>::value) {
    return std::nullopt;
  } else {
    if (trace_native) {
      std::fprintf(stderr, "xpod native planner: get result\n");
    }
    decltype(tree.getResult(true)) result;
    {
      ScopedQleverDiagnosticsStage algebra_stage("algebra-execution");
      result = tree.getResult(true);
    }
    if (result == nullptr) {
      return std::nullopt;
    }
    auto root_operation = tree.getRootOperation();
    if (trace_native) {
      std::fprintf(stderr, "xpod native planner: copy vocab/materialize\n");
    }
    auto unlimited_allocator = ad_utility::makeUnlimitedAllocator<Id>();
    const auto& result_allocator = allocator == nullptr
        ? unlimited_allocator
        : *allocator;
    MaterializedQleverResult materialized = materializeQleverResult(
        *result, qlever_result_width, result_allocator);
    IdTable table = std::move(materialized.table);
    LocalVocab local_vocab = std::move(materialized.local_vocab);
    if (!plan->root.result_modifiers.empty()) {
      if (trace_native) {
        std::fprintf(stderr, "xpod native planner: apply modifiers\n");
      }
      QleverResultWithStatus modified = [&]() {
        ScopedQleverDiagnosticsStage algebra_stage("algebra-execution");
        return applyBridgeResultModifiers(
            backend, plan->root,
            toQleverResult({XPOD_RDF_STATUS_OK, std::move(table)},
                           plan->sorted_by,
                           cloneQleverLocalVocab(local_vocab)),
            &local_vocab);
      }();
      if (modified.status != XPOD_RDF_STATUS_OK) {
        return std::nullopt;
      }
      MaterializedQleverResult modified_materialized =
          materializeQleverResultPreservingLocalVocab(
              modified.result, qleverResultTable(modified.result).numColumns(),
              result_allocator, local_vocab);
      table = std::move(modified_materialized.table);
      local_vocab = std::move(modified_materialized.local_vocab);
    }
    std::string cache_status = operationCacheStatus(root_operation, 0);
    std::string runtime_information =
        operationRuntimeInformationJson(root_operation, 0);
    return NativeQleverExecution{
        std::move(*plan), std::move(table), std::move(local_vocab),
        std::move(cache_status), std::move(runtime_information)};
  }
}

template <typename Context>
auto queryExecutionAllocator(Context* context, int)
    -> decltype(&context->getAllocator()) {
  return context == nullptr ? nullptr : &context->getAllocator();
}

template <typename Context>
const ad_utility::AllocatorWithLimit<Id>* queryExecutionAllocator(
    Context*, long) {
  return nullptr;
}

#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
template <typename Planner, bool IsNativeContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    const PlannerRequestContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct NativeContextQleverExecution {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    (void)backend;
    (void)context;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct NativeContextQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    if (context == nullptr) {
      return std::nullopt;
    }
    Planner planner(
        context, detail::makeQleverCancellationHandle(context->cancellation));
    return executeQleverPlannerTree(
        backend, planner, parsed, queryExecutionAllocator(context->qec, 0));
  }
};

template <typename Planner, bool IsContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    QueryExecutionContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct ContextQleverExecution {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    (void)backend;
    (void)qec;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct ContextQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    if (qec == nullptr) {
      return std::nullopt;
    }
    Planner planner(qec, detail::makeQleverCancellationHandle(nullptr));
    return executeQleverPlannerTree(
        backend, planner, parsed, queryExecutionAllocator(qec, 0));
  }
};
#endif

template <typename Planner, bool IsDefaultConstructible =
                                std::is_default_constructible<Planner>::value>
struct DefaultQleverExecution {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      ParsedQuery& parsed) {
    (void)backend;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct DefaultQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(
      const xpod::rdf::PhysicalBackend& backend,
      ParsedQuery& parsed) {
    Planner planner;
    return executeQleverPlannerTree(backend, planner, parsed);
  }
};

std::optional<NativeQleverExecution> executeQleverParsedQueryWithNativeTree(
    const xpod::rdf::PhysicalBackend& backend,
    PlannerContextHandle context,
    ParsedQuery& parsed) {
  if (!parsed.hasSelectClause() && !parsed.hasAskClause() &&
      !parsed.hasConstructClause() && !parsed.hasUpdateClause()) {
    return std::nullopt;
  }
  (void)context;
#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
  if (context.native != nullptr) {
    auto native_result =
        NativeContextQleverExecution<QueryPlanner>::execute(
            backend, context.native, parsed);
    if (native_result.has_value()) {
      return native_result;
    }
  }
  if (context.qec != nullptr) {
    auto qec_result =
        ContextQleverExecution<QueryPlanner>::execute(
            backend, context.qec, parsed);
    if (qec_result.has_value()) {
      return qec_result;
    }
  }
#endif
  return DefaultQleverExecution<QueryPlanner>::execute(backend, parsed);
}

xpod_rdf_status writeNativeQleverExecutionResult(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    ParsedQuery& parsed,
    NativeQleverExecution& native_execution,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  setCurrentExecutionMode(ExecutionMode::NativeQleverTree);
  applyBridgeRequestContext(
      native_execution.plan, request.snapshot, request.cancellation,
      request.graph_scope, request.source_scope, request.access_scope);
  const IdTable& output_table = native_execution.table;
  if (parsed.hasAskClause()) {
    {
      ScopedQleverDiagnosticsStage serialization_stage("serialization");
      std::ostringstream json;
      writeAskSparqlJson(json, output_table.numRows() != 0);
      result_storage = json.str();
      std::ostringstream profile;
      writeAskProfileJson(
          profile, native_execution.plan, output_table.numRows(),
          native_execution.cache_status, native_execution.runtime_information,
          ExecutionMode::NativeQleverTree);
      profile_storage = profile.str();
    }
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  }

  std::vector<ResolvedQleverBinding> terms;
  xpod_rdf_status resolve_status = XPOD_RDF_STATUS_OK;
  {
    ScopedQleverDiagnosticsStage term_resolution_stage("term-resolution");
    resolve_status = resolveIdTableTerms(
        backend, output_table, request.snapshot, terms, error_storage,
        &native_execution.local_vocab);
  }
  if (resolve_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, resolve_status, result_storage, profile_storage,
              error_storage);
    return resolve_status;
  }
  if (native_execution.plan.output_variables.size() !=
      output_table.numColumns()) {
    error_storage =
        "QLever native result columns do not match output variables";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (parsed.hasConstructClause()) {
    std::optional<size_t> triple_count;
    {
      ScopedQleverDiagnosticsStage serialization_stage("serialization");
      std::ostringstream ntriples;
      triple_count = writeConstructNTriples(
          ntriples, parsed, native_execution.plan, output_table, terms);
      if (triple_count.has_value()) {
        result_storage = ntriples.str();
        std::ostringstream profile;
        std::string_view graph_profile_kind =
            native_execution.plan.root.kind == BridgeOperationKind::Describe
                ? profileKind(native_execution.plan.root.kind)
                : std::string_view{"Construct"};
        writeScanProfileJson(
            profile, graph_profile_kind, native_execution.plan.descriptor,
            *triple_count, native_execution.cache_status,
            native_execution.runtime_information, {},
            ExecutionMode::NativeQleverTree);
        profile_storage = profile.str();
      }
    }
    if (!triple_count.has_value()) {
      error_storage = "failed to serialize QLever graph result";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage,
                          kNTriplesMediaType);
  }
  {
    ScopedQleverDiagnosticsStage serialization_stage("serialization");
    std::ostringstream json;
    writeSparqlJson(
        json, output_table, terms, native_execution.plan.output_variables);
    result_storage = json.str();
    std::ostringstream profile;
    writeScanProfileJson(
        profile, profileKind(native_execution.plan.root.kind),
        native_execution.plan.descriptor, output_table.numRows(),
        native_execution.cache_status, native_execution.runtime_information, {},
        ExecutionMode::NativeQleverTree);
    profile_storage = profile.str();
  }
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

xpod_rdf_status executeConstructBridgeQuery(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    ParsedQuery& parsed,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  setCurrentExecutionMode(ExecutionMode::CompatibilityParsedBgp);
  std::optional<BridgeQueryPlan> plan = planParsedGraphPatternFallback(
      parsed, parsed._rootGraphPattern, std::nullopt, false);
  if (!plan.has_value()) {
    error_storage = "unsupported QLever bridge CONSTRUCT query";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (plan->descriptor.find("Construct") == std::string::npos) {
    plan->descriptor = "Construct + " + plan->descriptor;
  }

  applyBridgeRequestContext(
      *plan, request.snapshot, request.cancellation, request.graph_scope,
      request.source_scope, request.access_scope);
  xpod_rdf_status bind_status = bindPlanTerms(
      backend, request.snapshot, *plan, error_storage);
  if (bind_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, bind_status, result_storage, profile_storage,
              error_storage);
    return bind_status;
  }

  IdTable materialized_output_table = makeQleverIdTable(
      plan->output_variables.size());
  LocalVocab materialized_local_vocab;
  if (!plan->known_empty) {
    BridgePhysicalPlan physical_plan = toBridgePhysicalPlan(*plan);
    if (isBridgeCandidateRoot(plan->root.kind)) {
      BridgePhysicalResult candidate_result = executeBridgePhysicalPlan(
          backend, physical_plan);
      if (candidate_result.status != XPOD_RDF_STATUS_OK) {
        error_storage = "Xpod-backed QLever CONSTRUCT candidate failed";
        setResult(out_result, candidate_result.status, result_storage,
                  profile_storage, error_storage);
        return candidate_result.status;
      }
      const std::vector<BridgeCandidateOutputColumn>* columns =
          candidateOutputColumnsForRoot(physical_plan);
      if (columns == nullptr || !candidate_result.candidates.has_value() ||
          columns->size() != plan->output_variables.size()) {
        error_storage = "unsupported QLever bridge CONSTRUCT candidate root";
        setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                  profile_storage, error_storage);
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      xpod_rdf_status candidate_status = candidateRowsToIdTable(
          backend, candidate_result.candidates->candidates, *columns,
          materialized_local_vocab, materialized_output_table);
      if (candidate_status != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to project QLever CONSTRUCT candidate rows";
        setResult(out_result, candidate_status, result_storage, profile_storage,
                  error_storage);
        return candidate_status;
      }
    } else {
      QleverResultWithStatus result = executeBridgeOperationPlan(
          backend, physical_plan);
      if (result.status != XPOD_RDF_STATUS_OK) {
        error_storage = "Xpod-backed QLever CONSTRUCT operation failed";
        setResult(out_result, result.status, result_storage, profile_storage,
                  error_storage);
        return result.status;
      }
      materialized_output_table = materializeQleverResultTable(
          result.result, plan->output_variables.size());
    }
  }

  std::vector<ResolvedQleverBinding> terms;
  xpod_rdf_status resolve_status = resolveIdTableTerms(
      backend, materialized_output_table, request.snapshot, terms,
      error_storage, &materialized_local_vocab);
  if (resolve_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, resolve_status, result_storage, profile_storage,
              error_storage);
    return resolve_status;
  }

  std::ostringstream ntriples;
  std::optional<size_t> triple_count = writeConstructNTriples(
      ntriples, parsed, *plan, materialized_output_table, terms);
  if (!triple_count.has_value()) {
    error_storage = "failed to serialize QLever CONSTRUCT result";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  result_storage = ntriples.str();
  std::ostringstream profile;
  std::string_view graph_profile_kind =
      plan->root.kind == BridgeOperationKind::Describe
          ? profileKind(plan->root.kind)
          : std::string_view{"Construct"};
  writeScanProfileJson(
      profile, graph_profile_kind, plan->descriptor, *triple_count,
      "computed", {}, {}, ExecutionMode::CompatibilityParsedBgp);
  profile_storage = profile.str();
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage,
                        kNTriplesMediaType);
}

const parsedQuery::Bind* updateBindFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Bind>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(
          operation));
}

std::optional<std::string> parseSimpleQuotedString(std::string_view value) {
  value = trimAsciiWhitespace(value);
  if (value.size() < 2 || value.front() != '"' || value.back() != '"') {
    return std::nullopt;
  }
  value.remove_prefix(1);
  value.remove_suffix(1);

  std::string output;
  output.reserve(value.size());
  bool escaped = false;
  for (char c : value) {
    if (escaped) {
      switch (c) {
        case 'n':
          output.push_back('\n');
          break;
        case 'r':
          output.push_back('\r');
          break;
        case 't':
          output.push_back('\t');
          break;
        default:
          output.push_back(c);
          break;
      }
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    output.push_back(c);
  }
  if (escaped) {
    return std::nullopt;
  }
  return output;
}

std::optional<BridgeTermBinding> iriFunctionBindingFromDescriptor(
    std::string_view descriptor) {
  descriptor = trimAsciiWhitespace(descriptor);
  std::string_view argument;
  if (descriptor.rfind("IRI(", 0) == 0 && descriptor.back() == ')') {
    argument = descriptor.substr(4, descriptor.size() - 5);
  } else if (descriptor.rfind("URI(", 0) == 0 && descriptor.back() == ')') {
    argument = descriptor.substr(4, descriptor.size() - 5);
  } else {
    return std::nullopt;
  }

  std::optional<std::string> iri_value = parseSimpleQuotedString(argument);
  if (!iri_value.has_value()) {
    return std::nullopt;
  }
  BridgeTermBinding binding;
  binding.kind = XPOD_RDF_TERM_IRI;
  binding.value = std::move(*iri_value);
  return binding;
}

std::optional<std::string> strVariableFromDescriptor(
    std::string_view descriptor) {
  descriptor = trimAsciiWhitespace(descriptor);
  if (descriptor.rfind("STR(", 0) != 0 || descriptor.back() != ')') {
    return std::nullopt;
  }
  std::string_view argument = trimAsciiWhitespace(
      descriptor.substr(4, descriptor.size() - 5));
  if (argument.size() < 2 || argument.front() != '?') {
    return std::nullopt;
  }
  return std::string(argument.substr(1));
}

std::optional<UpdateTemplateBinding> updateTemplateBindingFromBind(
    const parsedQuery::Bind& bind) {
  std::string_view descriptor = bind._expression.getDescriptor();
  std::optional<BridgeTermBinding> term = filterBindingFromToken(descriptor);
  if (!term.has_value()) {
    term = iriFunctionBindingFromDescriptor(descriptor);
  }
  if (!term.has_value()) {
    if (std::optional<std::string> source_variable =
            strVariableFromDescriptor(descriptor);
        source_variable.has_value()) {
      UpdateTemplateBinding binding;
      binding.variable = bridgeVariableName(bind._target);
      binding.kind = UpdateTemplateBindingKind::StrVariable;
      binding.source_variable = std::move(*source_variable);
      return binding;
    }
    return std::nullopt;
  }

  ResolvedQleverBinding resolved;
  xpod_rdf_term native_term = toNativeTerm(*term);
  resolved.setFromTerm(native_term);
  UpdateTemplateBinding binding;
  binding.variable = bridgeVariableName(bind._target);
  binding.kind = UpdateTemplateBindingKind::Constant;
  binding.binding = std::move(resolved);
  return binding;
}

std::optional<BridgeQueryPlan> planUpdateWhereDataOperationWithoutBinds(
    const ParsedQuery& parsed,
    const parsedQuery::GraphPatternOperation& operation,
    const std::optional<BridgeGraphScope>& inherited_default_graph_scope,
    const std::optional<BridgeGraphScope>& inherited_named_graph_scope) {
  std::optional<BridgeGraphScope> graph_scope;
  if (const parsedQuery::BasicGraphPattern* basic =
          scopedBasicPatternFromOperation(operation, graph_scope);
      basic != nullptr) {
    std::optional<BridgeGraphScope> effective_scope =
        graph_scope.has_value()
            ? mergeBridgeGraphScopes(inherited_named_graph_scope, graph_scope)
            : inherited_default_graph_scope;
    if (graph_scope.has_value()) {
      if (!effective_scope.has_value()) {
        return std::nullopt;
      }
    }
    return planBasicPatternFallback(parsed, *basic, effective_scope, false);
  }

  const parsedQuery::GroupGraphPattern* group = groupFromOperation(operation);
  if (group == nullptr) {
    return std::nullopt;
  }
  std::optional<BridgeGraphScope> local_scope = graphScopeFromGroup(*group);
  if (local_scope.has_value()) {
    std::optional<BridgeGraphScope> effective_scope =
        mergeBridgeGraphScopes(inherited_named_graph_scope, local_scope);
    if (!effective_scope.has_value()) {
      return std::nullopt;
    }
    return planParsedGraphPatternFallback(
        parsed, group->_child, effective_scope, false);
  }
  return planParsedGraphPatternFallback(
      parsed, group->_child, inherited_default_graph_scope, false);
}

std::optional<BridgeQueryPlan> planUpdateWhereWithConstantBinds(
    const ParsedQuery& parsed_update,
    const parsedQuery::GraphPattern& graph_pattern,
    const std::optional<BridgeGraphScope>& inherited_default_graph_scope,
    const std::optional<BridgeGraphScope>& inherited_named_graph_scope,
    std::vector<UpdateTemplateBinding>& out_template_bindings) {
  if (!graph_pattern._filters.empty()) {
    return std::nullopt;
  }

  const parsedQuery::GraphPatternOperation* data_operation = nullptr;
  std::vector<UpdateTemplateBinding> local_bindings;
  for (const parsedQuery::GraphPatternOperation& operation :
       graph_pattern._graphPatterns) {
    if (const parsedQuery::Bind* bind = updateBindFromOperation(operation);
        bind != nullptr) {
      std::optional<UpdateTemplateBinding> binding =
          updateTemplateBindingFromBind(*bind);
      if (!binding.has_value()) {
        return std::nullopt;
      }
      local_bindings.push_back(std::move(*binding));
      continue;
    }
    if (data_operation != nullptr) {
      return std::nullopt;
    }
    data_operation = &operation;
  }
  if (data_operation == nullptr || local_bindings.empty()) {
    return std::nullopt;
  }

  std::optional<BridgeQueryPlan> plan =
      planUpdateWhereDataOperationWithoutBinds(
          parsed_update, *data_operation, inherited_default_graph_scope,
          inherited_named_graph_scope);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  for (const UpdateTemplateBinding& binding : local_bindings) {
    if (outputColumnForVariable(plan->output_variables, binding.variable)
            .has_value()) {
      return std::nullopt;
    }
  }
  if (plan->descriptor.find("Bind") == std::string::npos) {
    plan->descriptor += " + BindTemplate";
  }
  out_template_bindings.insert(
      out_template_bindings.end(),
      std::make_move_iterator(local_bindings.begin()),
      std::make_move_iterator(local_bindings.end()));
  return plan;
}

template <typename GraphTermT>
std::optional<std::string> datasetGraphIriValue(const GraphTermT& graph) {
  if constexpr (std::is_same_v<
                    std::decay_t<GraphTermT>, TripleComponent::Iri>) {
    return iriValueFromIri(graph);
  } else {
    if (!graph.isIri()) {
      return std::nullopt;
    }
    return iriValueFromComponent(graph);
  }
}

std::optional<BridgeGraphScope> graphScopeFromDatasetGraphs(
    const parsedQuery::DatasetClauses::Graphs& graphs) {
  if (!graphs.has_value()) {
    return std::nullopt;
  }

  BridgeGraphScope scope;
  if (graphs->empty()) {
    scope.graph_scope_known_empty = true;
    return scope;
  }

  for (const auto& graph : *graphs) {
    auto iri_value = datasetGraphIriValue(graph);
    if (!iri_value.has_value()) {
      return std::nullopt;
    }
    BridgeTermBinding binding;
    binding.slot = XPOD_RDF_SLOT_GRAPH;
    binding.kind = XPOD_RDF_TERM_IRI;
    binding.value = std::move(*iri_value);
    scope.graph_scope_bindings.push_back(std::move(binding));
  }
  return scope;
}

std::optional<BridgeGraphScope> updateDefaultGraphScopeFromDataset(
    const ParsedQuery& parsed_update) {
  return graphScopeFromDatasetGraphs(
      parsed_update.datasetClauses_.activeDefaultGraphs());
}

std::optional<BridgeGraphScope> updateNamedGraphScopeFromDataset(
    const ParsedQuery& parsed_update) {
  return graphScopeFromDatasetGraphs(
      parsed_update.datasetClauses_.namedGraphs());
}

[[maybe_unused]] xpod_rdf_status materializeUpdateWhereBindings(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    ParsedQuery& parsed_update,
    BridgeQueryPlan& out_plan,
    IdTable& out_table,
    LocalVocab& out_local_vocab,
    std::vector<UpdateTemplateBinding>& out_template_bindings,
    std::string& error_storage) {
  if (auto native_execution = executeQleverParsedQueryWithNativeTree(
          backend, planner_context, parsed_update);
      native_execution.has_value()) {
    out_plan = std::move(native_execution->plan);
    out_table = std::move(native_execution->table);
    out_local_vocab = std::move(native_execution->local_vocab);
    return XPOD_RDF_STATUS_OK;
  }

  std::optional<BridgeGraphScope> dataset_graph_scope =
      updateDefaultGraphScopeFromDataset(parsed_update);
  std::optional<BridgeGraphScope> dataset_named_graph_scope =
      updateNamedGraphScopeFromDataset(parsed_update);
  std::optional<BridgeQueryPlan> plan;
  if (dataset_named_graph_scope.has_value() &&
      parsed_update._rootGraphPattern._filters.empty() &&
      parsed_update._rootGraphPattern._graphPatterns.size() == 1) {
    plan = planUpdateWhereDataOperationWithoutBinds(
        parsed_update, parsed_update._rootGraphPattern._graphPatterns.front(),
        dataset_graph_scope, dataset_named_graph_scope);
  }
  if (!plan.has_value()) {
    plan = planParsedGraphPatternFallback(
        parsed_update, parsed_update._rootGraphPattern, dataset_graph_scope,
        false);
  }
  if (!plan.has_value()) {
    plan = planUpdateWhereWithConstantBinds(
        parsed_update, parsed_update._rootGraphPattern, dataset_graph_scope,
        dataset_named_graph_scope, out_template_bindings);
  }
  if (!plan.has_value()) {
    error_storage = "unsupported QLever bridge UPDATE WHERE clause";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  applyBridgeRequestContext(
      *plan, request.snapshot, request.cancellation, request.graph_scope,
      request.source_scope, request.access_scope);
  xpod_rdf_status bind_status = bindPlanTerms(
      backend, request.snapshot, *plan, error_storage);
  if (bind_status != XPOD_RDF_STATUS_OK) {
    return bind_status;
  }

  out_table = makeQleverIdTable(plan->output_variables.size());
  if (!plan->known_empty) {
    BridgePhysicalPlan physical_plan = toBridgePhysicalPlan(*plan);
    if (isBridgeCandidateRoot(plan->root.kind)) {
      BridgePhysicalResult candidate_result = executeBridgePhysicalPlan(
          backend, physical_plan);
      if (candidate_result.status != XPOD_RDF_STATUS_OK) {
        error_storage = "Xpod-backed QLever UPDATE candidate failed";
        return candidate_result.status;
      }
      const std::vector<BridgeCandidateOutputColumn>* columns =
          candidateOutputColumnsForRoot(physical_plan);
      if (columns == nullptr || !candidate_result.candidates.has_value() ||
          columns->size() != plan->output_variables.size()) {
        error_storage = "unsupported QLever bridge UPDATE candidate root";
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      LocalVocab candidate_local_vocab;
      xpod_rdf_status candidate_status = candidateRowsToIdTable(
          backend, candidate_result.candidates->candidates, *columns,
          candidate_local_vocab, out_table);
      if (candidate_status != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to project QLever UPDATE candidate rows";
        return candidate_status;
      }
    } else {
      QleverResultWithStatus result = executeBridgeOperationPlan(
          backend, physical_plan);
      if (result.status != XPOD_RDF_STATUS_OK) {
        error_storage = "Xpod-backed QLever UPDATE WHERE operation failed";
        return result.status;
      }
      out_table = materializeQleverResultTable(
          result.result, plan->output_variables.size());
    }
  }

  out_plan = std::move(*plan);
  return XPOD_RDF_STATUS_OK;
}

class BridgeUpdateTransaction {
 public:
  explicit BridgeUpdateTransaction(xpod::rdf::PhysicalBackend backend)
      : backend_(backend) {}

  ~BridgeUpdateTransaction() { rollbackIfActive(); }

  bool beginTransaction(
      const xpod_qlever_query_request& request,
      std::string& error_storage,
      bool require_transaction = false) {
    const xpod_rdf_status status = backend_.beginTransaction(request.snapshot);
    if (status == XPOD_RDF_STATUS_UNSUPPORTED) {
      if (!require_transaction) {
        return true;
      }
      error_storage =
          "Xpod-backed QLever prepared update requires backend transactions";
      status_ = status;
      return false;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever update transaction begin failed";
      status_ = status;
      return false;
    }
    active_ = true;
    status_ = XPOD_RDF_STATUS_OK;
    return true;
  }

  bool rollback(std::string& error_storage) {
    if (!active_) {
      return true;
    }
    const xpod_rdf_status status = backend_.rollbackTransaction();
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever update transaction rollback failed";
      status_ = status;
      return false;
    }
    active_ = false;
    status_ = XPOD_RDF_STATUS_OK;
    return true;
  }

  bool commit(std::string& error_storage) {
    if (!active_) {
      return true;
    }
    const xpod_rdf_status status = backend_.commitTransaction();
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever update transaction commit failed";
      status_ = status;
      return false;
    }
    active_ = false;
    status_ = XPOD_RDF_STATUS_OK;
    return true;
  }

  xpod_rdf_status status() const noexcept { return status_; }

 private:
  void rollbackIfActive() noexcept {
    if (active_) {
      (void)backend_.rollbackTransaction();
      active_ = false;
    }
  }

  xpod::rdf::PhysicalBackend backend_;
  bool active_ = false;
  xpod_rdf_status status_ = XPOD_RDF_STATUS_OK;
};

xpod_rdf_status executeSimpleLoadUpdate(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionContext* qec,
    const xpod_qlever_query_request& request,
    const ParsedSimpleLoadUpdate& load_update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  auto complete_silent_load = [&]() -> xpod_rdf_status {
    result_storage = R"({"inserted":0,"deleted":0})";
    std::ostringstream profile;
    writeScanProfileJson(profile, "Update", "SPARQL LOAD SILENT", 0);
    profile_storage = profile.str();
    error_storage.clear();
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  };

  BridgeUpdateTransaction transaction(backend);
  if (!transaction.beginTransaction(request, error_storage)) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    setResult(out_result, transaction.status(), result_storage,
              profile_storage, error_storage);
    return transaction.status();
  }

  xpod_rdf_load_document_request load_request = {};
  load_request.snapshot = request.snapshot;
  load_request.cancellation = request.cancellation;
  load_request.source_iri =
      {load_update.source_iri.data(), load_update.source_iri.size()};
  load_request.source_scope = request.source_scope;
  load_request.access_scope = request.access_scope;
  if (load_update.target_graph_iri.has_value()) {
    load_request.has_target_graph = 1;
    load_request.target_graph.kind = XPOD_RDF_TERM_IRI;
    load_request.target_graph.value = {
        load_update.target_graph_iri->data(),
        load_update.target_graph_iri->size()};
  }

  xpod_rdf_load_document_result load_result = {};
  xpod_rdf_status load_status = XPOD_RDF_STATUS_OK;
  if (request.has_load_document != 0) {
    if (bytesView(request.load_document_source_uri) !=
        load_update.source_iri) {
      load_status = XPOD_RDF_STATUS_NOT_FOUND;
    } else {
      load_result.content = request.load_document_body;
      load_result.media_type = request.load_document_media_type;
      load_result.document_iri = request.load_document_source_uri;
    }
  } else {
    load_status = backend.loadDocument(load_request, load_result);
  }
  if (load_status == XPOD_RDF_STATUS_UNSUPPORTED ||
      load_status == XPOD_RDF_STATUS_NOT_FOUND) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    error_storage = "unsupported SPARQL LOAD";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (load_status != XPOD_RDF_STATUS_OK) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    error_storage = "Xpod-backed QLever LOAD document failed";
    setResult(out_result, load_status, result_storage, profile_storage,
              error_storage);
    return load_status;
  }
  const std::string_view media_type = bytesView(load_result.media_type);
  const bool is_ntriples = loadMediaTypeIsNTriples(media_type);
  const bool is_turtle = loadMediaTypeIsTurtle(media_type);
  if (!is_ntriples && !is_turtle) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    error_storage = "unsupported SPARQL LOAD document media type";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::vector<OwnedQuadMutation> owned_mutations;
  xpod_rdf_status parse_status = is_ntriples
      ? parseNTriplesLoadDocument(
            bytesView(load_result.content), load_update.target_graph_iri,
            owned_mutations, error_storage)
      : parseTurtleLoadDocument(
            bytesView(load_result.content), load_update.target_graph_iri,
            owned_mutations, error_storage);
  if (parse_status != XPOD_RDF_STATUS_OK) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    setResult(out_result, parse_status, result_storage, profile_storage,
              error_storage);
    return parse_status;
  }

  uint64_t inserted_count = 0;
  if (!owned_mutations.empty()) {
    std::vector<xpod_rdf_quad_mutation> mutations;
    mutations.reserve(owned_mutations.size());
    for (const auto& owned : owned_mutations) {
      mutations.push_back(owned.mutation);
    }

    xpod_rdf_mutation_request mutation_request = {};
    mutation_request.snapshot = request.snapshot;
    mutation_request.cancellation = request.cancellation;
    mutation_request.graph_scope = request.graph_scope;
    mutation_request.source_scope = request.source_scope;
    mutation_request.access_scope = request.access_scope;
    mutation_request.mutations = mutations.data();
    mutation_request.mutation_count = mutations.size();

    xpod_rdf_mutation_result mutation_result = {};
    const xpod_rdf_status mutation_status =
        backend.applyMutation(mutation_request, mutation_result);
    if (mutation_status != XPOD_RDF_STATUS_OK) {
      if (load_update.silent) {
        return complete_silent_load();
      }
      error_storage = "Xpod-backed QLever LOAD mutation failed";
      setResult(out_result, mutation_status, result_storage, profile_storage,
                error_storage);
      return mutation_status;
    }
    inserted_count = mutation_result.inserted_count;
    clearPlannerCacheAfterMutation(qec);
  }

  std::ostringstream json;
  json << "{\"inserted\":" << inserted_count << ",\"deleted\":0}";
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(profile, "Update", "SPARQL LOAD", inserted_count);
  profile_storage = profile.str();
  if (!transaction.commit(error_storage)) {
    if (load_update.silent) {
      return complete_silent_load();
    }
    setResult(out_result, transaction.status(), result_storage,
              profile_storage, error_storage);
    return transaction.status();
  }
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

void copyResolvedTermToMutationTerm(
    const xpod_rdf_term& resolved,
    OwnedMutationTerm& out_term) {
  out_term.term.kind = resolved.kind;
  out_term.value = std::string(bytesView(resolved.value));
  out_term.datatype_iri = std::string(bytesView(resolved.datatype_iri));
  out_term.language = std::string(bytesView(resolved.language));
  out_term.refreshViews();
}

xpod_rdf_status resolveMutationTerm(
    xpod::rdf::PhysicalBackend backend,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot& snapshot,
    OwnedMutationTerm& out_term,
    std::string& error_storage) {
  xpod_rdf_term resolved = {};
  const xpod_rdf_status status = backend.resolveTerm(key, snapshot, resolved);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever graph management term resolve failed";
    return status;
  }
  copyResolvedTermToMutationTerm(resolved, out_term);
  return XPOD_RDF_STATUS_OK;
}

void setIriMutationTerm(std::string_view iri, OwnedMutationTerm& out_term) {
  out_term.term.kind = XPOD_RDF_TERM_IRI;
  out_term.value = std::string(iri);
  out_term.datatype_iri.clear();
  out_term.language.clear();
  out_term.refreshViews();
}

struct GraphManagementScanState {
  std::vector<xpod_rdf_quad_key>* rows;
};

xpod_rdf_status appendGraphManagementRows(
    void* user_data,
    const xpod_rdf_quad_batch* batch) {
  if (user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<GraphManagementScanState*>(user_data);
  if (state->rows == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  state->rows->insert(
      state->rows->end(), batch->rows, batch->rows + batch->row_count);
  return XPOD_RDF_STATUS_OK;
}

bool graphScopeAllowsGraph(
    const xpod_rdf_graph_scope& scope,
    xpod_rdf_term_key graph_key,
    std::string_view graph_iri) {
  switch (scope.kind) {
    case XPOD_RDF_GRAPH_SCOPE_ALL:
      return true;
    case XPOD_RDF_GRAPH_SCOPE_EXACT:
      return scope.exact_graph == graph_key;
    case XPOD_RDF_GRAPH_SCOPE_PREFIX:
      return graph_iri.rfind(bytesView(scope.iri_prefix), 0) == 0;
    case XPOD_RDF_GRAPH_SCOPE_SET:
      return scope.graph_set != nullptr &&
             std::find(
                 scope.graph_set,
                 scope.graph_set + scope.graph_set_size,
                 graph_key) != scope.graph_set + scope.graph_set_size;
  }
  return false;
}

template <typename Key>
bool preparedKeyListContains(
    Key key,
    const Key* keys,
    size_t key_count) {
  return keys != nullptr &&
         std::find(keys, keys + key_count, key) != keys + key_count;
}

bool preparedIriMatchesPrefixes(
    std::string_view iri,
    const xpod_rdf_bytes* prefixes,
    size_t prefix_count) {
  if (prefixes == nullptr) {
    return false;
  }
  for (size_t index = 0; index < prefix_count; ++index) {
    if (iri.rfind(bytesView(prefixes[index]), 0) == 0) {
      return true;
    }
  }
  return false;
}

bool preparedBytesIsMalformed(xpod_rdf_bytes value) {
  return value.data == nullptr && value.size != 0;
}

bool preparedGraphScopePrefixIsMalformed(
    const xpod_rdf_graph_scope& scope) {
  return scope.kind == XPOD_RDF_GRAPH_SCOPE_PREFIX &&
         preparedBytesIsMalformed(scope.iri_prefix);
}

bool preparedPrefixListIsMalformed(
    const xpod_rdf_bytes* prefixes,
    size_t prefix_count) {
  if (prefixes == nullptr) {
    return prefix_count != 0;
  }
  for (size_t index = 0; index < prefix_count; ++index) {
    if (preparedBytesIsMalformed(prefixes[index])) {
      return true;
    }
  }
  return false;
}

bool preparedSourceScopeIsMalformed(const xpod_rdf_source_scope& scope) {
  return preparedBytesIsMalformed(scope.workspace) ||
         preparedBytesIsMalformed(scope.source_uri) ||
         preparedBytesIsMalformed(scope.source_uri_prefix) ||
         preparedBytesIsMalformed(scope.local_path) ||
         preparedBytesIsMalformed(scope.local_path_prefix);
}

bool preparedGraphKeyIsRequired(const xpod_qlever_query_request& request) {
  if (request.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT ||
      request.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
    return true;
  }
  return request.access_scope != nullptr &&
         (request.access_scope->allowed_graphs_size != 0 ||
          request.access_scope->denied_graphs_size != 0);
}

xpod_rdf_status validatePreparedUpdateMutation(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const OwnedQuadMutation& mutation,
    std::map<std::string, std::string>& validated_graph_sources,
    std::string& graph_iri,
    std::string& source_uri,
    std::string& error_storage) {
  const xpod_rdf_quad& quad = mutation.mutation.quad;
  if (mutation.mutation.kind != XPOD_RDF_MUTATION_INSERT &&
      mutation.mutation.kind != XPOD_RDF_MUTATION_DELETE) {
    error_storage = "prepared update contains an unsupported mutation kind";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (quad.has_graph == 0 || quad.graph.kind != XPOD_RDF_TERM_IRI) {
    error_storage = "prepared update v1 requires an explicit graph IRI";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const std::array<const xpod_rdf_term*, 4> terms{
      &quad.subject, &quad.predicate, &quad.object, &quad.graph};
  for (const xpod_rdf_term* term : terms) {
    if (term->kind == XPOD_RDF_TERM_BLANK) {
      error_storage =
          "prepared update v1 cannot stably encode blank-node mutations";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
  }

  if (preparedSourceScopeIsMalformed(request.source_scope)) {
    error_storage = "prepared update source metadata is malformed";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  graph_iri = std::string(bytesView(quad.graph.value));
  source_uri = std::string(bytesView(request.source_scope.source_uri));
  if (graph_iri.empty()) {
    error_storage =
        "prepared update source provenance is not uniquely identified";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_source_scope source_scope = request.source_scope;
  if (source_uri.empty()) {
    source_uri = graph_iri;
    source_scope.source_uri = {source_uri.data(), source_uri.size()};
  }
  const std::string_view source_uri_prefix =
      bytesView(request.source_scope.source_uri_prefix);
  if (!source_uri_prefix.empty() &&
      source_uri.rfind(source_uri_prefix, 0) != 0) {
    error_storage =
        "prepared update source is outside the source URI prefix";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (preparedGraphScopePrefixIsMalformed(request.graph_scope)) {
    error_storage = "prepared update graph prefix metadata is malformed";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const auto cached_source = validated_graph_sources.find(graph_iri);
  if (cached_source != validated_graph_sources.end()) {
    source_uri = cached_source->second;
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_resolved_source_scope resolved_source_scope = {};
  const xpod_rdf_status source_status = backend.resolveSourceScope(
      source_scope, request.snapshot, resolved_source_scope);
  if (source_status != XPOD_RDF_STATUS_OK) {
    error_storage = "prepared update source metadata lookup failed";
    return source_status;
  }
  if (resolved_source_scope.source_nodes_size > 1 ||
      (resolved_source_scope.source_nodes_size != 0 &&
       resolved_source_scope.source_nodes == nullptr)) {
    error_storage =
        "prepared update source provenance is not uniquely identified";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (preparedGraphScopePrefixIsMalformed(
          resolved_source_scope.graph_scope)) {
    error_storage = "prepared update graph prefix metadata is malformed";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_source_node_key source_node = 0;
  const bool has_source_node = resolved_source_scope.source_nodes_size == 1;
  if (has_source_node) {
    source_node = resolved_source_scope.source_nodes[0];
    if (request.source_scope.has_source_node != 0 &&
        request.source_scope.source_node != source_node) {
      error_storage =
          "prepared update source metadata is inconsistent";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
  }

  xpod_rdf_term_key graph_key = 0;
  const bool resolved_graph_key_is_required =
      has_source_node &&
      (resolved_source_scope.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT ||
       resolved_source_scope.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET);
  const bool graph_key_is_required =
      preparedGraphKeyIsRequired(request) ||
      resolved_graph_key_is_required;
  const xpod_rdf_status lookup_status =
      backend.lookupTerm(quad.graph, request.snapshot, graph_key);
  if (lookup_status == XPOD_RDF_STATUS_NOT_FOUND) {
    if ((!has_source_node && request.source_scope.has_source_node != 0) ||
        source_uri != graph_iri) {
      error_storage =
          "prepared update v1 requires a new graph sourceUri to equal graphIri";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (graph_key_is_required) {
      error_storage =
          "prepared update graph cannot be mapped to backend metadata";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
  } else if (lookup_status == XPOD_RDF_STATUS_OK && !has_source_node) {
    error_storage =
        "prepared update source provenance is not uniquely identified";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } else if (lookup_status != XPOD_RDF_STATUS_OK) {
    error_storage =
        "prepared update graph metadata lookup failed";
    return lookup_status;
  }

  if (!graphScopeAllowsGraph(
          request.graph_scope, graph_key, graph_iri)) {
    error_storage = "prepared update graph is outside the request graph scope";
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  if (has_source_node &&
      !graphScopeAllowsGraph(
          resolved_source_scope.graph_scope, graph_key, graph_iri)) {
    error_storage =
        "prepared update source metadata does not map to the graph";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const xpod_rdf_access_scope* access = request.access_scope;
  if (access == nullptr) {
    validated_graph_sources.emplace(graph_iri, source_uri);
    return XPOD_RDF_STATUS_OK;
  }
  if ((access->allowed_graphs_size != 0 &&
       access->allowed_graphs == nullptr) ||
      (access->denied_graphs_size != 0 &&
       access->denied_graphs == nullptr) ||
      (access->allowed_graph_prefixes_size != 0 &&
       access->allowed_graph_prefixes == nullptr) ||
      (access->denied_graph_prefixes_size != 0 &&
       access->denied_graph_prefixes == nullptr) ||
      (access->allowed_sources_size != 0 &&
       access->allowed_sources == nullptr) ||
      (access->denied_sources_size != 0 &&
       access->denied_sources == nullptr)) {
    error_storage = "prepared update access metadata is malformed";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (preparedPrefixListIsMalformed(
          access->allowed_graph_prefixes,
          access->allowed_graph_prefixes_size) ||
      preparedPrefixListIsMalformed(
          access->denied_graph_prefixes,
          access->denied_graph_prefixes_size)) {
    error_storage = "prepared update graph prefix metadata is malformed";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const bool has_allowed_graphs =
      access->allowed_graphs_size != 0 ||
      access->allowed_graph_prefixes_size != 0;
  const bool graph_is_allowed =
      preparedKeyListContains(
          graph_key, access->allowed_graphs,
          access->allowed_graphs_size) ||
      preparedIriMatchesPrefixes(
          graph_iri, access->allowed_graph_prefixes,
          access->allowed_graph_prefixes_size);
  const bool graph_is_denied =
      preparedKeyListContains(
          graph_key, access->denied_graphs,
          access->denied_graphs_size) ||
      preparedIriMatchesPrefixes(
          graph_iri, access->denied_graph_prefixes,
          access->denied_graph_prefixes_size);
  if ((has_allowed_graphs && !graph_is_allowed) || graph_is_denied) {
    error_storage = "prepared update graph is denied by access metadata";
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }

  if ((access->allowed_sources_size != 0 ||
       access->denied_sources_size != 0) &&
      !has_source_node) {
    error_storage =
        "prepared update source cannot be mapped to access metadata";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (access->allowed_sources_size != 0 &&
      !preparedKeyListContains(
          source_node, access->allowed_sources,
          access->allowed_sources_size)) {
    error_storage = "prepared update source is not allowed";
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  if (preparedKeyListContains(
          source_node, access->denied_sources,
          access->denied_sources_size)) {
    error_storage = "prepared update source is denied";
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  validated_graph_sources.emplace(graph_iri, source_uri);
  return XPOD_RDF_STATUS_OK;
}

struct PreparedGraphDelta {
  std::string source_uri;
  std::vector<const xpod_rdf_quad*> deletes;
  std::vector<const xpod_rdf_quad*> inserts;
};

struct PreparedNetMutation {
  xpod_rdf_mutation_kind kind = XPOD_RDF_MUTATION_INSERT;
  const OwnedQuadMutation* mutation = nullptr;
};

std::string preparedTermSignature(const xpod_rdf_term& term) {
  std::ostringstream out;
  out << static_cast<int>(term.kind) << '\x1f' << bytesView(term.value)
      << '\x1f' << bytesView(term.datatype_iri) << '\x1f'
      << bytesView(term.language);
  return out.str();
}

std::string preparedQuadSignature(const xpod_rdf_quad& quad) {
  std::ostringstream out;
  out << preparedTermSignature(quad.subject) << '\x1e'
      << preparedTermSignature(quad.predicate) << '\x1e'
      << preparedTermSignature(quad.object) << '\x1e'
      << preparedTermSignature(quad.graph);
  return out.str();
}

xpod_rdf_status lookupPreparedQuad(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const xpod_rdf_quad& quad,
    bool& out_exists,
    std::string& error_storage) {
  out_exists = false;
  std::array<xpod_rdf_term, 4> terms{
      quad.subject, quad.predicate, quad.object, quad.graph};
  std::array<xpod_rdf_term_key, 4> keys{};
  for (size_t index = 0; index < terms.size(); ++index) {
    const xpod_rdf_status lookup_status =
        backend.lookupTerm(terms[index], request.snapshot, keys[index]);
    if (lookup_status == XPOD_RDF_STATUS_NOT_FOUND) {
      return XPOD_RDF_STATUS_OK;
    }
    if (lookup_status != XPOD_RDF_STATUS_OK) {
      error_storage = "prepared update quad metadata lookup failed";
      return lookup_status;
    }
  }

  xpod_rdf_scan_request scan = {};
  scan.snapshot = request.snapshot;
  scan.cancellation = request.cancellation;
  scan.permutation = XPOD_RDF_PERM_GSPO;
  scan.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  scan.source_scope = request.source_scope;
  scan.access_scope = request.access_scope;
  scan.pattern.has_subject = 1;
  scan.pattern.subject = keys[0];
  scan.pattern.has_predicate = 1;
  scan.pattern.predicate = keys[1];
  scan.pattern.has_object = 1;
  scan.pattern.object = keys[2];
  scan.pattern.has_graph = 1;
  scan.pattern.graph = keys[3];
  scan.limit = 1;

  xpod_rdf_count_result count = {};
  const xpod_rdf_status count_status = backend.countScan(scan, count);
  if (count_status != XPOD_RDF_STATUS_OK) {
    error_storage = "prepared update quad existence scan failed";
    return count_status;
  }
  out_exists = count.count != 0;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status collectPreparedNetDelta(
    const std::vector<OwnedQuadMutation>& mutations,
    const std::map<std::string, bool>& initial_existence_by_signature,
    std::vector<PreparedNetMutation>& out_net_mutations,
    std::string& error_storage) {
  struct Candidate {
    const OwnedQuadMutation* first_mutation = nullptr;
    const OwnedQuadMutation* last_mutation = nullptr;
    bool initially_exists = false;
    bool finally_exists = false;
  };
  std::map<std::string, Candidate> candidates;
  for (const OwnedQuadMutation& mutation : mutations) {
    Candidate& candidate = candidates[preparedQuadSignature(mutation.mutation.quad)];
    if (candidate.first_mutation == nullptr) {
      candidate.first_mutation = &mutation;
    }
    candidate.last_mutation = &mutation;
  }

  for (auto& [signature, candidate] : candidates) {
    (void)signature;
    if (candidate.first_mutation == nullptr ||
        candidate.last_mutation == nullptr) {
      continue;
    }
    const auto initial = initial_existence_by_signature.find(signature);
    if (initial == initial_existence_by_signature.end()) {
      error_storage = "prepared update initial quad state is missing";
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    candidate.initially_exists = initial->second;
    candidate.finally_exists =
        candidate.last_mutation->mutation.kind == XPOD_RDF_MUTATION_INSERT;
    if (!candidate.initially_exists && candidate.finally_exists) {
      out_net_mutations.push_back(
          {XPOD_RDF_MUTATION_INSERT, candidate.last_mutation});
    } else if (candidate.initially_exists && !candidate.finally_exists) {
      out_net_mutations.push_back(
          {XPOD_RDF_MUTATION_DELETE, candidate.last_mutation});
    }
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status rememberPreparedInitialState(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const std::vector<OwnedQuadMutation>& mutations,
    std::map<std::string, bool>& initial_existence_by_signature,
    std::string& error_storage) {
  for (const OwnedQuadMutation& mutation : mutations) {
    const std::string signature =
        preparedQuadSignature(mutation.mutation.quad);
    if (initial_existence_by_signature.find(signature) !=
        initial_existence_by_signature.end()) {
      continue;
    }
    bool exists = false;
    const xpod_rdf_status status = lookupPreparedQuad(
        backend, request, mutation.mutation.quad, exists, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    initial_existence_by_signature.emplace(signature, exists);
  }
  return XPOD_RDF_STATUS_OK;
}

void writePreparedQuad(
    std::ostringstream& out,
    const xpod_rdf_quad& quad) {
  out << "{\"subject\":";
  writeTermBinding(out, quad.subject);
  out << ",\"predicate\":";
  writeTermBinding(out, quad.predicate);
  out << ",\"object\":";
  writeTermBinding(out, quad.object);
  out << ",\"graph\":";
  writeTermBinding(out, quad.graph);
  out << '}';
}

void writePreparedQuadArray(
    std::ostringstream& out,
    const std::vector<const xpod_rdf_quad*>& quads) {
  out << '[';
  for (size_t index = 0; index < quads.size(); ++index) {
    if (index != 0) {
      out << ',';
    }
    writePreparedQuad(out, *quads[index]);
  }
  out << ']';
}

xpod_rdf_status writePreparedDeltaJson(
    const std::vector<PreparedNetMutation>& mutations,
    const std::map<std::string, std::string>& validated_graph_sources,
    std::string& result_storage,
    uint64_t& mutation_count,
    std::string& error_storage) {
  std::map<std::string, PreparedGraphDelta> deltas;
  for (const PreparedNetMutation& net_mutation : mutations) {
    if (net_mutation.mutation == nullptr) {
      error_storage = "prepared update contains an empty net mutation";
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    const OwnedQuadMutation& mutation = *net_mutation.mutation;
    const std::string graph_iri =
        std::string(bytesView(mutation.mutation.quad.graph.value));
    const auto source = validated_graph_sources.find(graph_iri);
    if (source == validated_graph_sources.end()) {
      error_storage = "prepared update mutation was not preflight validated";
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    PreparedGraphDelta& delta = deltas[graph_iri];
    delta.source_uri = source->second;
    if (net_mutation.kind == XPOD_RDF_MUTATION_DELETE) {
      delta.deletes.push_back(&mutation.mutation.quad);
    } else {
      delta.inserts.push_back(&mutation.mutation.quad);
    }
  }

  std::ostringstream json;
  json << "{\"version\":1,\"graphs\":[";
  size_t graph_index = 0;
  for (const auto& [graph_iri, delta] : deltas) {
    if (graph_index++ != 0) {
      json << ',';
    }
    json << "{\"graphIri\":";
    writeJsonString(json, graph_iri);
    json << ",\"sourceUri\":";
    writeJsonString(json, delta.source_uri);
    json << ",\"deletes\":";
    writePreparedQuadArray(json, delta.deletes);
    json << ",\"inserts\":";
    writePreparedQuadArray(json, delta.inserts);
    json << '}';
  }
  json << "]}";
  result_storage = json.str();
  mutation_count = mutations.size();
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status executePreparedSimpleLoadUpdate(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const ParsedSimpleLoadUpdate& load_update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  const auto fail = [&](xpod_rdf_status status) {
    setResult(
        out_result, status, result_storage, profile_storage, error_storage,
        kPreparedDeltaMediaType);
    return status;
  };

  if (request.has_load_document == 0 ||
      bytesView(request.load_document_source_uri) != load_update.source_iri) {
    error_storage = "prepared LOAD requires a request-provided document";
    return fail(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const std::string_view media_type = bytesView(request.load_document_media_type);
  const bool is_ntriples = loadMediaTypeIsNTriples(media_type);
  const bool is_turtle = loadMediaTypeIsTurtle(media_type);
  if (!is_ntriples && !is_turtle) {
    error_storage = "unsupported prepared LOAD document media type";
    return fail(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  std::vector<OwnedQuadMutation> prepared_mutations;
  xpod_rdf_status parse_status = is_ntriples
      ? parseNTriplesLoadDocument(
            bytesView(request.load_document_body),
            load_update.target_graph_iri, prepared_mutations, error_storage)
      : parseTurtleLoadDocument(
            bytesView(request.load_document_body),
            load_update.target_graph_iri, prepared_mutations, error_storage);
  if (parse_status != XPOD_RDF_STATUS_OK) {
    return fail(parse_status);
  }
  for (OwnedQuadMutation& mutation : prepared_mutations) {
    mutation.refreshViews();
  }
  std::map<std::string, std::string> validated_graph_sources;
  for (const OwnedQuadMutation& mutation : prepared_mutations) {
    std::string graph_iri;
    std::string source_uri;
    const xpod_rdf_status validation_status = validatePreparedUpdateMutation(
        backend, request, mutation, validated_graph_sources, graph_iri,
        source_uri, error_storage);
    if (validation_status != XPOD_RDF_STATUS_OK) {
      return fail(validation_status);
    }
  }
  std::map<std::string, bool> initial_existence_by_signature;

  BridgeUpdateTransaction transaction(backend);
  if (!transaction.beginTransaction(
          request, error_storage, /*require_transaction=*/true)) {
    return fail(transaction.status());
  }

  if (!prepared_mutations.empty()) {
    const xpod_rdf_status initial_status = rememberPreparedInitialState(
        backend, request, prepared_mutations, initial_existence_by_signature,
        error_storage);
    if (initial_status != XPOD_RDF_STATUS_OK) {
      return fail(initial_status);
    }

    std::vector<xpod_rdf_quad_mutation> mutations;
    mutations.reserve(prepared_mutations.size());
    for (const auto& owned : prepared_mutations) {
      mutations.push_back(owned.mutation);
    }

    xpod_rdf_mutation_request mutation_request = {};
    mutation_request.snapshot = request.snapshot;
    mutation_request.cancellation = request.cancellation;
    mutation_request.graph_scope = request.graph_scope;
    mutation_request.source_scope = request.source_scope;
    mutation_request.access_scope = request.access_scope;
    mutation_request.mutations = mutations.data();
    mutation_request.mutation_count = mutations.size();

    xpod_rdf_mutation_result mutation_result = {};
    const xpod_rdf_status mutation_status =
        backend.applyMutation(mutation_request, mutation_result);
    if (mutation_status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever prepared LOAD mutation failed";
      return fail(mutation_status);
    }
  }

  std::vector<PreparedNetMutation> net_mutations;
  const xpod_rdf_status net_status = collectPreparedNetDelta(
      prepared_mutations, initial_existence_by_signature, net_mutations,
      error_storage);
  if (net_status != XPOD_RDF_STATUS_OK) {
    return fail(net_status);
  }

  uint64_t mutation_count = 0;
  const xpod_rdf_status serialization_status = writePreparedDeltaJson(
      net_mutations, validated_graph_sources, result_storage,
      mutation_count, error_storage);
  if (serialization_status != XPOD_RDF_STATUS_OK) {
    return fail(serialization_status);
  }

  std::ostringstream profile;
  writeScanProfileJson(
      profile, "PreparedUpdate", "SPARQL Prepared LOAD", mutation_count);
  profile_storage = profile.str();
  if (!transaction.rollback(error_storage)) {
    return fail(transaction.status());
  }
  return setQueryResult(
      out_result, XPOD_RDF_STATUS_OK, request, result_storage,
      profile_storage, error_storage, kPreparedDeltaMediaType);
}

xpod_rdf_status collectScopedGraphRows(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const xpod_rdf_graph_scope& graph_scope,
    const xpod_rdf_access_scope* access_scope,
    std::vector<xpod_rdf_quad_key>& rows,
    std::string& error_storage) {
  xpod_rdf_scan_request scan = {};
  scan.snapshot = request.snapshot;
  scan.cancellation = request.cancellation;
  scan.permutation = XPOD_RDF_PERM_GSPO;
  scan.graph_scope = graph_scope;
  scan.source_scope = request.source_scope;
  scan.access_scope = access_scope;
  scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                      XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;

  GraphManagementScanState scan_state{&rows};
  const xpod_rdf_status status = backend.scanPermutation(
      scan, appendGraphManagementRows, &scan_state);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever graph management scan failed";
  }
  return status;
}

xpod_rdf_status collectGraphRows(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    std::string_view graph_iri,
    std::vector<xpod_rdf_quad_key>& rows,
    std::string& error_storage) {
  xpod_rdf_term graph_term = {};
  graph_term.kind = XPOD_RDF_TERM_IRI;
  graph_term.value = {graph_iri.data(), graph_iri.size()};

  xpod_rdf_term_key graph_key = 0;
  xpod_rdf_status status =
      backend.lookupTerm(graph_term, request.snapshot, graph_key);
  if (status == XPOD_RDF_STATUS_NOT_FOUND) {
    return XPOD_RDF_STATUS_OK;
  }
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever graph management graph lookup failed";
    return status;
  }

  if (!graphScopeAllowsGraph(request.graph_scope, graph_key, graph_iri)) {
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_graph_scope graph_scope = {};
  graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  graph_scope.exact_graph = graph_key;
  return collectScopedGraphRows(
      backend, request, graph_scope, request.access_scope, rows,
      error_storage);
}

xpod_rdf_status collectNamedGraphRows(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    std::vector<xpod_rdf_quad_key>& rows,
    std::string& error_storage) {
  xpod_rdf_term default_graph_term = {};
  default_graph_term.kind = XPOD_RDF_TERM_IRI;
  default_graph_term.value = {
      kQleverDefaultGraphIri.data(), kQleverDefaultGraphIri.size()};
  xpod_rdf_term_key default_graph_key = 0;
  const xpod_rdf_status lookup_status = backend.lookupTerm(
      default_graph_term, request.snapshot, default_graph_key);
  if (lookup_status == XPOD_RDF_STATUS_NOT_FOUND) {
    return collectScopedGraphRows(
        backend, request, request.graph_scope, request.access_scope, rows,
        error_storage);
  }
  if (lookup_status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever default graph lookup failed";
    return lookup_status;
  }

  xpod_rdf_access_scope access_scope = {};
  std::vector<xpod_rdf_term_key> denied_graphs;
  if (request.access_scope != nullptr) {
    access_scope = *request.access_scope;
    if (request.access_scope->denied_graphs_size > 0) {
      denied_graphs.assign(
          request.access_scope->denied_graphs,
          request.access_scope->denied_graphs +
              request.access_scope->denied_graphs_size);
    }
  }
  if (std::find(
          denied_graphs.begin(), denied_graphs.end(), default_graph_key) ==
      denied_graphs.end()) {
    denied_graphs.push_back(default_graph_key);
  }
  access_scope.denied_graphs = denied_graphs.data();
  access_scope.denied_graphs_size = denied_graphs.size();
  return collectScopedGraphRows(
      backend, request, request.graph_scope, &access_scope, rows,
      error_storage);
}

xpod_rdf_status buildGraphDeleteMutations(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const std::vector<xpod_rdf_quad_key>& rows,
    std::vector<OwnedQuadMutation>& owned_mutations,
    std::string& error_storage) {
  for (const xpod_rdf_quad_key& row : rows) {
    OwnedQuadMutation owned;
    owned.mutation.kind = XPOD_RDF_MUTATION_DELETE;
    owned.mutation.quad.has_graph = 1;
    xpod_rdf_status status = resolveMutationTerm(
        backend, row.subject, request.snapshot, owned.subject, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    status = resolveMutationTerm(
        backend, row.predicate, request.snapshot, owned.predicate,
        error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    status = resolveMutationTerm(
        backend, row.object, request.snapshot, owned.object, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    status = resolveMutationTerm(
        backend, row.graph, request.snapshot, owned.graph, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    owned.refreshViews();
    owned_mutations.push_back(std::move(owned));
    owned_mutations.back().refreshViews();
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status buildGraphInsertMutations(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const std::vector<xpod_rdf_quad_key>& rows,
    std::string_view target_graph_iri,
    std::vector<OwnedQuadMutation>& owned_mutations,
    std::string& error_storage) {
  for (const xpod_rdf_quad_key& row : rows) {
    OwnedQuadMutation owned;
    owned.mutation.kind = XPOD_RDF_MUTATION_INSERT;
    owned.mutation.quad.has_graph = 1;
    xpod_rdf_status status = resolveMutationTerm(
        backend, row.subject, request.snapshot, owned.subject, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    status = resolveMutationTerm(
        backend, row.predicate, request.snapshot, owned.predicate,
        error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    status = resolveMutationTerm(
        backend, row.object, request.snapshot, owned.object, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    setIriMutationTerm(target_graph_iri, owned.graph);
    owned.refreshViews();
    owned_mutations.push_back(std::move(owned));
    owned_mutations.back().refreshViews();
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status executeSimpleGraphCreateUpdate(
    xpod::rdf::PhysicalBackend,
    QueryExecutionContext*,
    const xpod_qlever_query_request& request,
    const ParsedSimpleGraphCreateUpdate&,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  result_storage = R"({"inserted":0,"deleted":0})";
  std::ostringstream profile;
  writeScanProfileJson(profile, "Update", "SPARQL Graph Create", 0);
  profile_storage = profile.str();
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

xpod_rdf_status executeSimpleGraphManagementUpdate(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionContext* qec,
    const xpod_qlever_query_request& request,
    const ParsedSimpleGraphManagementUpdate& update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
  std::string& error_storage) {
  std::vector<xpod_rdf_quad_key> rows;
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  switch (update.target) {
    case SimpleGraphManagementTarget::Graph:
      status = collectGraphRows(
          backend, request, update.graph_iri, rows, error_storage);
      break;
    case SimpleGraphManagementTarget::Default:
      status = collectGraphRows(
          backend, request, kQleverDefaultGraphIri, rows, error_storage);
      break;
    case SimpleGraphManagementTarget::Named:
      status = collectNamedGraphRows(
          backend, request, rows, error_storage);
      break;
    case SimpleGraphManagementTarget::All:
      status = collectScopedGraphRows(
          backend, request, request.graph_scope, request.access_scope, rows,
          error_storage);
      break;
  }
  if (status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, status, result_storage, profile_storage,
              error_storage);
    return status;
  }

  std::vector<OwnedQuadMutation> owned_mutations;
  owned_mutations.reserve(rows.size());
  status = buildGraphDeleteMutations(
      backend, request, rows, owned_mutations, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, status, result_storage, profile_storage,
              error_storage);
    return status;
  }

  uint64_t deleted_count = 0;
  if (!owned_mutations.empty()) {
    std::vector<xpod_rdf_quad_mutation> mutations;
    mutations.reserve(owned_mutations.size());
    for (const auto& owned : owned_mutations) {
      mutations.push_back(owned.mutation);
    }

    xpod_rdf_mutation_request mutation_request = {};
    mutation_request.snapshot = request.snapshot;
    mutation_request.cancellation = request.cancellation;
    mutation_request.graph_scope = request.graph_scope;
    mutation_request.source_scope = request.source_scope;
    mutation_request.access_scope = request.access_scope;
    mutation_request.mutations = mutations.data();
    mutation_request.mutation_count = mutations.size();

    xpod_rdf_mutation_result mutation_result = {};
    status = backend.applyMutation(mutation_request, mutation_result);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever graph management mutation failed";
      setResult(out_result, status, result_storage, profile_storage,
                error_storage);
      return status;
    }
    deleted_count = mutation_result.deleted_count;
    clearPlannerCacheAfterMutation(qec);
  }

  std::ostringstream json;
  json << "{\"inserted\":0,\"deleted\":" << deleted_count << "}";
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(
      profile, "Update", "SPARQL Graph Management", deleted_count);
  profile_storage = profile.str();
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

xpod_rdf_status executeSimpleGraphCopyUpdate(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionContext* qec,
    const xpod_qlever_query_request& request,
    const ParsedSimpleGraphCopyUpdate& update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  if (update.source_graph_iri == update.target_graph_iri) {
    result_storage = R"({"inserted":0,"deleted":0})";
    std::ostringstream profile;
    writeScanProfileJson(profile, "Update", "SPARQL Graph Copy", 0);
    profile_storage = profile.str();
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  }

  std::vector<xpod_rdf_quad_key> source_rows;
  xpod_rdf_status status = collectGraphRows(
      backend, request, update.source_graph_iri, source_rows, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, status, result_storage, profile_storage,
              error_storage);
    return status;
  }

  std::vector<xpod_rdf_quad_key> target_rows;
  if (update.operation == SimpleGraphCopyOperation::Copy ||
      update.operation == SimpleGraphCopyOperation::Move) {
    status = collectGraphRows(
        backend, request, update.target_graph_iri, target_rows, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      setResult(out_result, status, result_storage, profile_storage,
                error_storage);
      return status;
    }
  }

  std::vector<OwnedQuadMutation> owned_mutations;
  owned_mutations.reserve(
      source_rows.size() +
      target_rows.size() +
      (update.operation == SimpleGraphCopyOperation::Move ? source_rows.size()
                                                          : 0));

  if (!target_rows.empty()) {
    status = buildGraphDeleteMutations(
        backend, request, target_rows, owned_mutations, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      setResult(out_result, status, result_storage, profile_storage,
                error_storage);
      return status;
    }
  }

  status = buildGraphInsertMutations(
      backend, request, source_rows, update.target_graph_iri, owned_mutations,
      error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, status, result_storage, profile_storage,
              error_storage);
    return status;
  }

  if (update.operation == SimpleGraphCopyOperation::Move) {
    status = buildGraphDeleteMutations(
        backend, request, source_rows, owned_mutations, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      setResult(out_result, status, result_storage, profile_storage,
                error_storage);
      return status;
    }
  }

  uint64_t inserted_count = 0;
  uint64_t deleted_count = 0;
  if (!owned_mutations.empty()) {
    std::vector<xpod_rdf_quad_mutation> mutations;
    mutations.reserve(owned_mutations.size());
    for (const auto& owned : owned_mutations) {
      mutations.push_back(owned.mutation);
    }

    xpod_rdf_mutation_request mutation_request = {};
    mutation_request.snapshot = request.snapshot;
    mutation_request.cancellation = request.cancellation;
    mutation_request.graph_scope = request.graph_scope;
    mutation_request.source_scope = request.source_scope;
    mutation_request.access_scope = request.access_scope;
    mutation_request.mutations = mutations.data();
    mutation_request.mutation_count = mutations.size();

    xpod_rdf_mutation_result mutation_result = {};
    status = backend.applyMutation(mutation_request, mutation_result);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever graph copy mutation failed";
      setResult(out_result, status, result_storage, profile_storage,
                error_storage);
      return status;
    }
    inserted_count = mutation_result.inserted_count;
    deleted_count = mutation_result.deleted_count;
    clearPlannerCacheAfterMutation(qec);
  }

  std::ostringstream json;
  json << "{\"inserted\":" << inserted_count
       << ",\"deleted\":" << deleted_count << "}";
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(
      profile, "Update", "SPARQL Graph Copy",
      inserted_count + deleted_count);
  profile_storage = profile.str();
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

[[maybe_unused]] xpod_rdf_status appendBoundUpdateTriples(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    const updateClause::UpdateTriples& triples,
    xpod_rdf_mutation_kind kind,
    const BridgeQueryPlan& plan,
    const IdTable& table,
    const LocalVocab* local_vocab,
    const std::vector<UpdateTemplateBinding>& template_bindings,
    bool evaluate_once_without_bindings,
    std::vector<OwnedQuadMutation>& owned_mutations,
    std::string& error_storage) {
  const size_t row_count =
      evaluate_once_without_bindings && table.numRows() == 0
          ? 1
          : table.numRows();
  for (size_t row = 0; row < row_count; ++row) {
    for (const auto& triple : triples.triples_) {
      OwnedQuadMutation owned;
      owned.mutation.kind = kind;

      bool has_subject = false;
      xpod_rdf_status status = fillBoundMutationTermFromComponent(
          backend, triple.s_, plan, table, template_bindings, row,
          request.snapshot,
          owned.subject, has_subject, error_storage, local_vocab);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }

      bool has_predicate = false;
      status = fillBoundMutationTermFromComponent(
          backend, triple.p_, plan, table, template_bindings, row,
          request.snapshot,
          owned.predicate, has_predicate, error_storage, local_vocab);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }

      bool has_object = false;
      status = fillBoundMutationTermFromComponent(
          backend, triple.o_, plan, table, template_bindings, row,
          request.snapshot,
          owned.object, has_object, error_storage, local_vocab);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }

      bool has_graph = false;
      status = fillBoundMutationGraphFromUpdateGraph(
          backend, triple.g_, plan, table, template_bindings, row,
          request.snapshot,
          owned, has_graph, error_storage, local_vocab);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }

      if (!has_subject || !has_predicate || !has_object || !has_graph) {
        continue;
      }
      owned.refreshViews();
      owned_mutations.push_back(std::move(owned));
      owned_mutations.back().refreshViews();
    }
  }
  return XPOD_RDF_STATUS_OK;
}

#if XPOD_QLEVER_HAS_PREPARED_GRAPH_UPDATE
xpod_rdf_status prepareQleverUpdateMutations(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    ParsedQuery& parsed_update,
    std::vector<OwnedQuadMutation>& owned_mutations,
    std::string& error_storage) {
  if (planner_context.qec == nullptr) {
    error_storage =
        "native-qlever-tree-unavailable: QLever update requires a query execution context";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const bool has_where_pattern = updateHasWherePattern(parsed_update);
  const auto graph_update = parsed_update.updateClause().op_;
  auto native_execution = executeQleverParsedQueryWithNativeTree(
      backend, planner_context, parsed_update);
  if (!native_execution.has_value()) {
    error_storage =
        "native-qlever-tree-unavailable: unsupported QLever UPDATE WHERE execution tree";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const std::vector<UpdateTemplateBinding> template_bindings;
  const size_t binding_count =
      !has_where_pattern && native_execution->table.numRows() == 0
          ? 1
          : native_execution->table.numRows();
  owned_mutations.reserve(
      binding_count *
      (graph_update.toDelete_.triples_.size() +
       graph_update.toInsert_.triples_.size()));
  xpod_rdf_status status = appendBoundUpdateTriples(
      backend, request, graph_update.toDelete_, XPOD_RDF_MUTATION_DELETE,
      native_execution->plan, native_execution->table,
      &native_execution->local_vocab, template_bindings, !has_where_pattern,
      owned_mutations, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  status = appendBoundUpdateTriples(
      backend, request, graph_update.toInsert_, XPOD_RDF_MUTATION_INSERT,
      native_execution->plan, native_execution->table,
      &native_execution->local_vocab, template_bindings, !has_where_pattern,
      owned_mutations, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  return XPOD_RDF_STATUS_OK;
}
#endif

xpod_rdf_status executePreparedBridgeUpdate(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    std::string_view update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  const auto fail = [&](xpod_rdf_status status) {
    setResult(
        out_result, status, result_storage, profile_storage, error_storage,
        kPreparedDeltaMediaType);
    return status;
  };

  try {
    QueryExecutionContext* qec = planner_context.qec;
    ParsedSimpleLoadUpdate load_update;
    if (parseSimpleLoadUpdate(update, load_update)) {
      return executePreparedSimpleLoadUpdate(
          backend, request, load_update, out_result, result_storage,
          profile_storage, error_storage);
    }
    if (isUnsupportedPreparedUpdateLifecycle(update)) {
      error_storage =
          "prepared update v1 does not support graph lifecycle operations";
      return fail(XPOD_RDF_STATUS_UNSUPPORTED);
    }

    ad_utility::BlankNodeManager fallback_blank_node_manager;
    EncodedIriManager encoded_iri_manager;
    std::vector<ParsedQuery> parsed_updates = SparqlParser::parseUpdate(
        &fallback_blank_node_manager, &encoded_iri_manager,
        std::string(update));
    if (parsed_updates.empty()) {
      error_storage = "prepared update contains no graph update";
      return fail(XPOD_RDF_STATUS_UNSUPPORTED);
    }

    BridgeUpdateTransaction transaction(backend);
    if (!transaction.beginTransaction(
            request, error_storage, /*require_transaction=*/true)) {
      return fail(transaction.status());
    }

    std::vector<OwnedQuadMutation> prepared_mutations;
    std::map<std::string, bool> initial_existence_by_signature;
    std::map<std::string, std::string> validated_graph_sources;
    for (ParsedQuery& parsed_update : parsed_updates) {
      const xpod_qlever_query_request& operation_request =
          planner_context.native != nullptr &&
                  planner_context.native->request != nullptr
              ? *planner_context.native->request
              : request;
      if (!parsed_update.hasUpdateClause()) {
        error_storage = "prepared update operation is not a graph update";
        return fail(XPOD_RDF_STATUS_UNSUPPORTED);
      }
      const auto& graph_update = parsed_update.updateClause().op_;
      const size_t template_count =
          graph_update.toDelete_.triples_.size() +
          graph_update.toInsert_.triples_.size();
      if (template_count == 0) {
        error_storage = "prepared update has no mutation templates";
        return fail(XPOD_RDF_STATUS_UNSUPPORTED);
      }

      std::vector<OwnedQuadMutation> owned_mutations;
#if XPOD_QLEVER_HAS_PREPARED_GRAPH_UPDATE
      const xpod_rdf_status build_status = prepareQleverUpdateMutations(
          backend, planner_context, operation_request, parsed_update,
          owned_mutations, error_storage);
#else
      (void)planner_context;
      error_storage = "QLever prepared graph-update seam is unavailable";
      const xpod_rdf_status build_status = XPOD_RDF_STATUS_UNSUPPORTED;
#endif
      if (build_status != XPOD_RDF_STATUS_OK) {
        return fail(build_status);
      }
      for (const OwnedQuadMutation& mutation : owned_mutations) {
        std::string graph_iri;
        std::string source_uri;
        const xpod_rdf_status validation_status =
            validatePreparedUpdateMutation(
                backend, operation_request, mutation,
                validated_graph_sources, graph_iri, source_uri,
                error_storage);
        if (validation_status != XPOD_RDF_STATUS_OK) {
          return fail(validation_status);
        }
      }
      if (!owned_mutations.empty()) {
        const xpod_rdf_status initial_status = rememberPreparedInitialState(
            backend, operation_request, owned_mutations,
            initial_existence_by_signature, error_storage);
        if (initial_status != XPOD_RDF_STATUS_OK) {
          return fail(initial_status);
        }

        std::vector<xpod_rdf_quad_mutation> mutations;
        mutations.reserve(owned_mutations.size());
        for (const auto& owned : owned_mutations) {
          mutations.push_back(owned.mutation);
        }

        xpod_rdf_mutation_request mutation_request = {};
        mutation_request.snapshot = operation_request.snapshot;
        mutation_request.cancellation = operation_request.cancellation;
        mutation_request.graph_scope = operation_request.graph_scope;
        mutation_request.source_scope = operation_request.source_scope;
        mutation_request.access_scope = operation_request.access_scope;
        mutation_request.mutations = mutations.data();
        mutation_request.mutation_count = mutations.size();

        xpod_rdf_mutation_result mutation_result = {};
        const xpod_rdf_status mutation_status =
            backend.applyMutation(mutation_request, mutation_result);
        if (mutation_status != XPOD_RDF_STATUS_OK) {
          error_storage =
              "Xpod-backed QLever prepared update mutation failed";
          return fail(mutation_status);
        }
        clearPlannerCacheAfterMutation(qec);
        if (refreshPlannerContextAfterMutation(
                planner_context, operation_request, mutation_result)) {
          qec = planner_context.qec;
        }
      }
      prepared_mutations.insert(
          prepared_mutations.end(),
          std::make_move_iterator(owned_mutations.begin()),
          std::make_move_iterator(owned_mutations.end()));
    }
    for (OwnedQuadMutation& mutation : prepared_mutations) {
      mutation.refreshViews();
    }

    std::vector<PreparedNetMutation> net_mutations;
    const xpod_rdf_status net_status = collectPreparedNetDelta(
        prepared_mutations, initial_existence_by_signature, net_mutations,
        error_storage);
    if (net_status != XPOD_RDF_STATUS_OK) {
      return fail(net_status);
    }

    uint64_t mutation_count = 0;
    const xpod_rdf_status serialization_status = writePreparedDeltaJson(
        net_mutations, validated_graph_sources, result_storage,
        mutation_count, error_storage);
    if (serialization_status != XPOD_RDF_STATUS_OK) {
      return fail(serialization_status);
    }

    std::ostringstream profile;
    writeScanProfileJson(
        profile, "PreparedUpdate", "SPARQL Prepared Update", mutation_count);
    profile_storage = profile.str();
    if (!transaction.rollback(error_storage)) {
      return fail(transaction.status());
    }
    return setQueryResult(
        out_result, XPOD_RDF_STATUS_OK, request, result_storage,
        profile_storage, error_storage, kPreparedDeltaMediaType);
  } catch (const ad_utility::CancellationException& error) {
    error_storage = error.what();
    return fail(XPOD_RDF_STATUS_CANCELLED);
  } catch (const ad_utility::detail::AllocationExceedsLimitException& error) {
    error_storage = error.what();
    return fail(XPOD_RDF_STATUS_BACKEND_ERROR);
  } catch (const std::exception& error) {
    error_storage = "failed to prepare QLever bridge update: ";
    error_storage += error.what();
    return fail(XPOD_RDF_STATUS_UNSUPPORTED);
  } catch (...) {
    error_storage = "failed to prepare QLever bridge update";
    return fail(XPOD_RDF_STATUS_UNSUPPORTED);
  }
}

xpod_rdf_status executeBridgeUpdate(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    std::string_view update,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  QueryExecutionContext* qec = planner_context.qec;
  try {
    ad_utility::BlankNodeManager fallback_blank_node_manager;
    ad_utility::BlankNodeManager* blank_node_manager =
        &fallback_blank_node_manager;
    EncodedIriManager encoded_iri_manager;
    ParsedSimpleLoadUpdate load_update;
    if (parseSimpleLoadUpdate(update, load_update)) {
      return executeSimpleLoadUpdate(
          backend, qec, request, load_update, out_result,
          result_storage, profile_storage, error_storage);
    }
    if (startsWithAsciiKeyword(stripSparqlUpdatePrologue(update), "load")) {
      error_storage = "unsupported SPARQL LOAD";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    ParsedSimpleGraphCreateUpdate graph_create_update;
    if (parseSimpleCreateGraphUpdate(update, graph_create_update)) {
      return executeSimpleGraphCreateUpdate(
          backend, qec, request, graph_create_update, out_result,
          result_storage,
          profile_storage, error_storage);
    }
    ParsedSimpleGraphManagementUpdate graph_management_update;
    if (parseSimpleClearOrDropGraphUpdate(update, graph_management_update)) {
      return executeSimpleGraphManagementUpdate(
          backend, qec, request, graph_management_update, out_result,
          result_storage,
          profile_storage, error_storage);
    }
    ParsedSimpleGraphCopyUpdate graph_copy_update;
    if (parseSimpleAddCopyMoveGraphUpdate(update, graph_copy_update)) {
      return executeSimpleGraphCopyUpdate(
          backend, qec, request, graph_copy_update, out_result,
          result_storage,
          profile_storage, error_storage);
    }
    std::vector<ParsedQuery> parsed_updates = SparqlParser::parseUpdate(
        blank_node_manager, &encoded_iri_manager, std::string(update));
    if (parsed_updates.empty()) {
      result_storage = R"({"inserted":0,"deleted":0})";
      std::ostringstream profile;
      writeScanProfileJson(profile, "Update", "SPARQL Update", 0);
      profile_storage = profile.str();
      return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                            result_storage, profile_storage, error_storage);
    }

    uint64_t inserted_count = 0;
    uint64_t deleted_count = 0;

    BridgeUpdateTransaction transaction(backend);
    if (!transaction.beginTransaction(request, error_storage)) {
      setResult(out_result, transaction.status(), result_storage,
                profile_storage, error_storage);
      return transaction.status();
    }

    for (ParsedQuery& parsed_update : parsed_updates) {
      const xpod_qlever_query_request& operation_request =
          planner_context.native != nullptr &&
                  planner_context.native->request != nullptr
              ? *planner_context.native->request
              : request;
      if (!parsed_update.hasUpdateClause()) {
        error_storage = "SPARQL update operation is not a graph update";
        setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                  profile_storage, error_storage);
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      const auto& graph_update = parsed_update.updateClause().op_;
      size_t mutation_count = graph_update.toDelete_.triples_.size() +
                              graph_update.toInsert_.triples_.size();
      if (mutation_count == 0) {
        error_storage = "empty update has no mutations";
        setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                  profile_storage, error_storage);
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }

      std::vector<OwnedQuadMutation> owned_mutations;
#if XPOD_QLEVER_HAS_PREPARED_GRAPH_UPDATE
      const xpod_rdf_status build_status = prepareQleverUpdateMutations(
          backend, planner_context, operation_request, parsed_update,
          owned_mutations, error_storage);
#else
      error_storage = "QLever prepared graph-update seam is unavailable";
      const xpod_rdf_status build_status = XPOD_RDF_STATUS_UNSUPPORTED;
#endif
      if (build_status != XPOD_RDF_STATUS_OK) {
        setResult(out_result, build_status, result_storage, profile_storage,
                  error_storage);
        return build_status;
      }
      if (owned_mutations.empty()) {
        continue;
      }

      std::vector<xpod_rdf_quad_mutation> mutations;
      mutations.reserve(owned_mutations.size());
      for (const auto& owned : owned_mutations) {
        mutations.push_back(owned.mutation);
      }

      xpod_rdf_mutation_request mutation_request = {};
      mutation_request.snapshot = operation_request.snapshot;
      mutation_request.cancellation = operation_request.cancellation;
      mutation_request.graph_scope = operation_request.graph_scope;
      mutation_request.source_scope = operation_request.source_scope;
      mutation_request.access_scope = operation_request.access_scope;
      mutation_request.mutations = mutations.data();
      mutation_request.mutation_count = mutations.size();

      xpod_rdf_mutation_result mutation_result = {};
      xpod_rdf_status status = backend.applyMutation(
          mutation_request, mutation_result);
      if (status != XPOD_RDF_STATUS_OK) {
        error_storage = "Xpod-backed QLever update mutation failed";
        setResult(out_result, status, result_storage, profile_storage,
                  error_storage);
        return status;
      }
      inserted_count += mutation_result.inserted_count;
      deleted_count += mutation_result.deleted_count;
      clearPlannerCacheAfterMutation(qec);
      if (refreshPlannerContextAfterMutation(
              planner_context, operation_request, mutation_result)) {
        qec = planner_context.qec;
      }
    }

    std::ostringstream json;
    json << "{\"inserted\":" << inserted_count
         << ",\"deleted\":" << deleted_count << "}";
    result_storage = json.str();
    std::ostringstream profile;
    writeScanProfileJson(
        profile, "Update", "SPARQL Update",
        inserted_count + deleted_count);
    profile_storage = profile.str();
    if (!transaction.commit(error_storage)) {
      setResult(out_result, transaction.status(), result_storage,
                profile_storage, error_storage);
      return transaction.status();
    }
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  } catch (const ad_utility::CancellationException& error) {
    error_storage = error.what();
    setResult(out_result, XPOD_RDF_STATUS_CANCELLED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_CANCELLED;
  } catch (const ad_utility::detail::AllocationExceedsLimitException& error) {
    error_storage = error.what();
    setResult(out_result, XPOD_RDF_STATUS_BACKEND_ERROR, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  } catch (const std::exception& error) {
    error_storage = "failed to parse QLever bridge update: ";
    error_storage += error.what();
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } catch (...) {
    error_storage = "failed to parse QLever bridge update";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
}

}  // namespace

uint64_t xpodQleverDiagnosticsStageStart() noexcept {
  return qleverDiagnosticsStageStartImpl();
}

void xpodQleverDiagnosticsStageFinish(
    const char* stage,
    uint64_t started_at_ns) noexcept {
  qleverDiagnosticsStageFinishImpl(stage, started_at_ns);
}

void xpodQleverDiagnosticsReset() noexcept {
  xpodQleverDiagnosticsResetImpl();
}

void xpodQleverDiagnosticsEnable() noexcept {
  xpodQleverDiagnosticsEnableImpl();
}

void xpodQleverDiagnosticsDisable() noexcept {
  xpodQleverDiagnosticsDisableImpl();
}

std::string xpodQleverDiagnosticsJson() {
  return xpodQleverDiagnosticsJsonImpl();
}

xpod_rdf_status executeBridgeQuery(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  return executeBridgeQueryWithPlannerContext(
      backend, {}, request, out_result, result_storage, profile_storage,
      error_storage);
}

bool preferBoundedPhysicalBridge(
    const xpod::rdf::PhysicalBackend& backend,
    ParsedQuery& parsed,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    std::string&,
    BridgeQueryPlan& plan,
    xpod_rdf_status& parse_status) {
  if (parsed._orderBy.empty() || parsed._limitOffset.isUnconstrained()) {
    return false;
  }
  std::string candidate_error_storage;
  parse_status = planBridgeParsedQuery(
      parsed, planner_context, candidate_error_storage, plan, true);
  BridgeQueryPlan probe_plan = plan;
  xpod_rdf_status candidate_status = parse_status;
  if (candidate_status == XPOD_RDF_STATUS_OK) {
    applyBridgeRequestContext(
        probe_plan, request.snapshot, request.cancellation, request.graph_scope,
        request.source_scope, request.access_scope);
    candidate_status = bindPlanTerms(
        backend, request.snapshot, probe_plan, candidate_error_storage);
  }
  const bool has_filter_fallback = candidate_status == XPOD_RDF_STATUS_OK &&
      probe_plan.physical_filter_fallback.has_value();
  const bool semantic_order = candidate_status == XPOD_RDF_STATUS_OK &&
      !has_filter_fallback &&
      probe_plan.root.kind == BridgeOperationKind::PermutationScan &&
      canPushSemanticOrderPage(backend, probe_plan.root);
  const bool physical_filter = candidate_status == XPOD_RDF_STATUS_OK &&
      !has_filter_fallback &&
      canUsePhysicalFilterBridge(backend, probe_plan);
  const bool preferred = candidate_status == XPOD_RDF_STATUS_OK &&
      (semantic_order || physical_filter);
  if (!preferred && candidate_status == XPOD_RDF_STATUS_OK) {
    recordQleverPhysicalFilterFallback(plan.physical_filter_fallback);
  }
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "xpod bounded physical candidate: status=%d root=%d "
        "modifiers=%zu semanticOrder=%d physicalFilter=%d preferred=%d\n",
        static_cast<int>(candidate_status),
        static_cast<int>(probe_plan.root.kind),
        probe_plan.root.result_modifiers.size(), semantic_order ? 1 : 0,
        physical_filter ? 1 : 0, preferred ? 1 : 0);
    for (size_t index = 0; index < probe_plan.root.result_modifiers.size();
         ++index) {
      std::fprintf(
          stderr, "xpod bounded physical modifier[%zu]=%d\n", index,
          static_cast<int>(probe_plan.root.result_modifiers[index].kind));
    }
  }
  return preferred;
}

bool preferParameterizedJoinBridge(
    const xpod::rdf::PhysicalBackend& backend,
    ParsedQuery& parsed,
    PlannerContextHandle planner_context,
    std::string& error_storage,
    BridgeQueryPlan& plan,
    xpod_rdf_status& parse_status) {
  if (!backend.supportsTermTupleFilter()) {
    return false;
  }
  const auto isParameterizedJoinPlan = [](const BridgeQueryPlan& candidate) {
    const bool hash_join =
        candidate.root.kind == BridgeOperationKind::HashJoin &&
        (candidate.root.scan_indexes.size() >= 2 ||
         (!candidate.root.native_result_only &&
          candidate.child_plans.size() == 2));
    bool multi_column_join = false;
    if (candidate.root.kind == BridgeOperationKind::MultiColumnJoin &&
        candidate.child_plans.size() == 2) {
      const BridgeOperationPlan& right = candidate.child_plans[1].root;
      multi_column_join =
          right.kind == BridgeOperationKind::PermutationScan &&
          right.scan_indexes.size() == 1 &&
          right.result_modifiers.empty() &&
          !right.has_limit &&
          !right.has_distinct &&
          right.children.empty();
    }
    return (hash_join || multi_column_join) &&
        candidate.text_sources.empty() &&
        candidate.vector_sources.empty();
  };
  BridgeQueryPlan direct_plan;
  std::string direct_plan_error;
  const xpod_rdf_status direct_status = planBridgeParsedQuery(
      parsed, planner_context, direct_plan_error, direct_plan, true);
  if (direct_status == XPOD_RDF_STATUS_OK &&
      isParameterizedJoinPlan(direct_plan)) {
    plan = std::move(direct_plan);
    parse_status = direct_status;
    error_storage.clear();
    return true;
  }

  parse_status = planBridgeParsedQuery(
      parsed, planner_context, error_storage, plan);
  return parse_status == XPOD_RDF_STATUS_OK &&
      isParameterizedJoinPlan(plan);
}

xpod_rdf_status executeBridgePlannedQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    const xpod_qlever_query_request& request,
    BridgeQueryPlan plan,
    xpod_rdf_status parse_status,
    bool is_ask_query,
    ExecutionMode mode,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  setCurrentExecutionMode(mode);
  if (parse_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, parse_status, result_storage, profile_storage,
              error_storage);
    return parse_status;
  }
  applyBridgeRequestContext(
      plan, request.snapshot, request.cancellation, request.graph_scope,
      request.source_scope, request.access_scope);
  xpod_rdf_status bind_status = bindPlanTerms(
      backend, request.snapshot, plan, error_storage);
  if (bind_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, bind_status, result_storage, profile_storage,
              error_storage);
    return bind_status;
  }
  if (plan.known_empty) {
    std::ostringstream json;
    if (is_ask_query) {
      writeAskSparqlJson(json, false);
    } else {
      writeEmptySparqlJson(json, plan.output_variables);
    }
    result_storage = json.str();
    std::ostringstream profile;
    writeScanProfileJson(
        profile, profileKind(plan.root.kind), plan.descriptor, 0,
        "computed", {}, {}, mode);
    profile_storage = profile.str();
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  }
  BridgePhysicalPlan physical_plan = toBridgePhysicalPlan(plan);
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "xpod bridge physical plan: root=%d scans=%zu scan_indexes=%zu "
        "children=%zu filter_scans=%zu\n",
        static_cast<int>(physical_plan.root.kind),
        physical_plan.scans.size(),
        physical_plan.root.scan_indexes.size(),
        physical_plan.root.children.size(),
        plan.filter_scans.size());
  }
  if (isBridgeCandidateRoot(plan.root.kind)) {
    BridgePhysicalResult candidate_result = executeBridgePhysicalPlan(
        backend, physical_plan);
    if (candidate_result.status != XPOD_RDF_STATUS_OK) {
      error_storage = "Xpod-backed QLever candidate operation failed";
      setResult(out_result, candidate_result.status, result_storage,
                profile_storage, error_storage);
      return candidate_result.status;
    }
    xpod_rdf_status candidate_status = writeCandidateSparqlJson(
        backend, plan, physical_plan, candidate_result, request.snapshot,
        result_storage, profile_storage, error_storage, mode);
    return setQueryResult(out_result, candidate_status, request, result_storage,
                          profile_storage, error_storage);
  }

  QleverResultWithStatus result = executeBridgeOperationPlan(
      backend, physical_plan);
  if (result.status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever operation failed";
    setResult(out_result, result.status, result_storage, profile_storage,
              error_storage);
    return result.status;
  }

  MaterializedQleverResult materialized_output = materializeQleverResult(
      result.result, plan.output_variables.size());
  const IdTable* output_table = &materialized_output.table;

  if (is_ask_query) {
    std::ostringstream json;
    writeAskSparqlJson(json, output_table->numRows() != 0);
    result_storage = json.str();
    std::ostringstream profile;
    const std::string_view details =
        (plan.root.kind == BridgeOperationKind::HashJoin ||
         plan.root.kind == BridgeOperationKind::MultiColumnJoin)
            ? bridgeOperationDetailsJson()
            : std::string_view{};
    writeScanProfileJson(
        profile, profileKind(plan.root.kind), plan.descriptor,
        output_table->numRows(), "computed", {}, details, mode);
    profile_storage = profile.str();
    return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                          result_storage, profile_storage, error_storage);
  }

  std::vector<ResolvedQleverBinding> terms;
  xpod_rdf_status resolve_status = resolveIdTableTerms(
      backend, *output_table, request.snapshot, terms, error_storage,
      &materialized_output.local_vocab);
  if (resolve_status != XPOD_RDF_STATUS_OK) {
    setResult(out_result, resolve_status, result_storage, profile_storage,
              error_storage);
    return resolve_status;
  }

  if (plan.output_variables.size() != output_table->numColumns()) {
    error_storage = "QLever bridge result columns do not match output variables";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::ostringstream json;
  writeSparqlJson(json, *output_table, terms, plan.output_variables);
  result_storage = json.str();
  std::ostringstream profile;
  const std::string_view details =
      (plan.root.kind == BridgeOperationKind::HashJoin ||
       plan.root.kind == BridgeOperationKind::MultiColumnJoin)
          ? bridgeOperationDetailsJson()
          : std::string_view{};
  writeScanProfileJson(
      profile, profileKind(plan.root.kind), plan.descriptor,
      output_table->numRows(), "computed", {}, details, mode);
  profile_storage = profile.str();
  return setQueryResult(out_result, XPOD_RDF_STATUS_OK, request,
                        result_storage, profile_storage, error_storage);
}

xpod_rdf_status executeNativeQleverQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  xpodQleverDiagnosticsResetRequestStateImpl();
  setCurrentExecutionMode(ExecutionMode::NativeQleverTree);
  result_storage.clear();
  profile_storage.clear();
  error_storage.clear();

  if (request.operation != XPOD_QLEVER_REQUEST_EXECUTE &&
      request.operation != XPOD_QLEVER_REQUEST_PREPARE_UPDATE &&
      request.operation != XPOD_QLEVER_REQUEST_QUERY_ONLY) {
    error_storage = "unsupported native QLever request operation";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::string_view query = bytesView(request.sparql);
  if (looksLikeSparqlUpdate(query)) {
    if (request.operation == XPOD_QLEVER_REQUEST_QUERY_ONLY) {
      error_storage = "update_authority_required";
      setResult(out_result, XPOD_RDF_STATUS_PERMISSION_DENIED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_PERMISSION_DENIED;
    }
    if (request.vector_query != nullptr) {
      error_storage = "Xpod vector query cannot be used with SPARQL UPDATE";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE) {
      setCurrentExecutionMode(ExecutionMode::NativeQleverPreparedUpdate);
      return executePreparedBridgeUpdate(
          backend, planner_context, request, query, out_result,
          result_storage, profile_storage, error_storage);
    }
    setCurrentExecutionMode(ExecutionMode::NativeQleverUpdate);
    return executeBridgeUpdate(
        backend, planner_context, request, query, out_result,
        result_storage, profile_storage, error_storage);
  }
  if (request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE) {
    error_storage = "prepareUpdate requires a SPARQL graph update";
    setResult(
        out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
        profile_storage, error_storage, kPreparedDeltaMediaType);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  try {
    EncodedIriManager encoded_iri_manager;
    std::optional<ParsedQuery> parsed_query;
    xpod_rdf_status vector_status = XPOD_RDF_STATUS_OK;
    {
      ScopedQleverDiagnosticsStage parse_plan_stage("parse-plan");
      parsed_query.emplace(
          SparqlParser::parseQuery(&encoded_iri_manager, std::string(query)));
      vector_status =
          appendVectorQuerySource(request, *parsed_query, error_storage);
    }
    if (vector_status != XPOD_RDF_STATUS_OK) {
      setResult(out_result, vector_status, result_storage, profile_storage,
                error_storage);
      return vector_status;
    }
    if (planner_context.native == nullptr && planner_context.qec == nullptr) {
      error_storage =
          "native-qlever-tree-unavailable: QLever planner context unavailable";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    std::optional<NativeQleverExecution> native_execution =
        executeQleverParsedQueryWithNativeTree(
            backend, planner_context, *parsed_query);
    if (!native_execution.has_value()) {
      error_storage =
          "native-qlever-tree-unavailable: unsupported QLever native execution tree";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return writeNativeQleverExecutionResult(
        backend, request, *parsed_query, *native_execution, out_result,
        result_storage, profile_storage, error_storage);
#if XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
  } catch (const XpodQleverVectorExecutionError& error) {
    error_storage = error.what();
    setResult(out_result, error.status(), result_storage, profile_storage,
              error_storage);
    return error.status();
#endif
  } catch (const ad_utility::CancellationException& error) {
    error_storage = error.what();
    setResult(out_result, XPOD_RDF_STATUS_CANCELLED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_CANCELLED;
  } catch (const ad_utility::detail::AllocationExceedsLimitException& error) {
    error_storage = error.what();
    setResult(out_result, XPOD_RDF_STATUS_BACKEND_ERROR, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  } catch (const std::exception& error) {
    const std::string_view message = error.what();
    constexpr std::string_view allocation_prefix = "Tried to allocate ";
    if (message.size() >= allocation_prefix.size() &&
        message.substr(0, allocation_prefix.size()) == allocation_prefix &&
        message.find(" were available") != std::string_view::npos) {
      error_storage = error.what();
      setResult(out_result, XPOD_RDF_STATUS_BACKEND_ERROR, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    error_storage = "failed to parse QLever native query: ";
    error_storage += error.what();
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } catch (...) {
    error_storage = "failed to parse QLever native query";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
}

xpod_rdf_status executeBridgeQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  xpodQleverDiagnosticsResetRequestStateImpl();
  setCurrentExecutionMode(ExecutionMode::CompatibilityOperationPlan);
  result_storage.clear();
  profile_storage.clear();
  error_storage.clear();

  std::string_view query = bytesView(request.sparql);
  if (looksLikeSparqlUpdate(query)) {
    if (request.operation == XPOD_QLEVER_REQUEST_QUERY_ONLY) {
      error_storage = "update_authority_required";
      setResult(out_result, XPOD_RDF_STATUS_PERMISSION_DENIED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_PERMISSION_DENIED;
    }
    if (request.vector_query != nullptr) {
      error_storage = "Xpod vector query cannot be used with SPARQL UPDATE";
      setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE) {
      return executePreparedBridgeUpdate(
          backend, planner_context, request, query, out_result,
          result_storage, profile_storage, error_storage);
    }
    return executeBridgeUpdate(
        backend, planner_context, request, query, out_result, result_storage,
        profile_storage, error_storage);
  }
  if (request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE) {
    error_storage = "prepareUpdate requires a SPARQL graph update";
    setResult(
        out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
        profile_storage, error_storage, kPreparedDeltaMediaType);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  BridgeQueryPlan plan;
  xpod_rdf_status parse_status = XPOD_RDF_STATUS_OK;
  bool is_ask_query = false;
  bool prefer_bounded_physical = false;
  bool prefer_parameterized_join = false;
  BridgePlanOrigin plan_origin = BridgePlanOrigin::OperationPlan;
  ExecutionMode selected_mode = ExecutionMode::CompatibilityOperationPlan;
  try {
    EncodedIriManager encoded_iri_manager;
    auto parsed = SparqlParser::parseQuery(&encoded_iri_manager, std::string(query));
    const xpod_rdf_status vector_status =
        appendVectorQuerySource(request, parsed, error_storage);
    if (vector_status != XPOD_RDF_STATUS_OK) {
      setResult(out_result, vector_status, result_storage, profile_storage,
                error_storage);
      return vector_status;
    }
    is_ask_query = parsed.hasAskClause();
    prefer_bounded_physical = preferBoundedPhysicalBridge(
        backend, parsed, planner_context, request, error_storage, plan,
        parse_status);
    if (prefer_bounded_physical) {
      selected_mode = ExecutionMode::CompatibilityBoundedPhysical;
    }
    if (!prefer_bounded_physical && request.vector_query == nullptr) {
      std::string parameterized_join_probe_error;
      prefer_parameterized_join = preferParameterizedJoinBridge(
          backend, parsed, planner_context, parameterized_join_probe_error,
          plan, parse_status);
      if (prefer_parameterized_join) {
        selected_mode = ExecutionMode::CompatibilityParameterizedJoin;
      }
    }
    std::optional<NativeQleverExecution> native_execution;
    if (!prefer_bounded_physical && !prefer_parameterized_join) {
      try {
        native_execution = executeQleverParsedQueryWithNativeTree(
            backend, planner_context, parsed);
#if XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
      } catch (const XpodQleverVectorExecutionError&) {
        throw;
#endif
      } catch (const std::exception&) {
        native_execution = std::nullopt;
      } catch (...) {
        native_execution = std::nullopt;
      }
    }
    if (native_execution.has_value()) {
      selected_mode = ExecutionMode::NativeQleverTree;
      return writeNativeQleverExecutionResult(
          backend, request, parsed, *native_execution, out_result,
          result_storage, profile_storage, error_storage);
    }
    if (parsed.hasConstructClause()) {
      selected_mode = ExecutionMode::CompatibilityParsedBgp;
      return executeConstructBridgeQuery(
          backend, request, parsed, out_result, result_storage,
          profile_storage, error_storage);
    }
    if (!prefer_bounded_physical && !prefer_parameterized_join) {
      parse_status = planBridgeParsedQuery(
          parsed, planner_context, error_storage, plan, false, &plan_origin);
      selected_mode = executionModeForPlanOrigin(plan_origin);
    }
#if XPOD_QLEVER_ADAPTER_ENABLE_VECTOR
  } catch (const XpodQleverVectorExecutionError& error) {
    error_storage = error.what();
    setResult(out_result, error.status(), result_storage, profile_storage,
              error_storage);
    return error.status();
#endif
  } catch (const std::exception& error) {
    error_storage = "failed to parse QLever bridge query: ";
    error_storage += error.what();
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } catch (...) {
    error_storage = "failed to parse QLever bridge query";
    setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
              profile_storage, error_storage);
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  return executeBridgePlannedQueryWithPlannerContext(
      backend, request, std::move(plan), parse_status, is_ask_query,
      selected_mode, out_result, result_storage, profile_storage,
      error_storage);
}

xpod_rdf_status executeBridgeQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    QueryExecutionContext* planner_context,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  return executeBridgeQueryWithPlannerContext(
      backend, {planner_context, nullptr}, request, out_result, result_storage,
      profile_storage, error_storage);
}

}  // namespace xpod::qlever
