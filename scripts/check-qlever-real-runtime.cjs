#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function fail(message, error) {
  console.error(`[qlever-real-runtime] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function splitCommand(command) {
  const result = [];
  let token = '';
  let quote = '';
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        result.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (token) result.push(token);
  return result;
}

function addExistingDir(dirs, value, baseDir) {
  if (!value) return;
  const resolved = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
  if (fileExists(resolved) && fs.statSync(resolved).isDirectory()) {
    dirs.add(resolved);
  }
}

function dependencyIncludeDirsFromCompileCommands(compileCommandsPath) {
  if (!fileExists(compileCommandsPath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(compileCommandsPath, 'utf8'));
  const dirs = new Set();
  for (const entry of parsed) {
    const baseDir = entry.directory || path.dirname(compileCommandsPath);
    const tokens = Array.isArray(entry.arguments)
      ? entry.arguments
      : splitCommand(String(entry.command || ''));
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === '-I' || token === '-isystem' || token === '-iquote' || token === '-idirafter') {
        addExistingDir(dirs, tokens[i + 1], baseDir);
        i += 1;
      } else if (token.startsWith('-I') && token.length > 2) {
        addExistingDir(dirs, token.slice(2), baseDir);
      } else if (token.startsWith('-isystem') && token.length > '-isystem'.length) {
        addExistingDir(dirs, token.slice('-isystem'.length), baseDir);
      }
    }
  }
  return [...dirs];
}

function readLinkTokens(linkLinePath) {
  if (!fileExists(linkLinePath)) {
    fail(`missing QLever link line: ${linkLinePath}. Run check:qlever-full-engine first.`);
  }
  const linkLine = fs.readFileSync(linkLinePath, 'utf8').trim();
  const tokens = splitCommand(linkLine);
  if (tokens.length === 0) {
    fail(`empty QLever link line: ${linkLinePath}`);
  }
  const outputIndex = tokens.indexOf('-o');
  if (outputIndex === -1 || outputIndex + 1 >= tokens.length) {
    fail(`unsupported QLever link line shape: ${linkLinePath}`);
  }
  return { compiler: tokens[0], beforeOutput: tokens.slice(1, outputIndex), afterOutput: tokens.slice(outputIndex + 2) };
}

function platformCompileArgsFromLinkLine(linkLinePath) {
  if (!fileExists(linkLinePath)) {
    return [];
  }
  const { beforeOutput } = readLinkTokens(linkLinePath);
  const args = [];
  for (let i = 0; i < beforeOutput.length; i += 1) {
    const token = beforeOutput[i];
    if ((token === '-arch' || token === '-isysroot') && beforeOutput[i + 1]) {
      args.push(token, beforeOutput[i + 1]);
      i += 1;
    }
  }
  return args;
}

function makeCompileArgs(qleverSource, qleverBuildDir, linkLinePath, smokeSourcePath, smokeObjectPath) {
  const dependencyIncludeDirs = dependencyIncludeDirsFromCompileCommands(
    path.join(qleverBuildDir, 'compile_commands.json'),
  );
  const args = [
    ...platformCompileArgsFromLinkLine(linkLinePath),
    '-std=c++20',
    '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
    '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
    '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
    '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
    '-I', path.join(qleverSource, 'src'),
  ];
  for (const dir of dependencyIncludeDirs) {
    args.push('-isystem', dir);
  }
  args.push('-c', smokeSourcePath, '-o', smokeObjectPath);
  return args;
}

function homebrewLlvmCxxRuntimeLinkArgs() {
  if (process.platform !== 'darwin') {
    return [];
  }
  const llvmCxxLib = '/opt/homebrew/opt/llvm/lib/c++';
  const llvmLib = '/opt/homebrew/opt/llvm/lib';
  if (!fileExists(llvmCxxLib)) {
    return [];
  }
  const args = [`-L${llvmCxxLib}`, `-Wl,-rpath,${llvmCxxLib}`, '-lc++'];
  if (fileExists(path.join(llvmLib, 'libunwind.dylib'))) {
    args.push(`-L${llvmLib}`, `-Wl,-rpath,${llvmLib}`, '-lunwind');
  }
  return args;
}

function makeLinkArgs(linkLinePath, smokeObjectPath, smokeBinaryPath, adapterBuildDir) {
  const { beforeOutput, afterOutput } = readLinkTokens(linkLinePath);
  const adapterLib = path.join(adapterBuildDir, 'libxpod_qlever_adapter.a');
  const prefix = beforeOutput.filter((token) => !token.includes('CMakeFiles/qlever-server.dir'));
  const libraries = afterOutput.filter((token) => token !== 'lib/libserver.a');
  return [
    ...prefix,
    smokeObjectPath,
    adapterLib,
    '-o',
    smokeBinaryPath,
    ...libraries,
    ...homebrewLlvmCxxRuntimeLinkArgs(),
  ];
}

function writeSmokeSource(smokeSourcePath) {
  fs.mkdirSync(path.dirname(smokeSourcePath), { recursive: true });
  fs.writeFileSync(smokeSourcePath, String.raw`#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string_view>

#include "xpod_qlever_adapter.h"

struct BackendState {
  int scan_calls = 0;
  int estimate_distinct_calls = 0;
  int text_calls = 0;
  int entity_text_estimate_calls = 0;
  int entity_text_calls = 0;
};

static xpod_rdf_bytes bytes(const char* value) {
  return {value, std::strlen(value)};
}

static xpod_rdf_status get_capabilities(void*, xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG |
      XPOD_RDF_PERM_CAP_SOPG |
      XPOD_RDF_PERM_CAP_PSOG |
      XPOD_RDF_PERM_CAP_POSG |
      XPOD_RDF_PERM_CAP_OSPG |
      XPOD_RDF_PERM_CAP_OPSG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  out_capabilities->max_batch_size = 64;
  out_capabilities->backend_name = bytes("xpod-real-runtime-smoke");
  out_capabilities->backend_version = bytes("1");
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode_qlever_id(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status compare_qlever_ids(void*, uint64_t left, uint64_t right, int32_t* out_compare) {
  *out_compare = left < right ? -1 : (left > right ? 1 : 0);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void*,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = XPOD_RDF_STATUS_OK;
    out_terms[i].kind = XPOD_RDF_TERM_IRI;
    if (keys[i] == 10) {
      out_terms[i].value = bytes("urn:s");
    } else if (keys[i] == 15) {
      out_terms[i].value = bytes("urn:literal-s");
    } else if (keys[i] == 20) {
      out_terms[i].value = bytes("urn:p");
    } else if (keys[i] == 21) {
      out_terms[i].value = bytes("urn:p2");
    } else if (keys[i] == 30) {
      out_terms[i].value = bytes("urn:o");
    } else if (keys[i] == 40) {
      out_terms[i].value = bytes("urn:g");
    } else if (keys[i] == 50) {
      out_terms[i].value = bytes("urn:text");
    } else if (keys[i] == 60) {
      out_terms[i].value = bytes("urn:entity");
    } else if (keys[i] == 70) {
      out_terms[i].value = bytes("urn:tail");
    } else if (keys[i] == 80) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("literal-value");
    } else {
      std::fprintf(stderr, "unexpected term key: %llu\n", static_cast<unsigned long long>(keys[i]));
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(void*, const xpod_rdf_scan_request*, xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 3;
  out_estimate->distinct_subjects = 3;
  out_estimate->distinct_predicates = 2;
  out_estimate->distinct_objects = 3;
  out_estimate->distinct_graphs = 1;
  out_estimate->selectivity = 1.0;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status count_scan(void*, const xpod_rdf_scan_request*, xpod_rdf_count_result* out_result) {
  out_result->count = 3;
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t length = std::strlen(expected);
  return actual.size == length &&
         std::string_view(actual.data, actual.size) == expected;
}


static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t i = 0; i < term_count; ++i) {
    if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:s")) {
      out_keys[i] = 10;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:p")) {
      out_keys[i] = 20;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:p2")) {
      out_keys[i] = 21;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:o")) {
      out_keys[i] = 30;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:g")) {
      out_keys[i] = 40;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:text")) {
      out_keys[i] = 50;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:entity")) {
      out_keys[i] = 60;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:tail")) {
      out_keys[i] = 70;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "literal-value")) {
      out_keys[i] = 80;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else {
      out_keys[i] = 0;
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  if (!bytes_equal(request->query, "topic")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->required_entities_size != 0) {
    if (request->required_entities_size != 1 ||
        request->required_entities[0] != 60) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    ++state->entity_text_estimate_calls;
  }
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->text_calls;
  if (!bytes_equal(request->query, "topic")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->required_entities_size != 0) {
    if (request->required_entities_size != 1 ||
        request->required_entities[0] != 60) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    ++state->entity_text_calls;
  }
  xpod_rdf_candidate row = {};
  row.retrieval_point = 50;
  row.has_retrieval_point = 1;
  row.score = 1.0;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 1;
  batch.scorer = bytes("runtime-text-search");
  return on_batch(callback_user_data, &batch);
}

static bool matches_pattern(const xpod_rdf_quad_pattern& pattern, const xpod_rdf_quad_key& row) {
  return (!pattern.has_subject || pattern.subject == row.subject) &&
         (!pattern.has_predicate || pattern.predicate == row.predicate) &&
         (!pattern.has_object || pattern.object == row.object) &&
         (!pattern.has_graph || pattern.graph == row.graph);
}

static xpod_rdf_status estimate_distinct(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_distinct_calls;
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
  };
  uint64_t matched_count = 0;
  for (const auto& row : rows) {
    if (matches_pattern(request->scan.pattern, row)) {
      ++matched_count;
    }
  }
  out_estimate->rows = matched_count;
  out_estimate->distinct_subjects = matched_count;
  out_estimate->distinct_predicates = matched_count;
  out_estimate->distinct_objects = matched_count;
  out_estimate->distinct_graphs = matched_count == 0 ? 0 : 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
  };
  xpod_rdf_quad_key matched[3] = {};
  size_t matched_count = 0;
  for (const auto& row : rows) {
    if (matches_pattern(request->pattern, row)) {
      matched[matched_count++] = row;
    }
  }
  xpod_rdf_quad_batch batch = {};
  batch.rows = matched;
  batch.row_count = matched_count;
  batch.sorted_slots = request->needed_slots;
  batch.scanned_rows = 2;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state;
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.encode_qlever_id = encode_qlever_id;
  raw_backend.decode_qlever_id = decode_qlever_id;
  raw_backend.compare_qlever_ids = compare_qlever_ids;
  raw_backend.resolve_terms = resolve_terms;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.count_scan = count_scan;
  raw_backend.estimate_distinct = estimate_distinct;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.estimate_text_search = estimate_text_search;
  raw_backend.text_search = text_search;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  raw_backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED;

  xpod_qlever_adapter_config config = {};
  config.backend = &raw_backend;
  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  xpod_qlever_query_request request = {};
  request.sparql = bytes("SELECT * WHERE { ?s ?p ?o }");
  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view json(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "query failed: %.*s\n", static_cast<int>(error.size()), error.data());
    return 2;
  }
  if (state.scan_calls < 1) return 3;
  if (json.find("urn:s") == std::string_view::npos) return 4;
  if (json.find("urn:p") == std::string_view::npos) return 5;
  if (json.find("urn:o") == std::string_view::npos) return 6;
  if (profile.find("xpod-qlever-bridge") == std::string_view::npos) return 7;

  int scans_before_join = state.scan_calls;
  int estimates_before_join = state.estimate_distinct_calls;
  xpod_qlever_query_request join_request = {};
  join_request.sparql = bytes(
      "SELECT ?s ?tail WHERE { ?s ?p ?o . ?o ?p2 ?tail }");
  xpod_qlever_query_result join_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &join_request, &join_result);
  std::string_view join_json(join_result.result_json.data, join_result.result_json.size);
  std::string_view join_profile(join_result.profile_json.data, join_result.profile_json.size);
  std::string_view join_error(join_result.error_message.data, join_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "join query failed: %.*s\n",
                 static_cast<int>(join_error.size()), join_error.data());
    return 16;
  }
  int join_scan_calls = state.scan_calls - scans_before_join;
  int join_estimate_distinct_calls =
      state.estimate_distinct_calls - estimates_before_join;
  if (join_scan_calls < 1) {
    std::fprintf(stderr,
                 "join_scan_calls=%d join_estimate_distinct_calls=%d json=%.*s profile=%.*s\n",
                 join_scan_calls,
                 join_estimate_distinct_calls,
                 static_cast<int>(join_json.size()),
                 join_json.data(),
                 static_cast<int>(join_profile.size()),
                 join_profile.data());
    return 17;
  }
  if (join_json.find("urn:s") == std::string_view::npos) return 18;
  if (join_json.find("urn:tail") == std::string_view::npos) return 19;
  if (join_profile.find("HashJoin") == std::string_view::npos &&
      join_profile.find("Join") == std::string_view::npos) return 20;
  if (join_json.find(R"("head":{"vars":["s","tail"]})") == std::string_view::npos) return 21;
  if (join_estimate_distinct_calls < 1) return 22;
  xpod_qlever_adapter_release_result(adapter, &join_result);

  int scans_before_modifier = state.scan_calls;
  xpod_qlever_query_request modifier_request = {};
  modifier_request.sparql = bytes(
      "SELECT DISTINCT ?s WHERE { ?s ?p ?o } ORDER BY ?s LIMIT 1");
  xpod_qlever_query_result modifier_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &modifier_request, &modifier_result);
  std::string_view modifier_json(
      modifier_result.result_json.data, modifier_result.result_json.size);
  std::string_view modifier_profile(
      modifier_result.profile_json.data, modifier_result.profile_json.size);
  std::string_view modifier_error(
      modifier_result.error_message.data, modifier_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "modifier query failed: %.*s\n",
                 static_cast<int>(modifier_error.size()),
                 modifier_error.data());
    return 23;
  }
  int modifier_scan_calls = state.scan_calls - scans_before_modifier;
  if (modifier_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr,
                 "modifier head mismatch scan_calls=%d json=%.*s profile=%.*s\n",
                 modifier_scan_calls,
                 static_cast<int>(modifier_json.size()),
                 modifier_json.data(),
                 static_cast<int>(modifier_profile.size()),
                 modifier_profile.data());
    return 25;
  }
  if (modifier_json.find("urn:s") == std::string_view::npos) return 26;
  if (modifier_json.find("urn:o") != std::string_view::npos) return 27;
  if (modifier_profile.find("OrderBy") == std::string_view::npos) return 28;
  xpod_qlever_adapter_release_result(adapter, &modifier_result);

  xpod_qlever_query_request bind_request = {};
  bind_request.sparql = bytes(
      "SELECT ?s ?copy WHERE { ?s ?p ?o BIND(?s AS ?copy) } ORDER BY ?s");
  xpod_qlever_query_result bind_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &bind_request, &bind_result);
  std::string_view bind_json(
      bind_result.result_json.data, bind_result.result_json.size);
  std::string_view bind_profile(
      bind_result.profile_json.data, bind_result.profile_json.size);
  std::string_view bind_error(
      bind_result.error_message.data, bind_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "bind query failed: %.*s\n",
                 static_cast<int>(bind_error.size()), bind_error.data());
    return 112;
  }
  if (bind_json.find(R"("head":{"vars":["s","copy"]})") == std::string_view::npos) {
    std::fprintf(stderr, "bind head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_json.size()), bind_json.data(),
                 static_cast<int>(bind_profile.size()), bind_profile.data());
    return 113;
  }
  if (bind_json.find(R"("s":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "bind missing s binding json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_json.size()), bind_json.data(),
                 static_cast<int>(bind_profile.size()), bind_profile.data());
    return 114;
  }
  if (bind_json.find(R"("copy":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "bind missing copied binding json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_json.size()), bind_json.data(),
                 static_cast<int>(bind_profile.size()), bind_profile.data());
    return 115;
  }
  if (bind_profile.find("BIND") == std::string_view::npos) {
    std::fprintf(stderr, "bind missing BIND profile json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_json.size()), bind_json.data(),
                 static_cast<int>(bind_profile.size()), bind_profile.data());
    return 116;
  }
  xpod_qlever_adapter_release_result(adapter, &bind_result);

  xpod_qlever_query_request union_request = {};
  union_request.sparql = bytes(
      "SELECT DISTINCT ?x WHERE { { ?x ?p ?o } UNION { ?s ?p2 ?x } } ORDER BY ?x");
  xpod_qlever_query_result union_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &union_request, &union_result);
  std::string_view union_json(
      union_result.result_json.data, union_result.result_json.size);
  std::string_view union_profile(
      union_result.profile_json.data, union_result.profile_json.size);
  std::string_view union_error(
      union_result.error_message.data, union_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union query failed: %.*s\n",
                 static_cast<int>(union_error.size()), union_error.data());
    return 29;
  }
  if (union_json.find(R"("head":{"vars":["x"]})") == std::string_view::npos) {
    std::fprintf(stderr, "union head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(union_json.size()), union_json.data(),
                 static_cast<int>(union_profile.size()), union_profile.data());
    return 30;
  }
  if (union_json.find("urn:s") == std::string_view::npos) return 31;
  if (union_json.find("urn:o") == std::string_view::npos) return 32;
  if (union_json.find("urn:tail") == std::string_view::npos) return 33;
  if (union_profile.find("Union") == std::string_view::npos) return 34;
  xpod_qlever_adapter_release_result(adapter, &union_result);

  xpod_qlever_query_request optional_request = {};
  optional_request.sparql = bytes(
      "SELECT ?s ?tail WHERE { ?s ?p ?o OPTIONAL { ?o ?p2 ?tail } } ORDER BY ?s LIMIT 1");
  xpod_qlever_query_result optional_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &optional_request, &optional_result);
  std::string_view optional_json(
      optional_result.result_json.data, optional_result.result_json.size);
  std::string_view optional_profile(
      optional_result.profile_json.data, optional_result.profile_json.size);
  std::string_view optional_error(
      optional_result.error_message.data, optional_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional query failed: %.*s\n",
                 static_cast<int>(optional_error.size()), optional_error.data());
    return 35;
  }
  if (optional_json.find(R"("head":{"vars":["s","tail"]})") == std::string_view::npos) {
    std::fprintf(stderr, "optional head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_json.size()), optional_json.data(),
                 static_cast<int>(optional_profile.size()), optional_profile.data());
    return 36;
  }
  if (optional_json.find("urn:s") == std::string_view::npos) return 37;
  if (optional_json.find("urn:tail") == std::string_view::npos) return 38;
  if (optional_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "optional leaked non-limited row json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_json.size()), optional_json.data(),
                 static_cast<int>(optional_profile.size()), optional_profile.data());
    return 39;
  }
  if (optional_profile.find("OptionalJoin") == std::string_view::npos) return 40;
  if (optional_profile.find("LimitOffset") == std::string_view::npos) return 46;
  xpod_qlever_adapter_release_result(adapter, &optional_result);

  xpod_qlever_query_request minus_request = {};
  minus_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o MINUS { ?s <urn:p2> ?tail } }");
  xpod_qlever_query_result minus_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &minus_request, &minus_result);
  std::string_view minus_json(
      minus_result.result_json.data, minus_result.result_json.size);
  std::string_view minus_profile(
      minus_result.profile_json.data, minus_result.profile_json.size);
  std::string_view minus_error(
      minus_result.error_message.data, minus_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "minus query failed: %.*s\n",
                 static_cast<int>(minus_error.size()), minus_error.data());
    return 41;
  }
  if (minus_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "minus head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(minus_json.size()), minus_json.data(),
                 static_cast<int>(minus_profile.size()), minus_profile.data());
    return 42;
  }
  if (minus_json.find("urn:s") == std::string_view::npos) return 43;
  if (minus_json.find("urn:o") != std::string_view::npos) return 44;
  if (minus_profile.find("Minus") == std::string_view::npos) return 45;
  xpod_qlever_adapter_release_result(adapter, &minus_result);

  xpod_qlever_query_request values_request = {};
  values_request.sparql = bytes(
      "SELECT ?s WHERE { VALUES ?s { <urn:s> <urn:o> } ?s ?p ?o } ORDER BY ?s");
  xpod_qlever_query_result values_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &values_request, &values_result);
  std::string_view values_json(
      values_result.result_json.data, values_result.result_json.size);
  std::string_view values_profile(
      values_result.profile_json.data, values_result.profile_json.size);
  std::string_view values_error(
      values_result.error_message.data, values_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "values query failed: %.*s\n",
                 static_cast<int>(values_error.size()), values_error.data());
    return 47;
  }
  if (values_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "values head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 48;
  }
  if (values_json.find("urn:s") == std::string_view::npos) return 49;
  if (values_json.find("urn:o") == std::string_view::npos) return 50;
  if (values_json.find("urn:tail") != std::string_view::npos) return 51;
  if (values_profile.find("Values") == std::string_view::npos) return 52;
  if (values_profile.find("OrderBy") == std::string_view::npos) return 53;
  xpod_qlever_adapter_release_result(adapter, &values_result);

  xpod_qlever_query_request filter_request = {};
  filter_request.sparql = bytes(
      "SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o != <urn:tail>) } ORDER BY ?s");
  xpod_qlever_query_result filter_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &filter_request, &filter_result);
  std::string_view filter_json(
      filter_result.result_json.data, filter_result.result_json.size);
  std::string_view filter_profile(
      filter_result.profile_json.data, filter_result.profile_json.size);
  std::string_view filter_error(
      filter_result.error_message.data, filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "filter query failed: %.*s\n",
                 static_cast<int>(filter_error.size()), filter_error.data());
    return 54;
  }
  if (filter_json.find(R"("head":{"vars":["s","o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(filter_json.size()), filter_json.data(),
                 static_cast<int>(filter_profile.size()), filter_profile.data());
    return 55;
  }
  if (filter_json.find("urn:s") == std::string_view::npos) return 56;
  if (filter_json.find("urn:o") == std::string_view::npos) return 57;
  if (filter_json.find("urn:tail") != std::string_view::npos) return 58;
  if (filter_profile.find("Filter") == std::string_view::npos) return 59;
  if (filter_profile.find("OrderBy") == std::string_view::npos) return 60;
  xpod_qlever_adapter_release_result(adapter, &filter_result);

  xpod_qlever_query_request equal_filter_request = {};
  equal_filter_request.sparql = bytes(
      "SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = <urn:o>) } ORDER BY ?s");
  xpod_qlever_query_result equal_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &equal_filter_request, &equal_filter_result);
  std::string_view equal_filter_json(
      equal_filter_result.result_json.data, equal_filter_result.result_json.size);
  std::string_view equal_filter_profile(
      equal_filter_result.profile_json.data, equal_filter_result.profile_json.size);
  std::string_view equal_filter_error(
      equal_filter_result.error_message.data, equal_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "equal filter query failed: %.*s\n",
                 static_cast<int>(equal_filter_error.size()),
                 equal_filter_error.data());
    return 65;
  }
  if (equal_filter_json.find(R"("head":{"vars":["s","o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "equal filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(equal_filter_json.size()),
                 equal_filter_json.data(),
                 static_cast<int>(equal_filter_profile.size()),
                 equal_filter_profile.data());
    return 66;
  }
  if (equal_filter_json.find("urn:s") == std::string_view::npos) return 67;
  if (equal_filter_json.find("urn:o") == std::string_view::npos) return 68;
  if (equal_filter_json.find("urn:tail") != std::string_view::npos) return 69;
  if (equal_filter_profile.find("Filter") == std::string_view::npos) return 70;
  if (equal_filter_profile.find("OrderBy") == std::string_view::npos) return 71;
  xpod_qlever_adapter_release_result(adapter, &equal_filter_result);

  xpod_qlever_query_request filtered_projection_request = {};
  filtered_projection_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(?o = <urn:o>) } ORDER BY ?s");
  xpod_qlever_query_result filtered_projection_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &filtered_projection_request, &filtered_projection_result);
  std::string_view filtered_projection_json(
      filtered_projection_result.result_json.data,
      filtered_projection_result.result_json.size);
  std::string_view filtered_projection_profile(
      filtered_projection_result.profile_json.data,
      filtered_projection_result.profile_json.size);
  std::string_view filtered_projection_error(
      filtered_projection_result.error_message.data,
      filtered_projection_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "filtered projection query failed: %.*s\n",
                 static_cast<int>(filtered_projection_error.size()),
                 filtered_projection_error.data());
    return 86;
  }
  if (filtered_projection_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "filtered projection head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(filtered_projection_json.size()),
                 filtered_projection_json.data(),
                 static_cast<int>(filtered_projection_profile.size()),
                 filtered_projection_profile.data());
    return 87;
  }
  if (filtered_projection_json.find("urn:s") == std::string_view::npos) return 88;
  if (filtered_projection_json.find("urn:o") != std::string_view::npos) return 89;
  if (filtered_projection_json.find("urn:tail") != std::string_view::npos) return 90;
  if (filtered_projection_profile.find("Filter") == std::string_view::npos) return 91;
  xpod_qlever_adapter_release_result(adapter, &filtered_projection_result);

  xpod_qlever_query_request literal_filter_request = {};
  literal_filter_request.sparql = bytes(
      "SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = \"literal-value\") } ORDER BY ?s");
  xpod_qlever_query_result literal_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_filter_request, &literal_filter_result);
  std::string_view literal_filter_json(
      literal_filter_result.result_json.data, literal_filter_result.result_json.size);
  std::string_view literal_filter_profile(
      literal_filter_result.profile_json.data, literal_filter_result.profile_json.size);
  std::string_view literal_filter_error(
      literal_filter_result.error_message.data, literal_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal filter query failed: %.*s\n",
                 static_cast<int>(literal_filter_error.size()),
                 literal_filter_error.data());
    return 72;
  }
  if (literal_filter_json.find(R"("head":{"vars":["s","o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "literal filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_filter_json.size()),
                 literal_filter_json.data(),
                 static_cast<int>(literal_filter_profile.size()),
                 literal_filter_profile.data());
    return 73;
  }
  if (literal_filter_json.find("urn:literal-s") == std::string_view::npos) return 74;
  if (literal_filter_json.find("literal-value") == std::string_view::npos) return 75;
  if (literal_filter_json.find("urn:tail") != std::string_view::npos) return 76;
  if (literal_filter_profile.find("Filter") == std::string_view::npos) return 77;
  if (literal_filter_profile.find("OrderBy") == std::string_view::npos) return 78;
  xpod_qlever_adapter_release_result(adapter, &literal_filter_result);

  xpod_qlever_query_request literal_left_filter_request = {};
  literal_left_filter_request.sparql = bytes(
      "SELECT ?s ?o WHERE { ?s ?p ?o FILTER(\"literal-value\" = ?o) } ORDER BY ?s");
  xpod_qlever_query_result literal_left_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_left_filter_request, &literal_left_filter_result);
  std::string_view literal_left_filter_json(
      literal_left_filter_result.result_json.data, literal_left_filter_result.result_json.size);
  std::string_view literal_left_filter_profile(
      literal_left_filter_result.profile_json.data, literal_left_filter_result.profile_json.size);
  std::string_view literal_left_filter_error(
      literal_left_filter_result.error_message.data, literal_left_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal-left filter query failed: %.*s\n",
                 static_cast<int>(literal_left_filter_error.size()),
                 literal_left_filter_error.data());
    return 79;
  }
  if (literal_left_filter_json.find(R"("head":{"vars":["s","o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "literal-left filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_left_filter_json.size()),
                 literal_left_filter_json.data(),
                 static_cast<int>(literal_left_filter_profile.size()),
                 literal_left_filter_profile.data());
    return 80;
  }
  if (literal_left_filter_json.find("urn:literal-s") == std::string_view::npos) return 81;
  if (literal_left_filter_json.find("literal-value") == std::string_view::npos) return 82;
  if (literal_left_filter_json.find("urn:tail") != std::string_view::npos) return 83;
  if (literal_left_filter_profile.find("Filter") == std::string_view::npos) return 84;
  if (literal_left_filter_profile.find("OrderBy") == std::string_view::npos) return 85;
  xpod_qlever_adapter_release_result(adapter, &literal_left_filter_result);

  xpod_qlever_query_request ask_request = {};
  ask_request.sparql = bytes("ASK { ?s ?p ?o }");
  xpod_qlever_query_result ask_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &ask_request, &ask_result);
  std::string_view ask_json(
      ask_result.result_json.data, ask_result.result_json.size);
  std::string_view ask_profile(
      ask_result.profile_json.data, ask_result.profile_json.size);
  std::string_view ask_error(
      ask_result.error_message.data, ask_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "ask query failed: %.*s\n",
                 static_cast<int>(ask_error.size()), ask_error.data());
    return 61;
  }
  if (ask_json.find(R"("boolean":true)") == std::string_view::npos) {
    std::fprintf(stderr, "ask boolean mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(ask_json.size()), ask_json.data(),
                 static_cast<int>(ask_profile.size()), ask_profile.data());
    return 62;
  }
  if (ask_profile.find("Ask") == std::string_view::npos) return 63;
  if (ask_profile.find("PermutationScan") == std::string_view::npos) return 64;
  xpod_qlever_adapter_release_result(adapter, &ask_result);

  xpod_qlever_adapter_release_result(adapter, &result);
  xpod_qlever_query_request text_request = {};
  text_request.sparql = bytes("SELECT * WHERE { ?text ql:contains-word \"topic\" }");
  xpod_qlever_query_result text_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &text_request, &text_result);
  std::string_view text_json(text_result.result_json.data, text_result.result_json.size);
  std::string_view text_profile(text_result.profile_json.data, text_result.profile_json.size);
  std::string_view text_error(text_result.error_message.data, text_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "text query failed: %.*s\n",
                 static_cast<int>(text_error.size()), text_error.data());
    return 8;
  }
  if (state.text_calls < 1) return 9;
  if (text_json.find("urn:text") == std::string_view::npos) return 10;
  if (text_profile.find("TextSearch") == std::string_view::npos) return 11;
  xpod_qlever_adapter_release_result(adapter, &text_result);

  xpod_qlever_query_request entity_text_request = {};
  entity_text_request.sparql = bytes(
      "SELECT * WHERE { ?text ql:contains-word \"topic\" . "
      "?text ql:contains-entity <urn:entity> }");
  xpod_qlever_query_result entity_text_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &entity_text_request, &entity_text_result);
  std::string_view entity_text_json(
      entity_text_result.result_json.data, entity_text_result.result_json.size);
  std::string_view entity_text_error(
      entity_text_result.error_message.data,
      entity_text_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "entity text query failed: %.*s\n",
                 static_cast<int>(entity_text_error.size()),
                 entity_text_error.data());
    return 12;
  }
  if (state.entity_text_calls < 1) return 13;
  if (state.entity_text_estimate_calls < 1) return 14;
  if (entity_text_json.find("urn:text") == std::string_view::npos) return 15;
  xpod_qlever_adapter_release_result(adapter, &entity_text_result);

  xpod_qlever_query_request count_request = {};
  count_request.sparql = bytes(
      "SELECT ?p (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?p ORDER BY ?p");
  xpod_qlever_query_result count_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &count_request, &count_result);
  std::string_view count_json(
      count_result.result_json.data, count_result.result_json.size);
  std::string_view count_profile(
      count_result.profile_json.data, count_result.profile_json.size);
  std::string_view count_error(
      count_result.error_message.data, count_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "count query failed: %.*s\n",
                 static_cast<int>(count_error.size()), count_error.data());
    return 92;
  }
  if (count_json.find(R"("head":{"vars":["p","count"]})") == std::string_view::npos) {
    std::fprintf(stderr, "count head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 93;
  }
  if (count_json.find("urn:p") == std::string_view::npos) {
    std::fprintf(stderr, "count missing urn:p json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 94;
  }
  if (count_json.find("urn:p2") == std::string_view::npos) {
    std::fprintf(stderr, "count missing urn:p2 json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 95;
  }
  if (count_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "count missing value 2 json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 96;
  }
  if (count_json.find(R"("value":"1")") == std::string_view::npos) {
    std::fprintf(stderr, "count missing value 1 json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 97;
  }
  if (count_json.find("http://www.w3.org/2001/XMLSchema#integer") == std::string_view::npos) {
    std::fprintf(stderr, "count missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 98;
  }
  if (count_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "count missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(count_json.size()), count_json.data(),
                 static_cast<int>(count_profile.size()), count_profile.data());
    return 99;
  }
  xpod_qlever_adapter_release_result(adapter, &count_result);

  xpod_qlever_query_request having_count_request = {};
  having_count_request.sparql = bytes(
      "SELECT ?p (COUNT(?o) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?p HAVING(COUNT(?o) > 1) ORDER BY ?p");
  xpod_qlever_query_result having_count_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &having_count_request, &having_count_result);
  std::string_view having_count_json(
      having_count_result.result_json.data,
      having_count_result.result_json.size);
  std::string_view having_count_profile(
      having_count_result.profile_json.data,
      having_count_result.profile_json.size);
  std::string_view having_count_error(
      having_count_result.error_message.data,
      having_count_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "having count query failed: %.*s\n",
                 static_cast<int>(having_count_error.size()),
                 having_count_error.data());
    return 105;
  }
  if (having_count_json.find(R"("head":{"vars":["p","count"]})") == std::string_view::npos) {
    std::fprintf(stderr, "having count head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 106;
  }
  if (having_count_json.find("urn:p") == std::string_view::npos) {
    std::fprintf(stderr, "having count missing urn:p json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 107;
  }
  if (having_count_json.find("urn:p2") != std::string_view::npos) {
    std::fprintf(stderr, "having count leaked urn:p2 json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 108;
  }
  if (having_count_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "having count missing value 2 json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 109;
  }
  if (having_count_json.find("http://www.w3.org/2001/XMLSchema#integer") == std::string_view::npos) {
    std::fprintf(stderr, "having count missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 110;
  }
  if (having_count_profile.find("Filter") == std::string_view::npos ||
      having_count_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "having count missing Filter/GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 111;
  }
  xpod_qlever_adapter_release_result(adapter, &having_count_result);

  xpod_qlever_query_request scalar_count_request = {};
  scalar_count_request.sparql = bytes(
      "SELECT (COUNT(?s) AS ?count) WHERE { ?s ?p ?o }");
  xpod_qlever_query_result scalar_count_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &scalar_count_request, &scalar_count_result);
  std::string_view scalar_count_json(
      scalar_count_result.result_json.data,
      scalar_count_result.result_json.size);
  std::string_view scalar_count_profile(
      scalar_count_result.profile_json.data,
      scalar_count_result.profile_json.size);
  std::string_view scalar_count_error(
      scalar_count_result.error_message.data,
      scalar_count_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "scalar count query failed: %.*s\n",
                 static_cast<int>(scalar_count_error.size()),
                 scalar_count_error.data());
    return 100;
  }
  if (scalar_count_json.find(R"("head":{"vars":["count"]})") == std::string_view::npos) {
    std::fprintf(stderr, "scalar count head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(scalar_count_json.size()),
                 scalar_count_json.data(),
                 static_cast<int>(scalar_count_profile.size()),
                 scalar_count_profile.data());
    return 101;
  }
  if (scalar_count_json.find(R"("value":"3")") == std::string_view::npos) {
    std::fprintf(stderr, "scalar count missing value 3 json=%.*s profile=%.*s\n",
                 static_cast<int>(scalar_count_json.size()),
                 scalar_count_json.data(),
                 static_cast<int>(scalar_count_profile.size()),
                 scalar_count_profile.data());
    return 102;
  }
  if (scalar_count_json.find("http://www.w3.org/2001/XMLSchema#integer") == std::string_view::npos) {
    std::fprintf(stderr, "scalar count missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(scalar_count_json.size()),
                 scalar_count_json.data(),
                 static_cast<int>(scalar_count_profile.size()),
                 scalar_count_profile.data());
    return 103;
  }
  if (scalar_count_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "scalar count missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(scalar_count_json.size()),
                 scalar_count_json.data(),
                 static_cast<int>(scalar_count_profile.size()),
                 scalar_count_profile.data());
    return 104;
  }
  xpod_qlever_adapter_release_result(adapter, &scalar_count_result);
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');
}

const sourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
if (!sourceInput) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}

const qleverSource = path.resolve(sourceInput);
const qleverBuildDir = path.resolve(
  readArg('--qlever-build-dir') || process.env.XPOD_QLEVER_FULL_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-full-build'),
);
const adapterBuildDir = path.resolve(
  readArg('--adapter-build-dir') || process.env.XPOD_QLEVER_REAL_ADAPTER_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
);
const runtimeBuildDir = path.resolve(
  readArg('--runtime-build-dir') || process.env.XPOD_QLEVER_REAL_RUNTIME_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-real-runtime-build'),
);
const jobs = readArg('--jobs') || process.env.XPOD_QLEVER_FULL_ENGINE_JOBS || '2';
const dryRun = hasFlag('--dry-run');
const json = hasFlag('--json');
const configureOnly = hasFlag('--configure-only');
const buildOnly = hasFlag('--build-only');
const skipPrerequisites = hasFlag('--skip-prerequisites');

const smokeSourcePath = path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke.cpp');
const smokeObjectPath = path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke.o');
const smokeBinaryPath = path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke');
const linkLinePath = path.join(qleverBuildDir, 'CMakeFiles/qlever-server.dir/link.txt');
const compiler = fileExists(linkLinePath) ? readLinkTokens(linkLinePath).compiler : 'c++';

const fullEngineArgs = [
  'scripts/check-qlever-full-engine-build.cjs',
  '--qlever-source', qleverSource,
  '--build-dir', qleverBuildDir,
  '--target', 'engine',
  '--jobs', jobs,
];
const realAdapterArgs = [
  'scripts/check-qlever-real-adapter-build.cjs',
  '--qlever-source', qleverSource,
  '--qlever-build-dir', qleverBuildDir,
  '--adapter-build-dir', adapterBuildDir,
  '--jobs', jobs,
];
const libraryBuildArgs = [
  '--build', qleverBuildDir,
  '--target', 'parser', 'qlever', 'SortPerformanceEstimator', 'compilationInfo',
  `-j${jobs}`,
];
const compileArgs = makeCompileArgs(qleverSource, qleverBuildDir, linkLinePath, smokeSourcePath, smokeObjectPath);
const linkArgs = fileExists(linkLinePath)
  ? makeLinkArgs(linkLinePath, smokeObjectPath, smokeBinaryPath, adapterBuildDir)
  : [smokeObjectPath, path.join(adapterBuildDir, 'libxpod_qlever_adapter.a'), '-o', smokeBinaryPath];
const runArgs = [smokeBinaryPath];

if (dryRun) {
  const payload = {
    fullEngineArgs,
    realAdapterArgs,
    libraryBuildArgs,
    smokeSourcePath,
    smokeObjectPath,
    smokeBinaryPath,
    compileArgs,
    linkLinePath,
    linkArgs,
    runArgs,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log('[qlever-real-runtime] full engine:', [process.execPath, ...fullEngineArgs].join(' '));
    console.log('[qlever-real-runtime] real adapter:', [process.execPath, ...realAdapterArgs].join(' '));
    console.log('[qlever-real-runtime] libraries:', ['cmake', ...libraryBuildArgs].join(' '));
    console.log('[qlever-real-runtime] compile:', [compiler, ...compileArgs].join(' '));
    console.log('[qlever-real-runtime] link:', [compiler, ...linkArgs].join(' '));
    console.log('[qlever-real-runtime] run:', runArgs.join(' '));
  }
  process.exit(0);
}

if (!fileExists(qleverSource)) {
  fail(`QLever source tree does not exist: ${qleverSource}`);
}

try {
  if (!skipPrerequisites && !buildOnly) {
    execFileSync(process.execPath, fullEngineArgs, { cwd: repoRoot, stdio: 'inherit' });
    execFileSync('cmake', libraryBuildArgs, { cwd: repoRoot, stdio: 'inherit' });
    execFileSync(process.execPath, realAdapterArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
  writeSmokeSource(smokeSourcePath);
  fs.mkdirSync(runtimeBuildDir, { recursive: true });
  if (!configureOnly) {
    execFileSync(compiler, compileArgs, { cwd: qleverBuildDir, stdio: 'inherit' });
    execFileSync(compiler, makeLinkArgs(linkLinePath, smokeObjectPath, smokeBinaryPath, adapterBuildDir), {
      cwd: qleverBuildDir,
      stdio: 'inherit',
    });
    execFileSync(smokeBinaryPath, [], { cwd: runtimeBuildDir, stdio: 'inherit' });
  }
} catch (error) {
  fail('real upstream QLever runtime smoke failed', error);
}

console.log(`[qlever-real-runtime] OK: ran ${smokeBinaryPath}`);
