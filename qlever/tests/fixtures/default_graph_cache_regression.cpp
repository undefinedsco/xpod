// Faithful regression for the stale default-graph key cache in the sqlite RDF backend.
//
// The product writes facts with the TypeScript index (an external SQLite writer);
// the native runtime only reads. These regressions drive the backend as the runtime
// does and mutate the shared file from a second SQLite connection.
//
// Regression 1: A resolves an empty default graph, external writer inserts the
//   default graph + a quad, then the same A must resolve and count it.
// Regression 2: A prepares a temporary default-graph insert in a transaction and
//   rolls it back; A must not keep the rolled-back id, and must later resolve the
//   externally written default graph.
#include "xpod_rdf_physical_backend.h"

#include <dlfcn.h>
#include <sqlite3.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace {
using Create = xpod_rdf_status (*)(const xpod_rdf_bytes*, xpod_rdf_backend_v1**);
using Destroy = void (*)(xpod_rdf_backend_v1*);

xpod_rdf_bytes B(const char* value) {
  xpod_rdf_bytes bytes;
  bytes.data = value;
  bytes.size = std::strlen(value);
  return bytes;
}
xpod_rdf_term iri(const char* value) {
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_IRI;
  term.value = B(value);
  return term;
}
xpod_rdf_term literal(const char* value) {
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_LITERAL;
  term.value = B(value);
  return term;
}
xpod_rdf_term default_graph_iri() {
  return iri("http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph");
}

xpod_rdf_backend_v1* open(Create create, const std::string& config) {
  xpod_rdf_backend_v1* backend = nullptr;
  xpod_rdf_bytes bytes;
  bytes.data = config.data();
  bytes.size = config.size();
  if (create(&bytes, &backend) != XPOD_RDF_STATUS_OK) return nullptr;
  return backend;
}

xpod_rdf_term_key lookup_default_graph(xpod_rdf_backend_v1* backend) {
  xpod_rdf_snapshot snapshot = {};
  xpod_rdf_term term = default_graph_iri();
  xpod_rdf_term_key key = 0;
  if (backend->lookup_term(backend->backend_user_data, &term, &snapshot, &key) !=
      XPOD_RDF_STATUS_OK) {
    return 0;
  }
  return key;
}

uint64_t count_graph(xpod_rdf_backend_v1* backend, xpod_rdf_term_key graph) {
  xpod_rdf_scan_request scan = {};
  scan.snapshot = {};
  scan.permutation = XPOD_RDF_PERM_GSPO;
  scan.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  scan.graph_scope.exact_graph = graph;
  scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                      XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH;
  xpod_rdf_count_result result = {};
  if (backend->count_scan(backend->backend_user_data, &scan, &result) !=
      XPOD_RDF_STATUS_OK) {
    return UINT64_MAX;
  }
  return result.count;
}

// Copy rows created by the actual TypeScript RdfQuadIndex into this separate
// connection. Their hashes, datatype relations and schema are production data.
bool external_insert_default_graph(const char* db_path, const char* seed_path) {
  sqlite3* raw = nullptr;
  const int opened = sqlite3_open(db_path, &raw);
  std::unique_ptr<sqlite3, decltype(&sqlite3_close)> db(raw, sqlite3_close);
  if (opened != SQLITE_OK) {
    std::fprintf(stderr, "external sqlite open failed\n");
    return false;
  }
  int foreign_keys = 0;
  if (sqlite3_db_config(db.get(), SQLITE_DBCONFIG_ENABLE_FKEY, 1, &foreign_keys) != SQLITE_OK || foreign_keys != 1) {
    std::fprintf(stderr, "external foreign key enforcement unavailable\n");
    return false;
  }
  sqlite3_stmt* raw_attach = nullptr;
  if (sqlite3_prepare_v2(db.get(), "ATTACH DATABASE ? AS seed", -1, &raw_attach, nullptr) != SQLITE_OK) return false;
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> attach(raw_attach, sqlite3_finalize);
  if (sqlite3_bind_text(attach.get(), 1, seed_path, -1, SQLITE_TRANSIENT) != SQLITE_OK || sqlite3_step(attach.get()) != SQLITE_DONE) return false;
  attach.reset();
  const char* sql =
      "BEGIN;"
      "INSERT INTO rdf_terms SELECT * FROM seed.rdf_terms;"
      "INSERT INTO rdf_sources SELECT * FROM seed.rdf_sources;"
      "INSERT INTO rdf_quads SELECT * FROM seed.rdf_quads;"
      "UPDATE rdf_index_metadata SET value=(SELECT value FROM seed.rdf_index_metadata WHERE key='data_version') WHERE key='data_version';"
      "COMMIT;";
  char* error = nullptr;
  if (sqlite3_exec(db.get(), sql, nullptr, nullptr, &error) != SQLITE_OK) {
    std::fprintf(stderr, "external insert failed: %s\n", error == nullptr ? "?" : error);
    sqlite3_free(error);
    return false;
  }
  sqlite3_stmt* raw_check = nullptr;
  if (sqlite3_prepare_v2(db.get(), "PRAGMA foreign_key_check", -1, &raw_check, nullptr) != SQLITE_OK) return false;
  std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> check(raw_check, sqlite3_finalize);
  return sqlite3_step(check.get()) == SQLITE_DONE;
}

