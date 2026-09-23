// Native smoke harness for the standalone RDF SQLite backend plugin.
//
// Loads the plugin at runtime through the documented C ABI and checks the two
// contracts the source-level tests only assert statically:
//
//   1. the writable provider is rollback-only staging: `apply_mutation`
//      reports applied rows but persists nothing on its own, and an explicit
//      `commit_transaction` refuses with UNSUPPORTED after rolling back;
//   2. the read path serves an existing owner-facts database: seeded rows are
//      resolved back to their terms and counted through a permutation scan.
//
//   cc -o smoke qlever/tests/xpod_rdf_sqlite_plugin_smoke.c -ldl
//   smoke <libxpod_rdf_sqlite_backend> <facts-database> [seeded-database]

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "xpod_rdf_physical_backend.h"
#include "xpod_rdf_sqlite_backend.h"

static int failures = 0;

static void check(int condition, const char* label) {
  if (condition) {
    printf("ok   %s\n", label);
  } else {
    printf("FAIL %s\n", label);
    failures += 1;
  }
}

static xpod_rdf_bytes bytes(const char* value) {
  xpod_rdf_bytes out = { value, strlen(value) };
  return out;
}

static int bytes_equal(xpod_rdf_bytes left, const char* right) {
  const size_t length = strlen(right);
  return left.size == length && left.data != NULL && memcmp(left.data, right, length) == 0;
}

