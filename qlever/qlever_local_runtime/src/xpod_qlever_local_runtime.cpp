#include "xpod_qlever_adapter.h"
#include "xpod_rdf_sqlite_backend.h"
#include "xpod_rdf_physical_backend.h"

#if __has_include("util/json.h")
#include "util/json.h"
#else
#include <nlohmann/json.hpp>
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include <unistd.h>

namespace {

using Json = nlohmann::json;

constexpr uint32_t kNativeSparqlAbiVersion = 1;
constexpr std::string_view kDefaultMediaType =
    "application/sparql-results+json";

xpod_rdf_bytes bytes(std::string_view value) {
  return {value.data(), value.size()};
}

std::string bytesToString(xpod_rdf_bytes value) {
  if (value.data == nullptr || value.size == 0) {
    return {};
  }
  return {value.data, value.size};
}

std::string getString(const Json& object, std::string_view key) {
  auto it = object.find(std::string(key));
  return it != object.end() && it->is_string() ? it->get<std::string>()
                                               : std::string{};
}

uint64_t getUint64(const Json& object, std::string_view key) {
  auto it = object.find(std::string(key));
  return it != object.end() && it->is_number_unsigned()
             ? it->get<uint64_t>()
             : 0;
}

bool getBool(const Json& object, std::string_view key) {
  auto it = object.find(std::string(key));
  return it != object.end() && it->is_boolean() && it->get<bool>();
}

bool isAllowedRequestOption(std::string_view key) {
  return key == "basePath" || key == "sourceUri" || key == "operation" ||
         key == "timeoutMs" || key == "acceptMediaType" ||
         key == "loadDocument" || key == "accessScope" ||
         key == "vectorQuery";
}

bool isAllowedLoadDocumentOption(std::string_view key) {
  return key == "sourceUri" || key == "body" || key == "mediaType";
}

bool isAllowedAccessScopeOption(std::string_view key) {
  return key == "basePath" || key == "mode" || key == "resolved" ||
         key == "principal" || key == "allowedGraphUrls" ||
         key == "deniedGraphUrls" || key == "deniedGraphPrefixes" ||
         key == "allowedSourceUrls" || key == "deniedSourceUrls" ||
         key == "deniedSourcePrefixes" || key == "version";
}

bool isAllowedVectorQueryOption(std::string_view key) {
  return key == "embedding" || key == "metric" || key == "provider" ||
         key == "model" || key == "modelVersion" || key == "inputKind" ||
         key == "projectionPolicyVersion" || key == "limit" ||
         key == "retrievalPointVariable" || key == "resourceVariable" ||
         key == "threshold";
}

bool containsOnlyAllowedOptions(
    const Json& options,
    bool (*isAllowed)(std::string_view)) {
  if (!options.is_object()) {
    return false;
  }
  for (const auto& item : options.items()) {
    if (!isAllowed(item.key())) {
      return false;
    }
  }
  return true;
}

bool getDoubleArray(
    const Json& object,
    std::string_view key,
    std::vector<double>& outValues) {
  outValues.clear();
  auto it = object.find(std::string(key));
  if (it == object.end() || !it->is_array() || it->empty()) {
    return false;
  }
  outValues.reserve(it->size());
  for (const Json& value : *it) {
    if (!value.is_number()) {
      outValues.clear();
      return false;
    }
    const double number = value.get<double>();
    if (!std::isfinite(number)) {
      outValues.clear();
      return false;
    }
    outValues.push_back(number);
  }
  return true;
}

bool getFiniteDouble(const Json& object, std::string_view key, double& outValue) {
  auto it = object.find(std::string(key));
  if (it == object.end() || !it->is_number()) {
    return false;
  }
  const double number = it->get<double>();
  if (!std::isfinite(number)) {
    return false;
  }
  outValue = number;
  return true;
}

bool vectorMetricFromString(
    const std::string& value,
    xpod_rdf_vector_metric& outMetric) {
  if (value.empty() || value == "cosine") {
    outMetric = XPOD_RDF_VECTOR_COSINE;
    return true;
  }
  if (value == "dot") {
    outMetric = XPOD_RDF_VECTOR_DOT;
    return true;
  }
  if (value == "euclidean") {
    outMetric = XPOD_RDF_VECTOR_EUCLIDEAN;
    return true;
  }
  return false;
}

std::vector<std::string> getStringArray(
    const Json& object,
    std::string_view key) {
  std::vector<std::string> out;
  auto it = object.find(std::string(key));
  if (it == object.end() || !it->is_array()) {
    return out;
  }
  for (const Json& value : *it) {
    if (value.is_string()) {
      out.push_back(value.get<std::string>());
    }
  }
  return out;
}

struct Arguments {
  std::string databasePath;
};

Arguments parseArguments(int argc, char** argv) {
  Arguments arguments;
  for (int i = 1; i < argc; ++i) {
    std::string_view arg = argv[i];
    if (arg == "--sqlite-path" && i + 1 < argc) {
      arguments.databasePath = argv[++i];
    } else if (arg.starts_with("--sqlite-path=")) {
      arguments.databasePath =
          std::string(arg.substr(std::string_view("--sqlite-path=").size()));
    } else {
      throw std::runtime_error("unsupported argument: " + std::string(arg));
    }
  }
  if (arguments.databasePath.empty()) {
    throw std::runtime_error("--sqlite-path is required");
  }
  return arguments;
}

struct OwnedStrings {
  std::deque<std::string> strings;

