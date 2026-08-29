#ifndef XPOD_QLEVER_LAZY_SCAN_BRIDGE_HPP
#define XPOD_QLEVER_LAZY_SCAN_BRIDGE_HPP

#include "XpodQleverIdTableBridge.hpp"

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER && __has_include("index/CompressedRelation.h")
#include "index/CompressedRelation.h"

namespace xpod::qlever {

struct QleverLazyScanRangeResult {
  xpod_rdf_status status;
  CompressedRelationReader::IdTableGeneratorInputRange blocks;
};

inline xpod_rdf_bytes ownedBytes(
    std::string& storage,
    xpod_rdf_bytes bytes) {
  if (bytes.data == nullptr || bytes.size == 0) {
    storage.clear();
    return {};
  }
  storage.assign(bytes.data, bytes.size);
  return {storage.data(), storage.size()};
}

struct XpodQleverOwnedScanInput {
  explicit XpodQleverOwnedScanInput(const ScanRequestInput& input) {
    input_ = input;
    copySnapshot(input);
    copyCancellation(input.cancellation);
    copyGraphScope(input.graph_scope);
    copySourceScope(input.source_scope);
    copyAccessScope(input.access_scope);
    copyBlockMetadataVersion(input.block_metadata_version);
  }

  const ScanRequestInput& input() const noexcept { return input_; }

 private:
  void copyCancellation(const xpod_rdf_cancellation* cancellation) {
    if (cancellation == nullptr) {
      input_.cancellation = nullptr;
      return;
    }
    cancellation_ = *cancellation;
    input_.cancellation = &cancellation_;
  }

  void copySnapshot(const ScanRequestInput& input) {
    if (input.snapshot == nullptr) {
      input_.snapshot = nullptr;
      return;
    }
    snapshot_ = *input.snapshot;
    snapshot_.facts_version = ownedBytes(
        snapshot_facts_version_storage_, input.snapshot->facts_version);
    snapshot_.stats_version = ownedBytes(
        snapshot_stats_version_storage_, input.snapshot->stats_version);
    snapshot_.snapshot_token =
        ownedBytes(snapshot_token_storage_, input.snapshot->snapshot_token);
    input_.snapshot = &snapshot_;
  }

  void copyGraphScope(xpod_rdf_graph_scope graph_scope) {
    graph_scope_ = graph_scope;
    graph_scope_.iri_prefix =
        ownedBytes(graph_iri_prefix_storage_, graph_scope.iri_prefix);
    if (graph_scope.graph_set != nullptr && graph_scope.graph_set_size > 0) {
      graph_set_storage_.assign(
          graph_scope.graph_set,
          graph_scope.graph_set + graph_scope.graph_set_size);
      graph_scope_.graph_set = graph_set_storage_.data();
      graph_scope_.graph_set_size = graph_set_storage_.size();
    } else {
      graph_scope_.graph_set = nullptr;
      graph_scope_.graph_set_size = 0;
    }
    input_.graph_scope = graph_scope_;
  }

  void copySourceScope(const xpod_rdf_source_scope* source_scope) {
    if (source_scope == nullptr) {
      input_.source_scope = nullptr;
      return;
    }
    source_scope_ = *source_scope;
    source_scope_.workspace =
        ownedBytes(source_workspace_storage_, source_scope->workspace);
    source_scope_.source_uri =
        ownedBytes(source_uri_storage_, source_scope->source_uri);
    source_scope_.source_uri_prefix =
        ownedBytes(source_uri_prefix_storage_, source_scope->source_uri_prefix);
    source_scope_.local_path =
        ownedBytes(source_local_path_storage_, source_scope->local_path);
    source_scope_.local_path_prefix =
        ownedBytes(source_local_path_prefix_storage_,
                   source_scope->local_path_prefix);
    input_.source_scope = &source_scope_;
  }

  void copyAccessScope(const xpod_rdf_access_scope* access_scope) {
    if (access_scope == nullptr) {
      input_.access_scope = nullptr;
      return;
    }
    access_scope_ = *access_scope;
    access_scope_.principal =
        ownedBytes(access_principal_storage_, access_scope->principal);
    access_scope_.permission_version =
        ownedBytes(access_permission_version_storage_,
                   access_scope->permission_version);
    copyTermKeyVector(
        access_scope->allowed_graphs, access_scope->allowed_graphs_size,
        allowed_graphs_storage_, access_scope_.allowed_graphs,
        access_scope_.allowed_graphs_size);
    copyTermKeyVector(
        access_scope->denied_graphs, access_scope->denied_graphs_size,
        denied_graphs_storage_, access_scope_.denied_graphs,
        access_scope_.denied_graphs_size);
    copyBytesVector(
        access_scope->allowed_graph_prefixes,
        access_scope->allowed_graph_prefixes_size,
        allowed_graph_prefix_storage_, allowed_graph_prefix_bytes_,
        access_scope_.allowed_graph_prefixes,
        access_scope_.allowed_graph_prefixes_size);
    copyBytesVector(
        access_scope->denied_graph_prefixes,
        access_scope->denied_graph_prefixes_size,
        denied_graph_prefix_storage_, denied_graph_prefix_bytes_,
        access_scope_.denied_graph_prefixes,
        access_scope_.denied_graph_prefixes_size);
    copySourceNodeVector(
        access_scope->allowed_sources, access_scope->allowed_sources_size,
        allowed_sources_storage_, access_scope_.allowed_sources,
        access_scope_.allowed_sources_size);
    copySourceNodeVector(
        access_scope->denied_sources, access_scope->denied_sources_size,
        denied_sources_storage_, access_scope_.denied_sources,
        access_scope_.denied_sources_size);
    input_.access_scope = &access_scope_;
  }