/* Counts the rows the plugin left behind, through the sqlite3 CLI. */
static void row_counts(const char* database, long* terms, long* quads) {
  char command[512];
  snprintf(command, sizeof(command),
           "sqlite3 %s \"SELECT (SELECT COUNT(*) FROM rdf_terms) || ' ' || (SELECT COUNT(*) FROM rdf_quads)\" 2>/dev/null",
           database);
  *terms = -1;
  *quads = -1;
  FILE* pipe = popen(command, "r");
  if (pipe == NULL) return;
  char line[128] = { 0 };
  if (fgets(line, sizeof(line), pipe) != NULL) {
    sscanf(line, "%ld %ld", terms, quads);
  }
  pclose(pipe);
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <libxpod_rdf_sqlite_backend> <facts-database> [seeded-database]\n", argv[0]);
    return 64;
  }
  void* library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (library == NULL) {
    fprintf(stderr, "dlopen failed: %s\n", dlerror());
    return 65;
  }
  xpod_rdf_sqlite_backend_create_fn create =
      (xpod_rdf_sqlite_backend_create_fn)dlsym(library, "xpod_rdf_sqlite_backend_create");
  xpod_rdf_sqlite_backend_destroy_fn destroy =
      (xpod_rdf_sqlite_backend_destroy_fn)dlsym(library, "xpod_rdf_sqlite_backend_destroy");
  xpod_qlever_backend_provider_create_fn provider_create =
      (xpod_qlever_backend_provider_create_fn)dlsym(library, "xpod_qlever_backend_provider_create");
  xpod_qlever_backend_provider_destroy_fn provider_destroy =
      (xpod_qlever_backend_provider_destroy_fn)dlsym(library, "xpod_qlever_backend_provider_destroy");
  check(create != NULL && destroy != NULL && provider_create != NULL && provider_destroy != NULL,
        "exports the documented C ABI entrypoints");
  if (create == NULL || destroy == NULL || provider_create == NULL) {
    return 66;
  }

  const char* database = argv[2];
  char config[512];
  snprintf(config, sizeof(config), "{\"databasePath\":\"%s\"}", database);
  xpod_rdf_backend_v1* provider_backend = NULL;
  const xpod_rdf_bytes config_bytes = { config, strlen(config) };
  const xpod_rdf_status provider_status = provider_create(&config_bytes, &provider_backend);
  check(provider_status == XPOD_RDF_STATUS_OK && provider_backend != NULL,
        "provider creates a backend from JSON config");
  if (provider_backend != NULL) {
    check(provider_backend->abi_version == XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION,
          "provider reports the protocol ABI version");
    check(provider_backend->struct_size == sizeof(xpod_rdf_backend_v1),
          "provider reports the full v1 struct size");
    xpod_rdf_backend_capabilities capabilities = { 0 };
    check(provider_backend->get_capabilities != NULL &&
              provider_backend->get_capabilities(provider_backend->backend_user_data, &capabilities) == XPOD_RDF_STATUS_OK,
          "capabilities are reported");
    printf("     backend=%.*s version=%.*s permutations=%u\n",
           (int)capabilities.backend_name.size, capabilities.backend_name.data,
           (int)capabilities.backend_version.size, capabilities.backend_version.data,
           capabilities.supported_permutations);
    provider_destroy(provider_backend);
  }

  xpod_rdf_term subject = { XPOD_RDF_TERM_IRI, { NULL, 0 }, { NULL, 0 }, { NULL, 0 } };
  subject.value = bytes("https://pod.example/alice/.data/chat/x/2026/09/23/messages.ttl#msg_1");
  xpod_rdf_term predicate = { XPOD_RDF_TERM_IRI, { NULL, 0 }, { NULL, 0 }, { NULL, 0 } };
  predicate.value = bytes("http://rdfs.org/sioc/ns#content");
  xpod_rdf_term object = { XPOD_RDF_TERM_LITERAL, { NULL, 0 }, { NULL, 0 }, { NULL, 0 } };
  object.value = bytes("hello from the sqlite plugin");
  xpod_rdf_quad quad = { subject, predicate, object, { 0 }, 0 };

  /* 1. Rollback-only staging. */
  xpod_rdf_sqlite_backend_config writable_config = { 0 };
  writable_config.database_path = bytes(database);
  xpod_rdf_backend_v1* writable = NULL;
  check(create(&writable_config, &writable) == XPOD_RDF_STATUS_OK && writable != NULL,
        "opens a writable backend over an existing facts schema");
  if (writable != NULL) {
    long terms_before = 0;
    long quads_before = 0;
    row_counts(database, &terms_before, &quads_before);

    xpod_rdf_quad_mutation insert = { XPOD_RDF_MUTATION_INSERT, quad };
    xpod_rdf_mutation_request insert_request = { 0 };
    insert_request.mutations = &insert;
    insert_request.mutation_count = 1;
    xpod_rdf_mutation_result insert_result = { 0 };
    const xpod_rdf_status insert_status =
        writable->apply_mutation(writable->backend_user_data, &insert_request, &insert_result);

    long terms_after = 0;
    long quads_after = 0;
    row_counts(database, &terms_after, &quads_after);
    printf("     apply_mutation status=%d inserted=%llu rows %ld/%ld -> %ld/%ld\n",
           (int)insert_status, (unsigned long long)insert_result.inserted_count,
           terms_before, quads_before, terms_after, quads_after);
    check(insert_status == XPOD_RDF_STATUS_OK && insert_result.inserted_count == 1,
          "apply_mutation stages the quad and reports it applied");
    check(terms_after == terms_before && quads_after == quads_before,
          "apply_mutation alone persists nothing (rollback-only staging)");

    check(writable->begin_transaction != NULL &&
              writable->begin_transaction(writable->backend_user_data, NULL) == XPOD_RDF_STATUS_OK,
          "an explicit transaction opens");
    const xpod_rdf_status commit_status = writable->commit_transaction(writable->backend_user_data);
    check(commit_status == XPOD_RDF_STATUS_UNSUPPORTED,
          "commit_transaction refuses with UNSUPPORTED instead of confirming a write");
    destroy(writable);
  }

  /* 2. Read path over seeded rows, which is what the runtime actually consumes. */
  const char* seeded_database = argc >= 4 ? argv[3] : NULL;
  if (seeded_database != NULL) {
    xpod_rdf_sqlite_backend_config read_config = { 0 };
    read_config.database_path = bytes(seeded_database);
    read_config.read_only = 1;
    xpod_rdf_backend_v1* reader = NULL;
    check(create(&read_config, &reader) == XPOD_RDF_STATUS_OK && reader != NULL,
          "opens a read-only backend over a seeded facts database");
    if (reader != NULL) {
      xpod_rdf_term_key subject_key = 0;
      const xpod_rdf_status lookup_status = reader->lookup_term(reader->backend_user_data, &subject, NULL, &subject_key);
      check(lookup_status == XPOD_RDF_STATUS_OK && subject_key != 0,
            "looks up a seeded subject term");

      xpod_rdf_term resolved = { 0 };
      check(subject_key != 0 &&
                reader->resolve_term(reader->backend_user_data, subject_key, NULL, &resolved) == XPOD_RDF_STATUS_OK &&
                resolved.kind == XPOD_RDF_TERM_IRI && bytes_equal(resolved.value, subject.value.data),
            "resolves the term key back to the original IRI");

      xpod_rdf_quad_pattern pattern = { 0 };
      pattern.has_subject = 1;
      pattern.subject = subject_key;
      xpod_rdf_scan_request scan_request = { 0 };
      scan_request.permutation = XPOD_RDF_PERM_SPOG;
      scan_request.pattern = pattern;
      xpod_rdf_count_result count_result = { 0 };
      check(reader->count_scan(reader->backend_user_data, &scan_request, &count_result) == XPOD_RDF_STATUS_OK &&
                count_result.count >= 1,
            "counts the seeded quad through a SPOG permutation scan");
      destroy(reader);
    }
  }

  dlclose(library);
  printf("%s\n", failures == 0 ? "PLUGIN SMOKE PASSED" : "PLUGIN SMOKE FAILED");
  return failures == 0 ? 0 : 1;
}