  xpod_rdf_bytes keepBytes(std::string value) {
    strings.push_back(std::move(value));
    const std::string& stored = strings.back();
    return {stored.data(), stored.size()};
  }
};

struct LocalCancellationState {
  std::atomic<bool> cancelled = false;
  bool hasDeadline = false;
  std::chrono::steady_clock::time_point deadline;
};

uint8_t localCancellationRequested(void* userData) {
  auto* state = static_cast<LocalCancellationState*>(userData);
  if (state == nullptr) {
    return 0;
  }
  if (state->cancelled.load(std::memory_order_relaxed)) {
    return 1;
  }
  return state->hasDeadline &&
                 std::chrono::steady_clock::now() >= state->deadline
             ? 1
             : 0;
}

struct RequestStorage {
  explicit RequestStorage(std::shared_ptr<LocalCancellationState> state)
      : cancellationState(std::move(state)) {}

  OwnedStrings owned;
  std::vector<xpod_rdf_term_key> allowedGraphs;
  std::vector<xpod_rdf_term_key> deniedGraphs;
  std::vector<xpod_rdf_source_node_key> allowedSources;
  std::vector<xpod_rdf_source_node_key> deniedSources;
  std::vector<std::string> allowedPrefixValues;
  std::vector<std::string> deniedPrefixValues;
  std::vector<xpod_rdf_bytes> allowedPrefixes;
  std::vector<xpod_rdf_bytes> deniedPrefixes;
  xpod_rdf_access_scope accessScope = {};
  std::shared_ptr<LocalCancellationState> cancellationState;
  xpod_rdf_cancellation cancellation = {};
  std::vector<double> vectorValues;
  xpod_qlever_vector_query vectorQuery = {};
};

xpod_rdf_term iriTerm(std::string_view value) {
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_IRI;
  term.value = bytes(value);
  return term;
}

xpod_rdf_status lookupIriTerms(
    xpod_qlever_adapter* adapter,
    const std::vector<std::string>& values,
    const xpod_rdf_snapshot& snapshot,
    std::vector<xpod_rdf_term_key>& outKeys,
    bool requireExisting) {
  if (values.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<xpod_rdf_term> terms;
  std::vector<xpod_rdf_term_key> keys(values.size(), 0);
  std::vector<xpod_rdf_status> statuses(values.size(), XPOD_RDF_STATUS_OK);
  terms.reserve(values.size());
  for (const std::string& value : values) {
    terms.push_back(iriTerm(value));
  }

  const xpod_rdf_status status = xpod_qlever_adapter_lookup_terms(
      adapter, terms.data(), terms.size(), &snapshot, keys.data(),
      statuses.data());
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }

  for (size_t index = 0; index < statuses.size(); ++index) {
    if (statuses[index] == XPOD_RDF_STATUS_OK) {
      outKeys.push_back(keys[index]);
      continue;
    }
    if (!requireExisting && statuses[index] == XPOD_RDF_STATUS_NOT_FOUND) {
      continue;
    }
    return requireExisting ? XPOD_RDF_STATUS_PERMISSION_DENIED
                           : statuses[index];
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_source_scope exactSourceScope(std::string_view value) {
  xpod_rdf_source_scope scope = {};
  scope.source_uri = bytes(value);
  return scope;
}

xpod_rdf_source_scope prefixSourceScope(std::string_view value) {
  xpod_rdf_source_scope scope = {};
  scope.source_uri_prefix = bytes(value);
  return scope;
}

xpod_rdf_status resolveSourceScope(
    xpod_qlever_adapter* adapter,
    const xpod_rdf_source_scope& scope,
    const xpod_rdf_snapshot& snapshot,
    std::vector<xpod_rdf_source_node_key>& outSources,
    bool requireExisting) {
  xpod_rdf_resolved_source_scope resolved = {};
  const xpod_rdf_status status = xpod_qlever_adapter_resolve_source_scope(
      adapter, &scope, &snapshot, &resolved);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  if (resolved.source_nodes_size == 0) {
    return requireExisting ? XPOD_RDF_STATUS_PERMISSION_DENIED
                           : XPOD_RDF_STATUS_OK;
  }
  outSources.insert(
      outSources.end(),
      resolved.source_nodes,
      resolved.source_nodes + resolved.source_nodes_size);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status resolveSourceUrls(
    xpod_qlever_adapter* adapter,
    const std::vector<std::string>& values,
    const xpod_rdf_snapshot& snapshot,
    std::vector<xpod_rdf_source_node_key>& outSources,
    bool requireExisting) {
  for (const std::string& value : values) {
    const xpod_rdf_status status = resolveSourceScope(
        adapter, exactSourceScope(value), snapshot, outSources, requireExisting);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status resolveSourcePrefixes(
    xpod_qlever_adapter* adapter,
    const std::vector<std::string>& values,
    const xpod_rdf_snapshot& snapshot,
    std::vector<xpod_rdf_source_node_key>& outSources) {
  for (const std::string& value : values) {
    const xpod_rdf_status status = resolveSourceScope(
        adapter, prefixSourceScope(value), snapshot, outSources, false);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

void setPrefixBytes(
    const std::vector<std::string>& values,
    std::vector<std::string>& ownedValues,
    std::vector<xpod_rdf_bytes>& outBytes) {
  ownedValues = values;
  outBytes.clear();
  outBytes.reserve(ownedValues.size());
  for (const std::string& value : ownedValues) {
    outBytes.push_back(bytes(value));
  }
}

xpod_rdf_access_mode accessModeFromString(std::string_view value) {
  if (value == "write") {
    return XPOD_RDF_ACCESS_WRITE;
  }
  if (value == "append") {
    return XPOD_RDF_ACCESS_APPEND;
  }
  if (value == "control") {
    return XPOD_RDF_ACCESS_CONTROL;
  }
  return XPOD_RDF_ACCESS_READ;
}

xpod_rdf_status applyRequestOptions(
    xpod_qlever_adapter* adapter,
    const Json& message,
    xpod_qlever_query_request& request,
    RequestStorage& storage) {
  const Json options = message.value("options", Json::object());
  if (!containsOnlyAllowedOptions(options, isAllowedRequestOption)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const std::string sparql = message.value("sparql", std::string{});
  request.sparql = storage.owned.keepBytes(sparql);
  request.accept_media_type = bytes(kDefaultMediaType);
  request.operation = XPOD_QLEVER_REQUEST_QUERY_ONLY;

  storage.cancellation = {storage.cancellationState.get(),
                          localCancellationRequested};
  request.cancellation = &storage.cancellation;

  const std::string operation = getString(options, "operation");
  if (operation == "prepareUpdate") {
    request.operation = XPOD_QLEVER_REQUEST_PREPARE_UPDATE;
  } else if (!operation.empty() && operation != "queryBindings" &&
             operation != "queryBoolean" && operation != "queryQuads") {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  if (const std::string accept = getString(options, "acceptMediaType");
      !accept.empty()) {
    request.accept_media_type = storage.owned.keepBytes(accept);
  }
  if (const std::string basePath = getString(options, "basePath");
      !basePath.empty()) {
    if (request.operation != XPOD_QLEVER_REQUEST_PREPARE_UPDATE) {
      request.source_scope.source_uri_prefix = storage.owned.keepBytes(basePath);
    }
    request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_PREFIX;
    request.graph_scope.iri_prefix = storage.owned.keepBytes(basePath);
  }
  if (const std::string sourceUri = getString(options, "sourceUri");
      !sourceUri.empty()) {
    request.source_scope.source_uri = storage.owned.keepBytes(sourceUri);
  }
  if (const uint64_t timeout = getUint64(options, "timeoutMs"); timeout != 0) {
    storage.cancellationState->hasDeadline = true;
    storage.cancellationState->deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
  }

  if (options.contains("vectorQuery")) {
    const Json& vectorQuery = options.at("vectorQuery");
    if (!containsOnlyAllowedOptions(vectorQuery, isAllowedVectorQueryOption) ||
        !getDoubleArray(vectorQuery, "embedding", storage.vectorValues) ||
        getString(vectorQuery, "provider").empty() ||
        getString(vectorQuery, "model").empty() ||
        getString(vectorQuery, "modelVersion").empty() ||
        getString(vectorQuery, "inputKind").empty() ||
        getString(vectorQuery, "projectionPolicyVersion").empty() ||
        (getString(vectorQuery, "retrievalPointVariable").empty() &&
         getString(vectorQuery, "resourceVariable").empty())) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    const uint64_t limit = getUint64(vectorQuery, "limit");
    if (limit == 0 || !vectorMetricFromString(
                          getString(vectorQuery, "metric"),
                          storage.vectorQuery.metric)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    storage.vectorQuery.vector = storage.vectorValues.data();
    storage.vectorQuery.dimensions = storage.vectorValues.size();
    storage.vectorQuery.provider =
        storage.owned.keepBytes(getString(vectorQuery, "provider"));
    storage.vectorQuery.model =
        storage.owned.keepBytes(getString(vectorQuery, "model"));
    storage.vectorQuery.model_version =
        storage.owned.keepBytes(getString(vectorQuery, "modelVersion"));
    storage.vectorQuery.input_kind =
        storage.owned.keepBytes(getString(vectorQuery, "inputKind"));
    storage.vectorQuery.projection_policy_version = storage.owned.keepBytes(
        getString(vectorQuery, "projectionPolicyVersion"));
    storage.vectorQuery.limit = limit;
    storage.vectorQuery.retrieval_point_variable =
        storage.owned.keepBytes(getString(vectorQuery, "retrievalPointVariable"));
    storage.vectorQuery.resource_variable =
        storage.owned.keepBytes(getString(vectorQuery, "resourceVariable"));
    double threshold = 0.0;
    if (getFiniteDouble(vectorQuery, "threshold", threshold)) {
      storage.vectorQuery.threshold = threshold;
      storage.vectorQuery.has_threshold = 1;
    } else if (vectorQuery.contains("threshold")) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    request.vector_query = &storage.vectorQuery;
  }

  if (options.contains("loadDocument")) {
    const Json& loadDocument = options.at("loadDocument");
    if (!containsOnlyAllowedOptions(loadDocument, isAllowedLoadDocumentOption)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    const std::string sourceUri = getString(loadDocument, "sourceUri");
    if (sourceUri.empty() || !loadDocument.contains("body") ||
        !loadDocument.at("body").is_string()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    std::string mediaType = getString(loadDocument, "mediaType");
    if (mediaType.empty()) {
      mediaType = "application/n-triples";
    }
    request.has_load_document = 1;
    request.load_document_source_uri = storage.owned.keepBytes(sourceUri);
    request.load_document_body =
        storage.owned.keepBytes(loadDocument.at("body").get<std::string>());
    request.load_document_media_type =
        storage.owned.keepBytes(std::move(mediaType));
  }

  if (request.operation == XPOD_QLEVER_REQUEST_PREPARE_UPDATE &&
      (request.source_scope.source_uri.data == nullptr ||
       request.source_scope.source_uri.size == 0)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  if (!options.contains("accessScope")) {
    return XPOD_RDF_STATUS_OK;
  }
  const Json& access = options.at("accessScope");
  if (!containsOnlyAllowedOptions(access, isAllowedAccessScopeOption)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  const std::vector<std::string> allowedGraphUrls =
      getStringArray(access, "allowedGraphUrls");
  const std::vector<std::string> deniedGraphUrls =
      getStringArray(access, "deniedGraphUrls");
  const std::vector<std::string> allowedSourceUrls =
      getStringArray(access, "allowedSourceUrls");
  const std::vector<std::string> deniedSourceUrls =
      getStringArray(access, "deniedSourceUrls");
  const std::vector<std::string> deniedGraphPrefixes =
      getStringArray(access, "deniedGraphPrefixes");
  const std::vector<std::string> deniedSourcePrefixes =
      getStringArray(access, "deniedSourcePrefixes");
  std::vector<std::string> allowedGraphPrefixes;
  if (const std::string accessBasePath = getString(access, "basePath");
      !accessBasePath.empty()) {
    allowedGraphPrefixes.push_back(accessBasePath);
  }
  const std::string principal = getString(access, "principal");
  const std::string permissionVersion = getString(access, "version");
  const bool resolvedScope = getBool(access, "resolved");
  const bool hasAccessIdentity =
      !principal.empty() || !permissionVersion.empty();
  const bool hasAccessBoundary =
      !allowedGraphUrls.empty() || !deniedGraphUrls.empty() ||
      !allowedGraphPrefixes.empty() ||
      !allowedSourceUrls.empty() || !deniedSourceUrls.empty() ||
      !deniedGraphPrefixes.empty() || !deniedSourcePrefixes.empty();
  if (hasAccessIdentity && !hasAccessBoundary && !resolvedScope) {
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  xpod_rdf_status lookupStatus = lookupIriTerms(
      adapter, allowedGraphUrls, request.snapshot, storage.allowedGraphs, true);
  if (lookupStatus != XPOD_RDF_STATUS_OK) {
    return lookupStatus;
  }
  lookupStatus = lookupIriTerms(
      adapter, deniedGraphUrls, request.snapshot, storage.deniedGraphs, false);
  if (lookupStatus != XPOD_RDF_STATUS_OK) {
    return lookupStatus;
  }
  lookupStatus = resolveSourceUrls(
      adapter, allowedSourceUrls, request.snapshot, storage.allowedSources, true);
  if (lookupStatus != XPOD_RDF_STATUS_OK) {
    return lookupStatus;
  }
  lookupStatus = resolveSourceUrls(
      adapter, deniedSourceUrls, request.snapshot, storage.deniedSources, false);
  if (lookupStatus != XPOD_RDF_STATUS_OK) {
    return lookupStatus;
  }
  setPrefixBytes(
      allowedGraphPrefixes,
      storage.allowedPrefixValues,
      storage.allowedPrefixes);
  setPrefixBytes(
      deniedGraphPrefixes, storage.deniedPrefixValues, storage.deniedPrefixes);
  lookupStatus = resolveSourcePrefixes(
      adapter, deniedSourcePrefixes, request.snapshot, storage.deniedSources);
  if (lookupStatus != XPOD_RDF_STATUS_OK) {
    return lookupStatus;
  }

  storage.accessScope.principal = storage.owned.keepBytes(principal);
  storage.accessScope.permission_version =
      storage.owned.keepBytes(permissionVersion);
  storage.accessScope.mode = accessModeFromString(getString(access, "mode"));
  storage.accessScope.authorization_model = XPOD_RDF_AUTH_MIXED;
  storage.accessScope.allowed_graphs = storage.allowedGraphs.data();
  storage.accessScope.allowed_graphs_size = storage.allowedGraphs.size();
  storage.accessScope.denied_graphs = storage.deniedGraphs.data();
  storage.accessScope.denied_graphs_size = storage.deniedGraphs.size();
  storage.accessScope.allowed_graph_prefixes = storage.allowedPrefixes.data();
  storage.accessScope.allowed_graph_prefixes_size =
      storage.allowedPrefixes.size();
  storage.accessScope.denied_graph_prefixes = storage.deniedPrefixes.data();
  storage.accessScope.denied_graph_prefixes_size =
      storage.deniedPrefixes.size();
  storage.accessScope.allowed_sources = storage.allowedSources.data();
  storage.accessScope.allowed_sources_size = storage.allowedSources.size();
  storage.accessScope.denied_sources = storage.deniedSources.data();
  storage.accessScope.denied_sources_size = storage.deniedSources.size();
  request.access_scope = &storage.accessScope;
  return XPOD_RDF_STATUS_OK;
}

std::string statusName(xpod_rdf_status status) {
  switch (status) {
    case XPOD_RDF_STATUS_OK:
      return "ok";
    case XPOD_RDF_STATUS_UNSUPPORTED:
      return "unsupported";
    default:
      return "error";
  }
}

std::string syscallError(std::string_view operation) {
  return std::string(operation) + " failed: " + std::strerror(errno);
}

void writeAll(int fd, std::string_view value) {
  const char* cursor = value.data();
  size_t remaining = value.size();
  while (remaining > 0) {
    const ssize_t written = ::write(fd, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      throw std::runtime_error(syscallError("write protocol stdout"));
    }
    if (written == 0) {
      throw std::runtime_error("write protocol stdout failed: wrote zero bytes");
    }
    cursor += written;
    remaining -= static_cast<size_t>(written);
  }
}

class ProtocolOutput {
 public:
  static ProtocolOutput isolateStdout() {
    std::cout.flush();
    std::fflush(stdout);
    const int protocolFd = ::dup(STDOUT_FILENO);
    if (protocolFd < 0) {
      throw std::runtime_error(syscallError("dup protocol stdout"));
    }
    if (::dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
      const int savedErrno = errno;
      ::close(protocolFd);
      errno = savedErrno;
      throw std::runtime_error(syscallError("redirect stdout to stderr"));
    }
    return ProtocolOutput(protocolFd);
  }

  ProtocolOutput(const ProtocolOutput&) = delete;
  ProtocolOutput& operator=(const ProtocolOutput&) = delete;

  ~ProtocolOutput() {
    if (fd_ >= 0) {
      ::close(fd_);
    }
  }

  void writeJson(const Json& value) {
    const std::lock_guard lock(mutex_);
    const std::string line = value.dump() + "\n";
    writeAll(fd_, line);
  }

 private:
  explicit ProtocolOutput(int fd) : fd_(fd) {}

  int fd_ = -1;
  std::mutex mutex_;
};

void writeReady(ProtocolOutput& output) {
  output.writeJson({
      {"type", "ready"},
      {"abiVersion", kNativeSparqlAbiVersion},
      {"adapterAbiVersion", xpod_qlever_adapter_abi_version()},
      {"physicalBackendAbiVersion", XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION},
      {"backend", "sqlite"},
  });
}

void writeError(
    const std::string& id,
    std::string_view code,
    std::string_view message,
    ProtocolOutput& output) {
  output.writeJson({
      {"id", id},
      {"type", "error"},
      {"code", code},
      {"message", message},
  });
}

void writeResult(
    const std::string& id,
    const xpod_qlever_query_result& result,
    xpod_rdf_status queryStatus,
    ProtocolOutput& output) {
  const std::string mediaType = bytesToString(result.result_media_type).empty()
      ? std::string(kDefaultMediaType)
      : bytesToString(result.result_media_type);
  const std::string profile = bytesToString(result.profile_json);
  xpod_rdf_status resultStatus =
      result.status == XPOD_RDF_STATUS_OK ? queryStatus : result.status;
  Json profileJson = nullptr;
  if (!profile.empty()) {
    profileJson = Json::parse(profile, nullptr, false);
    if (profileJson.is_discarded()) {
      profileJson = profile;
    }
  }
  output.writeJson({
      {"id", id},
      {"type", "result"},
      {"result",
       {
           {"status", statusName(resultStatus)},
           {"mediaType", mediaType},
           {"body", bytesToString(result.result_json)},
           {"profile", profileJson},
           {"queryStatus", static_cast<int>(queryStatus)},
           {"error", bytesToString(result.error_message)},
       }},
  });
}

struct LocalRuntimeBackend {
  xpod_rdf_backend_v1* backend = nullptr;

  LocalRuntimeBackend() = default;
  LocalRuntimeBackend(const LocalRuntimeBackend&) = delete;
  LocalRuntimeBackend& operator=(const LocalRuntimeBackend&) = delete;

  ~LocalRuntimeBackend() {
    if (backend != nullptr) {
      xpod_rdf_sqlite_backend_destroy(backend);
    }
  }
};

xpod_qlever_adapter* createAdapter(
    const Arguments& arguments,
    LocalRuntimeBackend& localBackend) {
  xpod_rdf_sqlite_backend_config sqliteConfig = {};
  sqliteConfig.database_path = bytes(arguments.databasePath);
  const xpod_rdf_status backendStatus =
      xpod_rdf_sqlite_backend_create(&sqliteConfig, &localBackend.backend);
  if (backendStatus != XPOD_RDF_STATUS_OK || localBackend.backend == nullptr) {
    throw std::runtime_error("SQLite RDF backend create failed");
  }
  xpod_qlever_adapter_config config = {};
  config.backend = localBackend.backend;
  config.enable_runtime_profile = 1;
  config.execution_policy = XPOD_QLEVER_EXECUTION_NATIVE_ONLY;
  xpod_qlever_adapter* adapter = nullptr;
  xpod_rdf_status status = xpod_qlever_adapter_create(&config, &adapter);
  if (status != XPOD_RDF_STATUS_OK || adapter == nullptr) {
    throw std::runtime_error("QLever adapter create failed");
  }
  return adapter;
}

int run(int argc, char** argv) {
  ProtocolOutput output = ProtocolOutput::isolateStdout();
  Arguments arguments = parseArguments(argc, argv);
  LocalRuntimeBackend localBackend;
  xpod_qlever_adapter* adapter = createAdapter(arguments, localBackend);
  struct QueryTask {
    std::string id;
    Json message;
    std::shared_ptr<LocalCancellationState> cancellation;
  };
  std::mutex stateMutex;
  std::condition_variable workAvailable;
  std::deque<QueryTask> tasks;
  std::unordered_map<std::string, std::shared_ptr<LocalCancellationState>>
      cancellations;
  bool stopping = false;

  writeReady(output);

  std::thread queryWorker([&]() {
    while (true) {
      QueryTask task;
      {
        std::unique_lock lock(stateMutex);
        workAvailable.wait(lock, [&]() { return stopping || !tasks.empty(); });
        if (tasks.empty()) {
          if (stopping) {
            return;
          }
          continue;
        }
        task = std::move(tasks.front());
        tasks.pop_front();
      }

      try {
        RequestStorage storage(task.cancellation);
        xpod_qlever_query_request request = {};
        const xpod_rdf_status optionStatus =
            applyRequestOptions(adapter, task.message, request, storage);
        if (optionStatus != XPOD_RDF_STATUS_OK) {
          writeError(
              task.id, statusName(optionStatus),
              "query options could not be mapped to the native QLever ABI",
              output);
        } else {
          xpod_qlever_query_result result = {};
          const xpod_rdf_status queryStatus =
              xpod_qlever_adapter_query_request(adapter, &request, &result);
          writeResult(task.id, result, queryStatus, output);
          xpod_qlever_adapter_release_result(adapter, &result);
        }
      } catch (const std::exception& error) {
        writeError(
            task.id, "qlever_runtime_protocol_error", error.what(),
            output);
      }

      const std::lock_guard lock(stateMutex);
      cancellations.erase(task.id);
    }
  });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }
    Json message;
    try {
      message = Json::parse(line);
    } catch (const std::exception& error) {
      writeError(
          "", "qlever_runtime_protocol_error", error.what(), output);
      continue;
    }

    const std::string id = message.value("id", std::string{});
    const std::string type = message.value("type", std::string{});
    if (type == "shutdown") {
      break;
    }
    if (type == "cancel") {
      const std::lock_guard lock(stateMutex);
      if (const auto it = cancellations.find(id); it != cancellations.end()) {
        it->second->cancelled.store(true, std::memory_order_relaxed);
      }
      continue;
    }
    if (type != "query") {
      writeError(
          id,
          "qlever_runtime_protocol_error",
          "unsupported protocol message type",
          output);
      continue;
    }
    if (id.empty()) {
      writeError(
          id, "qlever_runtime_protocol_error", "query id is required", output);
      continue;
    }
    auto cancellation = std::make_shared<LocalCancellationState>();
    bool duplicateQueryId = false;
    {
      const std::lock_guard lock(stateMutex);
      duplicateQueryId = cancellations.contains(id);
      if (!duplicateQueryId) {
        cancellations.emplace(id, cancellation);
        tasks.push_back({id, std::move(message), std::move(cancellation)});
      }
    }
    if (duplicateQueryId) {
      writeError(
          id, "qlever_runtime_protocol_error", "duplicate query id", output);
      continue;
    }
    workAvailable.notify_one();
  }

  std::vector<std::string> abortedTaskIds;
  {
    const std::lock_guard lock(stateMutex);
    stopping = true;
    for (const auto& [id, cancellation] : cancellations) {
      (void)id;
      cancellation->cancelled.store(true, std::memory_order_relaxed);
    }
    for (const QueryTask& task : tasks) {
      abortedTaskIds.push_back(task.id);
      cancellations.erase(task.id);
    }
    tasks.clear();
  }
  for (const std::string& id : abortedTaskIds) {
    writeError(
        id, "qlever_request_aborted", "runtime is shutting down", output);
  }
  workAvailable.notify_one();
  queryWorker.join();

  xpod_qlever_adapter_destroy(adapter);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "xpod_qlever_local_runtime: " << error.what() << '\n';
    return 1;
  }
}