  void copyBlockMetadataVersion(xpod_rdf_bytes block_metadata_version) {
    input_.block_metadata_version =
        ownedBytes(block_metadata_version_storage_, block_metadata_version);
  }

  static void copyTermKeyVector(
      const xpod_rdf_term_key* source,
      size_t source_size,
      std::vector<xpod_rdf_term_key>& storage,
      const xpod_rdf_term_key*& out,
      size_t& out_size) {
    if (source == nullptr || source_size == 0) {
      out = nullptr;
      out_size = 0;
      return;
    }
    storage.assign(source, source + source_size);
    out = storage.data();
    out_size = storage.size();
  }

  static void copySourceNodeVector(
      const xpod_rdf_source_node_key* source,
      size_t source_size,
      std::vector<xpod_rdf_source_node_key>& storage,
      const xpod_rdf_source_node_key*& out,
      size_t& out_size) {
    if (source == nullptr || source_size == 0) {
      out = nullptr;
      out_size = 0;
      return;
    }
    storage.assign(source, source + source_size);
    out = storage.data();
    out_size = storage.size();
  }

  static void copyBytesVector(
      const xpod_rdf_bytes* source,
      size_t source_size,
      std::vector<std::string>& string_storage,
      std::vector<xpod_rdf_bytes>& bytes_storage,
      const xpod_rdf_bytes*& out,
      size_t& out_size) {
    string_storage.clear();
    bytes_storage.clear();
    if (source == nullptr || source_size == 0) {
      out = nullptr;
      out_size = 0;
      return;
    }
    string_storage.reserve(source_size);
    bytes_storage.reserve(source_size);
    for (size_t i = 0; i < source_size; ++i) {
      string_storage.emplace_back(
          source[i].data == nullptr ? "" :
              std::string(source[i].data, source[i].size));
      bytes_storage.push_back(
          string_storage.back().empty()
              ? xpod_rdf_bytes{}
              : xpod_rdf_bytes{string_storage.back().data(),
                                string_storage.back().size()});
    }
    out = bytes_storage.data();
    out_size = bytes_storage.size();
  }

