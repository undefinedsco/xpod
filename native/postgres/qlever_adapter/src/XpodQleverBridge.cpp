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
  return isQleverUndefinedIdValue(id);
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
      if (isQleverUndefinedId(table(row, column))) {
        continue;
      }
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

void writeAskSparqlJson(std::ostringstream& out, bool result) {
  out << "{\"engine\":\"xpod-qlever-bridge\",\"head\":{},\"boolean\":"
      << (result ? "true" : "false") << '}';
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

struct NativeQleverExecution {
  BridgeQueryPlan plan;
  IdTable table;

  NativeQleverExecution(BridgeQueryPlan plan, IdTable table)
      : plan(std::move(plan)), table(std::move(table)) {}
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

xpod_rdf_status planBridgeParsedQuery(
    ParsedQuery& parsed,
    PlannerContextHandle planner_context,
    std::string& error_storage,
    BridgeQueryPlan& out_plan) {
  std::optional<BridgeQueryPlan> plan;
  std::string planner_error;
  try {
    plan = planQleverParsedQueryWithAvailablePlanner(planner_context, parsed);
  } catch (const std::exception& error) {
    planner_error = error.what();
  } catch (...) {
    planner_error = "unknown planner error";
  }
  if (!plan.has_value()) {
    if (parsed.hasAskClause()) {
      plan = planParsedAskQuery(parsed);
    } else {
      plan = planParsedQuery(parsed);
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

inline bool hasBridgeTermFilterModifier(const BridgeOperationPlan& root) {
  for (const BridgeResultModifier& modifier : root.result_modifiers) {
    if (modifier.kind == BridgeResultModifierKind::EqualTerm ||
        modifier.kind == BridgeResultModifierKind::NotEqualTerm) {
      return true;
    }
  }
  for (const BridgeOperationPlan& child : root.children) {
    if (hasBridgeTermFilterModifier(child)) {
      return true;
    }
  }
  return false;
}

template <typename Planner>
std::optional<NativeQleverExecution> executeQleverPlannerTree(
    const xpod::rdf::PhysicalBackend& backend,
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
  size_t qlever_result_width = plan->result_width;
  std::optional<BridgeResultModifier> selected_projection;
  std::optional<std::vector<std::string>> selected =
      selectedVariablesFromParsedQuery(parsed);
  if (selected.has_value()) {
    BridgeResultModifier projection;
    projection.kind = BridgeResultModifierKind::Project;
    projection.columns.reserve(selected->size());
    for (const std::string& variable : *selected) {
      std::optional<ColumnIndex> column =
          outputColumnForVariable(plan->output_variables, variable);
      if (!column.has_value()) {
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
  if (!appendParsedPublicModifiers(*plan, parsed, selected_projection)) {
    return std::nullopt;
  }
  if (selected.has_value()) {
    plan->output_variables = *selected;
    plan->result_width = plan->output_variables.size();
  }
  if (hasBridgeTermFilterModifier(plan->root)) {
    return std::nullopt;
  }
  if constexpr (!HasLazyTreeResult<Tree>::value) {
    return std::nullopt;
  } else {
    auto result = tree.getResult(true);
    if (result == nullptr) {
      return std::nullopt;
    }
    IdTable table = materializeQleverResultTable(*result, qlever_result_width);
    if (!plan->root.result_modifiers.empty()) {
      QleverResultWithStatus modified = applyBridgeResultModifiers(
          backend, plan->root,
          toQleverResult({XPOD_RDF_STATUS_OK, std::move(table)},
                         plan->sorted_by));
      if (modified.status != XPOD_RDF_STATUS_OK) {
        return std::nullopt;
      }
      table = materializeQleverResultTable(
          modified.result, modified.result.idTable().numColumns());
    }
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
    return executeQleverPlannerTree(backend, planner, parsed);
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
    return executeQleverPlannerTree(backend, planner, parsed);
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
  if (!parsed.hasSelectClause()) {
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
  bool is_ask_query = false;
  try {
    EncodedIriManager encoded_iri_manager;
    auto parsed = SparqlParser::parseQuery(&encoded_iri_manager, std::string(query));
    is_ask_query = parsed.hasAskClause();
    std::optional<NativeQleverExecution> native_execution;
    try {
      native_execution =
          executeQleverParsedQueryWithNativeTree(
              backend, planner_context, parsed);
    } catch (const std::exception&) {
      native_execution = std::nullopt;
    } catch (...) {
      native_execution = std::nullopt;
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
    if (is_ask_query) {
      writeAskSparqlJson(json, false);
    } else {
      writeEmptySparqlJson(json, plan.output_variables);
    }
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

  if (is_ask_query) {
    std::ostringstream json;
    writeAskSparqlJson(json, output_table->numRows() != 0);
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
