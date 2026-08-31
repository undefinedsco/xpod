#ifndef XPOD_QLEVER_VECTOR_INDEX_SCAN_HPP
#define XPOD_QLEVER_VECTOR_INDEX_SCAN_HPP

#include "XpodQleverPhysicalIndex.hpp"
#include "XpodQleverLocalVocabLiteralBridge.hpp"
#include "XpodQleverValueIdBridge.hpp"
#include "engine/Operation.h"
#include "parser/ExternalValuesQuery.h"
#include "util/Exception.h"

#include <optional>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace xpod::qlever {

class XpodQleverVectorExecutionError : public ad_utility::AbortException {
 public:
  XpodQleverVectorExecutionError(
      xpod_rdf_status status, std::string message)
      : ad_utility::AbortException(std::move(message)), status_(status) {}

  xpod_rdf_status status() const noexcept { return status_; }

 private:
  xpod_rdf_status status_;
};

class XpodQleverVectorIndexScan final : public Operation {
 public:
  static constexpr std::string_view kExternalValuesName = "XpodVectorQuery";

  static bool canHandle(
      QueryExecutionContext*,
      const parsedQuery::ExternalValuesQuery& query) noexcept {
    return query.name_ == kExternalValuesName;
  }

  XpodQleverVectorIndexScan(
      QueryExecutionContext* qec,
      const parsedQuery::ExternalValuesQuery& query)
      : XpodQleverVectorIndexScan(qec, validate(qec, query)) {}

  size_t getCostEstimate() override {
    const xpod_rdf_estimate& estimate = estimateOrThrow();
    const double cost = estimate.startup_cost + estimate.cpu_cost +
                        estimate.io_cost;
    return cost <= 0 ? static_cast<size_t>(estimate.rows)
                     : static_cast<size_t>(cost);
  }

  std::string getDescriptor() const override {
    return "XpodVectorIndexScan";
  }

  size_t getResultWidth() const override { return variables_.size(); }

  float getMultiplicity(size_t) override { return 1; }

  bool knownEmptyResult() override { return false; }

  std::vector<QueryExecutionTree*> getChildren() override { return {}; }

  VariableToColumnMap computeVariableToColumnMap() const override {
    VariableToColumnMap result;
    for (size_t i = 0; i < variables_.size(); ++i) {
      result[variables_[i]] = makeAlwaysDefinedColumn(i);
    }
    return result;
  }

 private:
  enum class OutputKind { RetrievalPoint, Resource };

  struct ValidatedInput {
    const XpodQleverPhysicalIndex* physical_index;
    std::vector<Variable> variables;
    std::vector<OutputKind> outputs;
    xpod_rdf_vector_search_request request;
  };

  static std::string_view bytesView(xpod_rdf_bytes value) noexcept {
    return value.data == nullptr ? std::string_view{}
                                 : std::string_view{value.data, value.size};
  }

  static std::optional<std::string> normalizedVariableName(
      xpod_rdf_bytes value) {
    std::string name{bytesView(value)};
    if (name.empty() || (name.front() != '?' && name.front() != '$')) {
      return std::nullopt;
    }
    if (name.front() == '$') {
      name.front() = '?';
    }
    return name;
  }

  [[noreturn]] static void throwUnsupported(std::string message) {
    throw XpodQleverVectorExecutionError(
        XPOD_RDF_STATUS_UNSUPPORTED, std::move(message));
  }

