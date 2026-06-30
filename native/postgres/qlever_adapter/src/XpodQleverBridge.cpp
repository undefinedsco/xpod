#include "XpodQleverBridge.hpp"
#include "XpodCandidateBridge.hpp"
#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverPermutationMap.hpp"
#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverOperationExecutor.hpp"
#include "XpodQleverOperationIntrospection.hpp"
#include "XpodQleverOperationPlanBridge.hpp"
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
#include "index/EncodedIriManager.h"
#include "index/Index.h"
#include "libqlever/Qlever.h"
#include "parser/SparqlParser.h"

#include <exception>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
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

xpod_rdf_status planBridgeParsedQuery(
    ParsedQuery& parsed,
    PlannerContextHandle planner_context,
    std::string& error_storage,
    BridgeQueryPlan& out_plan) {
  auto plan = planQleverParsedQueryWithAvailablePlanner(
      planner_context, parsed);
  if (!plan.has_value()) {
    plan = planParsedQuery(parsed);
  }
  if (!plan.has_value()) {
    error_storage = "unsupported QLever bridge query";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  out_plan = *plan;
  return XPOD_RDF_STATUS_OK;
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
    const xpod_rdf_snapshot& snapshot,
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

void writeSparqlJson(
    std::ostringstream& out,
    const IdTable& table,
    const std::vector<xpod_rdf_term>& terms,
    const std::vector<std::string>& variables) {
  writeSparqlHead(out, variables);
  out << '[';
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

void writeScanProfileJson(
    std::ostringstream& out,
    std::string_view kind,
    std::string_view descriptor,
    uint64_t output_rows) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"root\":{\"kind\":";
  writeJsonString(out, kind);
  out << ",\"descriptor\":";
  writeJsonString(out, descriptor);
  out << ",\"outputRows\":" << output_rows << "}}";
}

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
    IdTable& out_table) {
  std::vector<Id> row;
  row.reserve(columns.size());
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    row.clear();
    xpod_rdf_status status = appendCandidateProjection(
        backend, candidate, columns, row);
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
    std::string& error_storage) {
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
  xpod_rdf_status status = candidateRowsToIdTable(
      backend, physical_result.candidates->candidates, *columns, output_table);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to project QLever bridge candidate rows";
    return status;
  }

  std::vector<xpod_rdf_term> terms;
  status = resolveIdTableTerms(
      backend, output_table, snapshot, terms, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }

  std::ostringstream json;
  writeSparqlJson(json, output_table, terms, plan.output_variables);
  result_storage = json.str();
  std::ostringstream profile;
  writeScanProfileJson(
      profile, profileKind(plan.root.kind), plan.descriptor,
      output_table.numRows());
  profile_storage = profile.str();
  return XPOD_RDF_STATUS_OK;
}

[[maybe_unused]] void appendIdTableRows(IdTable& target, const IdTable& source) {
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
    size_t result_width) {
  IdTable table = makeQleverIdTable(result_width);
  if constexpr (HasIsFullyMaterialized<ResultT>::value) {
    if (result.isFullyMaterialized()) {
      appendIdTableRows(table, result.idTable());
      return table;
    }
  }
  if constexpr (HasLazyIdTables<ResultT>::value) {
    auto chunks = result.idTables();
    while (auto chunk = chunks.get()) {
      appendIdTableRows(table, chunk->idTable_);
    }
    return table;
  }
  appendIdTableRows(table, result.idTable());
  return table;
}

template <typename Tree, typename = void>
struct HasLazyTreeResult : std::false_type {};

template <typename Tree>
struct HasLazyTreeResult<
    Tree,
    decltype(void(std::declval<const Tree&>().getResult(true)))>
    : std::true_type {};

struct NativeQleverExecution {
  BridgeQueryPlan plan;
  IdTable table;

  NativeQleverExecution(BridgeQueryPlan plan, IdTable table)
      : plan(std::move(plan)), table(std::move(table)) {}
};

template <typename Planner>
std::optional<NativeQleverExecution> executeQleverPlannerTree(
    Planner& planner,
    ParsedQuery& parsed) {
  using Tree = decltype(planner.createExecutionTree(parsed));
  Tree tree = planner.createExecutionTree(parsed);
  if (tree.isEmpty()) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(tree);
  if (!plan.has_value() || isBridgeCandidateRoot(plan->root.kind)) {
    return std::nullopt;
  }
  if constexpr (!HasLazyTreeResult<Tree>::value) {
    return std::nullopt;
  } else {
    auto result = tree.getResult(true);
    if (result == nullptr) {
      return std::nullopt;
    }
    IdTable table = materializeQleverResultTable(*result, plan->result_width);
    return NativeQleverExecution{std::move(*plan), std::move(table)};
  }
}

#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
template <typename Planner, bool IsNativeContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    const PlannerRequestContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct NativeContextQleverExecution {
  static std::optional<NativeQleverExecution> execute(
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    (void)context;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct NativeContextQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    if (context == nullptr) {
      return std::nullopt;
    }
    Planner planner(
        context, detail::makeQleverCancellationHandle(context->cancellation));
    return executeQleverPlannerTree(planner, parsed);
  }
};

template <typename Planner, bool IsContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    QueryExecutionContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct ContextQleverExecution {
  static std::optional<NativeQleverExecution> execute(
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    (void)qec;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct ContextQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    if (qec == nullptr) {
      return std::nullopt;
    }
    Planner planner(qec, detail::makeQleverCancellationHandle(nullptr));
    return executeQleverPlannerTree(planner, parsed);
  }
};
#endif