  ScanRequestInput input_;
  xpod_rdf_cancellation cancellation_ = {};
  xpod_rdf_snapshot snapshot_ = {};
  xpod_rdf_graph_scope graph_scope_ = {};
  xpod_rdf_source_scope source_scope_ = {};
  xpod_rdf_access_scope access_scope_ = {};
  std::string snapshot_facts_version_storage_;
  std::string snapshot_stats_version_storage_;
  std::string snapshot_token_storage_;
  std::string graph_iri_prefix_storage_;
  std::vector<xpod_rdf_term_key> graph_set_storage_;
  std::string source_workspace_storage_;
  std::string source_uri_storage_;
  std::string source_uri_prefix_storage_;
  std::string source_local_path_storage_;
  std::string source_local_path_prefix_storage_;
  std::string access_principal_storage_;
  std::string access_permission_version_storage_;
  std::vector<xpod_rdf_term_key> allowed_graphs_storage_;
  std::vector<xpod_rdf_term_key> denied_graphs_storage_;
  std::vector<std::string> allowed_graph_prefix_storage_;
  std::vector<xpod_rdf_bytes> allowed_graph_prefix_bytes_;
  std::vector<std::string> denied_graph_prefix_storage_;
  std::vector<xpod_rdf_bytes> denied_graph_prefix_bytes_;
  std::vector<xpod_rdf_source_node_key> allowed_sources_storage_;
  std::vector<xpod_rdf_source_node_key> denied_sources_storage_;
  std::string block_metadata_version_storage_;
};

class XpodQleverVectorLazyScanRange
    : public ad_utility::InputRangeFromGet<
          IdTable,
          CompressedRelationReader::LazyScanMetadata> {
 public:
  explicit XpodQleverVectorLazyScanRange(std::vector<IdTable> blocks)
      : blocks_(std::move(blocks)) {
    details().numBlocksAll_ = blocks_.size();
  }

  std::optional<IdTable> get() override {
    if (next_block_ >= blocks_.size()) {
      return std::nullopt;
    }
    IdTable block = std::move(blocks_[next_block_]);
    ++next_block_;

    details().numBlocksRead_ = next_block_;
    details().numElementsRead_ += block.numRows();
    details().numElementsYielded_ += block.numRows();
    return block;
  }

 private:
  std::vector<IdTable> blocks_;
  size_t next_block_ = 0;
};

class XpodQleverCursorLazyScanRange
    : public ad_utility::InputRangeFromGet<
          IdTable,
          CompressedRelationReader::LazyScanMetadata> {
 public:
  XpodQleverCursorLazyScanRange(
      const xpod::rdf::PhysicalBackend& backend,
      const ScanRequestInput& input,
      const ad_utility::AllocatorWithLimit<Id>& allocator)
      : backend_(backend), input_(input), allocator_(allocator) {
    request_ = makeScanRequest(input_.input());
    details().numBlocksAll_ = input.block_metadata.size();
  }

  ~XpodQleverCursorLazyScanRange() override { closeCursor(); }

  XpodQleverCursorLazyScanRange(const XpodQleverCursorLazyScanRange&) = delete;
  XpodQleverCursorLazyScanRange& operator=(
      const XpodQleverCursorLazyScanRange&) = delete;

  std::optional<IdTable> get() override {
    if (done_) {
      return std::nullopt;
    }
    ensureOpen();
    xpod_rdf_quad_batch batch = {};
    xpod_rdf_status status = backend_.nextScanCursor(cursor_, batch);
    if (status == XPOD_RDF_STATUS_DONE) {
      done_ = true;
      closeCursor();
      return std::nullopt;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      done_ = true;
      closeCursor();
      throw std::runtime_error("Xpod QLever lazy scan cursor failed");
    }
    try {
      recordQleverBackendScanBatch(batch);
      ScopedQleverDiagnosticsStage materialization_stage(
          "id-table-materialization");
      QleverIdRowBuffer rows;
      status = appendEncodedBatch(
          rows, backend_, input_.input().permutation,
          input_.input().needed_slots, batch, input_.input().snapshot);
      if (status != XPOD_RDF_STATUS_OK) {
        done_ = true;
        closeCursor();
        throw std::runtime_error(
            "Xpod QLever lazy scan materialization failed");
      }
      IdTable block = toQleverIdTable(rows, allocator_);
      details().numBlocksRead_ += 1;
      details().numElementsRead_ += block.numRows();
      details().numElementsYielded_ += block.numRows();
      return block;
    } catch (...) {
      done_ = true;
      closeCursor();
      throw;
    }
  }

 private:
  void ensureOpen() {
    if (cursor_ != nullptr) {
      return;
    }
    xpod_rdf_status status = backend_.openScanCursor(request_, cursor_);
    if (status != XPOD_RDF_STATUS_OK) {
      done_ = true;
      closeCursor();
      throw std::runtime_error("Xpod QLever lazy scan cursor open failed");
    }
    recordQleverBackendScanInvocation();
  }

  void closeCursor() noexcept {
    if (cursor_ == nullptr) {
      return;
    }
    backend_.closeScanCursor(cursor_);
    cursor_ = nullptr;
  }

  xpod::rdf::PhysicalBackend backend_;
  XpodQleverOwnedScanInput input_;
  ad_utility::AllocatorWithLimit<Id> allocator_;
  xpod_rdf_scan_request request_ = {};
  xpod_rdf_scan_cursor* cursor_ = nullptr;
  bool done_ = false;
};

inline QleverLazyScanRangeResult toQleverLazyScanRange(
    QleverIdTableBlocksResult lower_result) {
  if (lower_result.status != XPOD_RDF_STATUS_OK) {
    return {lower_result.status, {}};
  }
  if (lower_result.blocks.empty()) {
    return {XPOD_RDF_STATUS_OK, {}};
  }
  auto generator = std::make_unique<XpodQleverVectorLazyScanRange>(
      std::move(lower_result.blocks));
  return {
      XPOD_RDF_STATUS_OK,
      CompressedRelationReader::IdTableGeneratorInputRange{
          std::move(generator)}};
}

inline QleverLazyScanRangeResult toQleverLazyScanRange(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  if (!backend.hasScanCursor()) {
    return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
  }
  auto generator = std::make_unique<XpodQleverCursorLazyScanRange>(
      backend, input, allocator);
  return {
      XPOD_RDF_STATUS_OK,
      CompressedRelationReader::IdTableGeneratorInputRange{
          std::move(generator)}};
}

}  // namespace xpod::qlever
#endif

#endif
