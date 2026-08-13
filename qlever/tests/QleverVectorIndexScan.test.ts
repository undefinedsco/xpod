import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const adapterInclude = path.join(repoRoot, 'qlever/qlever_adapter/src');
const vectorIndexScanHeader = path.join(adapterInclude, 'XpodQleverVectorIndexScan.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', [ 'c++', '--version' ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeFakeQleverOperationHeaders(root: string): Promise<string> {
  const include = path.join(root, 'include');
  await mkdir(path.join(include, 'engine'), { recursive: true });
  await mkdir(path.join(include, 'engine/idTable'), { recursive: true });
  await mkdir(path.join(include, 'global'), { recursive: true });
  await mkdir(path.join(include, 'index'), { recursive: true });
  await mkdir(path.join(include, 'parser'), { recursive: true });
  await mkdir(path.join(include, 'util'), { recursive: true });
  await writeFile(path.join(include, 'util/AllocatorWithLimit.h'), `
#pragma once
namespace ad_utility {
template <typename T>
class AllocatorWithLimit {
 public:
  explicit AllocatorWithLimit(int tag = 0) : tag_(tag) {}
  int tag() const { return tag_; }
 private:
  int tag_;
};
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() { return AllocatorWithLimit<T>{}; }
}
`, 'utf8');
  await writeFile(path.join(include, 'util/Exception.h'), `
#pragma once
#include <exception>
#include <string>
#include <utility>
namespace ad_utility {
class AbortException : public std::exception {
 public:
  explicit AbortException(const std::exception& original)
      : message_(original.what()) {}
  explicit AbortException(std::string message)
      : message_(std::move(message)) {}
  const char* what() const noexcept override { return message_.c_str(); }
 private:
  std::string message_;
};
}
`, 'utf8');
  await writeFile(path.join(include, 'global/Id.h'), `
#pragma once
#include <cstdint>
#include <stdexcept>
using ColumnIndex = uint64_t;
enum class Datatype { Encoded, TextRecordIndex, LocalVocabIndex };
class TextRecordIndex {
 public:
  static TextRecordIndex make(uint64_t value) { return TextRecordIndex(value); }
  uint64_t get() const { return value_; }
 private:
  explicit TextRecordIndex(uint64_t value) : value_(value) {}
  uint64_t value_;
};
class Id {
 public:
  static constexpr uint64_t maxIndex = (1ULL << 60) - 1;
  class IndexTooLargeException : public std::runtime_error {
   public:
    IndexTooLargeException() : std::runtime_error("index exceeds ValueId::maxIndex") {}
  };
  static Id fromBits(uint64_t bits) { return Id(bits, Datatype::Encoded); }
  static Id makeFromTextRecordIndex(TextRecordIndex index) {
    if (index.get() > maxIndex) throw IndexTooLargeException{};
    return Id(index.get(), Datatype::TextRecordIndex);
  }
  static Id makeFromLocalVocabIndex(uint64_t index) {
    return Id(index + 2000000, Datatype::LocalVocabIndex);
  }
  uint64_t getBits() const { return bits_; }
  Datatype getDatatype() const { return datatype_; }
  TextRecordIndex getTextRecordIndex() const { return TextRecordIndex::make(bits_); }
 private:
  Id(uint64_t bits, Datatype datatype) : bits_(bits), datatype_(datatype) {}
  uint64_t bits_;
  Datatype datatype_;
};
`, 'utf8');
  await writeFile(path.join(include, 'index/LocalVocab.h'), `
#pragma once
#include <string>
#include <utility>
#include <vector>
class LocalVocabEntry {
 public:
  static LocalVocabEntry literal(std::string value) {
    LocalVocabEntry entry;
    entry.value_ = std::move(value);
    return entry;
  }
  bool operator==(const LocalVocabEntry& other) const {
    return value_ == other.value_;
  }
 private:
  std::string value_;
};
class LocalVocab {
 public:
  uint64_t getIndexAndAddIfNotContained(const LocalVocabEntry& word) {
    for (size_t i = 0; i < words_.size(); ++i) {
      if (words_[i] == word) return i;
    }
    words_.push_back(word);
    return words_.size() - 1;
  }
 private:
  std::vector<LocalVocabEntry> words_;
};
`, 'utf8');
  await writeFile(path.join(include, 'index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
  await writeFile(path.join(include, 'engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  IdTable(size_t width, const ad_utility::AllocatorWithLimit<Id>& allocator)
      : width_(width), allocator_tag_(allocator.tag()) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  int allocatorTag() const { return allocator_tag_; }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  int allocator_tag_ = 0;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
  await writeFile(path.join(include, 'engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sorted, LocalVocab&&)
      : table_(std::move(table)), sorted_(std::move(sorted)) {}
  const IdTable& idTableView() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sorted_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sorted_;
};
`, 'utf8');
  await writeFile(path.join(include, 'parser/ExternalValuesQuery.h'), `
#pragma once
#include <string>
#include <map>
#include <utility>
#include <vector>
class Variable {
 public:
  explicit Variable(std::string name) : name_(std::move(name)) {
    if (!name_.empty() && name_.front() == '$') name_.front() = '?';
  }
  const std::string& name() const { return name_; }
  friend bool operator==(const Variable&, const Variable&) = default;
  friend bool operator<(const Variable& left, const Variable& right) {
    return left.name_ < right.name_;
  }
 private:
  std::string name_;
};
namespace parsedQuery {
struct ExternalValuesQuery {
  std::string name_;
  std::vector<Variable> variables_;
};
}
`, 'utf8');
  await writeFile(path.join(include, 'engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
namespace xpod::qlever { class XpodQleverPhysicalIndex; }
class QueryExecutionContext {
 public:
  explicit QueryExecutionContext(ad_utility::AllocatorWithLimit<Id> allocator)
      : allocator_(allocator) {}
  void setXpodPhysicalIndex(
      std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    index_ = std::move(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.get();
  }
  const ad_utility::AllocatorWithLimit<Id>& getAllocator() const {
    return allocator_;
  }
 private:
  ad_utility::AllocatorWithLimit<Id> allocator_;
  std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index_;
};
`, 'utf8');
  await writeFile(path.join(include, 'engine/Operation.h'), `
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "engine/QueryExecutionContext.h"
#include "engine/Result.h"
#include "parser/ExternalValuesQuery.h"
class QueryExecutionTree;
struct ColumnIndexAndTypeInfo {
  enum struct UndefStatus { AlwaysDefined, PossiblyUndefined };
  ColumnIndex columnIndex_;
  UndefStatus mightContainUndef_;
};
using VariableToColumnMap = std::map<Variable, ColumnIndexAndTypeInfo>;
inline ColumnIndexAndTypeInfo makeAlwaysDefinedColumn(ColumnIndex column) {
  return {column, ColumnIndexAndTypeInfo::UndefStatus::AlwaysDefined};
}
class Operation {
 public:
  explicit Operation(QueryExecutionContext* qec) : qec_(qec) {}
  virtual ~Operation() = default;
  virtual size_t getCostEstimate() = 0;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  virtual float getMultiplicity(size_t) = 0;
  virtual bool knownEmptyResult() = 0;
  virtual std::vector<QueryExecutionTree*> getChildren() = 0;
  virtual VariableToColumnMap computeVariableToColumnMap() const = 0;
  uint64_t getSizeEstimate() { return getSizeEstimateBeforeLimit(); }
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_ = resultSortedOn();
    return sorted_;
  }
  Result computeResultOnlyForTesting(bool requestLaziness = false) {
    return computeResult(requestLaziness);
  }
  bool canResultBeCached() const { return canResultBeCachedImpl(); }
  std::string getCacheKey() const { return getCacheKeyImpl(); }
  std::unique_ptr<Operation> clone() const { return cloneImpl(); }
  QueryExecutionContext* getExecutionContext() const { return qec_; }
  const ad_utility::AllocatorWithLimit<Id>& allocator() const {
    return qec_->getAllocator();
  }
 protected:
  virtual uint64_t getSizeEstimateBeforeLimit() = 0;
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
  virtual Result computeResult(bool) = 0;
 private:
  virtual std::string getCacheKeyImpl() const = 0;
  virtual bool canResultBeCachedImpl() const { return true; }
  virtual std::unique_ptr<Operation> cloneImpl() const = 0;
  [[maybe_unused]] QueryExecutionContext* qec_;
  mutable std::vector<ColumnIndex> sorted_;
};
`, 'utf8');
  await writeFile(path.join(include, 'index/CompressedRelation.h'), `
#pragma once
#include <memory>
#include <optional>
#include "engine/idTable/IdTable.h"
namespace ad_utility {
template <typename T, typename Details>
class InputRangeFromGet {
 public:
  virtual ~InputRangeFromGet() = default;
  virtual std::optional<T> get() = 0;
  Details& details() { return details_; }
 private:
  Details details_;
};
template <typename T, typename Details>
class InputRangeTypeErased {
 public:
  InputRangeTypeErased() = default;
  explicit InputRangeTypeErased(std::unique_ptr<InputRangeFromGet<T, Details>> impl)
      : impl_(std::move(impl)) {}
  std::optional<T> get() { return impl_ ? impl_->get() : std::nullopt; }
  Details& details() { return impl_->details(); }
 private:
  std::unique_ptr<InputRangeFromGet<T, Details>> impl_;
};
}
class CompressedRelationReader {
 public:
  struct LazyScanMetadata {
    size_t numBlocksRead_ = 0;
    size_t numBlocksAll_ = 0;
    size_t numElementsRead_ = 0;
    size_t numElementsYielded_ = 0;
  };
  using IdTableGeneratorInputRange =
      ad_utility::InputRangeTypeErased<IdTable, LazyScanMetadata>;
};
`, 'utf8');
  return include;
}

it('emits retrieval points as QLever text record ids', async () => {
  const source = await readFile(vectorIndexScanHeader, 'utf8');
  const retrievalBranch = source.slice(
    source.indexOf('if (output == OutputKind::RetrievalPoint)'),
    source.indexOf('if (!candidate.has_resource_term)'),
  );
  expect(retrievalBranch).toContain('candidate.has_retrieval_point');
  expect(retrievalBranch).toContain('Id::makeFromTextRecordIndex');
  expect(retrievalBranch).toContain('TextRecordIndex::make(candidate.retrieval_point)');
  expect(retrievalBranch).not.toContain('candidate.has_retrieval_point_key');
  expect(retrievalBranch).not.toContain('Id::makeFromLocalVocabIndex');
});

it('compiles the QLever vector operation leaf', async () => {
  expect(hasCxx(), 'c++ compiler is required for the vector operation check').toBe(true);

  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-vector-index-scan-'));
  try {
    const qleverInclude = await writeFakeQleverOperationHeaders(root);
    const source = path.join(root, 'vector_index_scan_smoke.cpp');
    const binary = path.join(root, 'vector_index_scan_smoke');
    await writeFile(source, `
#include "XpodQleverVectorIndexScan.hpp"
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

struct BackendState {
  std::vector<std::string> events;
  const xpod_rdf_access_scope* expected_access = nullptr;
  const xpod_rdf_cancellation* expected_cancellation = nullptr;
  int encode_calls = 0;
  bool vector_capable = true;
  bool omit_retrieval = false;
  bool omit_retrieval_key = false;
  bool omit_resource = false;
  xpod_rdf_status search_status = XPOD_RDF_STATUS_OK;
  uint64_t first_retrieval_point = 101;
  uint64_t second_retrieval_point = 102;
};

static xpod_rdf_bytes bytes(const char* value) {
  return {value, std::char_traits<char>::length(value)};
}

static bool has_request_scope(
    BackendState* state, const xpod_rdf_vector_search_request* request) {
  return request->snapshot.snapshot_token.size == 10 &&
      request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT &&
      request->graph_scope.exact_graph == 77 &&
      request->source_scope.has_source_node == 1 &&
      request->source_scope.source_node == 88 &&
      request->access_scope == state->expected_access &&
      request->cancellation == state->expected_cancellation &&
      request->limit == 2;
}

static xpod_rdf_status get_capabilities(
    void* user_data, xpod_rdf_backend_capabilities* out) {
  auto* state = static_cast<BackendState*>(user_data);
  out->features = state->vector_capable
      ? XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH
      : 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out) {
  auto* state = static_cast<BackendState*>(user_data);
  state->events.emplace_back("estimate");
  if (!has_request_scope(state, request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out->rows = 2;
  out->startup_cost = 2;
  out->cpu_cost = 3;
  out->io_cost = 4;
  out->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  state->events.emplace_back("search");
  if (!has_request_scope(state, request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (state->search_status != XPOD_RDF_STATUS_OK) return state->search_status;
  if (state->events != std::vector<std::string>{"estimate", "search"}) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate rows[2] = {};
  rows[0].has_retrieval_point = state->omit_retrieval ? 0 : 1;
  rows[0].retrieval_point = state->first_retrieval_point;
  rows[0].has_retrieval_point_key =
      state->omit_retrieval_key ? 0 : 1;
  rows[0].retrieval_point_key = {"chunk-101", 9};
  rows[0].has_resource_term = state->omit_resource ? 0 : 1;
  rows[0].resource_term = 11;
  rows[1].has_retrieval_point = 1;
  rows[1].retrieval_point = state->second_retrieval_point;
  rows[1].has_retrieval_point_key = 1;
  rows[1].retrieval_point_key = {"chunk-102", 9};
  rows[1].has_resource_term = 1;
  rows[1].resource_term = 12;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status encode_qlever_id(
    void* user_data, xpod_rdf_term_key term, uint64_t* out_bits) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->encode_calls;
  *out_bits = 1000 + term;
  return XPOD_RDF_STATUS_OK;
}

template <typename Function>
static bool throws_vector_status(Function&& function, xpod_rdf_status status) {
  try {
    function();
  } catch (const xpod::qlever::XpodQleverVectorExecutionError& error) {
    return error.status() == status;
  } catch (...) {
    return false;
  }
  return false;
}

int main() {
  using xpod::qlever::XpodQleverVectorIndexScan;
  static_assert(std::is_base_of_v<Operation, XpodQleverVectorIndexScan>);
  static_assert(std::is_final_v<XpodQleverVectorIndexScan>);
  static_assert(XpodQleverVectorIndexScan::kExternalValuesName == "XpodVectorQuery");
  parsedQuery::ExternalValuesQuery ordinary{"OrdinaryExternalValues", {Variable{"?x"}}};
  if (XpodQleverVectorIndexScan::canHandle(nullptr, ordinary)) return 1;
  parsedQuery::ExternalValuesQuery reserved{"XpodVectorQuery", {Variable{"?x"}}};
  if (!XpodQleverVectorIndexScan::canHandle(nullptr, reserved)) return 2;

  BackendState state;
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(raw_backend);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.estimate_vector_search = estimate_vector_search;
  raw_backend.vector_search = vector_search;
  raw_backend.encode_qlever_id = encode_qlever_id;
  xpod::rdf::PhysicalBackend backend(&raw_backend);

  double vector[2] = {0.25, 0.75};
  xpod_qlever_vector_query vector_query = {};
  vector_query.vector = vector;
  vector_query.dimensions = 2;
  vector_query.provider = bytes("xpod");
  vector_query.model = bytes("embed-v1");
  vector_query.model_version = bytes("2026-08-12");
  vector_query.input_kind = bytes("entity-card");
  vector_query.projection_policy_version = bytes("policy-v1");
  vector_query.metric = XPOD_RDF_VECTOR_COSINE;
  vector_query.limit = 2;
  vector_query.retrieval_point_variable = bytes("?retrieval");
  vector_query.resource_variable = bytes("?resource");

  xpod_rdf_cancellation cancellation = {};
  xpod_rdf_access_scope access = {};
  access.mode = XPOD_RDF_ACCESS_READ;
  xpod_qlever_query_request request = {};
  request.snapshot.snapshot_token = bytes("snapshot-1");
  request.cancellation = &cancellation;
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  request.graph_scope.exact_graph = 77;
  request.source_scope.has_source_node = 1;
  request.source_scope.source_node = 88;
  request.access_scope = &access;
  request.vector_query = &vector_query;
  state.expected_access = &access;
  state.expected_cancellation = &cancellation;

  xpod::qlever::PlannerRequestContext context{backend, &request, &cancellation};
  context.capabilities_status = backend.getCapabilities(context.capabilities);
  auto index = std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(context);
  QueryExecutionContext qec{ad_utility::AllocatorWithLimit<Id>{47}};
  qec.setXpodPhysicalIndex(index);

  parsedQuery::ExternalValuesQuery query{
      "XpodVectorQuery", {Variable{"?retrieval"}, Variable{"?resource"}}};
  XpodQleverVectorIndexScan operation(&qec, query);
  if (operation.getSizeEstimate() != 2) return 10;
  if (state.events != std::vector<std::string>{"estimate"}) return 11;
  if (operation.getCostEstimate() != 9) return 12;
  if (state.events != std::vector<std::string>{"estimate"}) return 13;
  if (operation.getDescriptor() != "XpodVectorIndexScan") return 14;
  if (operation.getResultWidth() != 2) return 15;
  if (operation.getMultiplicity(0) != 1 || operation.getMultiplicity(1) != 1) return 16;
  if (operation.knownEmptyResult()) return 17;
  if (!operation.getChildren().empty()) return 18;
  if (!operation.getResultSortedOn().empty()) return 19;
  if (operation.canResultBeCached()) return 20;
  auto columns = operation.computeVariableToColumnMap();
  const auto& retrieval_column = columns.at(Variable{"?retrieval"});
  const auto& resource_column = columns.at(Variable{"?resource"});
  if (columns.size() != 2 || retrieval_column.columnIndex_ != 0 ||
      retrieval_column.mightContainUndef_ !=
          ColumnIndexAndTypeInfo::UndefStatus::AlwaysDefined ||
      resource_column.columnIndex_ != 1 ||
      resource_column.mightContainUndef_ !=
          ColumnIndexAndTypeInfo::UndefStatus::AlwaysDefined) return 21;

  Result result = operation.computeResultOnlyForTesting(false);
  if (state.events != std::vector<std::string>{"estimate", "search"}) return 22;
  const IdTable& table = result.idTableView();
  if (table.numColumns() != 2 || table.numRows() != 2) return 23;
  if (table.allocatorTag() != 47) return 24;
  if (table(0, 0).getDatatype() != Datatype::TextRecordIndex ||
      table(0, 0).getTextRecordIndex().get() != state.first_retrieval_point ||
      table(1, 0).getDatatype() != Datatype::TextRecordIndex ||
      table(1, 0).getTextRecordIndex().get() != state.second_retrieval_point) return 25;
  if (table(0, 1).getBits() != 1011 || table(1, 1).getBits() != 1012) return 26;
  if (state.encode_calls != 2) return 27;
  auto clone = operation.clone();
  if (clone->getDescriptor() != "XpodVectorIndexScan" ||
      clone->getResultWidth() != 2) return 28;

  xpod_qlever_vector_query dollar_vector_query = vector_query;
  dollar_vector_query.retrieval_point_variable = bytes("$retrieval");
  dollar_vector_query.resource_variable = bytes("$resource");
  xpod_qlever_query_request dollar_request = request;
  dollar_request.vector_query = &dollar_vector_query;
  xpod::qlever::PlannerRequestContext dollar_context{
      backend, &dollar_request, &cancellation};
  dollar_context.capabilities_status =
      backend.getCapabilities(dollar_context.capabilities);
  auto dollar_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          dollar_context);
  QueryExecutionContext dollar_qec{ad_utility::AllocatorWithLimit<Id>{47}};
  dollar_qec.setXpodPhysicalIndex(dollar_index);
  parsedQuery::ExternalValuesQuery dollar_query{
      "XpodVectorQuery", {Variable{"$retrieval"}, Variable{"$resource"}}};
  state.events.clear();
  XpodQleverVectorIndexScan dollar_operation(&dollar_qec, dollar_query);
  if (dollar_operation.getSizeEstimate() != 2) return 29;
  if (state.events != std::vector<std::string>{"estimate"}) return 47;
  if (dollar_vector_query.retrieval_point_variable.data[0] != '$' ||
      dollar_vector_query.resource_variable.data[0] != '$') return 48;

  state.events.clear();
  state.vector_capable = false;
  XpodQleverVectorIndexScan missing_capability(&qec, query);
  if (!throws_vector_status(
          [&] { (void)missing_capability.getSizeEstimate(); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 30;
  if (!state.events.empty()) return 31;

  state.vector_capable = true;
  state.omit_resource = true;
  state.events.clear();
  XpodQleverVectorIndexScan missing_key(&qec, query);
  if (missing_key.getSizeEstimate() != 2) return 32;
  if (!throws_vector_status(
          [&] { (void)missing_key.computeResultOnlyForTesting(false); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 33;
  if (state.events != std::vector<std::string>{"estimate", "search"}) return 34;

  state.omit_resource = false;
  state.omit_retrieval = true;
  state.events.clear();
  XpodQleverVectorIndexScan missing_retrieval(&qec, query);
  if (missing_retrieval.getSizeEstimate() != 2) return 75;
  if (!throws_vector_status(
          [&] { (void)missing_retrieval.computeResultOnlyForTesting(false); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 76;
  if (state.events != std::vector<std::string>{"estimate", "search"}) return 77;

  state.omit_retrieval = false;
  state.omit_retrieval_key = true;
  state.events.clear();
  XpodQleverVectorIndexScan missing_retrieval_key(&qec, query);
  if (missing_retrieval_key.getSizeEstimate() != 2) return 84;
  Result missing_retrieval_key_result =
      missing_retrieval_key.computeResultOnlyForTesting(false);
  if (missing_retrieval_key_result.idTableView()(0, 0).getDatatype() !=
          Datatype::TextRecordIndex ||
      missing_retrieval_key_result.idTableView()(0, 0).getTextRecordIndex().get() !=
          state.first_retrieval_point) return 85;
  if (state.events != std::vector<std::string>{"estimate", "search"}) return 86;

  state.omit_retrieval_key = false;
  state.search_status = XPOD_RDF_STATUS_BACKEND_ERROR;
  state.events.clear();
  XpodQleverVectorIndexScan backend_error(&qec, query);
  if (!throws_vector_status(
          [&] { (void)backend_error.computeResultOnlyForTesting(false); },
          XPOD_RDF_STATUS_BACKEND_ERROR)) return 35;
  if (state.events != std::vector<std::string>{"search"}) return 36;
  state.search_status = XPOD_RDF_STATUS_OK;

  xpod_qlever_query_request no_sideband_request = request;
  no_sideband_request.vector_query = nullptr;
  xpod::qlever::PlannerRequestContext no_sideband_context{
      backend, &no_sideband_request, &cancellation};
  auto no_sideband_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          no_sideband_context);
  QueryExecutionContext no_sideband_qec{
      ad_utility::AllocatorWithLimit<Id>{47}};
  no_sideband_qec.setXpodPhysicalIndex(no_sideband_index);
  if (!throws_vector_status(
          [&] { XpodQleverVectorIndexScan invalid(&no_sideband_qec, query); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 37;

  parsedQuery::ExternalValuesQuery mismatched{
      "XpodVectorQuery", {Variable{"?resource"}, Variable{"?retrieval"}}};
  if (!throws_vector_status(
          [&] { XpodQleverVectorIndexScan invalid(&qec, mismatched); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 38;

  xpod_qlever_vector_query empty_retrieval = vector_query;
  empty_retrieval.retrieval_point_variable = {};
  xpod_qlever_query_request empty_retrieval_request = request;
  empty_retrieval_request.vector_query = &empty_retrieval;
  xpod::qlever::PlannerRequestContext empty_retrieval_context{
      backend, &empty_retrieval_request, &cancellation};
  auto empty_retrieval_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          empty_retrieval_context);
  QueryExecutionContext empty_retrieval_qec{
      ad_utility::AllocatorWithLimit<Id>{47}};
  empty_retrieval_qec.setXpodPhysicalIndex(empty_retrieval_index);
  parsedQuery::ExternalValuesQuery resource_only_query{
      "XpodVectorQuery", {Variable{"?resource"}}};
  state.events.clear();
  const int resource_only_encode_calls_before = state.encode_calls;
  XpodQleverVectorIndexScan resource_only_operation(
      &empty_retrieval_qec, resource_only_query);
  if (resource_only_operation.getResultWidth() != 1 ||
      resource_only_operation.getSizeEstimate() != 2) return 39;
  Result resource_only_result =
      resource_only_operation.computeResultOnlyForTesting(false);
  if (resource_only_result.idTableView().numColumns() != 1 ||
      resource_only_result.idTableView().numRows() != 2) return 78;
  if (resource_only_result.idTableView()(0, 0).getBits() != 1011 ||
      resource_only_result.idTableView()(1, 0).getBits() != 1012) return 79;
  if (state.encode_calls != resource_only_encode_calls_before + 2) return 80;

  xpod_qlever_vector_query empty_resource = vector_query;
  empty_resource.resource_variable = {};
  xpod_qlever_query_request empty_resource_request = request;
  empty_resource_request.vector_query = &empty_resource;
  xpod::qlever::PlannerRequestContext empty_resource_context{
      backend, &empty_resource_request, &cancellation};
  auto empty_resource_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          empty_resource_context);
  QueryExecutionContext empty_resource_qec{
      ad_utility::AllocatorWithLimit<Id>{47}};
  empty_resource_qec.setXpodPhysicalIndex(empty_resource_index);
  parsedQuery::ExternalValuesQuery retrieval_only_query{
      "XpodVectorQuery", {Variable{"?retrieval"}}};
  state.omit_resource = true;
  state.events.clear();
  const int retrieval_only_encode_calls_before = state.encode_calls;
  XpodQleverVectorIndexScan retrieval_only_operation(
      &empty_resource_qec, retrieval_only_query);
  if (retrieval_only_operation.getResultWidth() != 1 ||
      retrieval_only_operation.getSizeEstimate() != 2) return 40;
  Result retrieval_only_result =
      retrieval_only_operation.computeResultOnlyForTesting(false);
  if (retrieval_only_result.idTableView().numColumns() != 1 ||
      retrieval_only_result.idTableView().numRows() != 2) return 81;
  if (retrieval_only_result.idTableView()(0, 0).getDatatype() !=
          Datatype::TextRecordIndex ||
      retrieval_only_result.idTableView()(0, 0).getTextRecordIndex().get() !=
          state.first_retrieval_point ||
      retrieval_only_result.idTableView()(1, 0).getTextRecordIndex().get() !=
          state.second_retrieval_point) return 82;
  if (state.encode_calls != retrieval_only_encode_calls_before) return 83;
  state.omit_resource = false;

  xpod_qlever_vector_query invalid_vector = vector_query;
  invalid_vector.vector = nullptr;
  invalid_vector.dimensions = 0;
  invalid_vector.limit = 0;
  xpod_qlever_query_request invalid_vector_request = request;
  invalid_vector_request.vector_query = &invalid_vector;
  xpod::qlever::PlannerRequestContext invalid_vector_context{
      backend, &invalid_vector_request, &cancellation};
  auto invalid_vector_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          invalid_vector_context);
  QueryExecutionContext invalid_vector_qec{
      ad_utility::AllocatorWithLimit<Id>{47}};
  invalid_vector_qec.setXpodPhysicalIndex(invalid_vector_index);
  if (!throws_vector_status(
          [&] { XpodQleverVectorIndexScan invalid(&invalid_vector_qec, query); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 41;

  xpod_qlever_vector_query duplicate_outputs = vector_query;
  duplicate_outputs.resource_variable = bytes("?retrieval");
  xpod_qlever_query_request duplicate_request = request;
  duplicate_request.vector_query = &duplicate_outputs;
  xpod::qlever::PlannerRequestContext duplicate_context{
      backend, &duplicate_request, &cancellation};
  auto duplicate_index =
      std::make_shared<const xpod::qlever::XpodQleverPhysicalIndex>(
          duplicate_context);
  QueryExecutionContext duplicate_qec{ad_utility::AllocatorWithLimit<Id>{47}};
  duplicate_qec.setXpodPhysicalIndex(duplicate_index);
  parsedQuery::ExternalValuesQuery duplicate_query{
      "XpodVectorQuery", {Variable{"?retrieval"}, Variable{"?retrieval"}}};
  if (!throws_vector_status(
          [&] { XpodQleverVectorIndexScan invalid(&duplicate_qec, duplicate_query); },
          XPOD_RDF_STATUS_UNSUPPORTED)) return 42;

  return 0;
}
`, 'utf8');

    execFileSync('c++', [
      '-std=c++20',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
      '-I', adapterInclude,
      '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
      '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
      '-I', qleverInclude,
      source,
      '-o',
      binary,
    ], { stdio: 'pipe' });
    execFileSync(binary, [], { stdio: 'pipe' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
