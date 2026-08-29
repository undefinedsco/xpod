#include "xpod_rdf_sqlite_backend.h"

#if __has_include("util/json.h")
#include "util/json.h"
#else
#include <nlohmann/json.hpp>
#endif

#include <sqlite3.h>

#include "XpodNumericLiteralCompare.hpp"

#include <openssl/evp.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cctype>
#include <iomanip>
#include <deque>
#include <exception>
#include <initializer_list>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

struct xpod_rdf_scan_cursor {
  std::vector<xpod_rdf_quad_key> rows;
  size_t offset = 0;
  size_t batch_size = 1;
  uint32_t sorted_slots = 0;
};

namespace {

using Json = nlohmann::json;

constexpr uint32_t kMaxBatchSize = 4096;
constexpr size_t kMaxTermTupleFilterRows = 65536;
constexpr std::string_view kSqliteTextScorer = "sqlite-text-postings";
constexpr std::string_view kSqliteVectorScorer = "sqlite-vector-scan";
constexpr std::string_view kRequiredFactsSchemaVersion = "1";
constexpr std::string_view kRequiredTextSchemaVersion = "3";
constexpr std::string_view kRequiredVectorSchemaVersion = "2";
constexpr xpod_rdf_term_key XPOD_RDF_DEFAULT_GRAPH_KEY = 0;
constexpr std::string_view kRdfLangString =
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
constexpr std::string_view kXsdString = "http://www.w3.org/2001/XMLSchema#string";
constexpr std::string_view kQleverDefaultGraphIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph";
constexpr std::string_view kQleverDefaultGraphIriRef =
    "<http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph>";
constexpr uint64_t kQleverValueIdDataBits = 60;
constexpr uint64_t kQleverValueIdDataMask =
    std::numeric_limits<uint64_t>::max() >> 4;
constexpr uint64_t kQleverVocabIndexDatatype = 4;
constexpr uint64_t kQleverBlankNodeIndexDatatype = 10;

struct XpodRdfSqliteBackendState {
  xpod_rdf_backend_v1 backend = {};
  sqlite3* db = nullptr;
  std::string database_path;
  std::deque<std::string> owned_strings;
  std::vector<xpod_rdf_source_node_key> owned_source_nodes;
  std::vector<xpod_rdf_term_key> owned_graphs;
  std::vector<xpod_rdf_term_key> owned_allowed_graphs;
  std::vector<xpod_rdf_term_key> owned_denied_graphs;
  std::vector<xpod_rdf_source_node_key> owned_allowed_sources;
  std::vector<xpod_rdf_source_node_key> owned_denied_sources;
  std::vector<std::string> owned_allowed_graph_prefix_strings;
  std::vector<std::string> owned_denied_graph_prefix_strings;
  std::vector<xpod_rdf_bytes> owned_allowed_graph_prefixes;
  std::vector<xpod_rdf_bytes> owned_denied_graph_prefixes;
  xpod_rdf_term_key cached_default_graph_key = 0;
  bool has_cached_default_graph_key = false;
  bool read_only = true;
  bool has_text = false;
  bool has_vector = false;
  bool transaction_active = false;
  bool transaction_dirty = false;
};

xpod_rdf_status default_graph_key(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key* out_key);
xpod_rdf_status metadata_value(
    XpodRdfSqliteBackendState* state,
    const char* key,
    std::string* out);
xpod_rdf_status table_metadata_value(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* key,
    std::string* out);

struct SqlParam {
  enum class Kind { U64, Real, Text };
  Kind kind;
  uint64_t integer = 0;
  double real = 0.0;
  std::string text;
};

void add_u64(std::vector<SqlParam>* params, uint64_t value) {
  SqlParam param;
  param.kind = SqlParam::Kind::U64;
  param.integer = value;
  params->push_back(param);
}

void add_text(std::vector<SqlParam>* params, std::string value) {
  SqlParam param;
  param.kind = SqlParam::Kind::Text;
  param.text = std::move(value);
  params->push_back(std::move(param));
}

void add_real(std::vector<SqlParam>* params, double value) {
  SqlParam param;
  param.kind = SqlParam::Kind::Real;
  param.real = value;
  params->push_back(param);
}

std::string bytes_to_string(xpod_rdf_bytes bytes) {
  if (bytes.data == nullptr || bytes.size == 0) {
    return {};
  }
  return {bytes.data, bytes.size};
}

bool has_bytes(xpod_rdf_bytes bytes) {
  return bytes.data != nullptr && bytes.size != 0;
}

bool term_key_fits_qlever_value_id(xpod_rdf_term_key term) {
  return (term & ~kQleverValueIdDataMask) == 0;
}

xpod_rdf_bytes static_bytes(std::string_view value) {
  return {value.data(), value.size()};
}

xpod_rdf_bytes owned_bytes(XpodRdfSqliteBackendState* state, std::string value) {
  state->owned_strings.push_back(std::move(value));
  const std::string& stored = state->owned_strings.back();
  return {stored.data(), stored.size()};
}

bool cancellation_requested(const xpod_rdf_cancellation* cancellation) {
  return cancellation != nullptr && cancellation->is_cancelled != nullptr &&
         cancellation->is_cancelled(cancellation->cancellation_user_data) != 0;
}

size_t effective_batch_size(uint32_t requested) {
  if (requested == 0 || requested > kMaxBatchSize) {
    return kMaxBatchSize;
  }
  return requested;
}

xpod_rdf_status sqlite_status(int rc) {
  return rc == SQLITE_OK || rc == SQLITE_DONE || rc == SQLITE_ROW
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_BACKEND_ERROR;
}

struct Statement {
  sqlite3_stmt* stmt = nullptr;
  ~Statement() {
    if (stmt != nullptr) {
      sqlite3_finalize(stmt);
    }
  }
};

xpod_rdf_status prepare(
    XpodRdfSqliteBackendState* state,
    const std::string& sql,
    Statement* out) {
  if (state == nullptr || state->db == nullptr || out == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  return sqlite_status(sqlite3_prepare_v2(
      state->db, sql.c_str(), static_cast<int>(sql.size()), &out->stmt, nullptr));
}

xpod_rdf_status bind_u64(sqlite3_stmt* stmt, int index, uint64_t value) {
  return sqlite_status(sqlite3_bind_int64(
      stmt, index, static_cast<sqlite3_int64>(value)));
}

xpod_rdf_status bind_bytes(sqlite3_stmt* stmt, int index, xpod_rdf_bytes value) {
  return sqlite_status(sqlite3_bind_text(
      stmt,
      index,
      value.data == nullptr ? "" : value.data,
      static_cast<int>(value.size),
      SQLITE_TRANSIENT));
}

xpod_rdf_status bind_params(sqlite3_stmt* stmt, const std::vector<SqlParam>& params) {
  int index = 1;
  for (const SqlParam& param : params) {
    xpod_rdf_status status = XPOD_RDF_STATUS_OK;
    if (param.kind == SqlParam::Kind::U64) {
      status = bind_u64(stmt, index, param.integer);
    } else if (param.kind == SqlParam::Kind::Real) {
      status = sqlite_status(sqlite3_bind_double(stmt, index, param.real));
    } else {
      status = sqlite_status(sqlite3_bind_text(
          stmt,
          index,
          param.text.c_str(),
          static_cast<int>(param.text.size()),
          SQLITE_TRANSIENT));
    }
    if (status != XPOD_RDF_STATUS_OK) return status;
    ++index;
  }
  return XPOD_RDF_STATUS_OK;
}

bool prefix_upper_bound(const std::string& prefix, std::string* upper) {
  if (upper == nullptr || prefix.empty()) return false;
  *upper = prefix;
  for (size_t i = upper->size(); i > 0; --i) {
    unsigned char value = static_cast<unsigned char>((*upper)[i - 1]);
    if (value != std::numeric_limits<unsigned char>::max()) {
      (*upper)[i - 1] = static_cast<char>(value + 1);
      upper->resize(i);
      return true;
    }
  }
  upper->clear();
  return false;
}

void append_prefix_condition(
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const std::string& column,
    const std::string& prefix) {
  if (prefix.empty()) return;
  std::string upper;
  conditions->push_back(column + " >= ?");
  add_text(params, prefix);
  if (prefix_upper_bound(prefix, &upper)) {
    conditions->back() += " AND " + column + " < ?";
    add_text(params, upper);
  }
}

std::string placeholders(size_t count) {
  std::string out;
  for (size_t i = 0; i < count; ++i) {
    if (i != 0) out += ", ";
    out += "?";
  }
  return out;
}

bool has_table(XpodRdfSqliteBackendState* state, const char* table) {
  Statement stmt;
  if (prepare(
          state,
          "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
          &stmt) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(stmt.stmt, 1, table, -1, SQLITE_STATIC);
  return sqlite3_step(stmt.stmt) == SQLITE_ROW;
}

bool has_column(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* column) {
  Statement stmt;
  if (prepare(state, "SELECT name FROM pragma_table_info(?) WHERE name = ?", &stmt) !=
      XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(stmt.stmt, 1, table, -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt.stmt, 2, column, -1, SQLITE_STATIC);
  return sqlite3_step(stmt.stmt) == SQLITE_ROW;
}

bool has_columns(
    XpodRdfSqliteBackendState* state,
    const char* table,
    std::initializer_list<const char*> columns) {
  if (!has_table(state, table)) return false;
  for (const char* column : columns) {
    if (!has_column(state, table, column)) return false;
  }
  return true;
}

bool has_exact_columns(
    XpodRdfSqliteBackendState* state,
    const char* table,
    std::initializer_list<const char*> columns) {
  if (!has_table(state, table)) return false;
  Statement stmt;
  if (prepare(
          state,
          "SELECT name FROM pragma_table_info(?) ORDER BY cid",
          &stmt) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(stmt.stmt, 1, table, -1, SQLITE_STATIC);
  auto expected = columns.begin();
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    if (expected == columns.end()) return false;
    const unsigned char* name = sqlite3_column_text(stmt.stmt, 0);
    if (name == nullptr ||
        std::string_view(reinterpret_cast<const char*>(name)) != *expected) {
      return false;
    }
    ++expected;
  }
  return rc == SQLITE_DONE && expected == columns.end();
}

bool has_exact_index(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* index,
    bool unique,
    std::initializer_list<const char*> columns) {
  Statement definition;
  if (prepare(
          state,
          "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
          &definition) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(definition.stmt, 1, index, -1, SQLITE_STATIC);
  if (sqlite3_step(definition.stmt) != SQLITE_ROW) return false;
  const unsigned char* owner = sqlite3_column_text(definition.stmt, 0);
  if (owner == nullptr ||
      std::string_view(reinterpret_cast<const char*>(owner)) != table) {
    return false;
  }

  Statement index_list;
  if (prepare(
          state,
          "SELECT \"unique\" FROM pragma_index_list(?) WHERE name = ?",
          &index_list) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(index_list.stmt, 1, table, -1, SQLITE_STATIC);
  sqlite3_bind_text(index_list.stmt, 2, index, -1, SQLITE_STATIC);
  if (sqlite3_step(index_list.stmt) != SQLITE_ROW ||
      (sqlite3_column_int(index_list.stmt, 0) != 0) != unique) {
    return false;
  }

  Statement index_info;
  if (prepare(
          state,
          "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
          &index_info) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(index_info.stmt, 1, index, -1, SQLITE_STATIC);
  auto expected = columns.begin();
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(index_info.stmt)) == SQLITE_ROW) {
    if (expected == columns.end()) return false;
    const unsigned char* name = sqlite3_column_text(index_info.stmt, 0);
    if (name == nullptr ||
        std::string_view(reinterpret_cast<const char*>(name)) != *expected) {
      return false;
    }
    ++expected;
  }
  return rc == SQLITE_DONE && expected == columns.end();
}

bool has_not_null_column(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* column) {
  Statement stmt;
  if (prepare(
          state,
          "SELECT \"notnull\" FROM pragma_table_info(?) WHERE name = ?",
          &stmt) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(stmt.stmt, 1, table, -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt.stmt, 2, column, -1, SQLITE_STATIC);
  return sqlite3_step(stmt.stmt) == SQLITE_ROW &&
         sqlite3_column_int(stmt.stmt, 0) == 1;
}

bool has_unique_column(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* column) {
  Statement stmt;
  if (prepare(
          state,
          "SELECT name FROM pragma_index_list(?) WHERE \"unique\" = 1",
          &stmt) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  sqlite3_bind_text(stmt.stmt, 1, table, -1, SQLITE_STATIC);
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    const unsigned char* name = sqlite3_column_text(stmt.stmt, 0);
    if (name == nullptr) return false;
    const std::string index(reinterpret_cast<const char*>(name));
    if (has_exact_index(state, table, index.c_str(), true, {column})) {
      return true;
    }
  }
  return false;
}

bool has_schema_version(
    XpodRdfSqliteBackendState* state,
    const char* table,
    std::string_view required_version) {
  std::string version;
  return table_metadata_value(state, table, "schema_version", &version) ==
             XPOD_RDF_STATUS_OK &&
         version == required_version;
}

bool is_canonical_unsigned_decimal(std::string_view value) {
  if (value.empty() || (value.size() > 1 && value.front() == '0')) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isdigit(character) != 0;
  });
}

bool has_facts_schema(XpodRdfSqliteBackendState* state) {
  std::string data_version;
  if (!has_schema_version(
          state, "rdf_index_metadata", kRequiredFactsSchemaVersion) ||
      table_metadata_value(
          state, "rdf_index_metadata", "data_version", &data_version) !=
          XPOD_RDF_STATUS_OK ||
      !is_canonical_unsigned_decimal(data_version) ||
      !has_exact_columns(
          state,
          "rdf_terms",
          {"id", "kind", "value", "value_head", "datatype_id", "lang",
           "hash", "normalized_text", "numeric_value", "created_at"}) ||
      !has_exact_columns(
          state,
          "rdf_sources",
          {"id", "source", "workspace", "local_path", "content_type",
           "last_indexed_at", "source_version"}) ||
      !has_exact_columns(
          state,
          "rdf_quads",
          {"graph_id", "subject_id", "predicate_id", "object_id",
           "source_file_id", "source_line_no"}) ||
      !has_exact_columns(state, "rdf_index_metadata", {"key", "value"})) {
    return false;
  }

  return has_exact_index(
             state, "rdf_terms", "rdf_terms_identity_hash", true, {"hash"}) &&
         has_exact_index(
             state, "rdf_terms", "rdf_terms_kind_value_head", false,
             {"kind", "value_head"}) &&
         has_exact_index(
             state, "rdf_terms", "rdf_terms_kind_datatype", false,
             {"kind", "datatype_id"}) &&
         has_exact_index(
             state, "rdf_terms", "rdf_terms_kind_lang", false,
             {"kind", "lang"}) &&
         has_exact_index(
             state, "rdf_terms", "rdf_terms_kind_numeric_value", false,
             {"kind", "numeric_value"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_spog", false,
             {"subject_id", "predicate_id", "object_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_sopg", false,
             {"subject_id", "object_id", "predicate_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_psog", false,
             {"predicate_id", "subject_id", "object_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_posg", false,
             {"predicate_id", "object_id", "subject_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_ospg", false,
             {"object_id", "subject_id", "predicate_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_opsg", false,
             {"object_id", "predicate_id", "subject_id", "graph_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_gspo", false,
             {"graph_id", "subject_id", "predicate_id", "object_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_gpos", false,
             {"graph_id", "predicate_id", "object_id", "subject_id"}) &&
         has_exact_index(
             state, "rdf_quads", "rdf_quads_source", false,
             {"source_file_id"});
}

bool has_text_schema(XpodRdfSqliteBackendState* state) {
  return has_schema_version(
             state, "rdf_text_metadata", kRequiredTextSchemaVersion) &&
         has_columns(
             state,
             "rdf_text_sources",
             {"id", "source_key", "source", "workspace"}) &&
         has_not_null_column(state, "rdf_text_sources", "source_key") &&
         has_unique_column(state, "rdf_text_sources", "source_key") &&
         has_columns(
             state,
             "rdf_text_chunks",
             {"id", "source_id", "chunk_key", "content", "start_offset",
              "end_offset"}) &&
         has_columns(
             state,
             "rdf_text_terms",
             {"id", "term", "source_id", "chunk_id", "occurrences"}) &&
         has_columns(
             state,
             "rdf_text_entities",
             {"entity", "source_id", "chunk_id", "occurrences"});
}

bool has_vector_schema(XpodRdfSqliteBackendState* state) {
  return has_schema_version(
             state, "rdf_vector_metadata", kRequiredVectorSchemaVersion) &&
         has_columns(
             state,
             "rdf_vector_sources",
             {"id", "source_key", "source", "workspace"}) &&
         has_not_null_column(state, "rdf_vector_sources", "source_key") &&
         has_unique_column(state, "rdf_vector_sources", "source_key") &&
         has_columns(
             state,
             "rdf_vector_chunks",
             {"id", "source_id", "chunk_key", "start_offset", "end_offset",
              "dimensions", "magnitude", "provider", "model", "model_version",
              "input_kind", "projection_policy_version"}) &&
         has_columns(
             state,
             "rdf_vector_components",
             {"chunk_id", "dimension", "value"});
}

std::string term_kind_name(xpod_rdf_term_kind kind) {
  switch (kind) {
    case XPOD_RDF_TERM_IRI:
      return "iri";
    case XPOD_RDF_TERM_BLANK:
      return "blank";
    case XPOD_RDF_TERM_LITERAL:
      return "literal";
  }
  return {};
}

xpod_rdf_status sqlite_done_status(sqlite3_stmt* stmt) {
  const int rc = sqlite3_step(stmt);
  return rc == SQLITE_DONE ? XPOD_RDF_STATUS_OK
                           : XPOD_RDF_STATUS_BACKEND_ERROR;
}

std::string sha256_hex(std::string_view input) {
  unsigned char digest[EVP_MAX_MD_SIZE] = {};
  unsigned int digest_size = 0;
  EVP_MD_CTX* raw_context = EVP_MD_CTX_new();
  if (raw_context == nullptr) {
    return {};
  }
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(
      raw_context, EVP_MD_CTX_free);
  if (EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(context.get(), input.data(), input.size()) != 1 ||
      EVP_DigestFinal_ex(context.get(), digest, &digest_size) != 1) {
    return {};
  }
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < digest_size; ++i) {
    out << std::setw(2) << static_cast<unsigned int>(digest[i]);
  }
  return out.str();
}

std::string rdf_term_identity_hash(
    std::string_view kind,
    std::string_view value,
    uint64_t datatype_id,
    bool has_datatype_id,
    std::string_view language) {
  std::string identity;
  identity.reserve(kind.size() + value.size() + language.size() + 32);
  identity.append(kind);
  identity.push_back('\0');
  identity.append(value);
  identity.push_back('\0');
  if (has_datatype_id) {
    identity.append(std::to_string(datatype_id));
  }
  identity.push_back('\0');
  identity.append(language);
  return sha256_hex(identity);
}

bool is_qlever_default_graph_iri(const xpod_rdf_term& term) {
  if (term.kind != XPOD_RDF_TERM_IRI) {
    return false;
  }
  const std::string value = bytes_to_string(term.value);
  return value == kQleverDefaultGraphIri || value == kQleverDefaultGraphIriRef;
}

xpod_rdf_term_kind term_kind_from_name(std::string_view kind) {
  if (kind == "iri") return XPOD_RDF_TERM_IRI;
  if (kind == "blank") return XPOD_RDF_TERM_BLANK;
  return XPOD_RDF_TERM_LITERAL;
}

xpod_rdf_status metadata_value(
    XpodRdfSqliteBackendState* state,
    const char* key,
    std::string* out) {
  return table_metadata_value(state, "rdf_index_metadata", key, out);
}

xpod_rdf_status table_metadata_value(
    XpodRdfSqliteBackendState* state,
    const char* table,
    const char* key,
    std::string* out) {
  if (state == nullptr || table == nullptr || key == nullptr || out == nullptr ||
      !has_table(state, table)) {
    return XPOD_RDF_STATUS_NOT_FOUND;
  }
  Statement stmt;
  xpod_rdf_status status = prepare(
      state, std::string("SELECT value FROM ") + table + " WHERE key = ?", &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  sqlite3_bind_text(stmt.stmt, 1, key, -1, SQLITE_STATIC);
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_ROW) {
    const unsigned char* text = sqlite3_column_text(stmt.stmt, 0);
    *out = text == nullptr ? std::string{} : reinterpret_cast<const char*>(text);
    return XPOD_RDF_STATUS_OK;
  }
  return rc == SQLITE_DONE ? XPOD_RDF_STATUS_NOT_FOUND
                           : XPOD_RDF_STATUS_BACKEND_ERROR;
}

xpod_rdf_status validate_snapshot(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_snapshot* snapshot) {
  if (snapshot == nullptr || !has_bytes(snapshot->facts_version)) {
    return XPOD_RDF_STATUS_OK;
  }
  std::string current;
  xpod_rdf_status status = metadata_value(state, "data_version", &current);
  if (status == XPOD_RDF_STATUS_NOT_FOUND) {
    current.clear();
    status = XPOD_RDF_STATUS_OK;
  }
  if (status != XPOD_RDF_STATUS_OK) return status;
  return current == bytes_to_string(snapshot->facts_version)
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_STALE_STATS;
}

xpod_rdf_status lookup_term_key(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_term* term,
    xpod_rdf_term_key* out_key) {
  if (term == nullptr || out_key == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_key = 0;
  if (is_qlever_default_graph_iri(*term)) {
    return default_graph_key(state, out_key);
  }
  const std::string kind = term_kind_name(term->kind);
  if (kind.empty()) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  const bool has_datatype =
      term->kind == XPOD_RDF_TERM_LITERAL && has_bytes(term->datatype_iri) &&
      bytes_to_string(term->datatype_iri) != std::string(kXsdString);
  const bool has_language =
      term->kind == XPOD_RDF_TERM_LITERAL && has_bytes(term->language);
  std::string sql =
      "SELECT term.id FROM rdf_terms term "
      "LEFT JOIN rdf_terms datatype ON datatype.id = term.datatype_id "
      "WHERE term.kind = ? AND term.value = ? ";
  if (has_datatype) {
    sql += "AND datatype.kind = 'iri' AND datatype.value = ? AND term.lang IS NULL";
  } else if (has_language) {
    sql +=
        "AND term.lang = ? "
        "AND datatype.kind = 'iri' AND datatype.value = ?";
  } else {
    sql +=
        "AND term.lang IS NULL "
        "AND (term.datatype_id IS NULL OR datatype.value = ?)";
  }
  Statement stmt;
  xpod_rdf_status status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  sqlite3_bind_text(stmt.stmt, 1, kind.c_str(), -1, SQLITE_TRANSIENT);
  status = bind_bytes(stmt.stmt, 2, term->value);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (has_datatype) {
    status = bind_bytes(stmt.stmt, 3, term->datatype_iri);
  } else if (has_language) {
    status = bind_bytes(stmt.stmt, 3, term->language);
    if (status != XPOD_RDF_STATUS_OK) return status;
    sqlite3_bind_text(
        stmt.stmt, 4, kRdfLangString.data(),
        static_cast<int>(kRdfLangString.size()), SQLITE_STATIC);
  } else {
    sqlite3_bind_text(
        stmt.stmt, 3, kXsdString.data(),
        static_cast<int>(kXsdString.size()), SQLITE_STATIC);
  }
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_ROW) {
    *out_key = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
    return XPOD_RDF_STATUS_OK;
  }
  return rc == SQLITE_DONE ? XPOD_RDF_STATUS_NOT_FOUND
                           : XPOD_RDF_STATUS_BACKEND_ERROR;
}

xpod_rdf_status default_graph_key(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key* out_key) {
  if (state == nullptr || out_key == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (state->has_cached_default_graph_key) {
    *out_key = state->cached_default_graph_key;
    return XPOD_RDF_STATUS_OK;
  }
  Statement stmt;
  xpod_rdf_status status = prepare(
      state,
      "SELECT id FROM rdf_terms WHERE kind = 'default_graph' AND value = '' LIMIT 1",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_ROW) {
    state->cached_default_graph_key =
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
  } else {
    state->cached_default_graph_key = XPOD_RDF_DEFAULT_GRAPH_KEY;
  }
  state->has_cached_default_graph_key = true;
  *out_key = state->cached_default_graph_key;
  return rc == SQLITE_DONE || rc == SQLITE_ROW ? XPOD_RDF_STATUS_OK
                                               : XPOD_RDF_STATUS_BACKEND_ERROR;
}

xpod_rdf_status ensure_default_graph_key(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key* out_key) {
  xpod_rdf_status status = default_graph_key(state, out_key);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (*out_key != XPOD_RDF_DEFAULT_GRAPH_KEY) return XPOD_RDF_STATUS_OK;
  if (state->read_only) return XPOD_RDF_STATUS_NOT_FOUND;
  Statement stmt;
  status = prepare(
      state,
      "INSERT OR IGNORE INTO rdf_terms "
      "(kind, value, value_head, datatype_id, lang, hash, normalized_text, numeric_value) "
      "VALUES ('default_graph', '', '', NULL, NULL, ?, NULL, NULL)",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const std::string hash = rdf_term_identity_hash("default_graph", "", 0, false, "");
  sqlite3_bind_text(stmt.stmt, 1, hash.c_str(), -1, SQLITE_TRANSIENT);
  status = sqlite_done_status(stmt.stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->has_cached_default_graph_key = false;
  return default_graph_key(state, out_key);
}

xpod_rdf_status normalize_graph_key(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key key,
    xpod_rdf_term_key* out_key) {
  if (key != XPOD_RDF_DEFAULT_GRAPH_KEY) {
    *out_key = key;
    return XPOD_RDF_STATUS_OK;
  }
  return default_graph_key(state, out_key);
}

xpod_rdf_status resolve_term_key(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key key,
    xpod_rdf_term* out_term) {
  if (out_term == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  Statement stmt;
  xpod_rdf_status status = prepare(
      state,
      "SELECT term.kind, term.value, datatype.value, term.lang, term.numeric_value "
      "FROM rdf_terms term "
      "LEFT JOIN rdf_terms datatype ON datatype.id = term.datatype_id "
      "WHERE term.id = ?",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_u64(stmt.stmt, 1, key);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_DONE) return XPOD_RDF_STATUS_NOT_FOUND;
  if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
  const char* kind =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 0));
  const char* value =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 1));
  const char* datatype =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 2));
  const char* language =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 3));
  *out_term = {};
  out_term->kind = term_kind_from_name(kind == nullptr ? "" : kind);
  out_term->value = owned_bytes(state, value == nullptr ? "" : value);
  if (datatype != nullptr) {
    out_term->datatype_iri = owned_bytes(state, datatype);
  }
  if (language != nullptr) {
    out_term->language = owned_bytes(state, language);
  }
  return XPOD_RDF_STATUS_OK;
}

struct ComparableTerm {
  std::string kind;
  std::string value;
  std::string datatype;
  std::string language;
};

xpod_rdf_status resolve_comparable_term(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key key,
    ComparableTerm* out_term) {
  if (state == nullptr || out_term == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  Statement stmt;
  xpod_rdf_status status = prepare(
      state,
      "SELECT term.kind, term.value, datatype.value, term.lang "
      "FROM rdf_terms term "
      "LEFT JOIN rdf_terms datatype ON datatype.id = term.datatype_id "
      "WHERE term.id = ?",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_u64(stmt.stmt, 1, key);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_DONE) return XPOD_RDF_STATUS_NOT_FOUND;
  if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
  const char* kind =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 0));
  const char* value =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 1));
  const char* datatype =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 2));
  const char* language =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 3));
  out_term->kind = kind == nullptr ? std::string{} : kind;
  out_term->value = value == nullptr ? std::string{} : value;
  out_term->datatype = datatype == nullptr ? std::string{} : datatype;
  out_term->language = language == nullptr ? std::string{} : language;
  return XPOD_RDF_STATUS_OK;
}