bool production_terms_resolve(xpod_rdf_backend_v1* backend) {
  xpod_rdf_snapshot snapshot = {};
  auto subject = iri("urn:xpod:cross");
  auto object = literal(R"({"note":"cross \"quoted\"","path":"C:\\data"})");
  xpod_rdf_term_key subject_key = 0;
  xpod_rdf_term_key object_key = 0;
  return backend->lookup_term(backend->backend_user_data, &subject, &snapshot, &subject_key) == XPOD_RDF_STATUS_OK && subject_key != 0 &&
         backend->lookup_term(backend->backend_user_data, &object, &snapshot, &object_key) == XPOD_RDF_STATUS_OK && object_key != 0;
}

xpod_rdf_status insert_default_graph_quad(xpod_rdf_backend_v1* backend,
                                          const char* subject) {
  xpod_rdf_quad quad = {};
  quad.subject = iri(subject);
  quad.predicate = iri("urn:xpod:p");
  quad.object = literal("temp");
  quad.has_graph = 0;
  xpod_rdf_quad_mutation mutation = {};
  mutation.kind = XPOD_RDF_MUTATION_INSERT;
  mutation.quad = quad;
  xpod_rdf_mutation_request request = {};
  xpod_rdf_mutation_result result = {};
  request.snapshot = {};
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  request.mutations = &mutation;
  request.mutation_count = 1;
  return backend->apply_mutation(backend->backend_user_data, &request, &result);
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr, "usage: default-graph-cache PROFILE DB1 DB2 SEED MODE\n");
    return 64;
  }
  void* library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (library == nullptr) {
    std::fprintf(stderr, "dlopen: %s\n", dlerror());
    return 2;
  }
  auto create = reinterpret_cast<Create>(
      dlsym(library, "xpod_qlever_backend_provider_create"));
  auto destroy = reinterpret_cast<Destroy>(
      dlsym(library, "xpod_qlever_backend_provider_destroy"));
  if (create == nullptr || destroy == nullptr) {
    std::fprintf(stderr, "provider entry points missing\n");
    return 2;
  }
  const std::string config1 =
      std::string("{\"databasePath\":\"") + argv[2] + "\",\"readOnly\":false}";
  const std::string config2 =
      std::string("{\"databasePath\":\"") + argv[3] + "\",\"readOnly\":false}";
  const bool run1 = std::string(argv[5]) == "1";
  const bool run2 = std::string(argv[5]) == "2";

  int failures = 0;

  // Regression 1: external insert after A resolved an empty default graph.
  if (run1) {
    xpod_rdf_backend_v1* a = open(create, config1);
    if (a == nullptr) {
      std::fprintf(stderr, "open failed\n");
      return 3;
    }
    const xpod_rdf_term_key before = lookup_default_graph(a);
    const bool inserted = external_insert_default_graph(argv[2], argv[4]);
    const xpod_rdf_term_key after = lookup_default_graph(a);
    const uint64_t rows = count_graph(a, after);
    const bool ok = inserted && production_terms_resolve(a) && before == 0 && after != 0 && rows == 1;
    std::printf("REGRESSION1 before=%llu after=%llu rows=%llu ok=%d\n",
                static_cast<unsigned long long>(before),
                static_cast<unsigned long long>(after),
                static_cast<unsigned long long>(rows), ok ? 1 : 0);
    if (!ok) ++failures;
    destroy(a);
  }

  // Regression 2: transactional default-graph creation rolled back must not stick.
  if (run2) {
    xpod_rdf_backend_v1* a = open(create, config2);
    if (a == nullptr) {
      std::fprintf(stderr, "open failed\n");
      return 3;
    }
    const xpod_rdf_term_key before = lookup_default_graph(a);
    const xpod_rdf_status begin = a->begin_transaction(a->backend_user_data, nullptr);
    const xpod_rdf_status during = insert_default_graph_quad(a, "urn:xpod:temp");
    const xpod_rdf_status rollback = a->rollback_transaction(a->backend_user_data);
    const xpod_rdf_term_key after_rollback = lookup_default_graph(a);
    const bool inserted = external_insert_default_graph(argv[3], argv[4]);
    const xpod_rdf_term_key after_external = lookup_default_graph(a);
    const uint64_t rows = count_graph(a, after_external);
    const bool ok = inserted && production_terms_resolve(a) && before == 0 && begin == XPOD_RDF_STATUS_OK &&
                    during == XPOD_RDF_STATUS_OK &&
                    rollback == XPOD_RDF_STATUS_OK && after_rollback == 0 &&
                    after_external != 0 && rows == 1;
    std::printf(
        "REGRESSION2 before=%llu after_rollback=%llu after_external=%llu begin=%d during=%d rollback=%d rows=%llu ok=%d\n",
        static_cast<unsigned long long>(before),
        static_cast<unsigned long long>(after_rollback),
        static_cast<unsigned long long>(after_external), static_cast<int>(begin),
        static_cast<int>(during), static_cast<int>(rollback),
        static_cast<unsigned long long>(rows), ok ? 1 : 0);
    if (!ok) ++failures;
    destroy(a);
  }

  return failures == 0 ? 0 : 1;
}