template <typename Planner, bool IsDefaultConstructible =
                                std::is_default_constructible<Planner>::value>
struct DefaultQleverExecution {
  static std::optional<NativeQleverExecution> execute(ParsedQuery& parsed) {
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct DefaultQleverExecution<Planner, true> {
  static std::optional<NativeQleverExecution> execute(ParsedQuery& parsed) {
    Planner planner;
    return executeQleverPlannerTree(planner, parsed);
  }
};

std::optional<NativeQleverExecution> executeQleverParsedQueryWithNativeTree(
    PlannerContextHandle context,
    ParsedQuery& parsed) {
  if (!parsed.hasSelectClause()) {
    return std::nullopt;
  }
  (void)context;
#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
  if (context.native != nullptr) {
    auto native_result =
        NativeContextQleverExecution<QueryPlanner>::execute(
            context.native, parsed);
    if (native_result.has_value()) {
      return native_result;
    }
  }
  if (context.qec != nullptr) {
    auto qec_result =
        ContextQleverExecution<QueryPlanner>::execute(context.qec, parsed);
    if (qec_result.has_value()) {
      return qec_result;
    }
  }
#endif
  return DefaultQleverExecution<QueryPlanner>::execute(parsed);
}

}  // namespace

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

xpod_rdf_status executeBridgeQueryWithPlannerContext(
    xpod::rdf::PhysicalBackend backend,
    PlannerContextHandle planner_context,
    const xpod_qlever_query_request& request,
    xpod_qlever_query_result& out_result,
    std::string& result_storage,
    std::string& profile_storage,
    std::string& error_storage) {
  result_storage.clear();
  profile_storage.clear();
  error_storage.clear();

  std::string_view query = bytesView(request.sparql);
  BridgeQueryPlan plan;
  xpod_rdf_status parse_status = XPOD_RDF_STATUS_OK;
  try {
    EncodedIriManager encoded_iri_manager;
    auto parsed = SparqlParser::parseQuery(&encoded_iri_manager, std::string(query));
    std::optional<NativeQleverExecution> native_execution;
    try {
      native_execution =
          executeQleverParsedQueryWithNativeTree(planner_context, parsed);
    } catch (const std::exception& error) {
      error_storage = "failed to execute QLever native tree: ";
      error_storage += error.what();
      setResult(out_result, XPOD_RDF_STATUS_BACKEND_ERROR, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    } catch (...) {
      error_storage = "failed to execute QLever native tree";
      setResult(out_result, XPOD_RDF_STATUS_BACKEND_ERROR, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    if (native_execution.has_value()) {
      applyBridgeRequestContext(
          native_execution->plan, request.snapshot, request.cancellation,
          request.graph_scope, request.source_scope, request.access_scope);
      const IdTable& output_table = native_execution->table;
      std::vector<xpod_rdf_term> terms;
      xpod_rdf_status resolve_status = resolveIdTableTerms(
          backend, output_table, request.snapshot, terms, error_storage);
      if (resolve_status != XPOD_RDF_STATUS_OK) {
        setResult(out_result, resolve_status, result_storage, profile_storage,
                  error_storage);
        return resolve_status;
      }
      if (native_execution->plan.output_variables.size() !=
          output_table.numColumns()) {
        error_storage =
            "QLever native result columns do not match output variables";
        setResult(out_result, XPOD_RDF_STATUS_UNSUPPORTED, result_storage,
                  profile_storage, error_storage);
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      std::ostringstream json;
      writeSparqlJson(
          json, output_table, terms, native_execution->plan.output_variables);
      result_storage = json.str();
      std::ostringstream profile;
      writeScanProfileJson(
          profile, profileKind(native_execution->plan.root.kind),
          native_execution->plan.descriptor, output_table.numRows());
      profile_storage = profile.str();
      setResult(out_result, XPOD_RDF_STATUS_OK, result_storage,
                profile_storage, error_storage);
      return XPOD_RDF_STATUS_OK;
    }
    parse_status = planBridgeParsedQuery(
        parsed, planner_context, error_storage, plan);
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
    writeEmptySparqlJson(json, plan.output_variables);
    result_storage = json.str();
    std::ostringstream profile;
    writeScanProfileJson(profile, profileKind(plan.root.kind), plan.descriptor, 0);
    profile_storage = profile.str();
    setResult(out_result, XPOD_RDF_STATUS_OK, result_storage, profile_storage,
              error_storage);
    return XPOD_RDF_STATUS_OK;
  }
  BridgePhysicalPlan physical_plan = toBridgePhysicalPlan(plan);
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
        result_storage, profile_storage, error_storage);
    setResult(out_result, candidate_status, result_storage, profile_storage,
              error_storage);
    return candidate_status;
  }

  QleverResultWithStatus result = executeBridgeOperationPlan(
      backend, physical_plan);
  if (result.status != XPOD_RDF_STATUS_OK) {
    error_storage = "Xpod-backed QLever operation failed";
    setResult(out_result, result.status, result_storage, profile_storage,
              error_storage);
    return result.status;
  }

  const IdTable* output_table = &result.result.idTable();

  std::vector<xpod_rdf_term> terms;
  xpod_rdf_status resolve_status = resolveIdTableTerms(
      backend, *output_table, request.snapshot, terms, error_storage);
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
  writeScanProfileJson(
      profile, profileKind(plan.root.kind), plan.descriptor,
      output_table->numRows());
  profile_storage = profile.str();
  setResult(out_result, XPOD_RDF_STATUS_OK, result_storage, profile_storage,
            error_storage);
  return XPOD_RDF_STATUS_OK;
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