  static ValidatedInput validate(
      QueryExecutionContext* qec,
      const parsedQuery::ExternalValuesQuery& query) {
    if (query.name_ != kExternalValuesName) {
      throwUnsupported("unexpected external-values name for Xpod vector scan");
    }
    if (qec == nullptr || qec->xpodPhysicalIndex() == nullptr) {
      throwUnsupported("Xpod vector scan requires a physical index");
    }

    const XpodQleverPhysicalIndex* physical_index = qec->xpodPhysicalIndex();
    const PlannerRequestContext& context =
        physical_index->plannerRequestContext();
    if (context.request == nullptr || context.request->vector_query == nullptr) {
      throwUnsupported("Xpod vector scan requires a request-local vector query");
    }

    const xpod_qlever_vector_query& sideband =
        *context.request->vector_query;
    if (sideband.vector == nullptr || sideband.dimensions == 0 ||
        sideband.limit == 0 || bytesView(sideband.provider).empty() ||
        bytesView(sideband.model).empty() ||
        bytesView(sideband.model_version).empty() ||
        bytesView(sideband.input_kind).empty() ||
        bytesView(sideband.projection_policy_version).empty()) {
      throwUnsupported("Xpod vector scan sideband is invalid");
    }
    const std::optional<std::string> retrieval_variable =
        normalizedVariableName(sideband.retrieval_point_variable);
    const std::optional<std::string> resource_variable =
        normalizedVariableName(sideband.resource_variable);
    if (!retrieval_variable.has_value() && !resource_variable.has_value()) {
      throwUnsupported("Xpod vector scan requires at least one output variable");
    }
    if (retrieval_variable.has_value() && resource_variable.has_value() &&
        retrieval_variable == resource_variable) {
      throwUnsupported("Xpod vector scan output variables must be unique");
    }

    std::vector<std::pair<std::string, OutputKind>> expected_outputs;
    if (retrieval_variable.has_value()) {
      expected_outputs.emplace_back(
          *retrieval_variable, OutputKind::RetrievalPoint);
    }
    if (resource_variable.has_value()) {
      expected_outputs.emplace_back(*resource_variable, OutputKind::Resource);
    }
    if (query.variables_.size() != expected_outputs.size()) {
      throwUnsupported("Xpod vector scan variables do not match sideband outputs");
    }

    ValidatedInput result;
    result.physical_index = physical_index;
    result.variables = query.variables_;
    result.outputs.reserve(expected_outputs.size());
    for (size_t i = 0; i < expected_outputs.size(); ++i) {
      if (query.variables_[i].name() != expected_outputs[i].first) {
        throwUnsupported(
            "Xpod vector scan variables do not match sideband outputs");
      }
      result.outputs.push_back(expected_outputs[i].second);
    }

    result.request.snapshot = context.request->snapshot;
    result.request.cancellation = context.cancellation;
    result.request.vector = sideband.vector;
    result.request.dimensions = sideband.dimensions;
    result.request.provider = sideband.provider;
    result.request.model = sideband.model;
    result.request.model_version = sideband.model_version;
    result.request.input_kind = sideband.input_kind;
    result.request.projection_policy_version =
        sideband.projection_policy_version;
    result.request.metric = sideband.metric;
    result.request.graph_scope = context.request->graph_scope;
    result.request.source_scope = context.request->source_scope;
    result.request.access_scope = context.request->access_scope;
    result.request.limit = sideband.limit;
    result.request.threshold = sideband.threshold;
    result.request.has_threshold = sideband.has_threshold;
    return result;
  }

  XpodQleverVectorIndexScan(
      QueryExecutionContext* qec, ValidatedInput input)
      : Operation(qec),
        physical_index_(input.physical_index),
        variables_(std::move(input.variables)),
        outputs_(std::move(input.outputs)),
        request_(input.request),
        search_(physical_index_->vectorSearch(
            request_, std::string{kExternalValuesName})) {}

  const xpod_rdf_estimate& estimateOrThrow() {
    if (!estimate_.has_value()) {
      estimate_ = search_.estimate();
    }
    if (estimate_->status != XPOD_RDF_STATUS_OK) {
      throw XpodQleverVectorExecutionError(
          estimate_->status, "Xpod vector estimate failed");
    }
    return estimate_->estimate;
  }

  uint64_t getSizeEstimateBeforeLimit() override {
    return estimateOrThrow().rows;
  }

  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }

  Result computeResult(bool) override {
    XpodBackedCandidateResult candidates = search_.execute();
    if (candidates.status != XPOD_RDF_STATUS_OK) {
      throw XpodQleverVectorExecutionError(
          candidates.status, "Xpod vector search failed");
    }

    IdTable table(getResultWidth(), allocator());
    std::vector<Id> row;
    LocalVocab local_vocab;
    row.reserve(outputs_.size());
    for (const xpod::rdf::CandidateRow& candidate : candidates.candidates.rows) {
      row.clear();
      for (OutputKind output : outputs_) {
        if (output == OutputKind::RetrievalPoint) {
          if (!candidate.has_retrieval_point_key) {
            throwUnsupported(
                "Xpod vector candidate is missing retrieval point key");
          }
          row.push_back(bridgeLocalVocabLiteralId(
              local_vocab, candidate.retrieval_point_key,
              getExecutionContext()->getLocalVocabContext()));
          continue;
        }
        if (!candidate.has_resource_term) {
          throwUnsupported("Xpod vector candidate is missing resource key");
        }
        uint64_t bits = 0;
        xpod_rdf_status status =
            physical_index_->encodeQleverId(candidate.resource_term, bits);
        if (status != XPOD_RDF_STATUS_OK) {
          throw XpodQleverVectorExecutionError(
              status, "Xpod vector resource Id conversion failed");
        }
        row.push_back(toQleverId(bits));
      }
      table.push_back(row);
    }
    return {std::move(table), resultSortedOn(), std::move(local_vocab)};
  }

  std::string getCacheKeyImpl() const override {
    return "XpodVectorIndexScan";
  }

  bool canResultBeCachedImpl() const override { return false; }

  std::unique_ptr<Operation> cloneImpl() const override {
    parsedQuery::ExternalValuesQuery query;
    query.name_ = std::string{kExternalValuesName};
    query.variables_ = variables_;
    return std::make_unique<XpodQleverVectorIndexScan>(
        getExecutionContext(), query);
  }

  const XpodQleverPhysicalIndex* physical_index_;
  std::vector<Variable> variables_;
  std::vector<OutputKind> outputs_;
  xpod_rdf_vector_search_request request_ = {};
  XpodBackedVectorSearch search_;
  std::optional<XpodBackedCandidateEstimate> estimate_;
};

}  // namespace xpod::qlever

#endif