bool encode_term_key_as_qlever_value_id_bits(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key term,
    uint64_t* out_qlever_id_bits) {
  if (state == nullptr || out_qlever_id_bits == nullptr ||
      !term_key_fits_qlever_value_id(term)) {
    return false;
  }
  ComparableTerm resolved;
  if (resolve_comparable_term(state, term, &resolved) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  const uint64_t datatype = resolved.kind == "blank"
                                ? kQleverBlankNodeIndexDatatype
                                : kQleverVocabIndexDatatype;
  *out_qlever_id_bits = (datatype << kQleverValueIdDataBits) | term;
  return true;
}

bool decode_term_key_from_qlever_value_id_bits(
    uint64_t qlever_id_bits,
    xpod_rdf_term_key* out_term) {
  if (out_term == nullptr) return false;
  const uint64_t datatype = qlever_id_bits >> kQleverValueIdDataBits;
  if (datatype != kQleverVocabIndexDatatype &&
      datatype != kQleverBlankNodeIndexDatatype) {
    return false;
  }
  *out_term = qlever_id_bits & kQleverValueIdDataMask;
  return true;
}

int compare_strings(const std::string& left, const std::string& right) {
  if (left < right) return -1;
  if (right < left) return 1;
  return 0;
}

int term_kind_rank(std::string_view kind) {
  if (kind == "blank") return 1;
  if (kind == "iri") return 2;
  if (kind == "literal") return 3;
  return 4;
}

int compare_resolved_terms(const ComparableTerm& left, const ComparableTerm& right) {
  const int left_kind = term_kind_rank(left.kind);
  const int right_kind = term_kind_rank(right.kind);
  if (left_kind != right_kind) return left_kind < right_kind ? -1 : 1;
  if (left.kind == "literal") {
    const auto numeric = xpod::qlever::numeric_literal::compare(
        left.value, left.datatype, right.value, right.datatype);
    if (numeric.applicable) {
      return numeric.compare;
    }
  }
  if (const int value = compare_strings(left.value, right.value); value != 0) {
    return value;
  }
  if (left.kind == "literal") {
    if (const int language = compare_strings(left.language, right.language);
        language != 0) {
      return language;
    }
    return compare_strings(left.datatype, right.datatype);
  }
  return 0;
}

std::string slot_column(uint32_t slot) {
  switch (slot) {
    case XPOD_RDF_SLOT_SUBJECT:
      return "subject_id";
    case XPOD_RDF_SLOT_PREDICATE:
      return "predicate_id";
    case XPOD_RDF_SLOT_OBJECT:
      return "object_id";
    case XPOD_RDF_SLOT_GRAPH:
      return "graph_id";
  }
  return {};
}

void append_condition(
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const char* column,
    uint8_t has_value,
    uint64_t value) {
  if (has_value == 0) return;
  conditions->push_back(std::string("q.") + column + " = ?");
  add_u64(params, value);
}

xpod_rdf_status append_graph_key_condition(
    XpodRdfSqliteBackendState* state,
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const std::string& column,
    xpod_rdf_term_key key) {
  xpod_rdf_term_key normalized = 0;
  xpod_rdf_status status = normalize_graph_key(state, key, &normalized);
  if (status != XPOD_RDF_STATUS_OK) return status;
  conditions->push_back(column + " = ?");
  add_u64(params, normalized);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status append_graph_prefix_condition(
    XpodRdfSqliteBackendState* state,
    std::vector<SqlParam>* params,
    const std::string& graph_column,
    const std::string& prefix,
    const xpod_rdf_source_scope& source_scope,
    std::string* out_clause) {
  if (prefix.empty()) return XPOD_RDF_STATUS_UNSUPPORTED;
  std::string clause =
      "(" + graph_column +
      " IN (SELECT id FROM rdf_terms graph_term WHERE graph_term.kind = 'iri' "
      "AND graph_term.value >= ?";
  add_text(params, prefix);
  std::string upper;
  if (prefix_upper_bound(prefix, &upper)) {
    clause += " AND graph_term.value < ?";
    add_text(params, upper);
  }
  clause += ")";
  if (has_bytes(source_scope.source_uri_prefix) &&
      bytes_to_string(source_scope.source_uri_prefix) == prefix) {
    xpod_rdf_term_key default_graph = 0;
    xpod_rdf_status status = default_graph_key(state, &default_graph);
    if (status != XPOD_RDF_STATUS_OK) return status;
    clause += " OR " + graph_column + " = ?";
    add_u64(params, default_graph);
  }
  clause += ")";
  *out_clause = std::move(clause);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status append_graph_scope_conditions(
    XpodRdfSqliteBackendState* state,
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const std::string& graph_column,
    const xpod_rdf_graph_scope* graph_scope,
    const xpod_rdf_source_scope& source_scope) {
  if (graph_scope == nullptr ||
      graph_scope->kind == XPOD_RDF_GRAPH_SCOPE_ALL) {
    return XPOD_RDF_STATUS_OK;
  }
  if (graph_scope->kind == XPOD_RDF_GRAPH_SCOPE_EXACT) {
    return append_graph_key_condition(
        state, conditions, params, graph_column, graph_scope->exact_graph);
  }
  if (graph_scope->kind == XPOD_RDF_GRAPH_SCOPE_SET) {
    if (graph_scope->graph_set_size == 0) {
      conditions->push_back("0 = 1");
      return XPOD_RDF_STATUS_OK;
    }
    conditions->push_back(graph_column + " IN (" +
                          placeholders(graph_scope->graph_set_size) + ")");
    for (size_t i = 0; i < graph_scope->graph_set_size; ++i) {
      xpod_rdf_term_key normalized = 0;
      xpod_rdf_status status =
          normalize_graph_key(state, graph_scope->graph_set[i], &normalized);
      if (status != XPOD_RDF_STATUS_OK) return status;
      add_u64(params, normalized);
    }
    return XPOD_RDF_STATUS_OK;
  }
  if (graph_scope->kind == XPOD_RDF_GRAPH_SCOPE_PREFIX) {
    const std::string prefix = bytes_to_string(graph_scope->iri_prefix);
    std::string clause;
    xpod_rdf_status status = append_graph_prefix_condition(
        state, params, graph_column, prefix, source_scope, &clause);
    if (status != XPOD_RDF_STATUS_OK) return status;
    conditions->push_back(std::move(clause));
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

bool source_scope_needs_join(const xpod_rdf_source_scope& source_scope) {
  return source_scope.has_source_node != 0 ||
         has_bytes(source_scope.workspace) ||
         has_bytes(source_scope.source_uri) ||
         has_bytes(source_scope.source_uri_prefix) ||
         has_bytes(source_scope.local_path) ||
         has_bytes(source_scope.local_path_prefix) ||
         source_scope.include_files != 0 ||
         source_scope.include_folders != 0;
}

void append_source_scope_conditions(
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const std::string& source_alias,
    const xpod_rdf_source_scope& source_scope) {
  if (source_scope.has_source_node != 0) {
    conditions->push_back(source_alias + ".id = ?");
    add_u64(params, source_scope.source_node);
  }
  if (has_bytes(source_scope.workspace)) {
    conditions->push_back(source_alias + ".workspace = ?");
    add_text(params, bytes_to_string(source_scope.workspace));
  }
  if (has_bytes(source_scope.source_uri)) {
    conditions->push_back(source_alias + ".source = ?");
    add_text(params, bytes_to_string(source_scope.source_uri));
  }
  if (has_bytes(source_scope.source_uri_prefix)) {
    append_prefix_condition(
        conditions, params, source_alias + ".source",
        bytes_to_string(source_scope.source_uri_prefix));
  }
  if (has_bytes(source_scope.local_path)) {
    conditions->push_back(source_alias + ".local_path = ?");
    add_text(params, bytes_to_string(source_scope.local_path));
  }
  if (has_bytes(source_scope.local_path_prefix)) {
    append_prefix_condition(
        conditions, params, source_alias + ".local_path",
        bytes_to_string(source_scope.local_path_prefix));
  }
  if (source_scope.include_folders != 0 && source_scope.include_files == 0) {
    conditions->push_back(
        "(" + source_alias + ".content_type = 'inode/directory' OR " +
        source_alias + ".source LIKE '%/' OR " + source_alias +
        ".local_path LIKE '%/')");
  }
  if (source_scope.include_files != 0 && source_scope.include_folders == 0) {
    conditions->push_back(
        "(COALESCE(" + source_alias + ".content_type, '') <> 'inode/directory' "
        "AND " + source_alias + ".source NOT LIKE '%/' "
        "AND COALESCE(" + source_alias + ".local_path, '') NOT LIKE '%/')");
  }
}

xpod_rdf_status append_access_scope_conditions(
    XpodRdfSqliteBackendState* state,
    std::vector<std::string>* conditions,
    std::vector<SqlParam>* params,
    const std::string& graph_column,
    const std::string& source_column,
    const xpod_rdf_access_scope* access_scope,
    const xpod_rdf_source_scope& source_scope) {
  if (access_scope == nullptr) return XPOD_RDF_STATUS_OK;
  if (access_scope->allowed_graphs_size != 0) {
    conditions->push_back(graph_column + " IN (" +
                          placeholders(access_scope->allowed_graphs_size) + ")");
    for (size_t i = 0; i < access_scope->allowed_graphs_size; ++i) {
      xpod_rdf_term_key normalized = 0;
      xpod_rdf_status status =
          normalize_graph_key(state, access_scope->allowed_graphs[i], &normalized);
      if (status != XPOD_RDF_STATUS_OK) return status;
      add_u64(params, normalized);
    }
  }
  if (access_scope->denied_graphs_size != 0) {
    conditions->push_back(graph_column + " NOT IN (" +
                          placeholders(access_scope->denied_graphs_size) + ")");
    for (size_t i = 0; i < access_scope->denied_graphs_size; ++i) {
      xpod_rdf_term_key normalized = 0;
      xpod_rdf_status status =
          normalize_graph_key(state, access_scope->denied_graphs[i], &normalized);
      if (status != XPOD_RDF_STATUS_OK) return status;
      add_u64(params, normalized);
    }
  }
  if (access_scope->allowed_graph_prefixes_size != 0) {
    std::vector<std::string> prefix_conditions;
    for (size_t i = 0; i < access_scope->allowed_graph_prefixes_size; ++i) {
      const std::string prefix =
          bytes_to_string(access_scope->allowed_graph_prefixes[i]);
      if (prefix.empty()) continue;
      std::string clause;
      xpod_rdf_status status = append_graph_prefix_condition(
          state, params, graph_column, prefix, source_scope, &clause);
      if (status != XPOD_RDF_STATUS_OK) return status;
      prefix_conditions.push_back(std::move(clause));
    }
    if (!prefix_conditions.empty()) {
      std::string joined = "(";
      for (size_t i = 0; i < prefix_conditions.size(); ++i) {
        if (i != 0) joined += " OR ";
        joined += prefix_conditions[i];
      }
      joined += ")";
      conditions->push_back(std::move(joined));
    }
  }
  for (size_t i = 0; i < access_scope->denied_graph_prefixes_size; ++i) {
    const std::string prefix = bytes_to_string(access_scope->denied_graph_prefixes[i]);
    if (prefix.empty()) continue;
    std::string clause =
        graph_column +
        " NOT IN (SELECT id FROM rdf_terms graph_term WHERE graph_term.kind = 'iri' "
        "AND graph_term.value >= ?";
    add_text(params, prefix);
    std::string upper;
    if (prefix_upper_bound(prefix, &upper)) {
      clause += " AND graph_term.value < ?";
      add_text(params, upper);
    }
    clause += ")";
    conditions->push_back(std::move(clause));
  }
  if (access_scope->allowed_sources_size != 0) {
    conditions->push_back(source_column + " IN (" +
                          placeholders(access_scope->allowed_sources_size) + ")");
    for (size_t i = 0; i < access_scope->allowed_sources_size; ++i) {
      add_u64(params, access_scope->allowed_sources[i]);
    }
  }
  if (access_scope->denied_sources_size != 0) {
    conditions->push_back("(" + source_column + " IS NULL OR " + source_column +
                          " NOT IN (" +
                          placeholders(access_scope->denied_sources_size) + "))");
    for (size_t i = 0; i < access_scope->denied_sources_size; ++i) {
      add_u64(params, access_scope->denied_sources[i]);
    }
  }
  return XPOD_RDF_STATUS_OK;
}

uint32_t permutation_sorted_slots(xpod_rdf_permutation permutation) {
  switch (permutation) {
    case XPOD_RDF_PERM_SPOG:
      return XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
             XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_SOPG:
      return XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT |
             XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_PSOG:
      return XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_SUBJECT |
             XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_POSG:
      return XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT |
             XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_OSPG:
      return XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_SUBJECT |
             XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_OPSG:
      return XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_PREDICATE |
             XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_GRAPH;
    case XPOD_RDF_PERM_GSPO:
      return XPOD_RDF_SLOT_GRAPH | XPOD_RDF_SLOT_SUBJECT |
             XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
    case XPOD_RDF_PERM_GPOS:
      return XPOD_RDF_SLOT_GRAPH | XPOD_RDF_SLOT_PREDICATE |
             XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_SUBJECT;
  }
  return XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
         XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;
}

xpod_rdf_status scan_sql(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_scan_request* request,
    bool count,
    std::string* out_sql,
    std::vector<SqlParam>* out_params) {
  if (request == nullptr || out_sql == nullptr || out_params == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (request->slot_range_count != 0 || request->term_tuple_filter != nullptr ||
      request->filter_count != 0) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  std::vector<std::string> conditions;
  append_condition(
      &conditions, out_params, "subject_id", request->pattern.has_subject,
      request->pattern.subject);
  append_condition(
      &conditions, out_params, "predicate_id", request->pattern.has_predicate,
      request->pattern.predicate);
  append_condition(
      &conditions, out_params, "object_id", request->pattern.has_object,
      request->pattern.object);
  if (request->pattern.has_graph != 0) {
    xpod_rdf_term_key graph = 0;
    xpod_rdf_status graph_status =
        normalize_graph_key(state, request->pattern.graph, &graph);
    if (graph_status != XPOD_RDF_STATUS_OK) return graph_status;
    append_condition(&conditions, out_params, "graph_id", 1, graph);
  }
  status = append_graph_scope_conditions(
      state, &conditions, out_params, "q.graph_id", &request->graph_scope,
      request->source_scope);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::string from = " FROM rdf_quads q";
  if (source_scope_needs_join(request->source_scope)) {
    from += " JOIN rdf_sources s ON s.id = q.source_file_id";
    append_source_scope_conditions(
        &conditions, out_params, "s", request->source_scope);
  }
  status = append_access_scope_conditions(
      state, &conditions, out_params, "q.graph_id", "q.source_file_id",
      request->access_scope, request->source_scope);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::string sql = count
                        ? "SELECT COUNT(*)" + from
                        : "SELECT q.subject_id, q.predicate_id, q.object_id, q.graph_id" + from;
  if (!conditions.empty()) {
    sql += " WHERE ";
    for (size_t i = 0; i < conditions.size(); ++i) {
      if (i != 0) sql += " AND ";
      sql += conditions[i];
    }
  }
  if (!count) {
    sql += " ORDER BY ";
    switch (request->permutation) {
      case XPOD_RDF_PERM_SOPG:
        sql += "q.subject_id, q.object_id, q.predicate_id, q.graph_id";
        break;
      case XPOD_RDF_PERM_PSOG:
        sql += "q.predicate_id, q.subject_id, q.object_id, q.graph_id";
        break;
      case XPOD_RDF_PERM_POSG:
        sql += "q.predicate_id, q.object_id, q.subject_id, q.graph_id";
        break;
      case XPOD_RDF_PERM_OSPG:
        sql += "q.object_id, q.subject_id, q.predicate_id, q.graph_id";
        break;
      case XPOD_RDF_PERM_OPSG:
        sql += "q.object_id, q.predicate_id, q.subject_id, q.graph_id";
        break;
      case XPOD_RDF_PERM_GSPO:
        sql += "q.graph_id, q.subject_id, q.predicate_id, q.object_id";
        break;
      case XPOD_RDF_PERM_GPOS:
        sql += "q.graph_id, q.predicate_id, q.object_id, q.subject_id";
        break;
      case XPOD_RDF_PERM_SPOG:
      default:
        sql += "q.subject_id, q.predicate_id, q.object_id, q.graph_id";
        break;
    }
    if (request->limit != 0) {
      sql += " LIMIT " + std::to_string(request->limit);
    }
    if (request->offset != 0) {
      if (request->limit == 0) {
        sql += " LIMIT -1";
      }
      sql += " OFFSET " + std::to_string(request->offset);
    }
  }
  *out_sql = std::move(sql);
  return XPOD_RDF_STATUS_OK;
}

uint32_t all_permutation_caps() {
  return XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_SOPG |
         XPOD_RDF_PERM_CAP_PSOG | XPOD_RDF_PERM_CAP_POSG |
         XPOD_RDF_PERM_CAP_OSPG | XPOD_RDF_PERM_CAP_OPSG |
         XPOD_RDF_PERM_CAP_GSPO | XPOD_RDF_PERM_CAP_GPOS;
}

xpod_rdf_status sqlite_get_capabilities(
    void* backend_user_data,
    xpod_rdf_backend_capabilities* out_capabilities) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || out_capabilities == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_capabilities = {};
  out_capabilities->supported_permutations = all_permutation_caps();
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
                               XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET |
                               XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE |
                               XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE |
                               XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE |
                               XPOD_RDF_BACKEND_FEATURE_DISTINCT_ESTIMATE;
  if (!state->read_only) {
    out_capabilities->features |= XPOD_RDF_BACKEND_FEATURE_MUTATION |
                                  XPOD_RDF_BACKEND_FEATURE_TRANSACTIONS;
  }
  if (state->has_text) {
    out_capabilities->features |= XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
                                  XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM;
  }
  if (state->has_vector) {
    out_capabilities->features |= XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  }
  out_capabilities->max_batch_size = kMaxBatchSize;
  out_capabilities->backend_name = static_bytes("xpod-rdf-sqlite-backend");
  out_capabilities->backend_version = static_bytes("sqlite-c-api");
  out_capabilities->max_term_tuple_filter_rows = kMaxTermTupleFilterRows;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_lookup_term(
    void* backend_user_data,
    const xpod_rdf_term* term,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_key) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  return status == XPOD_RDF_STATUS_OK ? lookup_term_key(state, term, out_key) : status;
}

xpod_rdf_status sqlite_resolve_term(
    void* backend_user_data,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_term) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  return resolve_term_key(state, key, out_term);
}

xpod_rdf_status sqlite_lookup_terms(
    void* backend_user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (term_count != 0 &&
      (terms == nullptr || out_keys == nullptr || out_statuses == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  for (size_t i = 0; i < term_count; ++i) {
    out_statuses[i] = lookup_term_key(state, &terms[i], &out_keys[i]);
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_resolve_terms(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  if (key_count != 0 &&
      (keys == nullptr || out_terms == nullptr || out_statuses == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = resolve_term_key(state, keys[i], &out_terms[i]);
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_scan_permutation(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  if (request == nullptr || on_batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (cancellation_requested(request->cancellation)) {
    return XPOD_RDF_STATUS_CANCELLED;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  std::vector<SqlParam> params;
  std::string sql;
  xpod_rdf_status status = scan_sql(state, request, false, &sql, &params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<xpod_rdf_quad_key> batch;
  batch.reserve(effective_batch_size(request->batch_size));
  uint64_t scanned = 0;
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    if (cancellation_requested(request->cancellation)) {
      return XPOD_RDF_STATUS_CANCELLED;
    }
    batch.push_back({
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0)),
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 1)),
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 2)),
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 3)),
    });
    ++scanned;
    if (batch.size() == effective_batch_size(request->batch_size)) {
      xpod_rdf_quad_batch out = {
          batch.data(), batch.size(), permutation_sorted_slots(request->permutation), scanned};
      status = on_batch(callback_user_data, &out);
      if (status != XPOD_RDF_STATUS_OK) return status;
      batch.clear();
    }
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!batch.empty()) {
    xpod_rdf_quad_batch out = {
        batch.data(), batch.size(), permutation_sorted_slots(request->permutation), scanned};
    status = on_batch(callback_user_data, &out);
  }
  return status;
}

xpod_rdf_status sqlite_open_scan_cursor(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_cursor** out) {
  if (out == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  *out = nullptr;
  struct Collector {
    std::vector<xpod_rdf_quad_key> rows;
  } collector;
  auto collect = [](void* opaque, const xpod_rdf_quad_batch* batch) -> xpod_rdf_status {
    auto* c = static_cast<Collector*>(opaque);
    c->rows.insert(c->rows.end(), batch->rows, batch->rows + batch->row_count);
    return XPOD_RDF_STATUS_OK;
  };
  xpod_rdf_status status =
      sqlite_scan_permutation(backend_user_data, request, collect, &collector);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::unique_ptr<xpod_rdf_scan_cursor> cursor(new xpod_rdf_scan_cursor());
  cursor->rows = std::move(collector.rows);
  cursor->batch_size = effective_batch_size(request == nullptr ? 0 : request->batch_size);
  cursor->sorted_slots =
      request == nullptr ? 0 : permutation_sorted_slots(request->permutation);
  *out = cursor.release();
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_next_scan_cursor(
    void*,
    xpod_rdf_scan_cursor* cursor,
    xpod_rdf_quad_batch* out) {
  if (cursor == nullptr || out == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (cursor->offset >= cursor->rows.size()) return XPOD_RDF_STATUS_DONE;
  const size_t remaining = cursor->rows.size() - cursor->offset;
  const size_t take = std::min(cursor->batch_size, remaining);
  *out = {
      cursor->rows.data() + cursor->offset,
      take,
      cursor->sorted_slots,
      cursor->offset + take,
  };
  cursor->offset += take;
  return XPOD_RDF_STATUS_OK;
}

void sqlite_close_scan_cursor(void*, xpod_rdf_scan_cursor* cursor) {
  delete cursor;
}

xpod_rdf_status sqlite_count_scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result) {
  if (request == nullptr || out_result == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  std::vector<SqlParam> params;
  std::string sql;
  xpod_rdf_status status = scan_sql(state, request, true, &sql, &params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (sqlite3_step(stmt.stmt) != SQLITE_ROW) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_result->count = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_distinct_scan(
    void* backend_user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_term_tuple_batch_callback on_batch,
    void* callback_user_data) {
  if (request == nullptr || on_batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  std::vector<std::string> columns;
  for (uint32_t slot : {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE,
                       XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_GRAPH}) {
    if ((request->distinct_slots & slot) != 0) {
      std::string column = slot_column(slot);
      if (column.empty()) return XPOD_RDF_STATUS_UNSUPPORTED;
      columns.push_back("q." + column);
    }
  }
  if (columns.empty()) return XPOD_RDF_STATUS_UNSUPPORTED;
  std::vector<SqlParam> params;
  std::string base;
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = scan_sql(state, &request->scan, true, &base, &params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const size_t from_pos = base.find(" FROM ");
  std::string sql = "SELECT DISTINCT ";
  for (size_t i = 0; i < columns.size(); ++i) {
    if (i != 0) sql += ", ";
    sql += columns[i];
  }
  sql += base.substr(from_pos);
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<xpod_rdf_term_key> rows;
  const size_t width = columns.size();
  rows.reserve(width * effective_batch_size(request->scan.batch_size));
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    for (size_t i = 0; i < width; ++i) {
      rows.push_back(static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, static_cast<int>(i))));
    }
    if (rows.size() / width == effective_batch_size(request->scan.batch_size)) {
      xpod_rdf_term_tuple_batch batch = {rows.data(), rows.size() / width, static_cast<uint32_t>(width)};
      status = on_batch(callback_user_data, &batch);
      if (status != XPOD_RDF_STATUS_OK) return status;
      rows.clear();
    }
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!rows.empty()) {
    xpod_rdf_term_tuple_batch batch = {rows.data(), rows.size() / width, static_cast<uint32_t>(width)};
    status = on_batch(callback_user_data, &batch);
  }
  return status;
}

xpod_rdf_status sqlite_estimate_scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (out_estimate == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_count_result count = {};
  xpod_rdf_status status = sqlite_count_scan(backend_user_data, request, &count);
  if (status != XPOD_RDF_STATUS_OK) return status;
  *out_estimate = {};
  out_estimate->rows = count.count;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  out_estimate->selectivity = 1.0;
  out_estimate->reason = static_bytes("sqlite-exact-count");
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_estimate_distinct(
    void* backend_user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request == nullptr || out_estimate == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_scan_request scan = request->scan;
  return sqlite_estimate_scan(backend_user_data, &scan, out_estimate);
}

xpod_rdf_status sqlite_estimate_join_fanout(
    void* backend_user_data,
    const xpod_rdf_join_fanout_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request == nullptr || out_estimate == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  *out_estimate = {};
  out_estimate->rows = request->pattern_count == 0 ? 0 : 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
  out_estimate->reason = static_bytes("sqlite-heuristic-join-fanout");
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_estimate_source_scope(
    void* backend_user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_estimate* out_estimate) {
  if (source_scope == nullptr || out_estimate == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  xpod_rdf_scan_request request = {};
  request.snapshot = *snapshot;
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  request.source_scope = *source_scope;
  return sqlite_estimate_scan(backend_user_data, &request, out_estimate);
}

xpod_rdf_status sqlite_resolve_source_scope(
    void* backend_user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_resolved_source_scope* out_scope) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (source_scope == nullptr || out_scope == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<std::string> conditions;
  std::vector<SqlParam> params;
  append_source_scope_conditions(&conditions, &params, "rdf_sources", *source_scope);
  std::string sql = "SELECT id FROM rdf_sources";
  if (!conditions.empty()) {
    sql += " WHERE ";
    for (size_t i = 0; i < conditions.size(); ++i) {
      if (i != 0) sql += " AND ";
      sql += conditions[i];
    }
  }
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_source_nodes.clear();
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    state->owned_source_nodes.push_back(
        static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0)));
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  *out_scope = {};
  out_scope->source_nodes = state->owned_source_nodes.data();
  out_scope->source_nodes_size = state->owned_source_nodes.size();
  out_scope->graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  out_scope->scope_version = static_bytes("sqlite-source-scope");
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_estimate_access_scope(
    void* backend_user_data,
    const xpod_rdf_access_scope* access_scope,
    const xpod_rdf_source_scope* source_scope,
    xpod_rdf_estimate* out_estimate) {
  if (out_estimate == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  (void)backend_user_data;
  (void)access_scope;
  (void)source_scope;
  return XPOD_RDF_STATUS_UNSUPPORTED;
}

xpod_rdf_status sqlite_encode_qlever_id(
    void* backend_user_data,
    xpod_rdf_term_key term,
    uint64_t* out) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  return encode_term_key_as_qlever_value_id_bits(state, term, out)
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_BACKEND_ERROR;
}

xpod_rdf_status sqlite_decode_qlever_id(void*, uint64_t bits, xpod_rdf_term_key* out) {
  return decode_term_key_from_qlever_value_id_bits(bits, out)
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_UNSUPPORTED;
}

xpod_rdf_status sqlite_compare_qlever_ids(
    void* backend_user_data,
    uint64_t left_qlever_id_bits,
    uint64_t right_qlever_id_bits,
    int32_t* out_compare) {
  if (backend_user_data == nullptr || out_compare == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (left_qlever_id_bits == right_qlever_id_bits) {
    *out_compare = 0;
    return XPOD_RDF_STATUS_OK;
  }
  xpod_rdf_term_key left_key = 0;
  xpod_rdf_term_key right_key = 0;
  if (!decode_term_key_from_qlever_value_id_bits(left_qlever_id_bits, &left_key) ||
      !decode_term_key_from_qlever_value_id_bits(right_qlever_id_bits, &right_key)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  ComparableTerm left;
  ComparableTerm right;
  xpod_rdf_status status = resolve_comparable_term(state, left_key, &left);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = resolve_comparable_term(state, right_key, &right);
  if (status != XPOD_RDF_STATUS_OK) return status;
  *out_compare = compare_resolved_terms(left, right);
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_prefetch_qlever_ids(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || (key_count != 0 && keys == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  for (size_t i = 0; i < key_count; ++i) {
    xpod_rdf_term term = {};
    status = resolve_term_key(state, keys[i], &term);
    if (status != XPOD_RDF_STATUS_OK) return status;
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_encode_qlever_ids(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    uint64_t* out_qlever_id_bits) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr ||
      (key_count != 0 && (keys == nullptr || out_qlever_id_bits == nullptr))) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  for (size_t i = 0; i < key_count; ++i) {
    if (!encode_term_key_as_qlever_value_id_bits(
            state, keys[i], &out_qlever_id_bits[i])) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_text_search(
    void* backend_user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request == nullptr || on_batch == nullptr) return XPOD_RDF_STATUS_BACKEND_ERROR;
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_RECORD &&
      request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_ENTITY) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_RECORD &&
      request->required_entities_size != 0) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<std::string> conditions;
  std::vector<SqlParam> params;
  std::string from =
      " FROM rdf_text_terms term "
      "JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id "
      "JOIN rdf_text_sources source ON source.id = chunk.source_id "
      "JOIN rdf_sources rdf_source ON rdf_source.source = source.source ";
  if (request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_ENTITY) {
    from +=
        "JOIN rdf_text_entities entity ON entity.chunk_id = chunk.id "
        "AND entity.source_id = source.id "
        "JOIN rdf_terms resource_term ON resource_term.kind = 'iri' "
        "AND resource_term.value = entity.entity ";
  }
  append_source_scope_conditions(
      &conditions, &params, "rdf_source", request->source_scope);
  if (request->access_scope != nullptr ||
      request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) {
    std::vector<std::string> scoped_conditions;
    std::vector<SqlParam> scoped_params;
    status = append_graph_scope_conditions(
        state, &scoped_conditions, &scoped_params, "q.graph_id",
        &request->graph_scope, request->source_scope);
    if (status != XPOD_RDF_STATUS_OK) return status;
    status = append_access_scope_conditions(
        state, &scoped_conditions, &scoped_params, "q.graph_id", "q.source_file_id",
        request->access_scope, request->source_scope);
    if (status != XPOD_RDF_STATUS_OK) return status;
    if (!scoped_conditions.empty()) {
      std::string exists =
          "EXISTS (SELECT 1 FROM rdf_quads q WHERE q.source_file_id = rdf_source.id";
      for (const std::string& clause : scoped_conditions) {
        exists += " AND " + clause;
      }
      exists += ")";
      conditions.push_back(std::move(exists));
      params.insert(params.end(), scoped_params.begin(), scoped_params.end());
    }
  }

  const std::string query = bytes_to_string(request->query);
  const bool prefix_query = !query.empty() && query.back() == '*';
  const std::string normalized_query =
      prefix_query ? query.substr(0, query.size() - 1) : query;
  if (prefix_query) {
    append_prefix_condition(&conditions, &params, "term.term", normalized_query);
  } else {
    conditions.push_back("term.term = ?");
    add_text(&params, normalized_query);
  }
  if (request->required_entities_size != 0) {
    conditions.push_back(
        "resource_term.id IN (" + placeholders(request->required_entities_size) + ")");
    for (size_t i = 0; i < request->required_entities_size; ++i) {
      add_u64(&params, request->required_entities[i]);
    }
  }

  std::string sql =
      "SELECT DISTINCT chunk.id AS retrieval_point, rdf_source.id AS source_node, ";
  sql += "source.source_key AS source_key, ";
  sql += "chunk.chunk_key AS retrieval_point_key, ";
  sql += request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_ENTITY
             ? "resource_term.id"
             : "NULL";
  sql += " AS resource_term_id, ";
  sql += prefix_query ? "term.id" : "NULL";
  sql += " AS matched_term_id";
  sql +=
      ", term.occurrences AS score, chunk.start_offset, chunk.end_offset" + from;
  if (!conditions.empty()) {
    sql += " WHERE ";
    for (size_t i = 0; i < conditions.size(); ++i) {
      if (i != 0) sql += " AND ";
      sql += conditions[i];
    }
  }
  sql +=
      " ORDER BY score DESC, retrieval_point ASC, "
      "resource_term_id ASC, matched_term_id ASC";
  if (request->limit != 0) sql += " LIMIT " + std::to_string(request->limit);
  if (request->offset != 0) {
    if (request->limit == 0) sql += " LIMIT -1";
    sql += " OFFSET " + std::to_string(request->offset);
  }
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<xpod_rdf_candidate> candidates;
  std::deque<std::string> candidate_source_keys;
  std::deque<std::string> candidate_retrieval_point_keys;
  std::vector<xpod_rdf_text_term_key> matched_terms;
  std::vector<uint8_t> has_matched_terms;
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    xpod_rdf_candidate candidate = {};
    const bool resource_term_is_null =
        sqlite3_column_type(stmt.stmt, 4) == SQLITE_NULL;
    const bool matched_term_is_null =
        sqlite3_column_type(stmt.stmt, 5) == SQLITE_NULL;
    if ((request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_ENTITY &&
         resource_term_is_null) ||
        (prefix_query && matched_term_is_null)) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    const int64_t start_offset = sqlite3_column_int64(stmt.stmt, 7);
    const int64_t end_offset = sqlite3_column_int64(stmt.stmt, 8);
    if (start_offset < 0 || end_offset < start_offset) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    candidate.retrieval_point = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
    candidate.has_retrieval_point = 1;
    candidate.source_node = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 1));
    candidate.has_source_node = 1;
    const unsigned char* source_key = sqlite3_column_text(stmt.stmt, 2);
    const unsigned char* retrieval_point_key =
        sqlite3_column_text(stmt.stmt, 3);
    if (source_key == nullptr || retrieval_point_key == nullptr) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    candidate_source_keys.emplace_back(
        reinterpret_cast<const char*>(source_key),
        static_cast<size_t>(sqlite3_column_bytes(stmt.stmt, 2)));
    candidate_retrieval_point_keys.emplace_back(
        reinterpret_cast<const char*>(retrieval_point_key),
        static_cast<size_t>(sqlite3_column_bytes(stmt.stmt, 3)));
    candidate.source_key = {
        candidate_source_keys.back().data(),
        candidate_source_keys.back().size()};
    candidate.has_source_key = 1;
    candidate.retrieval_point_key = {
        candidate_retrieval_point_keys.back().data(),
        candidate_retrieval_point_keys.back().size()};
    candidate.has_retrieval_point_key = 1;
    if (!resource_term_is_null) {
      candidate.resource_term =
          static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 4));
      candidate.has_resource_term = 1;
    }
    matched_terms.push_back(
        matched_term_is_null
            ? 0
            : static_cast<xpod_rdf_text_term_key>(
                  sqlite3_column_int64(stmt.stmt, 5)));
    has_matched_terms.push_back(matched_term_is_null ? 0 : 1);
    candidate.score = sqlite3_column_double(stmt.stmt, 6);
    candidate.range.start_offset = static_cast<uint64_t>(start_offset);
    candidate.range.end_offset = static_cast<uint64_t>(end_offset);
    candidate.scorer = static_bytes(kSqliteTextScorer);
    candidates.push_back(candidate);
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = candidates.data();
  batch.row_count = candidates.size();
  batch.scanned_rows = candidates.size();
  batch.scorer = static_bytes(kSqliteTextScorer);
  batch.matched_terms = matched_terms.data();
  batch.has_matched_terms = has_matched_terms.data();
  return on_batch(callback_user_data, &batch);
}

xpod_rdf_status sqlite_estimate_text_search(
    void* backend_user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || request == nullptr || out_estimate == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_RECORD &&
      request->candidate_kind != XPOD_RDF_TEXT_CANDIDATE_ENTITY) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (request->candidate_kind == XPOD_RDF_TEXT_CANDIDATE_RECORD &&
      request->required_entities_size != 0) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::string data_version;
  status = metadata_value(state, "data_version", &data_version);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  *out_estimate = {};
  out_estimate->rows = request->limit == 0 ? 1 : request->limit;
  out_estimate->selectivity = 1.0;
  out_estimate->startup_cost = 1.0;
  out_estimate->cpu_cost = static_cast<double>(out_estimate->rows);
  out_estimate->io_cost = static_cast<double>(out_estimate->rows);
  out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
  out_estimate->stats_version = owned_bytes(state, data_version);
  out_estimate->reason = static_bytes("sqlite-heuristic-text-limit");
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_resolve_retrieval_points(
    void* backend_user_data,
    const xpod_rdf_retrieval_point_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_bytes* out_contents,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr ||
      (key_count != 0 &&
       (keys == nullptr || out_contents == nullptr || out_statuses == nullptr))) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  if (key_count == 0) return XPOD_RDF_STATUS_OK;

  std::vector<SqlParam> params;
  for (size_t i = 0; i < key_count; ++i) add_u64(&params, keys[i]);
  Statement stmt;
  status = prepare(
      state,
      "SELECT id, content FROM rdf_text_chunks WHERE id IN (" +
          placeholders(key_count) + ")",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;

  std::unordered_map<xpod_rdf_retrieval_point_key, xpod_rdf_bytes> resolved;
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    const uint64_t id = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
    const char* content =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 1));
    const int content_size = sqlite3_column_bytes(stmt.stmt, 1);
    if (content == nullptr || content_size < 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
    resolved.emplace(
        id,
        owned_bytes(state, std::string(content, static_cast<size_t>(content_size))));
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;

  for (size_t i = 0; i < key_count; ++i) {
    out_contents[i] = {};
    const auto found = resolved.find(keys[i]);
    if (found == resolved.end()) {
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    } else {
      out_contents[i] = found->second;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_resolve_text_term(
    void* backend_user_data,
    xpod_rdf_text_term_key key,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_bytes* out_term) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || out_term == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  Statement stmt;
  status = prepare(state, "SELECT term FROM rdf_text_terms WHERE id = ?", &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_u64(stmt.stmt, 1, key);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_DONE) return XPOD_RDF_STATUS_NOT_FOUND;
  if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
  const char* term = reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 0));
  const int term_size = sqlite3_column_bytes(stmt.stmt, 0);
  if (term == nullptr || term_size < 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  *out_term = owned_bytes(state, std::string(term, static_cast<size_t>(term_size)));
  return sqlite3_step(stmt.stmt) == SQLITE_DONE ? XPOD_RDF_STATUS_OK
                                                : XPOD_RDF_STATUS_BACKEND_ERROR;
}

xpod_rdf_status sqlite_resolve_text_terms(
    void* backend_user_data,
    const xpod_rdf_text_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot* snapshot,
    xpod_rdf_bytes* out_terms,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr ||
      (key_count != 0 &&
       (keys == nullptr || out_terms == nullptr || out_statuses == nullptr))) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  for (size_t i = 0; i < key_count; ++i) {
    out_terms[i] = {};
    Statement stmt;
    status = prepare(state, "SELECT term FROM rdf_text_terms WHERE id = ?", &stmt);
    if (status != XPOD_RDF_STATUS_OK) return status;
    status = bind_u64(stmt.stmt, 1, keys[i]);
    if (status != XPOD_RDF_STATUS_OK) return status;
    const int rc = sqlite3_step(stmt.stmt);
    if (rc == SQLITE_DONE) {
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
      continue;
    }
    if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
    const char* term =
        reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 0));
    const int term_size = sqlite3_column_bytes(stmt.stmt, 0);
    if (term == nullptr || term_size < 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
    out_terms[i] =
        owned_bytes(state, std::string(term, static_cast<size_t>(term_size)));
    out_statuses[i] = sqlite3_step(stmt.stmt) == SQLITE_DONE
                          ? XPOD_RDF_STATUS_OK
                          : XPOD_RDF_STATUS_BACKEND_ERROR;
    if (out_statuses[i] != XPOD_RDF_STATUS_OK) return out_statuses[i];
  }
  return XPOD_RDF_STATUS_OK;
}

double cosine_score(double dot_product, double chunk_magnitude, double query_magnitude) {
  if (chunk_magnitude == 0.0 || query_magnitude == 0.0) return 0.0;
  return dot_product / (chunk_magnitude * query_magnitude);
}

double dot_score(double dot_product) {
  return dot_product;
}

double euclidean_score(double dot_product, double chunk_magnitude, double query_magnitude) {
  const double distance_squared =
      std::max(0.0, chunk_magnitude * chunk_magnitude +
                        query_magnitude * query_magnitude - 2.0 * dot_product);
  return -std::sqrt(distance_squared);
}

xpod_rdf_status sqlite_vector_search(
    void* backend_user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request == nullptr || on_batch == nullptr || request->vector == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (request->dimensions == 0 || !has_bytes(request->provider) ||
      !has_bytes(request->model) || !has_bytes(request->model_version) ||
      !has_bytes(request->input_kind) ||
      !has_bytes(request->projection_policy_version) ||
      (request->metric != XPOD_RDF_VECTOR_COSINE &&
       request->metric != XPOD_RDF_VECTOR_DOT &&
       request->metric != XPOD_RDF_VECTOR_EUCLIDEAN)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  double query_magnitude = 0.0;
  for (size_t i = 0; i < request->dimensions; ++i) {
    query_magnitude += request->vector[i] * request->vector[i];
  }
  query_magnitude = std::sqrt(query_magnitude);

  std::vector<std::string> conditions;
  std::vector<SqlParam> params;
  conditions.push_back("chunk.dimensions = ?");
  add_u64(&params, request->dimensions);
  conditions.push_back("chunk.provider = ?");
  add_text(&params, bytes_to_string(request->provider));
  conditions.push_back("chunk.model = ?");
  add_text(&params, bytes_to_string(request->model));
  conditions.push_back("chunk.model_version = ?");
  add_text(&params, bytes_to_string(request->model_version));
  conditions.push_back("chunk.input_kind = ?");
  add_text(&params, bytes_to_string(request->input_kind));
  conditions.push_back("chunk.projection_policy_version = ?");
  add_text(&params, bytes_to_string(request->projection_policy_version));
  conditions.push_back("component.dimension IN (" + placeholders(request->dimensions) + ")");
  for (size_t i = 0; i < request->dimensions; ++i) {
    add_u64(&params, i);
  }
  append_source_scope_conditions(
      &conditions, &params, "rdf_source", request->source_scope);
  if (request->access_scope != nullptr ||
      request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) {
    std::vector<std::string> scoped_conditions;
    std::vector<SqlParam> scoped_params;
    status = append_graph_scope_conditions(
        state, &scoped_conditions, &scoped_params, "q.graph_id",
        &request->graph_scope, request->source_scope);
    if (status != XPOD_RDF_STATUS_OK) return status;
    status = append_access_scope_conditions(
        state, &scoped_conditions, &scoped_params, "q.graph_id", "q.source_file_id",
        request->access_scope, request->source_scope);
    if (status != XPOD_RDF_STATUS_OK) return status;
    if (!scoped_conditions.empty()) {
      std::string exists =
          "EXISTS (SELECT 1 FROM rdf_quads q WHERE q.source_file_id = rdf_source.id";
      for (const std::string& clause : scoped_conditions) {
        exists += " AND " + clause;
      }
      exists += ")";
      conditions.push_back(std::move(exists));
      params.insert(params.end(), scoped_params.begin(), scoped_params.end());
    }
  }

  std::string dot_case = "CASE component.dimension";
  std::vector<SqlParam> query_params;
  for (size_t i = 0; i < request->dimensions; ++i) {
    dot_case += " WHEN " + std::to_string(i) + " THEN ?";
    add_real(&query_params, request->vector[i]);
  }
  query_params.insert(query_params.end(), params.begin(), params.end());
  params = std::move(query_params);
  dot_case += " ELSE 0 END";
  std::string sql =
      "SELECT text_chunk.id, rdf_source.id, "
      "text_source.source_key AS source_key, "
      "text_chunk.chunk_key AS retrieval_point_key, "
      "resource.id, chunk.magnitude, "
      "SUM(component.value * " +
      dot_case +
      ") AS dot_product "
      "FROM rdf_vector_chunks chunk "
      "JOIN rdf_vector_sources source ON source.id = chunk.source_id "
      "JOIN rdf_text_sources text_source ON "
      "text_source.source_key = source.source_key "
      "JOIN rdf_text_chunks text_chunk ON text_chunk.source_id = text_source.id "
      "AND text_chunk.chunk_key = chunk.chunk_key "
      "JOIN rdf_sources rdf_source ON rdf_source.source = text_source.source "
      "JOIN rdf_vector_components component ON component.chunk_id = chunk.id "
      "LEFT JOIN rdf_terms resource ON resource.kind = 'iri' "
      "AND resource.value = text_source.source";
  if (!conditions.empty()) {
    sql += " WHERE ";
    for (size_t i = 0; i < conditions.size(); ++i) {
      if (i != 0) sql += " AND ";
      sql += conditions[i];
    }
  }
  sql +=
      " GROUP BY text_chunk.id, rdf_source.id, text_source.source_key, text_chunk.chunk_key, resource.id, chunk.magnitude "
      "HAVING COUNT(DISTINCT component.dimension) = " +
      std::to_string(request->dimensions) +
      " ORDER BY dot_product DESC, text_chunk.id ASC";
  Statement stmt;
  status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  std::vector<xpod_rdf_candidate> candidates;
  std::deque<std::string> candidate_source_keys;
  std::deque<std::string> candidate_retrieval_point_keys;
  int rc = SQLITE_OK;
  while ((rc = sqlite3_step(stmt.stmt)) == SQLITE_ROW) {
    const bool resource_term_is_null =
        sqlite3_column_type(stmt.stmt, 4) == SQLITE_NULL;
    const double chunk_magnitude = sqlite3_column_double(stmt.stmt, 5);
    const double dot_product = sqlite3_column_double(stmt.stmt, 6);
    double score = 0.0;
    switch (request->metric) {
      case XPOD_RDF_VECTOR_COSINE:
        score = cosine_score(dot_product, chunk_magnitude, query_magnitude);
        break;
      case XPOD_RDF_VECTOR_DOT:
        score = dot_score(dot_product);
        break;
      case XPOD_RDF_VECTOR_EUCLIDEAN:
        score = euclidean_score(dot_product, chunk_magnitude, query_magnitude);
        break;
    }
    if (request->has_threshold != 0 && score < request->threshold) {
      continue;
    }
    xpod_rdf_candidate candidate = {};
    candidate.retrieval_point = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
    candidate.has_retrieval_point = 1;
    candidate.source_node = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 1));
    candidate.has_source_node = 1;
    const unsigned char* source_key = sqlite3_column_text(stmt.stmt, 2);
    const unsigned char* retrieval_point_key =
        sqlite3_column_text(stmt.stmt, 3);
    if (source_key == nullptr || retrieval_point_key == nullptr) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    candidate_source_keys.emplace_back(
        reinterpret_cast<const char*>(source_key),
        static_cast<size_t>(sqlite3_column_bytes(stmt.stmt, 2)));
    candidate_retrieval_point_keys.emplace_back(
        reinterpret_cast<const char*>(retrieval_point_key),
        static_cast<size_t>(sqlite3_column_bytes(stmt.stmt, 3)));
    candidate.source_key = {
        candidate_source_keys.back().data(),
        candidate_source_keys.back().size()};
    candidate.has_source_key = 1;
    candidate.retrieval_point_key = {
        candidate_retrieval_point_keys.back().data(),
        candidate_retrieval_point_keys.back().size()};
    candidate.has_retrieval_point_key = 1;
    if (!resource_term_is_null) {
      candidate.resource_term =
          static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 4));
      candidate.has_resource_term = 1;
    }
    candidate.score = score;
    candidate.scorer = static_bytes(kSqliteVectorScorer);
    candidates.push_back(candidate);
  }
  if (rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  std::stable_sort(
      candidates.begin(),
      candidates.end(),
      [](const xpod_rdf_candidate& left, const xpod_rdf_candidate& right) {
        if (left.score != right.score) return left.score > right.score;
        return left.retrieval_point < right.retrieval_point;
      });
  if (request->limit != 0 && candidates.size() > request->limit) {
    candidates.resize(static_cast<size_t>(request->limit));
  }
  xpod_rdf_candidate_batch batch = {};
  batch.rows = candidates.data();
  batch.row_count = candidates.size();
  batch.scanned_rows = candidates.size();
  batch.scorer = static_bytes(kSqliteVectorScorer);
  return on_batch(callback_user_data, &batch);
}

xpod_rdf_status sqlite_estimate_vector_search(
    void* backend_user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || request == nullptr || out_estimate == nullptr ||
      request->vector == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_status status = validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (request->dimensions == 0 || request->limit == 0 ||
      !has_bytes(request->provider) || !has_bytes(request->model) ||
      !has_bytes(request->model_version) || !has_bytes(request->input_kind) ||
      !has_bytes(request->projection_policy_version) ||
      (request->metric != XPOD_RDF_VECTOR_COSINE &&
       request->metric != XPOD_RDF_VECTOR_DOT &&
       request->metric != XPOD_RDF_VECTOR_EUCLIDEAN)) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  std::string data_version;
  status = metadata_value(state, "data_version", &data_version);
  if (status != XPOD_RDF_STATUS_OK) return status;
  state->owned_strings.clear();
  *out_estimate = {};
  out_estimate->rows = request->limit;
  out_estimate->selectivity = 1.0;
  out_estimate->startup_cost = 1.0;
  out_estimate->cpu_cost =
      static_cast<double>(request->limit) *
      static_cast<double>(request->dimensions);
  out_estimate->io_cost = static_cast<double>(request->limit);
  out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
  out_estimate->stats_version = owned_bytes(state, data_version);
  out_estimate->reason = static_bytes("sqlite-heuristic-vector-limit");
  return XPOD_RDF_STATUS_OK;
}

std::string normalized_text_for_term(const xpod_rdf_term& term) {
  std::string value = bytes_to_string(term.value);
  if (term.kind != XPOD_RDF_TERM_LITERAL && term.kind != XPOD_RDF_TERM_IRI &&
      term.kind != XPOD_RDF_TERM_BLANK) {
    return {};
  }
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

xpod_rdf_status upsert_term(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_term* term,
    xpod_rdf_term_key* out_key) {
  if (term != nullptr && is_qlever_default_graph_iri(*term)) {
    return ensure_default_graph_key(state, out_key);
  }
  xpod_rdf_status status = lookup_term_key(state, term, out_key);
  if (status == XPOD_RDF_STATUS_OK) return status;
  if (status != XPOD_RDF_STATUS_NOT_FOUND) return status;
  if (state->read_only) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  const std::string kind = term_kind_name(term->kind);
  if (kind.empty()) return XPOD_RDF_STATUS_UNSUPPORTED;

  uint64_t datatype_id = 0;
  bool has_datatype_id = false;
  if (term->kind == XPOD_RDF_TERM_LITERAL && has_bytes(term->language)) {
    xpod_rdf_term datatype = {};
    datatype.kind = XPOD_RDF_TERM_IRI;
    datatype.value = static_bytes(kRdfLangString);
    status = upsert_term(state, &datatype, &datatype_id);
    if (status != XPOD_RDF_STATUS_OK) return status;
    has_datatype_id = true;
  } else if (term->kind == XPOD_RDF_TERM_LITERAL && has_bytes(term->datatype_iri) &&
             bytes_to_string(term->datatype_iri) != std::string(kXsdString)) {
    xpod_rdf_term datatype = {};
    datatype.kind = XPOD_RDF_TERM_IRI;
    datatype.value = term->datatype_iri;
    status = upsert_term(state, &datatype, &datatype_id);
    if (status != XPOD_RDF_STATUS_OK) return status;
    has_datatype_id = true;
  }

  const std::string value = bytes_to_string(term->value);
  const std::string value_head = value.substr(0, std::min<size_t>(value.size(), 256));
  const std::string identity = rdf_term_identity_hash(
      kind,
      value,
      datatype_id,
      has_datatype_id,
      bytes_to_string(term->language));
  if (identity.empty()) return XPOD_RDF_STATUS_BACKEND_ERROR;
  Statement stmt;
  status = prepare(
      state,
      "INSERT OR IGNORE INTO rdf_terms "
      "(kind, value, value_head, datatype_id, lang, hash, normalized_text, numeric_value) "
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  sqlite3_bind_text(stmt.stmt, 1, kind.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt.stmt, 2, value.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt.stmt, 3, value_head.c_str(), -1, SQLITE_TRANSIENT);
  if (has_datatype_id) {
    bind_u64(stmt.stmt, 4, datatype_id);
  } else {
    sqlite3_bind_null(stmt.stmt, 4);
  }
  if (has_bytes(term->language)) {
    bind_bytes(stmt.stmt, 5, term->language);
  } else {
    sqlite3_bind_null(stmt.stmt, 5);
  }
  sqlite3_bind_text(stmt.stmt, 6, identity.c_str(), -1, SQLITE_TRANSIENT);
  const std::string normalized = normalized_text_for_term(*term);
  if (normalized.empty()) {
    sqlite3_bind_null(stmt.stmt, 7);
  } else {
    sqlite3_bind_text(stmt.stmt, 7, normalized.c_str(), -1, SQLITE_TRANSIENT);
  }
  status = sqlite_done_status(stmt.stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  return lookup_term_key(state, term, out_key);
}

xpod_rdf_status mutation_graph_key(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_mutation_request* request,
    const xpod_rdf_quad& quad,
    xpod_rdf_term_key* out_key) {
  if (quad.has_graph != 0) {
    return upsert_term(state, &quad.graph, out_key);
  }
  if (request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT) {
    return normalize_graph_key(state, request->graph_scope.exact_graph, out_key);
  }
  return ensure_default_graph_key(state, out_key);
}

xpod_rdf_status resolve_mutation_source_file_id(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_source_scope& source_scope,
    bool* out_has_source,
    xpod_rdf_source_node_key* out_source) {
  if (out_has_source == nullptr || out_source == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_has_source = false;
  *out_source = 0;
  if (source_scope.has_source_node != 0) {
    *out_has_source = true;
    *out_source = source_scope.source_node;
    return XPOD_RDF_STATUS_OK;
  }
  if (has_bytes(source_scope.source_uri_prefix) ||
      has_bytes(source_scope.local_path_prefix) ||
      source_scope.include_files != 0 ||
      source_scope.include_folders != 0) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (!has_bytes(source_scope.source_uri) &&
      !has_bytes(source_scope.workspace) &&
      !has_bytes(source_scope.local_path)) {
    return XPOD_RDF_STATUS_OK;
  }
  std::vector<std::string> conditions;
  std::vector<SqlParam> params;
  append_source_scope_conditions(&conditions, &params, "rdf_sources", source_scope);
  std::string sql = "SELECT id FROM rdf_sources";
  if (!conditions.empty()) {
    sql += " WHERE ";
    for (size_t i = 0; i < conditions.size(); ++i) {
      if (i != 0) sql += " AND ";
      sql += conditions[i];
    }
  }
  sql += " ORDER BY id LIMIT 2";
  Statement stmt;
  xpod_rdf_status status = prepare(state, sql, &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_params(stmt.stmt, params);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_DONE) return XPOD_RDF_STATUS_NOT_FOUND;
  if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
  *out_source = static_cast<uint64_t>(sqlite3_column_int64(stmt.stmt, 0));
  *out_has_source = true;
  const int second_rc = sqlite3_step(stmt.stmt);
  if (second_rc == SQLITE_ROW) return XPOD_RDF_STATUS_UNSUPPORTED;
  if (second_rc != SQLITE_DONE) return XPOD_RDF_STATUS_BACKEND_ERROR;
  return XPOD_RDF_STATUS_OK;
}

bool key_in_list(
    const xpod_rdf_term_key* keys,
    size_t size,
    xpod_rdf_term_key key) {
  return std::find(keys, keys + size, key) != keys + size;
}

xpod_rdf_status graph_value(
    XpodRdfSqliteBackendState* state,
    xpod_rdf_term_key key,
    std::string* out_value) {
  Statement stmt;
  xpod_rdf_status status =
      prepare(state, "SELECT value FROM rdf_terms WHERE id = ?", &stmt);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = bind_u64(stmt.stmt, 1, key);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const int rc = sqlite3_step(stmt.stmt);
  if (rc == SQLITE_DONE) {
    out_value->clear();
    return XPOD_RDF_STATUS_OK;
  }
  if (rc != SQLITE_ROW) return XPOD_RDF_STATUS_BACKEND_ERROR;
  const char* value =
      reinterpret_cast<const char*>(sqlite3_column_text(stmt.stmt, 0));
  *out_value = value == nullptr ? std::string{} : value;
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status check_write_access_for_graph(
    XpodRdfSqliteBackendState* state,
    const xpod_rdf_access_scope* access_scope,
    xpod_rdf_term_key graph) {
  if (access_scope == nullptr) return XPOD_RDF_STATUS_OK;
  if (access_scope->allowed_graphs_size != 0 &&
      !key_in_list(access_scope->allowed_graphs, access_scope->allowed_graphs_size, graph)) {
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  if (access_scope->denied_graphs_size != 0 &&
      key_in_list(access_scope->denied_graphs, access_scope->denied_graphs_size, graph)) {
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  if (access_scope->allowed_graph_prefixes_size == 0 &&
      access_scope->denied_graph_prefixes_size == 0) {
    return XPOD_RDF_STATUS_OK;
  }
  std::string value;
  xpod_rdf_status status = graph_value(state, graph, &value);
  if (status != XPOD_RDF_STATUS_OK) return status;
  if (access_scope->allowed_graph_prefixes_size != 0) {
    bool allowed = false;
    for (size_t i = 0; i < access_scope->allowed_graph_prefixes_size; ++i) {
      const std::string prefix = bytes_to_string(access_scope->allowed_graph_prefixes[i]);
      if (value.rfind(prefix, 0) == 0) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  for (size_t i = 0; i < access_scope->denied_graph_prefixes_size; ++i) {
    const std::string prefix = bytes_to_string(access_scope->denied_graph_prefixes[i]);
    if (value.rfind(prefix, 0) == 0) {
      return XPOD_RDF_STATUS_PERMISSION_DENIED;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_apply_mutation(
    void* backend_user_data,
    const xpod_rdf_mutation_request* request,
    xpod_rdf_mutation_result* out_result) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || request == nullptr || out_result == nullptr ||
      (request->mutation_count != 0 && request->mutations == nullptr)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (state->read_only) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  xpod_rdf_status status = state->transaction_active
                                ? XPOD_RDF_STATUS_OK
                                : validate_snapshot(state, &request->snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  *out_result = {};
  bool has_source_file_id = false;
  xpod_rdf_source_node_key source_file_id = 0;
  status = resolve_mutation_source_file_id(
      state, request->source_scope, &has_source_file_id, &source_file_id);
  if (status != XPOD_RDF_STATUS_OK) return status;
  const bool owned_transaction = !state->transaction_active;
  if (owned_transaction) {
    status = sqlite_status(sqlite3_exec(state->db, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr));
    if (status != XPOD_RDF_STATUS_OK) return status;
  }
  for (size_t i = 0; i < request->mutation_count; ++i) {
    if (cancellation_requested(request->cancellation)) {
      if (owned_transaction) sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr);
      return XPOD_RDF_STATUS_CANCELLED;
    }
    const xpod_rdf_quad_mutation& mutation = request->mutations[i];
    xpod_rdf_quad_key key = {};
    status = upsert_term(state, &mutation.quad.subject, &key.subject);
    if (status == XPOD_RDF_STATUS_OK) status = upsert_term(state, &mutation.quad.predicate, &key.predicate);
    if (status == XPOD_RDF_STATUS_OK) status = upsert_term(state, &mutation.quad.object, &key.object);
    if (status == XPOD_RDF_STATUS_OK) status = mutation_graph_key(state, request, mutation.quad, &key.graph);
    if (status != XPOD_RDF_STATUS_OK) {
      if (owned_transaction) sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr);
      return status;
    }
    status = check_write_access_for_graph(state, request->access_scope, key.graph);
    if (status != XPOD_RDF_STATUS_OK) {
      if (owned_transaction) sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr);
      return status;
    }
    Statement stmt;
    if (mutation.kind == XPOD_RDF_MUTATION_INSERT) {
      status = prepare(
          state,
          "INSERT OR IGNORE INTO rdf_quads "
          "(graph_id, subject_id, predicate_id, object_id, source_file_id, source_line_no) "
          "VALUES (?, ?, ?, ?, ?, NULL)",
          &stmt);
    } else if (mutation.kind == XPOD_RDF_MUTATION_DELETE) {
      status = prepare(
          state,
          "DELETE FROM rdf_quads WHERE graph_id = ? AND subject_id = ? "
          "AND predicate_id = ? AND object_id = ?",
          &stmt);
    } else {
      status = XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (status == XPOD_RDF_STATUS_OK) {
      bind_u64(stmt.stmt, 1, key.graph);
      bind_u64(stmt.stmt, 2, key.subject);
      bind_u64(stmt.stmt, 3, key.predicate);
      bind_u64(stmt.stmt, 4, key.object);
      if (mutation.kind == XPOD_RDF_MUTATION_INSERT) {
        if (has_source_file_id) {
          bind_u64(stmt.stmt, 5, source_file_id);
        } else {
          sqlite3_bind_null(stmt.stmt, 5);
        }
      }
      status = sqlite_done_status(stmt.stmt);
    }
    if (status != XPOD_RDF_STATUS_OK) {
      if (owned_transaction) sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr);
      return status;
    }
    const int changed = sqlite3_changes(state->db);
    if (mutation.kind == XPOD_RDF_MUTATION_INSERT) {
      out_result->inserted_count += static_cast<uint64_t>(std::max(changed, 0));
    } else {
      out_result->deleted_count += static_cast<uint64_t>(std::max(changed, 0));
    }
  }
  const bool changed = out_result->inserted_count != 0 || out_result->deleted_count != 0;
  if (changed) {
    state->transaction_dirty = true;
  }
  std::string version;
  if (metadata_value(state, "data_version", &version) == XPOD_RDF_STATUS_OK) {
    out_result->facts_version = owned_bytes(state, version);
  }
  if (owned_transaction) {
    status = sqlite_status(sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr));
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    state->transaction_dirty = false;
  }
  return XPOD_RDF_STATUS_OK;
}

xpod_rdf_status sqlite_begin_transaction(void* backend_user_data, const xpod_rdf_snapshot* snapshot) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (state->read_only) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  xpod_rdf_status status = validate_snapshot(state, snapshot);
  if (status != XPOD_RDF_STATUS_OK) return status;
  status = sqlite_status(sqlite3_exec(state->db, "BEGIN DEFERRED", nullptr, nullptr, nullptr));
  if (status == XPOD_RDF_STATUS_OK) state->transaction_active = true;
  return status;
}

xpod_rdf_status sqlite_commit_transaction(void* backend_user_data) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || !state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_status status = sqlite_status(sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr));
  state->transaction_active = false;
  state->transaction_dirty = false;
  return status == XPOD_RDF_STATUS_OK ? XPOD_RDF_STATUS_UNSUPPORTED : status;
}

xpod_rdf_status sqlite_rollback_transaction(void* backend_user_data) {
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend_user_data);
  if (state == nullptr || !state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_status status = sqlite_status(sqlite3_exec(state->db, "ROLLBACK", nullptr, nullptr, nullptr));
  state->transaction_active = false;
  state->transaction_dirty = false;
  return status;
}

xpod_rdf_sqlite_backend_config config_from_json(
    const xpod_rdf_bytes* config_json,
    std::string* path_storage,
    bool* out_ok) {
  if (out_ok != nullptr) *out_ok = true;
  xpod_rdf_sqlite_backend_config config = {};
  const std::string json =
      config_json == nullptr ? std::string{} : bytes_to_string(*config_json);
  Json parsed = Json::object();
  if (!json.empty()) {
    parsed = Json::parse(json, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) {
      if (out_ok != nullptr) *out_ok = false;
      return config;
    }
  }
  *path_storage = parsed.value("databasePath", std::string{});
  if (path_storage->empty()) {
    *path_storage = parsed.value("database_path", std::string{});
  }
  const auto bool_value = [&parsed](const char* camel, const char* snake) {
    return parsed.value(camel, false) || parsed.value(snake, false);
  };
  config.database_path = {path_storage->data(), path_storage->size()};
  config.read_only = bool_value("readOnly", "read_only") ? 1 : 0;
  config.require_text_search =
      bool_value("requireTextSearch", "require_text_search") ? 1 : 0;
  config.require_vector_search =
      bool_value("requireVectorSearch", "require_vector_search") ? 1 : 0;
  return config;
}

}  // namespace

extern "C" xpod_rdf_status xpod_rdf_sqlite_backend_create(
    const xpod_rdf_sqlite_backend_config* config,
    xpod_rdf_backend_v1** out_backend) {
  if (config == nullptr || out_backend == nullptr ||
      !has_bytes(config->database_path)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_backend = nullptr;
  std::unique_ptr<XpodRdfSqliteBackendState> state(new XpodRdfSqliteBackendState());
  state->database_path = bytes_to_string(config->database_path);
  state->read_only = config->read_only != 0;
  const int flags = (state->read_only ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE) |
                    SQLITE_OPEN_NOMUTEX;
  if (sqlite3_open_v2(state->database_path.c_str(), &state->db, flags, nullptr) != SQLITE_OK) {
    if (state->db != nullptr) sqlite3_close(state->db);
    state->db = nullptr;
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  sqlite3_busy_timeout(state->db, 5000);
  if (sqlite3_exec(state->db, "PRAGMA foreign_keys = ON", nullptr, nullptr, nullptr) != SQLITE_OK) {
    sqlite3_close(state->db);
    state->db = nullptr;
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!has_facts_schema(state.get())) {
    sqlite3_close(state->db);
    state->db = nullptr;
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  state->has_text = has_text_schema(state.get());
  state->has_vector = has_vector_schema(state.get());
  if ((config->require_text_search != 0 && !state->has_text) ||
      (config->require_vector_search != 0 && !state->has_vector)) {
    sqlite3_close(state->db);
    state->db = nullptr;
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  state->backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  state->backend.struct_size = sizeof(xpod_rdf_backend_v1);
  state->backend.backend_user_data = state.get();
  state->backend.get_capabilities = sqlite_get_capabilities;
  state->backend.lookup_term = sqlite_lookup_term;
  state->backend.resolve_term = sqlite_resolve_term;
  state->backend.lookup_terms = sqlite_lookup_terms;
  state->backend.resolve_terms = sqlite_resolve_terms;
  state->backend.scan_permutation = sqlite_scan_permutation;
  state->backend.open_scan_cursor = sqlite_open_scan_cursor;
  state->backend.next_scan_cursor = sqlite_next_scan_cursor;
  state->backend.close_scan_cursor = sqlite_close_scan_cursor;
  state->backend.count_scan = sqlite_count_scan;
  state->backend.distinct_scan = sqlite_distinct_scan;
  state->backend.estimate_scan = sqlite_estimate_scan;
  state->backend.estimate_distinct = sqlite_estimate_distinct;
  state->backend.estimate_join_fanout = sqlite_estimate_join_fanout;
  state->backend.estimate_source_scope = sqlite_estimate_source_scope;
  state->backend.resolve_source_scope = sqlite_resolve_source_scope;
  state->backend.estimate_access_scope = sqlite_estimate_access_scope;
  state->backend.encode_qlever_id = sqlite_encode_qlever_id;
  state->backend.decode_qlever_id = sqlite_decode_qlever_id;
  state->backend.compare_qlever_ids = sqlite_compare_qlever_ids;
  state->backend.prefetch_qlever_ids = sqlite_prefetch_qlever_ids;
  state->backend.encode_qlever_ids = sqlite_encode_qlever_ids;
  if (!state->read_only) {
    state->backend.begin_transaction = sqlite_begin_transaction;
    state->backend.commit_transaction = sqlite_commit_transaction;
    state->backend.rollback_transaction = sqlite_rollback_transaction;
    state->backend.apply_mutation = sqlite_apply_mutation;
  }
  state->backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_OPAQUE;
  state->backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_UNKNOWN;
  if (state->has_text) {
    state->backend.text_search = sqlite_text_search;
    state->backend.estimate_text_search = sqlite_estimate_text_search;
    state->backend.resolve_retrieval_points = sqlite_resolve_retrieval_points;
    state->backend.resolve_text_term = sqlite_resolve_text_term;
    state->backend.resolve_text_terms = sqlite_resolve_text_terms;
  }
  if (state->has_vector) {
    state->backend.vector_search = sqlite_vector_search;
    state->backend.estimate_vector_search = sqlite_estimate_vector_search;
  }

  *out_backend = &state->backend;
  state.release();
  return XPOD_RDF_STATUS_OK;
}

extern "C" void xpod_rdf_sqlite_backend_destroy(xpod_rdf_backend_v1* backend) {
  if (backend == nullptr) return;
  auto* state = static_cast<XpodRdfSqliteBackendState*>(backend->backend_user_data);
  if (state == nullptr) return;
  if (state->db != nullptr) {
    sqlite3_close(state->db);
    state->db = nullptr;
  }
  delete state;
}

extern "C" xpod_rdf_status xpod_qlever_backend_provider_create(
    const xpod_rdf_bytes* config_json,
    xpod_rdf_backend_v1** out_backend) {
  std::string path;
  bool ok = true;
  xpod_rdf_sqlite_backend_config config = config_from_json(config_json, &path, &ok);
  if (!ok) return XPOD_RDF_STATUS_BACKEND_ERROR;
  return xpod_rdf_sqlite_backend_create(&config, out_backend);
}

extern "C" void xpod_qlever_backend_provider_destroy(xpod_rdf_backend_v1* backend) {
  xpod_rdf_sqlite_backend_destroy(backend);
}
