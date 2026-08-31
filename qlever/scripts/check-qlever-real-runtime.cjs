#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function fail(message, error) {
  console.error(`[qlever-real-runtime] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (typeof error === 'object') {
      const status = 'status' in error ? error.status : undefined;
      const signal = 'signal' in error ? error.signal : undefined;
      if (status !== undefined || signal !== undefined) {
        console.error(
          `[qlever-real-runtime] child status=${String(status)} signal=${String(signal)}`,
        );
      }
    }
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

function readArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
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
    '-I', path.join(repoRoot, 'rdf_protocol/include'),
    '-I', path.join(repoRoot, 'qlever_adapter/include'),
    '-I', path.join(repoRoot, 'qlever_adapter/src'),
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

function qleverBuildDirFromLinkLine(linkLinePath) {
  return path.resolve(path.dirname(linkLinePath), '..', '..');
}

function resolveLinkSearchDir(value, linkLinePath) {
  return path.isAbsolute(value)
    ? value
    : path.resolve(qleverBuildDirFromLinkLine(linkLinePath), value);
}

function linkSearchDirs(tokens, linkLinePath) {
  const dirs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-L' && tokens[i + 1]) {
      dirs.push(resolveLinkSearchDir(tokens[i + 1], linkLinePath));
      i += 1;
    } else if (token.startsWith('-L') && token.length > 2) {
      dirs.push(resolveLinkSearchDir(token.slice(2), linkLinePath));
    }
  }
  return dirs;
}

function hasJemallocLibrary(searchDirs) {
  return searchDirs.some((dir) => [
    'libjemalloc.a',
    'libjemalloc.dylib',
    'libjemalloc.so',
  ].some((file) => fileExists(path.join(dir, file))));
}

function filterUnavailableJemalloc(tokens, linkLinePath) {
  const searchDirs = linkSearchDirs(tokens, linkLinePath);
  if (searchDirs.length === 0 || hasJemallocLibrary(searchDirs)) {
    return tokens;
  }
  return tokens.filter((token) => token !== '-ljemalloc');
}

function makeLinkArgs(linkLinePath, smokeObjectPath, smokeBinaryPath, adapterBuildDir) {
  const { beforeOutput, afterOutput } = readLinkTokens(linkLinePath);
  const adapterLib = path.join(adapterBuildDir, 'libxpod_qlever_adapter.a');
  const prefix = beforeOutput.filter((token) => !token.includes('CMakeFiles/qlever-server.dir'));
  const libraries = filterUnavailableJemalloc(
    afterOutput.filter((token) => token !== 'lib/libserver.a'),
    linkLinePath,
  );
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

function makeSmokePlan(
  qleverSource,
  qleverBuildDir,
  linkLinePath,
  smokeSourcePath,
  smokeObjectPath,
  smokeBinaryPath,
  adapterBuildDir,
) {
  const compiler = fileExists(linkLinePath) ? readLinkTokens(linkLinePath).compiler : 'c++';
  const linkArgs = fileExists(linkLinePath)
    ? makeLinkArgs(linkLinePath, smokeObjectPath, smokeBinaryPath, adapterBuildDir)
    : [smokeObjectPath, path.join(adapterBuildDir, 'libxpod_qlever_adapter.a'), '-o', smokeBinaryPath];
  return {
    compiler,
    compileArgs: makeCompileArgs(
      qleverSource,
      qleverBuildDir,
      linkLinePath,
      smokeSourcePath,
      smokeObjectPath,
    ),
    linkArgs,
  };
}

function writeSmokeSource(smokeSourcePath, relationalShapesOnly) {
  fs.mkdirSync(path.dirname(smokeSourcePath), { recursive: true });
  fs.writeFileSync(smokeSourcePath, String.raw`#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string_view>

#include "global/Id.h"
#include "xpod_qlever_adapter.h"

static constexpr bool kRelationalShapesOnly = ${relationalShapesOnly ? 'true' : 'false'};

struct BackendState {
  int scan_calls = 0;
  int distinct_scan_calls = 0;
  int estimate_distinct_calls = 0;
  int exact_graph_scope_scans = 0;
  int default_graph_scope_scans = 0;
  int text_calls = 0;
  int entity_text_estimate_calls = 0;
  int entity_text_calls = 0;
  int block_metadata_calls = 0;
  int mutation_calls = 0;
  bool inserted_row = false;
  bool inserted_literal_row = false;
  bool inserted_graph_row = false;
  bool inserted_bind_row = false;
  bool inserted_iri_bind_row = false;
  bool inserted_str_bind_row = false;
  bool inserted_optional_tail_row = false;
  bool inserted_blank_row = false;
  bool inserted_blank_link_row = false;
  bool deleted_base_row = false;
  bool modified_row = false;
  bool modified_graph_row = false;
  bool modified_with_graph_row = false;
  bool using_rows_enabled = false;
  bool deleted_using_source_row = false;
  bool modified_using_graph_row = false;
  bool using_named_rows_enabled = false;
  bool deleted_using_named_source_g_row = false;
  bool deleted_using_named_source_other_row = false;
  bool modified_using_named_g_row = false;
  bool modified_using_named_other_row = false;
  bool clear_graph_row = false;
  bool time_rows_enabled = false;
};

static xpod_rdf_bytes bytes(const char* value) {
  return {value, std::strlen(value)};
}

static constexpr const char* kDefaultGraphIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph";
static constexpr xpod_rdf_term_key kDefaultGraphKey = 44;
static constexpr xpod_rdf_term_key kTimePredicateKey = 27;
static constexpr xpod_rdf_term_key kTimeEarlySubjectKey = 111;
static constexpr xpod_rdf_term_key kTimeLateSubjectKey = 112;
static constexpr xpod_rdf_term_key kTimeLateOpaqueKey = 8000;
static constexpr xpod_rdf_term_key kTimeEarlyOpaqueKey = 8100;
static constexpr xpod_rdf_term_key kIntegerOneOpaqueKey = 8201;
static constexpr xpod_rdf_term_key kIntegerTwoOpaqueKey = 8202;
static constexpr xpod_rdf_term_key kDoubleOnePointFiveOpaqueKey = 8211;
static constexpr xpod_rdf_term_key kDoubleTwoPointFiveOpaqueKey = 8212;
static constexpr xpod_rdf_term_key kBoolTrueOpaqueKey = 8221;
static constexpr xpod_rdf_term_key kBoolFalseOpaqueKey = 8222;
static constexpr const char* kTimeEarlyLexical = "2026-08-28T23:30:00+12:00";
static constexpr const char* kTimeLateLexical = "2026-08-28T12:00:00Z";

static xpod_rdf_term_key stored_numeric_key(int64_t value) {
  if (value == 1) return kIntegerOneOpaqueKey;
  if (value == 2) return kIntegerTwoOpaqueKey;
  std::abort();
}

static xpod_rdf_term_key stored_double_key(double value) {
  if (value == 1.5) return kDoubleOnePointFiveOpaqueKey;
  if (value == 2.5) return kDoubleTwoPointFiveOpaqueKey;
  std::abort();
}

static xpod_rdf_term_key stored_bool_key(bool value) {
  return value ? kBoolTrueOpaqueKey : kBoolFalseOpaqueKey;
}

static xpod_rdf_status get_capabilities(void*, xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG |
      XPOD_RDF_PERM_CAP_SOPG |
      XPOD_RDF_PERM_CAP_PSOG |
      XPOD_RDF_PERM_CAP_POSG |
      XPOD_RDF_PERM_CAP_OSPG |
      XPOD_RDF_PERM_CAP_OPSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
      XPOD_RDF_BACKEND_FEATURE_DISTINCT_ESTIMATE |
      XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA |
      XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN |
      XPOD_RDF_BACKEND_FEATURE_MUTATION;
  out_capabilities->max_batch_size = 64;
  out_capabilities->backend_name = bytes("xpod-real-runtime-smoke");
  out_capabilities->backend_version = bytes("1");
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term == 98
      ? Id::makeFromBlankNodeIndex(BlankNodeIndex::make(term)).getBits()
      : Id::makeFromVocabIndex(VocabIndex::make(term)).getBits();
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode_qlever_id(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  Id id = Id::fromBits(bits);
  if (id.getDatatype() == Datatype::VocabIndex) {
    *out_term = id.getVocabIndex().get();
    return XPOD_RDF_STATUS_OK;
  }
  if (id.getDatatype() == Datatype::BlankNodeIndex) {
    *out_term = id.getBlankNodeIndex().get();
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_UNSUPPORTED;
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
    } else if (keys[i] == 90) {
      out_terms[i].value = bytes("urn:inserted");
    } else if (keys[i] == 91) {
      out_terms[i].value = bytes("urn:inserted-literal");
    } else if (keys[i] == 92) {
      out_terms[i].value = bytes("urn:inserted-graph");
    } else if (keys[i] == 93) {
      out_terms[i].value = bytes("urn:inserted-bind");
    } else if (keys[i] == 94) {
      out_terms[i].value = bytes("urn:inserted-iri-bind");
    } else if (keys[i] == 96) {
      out_terms[i].value = bytes("urn:inserted-str-bind");
    } else if (keys[i] == 98) {
      out_terms[i].kind = XPOD_RDF_TERM_BLANK;
      out_terms[i].value = bytes("blank-insert");
    } else if (keys[i] == 99) {
      out_terms[i].value = bytes("urn:blank-object-holder");
    } else if (keys[i] == 100) {
      out_terms[i].value = bytes("urn:modified");
    } else if (keys[i] == 101) {
      out_terms[i].value = bytes("urn:modified-graph");
    } else if (keys[i] == 102) {
      out_terms[i].value = bytes("urn:with-modified-graph");
    } else if (keys[i] == 103) {
      out_terms[i].value = bytes("urn:using-noise");
    } else if (keys[i] == 104) {
      out_terms[i].value = bytes("urn:using-source");
    } else if (keys[i] == 105) {
      out_terms[i].value = bytes("urn:using-modified-graph");
    } else if (keys[i] == 106) {
      out_terms[i].value = bytes("urn:using-named-source-g");
    } else if (keys[i] == 107) {
      out_terms[i].value = bytes("urn:using-named-source-other");
    } else if (keys[i] == 108) {
      out_terms[i].value = bytes("urn:using-named-noise");
    } else if (keys[i] == 109) {
      out_terms[i].value = bytes("urn:using-named-modified");
    } else if (keys[i] == 110) {
      out_terms[i].value = bytes("urn:clear-target");
    } else if (keys[i] == kTimeEarlySubjectKey) {
      out_terms[i].value = bytes("urn:time-early");
    } else if (keys[i] == kTimeLateSubjectKey) {
      out_terms[i].value = bytes("urn:time-late");
    } else if (keys[i] == 20) {
      out_terms[i].value = bytes("urn:p");
    } else if (keys[i] == 21) {
      out_terms[i].value = bytes("urn:p2");
    } else if (keys[i] == 22) {
      out_terms[i].value = bytes("urn:num");
    } else if (keys[i] == 23) {
      out_terms[i].value = bytes("urn:double");
    } else if (keys[i] == 24) {
      out_terms[i].value = bytes("urn:flag");
    } else if (keys[i] == 25) {
      out_terms[i].value = bytes("urn:using-p");
    } else if (keys[i] == 26) {
      out_terms[i].value = bytes("urn:using-named-p");
    } else if (keys[i] == kTimePredicateKey) {
      out_terms[i].value = bytes("urn:time");
    } else if (keys[i] == 30) {
      out_terms[i].value = bytes("urn:o");
    } else if (keys[i] == 40) {
      out_terms[i].value = bytes("urn:g");
    } else if (keys[i] == 41) {
      out_terms[i].value = bytes("urn:other-g");
    } else if (keys[i] == 42) {
      out_terms[i].value = bytes("urn:third-g");
    } else if (keys[i] == 43) {
      out_terms[i].value = bytes("urn:clear-g");
    } else if (keys[i] == kDefaultGraphKey) {
      out_terms[i].value = bytes(kDefaultGraphIri);
    } else if (keys[i] == 50) {
      out_terms[i].value = bytes("urn:text");
    } else if (keys[i] == 60) {
      out_terms[i].value = bytes("urn:entity");
    } else if (keys[i] == 70) {
      out_terms[i].value = bytes("urn:tail");
    } else if (keys[i] == 80) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("literal-value");
    } else if (keys[i] == 95) {
      out_terms[i].value = bytes("urn:bind-copy");
    } else if (keys[i] == 97) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("urn:o");
    } else if (keys[i] == stored_numeric_key(1)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("1");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#integer");
    } else if (keys[i] == stored_numeric_key(2)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("2");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#integer");
    } else if (keys[i] == stored_double_key(1.5)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("1.5");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#double");
    } else if (keys[i] == stored_double_key(2.5)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("2.5");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#double");
    } else if (keys[i] == stored_bool_key(true)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("true");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#boolean");
    } else if (keys[i] == stored_bool_key(false)) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes("false");
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#boolean");
    } else if (keys[i] == kTimeEarlyOpaqueKey) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes(kTimeEarlyLexical);
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#dateTime");
    } else if (keys[i] == kTimeLateOpaqueKey) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = bytes(kTimeLateLexical);
      out_terms[i].datatype_iri = bytes("http://www.w3.org/2001/XMLSchema#dateTime");
    } else {
      std::fprintf(stderr, "unexpected term key: %llu\n", static_cast<unsigned long long>(keys[i]));
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(void*, const xpod_rdf_scan_request*, xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 9;
  out_estimate->distinct_subjects = 3;
  out_estimate->distinct_predicates = 5;
  out_estimate->distinct_objects = 9;
  out_estimate->distinct_graphs = 1;
  out_estimate->selectivity = 1.0;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status count_scan(void*, const xpod_rdf_scan_request*, xpod_rdf_count_result* out_result) {
  out_result->count = 9;
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t length = std::strlen(expected);
  return actual.size == length &&
         std::string_view(actual.data, actual.size) == expected;
}


static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t i = 0; i < term_count; ++i) {
    if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
      std::fprintf(stderr,
                   "lookup term #%zu kind=%u value=%.*s datatype=%.*s lang=%.*s\n",
                   i,
                   static_cast<unsigned>(terms[i].kind),
                   static_cast<int>(terms[i].value.size),
                   terms[i].value.data == nullptr ? "" : terms[i].value.data,
                   static_cast<int>(terms[i].datatype_iri.size),
                   terms[i].datatype_iri.data == nullptr ? "" : terms[i].datatype_iri.data,
                   static_cast<int>(terms[i].language.size),
                   terms[i].language.data == nullptr ? "" : terms[i].language.data);
    }
    if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:s") &&
        !static_cast<BackendState*>(user_data)->deleted_base_row) {
      out_keys[i] = 10;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted") &&
        static_cast<BackendState*>(user_data)->inserted_row) {
      out_keys[i] = 90;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted-literal") &&
        static_cast<BackendState*>(user_data)->inserted_literal_row) {
      out_keys[i] = 91;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted-graph") &&
        static_cast<BackendState*>(user_data)->inserted_graph_row) {
      out_keys[i] = 92;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted-bind") &&
        static_cast<BackendState*>(user_data)->inserted_bind_row) {
      out_keys[i] = 93;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted-iri-bind") &&
        static_cast<BackendState*>(user_data)->inserted_iri_bind_row) {
      out_keys[i] = 94;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:inserted-str-bind") &&
        static_cast<BackendState*>(user_data)->inserted_str_bind_row) {
      out_keys[i] = 96;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_BLANK &&
        static_cast<BackendState*>(user_data)->inserted_blank_row) {
      out_keys[i] = 98;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:blank-object-holder") &&
        static_cast<BackendState*>(user_data)->inserted_blank_link_row) {
      out_keys[i] = 99;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:modified") &&
        (static_cast<BackendState*>(user_data)->modified_row ||
         static_cast<BackendState*>(user_data)->inserted_optional_tail_row)) {
      out_keys[i] = 100;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:modified-graph") &&
        static_cast<BackendState*>(user_data)->modified_graph_row) {
      out_keys[i] = 101;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:with-modified-graph") &&
        static_cast<BackendState*>(user_data)->modified_with_graph_row) {
      out_keys[i] = 102;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-noise")) {
      if (static_cast<BackendState*>(user_data)->using_rows_enabled) {
        out_keys[i] = 103;
        out_statuses[i] = XPOD_RDF_STATUS_OK;
      } else {
        out_keys[i] = 0;
        out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
      }
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-source") &&
        static_cast<BackendState*>(user_data)->using_rows_enabled &&
        !static_cast<BackendState*>(user_data)->deleted_using_source_row) {
      out_keys[i] = 104;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-modified-graph") &&
        static_cast<BackendState*>(user_data)->using_rows_enabled &&
        static_cast<BackendState*>(user_data)->modified_using_graph_row) {
      out_keys[i] = 105;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-named-source-g") &&
        static_cast<BackendState*>(user_data)->using_named_rows_enabled &&
        !static_cast<BackendState*>(user_data)->deleted_using_named_source_g_row) {
      out_keys[i] = 106;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-named-source-other") &&
        static_cast<BackendState*>(user_data)->using_named_rows_enabled &&
        !static_cast<BackendState*>(user_data)->deleted_using_named_source_other_row) {
      out_keys[i] = 107;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-named-noise")) {
      if (static_cast<BackendState*>(user_data)->using_named_rows_enabled) {
        out_keys[i] = 108;
        out_statuses[i] = XPOD_RDF_STATUS_OK;
      } else {
        out_keys[i] = 0;
        out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
      }
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-named-modified") &&
        static_cast<BackendState*>(user_data)->using_named_rows_enabled &&
        (static_cast<BackendState*>(user_data)->modified_using_named_g_row ||
         static_cast<BackendState*>(user_data)->modified_using_named_other_row)) {
      out_keys[i] = 109;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:clear-target") &&
        static_cast<BackendState*>(user_data)->clear_graph_row) {
      out_keys[i] = 110;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:literal-s")) {
      out_keys[i] = 15;
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
        bytes_equal(terms[i].value, "urn:num")) {
      out_keys[i] = 22;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:double")) {
      out_keys[i] = 23;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:flag")) {
      out_keys[i] = 24;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-p")) {
      out_keys[i] = 25;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:using-named-p")) {
      out_keys[i] = 26;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:time")) {
      out_keys[i] = kTimePredicateKey;
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
        bytes_equal(terms[i].value, kDefaultGraphIri)) {
      out_keys[i] = kDefaultGraphKey;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:other-g")) {
      out_keys[i] = 41;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:third-g")) {
      out_keys[i] = 42;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:clear-g")) {
      out_keys[i] = 43;
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
    } else if (terms[i].kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(terms[i].value, "urn:bind-copy")) {
      out_keys[i] = 95;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "urn:o")) {
      out_keys[i] = 97;
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "1") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#integer")) {
      out_keys[i] = stored_numeric_key(1);
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "2") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#integer")) {
      out_keys[i] = stored_numeric_key(2);
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "1.5") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#double")) {
      out_keys[i] = stored_double_key(1.5);
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "2.5") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#double")) {
      out_keys[i] = stored_double_key(2.5);
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "true") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#boolean")) {
      out_keys[i] = stored_bool_key(true);
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (terms[i].kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(terms[i].value, "false") &&
        bytes_equal(terms[i].datatype_iri, "http://www.w3.org/2001/XMLSchema#boolean")) {
      out_keys[i] = stored_bool_key(false);
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

static bool matches_graph_scope(const xpod_rdf_graph_scope& scope, const xpod_rdf_quad_key& row) {
  if (scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT) {
    return row.graph == scope.exact_graph;
  }
  if (scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
    for (size_t index = 0; index < scope.graph_set_size; ++index) {
      if (scope.graph_set[index] == row.graph) {
        return true;
      }
    }
    return false;
  }
  return true;
}

static bool access_scope_contains(
    const xpod_rdf_term_key* graph_keys,
    size_t graph_key_count,
    xpod_rdf_term_key graph) {
  if (graph_keys == nullptr) return false;
  for (size_t index = 0; index < graph_key_count; ++index) {
    if (graph_keys[index] == graph) return true;
  }
  return false;
}

static bool matches_access_scope(
    const xpod_rdf_access_scope* scope,
    const xpod_rdf_quad_key& row) {
  if (scope == nullptr) return true;
  if (scope->allowed_graphs_size != 0 &&
      !access_scope_contains(
          scope->allowed_graphs, scope->allowed_graphs_size, row.graph)) {
    return false;
  }
  return !access_scope_contains(
      scope->denied_graphs, scope->denied_graphs_size, row.graph);
}

static bool row_visible_for_state(const BackendState* state, const xpod_rdf_quad_key& row) {
  if (row.subject == 10 && state->deleted_base_row) return false;
  if (row.subject == 90 && !state->inserted_row) return false;
  if (row.subject == 91 && !state->inserted_literal_row) return false;
  if (row.subject == 92 && !state->inserted_graph_row) return false;
  if (row.subject == 93 && !state->inserted_bind_row) return false;
  if (row.subject == 94 && !state->inserted_iri_bind_row) return false;
  if (row.subject == 96 && !state->inserted_str_bind_row) return false;
  if (row.subject == 100 && row.object == 70 &&
      !state->inserted_optional_tail_row) return false;
  if (row.subject == 98 && !state->inserted_blank_row) return false;
  if (row.subject == 99 && !state->inserted_blank_link_row) return false;
  if (row.subject == 100 && row.object == 30 && !state->modified_row) return false;
  if (row.subject == 101 && !state->modified_graph_row) return false;
  if (row.subject == 102 && !state->modified_with_graph_row) return false;
  if ((row.subject == 103 || row.subject == 104 || row.subject == 105) &&
      !state->using_rows_enabled) return false;
  if (row.subject == 104 && state->deleted_using_source_row) return false;
  if (row.subject == 105 && !state->modified_using_graph_row) return false;
  if ((row.subject == 106 || row.subject == 107 || row.subject == 108 ||
       row.subject == 109) &&
      !state->using_named_rows_enabled) return false;
  if (row.subject == 106 && state->deleted_using_named_source_g_row) return false;
  if (row.subject == 107 && state->deleted_using_named_source_other_row) return false;
  if (row.subject == 109 && row.graph == 40 && !state->modified_using_named_g_row) return false;
  if (row.subject == 109 && row.graph == 41 && !state->modified_using_named_other_row) return false;
  if (row.subject == 110 && !state->clear_graph_row) return false;
  if ((row.subject == kTimeEarlySubjectKey ||
       row.subject == kTimeLateSubjectKey) &&
      !state->time_rows_enabled) return false;
  return true;
}

static xpod_rdf_status estimate_distinct(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_distinct_calls;
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, kDefaultGraphKey},
      {15, 20, 80, kDefaultGraphKey},
      {30, 21, 70, kDefaultGraphKey},
      {10, 22, stored_numeric_key(1), kDefaultGraphKey},
      {15, 22, stored_numeric_key(2), kDefaultGraphKey},
      {10, 23, stored_double_key(1.5), kDefaultGraphKey},
      {15, 23, stored_double_key(2.5), kDefaultGraphKey},
      {10, 24, stored_bool_key(true), kDefaultGraphKey},
      {15, 24, stored_bool_key(false), kDefaultGraphKey},
      {kTimeLateSubjectKey, kTimePredicateKey, kTimeLateOpaqueKey, kDefaultGraphKey},
      {kTimeEarlySubjectKey, kTimePredicateKey, kTimeEarlyOpaqueKey, kDefaultGraphKey},
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
      {10, 22, stored_numeric_key(1), 40},
      {15, 22, stored_numeric_key(2), 40},
      {10, 23, stored_double_key(1.5), 40},
      {15, 23, stored_double_key(2.5), 40},
      {10, 24, stored_bool_key(true), 40},
      {15, 24, stored_bool_key(false), 40},
  };
  uint64_t matched_count = 0;
  for (const auto& row : rows) {
    if (!matches_graph_scope(request->scan.graph_scope, row)) continue;
    if (!matches_access_scope(request->scan.access_scope, row)) continue;
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

static xpod_rdf_term_key slot_value(const xpod_rdf_quad_key& row, uint32_t slot) {
  if (slot == XPOD_RDF_SLOT_SUBJECT) return row.subject;
  if (slot == XPOD_RDF_SLOT_PREDICATE) return row.predicate;
  if (slot == XPOD_RDF_SLOT_OBJECT) return row.object;
  if (slot == XPOD_RDF_SLOT_GRAPH) return row.graph;
  return 0;
}

static xpod_rdf_term_key slot_value_by_name(const xpod_rdf_quad_key& row, char slot) {
  if (slot == 'S') return row.subject;
  if (slot == 'P') return row.predicate;
  if (slot == 'O') return row.object;
  if (slot == 'G') return row.graph;
  return 0;
}

static const char* xpod_permutation_slots(xpod_rdf_permutation permutation) {
  switch (permutation) {
    case XPOD_RDF_PERM_SPOG: return "SPOG";
    case XPOD_RDF_PERM_SOPG: return "SOPG";
    case XPOD_RDF_PERM_PSOG: return "PSOG";
    case XPOD_RDF_PERM_POSG: return "POSG";
    case XPOD_RDF_PERM_OSPG: return "OSPG";
    case XPOD_RDF_PERM_OPSG: return "OPSG";
    case XPOD_RDF_PERM_GSPO: return "GSPO";
    case XPOD_RDF_PERM_GPOS: return "GPOS";
  }
  return "SPOG";
}

static bool row_less_for_permutation(
    const xpod_rdf_quad_key& left,
    const xpod_rdf_quad_key& right,
    xpod_rdf_permutation permutation) {
  const char* slots = xpod_permutation_slots(permutation);
  for (const char* slot = slots; *slot != '\0'; ++slot) {
    xpod_rdf_term_key left_value = slot_value_by_name(left, *slot);
    xpod_rdf_term_key right_value = slot_value_by_name(right, *slot);
    if (left_value < right_value) return true;
    if (left_value > right_value) return false;
  }
  return false;
}

static bool row_in_block_for_permutation(
    const xpod_rdf_quad_key& row,
    const xpod_rdf_scan_block_metadata& block,
    xpod_rdf_permutation permutation) {
  return !row_less_for_permutation(row, block.first_quad, permutation) &&
         !row_less_for_permutation(block.last_quad, row, permutation);
}

static bool matches_selected_blocks(
    const xpod_rdf_scan_request* request,
    const xpod_rdf_quad_key& row) {
  if (request->block_metadata == nullptr || request->block_metadata_count == 0) {
    return true;
  }
  for (size_t index = 0; index < request->block_metadata_count; ++index) {
    if (row_in_block_for_permutation(
            row, request->block_metadata[index], request->permutation)) {
      return true;
    }
  }
  return false;
}

static size_t append_distinct_tuple(
    xpod_rdf_term_key* out,
    const xpod_rdf_quad_key& row,
    uint32_t distinct_slots) {
  size_t width = 0;
  const uint32_t slot_order[] = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_PREDICATE,
      XPOD_RDF_SLOT_OBJECT,
      XPOD_RDF_SLOT_GRAPH,
  };
  for (uint32_t slot : slot_order) {
    if ((distinct_slots & slot) != 0) {
      out[width++] = slot_value(row, slot);
    }
  }
  return width;
}

static bool same_tuple(
    const xpod_rdf_term_key* left,
    const xpod_rdf_term_key* right,
    size_t width) {
  for (size_t i = 0; i < width; ++i) {
    if (left[i] != right[i]) return false;
  }
  return true;
}

static xpod_rdf_status distinct_scan(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_term_tuple_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->distinct_scan_calls;
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, kDefaultGraphKey},
      {15, 20, 80, kDefaultGraphKey},
      {30, 21, 70, kDefaultGraphKey},
      {10, 22, stored_numeric_key(1), kDefaultGraphKey},
      {15, 22, stored_numeric_key(2), kDefaultGraphKey},
      {10, 23, stored_double_key(1.5), kDefaultGraphKey},
      {15, 23, stored_double_key(2.5), kDefaultGraphKey},
      {10, 24, stored_bool_key(true), kDefaultGraphKey},
      {15, 24, stored_bool_key(false), kDefaultGraphKey},
      {kTimeLateSubjectKey, kTimePredicateKey, kTimeLateOpaqueKey, kDefaultGraphKey},
      {kTimeEarlySubjectKey, kTimePredicateKey, kTimeEarlyOpaqueKey, kDefaultGraphKey},
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
      {10, 22, stored_numeric_key(1), 40},
      {15, 22, stored_numeric_key(2), 40},
      {10, 23, stored_double_key(1.5), 40},
      {15, 23, stored_double_key(2.5), 40},
      {10, 24, stored_bool_key(true), 40},
      {15, 24, stored_bool_key(false), 40},
      {90, 20, 30, kDefaultGraphKey},
      {91, 20, 80, kDefaultGraphKey},
      {92, 20, 30, 40},
      {93, 20, 95, kDefaultGraphKey},
      {94, 20, 95, kDefaultGraphKey},
      {96, 20, 97, kDefaultGraphKey},
      {100, 20, 70, kDefaultGraphKey},
      {98, 20, 30, kDefaultGraphKey},
      {99, 20, 98, kDefaultGraphKey},
      {100, 20, 30, kDefaultGraphKey},
      {101, 20, 30, 40},
      {102, 20, 30, 40},
      {103, 25, 30, 41},
      {104, 25, 30, 40},
      {105, 25, 30, 40},
      {106, 26, 30, 40},
      {107, 26, 30, 41},
      {108, 26, 30, 42},
      {109, 26, 30, 40},
      {109, 26, 30, 41},
      {110, 20, 30, 43},
  };
  xpod_rdf_term_key tuples[192] = {};
  size_t tuple_width = 0;
  size_t row_count = 0;
  for (const auto& row : rows) {
    if (!row_visible_for_state(state, row)) continue;
    if (!matches_graph_scope(request->scan.graph_scope, row)) continue;
    if (!matches_access_scope(request->scan.access_scope, row)) continue;
    if (!matches_pattern(request->scan.pattern, row)) continue;
    xpod_rdf_term_key tuple[4] = {};
    size_t width = append_distinct_tuple(tuple, row, request->distinct_slots);
    if (width == 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
    if (tuple_width == 0) tuple_width = width;
    if (tuple_width != width) return XPOD_RDF_STATUS_BACKEND_ERROR;
    bool exists = false;
    for (size_t i = 0; i < row_count; ++i) {
      if (same_tuple(&tuples[i * tuple_width], tuple, tuple_width)) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    for (size_t i = 0; i < tuple_width; ++i) {
      tuples[row_count * tuple_width + i] = tuple[i];
    }
    ++row_count;
  }
  xpod_rdf_term_tuple_batch batch = {};
  batch.terms = tuples;
  batch.row_count = row_count;
  batch.tuple_width = tuple_width;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan_block_metadata(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_block_metadata_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->block_metadata_calls;
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, kDefaultGraphKey},
      {15, 20, 80, kDefaultGraphKey},
      {30, 21, 70, kDefaultGraphKey},
      {10, 22, stored_numeric_key(1), kDefaultGraphKey},
      {15, 22, stored_numeric_key(2), kDefaultGraphKey},
      {10, 23, stored_double_key(1.5), kDefaultGraphKey},
      {15, 23, stored_double_key(2.5), kDefaultGraphKey},
      {10, 24, stored_bool_key(true), kDefaultGraphKey},
      {15, 24, stored_bool_key(false), kDefaultGraphKey},
      {kTimeLateSubjectKey, kTimePredicateKey, kTimeLateOpaqueKey, kDefaultGraphKey},
      {kTimeEarlySubjectKey, kTimePredicateKey, kTimeEarlyOpaqueKey, kDefaultGraphKey},
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
      {10, 22, stored_numeric_key(1), 40},
      {15, 22, stored_numeric_key(2), 40},
      {10, 23, stored_double_key(1.5), 40},
      {15, 23, stored_double_key(2.5), 40},
      {10, 24, stored_bool_key(true), 40},
      {15, 24, stored_bool_key(false), 40},
      {90, 20, 30, kDefaultGraphKey},
      {91, 20, 80, kDefaultGraphKey},
      {92, 20, 30, 40},
      {93, 20, 95, kDefaultGraphKey},
      {94, 20, 95, kDefaultGraphKey},
      {96, 20, 97, kDefaultGraphKey},
      {100, 20, 70, kDefaultGraphKey},
      {98, 20, 30, kDefaultGraphKey},
      {99, 20, 98, kDefaultGraphKey},
      {100, 20, 30, kDefaultGraphKey},
      {101, 20, 30, 40},
      {102, 20, 30, 40},
      {103, 25, 30, 41},
      {104, 25, 30, 40},
      {105, 25, 30, 40},
      {106, 26, 30, 40},
      {107, 26, 30, 41},
      {108, 26, 30, 42},
      {109, 26, 30, 40},
      {109, 26, 30, 41},
      {110, 20, 30, 43},
  };
  xpod_rdf_quad_key matched[48] = {};
  size_t matched_count = 0;
  for (const auto& row : rows) {
    if (!row_visible_for_state(state, row)) continue;
    if (!matches_graph_scope(request->graph_scope, row)) continue;
    if (!matches_access_scope(request->access_scope, row)) continue;
    if (matches_pattern(request->pattern, row)) {
      matched[matched_count++] = row;
    }
  }
  std::sort(matched, matched + matched_count,
            [&](const xpod_rdf_quad_key& left, const xpod_rdf_quad_key& right) {
              return row_less_for_permutation(left, right, request->permutation);
            });

  xpod_rdf_scan_block_metadata metadata[48] = {};
  for (size_t index = 0; index < matched_count; ++index) {
    metadata[index].block_id = index + 1;
    metadata[index].first_quad = matched[index];
    metadata[index].last_quad = matched[index];
    metadata[index].row_count = 1;
    metadata[index].sorted_slots =
        XPOD_RDF_SLOT_SUBJECT |
        XPOD_RDF_SLOT_PREDICATE |
        XPOD_RDF_SLOT_OBJECT |
        XPOD_RDF_SLOT_GRAPH;
  }
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(stderr,
                 "block metadata #%d perm=%u matched=%zu pattern={s:%d/%llu p:%d/%llu o:%d/%llu g:%d/%llu}\n",
                 state->block_metadata_calls,
                 static_cast<unsigned>(request->permutation),
                 matched_count,
                 request->pattern.has_subject,
                 static_cast<unsigned long long>(request->pattern.subject),
                 request->pattern.has_predicate,
                 static_cast<unsigned long long>(request->pattern.predicate),
                 request->pattern.has_object,
                 static_cast<unsigned long long>(request->pattern.object),
                 request->pattern.has_graph,
                 static_cast<unsigned long long>(request->pattern.graph));
  }
  static const char version[] = "smoke-blocks-v1";
  xpod_rdf_scan_block_metadata_batch batch = {};
  batch.rows = metadata;
  batch.row_count = matched_count;
  batch.total_blocks = matched_count;
  batch.metadata_version = {version, 15};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT &&
      request->graph_scope.exact_graph == 40) {
    ++state->exact_graph_scope_scans;
  }
  if (request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT &&
      request->graph_scope.exact_graph == kDefaultGraphKey) {
    ++state->default_graph_scope_scans;
  }
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(stderr,
                 "scan #%d perm=%u needed=%u limit=%llu offset=%llu graph_scope=%u/%llu pattern={s:%d/%llu p:%d/%llu o:%d/%llu g:%d/%llu}\n",
                 state->scan_calls,
                 static_cast<unsigned>(request->permutation),
                 static_cast<unsigned>(request->needed_slots),
                 static_cast<unsigned long long>(request->limit),
                 static_cast<unsigned long long>(request->offset),
                 static_cast<unsigned>(request->graph_scope.kind),
                 static_cast<unsigned long long>(request->graph_scope.exact_graph),
                 request->pattern.has_subject,
                 static_cast<unsigned long long>(request->pattern.subject),
                 request->pattern.has_predicate,
                 static_cast<unsigned long long>(request->pattern.predicate),
                 request->pattern.has_object,
                 static_cast<unsigned long long>(request->pattern.object),
                 request->pattern.has_graph,
                 static_cast<unsigned long long>(request->pattern.graph));
  }
  const xpod_rdf_quad_key rows[] = {
      {10, 20, 30, kDefaultGraphKey},
      {15, 20, 80, kDefaultGraphKey},
      {30, 21, 70, kDefaultGraphKey},
      {10, 22, stored_numeric_key(1), kDefaultGraphKey},
      {15, 22, stored_numeric_key(2), kDefaultGraphKey},
      {10, 23, stored_double_key(1.5), kDefaultGraphKey},
      {15, 23, stored_double_key(2.5), kDefaultGraphKey},
      {10, 24, stored_bool_key(true), kDefaultGraphKey},
      {15, 24, stored_bool_key(false), kDefaultGraphKey},
      {kTimeLateSubjectKey, kTimePredicateKey, kTimeLateOpaqueKey, kDefaultGraphKey},
      {kTimeEarlySubjectKey, kTimePredicateKey, kTimeEarlyOpaqueKey, kDefaultGraphKey},
      {10, 20, 30, 40},
      {15, 20, 80, 40},
      {30, 21, 70, 40},
      {10, 22, stored_numeric_key(1), 40},
      {15, 22, stored_numeric_key(2), 40},
      {10, 23, stored_double_key(1.5), 40},
      {15, 23, stored_double_key(2.5), 40},
      {10, 24, stored_bool_key(true), 40},
      {15, 24, stored_bool_key(false), 40},
      {90, 20, 30, kDefaultGraphKey},
      {91, 20, 80, kDefaultGraphKey},
      {92, 20, 30, 40},
      {93, 20, 95, kDefaultGraphKey},
      {94, 20, 95, kDefaultGraphKey},
      {96, 20, 97, kDefaultGraphKey},
      {100, 20, 70, kDefaultGraphKey},
      {98, 20, 30, kDefaultGraphKey},
      {99, 20, 98, kDefaultGraphKey},
      {100, 20, 30, kDefaultGraphKey},
      {101, 20, 30, 40},
      {102, 20, 30, 40},
      {103, 25, 30, 41},
      {104, 25, 30, 40},
      {105, 25, 30, 40},
      {106, 26, 30, 40},
      {107, 26, 30, 41},
      {108, 26, 30, 42},
      {109, 26, 30, 40},
      {109, 26, 30, 41},
      {110, 20, 30, 43},
  };
  xpod_rdf_quad_key matched[48] = {};
  size_t matched_count = 0;
  for (const auto& row : rows) {
    if (!row_visible_for_state(state, row)) continue;
    if (!matches_graph_scope(request->graph_scope, row)) continue;
    if (!matches_access_scope(request->access_scope, row)) continue;
    if (!matches_selected_blocks(request, row)) continue;
    if (matches_pattern(request->pattern, row)) {
      matched[matched_count++] = row;
    }
  }
  std::sort(matched, matched + matched_count,
            [&](const xpod_rdf_quad_key& left, const xpod_rdf_quad_key& right) {
              return row_less_for_permutation(left, right, request->permutation);
            });
  size_t start = request->offset < matched_count
      ? static_cast<size_t>(request->offset)
      : matched_count;
  size_t limited_count = matched_count - start;
  if (request->limit != 0 && request->limit < limited_count) {
    limited_count = static_cast<size_t>(request->limit);
  }
  xpod_rdf_quad_batch batch = {};
  batch.rows = limited_count == 0 ? nullptr : matched + start;
  batch.row_count = limited_count;
  batch.sorted_slots = request->needed_slots;
  batch.scanned_rows = matched_count;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status apply_mutation(
    void* user_data,
    const xpod_rdf_mutation_request* request,
    xpod_rdf_mutation_result* out_result) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->mutation_calls;
  if (request == nullptr ||
      request->mutation_count == 0 ||
      request->mutations == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  uint64_t inserted_count = 0;
  uint64_t deleted_count = 0;
  for (size_t index = 0; index < request->mutation_count; ++index) {
    const xpod_rdf_quad_mutation& mutation = request->mutations[index];
    const bool predicate_p =
        mutation.quad.predicate.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.predicate.value, "urn:p");
    const bool predicate_using_p =
        mutation.quad.predicate.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.predicate.value, "urn:using-p");
    const bool predicate_using_named_p =
        mutation.quad.predicate.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.predicate.value, "urn:using-named-p");
    if (!predicate_p && !predicate_using_p && !predicate_using_named_p) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    const bool iri_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o");
    const bool literal_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted-literal") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(mutation.quad.object.value, "literal-value");
    const bool graph_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted-graph") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool bind_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted-bind") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:bind-copy");
    const bool iri_bind_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted-iri-bind") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:bind-copy");
    const bool str_bind_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:inserted-str-bind") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_LITERAL &&
        bytes_equal(mutation.quad.object.value, "urn:o");
    const bool blank_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_BLANK &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o");
    const bool blank_link_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:blank-object-holder") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_BLANK;
    const bool base_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:s") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o");
    const bool modified_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:modified") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o");
    const bool optional_tail_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:modified") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:tail");
    const bool modified_graph_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:modified-graph") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool modified_with_graph_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:with-modified-graph") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool using_source_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-source") &&
        predicate_using_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool using_modified_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-modified-graph") &&
        predicate_using_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool using_named_source_g_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-named-source-g") &&
        predicate_using_named_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool using_named_source_other_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-named-source-other") &&
        predicate_using_named_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:other-g");
    const bool using_named_modified_g_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-named-modified") &&
        predicate_using_named_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:g");
    const bool using_named_modified_other_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:using-named-modified") &&
        predicate_using_named_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:other-g");
    const bool clear_graph_row =
        mutation.quad.subject.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.subject.value, "urn:clear-target") &&
        predicate_p &&
        mutation.quad.object.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.object.value, "urn:o") &&
        mutation.quad.has_graph != 0 &&
        mutation.quad.graph.kind == XPOD_RDF_TERM_IRI &&
        bytes_equal(mutation.quad.graph.value, "urn:clear-g");
    if (!iri_row && !literal_row && !graph_row && !bind_row &&
        !iri_bind_row && !str_bind_row && !blank_row && !blank_link_row &&
        !base_row && !modified_row && !optional_tail_row && !modified_graph_row &&
        !modified_with_graph_row && !using_source_row && !using_modified_row &&
        !using_named_source_g_row && !using_named_source_other_row &&
        !using_named_modified_g_row && !using_named_modified_other_row &&
        !clear_graph_row) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    bool* row_state = &state->modified_using_graph_row;
    if (iri_row) row_state = &state->inserted_row;
    else if (literal_row) row_state = &state->inserted_literal_row;
    else if (graph_row) row_state = &state->inserted_graph_row;
    else if (bind_row) row_state = &state->inserted_bind_row;
    else if (iri_bind_row) row_state = &state->inserted_iri_bind_row;
    else if (str_bind_row) row_state = &state->inserted_str_bind_row;
    else if (blank_row) row_state = &state->inserted_blank_row;
    else if (blank_link_row) row_state = &state->inserted_blank_link_row;
    else if (base_row) row_state = &state->deleted_base_row;
    else if (modified_row) row_state = &state->modified_row;
    else if (optional_tail_row) row_state = &state->inserted_optional_tail_row;
    else if (modified_graph_row) row_state = &state->modified_graph_row;
    else if (modified_with_graph_row) row_state = &state->modified_with_graph_row;
    else if (using_source_row) row_state = &state->deleted_using_source_row;
    else if (using_named_source_g_row) row_state = &state->deleted_using_named_source_g_row;
    else if (using_named_source_other_row) row_state = &state->deleted_using_named_source_other_row;
    else if (using_named_modified_g_row) row_state = &state->modified_using_named_g_row;
    else if (using_named_modified_other_row) row_state = &state->modified_using_named_other_row;
    else if (clear_graph_row) row_state = &state->clear_graph_row;
    const bool static_delete_row = base_row || using_source_row ||
        using_named_source_g_row || using_named_source_other_row;
    if (mutation.kind == XPOD_RDF_MUTATION_INSERT) {
      *row_state = !static_delete_row;
      ++inserted_count;
    } else if (mutation.kind == XPOD_RDF_MUTATION_DELETE) {
      *row_state = static_delete_row;
      ++deleted_count;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
  }
  out_result->inserted_count = inserted_count;
  out_result->deleted_count = deleted_count;
  out_result->facts_version = bytes("facts-v2");
  return XPOD_RDF_STATUS_OK;
}

static int expect_select_s_result(
    xpod_qlever_adapter* adapter,
    const char* label,
    const char* sparql,
    const char* required,
    const char* forbidden,
    int code_base) {
  xpod_qlever_query_request request = {};
  request.sparql = bytes(sparql);
  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(
      adapter, &request, &result);
  std::string_view json(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "%s query failed: %.*s\n",
                 label,
                 static_cast<int>(error.size()),
                 error.data());
    return code_base;
  }
  if (json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "%s head mismatch json=%.*s profile=%.*s\n",
                 label,
                 static_cast<int>(json.size()),
                 json.data(),
                 static_cast<int>(profile.size()),
                 profile.data());
    xpod_qlever_adapter_release_result(adapter, &result);
    return code_base + 1;
  }
  if (required != nullptr &&
      json.find(required) == std::string_view::npos) {
    std::fprintf(stderr, "%s missing %s json=%.*s profile=%.*s\n",
                 label,
                 required,
                 static_cast<int>(json.size()),
                 json.data(),
                 static_cast<int>(profile.size()),
                 profile.data());
    xpod_qlever_adapter_release_result(adapter, &result);
    return code_base + 2;
  }
  if (forbidden != nullptr &&
      json.find(forbidden) != std::string_view::npos) {
    std::fprintf(stderr, "%s leaked %s json=%.*s profile=%.*s\n",
                 label,
                 forbidden,
                 static_cast<int>(json.size()),
                 json.data(),
                 static_cast<int>(profile.size()),
                 profile.data());
    xpod_qlever_adapter_release_result(adapter, &result);
    return code_base + 3;
  }
  xpod_qlever_adapter_release_result(adapter, &result);
  return 0;
}

static int expect_select_s_pair_result(
    xpod_qlever_adapter* adapter,
    const char* label,
    const char* sparql,
    int code_base) {
  if (int code = expect_select_s_result(
          adapter, label, sparql, "urn:s", nullptr, code_base)) {
    return code;
  }
  return expect_select_s_result(
      adapter, label, sparql, "urn:literal-s", nullptr, code_base + 4);
}

static int expect_select_s_empty_result(
    xpod_qlever_adapter* adapter,
    const char* label,
    const char* sparql,
    int code_base) {
  xpod_qlever_query_request request = {};
  request.sparql = bytes(sparql);
  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(
      adapter, &request, &result);
  std::string_view json(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "%s query failed: %.*s\n",
                 label,
                 static_cast<int>(error.size()),
                 error.data());
    return code_base;
  }
  if (json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "%s head mismatch json=%.*s profile=%.*s\n",
                 label,
                 static_cast<int>(json.size()),
                 json.data(),
                 static_cast<int>(profile.size()),
                 profile.data());
    xpod_qlever_adapter_release_result(adapter, &result);
    return code_base + 1;
  }
  if (json.find("urn:s") != std::string_view::npos ||
      json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "%s leaked rows json=%.*s profile=%.*s\n",
                 label,
                 static_cast<int>(json.size()),
                 json.data(),
                 static_cast<int>(profile.size()),
                 profile.data());
    xpod_qlever_adapter_release_result(adapter, &result);
    return code_base + 2;
  }
  xpod_qlever_adapter_release_result(adapter, &result);
  return 0;
}

static int assert_native_shape_profile(
    const char* shape,
    std::string_view profile,
    const char* operation,
    int code_base) {
  if (profile.find(R"("executionMode":"native-qlever-tree")") ==
      std::string_view::npos) {
    std::fprintf(stderr, "%s missing native-qlever-tree profile=%.*s\n",
                 shape,
                 static_cast<int>(profile.size()),
                 profile.data());
    return code_base;
  }
  if (profile.find("runtimeInformation") == std::string_view::npos) {
    std::fprintf(stderr, "%s missing runtimeInformation profile=%.*s\n",
                 shape,
                 static_cast<int>(profile.size()),
                 profile.data());
    return code_base + 1;
  }
  if (profile.find(operation) == std::string_view::npos) {
    std::fprintf(stderr, "%s missing operation %s profile=%.*s\n",
                 shape,
                 operation,
                 static_cast<int>(profile.size()),
                 profile.data());
    return code_base + 2;
  }
  if (profile.find("BridgeOperation") != std::string_view::npos ||
      profile.find("compatibility-") != std::string_view::npos) {
    std::fprintf(stderr, "%s leaked compatibility bridge profile=%.*s\n",
                 shape,
                 static_cast<int>(profile.size()),
                 profile.data());
    return code_base + 3;
  }
  return 0;
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
  raw_backend.resolve_terms = resolve_terms;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.count_scan = count_scan;
  raw_backend.estimate_distinct = estimate_distinct;
  raw_backend.distinct_scan = distinct_scan;
  raw_backend.scan_block_metadata = scan_block_metadata;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.estimate_text_search = estimate_text_search;
  raw_backend.text_search = text_search;
  raw_backend.apply_mutation = apply_mutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_OPAQUE;
  raw_backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_UNKNOWN;

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

  const int default_graph_scope_before_mixed_union =
      state.default_graph_scope_scans;
  xpod_qlever_query_request mixed_default_named_union_request = {};
  mixed_default_named_union_request.sparql = bytes(
      "SELECT ?g ?s WHERE { "
      "{ ?s <urn:p> ?o "
      "BIND(<urn:xpod:semantic:g:default> AS ?g) } UNION "
      "{ GRAPH ?g { ?s <urn:p> ?o } } "
      "} ORDER BY ?g ?s");
  xpod_qlever_query_result mixed_default_named_union_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter,
      &mixed_default_named_union_request,
      &mixed_default_named_union_result);
  std::string_view mixed_default_named_union_json(
      mixed_default_named_union_result.result_json.data,
      mixed_default_named_union_result.result_json.size);
  std::string_view mixed_default_named_union_profile(
      mixed_default_named_union_result.profile_json.data,
      mixed_default_named_union_result.profile_json.size);
  std::string_view mixed_default_named_union_error(
      mixed_default_named_union_result.error_message.data,
      mixed_default_named_union_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "mixed default/named UNION query failed: %.*s\n",
                 static_cast<int>(mixed_default_named_union_error.size()),
                 mixed_default_named_union_error.data());
    return 1244;
  }
  if (mixed_default_named_union_json.find(
          R"("g":{"type":"uri","value":"urn:xpod:semantic:g:default"})") ==
          std::string_view::npos ||
      mixed_default_named_union_json.find(
          R"("g":{"type":"uri","value":"urn:g"})") ==
          std::string_view::npos) {
    std::fprintf(stderr,
                 "mixed default/named UNION missing one branch json=%.*s profile=%.*s\n",
                 static_cast<int>(mixed_default_named_union_json.size()),
                 mixed_default_named_union_json.data(),
                 static_cast<int>(mixed_default_named_union_profile.size()),
                 mixed_default_named_union_profile.data());
    return 1245;
  }
  if (state.default_graph_scope_scans <=
      default_graph_scope_before_mixed_union) {
    std::fprintf(stderr,
                 "mixed default/named UNION did not scan the QLever default graph exactly json=%.*s profile=%.*s\n",
                 static_cast<int>(mixed_default_named_union_json.size()),
                 mixed_default_named_union_json.data(),
                 static_cast<int>(mixed_default_named_union_profile.size()),
                 mixed_default_named_union_profile.data());
    return 1246;
  }
  if (int code = assert_native_shape_profile(
          "mixed default/named union",
          mixed_default_named_union_profile,
          "Union",
          1240)) {
    return code;
  }
  xpod_qlever_adapter_release_result(
      adapter, &mixed_default_named_union_result);

  xpod_qlever_query_request select_accept_mismatch_request = {};
  select_accept_mismatch_request.sparql = bytes("SELECT * WHERE { ?s ?p ?o }");
  select_accept_mismatch_request.accept_media_type = bytes("application/n-triples");
  xpod_qlever_query_result select_accept_mismatch_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &select_accept_mismatch_request, &select_accept_mismatch_result);
  std::string_view select_accept_mismatch_error(
      select_accept_mismatch_result.error_message.data,
      select_accept_mismatch_result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) {
    std::fprintf(stderr, "select accept mismatch did not fail status=%u\n",
                 static_cast<unsigned>(status));
    return 575;
  }
  if (select_accept_mismatch_error.find("not acceptable") == std::string_view::npos) {
    std::fprintf(stderr, "select accept mismatch error mismatch: %.*s\n",
                 static_cast<int>(select_accept_mismatch_error.size()),
                 select_accept_mismatch_error.data());
    return 576;
  }
  xpod_qlever_adapter_release_result(adapter, &select_accept_mismatch_result);

  xpod_qlever_query_request select_accept_wildcard_request = {};
  select_accept_wildcard_request.sparql = bytes("SELECT * WHERE { ?s ?p ?o }");
  select_accept_wildcard_request.accept_media_type = bytes("application/*");
  xpod_qlever_query_result select_accept_wildcard_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &select_accept_wildcard_request, &select_accept_wildcard_result);
  std::string_view select_accept_wildcard_media(
      select_accept_wildcard_result.result_media_type.data,
      select_accept_wildcard_result.result_media_type.size);
  std::string_view select_accept_wildcard_error(
      select_accept_wildcard_result.error_message.data,
      select_accept_wildcard_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "select accept wildcard failed: %.*s\n",
                 static_cast<int>(select_accept_wildcard_error.size()),
                 select_accept_wildcard_error.data());
    return 582;
  }
  if (select_accept_wildcard_media != "application/sparql-results+json") {
    std::fprintf(stderr, "select accept wildcard media mismatch: %.*s\n",
                 static_cast<int>(select_accept_wildcard_media.size()),
                 select_accept_wildcard_media.data());
    return 583;
  }
  xpod_qlever_adapter_release_result(adapter, &select_accept_wildcard_result);

  xpod_qlever_query_request select_accept_q0_request = {};
  select_accept_q0_request.sparql = bytes("SELECT * WHERE { ?s ?p ?o }");
  select_accept_q0_request.accept_media_type = bytes("application/sparql-results+json; q=0");
  xpod_qlever_query_result select_accept_q0_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &select_accept_q0_request, &select_accept_q0_result);
  std::string_view select_accept_q0_error(
      select_accept_q0_result.error_message.data,
      select_accept_q0_result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) {
    std::fprintf(stderr, "select accept q0 did not fail status=%u\n",
                 static_cast<unsigned>(status));
    return 586;
  }
  if (select_accept_q0_error.find("not acceptable") == std::string_view::npos) {
    std::fprintf(stderr, "select accept q0 error mismatch: %.*s\n",
                 static_cast<int>(select_accept_q0_error.size()),
                 select_accept_q0_error.data());
    return 587;
  }
  xpod_qlever_adapter_release_result(adapter, &select_accept_q0_result);

  xpod_qlever_query_request subquery_request = {};
  subquery_request.sparql = bytes(
      "SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p> ?o } } } ORDER BY ?s");
  xpod_qlever_query_result subquery_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &subquery_request, &subquery_result);
  std::string_view subquery_json(
      subquery_result.result_json.data, subquery_result.result_json.size);
  std::string_view subquery_profile(
      subquery_result.profile_json.data, subquery_result.profile_json.size);
  std::string_view subquery_error(
      subquery_result.error_message.data, subquery_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "subquery failed: %.*s\n",
                 static_cast<int>(subquery_error.size()),
                 subquery_error.data());
    return 160;
  }
  if (subquery_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "subquery head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(subquery_json.size()), subquery_json.data(),
                 static_cast<int>(subquery_profile.size()), subquery_profile.data());
    return 161;
  }
  if (subquery_json.find("urn:s") == std::string_view::npos ||
      subquery_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "subquery missing expected rows json=%.*s profile=%.*s\n",
                 static_cast<int>(subquery_json.size()), subquery_json.data(),
                 static_cast<int>(subquery_profile.size()), subquery_profile.data());
    return 162;
  }
  if (subquery_json.find("urn:o") != std::string_view::npos ||
      subquery_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "subquery leaked wrong rows json=%.*s profile=%.*s\n",
                 static_cast<int>(subquery_json.size()), subquery_json.data(),
                 static_cast<int>(subquery_profile.size()), subquery_profile.data());
    return 163;
  }
  xpod_qlever_adapter_release_result(adapter, &subquery_result);

  xpod_qlever_query_request order_by_str_request = {};
  order_by_str_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o } ORDER BY STR(?s) LIMIT 1");
  xpod_qlever_query_result order_by_str_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &order_by_str_request, &order_by_str_result);
  std::string_view order_by_str_json(
      order_by_str_result.result_json.data,
      order_by_str_result.result_json.size);
  std::string_view order_by_str_profile(
      order_by_str_result.profile_json.data,
      order_by_str_result.profile_json.size);
  std::string_view order_by_str_error(
      order_by_str_result.error_message.data,
      order_by_str_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "ORDER BY STR query failed: %.*s\n",
                 static_cast<int>(order_by_str_error.size()),
                 order_by_str_error.data());
    return 164;
  }
  if (order_by_str_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "ORDER BY STR head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(order_by_str_json.size()),
                 order_by_str_json.data(),
                 static_cast<int>(order_by_str_profile.size()),
                 order_by_str_profile.data());
    return 165;
  }
  if (order_by_str_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "ORDER BY STR missing lexical first row json=%.*s profile=%.*s\n",
                 static_cast<int>(order_by_str_json.size()),
                 order_by_str_json.data(),
                 static_cast<int>(order_by_str_profile.size()),
                 order_by_str_profile.data());
    return 166;
  }
  if (order_by_str_json.find("urn:s") != std::string_view::npos ||
      order_by_str_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "ORDER BY STR leaked non-limited rows json=%.*s profile=%.*s\n",
                 static_cast<int>(order_by_str_json.size()),
                 order_by_str_json.data(),
                 static_cast<int>(order_by_str_profile.size()),
                 order_by_str_profile.data());
    return 167;
  }
  if (order_by_str_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "ORDER BY STR missing profile node json=%.*s profile=%.*s\n",
                 static_cast<int>(order_by_str_json.size()),
                 order_by_str_json.data(),
                 static_cast<int>(order_by_str_profile.size()),
                 order_by_str_profile.data());
    return 168;
  }
  xpod_qlever_adapter_release_result(adapter, &order_by_str_result);

  xpod_qlever_query_request named_graph_request = {};
  named_graph_request.sparql = bytes(
      "SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } } ORDER BY ?s");
  xpod_qlever_query_result named_graph_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &named_graph_request, &named_graph_result);
  std::string_view named_graph_json(
      named_graph_result.result_json.data,
      named_graph_result.result_json.size);
  std::string_view named_graph_profile(
      named_graph_result.profile_json.data,
      named_graph_result.profile_json.size);
  std::string_view named_graph_error(
      named_graph_result.error_message.data,
      named_graph_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "named GRAPH query failed: %.*s\n",
                 static_cast<int>(named_graph_error.size()),
                 named_graph_error.data());
    return 150;
  }
  if (named_graph_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "named GRAPH head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_json.size()),
                 named_graph_json.data(),
                 static_cast<int>(named_graph_profile.size()),
                 named_graph_profile.data());
    return 151;
  }
  if (named_graph_json.find("urn:s") == std::string_view::npos ||
      named_graph_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "named GRAPH missing expected rows json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_json.size()),
                 named_graph_json.data(),
                 static_cast<int>(named_graph_profile.size()),
                 named_graph_profile.data());
    return 152;
  }
  if (named_graph_json.find("urn:o") != std::string_view::npos ||
      named_graph_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "named GRAPH leaked wrong rows json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_json.size()),
                 named_graph_json.data(),
                 static_cast<int>(named_graph_profile.size()),
                 named_graph_profile.data());
    return 153;
  }
  if (named_graph_profile.find("PermutationScan") == std::string_view::npos &&
      named_graph_profile.find("IndexScan") == std::string_view::npos) {
    std::fprintf(stderr, "named GRAPH missing scan profile json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_json.size()),
                 named_graph_json.data(),
                 static_cast<int>(named_graph_profile.size()),
                 named_graph_profile.data());
    return 154;
  }
  xpod_qlever_adapter_release_result(adapter, &named_graph_result);

  xpod_qlever_query_request graph_variable_request = {};
  graph_variable_request.sparql = bytes(
      "SELECT ?g WHERE { GRAPH ?g { <urn:s> <urn:p> <urn:o> } } ORDER BY ?g");
  xpod_qlever_query_result graph_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &graph_variable_request, &graph_variable_result);
  std::string_view graph_variable_json(
      graph_variable_result.result_json.data,
      graph_variable_result.result_json.size);
  std::string_view graph_variable_profile(
      graph_variable_result.profile_json.data,
      graph_variable_result.profile_json.size);
  std::string_view graph_variable_error(
      graph_variable_result.error_message.data,
      graph_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "GRAPH variable query failed: %.*s\n",
                 static_cast<int>(graph_variable_error.size()),
                 graph_variable_error.data());
    return 155;
  }
  if (graph_variable_json.find(R"("head":{"vars":["g"]})") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_json.size()),
                 graph_variable_json.data(),
                 static_cast<int>(graph_variable_profile.size()),
                 graph_variable_profile.data());
    return 156;
  }
  if (graph_variable_json.find("urn:g") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable missing graph binding json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_json.size()),
                 graph_variable_json.data(),
                 static_cast<int>(graph_variable_profile.size()),
                 graph_variable_profile.data());
    return 157;
  }
  if (graph_variable_json.find(kDefaultGraphIri) != std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable leaked default graph binding json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_json.size()),
                 graph_variable_json.data(),
                 static_cast<int>(graph_variable_profile.size()),
                 graph_variable_profile.data());
    return 927;
  }
  if (graph_variable_json.find("urn:s") != std::string_view::npos ||
      graph_variable_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable leaked internal terms json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_json.size()),
                 graph_variable_json.data(),
                 static_cast<int>(graph_variable_profile.size()),
                 graph_variable_profile.data());
    return 158;
  }
  if (graph_variable_profile.find("PermutationScan") == std::string_view::npos &&
      graph_variable_profile.find("IndexScan") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable missing scan profile json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_json.size()),
                 graph_variable_json.data(),
                 static_cast<int>(graph_variable_profile.size()),
                 graph_variable_profile.data());
    return 159;
  }
  xpod_qlever_adapter_release_result(adapter, &graph_variable_result);

  xpod_qlever_query_request graph_variable_stored_numeric_request = {};
  graph_variable_stored_numeric_request.sparql = bytes(
      "SELECT ?g ?s ?n WHERE { GRAPH ?g { ?s <urn:num> ?n } } ORDER BY ?s");
  xpod_qlever_query_result graph_variable_stored_numeric_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter,
      &graph_variable_stored_numeric_request,
      &graph_variable_stored_numeric_result);
  std::string_view graph_variable_stored_numeric_json(
      graph_variable_stored_numeric_result.result_json.data,
      graph_variable_stored_numeric_result.result_json.size);
  std::string_view graph_variable_stored_numeric_profile(
      graph_variable_stored_numeric_result.profile_json.data,
      graph_variable_stored_numeric_result.profile_json.size);
  std::string_view graph_variable_stored_numeric_error(
      graph_variable_stored_numeric_result.error_message.data,
      graph_variable_stored_numeric_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "GRAPH variable stored numeric query failed: %.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_error.size()),
                 graph_variable_stored_numeric_error.data());
    return 520;
  }
  if (graph_variable_stored_numeric_json.find(R"("head":{"vars":["g","s","n"]})") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 521;
  }
  if (graph_variable_stored_numeric_json.find("urn:g") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric missing graph binding json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 522;
  }
  if (graph_variable_stored_numeric_json.find(kDefaultGraphIri) != std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric leaked default graph binding json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 928;
  }
  if (graph_variable_stored_numeric_json.find("urn:s") == std::string_view::npos ||
      graph_variable_stored_numeric_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric missing subject rows json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 523;
  }
  if (graph_variable_stored_numeric_json.find(R"("value":"1")") == std::string_view::npos ||
      graph_variable_stored_numeric_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric missing integer values json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 524;
  }
  if (graph_variable_stored_numeric_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 525;
  }
  if (graph_variable_stored_numeric_profile.find("PermutationScan") == std::string_view::npos &&
      graph_variable_stored_numeric_profile.find("IndexScan") == std::string_view::npos) {
    std::fprintf(stderr, "GRAPH variable stored numeric missing scan profile json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_variable_stored_numeric_json.size()),
                 graph_variable_stored_numeric_json.data(),
                 static_cast<int>(graph_variable_stored_numeric_profile.size()),
                 graph_variable_stored_numeric_profile.data());
    return 526;
  }
  xpod_qlever_adapter_release_result(adapter, &graph_variable_stored_numeric_result);

  xpod_qlever_adapter_destroy(adapter);
  adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) {
    return 184;
  }
  int exact_graph_scope_before_from = state.exact_graph_scope_scans;
  xpod_qlever_query_request from_graph_request = {};
  from_graph_request.sparql = bytes(
      "SELECT ?s FROM <urn:g> WHERE { ?s <urn:p> ?o } ORDER BY ?s");
  xpod_qlever_query_result from_graph_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &from_graph_request, &from_graph_result);
  std::string_view from_graph_json(
      from_graph_result.result_json.data,
      from_graph_result.result_json.size);
  std::string_view from_graph_profile(
      from_graph_result.profile_json.data,
      from_graph_result.profile_json.size);
  std::string_view from_graph_error(
      from_graph_result.error_message.data,
      from_graph_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "FROM graph query failed: %.*s\n",
                 static_cast<int>(from_graph_error.size()),
                 from_graph_error.data());
    return 185;
  }
  if (from_graph_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "FROM graph head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_json.size()),
                 from_graph_json.data(),
                 static_cast<int>(from_graph_profile.size()),
                 from_graph_profile.data());
    return 186;
  }
  if (from_graph_json.find("urn:s") == std::string_view::npos ||
      from_graph_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "FROM graph missing scoped rows json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_json.size()),
                 from_graph_json.data(),
                 static_cast<int>(from_graph_profile.size()),
                 from_graph_profile.data());
    return 187;
  }
  if (state.exact_graph_scope_scans <= exact_graph_scope_before_from) {
    std::fprintf(stderr, "FROM graph did not reach backend as exact graph scope json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_json.size()),
                 from_graph_json.data(),
                 static_cast<int>(from_graph_profile.size()),
                 from_graph_profile.data());
    return 188;
  }
  xpod_qlever_adapter_release_result(adapter, &from_graph_result);

  int exact_graph_scope_before_from_stored_numeric = state.exact_graph_scope_scans;
  xpod_qlever_query_request from_graph_stored_numeric_request = {};
  from_graph_stored_numeric_request.sparql = bytes(
      "SELECT ?s ?n FROM <urn:g> WHERE { ?s <urn:num> ?n } ORDER BY ?s");
  xpod_qlever_query_result from_graph_stored_numeric_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter,
      &from_graph_stored_numeric_request,
      &from_graph_stored_numeric_result);
  std::string_view from_graph_stored_numeric_json(
      from_graph_stored_numeric_result.result_json.data,
      from_graph_stored_numeric_result.result_json.size);
  std::string_view from_graph_stored_numeric_profile(
      from_graph_stored_numeric_result.profile_json.data,
      from_graph_stored_numeric_result.profile_json.size);
  std::string_view from_graph_stored_numeric_error(
      from_graph_stored_numeric_result.error_message.data,
      from_graph_stored_numeric_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "FROM stored numeric query failed: %.*s\n",
                 static_cast<int>(from_graph_stored_numeric_error.size()),
                 from_graph_stored_numeric_error.data());
    return 527;
  }
  if (from_graph_stored_numeric_json.find(R"("head":{"vars":["s","n"]})") == std::string_view::npos) {
    std::fprintf(stderr, "FROM stored numeric head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_stored_numeric_json.size()),
                 from_graph_stored_numeric_json.data(),
                 static_cast<int>(from_graph_stored_numeric_profile.size()),
                 from_graph_stored_numeric_profile.data());
    return 528;
  }
  if (from_graph_stored_numeric_json.find("urn:s") == std::string_view::npos ||
      from_graph_stored_numeric_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "FROM stored numeric missing scoped subject rows json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_stored_numeric_json.size()),
                 from_graph_stored_numeric_json.data(),
                 static_cast<int>(from_graph_stored_numeric_profile.size()),
                 from_graph_stored_numeric_profile.data());
    return 529;
  }
  if (from_graph_stored_numeric_json.find(R"("value":"1")") == std::string_view::npos ||
      from_graph_stored_numeric_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "FROM stored numeric missing integer values json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_stored_numeric_json.size()),
                 from_graph_stored_numeric_json.data(),
                 static_cast<int>(from_graph_stored_numeric_profile.size()),
                 from_graph_stored_numeric_profile.data());
    return 530;
  }
  if (from_graph_stored_numeric_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
    std::fprintf(stderr, "FROM stored numeric missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_stored_numeric_json.size()),
                 from_graph_stored_numeric_json.data(),
                 static_cast<int>(from_graph_stored_numeric_profile.size()),
                 from_graph_stored_numeric_profile.data());
    return 531;
  }
  if (state.exact_graph_scope_scans <= exact_graph_scope_before_from_stored_numeric) {
    std::fprintf(stderr, "FROM stored numeric did not reach exact graph scope scan json=%.*s profile=%.*s\n",
                 static_cast<int>(from_graph_stored_numeric_json.size()),
                 from_graph_stored_numeric_json.data(),
                 static_cast<int>(from_graph_stored_numeric_profile.size()),
                 from_graph_stored_numeric_profile.data());
    return 532;
  }
  xpod_qlever_adapter_release_result(adapter, &from_graph_stored_numeric_result);

  xpod_qlever_query_request strstarts_filter_request = {};
  strstarts_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), \"urn:literal\")) } ORDER BY ?s");
  xpod_qlever_query_result strstarts_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strstarts_filter_request, &strstarts_filter_result);
  std::string_view strstarts_filter_json(
      strstarts_filter_result.result_json.data,
      strstarts_filter_result.result_json.size);
  std::string_view strstarts_filter_profile(
      strstarts_filter_result.profile_json.data,
      strstarts_filter_result.profile_json.size);
  std::string_view strstarts_filter_error(
      strstarts_filter_result.error_message.data,
      strstarts_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRSTARTS filter query failed: %.*s\n",
                 static_cast<int>(strstarts_filter_error.size()),
                 strstarts_filter_error.data());
    return 160;
  }
  if (strstarts_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_filter_json.size()),
                 strstarts_filter_json.data(),
                 static_cast<int>(strstarts_filter_profile.size()),
                 strstarts_filter_profile.data());
    return 161;
  }
  if (strstarts_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS filter missing literal subject json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_filter_json.size()),
                 strstarts_filter_json.data(),
                 static_cast<int>(strstarts_filter_profile.size()),
                 strstarts_filter_profile.data());
    return 162;
  }
  if (strstarts_filter_json.find("urn:s") != std::string_view::npos ||
      strstarts_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS filter leaked non-prefix rows json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_filter_json.size()),
                 strstarts_filter_json.data(),
                 static_cast<int>(strstarts_filter_profile.size()),
                 strstarts_filter_profile.data());
    return 163;
  }
  if (strstarts_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS filter missing profile node json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_filter_json.size()),
                 strstarts_filter_json.data(),
                 static_cast<int>(strstarts_filter_profile.size()),
                 strstarts_filter_profile.data());
    return 164;
  }
  xpod_qlever_adapter_release_result(adapter, &strstarts_filter_result);

  xpod_qlever_query_request contains_filter_request = {};
  contains_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(CONTAINS(STR(?s), \"literal\")) } ORDER BY ?s");
  xpod_qlever_query_result contains_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &contains_filter_request, &contains_filter_result);
  std::string_view contains_filter_json(
      contains_filter_result.result_json.data,
      contains_filter_result.result_json.size);
  std::string_view contains_filter_profile(
      contains_filter_result.profile_json.data,
      contains_filter_result.profile_json.size);
  std::string_view contains_filter_error(
      contains_filter_result.error_message.data,
      contains_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "CONTAINS filter query failed: %.*s\n",
                 static_cast<int>(contains_filter_error.size()),
                 contains_filter_error.data());
    return 165;
  }
  if (contains_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_filter_json.size()),
                 contains_filter_json.data(),
                 static_cast<int>(contains_filter_profile.size()),
                 contains_filter_profile.data());
    return 166;
  }
  if (contains_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS filter missing literal subject json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_filter_json.size()),
                 contains_filter_json.data(),
                 static_cast<int>(contains_filter_profile.size()),
                 contains_filter_profile.data());
    return 167;
  }
  if (contains_filter_json.find("urn:s") != std::string_view::npos ||
      contains_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS filter leaked non-matching rows json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_filter_json.size()),
                 contains_filter_json.data(),
                 static_cast<int>(contains_filter_profile.size()),
                 contains_filter_profile.data());
    return 168;
  }
  if (contains_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS filter missing profile node json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_filter_json.size()),
                 contains_filter_json.data(),
                 static_cast<int>(contains_filter_profile.size()),
                 contains_filter_profile.data());
    return 169;
  }
  xpod_qlever_adapter_release_result(adapter, &contains_filter_result);

  xpod_qlever_query_request strends_filter_request = {};
  strends_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(STRENDS(STR(?s), \"literal-s\")) } ORDER BY ?s");
  xpod_qlever_query_result strends_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strends_filter_request, &strends_filter_result);
  std::string_view strends_filter_json(
      strends_filter_result.result_json.data,
      strends_filter_result.result_json.size);
  std::string_view strends_filter_profile(
      strends_filter_result.profile_json.data,
      strends_filter_result.profile_json.size);
  std::string_view strends_filter_error(
      strends_filter_result.error_message.data,
      strends_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRENDS filter query failed: %.*s\n",
                 static_cast<int>(strends_filter_error.size()),
                 strends_filter_error.data());
    return 170;
  }
  if (strends_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "STRENDS filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_filter_json.size()),
                 strends_filter_json.data(),
                 static_cast<int>(strends_filter_profile.size()),
                 strends_filter_profile.data());
    return 171;
  }
  if (strends_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "STRENDS filter missing literal subject json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_filter_json.size()),
                 strends_filter_json.data(),
                 static_cast<int>(strends_filter_profile.size()),
                 strends_filter_profile.data());
    return 172;
  }
  if (strends_filter_json.find("urn:s") != std::string_view::npos ||
      strends_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "STRENDS filter leaked non-matching rows json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_filter_json.size()),
                 strends_filter_json.data(),
                 static_cast<int>(strends_filter_profile.size()),
                 strends_filter_profile.data());
    return 173;
  }
  if (strends_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "STRENDS filter missing profile node json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_filter_json.size()),
                 strends_filter_json.data(),
                 static_cast<int>(strends_filter_profile.size()),
                 strends_filter_profile.data());
    return 174;
  }
  xpod_qlever_adapter_release_result(adapter, &strends_filter_result);

  xpod_qlever_adapter_destroy(adapter);
  adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) {
    return 180;
  }

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
  if (join_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr,
                 "join missing urn:s json=%.*s profile=%.*s scans=%d estimates=%d\n",
                 static_cast<int>(join_json.size()), join_json.data(),
                 static_cast<int>(join_profile.size()), join_profile.data(),
                 join_scan_calls, join_estimate_distinct_calls);
    return 18;
  }
  if (join_json.find("urn:tail") == std::string_view::npos) {
    std::fprintf(stderr,
                 "join missing urn:tail json=%.*s profile=%.*s scans=%d estimates=%d\n",
                 static_cast<int>(join_json.size()), join_json.data(),
                 static_cast<int>(join_profile.size()), join_profile.data(),
                 join_scan_calls, join_estimate_distinct_calls);
    return 19;
  }
  if (join_profile.find("HashJoin") == std::string_view::npos &&
      join_profile.find("Join") == std::string_view::npos) {
    std::fprintf(stderr, "join profile missing Join node profile=%.*s\n",
                 static_cast<int>(join_profile.size()), join_profile.data());
    return 20;
  }
  if (join_json.find(R"("head":{"vars":["s","tail"]})") == std::string_view::npos) {
    std::fprintf(stderr, "join head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(join_json.size()), join_json.data(),
                 static_cast<int>(join_profile.size()), join_profile.data());
    return 21;
  }
  if (join_estimate_distinct_calls < 1) {
    std::fprintf(stderr,
                 "join did not request distinct estimates scans=%d profile=%.*s\n",
                 join_scan_calls, static_cast<int>(join_profile.size()),
                 join_profile.data());
    return 22;
  }
  if (int code = assert_native_shape_profile("join", join_profile, "Join", 1000)) {
    return code;
  }
  xpod_qlever_adapter_release_result(adapter, &join_result);

  xpod_qlever_query_request path_request = {};
  path_request.sparql = bytes(
      "SELECT ?tail WHERE { <urn:s> <urn:p>/<urn:p2> ?tail }");
  xpod_qlever_query_result path_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &path_request, &path_result);
  std::string_view path_json(path_result.result_json.data, path_result.result_json.size);
  std::string_view path_profile(path_result.profile_json.data, path_result.profile_json.size);
  std::string_view path_error(path_result.error_message.data, path_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "path query failed: %.*s\n",
                 static_cast<int>(path_error.size()), path_error.data());
    return 133;
  }
  if (path_json.find(R"("head":{"vars":["tail"]})") == std::string_view::npos) {
    std::fprintf(stderr, "path head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(path_json.size()), path_json.data(),
                 static_cast<int>(path_profile.size()), path_profile.data());
    return 134;
  }
  if (path_json.find("urn:tail") == std::string_view::npos) {
    std::fprintf(stderr, "path missing tail json=%.*s profile=%.*s\n",
                 static_cast<int>(path_json.size()), path_json.data(),
                 static_cast<int>(path_profile.size()), path_profile.data());
    return 135;
  }
  if (path_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "path leaked internal subject json=%.*s profile=%.*s\n",
                 static_cast<int>(path_json.size()), path_json.data(),
                 static_cast<int>(path_profile.size()), path_profile.data());
    return 136;
  }
  xpod_qlever_adapter_release_result(adapter, &path_result);

  xpod_qlever_query_request transitive_path_request = {};
  transitive_path_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:s> <urn:p>+ ?o }");
  xpod_qlever_query_result transitive_path_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &transitive_path_request, &transitive_path_result);
  std::string_view transitive_path_json(
      transitive_path_result.result_json.data,
      transitive_path_result.result_json.size);
  std::string_view transitive_path_profile(
      transitive_path_result.profile_json.data,
      transitive_path_result.profile_json.size);
  std::string_view transitive_path_error(
      transitive_path_result.error_message.data,
      transitive_path_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "transitive path query failed: %.*s\n",
                 static_cast<int>(transitive_path_error.size()),
                 transitive_path_error.data());
    return 137;
  }
  if (transitive_path_json.find(R"("head":{"vars":["o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "transitive path head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(transitive_path_json.size()),
                 transitive_path_json.data(),
                 static_cast<int>(transitive_path_profile.size()),
                 transitive_path_profile.data());
    return 138;
  }
  if (transitive_path_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "transitive path missing urn:o json=%.*s profile=%.*s\n",
                 static_cast<int>(transitive_path_json.size()),
                 transitive_path_json.data(),
                 static_cast<int>(transitive_path_profile.size()),
                 transitive_path_profile.data());
    return 139;
  }
  xpod_qlever_adapter_release_result(adapter, &transitive_path_result);

  xpod_qlever_query_request zero_or_more_path_request = {};
  zero_or_more_path_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:s> <urn:p>* ?o } ORDER BY ?o");
  xpod_qlever_query_result zero_or_more_path_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &zero_or_more_path_request, &zero_or_more_path_result);
  std::string_view zero_or_more_path_json(
      zero_or_more_path_result.result_json.data,
      zero_or_more_path_result.result_json.size);
  std::string_view zero_or_more_path_profile(
      zero_or_more_path_result.profile_json.data,
      zero_or_more_path_result.profile_json.size);
  std::string_view zero_or_more_path_error(
      zero_or_more_path_result.error_message.data,
      zero_or_more_path_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "zero-or-more path query failed: %.*s json=%.*s profile=%.*s\n",
                 static_cast<int>(zero_or_more_path_error.size()),
                 zero_or_more_path_error.data(),
                 static_cast<int>(zero_or_more_path_json.size()),
                 zero_or_more_path_json.data(),
                 static_cast<int>(zero_or_more_path_profile.size()),
                 zero_or_more_path_profile.data());
    return 196;
  }
  if (zero_or_more_path_json.find(R"("head":{"vars":["o"]})") == std::string_view::npos) {
    std::fprintf(stderr, "zero-or-more path head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(zero_or_more_path_json.size()),
                 zero_or_more_path_json.data(),
                 static_cast<int>(zero_or_more_path_profile.size()),
                 zero_or_more_path_profile.data());
    return 197;
  }
  if (zero_or_more_path_json.find(R"("o":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "zero-or-more path missing zero-length urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(zero_or_more_path_json.size()),
                 zero_or_more_path_json.data(),
                 static_cast<int>(zero_or_more_path_profile.size()),
                 zero_or_more_path_profile.data());
    return 198;
  }
  if (zero_or_more_path_json.find(R"("o":{"type":"uri","value":"urn:o"})") == std::string_view::npos) {
    std::fprintf(stderr, "zero-or-more path missing transitive urn:o json=%.*s profile=%.*s\n",
                 static_cast<int>(zero_or_more_path_json.size()),
                 zero_or_more_path_json.data(),
                 static_cast<int>(zero_or_more_path_profile.size()),
                 zero_or_more_path_profile.data());
    return 199;
  }
  if (zero_or_more_path_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "zero-or-more path leaked non-p edge tail json=%.*s profile=%.*s\n",
                 static_cast<int>(zero_or_more_path_json.size()),
                 zero_or_more_path_json.data(),
                 static_cast<int>(zero_or_more_path_profile.size()),
                 zero_or_more_path_profile.data());
    return 200;
  }
  if (int code = assert_native_shape_profile(
          "property path", zero_or_more_path_profile, "TransitivePath", 1030)) {
    return code;
  }
  xpod_qlever_adapter_release_result(adapter, &zero_or_more_path_result);

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
  if (modifier_json.find(R"("s":{"type":"uri")") == std::string_view::npos) return 26;
  if (modifier_json.find(R"("s":{"type":"uri","value":"urn:o"})") != std::string_view::npos) return 27;
  if (modifier_profile.find("OrderBy") == std::string_view::npos) return 28;
  if (int code = assert_native_shape_profile(
          "order limit", modifier_profile, "OrderBy", 1060)) {
    return code;
  }
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

  xpod_qlever_query_request bind_str_request = {};
  bind_str_request.sparql = bytes(
      "SELECT ?s ?label WHERE { ?s ?p ?o BIND(STR(?s) AS ?label) } ORDER BY ?s");
  xpod_qlever_query_result bind_str_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &bind_str_request, &bind_str_result);
  std::string_view bind_str_json(
      bind_str_result.result_json.data, bind_str_result.result_json.size);
  std::string_view bind_str_profile(
      bind_str_result.profile_json.data, bind_str_result.profile_json.size);
  std::string_view bind_str_error(
      bind_str_result.error_message.data, bind_str_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "bind STR query failed: %.*s json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_str_error.size()),
                 bind_str_error.data(),
                 static_cast<int>(bind_str_json.size()),
                 bind_str_json.data(),
                 static_cast<int>(bind_str_profile.size()),
                 bind_str_profile.data());
    return 181;
  }
  if (bind_str_json.find(R"("head":{"vars":["s","label"]})") == std::string_view::npos) {
    std::fprintf(stderr, "bind STR head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_str_json.size()),
                 bind_str_json.data(),
                 static_cast<int>(bind_str_profile.size()),
                 bind_str_profile.data());
    return 182;
  }
  if (bind_str_json.find(R"("s":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "bind STR missing s binding json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_str_json.size()),
                 bind_str_json.data(),
                 static_cast<int>(bind_str_profile.size()),
                 bind_str_profile.data());
    return 183;
  }
  if (bind_str_json.find(R"("label":{"type":"literal","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "bind STR missing computed literal json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_str_json.size()),
                 bind_str_json.data(),
                 static_cast<int>(bind_str_profile.size()),
                 bind_str_profile.data());
    return 184;
  }
  if (bind_str_profile.find("BIND") == std::string_view::npos) {
    std::fprintf(stderr, "bind STR missing BIND profile json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_str_json.size()),
                 bind_str_json.data(),
                 static_cast<int>(bind_str_profile.size()),
                 bind_str_profile.data());
    return 185;
  }
  xpod_qlever_adapter_release_result(adapter, &bind_str_result);

  xpod_qlever_query_request lcase_filter_request = {};
  lcase_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(LCASE(STR(?s)) = \"urn:s\") } ORDER BY ?s");
  xpod_qlever_query_result lcase_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_filter_request, &lcase_filter_result);
  std::string_view lcase_filter_json(
      lcase_filter_result.result_json.data,
      lcase_filter_result.result_json.size);
  std::string_view lcase_filter_profile(
      lcase_filter_result.profile_json.data,
      lcase_filter_result.profile_json.size);
  std::string_view lcase_filter_error(
      lcase_filter_result.error_message.data,
      lcase_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr,
                 "LCASE filter query failed: %.*s json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_filter_error.size()),
                 lcase_filter_error.data(),
                 static_cast<int>(lcase_filter_json.size()),
                 lcase_filter_json.data(),
                 static_cast<int>(lcase_filter_profile.size()),
                 lcase_filter_profile.data());
    return 186;
  }
  if (lcase_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_filter_json.size()),
                 lcase_filter_json.data(),
                 static_cast<int>(lcase_filter_profile.size()),
                 lcase_filter_profile.data());
    return 187;
  }
  if (lcase_filter_json.find(R"("s":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE filter missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_filter_json.size()),
                 lcase_filter_json.data(),
                 static_cast<int>(lcase_filter_profile.size()),
                 lcase_filter_profile.data());
    return 188;
  }
  if (lcase_filter_json.find("urn:literal-s") != std::string_view::npos ||
      lcase_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "LCASE filter leaked non-matching rows json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_filter_json.size()),
                 lcase_filter_json.data(),
                 static_cast<int>(lcase_filter_profile.size()),
                 lcase_filter_profile.data());
    return 189;
  }
  if (lcase_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE filter missing Filter profile json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_filter_json.size()),
                 lcase_filter_json.data(),
                 static_cast<int>(lcase_filter_profile.size()),
                 lcase_filter_profile.data());
    return 190;
  }
  xpod_qlever_adapter_release_result(adapter, &lcase_filter_result);

  xpod_qlever_query_request ucase_filter_request = {};
  ucase_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(UCASE(STR(?s)) = \"URN:S\") } ORDER BY ?s");
  xpod_qlever_query_result ucase_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &ucase_filter_request, &ucase_filter_result);
  std::string_view ucase_filter_json(
      ucase_filter_result.result_json.data,
      ucase_filter_result.result_json.size);
  std::string_view ucase_filter_profile(
      ucase_filter_result.profile_json.data,
      ucase_filter_result.profile_json.size);
  std::string_view ucase_filter_error(
      ucase_filter_result.error_message.data,
      ucase_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr,
                 "UCASE filter query failed: %.*s json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_filter_error.size()),
                 ucase_filter_error.data(),
                 static_cast<int>(ucase_filter_json.size()),
                 ucase_filter_json.data(),
                 static_cast<int>(ucase_filter_profile.size()),
                 ucase_filter_profile.data());
    return 191;
  }
  if (ucase_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "UCASE filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_filter_json.size()),
                 ucase_filter_json.data(),
                 static_cast<int>(ucase_filter_profile.size()),
                 ucase_filter_profile.data());
    return 192;
  }
  if (ucase_filter_json.find(R"("s":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "UCASE filter missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_filter_json.size()),
                 ucase_filter_json.data(),
                 static_cast<int>(ucase_filter_profile.size()),
                 ucase_filter_profile.data());
    return 193;
  }
  if (ucase_filter_json.find("urn:literal-s") != std::string_view::npos ||
      ucase_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "UCASE filter leaked non-matching rows json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_filter_json.size()),
                 ucase_filter_json.data(),
                 static_cast<int>(ucase_filter_profile.size()),
                 ucase_filter_profile.data());
    return 194;
  }
  if (ucase_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "UCASE filter missing Filter profile json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_filter_json.size()),
                 ucase_filter_json.data(),
                 static_cast<int>(ucase_filter_profile.size()),
                 ucase_filter_profile.data());
    return 195;
  }
  xpod_qlever_adapter_release_result(adapter, &ucase_filter_result);

  xpod_qlever_query_request exists_request = {};
  exists_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER EXISTS { ?o <urn:p2> ?tail } } ORDER BY ?s");
  xpod_qlever_query_result exists_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &exists_request, &exists_result);
  std::string_view exists_json(
      exists_result.result_json.data, exists_result.result_json.size);
  std::string_view exists_profile(
      exists_result.profile_json.data, exists_result.profile_json.size);
  std::string_view exists_error(
      exists_result.error_message.data, exists_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists query failed: %.*s\n",
                 static_cast<int>(exists_error.size()), exists_error.data());
    return 117;
  }
  if (exists_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "exists head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_json.size()), exists_json.data(),
                 static_cast<int>(exists_profile.size()), exists_profile.data());
    return 118;
  }
  if (exists_json.find(R"("s":{"type":"uri","value":"urn:s"})") == std::string_view::npos) {
    std::fprintf(stderr, "exists missing s binding json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_json.size()), exists_json.data(),
                 static_cast<int>(exists_profile.size()), exists_profile.data());
    return 119;
  }
  if (exists_profile.find("Filter") == std::string_view::npos ||
      exists_profile.find("Exists") == std::string_view::npos) {
    std::fprintf(stderr, "exists missing profile nodes json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_json.size()), exists_json.data(),
                 static_cast<int>(exists_profile.size()), exists_profile.data());
    return 121;
  }
  xpod_qlever_adapter_release_result(adapter, &exists_result);

  xpod_qlever_query_request not_exists_request = {};
  not_exists_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER NOT EXISTS { ?s <urn:p2> ?tail } } ORDER BY ?s");
  xpod_qlever_query_result not_exists_result = {};
  status = xpod_qlever_adapter_query_request(adapter, &not_exists_request, &not_exists_result);
  std::string_view not_exists_json(
      not_exists_result.result_json.data, not_exists_result.result_json.size);
  std::string_view not_exists_profile(
      not_exists_result.profile_json.data, not_exists_result.profile_json.size);
  std::string_view not_exists_error(
      not_exists_result.error_message.data, not_exists_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists query failed: %.*s\n",
                 static_cast<int>(not_exists_error.size()),
                 not_exists_error.data());
    return 127;
  }
  if (not_exists_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_json.size()),
                 not_exists_json.data(),
                 static_cast<int>(not_exists_profile.size()),
                 not_exists_profile.data());
    return 128;
  }
  if (not_exists_json.find("urn:s") == std::string_view::npos) return 129;
  if (not_exists_json.find("urn:literal-s") == std::string_view::npos) return 130;
  if (not_exists_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "not-exists leaked excluded row json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_json.size()),
                 not_exists_json.data(),
                 static_cast<int>(not_exists_profile.size()),
                 not_exists_profile.data());
    return 131;
  }
  if (not_exists_profile.find("Filter") == std::string_view::npos ||
      not_exists_profile.find("Exists") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists missing profile nodes json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_json.size()),
                 not_exists_json.data(),
                 static_cast<int>(not_exists_profile.size()),
                 not_exists_profile.data());
    return 132;
  }
  xpod_qlever_adapter_release_result(adapter, &not_exists_result);

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
  if (int code = assert_native_shape_profile("union", union_profile, "Union", 1090)) {
    return code;
  }
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
  if (optional_profile.find("OptionalJoin") == std::string_view::npos) return 40;
  if (optional_profile.find("LimitOffset") == std::string_view::npos) return 46;
  if (int code = assert_native_shape_profile(
          "optional", optional_profile, "OptionalJoin", 1120)) {
    return code;
  }
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
  if (int code = assert_native_shape_profile("minus", minus_profile, "Minus", 1150)) {
    return code;
  }
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
  if (values_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "values missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 49;
  }
  if (values_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "values missing urn:o json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 50;
  }
  if (values_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "values leaked urn:tail json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 51;
  }
  if (values_profile.find("Values") == std::string_view::npos &&
      values_profile.find("HashJoin") == std::string_view::npos) {
    std::fprintf(stderr, "values profile missing Values/HashJoin json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 52;
  }
  if (values_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "values profile missing OrderBy json=%.*s profile=%.*s\n",
                 static_cast<int>(values_json.size()), values_json.data(),
                 static_cast<int>(values_profile.size()), values_profile.data());
    return 53;
  }
  xpod_qlever_adapter_release_result(adapter, &values_result);

  int distinct_calls_before_has_predicate = state.distinct_scan_calls;
  xpod_qlever_query_request has_predicate_request = {};
  has_predicate_request.sparql = bytes(
      "SELECT ?p WHERE { <urn:s> ql:has-predicate ?p } ORDER BY ?p");
  xpod_qlever_query_result has_predicate_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &has_predicate_request, &has_predicate_result);
  std::string_view has_predicate_json(
      has_predicate_result.result_json.data,
      has_predicate_result.result_json.size);
  std::string_view has_predicate_profile(
      has_predicate_result.profile_json.data,
      has_predicate_result.profile_json.size);
  std::string_view has_predicate_error(
      has_predicate_result.error_message.data,
      has_predicate_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "has-predicate query failed: %.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_error.size()),
                 has_predicate_error.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 220;
  }
  if (has_predicate_json.find(R"("head":{"vars":["p"]})") ==
      std::string_view::npos) {
    std::fprintf(stderr, "has-predicate head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_json.size()),
                 has_predicate_json.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 221;
  }
  if (has_predicate_json.find("urn:p") == std::string_view::npos) {
    std::fprintf(stderr, "has-predicate missing urn:p json=%.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_json.size()),
                 has_predicate_json.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 222;
  }
  if (has_predicate_json.find("urn:p2") != std::string_view::npos ||
      has_predicate_json.find("urn:s") != std::string_view::npos ||
      has_predicate_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "has-predicate leaked non-predicate bindings json=%.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_json.size()),
                 has_predicate_json.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 223;
  }
  if (state.distinct_scan_calls <= distinct_calls_before_has_predicate) {
    std::fprintf(stderr, "has-predicate did not use Xpod distinct scan json=%.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_json.size()),
                 has_predicate_json.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 224;
  }
  if (has_predicate_profile.find("HasPredicateScan") == std::string_view::npos) {
    std::fprintf(stderr, "has-predicate profile missing HasPredicateScan json=%.*s profile=%.*s\n",
                 static_cast<int>(has_predicate_json.size()),
                 has_predicate_json.data(),
                 static_cast<int>(has_predicate_profile.size()),
                 has_predicate_profile.data());
    return 225;
  }
  xpod_qlever_adapter_release_result(adapter, &has_predicate_result);

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
  if (int code = assert_native_shape_profile("filter", filter_profile, "Filter", 1180)) {
    return code;
  }
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

  xpod_qlever_query_request in_filter_request = {};
  in_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:p> ?o FILTER(?o IN (<urn:o>, <urn:tail>)) } ORDER BY ?s");
  xpod_qlever_query_result in_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &in_filter_request, &in_filter_result);
  std::string_view in_filter_json(
      in_filter_result.result_json.data, in_filter_result.result_json.size);
  std::string_view in_filter_profile(
      in_filter_result.profile_json.data, in_filter_result.profile_json.size);
  std::string_view in_filter_error(
      in_filter_result.error_message.data, in_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "IN filter query failed: %.*s\n",
                 static_cast<int>(in_filter_error.size()),
                 in_filter_error.data());
    return 140;
  }
  if (in_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "IN filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_json.size()),
                 in_filter_json.data(),
                 static_cast<int>(in_filter_profile.size()),
                 in_filter_profile.data());
    return 141;
  }
  if (in_filter_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "IN filter missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_json.size()),
                 in_filter_json.data(),
                 static_cast<int>(in_filter_profile.size()),
                 in_filter_profile.data());
    return 142;
  }
  if (in_filter_json.find("urn:literal-s") != std::string_view::npos ||
      in_filter_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "IN filter leaked non-matching rows json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_json.size()),
                 in_filter_json.data(),
                 static_cast<int>(in_filter_profile.size()),
                 in_filter_profile.data());
    return 143;
  }
  xpod_qlever_adapter_release_result(adapter, &in_filter_result);

  xpod_qlever_query_request not_in_filter_request = {};
  not_in_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p ?o FILTER(?o NOT IN (<urn:tail>)) } ORDER BY ?s");
  xpod_qlever_query_result not_in_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_in_filter_request, &not_in_filter_result);
  std::string_view not_in_filter_json(
      not_in_filter_result.result_json.data,
      not_in_filter_result.result_json.size);
  std::string_view not_in_filter_profile(
      not_in_filter_result.profile_json.data,
      not_in_filter_result.profile_json.size);
  std::string_view not_in_filter_error(
      not_in_filter_result.error_message.data,
      not_in_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "NOT IN filter query failed: %.*s\n",
                 static_cast<int>(not_in_filter_error.size()),
                 not_in_filter_error.data());
    return 144;
  }
  if (not_in_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "NOT IN filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_json.size()),
                 not_in_filter_json.data(),
                 static_cast<int>(not_in_filter_profile.size()),
                 not_in_filter_profile.data());
    return 145;
  }
  if (not_in_filter_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "NOT IN filter missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_json.size()),
                 not_in_filter_json.data(),
                 static_cast<int>(not_in_filter_profile.size()),
                 not_in_filter_profile.data());
    return 146;
  }
  if (not_in_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "NOT IN filter missing literal row json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_json.size()),
                 not_in_filter_json.data(),
                 static_cast<int>(not_in_filter_profile.size()),
                 not_in_filter_profile.data());
    return 147;
  }
  if (not_in_filter_json.find("urn:o") != std::string_view::npos ||
      not_in_filter_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "NOT IN filter leaked excluded row json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_json.size()),
                 not_in_filter_json.data(),
                 static_cast<int>(not_in_filter_profile.size()),
                 not_in_filter_profile.data());
    return 148;
  }
  if (not_in_filter_profile.find("Filter") == std::string_view::npos) {
    std::fprintf(stderr, "NOT IN filter missing profile node json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_json.size()),
                 not_in_filter_json.data(),
                 static_cast<int>(not_in_filter_profile.size()),
                 not_in_filter_profile.data());
    return 149;
  }
  xpod_qlever_adapter_release_result(adapter, &not_in_filter_result);

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

  xpod_qlever_query_request literal_bgp_request = {};
  literal_bgp_request.sparql = bytes(
      "SELECT ?s WHERE { ?s ?p \"literal-value\" } ORDER BY ?s");
  xpod_qlever_query_result literal_bgp_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_bgp_request, &literal_bgp_result);
  std::string_view literal_bgp_json(
      literal_bgp_result.result_json.data, literal_bgp_result.result_json.size);
  std::string_view literal_bgp_profile(
      literal_bgp_result.profile_json.data, literal_bgp_result.profile_json.size);
  std::string_view literal_bgp_error(
      literal_bgp_result.error_message.data, literal_bgp_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal BGP query failed: %.*s\n",
                 static_cast<int>(literal_bgp_error.size()),
                 literal_bgp_error.data());
    return 122;
  }
  if (literal_bgp_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "literal BGP head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_bgp_json.size()),
                 literal_bgp_json.data(),
                 static_cast<int>(literal_bgp_profile.size()),
                 literal_bgp_profile.data());
    return 123;
  }
  if (literal_bgp_json.find("urn:literal-s") == std::string_view::npos) return 124;
  if (literal_bgp_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "literal BGP leaked non-literal row json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_bgp_json.size()),
                 literal_bgp_json.data(),
                 static_cast<int>(literal_bgp_profile.size()),
                 literal_bgp_profile.data());
    return 125;
  }
  if (literal_bgp_profile.find("IndexScan") == std::string_view::npos) return 126;
  xpod_qlever_adapter_release_result(adapter, &literal_bgp_result);

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
  if (ask_profile.find("PermutationScan") == std::string_view::npos &&
      ask_profile.find("IndexScan") == std::string_view::npos) return 64;
  xpod_qlever_adapter_release_result(adapter, &ask_result);

  xpod_qlever_query_request ask_false_request = {};
  ask_false_request.sparql = bytes("ASK { <urn:missing> ?p ?o }");
  xpod_qlever_query_result ask_false_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &ask_false_request, &ask_false_result);
  std::string_view ask_false_json(
      ask_false_result.result_json.data, ask_false_result.result_json.size);
  std::string_view ask_false_profile(
      ask_false_result.profile_json.data, ask_false_result.profile_json.size);
  std::string_view ask_false_error(
      ask_false_result.error_message.data, ask_false_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "ask false query failed: %.*s\n",
                 static_cast<int>(ask_false_error.size()),
                 ask_false_error.data());
    return 595;
  }
  if (ask_false_json.find(R"("boolean":false)") == std::string_view::npos) {
    std::fprintf(stderr, "ask false boolean mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(ask_false_json.size()),
                 ask_false_json.data(),
                 static_cast<int>(ask_false_profile.size()),
                 ask_false_profile.data());
    return 596;
  }
  if (ask_false_profile.find("Ask") == std::string_view::npos) return 597;
  xpod_qlever_adapter_release_result(adapter, &ask_false_result);

  xpod_qlever_query_request construct_request = {};
  construct_request.sparql = bytes("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");
  construct_request.accept_media_type = bytes("application/n-triples");
  xpod_qlever_query_result construct_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_request, &construct_result);
  std::string_view construct_body(
      construct_result.result_json.data, construct_result.result_json.size);
  std::string_view construct_media(
      construct_result.result_media_type.data,
      construct_result.result_media_type.size);
  std::string_view construct_profile(
      construct_result.profile_json.data, construct_result.profile_json.size);
  std::string_view construct_error(
      construct_result.error_message.data, construct_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct query failed: %.*s\n",
                 static_cast<int>(construct_error.size()),
                 construct_error.data());
    return 174;
  }
  if (construct_media != "application/n-triples") {
    std::fprintf(stderr, "construct media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_media.size()),
                 construct_media.data(),
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 175;
  }
  if (construct_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct missing iri triple body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 176;
  }
  if (construct_body.find("<urn:literal-s> <urn:p> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct missing literal triple body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 177;
  }
  if (construct_body.find("<urn:s> <urn:num> \"1\"^^<http://www.w3.org/2001/XMLSchema#integer> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct missing stored integer triple body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 533;
  }
  if (construct_body.find("<urn:s> <urn:double> \"1.5\"^^<http://www.w3.org/2001/XMLSchema#double> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct missing stored double triple body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 534;
  }
  if (construct_body.find("<urn:s> <urn:flag> \"true\"^^<http://www.w3.org/2001/XMLSchema#boolean> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct missing stored bool triple body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_body.size()),
                 construct_body.data(),
                 static_cast<int>(construct_profile.size()),
                 construct_profile.data());
    return 535;
  }
  if (construct_profile.find("Construct") == std::string_view::npos) return 178;
  xpod_qlever_adapter_release_result(adapter, &construct_result);

  xpod_qlever_query_request construct_empty_request = {};
  construct_empty_request.sparql = bytes(
      "CONSTRUCT { <urn:s> <urn:p2> ?o } WHERE { <urn:missing> ?p ?o }");
  construct_empty_request.accept_media_type = bytes("application/n-triples");
  xpod_qlever_query_result construct_empty_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_empty_request, &construct_empty_result);
  std::string_view construct_empty_body(
      construct_empty_result.result_json.data,
      construct_empty_result.result_json.size);
  std::string_view construct_empty_media(
      construct_empty_result.result_media_type.data,
      construct_empty_result.result_media_type.size);
  std::string_view construct_empty_profile(
      construct_empty_result.profile_json.data,
      construct_empty_result.profile_json.size);
  std::string_view construct_empty_error(
      construct_empty_result.error_message.data,
      construct_empty_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct empty graph query failed: %.*s\n",
                 static_cast<int>(construct_empty_error.size()),
                 construct_empty_error.data());
    return 598;
  }
  if (construct_empty_media != "application/n-triples") {
    std::fprintf(stderr, "construct empty graph media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_empty_media.size()),
                 construct_empty_media.data(),
                 static_cast<int>(construct_empty_body.size()),
                 construct_empty_body.data(),
                 static_cast<int>(construct_empty_profile.size()),
                 construct_empty_profile.data());
    return 599;
  }
  if (!construct_empty_body.empty()) {
    std::fprintf(stderr, "construct empty graph body mismatch body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_empty_body.size()),
                 construct_empty_body.data(),
                 static_cast<int>(construct_empty_profile.size()),
                 construct_empty_profile.data());
    return 600;
  }
  if (construct_empty_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct empty graph missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_empty_body.size()),
                 construct_empty_body.data(),
                 static_cast<int>(construct_empty_profile.size()),
                 construct_empty_profile.data());
    return 601;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_empty_result);

  xpod_qlever_query_request construct_accept_list_request = {};
  construct_accept_list_request.sparql = bytes(
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");
  construct_accept_list_request.accept_media_type = bytes("text/turtle, application/n-triples; q=0.9");
  xpod_qlever_query_result construct_accept_list_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_accept_list_request, &construct_accept_list_result);
  std::string_view construct_accept_list_media(
      construct_accept_list_result.result_media_type.data,
      construct_accept_list_result.result_media_type.size);
  std::string_view construct_accept_list_error(
      construct_accept_list_result.error_message.data,
      construct_accept_list_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct accept list failed: %.*s\n",
                 static_cast<int>(construct_accept_list_error.size()),
                 construct_accept_list_error.data());
    return 584;
  }
  if (construct_accept_list_media != "application/n-triples") {
    std::fprintf(stderr, "construct accept list media mismatch: %.*s\n",
                 static_cast<int>(construct_accept_list_media.size()),
                 construct_accept_list_media.data());
    return 585;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_accept_list_result);

  xpod_qlever_query_request construct_accept_q0_list_request = {};
  construct_accept_q0_list_request.sparql = bytes(
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");
  construct_accept_q0_list_request.accept_media_type = bytes("application/n-triples; q=0, application/*; q=0.5");
  xpod_qlever_query_result construct_accept_q0_list_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_accept_q0_list_request, &construct_accept_q0_list_result);
  std::string_view construct_accept_q0_list_media(
      construct_accept_q0_list_result.result_media_type.data,
      construct_accept_q0_list_result.result_media_type.size);
  std::string_view construct_accept_q0_list_error(
      construct_accept_q0_list_result.error_message.data,
      construct_accept_q0_list_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct accept q0 list failed: %.*s\n",
                 static_cast<int>(construct_accept_q0_list_error.size()),
                 construct_accept_q0_list_error.data());
    return 588;
  }
  if (construct_accept_q0_list_media != "application/n-triples") {
    std::fprintf(stderr, "construct accept q0 list media mismatch: %.*s\n",
                 static_cast<int>(construct_accept_q0_list_media.size()),
                 construct_accept_q0_list_media.data());
    return 589;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_accept_q0_list_result);

  xpod_qlever_query_request construct_accept_mismatch_request = {};
  construct_accept_mismatch_request.sparql = bytes(
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");
  construct_accept_mismatch_request.accept_media_type =
      bytes("application/sparql-results+json");
  xpod_qlever_query_result construct_accept_mismatch_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_accept_mismatch_request, &construct_accept_mismatch_result);
  std::string_view construct_accept_mismatch_error(
      construct_accept_mismatch_result.error_message.data,
      construct_accept_mismatch_result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) {
    std::fprintf(stderr, "construct accept mismatch did not fail status=%u\n",
                 static_cast<unsigned>(status));
    return 580;
  }
  if (construct_accept_mismatch_error.find("not acceptable") == std::string_view::npos) {
    std::fprintf(stderr, "construct accept mismatch error mismatch: %.*s\n",
                 static_cast<int>(construct_accept_mismatch_error.size()),
                 construct_accept_mismatch_error.data());
    return 581;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_accept_mismatch_result);

  xpod_qlever_query_request construct_constant_template_request = {};
  construct_constant_template_request.sparql = bytes(
      "CONSTRUCT { ?s <urn:p2> <urn:tail> } WHERE { ?s <urn:p> ?o }");
  xpod_qlever_query_result construct_constant_template_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_constant_template_request, &construct_constant_template_result);
  std::string_view construct_constant_template_body(
      construct_constant_template_result.result_json.data,
      construct_constant_template_result.result_json.size);
  std::string_view construct_constant_template_media(
      construct_constant_template_result.result_media_type.data,
      construct_constant_template_result.result_media_type.size);
  std::string_view construct_constant_template_profile(
      construct_constant_template_result.profile_json.data,
      construct_constant_template_result.profile_json.size);
  std::string_view construct_constant_template_error(
      construct_constant_template_result.error_message.data,
      construct_constant_template_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct constant template query failed: %.*s\n",
                 static_cast<int>(construct_constant_template_error.size()),
                 construct_constant_template_error.data());
    return 539;
  }
  if (construct_constant_template_media != "application/n-triples") {
    std::fprintf(stderr, "construct constant template media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_constant_template_media.size()),
                 construct_constant_template_media.data(),
                 static_cast<int>(construct_constant_template_body.size()),
                 construct_constant_template_body.data(),
                 static_cast<int>(construct_constant_template_profile.size()),
                 construct_constant_template_profile.data());
    return 540;
  }
  if (construct_constant_template_body.find("<urn:s> <urn:p2> <urn:tail> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct constant template missing urn:s tail body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_constant_template_body.size()),
                 construct_constant_template_body.data(),
                 static_cast<int>(construct_constant_template_profile.size()),
                 construct_constant_template_profile.data());
    return 541;
  }
  if (construct_constant_template_body.find("<urn:literal-s> <urn:p2> <urn:tail> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct constant template missing urn:literal-s tail body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_constant_template_body.size()),
                 construct_constant_template_body.data(),
                 static_cast<int>(construct_constant_template_profile.size()),
                 construct_constant_template_profile.data());
    return 542;
  }
  if (construct_constant_template_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct constant template missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_constant_template_body.size()),
                 construct_constant_template_body.data(),
                 static_cast<int>(construct_constant_template_profile.size()),
                 construct_constant_template_profile.data());
    return 543;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_constant_template_result);

  xpod_qlever_query_request construct_bind_template_request = {};
  construct_bind_template_request.sparql = bytes(
      "CONSTRUCT { ?s <urn:p2> ?label } WHERE { ?s <urn:p> ?o BIND(STR(?s) AS ?label) }");
  xpod_qlever_query_result construct_bind_template_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_bind_template_request, &construct_bind_template_result);
  std::string_view construct_bind_template_body(
      construct_bind_template_result.result_json.data,
      construct_bind_template_result.result_json.size);
  std::string_view construct_bind_template_media(
      construct_bind_template_result.result_media_type.data,
      construct_bind_template_result.result_media_type.size);
  std::string_view construct_bind_template_profile(
      construct_bind_template_result.profile_json.data,
      construct_bind_template_result.profile_json.size);
  std::string_view construct_bind_template_error(
      construct_bind_template_result.error_message.data,
      construct_bind_template_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct bind template query failed: %.*s\n",
                 static_cast<int>(construct_bind_template_error.size()),
                 construct_bind_template_error.data());
    return 550;
  }
  if (construct_bind_template_media != "application/n-triples") {
    std::fprintf(stderr, "construct bind template media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_bind_template_media.size()),
                 construct_bind_template_media.data(),
                 static_cast<int>(construct_bind_template_body.size()),
                 construct_bind_template_body.data(),
                 static_cast<int>(construct_bind_template_profile.size()),
                 construct_bind_template_profile.data());
    return 551;
  }
  if (construct_bind_template_body.find("<urn:s> <urn:p2> \"urn:s\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct bind template missing urn:s label body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_bind_template_body.size()),
                 construct_bind_template_body.data(),
                 static_cast<int>(construct_bind_template_profile.size()),
                 construct_bind_template_profile.data());
    return 552;
  }
  if (construct_bind_template_body.find("<urn:literal-s> <urn:p2> \"urn:literal-s\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct bind template missing urn:literal-s label body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_bind_template_body.size()),
                 construct_bind_template_body.data(),
                 static_cast<int>(construct_bind_template_profile.size()),
                 construct_bind_template_profile.data());
    return 553;
  }
  if (construct_bind_template_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct bind template missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_bind_template_body.size()),
                 construct_bind_template_body.data(),
                 static_cast<int>(construct_bind_template_profile.size()),
                 construct_bind_template_profile.data());
    return 554;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_bind_template_result);

  xpod_qlever_query_request construct_iri_bind_template_request = {};
  construct_iri_bind_template_request.sparql = bytes(
      "CONSTRUCT { ?s ?p2 ?o } WHERE { ?s <urn:p> ?o BIND(IRI(\"urn:p2\") AS ?p2) }");
  xpod_qlever_query_result construct_iri_bind_template_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_iri_bind_template_request, &construct_iri_bind_template_result);
  std::string_view construct_iri_bind_template_body(
      construct_iri_bind_template_result.result_json.data,
      construct_iri_bind_template_result.result_json.size);
  std::string_view construct_iri_bind_template_media(
      construct_iri_bind_template_result.result_media_type.data,
      construct_iri_bind_template_result.result_media_type.size);
  std::string_view construct_iri_bind_template_profile(
      construct_iri_bind_template_result.profile_json.data,
      construct_iri_bind_template_result.profile_json.size);
  std::string_view construct_iri_bind_template_error(
      construct_iri_bind_template_result.error_message.data,
      construct_iri_bind_template_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct iri bind template query failed: %.*s\n",
                 static_cast<int>(construct_iri_bind_template_error.size()),
                 construct_iri_bind_template_error.data());
    return 555;
  }
  if (construct_iri_bind_template_media != "application/n-triples") {
    std::fprintf(stderr, "construct iri bind template media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_iri_bind_template_media.size()),
                 construct_iri_bind_template_media.data(),
                 static_cast<int>(construct_iri_bind_template_body.size()),
                 construct_iri_bind_template_body.data(),
                 static_cast<int>(construct_iri_bind_template_profile.size()),
                 construct_iri_bind_template_profile.data());
    return 556;
  }
  if (construct_iri_bind_template_body.find("<urn:s> <urn:p2> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct iri bind template missing urn:s row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_iri_bind_template_body.size()),
                 construct_iri_bind_template_body.data(),
                 static_cast<int>(construct_iri_bind_template_profile.size()),
                 construct_iri_bind_template_profile.data());
    return 557;
  }
  if (construct_iri_bind_template_body.find("<urn:literal-s> <urn:p2> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct iri bind template missing urn:literal-s row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_iri_bind_template_body.size()),
                 construct_iri_bind_template_body.data(),
                 static_cast<int>(construct_iri_bind_template_profile.size()),
                 construct_iri_bind_template_profile.data());
    return 558;
  }
  if (construct_iri_bind_template_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct iri bind template missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_iri_bind_template_body.size()),
                 construct_iri_bind_template_body.data(),
                 static_cast<int>(construct_iri_bind_template_profile.size()),
                 construct_iri_bind_template_profile.data());
    return 559;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_iri_bind_template_result);

  xpod_qlever_query_request construct_subject_iri_bind_template_request = {};
  construct_subject_iri_bind_template_request.sparql = bytes(
      "CONSTRUCT { ?copy <urn:p2> ?o } WHERE { ?s <urn:p> ?o BIND(IRI(\"urn:copy\") AS ?copy) }");
  xpod_qlever_query_result construct_subject_iri_bind_template_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_subject_iri_bind_template_request, &construct_subject_iri_bind_template_result);
  std::string_view construct_subject_iri_bind_template_body(
      construct_subject_iri_bind_template_result.result_json.data,
      construct_subject_iri_bind_template_result.result_json.size);
  std::string_view construct_subject_iri_bind_template_media(
      construct_subject_iri_bind_template_result.result_media_type.data,
      construct_subject_iri_bind_template_result.result_media_type.size);
  std::string_view construct_subject_iri_bind_template_profile(
      construct_subject_iri_bind_template_result.profile_json.data,
      construct_subject_iri_bind_template_result.profile_json.size);
  std::string_view construct_subject_iri_bind_template_error(
      construct_subject_iri_bind_template_result.error_message.data,
      construct_subject_iri_bind_template_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct subject iri bind template query failed: %.*s\n",
                 static_cast<int>(construct_subject_iri_bind_template_error.size()),
                 construct_subject_iri_bind_template_error.data());
    return 560;
  }
  if (construct_subject_iri_bind_template_media != "application/n-triples") {
    std::fprintf(stderr, "construct subject iri bind template media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_subject_iri_bind_template_media.size()),
                 construct_subject_iri_bind_template_media.data(),
                 static_cast<int>(construct_subject_iri_bind_template_body.size()),
                 construct_subject_iri_bind_template_body.data(),
                 static_cast<int>(construct_subject_iri_bind_template_profile.size()),
                 construct_subject_iri_bind_template_profile.data());
    return 561;
  }
  if (construct_subject_iri_bind_template_body.find("<urn:copy> <urn:p2> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct subject iri bind template missing urn:o row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_subject_iri_bind_template_body.size()),
                 construct_subject_iri_bind_template_body.data(),
                 static_cast<int>(construct_subject_iri_bind_template_profile.size()),
                 construct_subject_iri_bind_template_profile.data());
    return 562;
  }
  if (construct_subject_iri_bind_template_body.find("<urn:copy> <urn:p2> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct subject iri bind template missing literal row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_subject_iri_bind_template_body.size()),
                 construct_subject_iri_bind_template_body.data(),
                 static_cast<int>(construct_subject_iri_bind_template_profile.size()),
                 construct_subject_iri_bind_template_profile.data());
    return 563;
  }
  if (construct_subject_iri_bind_template_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct subject iri bind template missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_subject_iri_bind_template_body.size()),
                 construct_subject_iri_bind_template_body.data(),
                 static_cast<int>(construct_subject_iri_bind_template_profile.size()),
                 construct_subject_iri_bind_template_profile.data());
    return 564;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_subject_iri_bind_template_result);

  xpod_qlever_query_request construct_blank_template_request = {};
  construct_blank_template_request.sparql = bytes(
      "CONSTRUCT { _:copy <urn:p2> ?o } WHERE { ?s <urn:p> ?o }");
  xpod_qlever_query_result construct_blank_template_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_blank_template_request, &construct_blank_template_result);
  std::string_view construct_blank_template_body(
      construct_blank_template_result.result_json.data,
      construct_blank_template_result.result_json.size);
  std::string_view construct_blank_template_media(
      construct_blank_template_result.result_media_type.data,
      construct_blank_template_result.result_media_type.size);
  std::string_view construct_blank_template_profile(
      construct_blank_template_result.profile_json.data,
      construct_blank_template_result.profile_json.size);
  std::string_view construct_blank_template_error(
      construct_blank_template_result.error_message.data,
      construct_blank_template_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct blank template query failed: %.*s\n",
                 static_cast<int>(construct_blank_template_error.size()),
                 construct_blank_template_error.data());
    return 565;
  }
  if (construct_blank_template_media != "application/n-triples") {
    std::fprintf(stderr, "construct blank template media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_blank_template_media.size()),
                 construct_blank_template_media.data(),
                 static_cast<int>(construct_blank_template_body.size()),
                 construct_blank_template_body.data(),
                 static_cast<int>(construct_blank_template_profile.size()),
                 construct_blank_template_profile.data());
    return 566;
  }
  if (construct_blank_template_body.find("_:") == std::string_view::npos ||
      construct_blank_template_body.find(" <urn:p2> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct blank template missing iri object row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_blank_template_body.size()),
                 construct_blank_template_body.data(),
                 static_cast<int>(construct_blank_template_profile.size()),
                 construct_blank_template_profile.data());
    return 567;
  }
  if (construct_blank_template_body.find("_:") == std::string_view::npos ||
      construct_blank_template_body.find(" <urn:p2> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct blank template missing literal object row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_blank_template_body.size()),
                 construct_blank_template_body.data(),
                 static_cast<int>(construct_blank_template_profile.size()),
                 construct_blank_template_profile.data());
    return 568;
  }
  if (construct_blank_template_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct blank template missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_blank_template_body.size()),
                 construct_blank_template_body.data(),
                 static_cast<int>(construct_blank_template_profile.size()),
                 construct_blank_template_profile.data());
    return 569;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_blank_template_result);

  xpod_qlever_query_request construct_graph_request = {};
  construct_graph_request.sparql = bytes(
      "CONSTRUCT { ?s <urn:p2> ?o } WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } }");
  xpod_qlever_query_result construct_graph_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_graph_request, &construct_graph_result);
  std::string_view construct_graph_body(
      construct_graph_result.result_json.data,
      construct_graph_result.result_json.size);
  std::string_view construct_graph_media(
      construct_graph_result.result_media_type.data,
      construct_graph_result.result_media_type.size);
  std::string_view construct_graph_profile(
      construct_graph_result.profile_json.data,
      construct_graph_result.profile_json.size);
  std::string_view construct_graph_error(
      construct_graph_result.error_message.data,
      construct_graph_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct graph query failed: %.*s\n",
                 static_cast<int>(construct_graph_error.size()),
                 construct_graph_error.data());
    return 640;
  }
  if (construct_graph_media != "application/n-triples") {
    std::fprintf(stderr, "construct graph media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_media.size()),
                 construct_graph_media.data(),
                 static_cast<int>(construct_graph_body.size()),
                 construct_graph_body.data(),
                 static_cast<int>(construct_graph_profile.size()),
                 construct_graph_profile.data());
    return 641;
  }
  if (construct_graph_body.find("<urn:s> <urn:p2> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct graph missing urn:s row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_body.size()),
                 construct_graph_body.data(),
                 static_cast<int>(construct_graph_profile.size()),
                 construct_graph_profile.data());
    return 642;
  }
  if (construct_graph_body.find("<urn:g>") != std::string_view::npos) {
    std::fprintf(stderr, "construct graph leaked graph iri body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_body.size()),
                 construct_graph_body.data(),
                 static_cast<int>(construct_graph_profile.size()),
                 construct_graph_profile.data());
    return 643;
  }
  if (construct_graph_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct graph missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_body.size()),
                 construct_graph_body.data(),
                 static_cast<int>(construct_graph_profile.size()),
                 construct_graph_profile.data());
    return 644;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_graph_result);

  xpod_qlever_query_request construct_graph_variable_request = {};
  construct_graph_variable_request.sparql = bytes(
      "CONSTRUCT { ?s <urn:p2> ?o } WHERE { GRAPH ?g { ?s <urn:p> ?o } }");
  xpod_qlever_query_result construct_graph_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &construct_graph_variable_request, &construct_graph_variable_result);
  std::string_view construct_graph_variable_body(
      construct_graph_variable_result.result_json.data,
      construct_graph_variable_result.result_json.size);
  std::string_view construct_graph_variable_media(
      construct_graph_variable_result.result_media_type.data,
      construct_graph_variable_result.result_media_type.size);
  std::string_view construct_graph_variable_profile(
      construct_graph_variable_result.profile_json.data,
      construct_graph_variable_result.profile_json.size);
  std::string_view construct_graph_variable_error(
      construct_graph_variable_result.error_message.data,
      construct_graph_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "construct graph variable query failed: %.*s\n",
                 static_cast<int>(construct_graph_variable_error.size()),
                 construct_graph_variable_error.data());
    return 645;
  }
  if (construct_graph_variable_media != "application/n-triples") {
    std::fprintf(stderr, "construct graph variable media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_variable_media.size()),
                 construct_graph_variable_media.data(),
                 static_cast<int>(construct_graph_variable_body.size()),
                 construct_graph_variable_body.data(),
                 static_cast<int>(construct_graph_variable_profile.size()),
                 construct_graph_variable_profile.data());
    return 646;
  }
  if (construct_graph_variable_body.find("<urn:s> <urn:p2> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "construct graph variable missing urn:s row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_variable_body.size()),
                 construct_graph_variable_body.data(),
                 static_cast<int>(construct_graph_variable_profile.size()),
                 construct_graph_variable_profile.data());
    return 647;
  }
  if (construct_graph_variable_body.find("<urn:literal-s> <urn:p2> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "construct graph variable missing literal row body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_variable_body.size()),
                 construct_graph_variable_body.data(),
                 static_cast<int>(construct_graph_variable_profile.size()),
                 construct_graph_variable_profile.data());
    return 648;
  }
  if (construct_graph_variable_body.find("<urn:g>") != std::string_view::npos) {
    std::fprintf(stderr, "construct graph variable leaked graph iri body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_variable_body.size()),
                 construct_graph_variable_body.data(),
                 static_cast<int>(construct_graph_variable_profile.size()),
                 construct_graph_variable_profile.data());
    return 649;
  }
  if (construct_graph_variable_profile.find("Construct") == std::string_view::npos) {
    std::fprintf(stderr, "construct graph variable missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(construct_graph_variable_body.size()),
                 construct_graph_variable_body.data(),
                 static_cast<int>(construct_graph_variable_profile.size()),
                 construct_graph_variable_profile.data());
    return 650;
  }
  xpod_qlever_adapter_release_result(adapter, &construct_graph_variable_result);

  xpod_qlever_query_request describe_request = {};
  describe_request.sparql = bytes("DESCRIBE <urn:s>");
  xpod_qlever_query_result describe_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_request, &describe_result);
  std::string_view describe_body(
      describe_result.result_json.data, describe_result.result_json.size);
  std::string_view describe_media(
      describe_result.result_media_type.data,
      describe_result.result_media_type.size);
  std::string_view describe_profile(
      describe_result.profile_json.data, describe_result.profile_json.size);
  std::string_view describe_error(
      describe_result.error_message.data, describe_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe query failed: %.*s\n",
                 static_cast<int>(describe_error.size()),
                 describe_error.data());
    return 179;
  }
  if (describe_media != "application/n-triples") {
    std::fprintf(stderr, "describe media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_media.size()),
                 describe_media.data(),
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 180;
  }
  if (describe_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing subject triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 181;
  }
  if (describe_body.find("<urn:s> <urn:num> \"1\"^^<http://www.w3.org/2001/XMLSchema#integer> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing stored integer triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 536;
  }
  if (describe_body.find("<urn:s> <urn:double> \"1.5\"^^<http://www.w3.org/2001/XMLSchema#double> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing stored double triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 537;
  }
  if (describe_body.find("<urn:s> <urn:flag> \"true\"^^<http://www.w3.org/2001/XMLSchema#boolean> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing stored bool triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 538;
  }
  if (describe_body.find("<urn:literal-s>") != std::string_view::npos) {
    std::fprintf(stderr, "describe leaked other subject body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 182;
  }
  if (describe_profile.find("Describe") == std::string_view::npos &&
      describe_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_body.size()),
                 describe_body.data(),
                 static_cast<int>(describe_profile.size()),
                 describe_profile.data());
    return 183;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_result);

  xpod_qlever_query_request describe_missing_iri_request = {};
  describe_missing_iri_request.sparql = bytes("DESCRIBE <urn:missing>");
  xpod_qlever_query_result describe_missing_iri_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_missing_iri_request, &describe_missing_iri_result);
  std::string_view describe_missing_iri_body(
      describe_missing_iri_result.result_json.data,
      describe_missing_iri_result.result_json.size);
  std::string_view describe_missing_iri_media(
      describe_missing_iri_result.result_media_type.data,
      describe_missing_iri_result.result_media_type.size);
  std::string_view describe_missing_iri_profile(
      describe_missing_iri_result.profile_json.data,
      describe_missing_iri_result.profile_json.size);
  std::string_view describe_missing_iri_error(
      describe_missing_iri_result.error_message.data,
      describe_missing_iri_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe missing iri query failed: %.*s\n",
                 static_cast<int>(describe_missing_iri_error.size()),
                 describe_missing_iri_error.data());
    return 602;
  }
  if (describe_missing_iri_media != "application/n-triples") {
    std::fprintf(stderr, "describe missing iri media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_missing_iri_media.size()),
                 describe_missing_iri_media.data(),
                 static_cast<int>(describe_missing_iri_body.size()),
                 describe_missing_iri_body.data(),
                 static_cast<int>(describe_missing_iri_profile.size()),
                 describe_missing_iri_profile.data());
    return 603;
  }
  if (!describe_missing_iri_body.empty()) {
    std::fprintf(stderr, "describe missing iri body mismatch body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_missing_iri_body.size()),
                 describe_missing_iri_body.data(),
                 static_cast<int>(describe_missing_iri_profile.size()),
                 describe_missing_iri_profile.data());
    return 604;
  }
  if (describe_missing_iri_profile.find("Describe") == std::string_view::npos &&
      describe_missing_iri_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe missing iri missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_missing_iri_body.size()),
                 describe_missing_iri_body.data(),
                 static_cast<int>(describe_missing_iri_profile.size()),
                 describe_missing_iri_profile.data());
    return 605;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_missing_iri_result);

  xpod_qlever_query_request describe_variable_request = {};
  describe_variable_request.sparql = bytes(
      "DESCRIBE ?s WHERE { ?s <urn:p> <urn:o> }");
  xpod_qlever_query_result describe_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_variable_request, &describe_variable_result);
  std::string_view describe_variable_body(
      describe_variable_result.result_json.data,
      describe_variable_result.result_json.size);
  std::string_view describe_variable_media(
      describe_variable_result.result_media_type.data,
      describe_variable_result.result_media_type.size);
  std::string_view describe_variable_profile(
      describe_variable_result.profile_json.data,
      describe_variable_result.profile_json.size);
  std::string_view describe_variable_error(
      describe_variable_result.error_message.data,
      describe_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe variable query failed: %.*s\n",
                 static_cast<int>(describe_variable_error.size()),
                 describe_variable_error.data());
    return 544;
  }
  if (describe_variable_media != "application/n-triples") {
    std::fprintf(stderr, "describe variable media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_media.size()),
                 describe_variable_media.data(),
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 545;
  }
  if (describe_variable_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe variable missing subject triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 546;
  }
  if (describe_variable_body.find("<urn:s> <urn:num> \"1\"^^<http://www.w3.org/2001/XMLSchema#integer> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe variable missing stored integer triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 547;
  }
  if (describe_variable_body.find("<urn:s> <urn:double> \"1.5\"^^<http://www.w3.org/2001/XMLSchema#double> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe variable missing stored double triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 1301;
  }
  if (describe_variable_body.find("<urn:literal-s>") != std::string_view::npos) {
    std::fprintf(stderr, "describe variable leaked other subject body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 548;
  }
  if (describe_variable_profile.find("Describe") == std::string_view::npos &&
      describe_variable_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe variable missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_variable_body.size()),
                 describe_variable_body.data(),
                 static_cast<int>(describe_variable_profile.size()),
                 describe_variable_profile.data());
    return 549;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_variable_result);

  xpod_qlever_query_request describe_star_request = {};
  describe_star_request.sparql = bytes(
      "DESCRIBE * WHERE { ?s <urn:p> <urn:o> }");
  xpod_qlever_query_result describe_star_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_star_request, &describe_star_result);
  std::string_view describe_star_body(
      describe_star_result.result_json.data,
      describe_star_result.result_json.size);
  std::string_view describe_star_media(
      describe_star_result.result_media_type.data,
      describe_star_result.result_media_type.size);
  std::string_view describe_star_profile(
      describe_star_result.profile_json.data,
      describe_star_result.profile_json.size);
  std::string_view describe_star_error(
      describe_star_result.error_message.data,
      describe_star_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe star query failed: %.*s\n",
                 static_cast<int>(describe_star_error.size()),
                 describe_star_error.data());
    return 620;
  }
  if (describe_star_media != "application/n-triples") {
    std::fprintf(stderr, "describe star media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_star_media.size()),
                 describe_star_media.data(),
                 static_cast<int>(describe_star_body.size()),
                 describe_star_body.data(),
                 static_cast<int>(describe_star_profile.size()),
                 describe_star_profile.data());
    return 621;
  }
  if (describe_star_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe star missing subject triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_star_body.size()),
                 describe_star_body.data(),
                 static_cast<int>(describe_star_profile.size()),
                 describe_star_profile.data());
    return 622;
  }
  if (describe_star_body.find("<urn:literal-s>") != std::string_view::npos) {
    std::fprintf(stderr, "describe star leaked other subject body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_star_body.size()),
                 describe_star_body.data(),
                 static_cast<int>(describe_star_profile.size()),
                 describe_star_profile.data());
    return 623;
  }
  if (describe_star_profile.find("Describe") == std::string_view::npos &&
      describe_star_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe star missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_star_body.size()),
                 describe_star_body.data(),
                 static_cast<int>(describe_star_profile.size()),
                 describe_star_profile.data());
    return 624;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_star_result);

  xpod_qlever_query_request describe_empty_variable_request = {};
  describe_empty_variable_request.sparql = bytes(
      "DESCRIBE ?s WHERE { ?s <urn:p> <urn:missing> }");
  xpod_qlever_query_result describe_empty_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_empty_variable_request, &describe_empty_variable_result);
  std::string_view describe_empty_variable_body(
      describe_empty_variable_result.result_json.data,
      describe_empty_variable_result.result_json.size);
  std::string_view describe_empty_variable_media(
      describe_empty_variable_result.result_media_type.data,
      describe_empty_variable_result.result_media_type.size);
  std::string_view describe_empty_variable_profile(
      describe_empty_variable_result.profile_json.data,
      describe_empty_variable_result.profile_json.size);
  std::string_view describe_empty_variable_error(
      describe_empty_variable_result.error_message.data,
      describe_empty_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe empty variable query failed: %.*s\n",
                 static_cast<int>(describe_empty_variable_error.size()),
                 describe_empty_variable_error.data());
    return 606;
  }
  if (describe_empty_variable_media != "application/n-triples") {
    std::fprintf(stderr, "describe empty variable media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_empty_variable_media.size()),
                 describe_empty_variable_media.data(),
                 static_cast<int>(describe_empty_variable_body.size()),
                 describe_empty_variable_body.data(),
                 static_cast<int>(describe_empty_variable_profile.size()),
                 describe_empty_variable_profile.data());
    return 607;
  }
  if (!describe_empty_variable_body.empty()) {
    std::fprintf(stderr, "describe empty variable body mismatch body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_empty_variable_body.size()),
                 describe_empty_variable_body.data(),
                 static_cast<int>(describe_empty_variable_profile.size()),
                 describe_empty_variable_profile.data());
    return 608;
  }
  if (describe_empty_variable_profile.find("Describe") == std::string_view::npos &&
      describe_empty_variable_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe empty variable missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_empty_variable_body.size()),
                 describe_empty_variable_body.data(),
                 static_cast<int>(describe_empty_variable_profile.size()),
                 describe_empty_variable_profile.data());
    return 609;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_empty_variable_result);

  xpod_qlever_query_request describe_multi_variable_request = {};
  describe_multi_variable_request.sparql = bytes(
      "DESCRIBE ?s WHERE { ?s <urn:p> ?o }");
  xpod_qlever_query_result describe_multi_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_multi_variable_request, &describe_multi_variable_result);
  std::string_view describe_multi_variable_body(
      describe_multi_variable_result.result_json.data,
      describe_multi_variable_result.result_json.size);
  std::string_view describe_multi_variable_media(
      describe_multi_variable_result.result_media_type.data,
      describe_multi_variable_result.result_media_type.size);
  std::string_view describe_multi_variable_profile(
      describe_multi_variable_result.profile_json.data,
      describe_multi_variable_result.profile_json.size);
  std::string_view describe_multi_variable_error(
      describe_multi_variable_result.error_message.data,
      describe_multi_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe multi variable query failed: %.*s\n",
                 static_cast<int>(describe_multi_variable_error.size()),
                 describe_multi_variable_error.data());
    return 570;
  }
  if (describe_multi_variable_media != "application/n-triples") {
    std::fprintf(stderr, "describe multi variable media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_variable_media.size()),
                 describe_multi_variable_media.data(),
                 static_cast<int>(describe_multi_variable_body.size()),
                 describe_multi_variable_body.data(),
                 static_cast<int>(describe_multi_variable_profile.size()),
                 describe_multi_variable_profile.data());
    return 571;
  }
  if (describe_multi_variable_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi variable missing urn:s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_variable_body.size()),
                 describe_multi_variable_body.data(),
                 static_cast<int>(describe_multi_variable_profile.size()),
                 describe_multi_variable_profile.data());
    return 572;
  }
  if (describe_multi_variable_body.find("<urn:literal-s> <urn:p> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi variable missing urn:literal-s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_variable_body.size()),
                 describe_multi_variable_body.data(),
                 static_cast<int>(describe_multi_variable_profile.size()),
                 describe_multi_variable_profile.data());
    return 573;
  }
  if (describe_multi_variable_profile.find("Describe") == std::string_view::npos &&
      describe_multi_variable_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi variable missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_variable_body.size()),
                 describe_multi_variable_body.data(),
                 static_cast<int>(describe_multi_variable_profile.size()),
                 describe_multi_variable_profile.data());
    return 574;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_multi_variable_result);

  xpod_qlever_query_request describe_multi_resource_variable_request = {};
  describe_multi_resource_variable_request.sparql = bytes(
      "DESCRIBE ?s ?o WHERE { ?s <urn:p> ?o }");
  xpod_qlever_query_result describe_multi_resource_variable_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_multi_resource_variable_request, &describe_multi_resource_variable_result);
  std::string_view describe_multi_resource_variable_body(
      describe_multi_resource_variable_result.result_json.data,
      describe_multi_resource_variable_result.result_json.size);
  std::string_view describe_multi_resource_variable_media(
      describe_multi_resource_variable_result.result_media_type.data,
      describe_multi_resource_variable_result.result_media_type.size);
  std::string_view describe_multi_resource_variable_profile(
      describe_multi_resource_variable_result.profile_json.data,
      describe_multi_resource_variable_result.profile_json.size);
  std::string_view describe_multi_resource_variable_error(
      describe_multi_resource_variable_result.error_message.data,
      describe_multi_resource_variable_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe multi resource variable query failed: %.*s\n",
                 static_cast<int>(describe_multi_resource_variable_error.size()),
                 describe_multi_resource_variable_error.data());
    return 630;
  }
  if (describe_multi_resource_variable_media != "application/n-triples") {
    std::fprintf(stderr, "describe multi resource variable media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_resource_variable_media.size()),
                 describe_multi_resource_variable_media.data(),
                 static_cast<int>(describe_multi_resource_variable_body.size()),
                 describe_multi_resource_variable_body.data(),
                 static_cast<int>(describe_multi_resource_variable_profile.size()),
                 describe_multi_resource_variable_profile.data());
    return 631;
  }
  if (describe_multi_resource_variable_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi resource variable missing urn:s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_resource_variable_body.size()),
                 describe_multi_resource_variable_body.data(),
                 static_cast<int>(describe_multi_resource_variable_profile.size()),
                 describe_multi_resource_variable_profile.data());
    return 632;
  }
  if (describe_multi_resource_variable_body.find("<urn:o> <urn:p2> <urn:tail> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi resource variable missing urn:o triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_resource_variable_body.size()),
                 describe_multi_resource_variable_body.data(),
                 static_cast<int>(describe_multi_resource_variable_profile.size()),
                 describe_multi_resource_variable_profile.data());
    return 633;
  }
  if (describe_multi_resource_variable_body.find("\"literal-value\" <") != std::string_view::npos) {
    std::fprintf(stderr, "describe multi resource variable leaked literal as subject body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_resource_variable_body.size()),
                 describe_multi_resource_variable_body.data(),
                 static_cast<int>(describe_multi_resource_variable_profile.size()),
                 describe_multi_resource_variable_profile.data());
    return 634;
  }
  if (describe_multi_resource_variable_profile.find("Describe") == std::string_view::npos &&
      describe_multi_resource_variable_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe multi resource variable missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_multi_resource_variable_body.size()),
                 describe_multi_resource_variable_body.data(),
                 static_cast<int>(describe_multi_resource_variable_profile.size()),
                 describe_multi_resource_variable_profile.data());
    return 635;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_multi_resource_variable_result);

  xpod_qlever_query_request describe_explicit_multi_request = {};
  describe_explicit_multi_request.sparql = bytes("DESCRIBE <urn:s> <urn:literal-s>");
  xpod_qlever_query_result describe_explicit_multi_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_explicit_multi_request, &describe_explicit_multi_result);
  std::string_view describe_explicit_multi_body(
      describe_explicit_multi_result.result_json.data,
      describe_explicit_multi_result.result_json.size);
  std::string_view describe_explicit_multi_media(
      describe_explicit_multi_result.result_media_type.data,
      describe_explicit_multi_result.result_media_type.size);
  std::string_view describe_explicit_multi_profile(
      describe_explicit_multi_result.profile_json.data,
      describe_explicit_multi_result.profile_json.size);
  std::string_view describe_explicit_multi_error(
      describe_explicit_multi_result.error_message.data,
      describe_explicit_multi_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe explicit multi query failed: %.*s\n",
                 static_cast<int>(describe_explicit_multi_error.size()),
                 describe_explicit_multi_error.data());
    return 590;
  }
  if (describe_explicit_multi_media != "application/n-triples") {
    std::fprintf(stderr, "describe explicit multi media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_multi_media.size()),
                 describe_explicit_multi_media.data(),
                 static_cast<int>(describe_explicit_multi_body.size()),
                 describe_explicit_multi_body.data(),
                 static_cast<int>(describe_explicit_multi_profile.size()),
                 describe_explicit_multi_profile.data());
    return 591;
  }
  if (describe_explicit_multi_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe explicit multi missing urn:s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_multi_body.size()),
                 describe_explicit_multi_body.data(),
                 static_cast<int>(describe_explicit_multi_profile.size()),
                 describe_explicit_multi_profile.data());
    return 592;
  }
  if (describe_explicit_multi_body.find("<urn:literal-s> <urn:p> \"literal-value\" .") == std::string_view::npos) {
    std::fprintf(stderr, "describe explicit multi missing urn:literal-s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_multi_body.size()),
                 describe_explicit_multi_body.data(),
                 static_cast<int>(describe_explicit_multi_profile.size()),
                 describe_explicit_multi_profile.data());
    return 593;
  }
  if (describe_explicit_multi_profile.find("Describe") == std::string_view::npos &&
      describe_explicit_multi_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe explicit multi missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_multi_body.size()),
                 describe_explicit_multi_body.data(),
                 static_cast<int>(describe_explicit_multi_profile.size()),
                 describe_explicit_multi_profile.data());
    return 594;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_explicit_multi_result);

  xpod_qlever_query_request describe_explicit_mixed_request = {};
  describe_explicit_mixed_request.sparql = bytes("DESCRIBE <urn:s> <urn:missing>");
  xpod_qlever_query_result describe_explicit_mixed_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &describe_explicit_mixed_request, &describe_explicit_mixed_result);
  std::string_view describe_explicit_mixed_body(
      describe_explicit_mixed_result.result_json.data,
      describe_explicit_mixed_result.result_json.size);
  std::string_view describe_explicit_mixed_media(
      describe_explicit_mixed_result.result_media_type.data,
      describe_explicit_mixed_result.result_media_type.size);
  std::string_view describe_explicit_mixed_profile(
      describe_explicit_mixed_result.profile_json.data,
      describe_explicit_mixed_result.profile_json.size);
  std::string_view describe_explicit_mixed_error(
      describe_explicit_mixed_result.error_message.data,
      describe_explicit_mixed_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "describe explicit mixed query failed: %.*s\n",
                 static_cast<int>(describe_explicit_mixed_error.size()),
                 describe_explicit_mixed_error.data());
    return 610;
  }
  if (describe_explicit_mixed_media != "application/n-triples") {
    std::fprintf(stderr, "describe explicit mixed media mismatch media=%.*s body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_mixed_media.size()),
                 describe_explicit_mixed_media.data(),
                 static_cast<int>(describe_explicit_mixed_body.size()),
                 describe_explicit_mixed_body.data(),
                 static_cast<int>(describe_explicit_mixed_profile.size()),
                 describe_explicit_mixed_profile.data());
    return 611;
  }
  if (describe_explicit_mixed_body.find("<urn:s> <urn:p> <urn:o> .") == std::string_view::npos) {
    std::fprintf(stderr, "describe explicit mixed missing urn:s triple body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_mixed_body.size()),
                 describe_explicit_mixed_body.data(),
                 static_cast<int>(describe_explicit_mixed_profile.size()),
                 describe_explicit_mixed_profile.data());
    return 612;
  }
  if (describe_explicit_mixed_body.find("<urn:missing>") != std::string_view::npos) {
    std::fprintf(stderr, "describe explicit mixed leaked missing iri body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_mixed_body.size()),
                 describe_explicit_mixed_body.data(),
                 static_cast<int>(describe_explicit_mixed_profile.size()),
                 describe_explicit_mixed_profile.data());
    return 613;
  }
  if (describe_explicit_mixed_profile.find("Describe") == std::string_view::npos &&
      describe_explicit_mixed_profile.find("DESCRIBE") == std::string_view::npos) {
    std::fprintf(stderr, "describe explicit mixed missing profile body=%.*s profile=%.*s\n",
                 static_cast<int>(describe_explicit_mixed_body.size()),
                 describe_explicit_mixed_body.data(),
                 static_cast<int>(describe_explicit_mixed_profile.size()),
                 describe_explicit_mixed_profile.data());
    return 614;
  }
  xpod_qlever_adapter_release_result(adapter, &describe_explicit_mixed_result);

  xpod_qlever_query_request create_noop_request = {};
  create_noop_request.sparql = bytes("CREATE GRAPH <urn:created>");
  xpod_qlever_query_result create_noop_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &create_noop_request, &create_noop_result);
  std::string_view create_noop_json(
      create_noop_result.result_json.data,
      create_noop_result.result_json.size);
  std::string_view create_noop_profile(
      create_noop_result.profile_json.data,
      create_noop_result.profile_json.size);
  std::string_view create_noop_error(
      create_noop_result.error_message.data,
      create_noop_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "CREATE no-op update failed: %.*s\n",
                 static_cast<int>(create_noop_error.size()),
                 create_noop_error.data());
    return 636;
  }
  if (state.mutation_calls != 0) {
    std::fprintf(stderr, "CREATE no-op update called backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(create_noop_json.size()),
                 create_noop_json.data(),
                 static_cast<int>(create_noop_profile.size()),
                 create_noop_profile.data());
    return 637;
  }
  if (create_noop_json.find(R"("inserted":0)") == std::string_view::npos ||
      create_noop_json.find(R"("deleted":0)") == std::string_view::npos ||
      create_noop_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "CREATE no-op update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(create_noop_json.size()),
                 create_noop_json.data(),
                 static_cast<int>(create_noop_profile.size()),
                 create_noop_profile.data());
    return 638;
  }
  xpod_qlever_adapter_release_result(adapter, &create_noop_result);

  xpod_qlever_query_request insert_data_request = {};
  insert_data_request.sparql = bytes("INSERT DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result insert_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &insert_data_request, &insert_data_result);
  std::string_view insert_data_json(
      insert_data_result.result_json.data,
      insert_data_result.result_json.size);
  std::string_view insert_data_profile(
      insert_data_result.profile_json.data,
      insert_data_result.profile_json.size);
  std::string_view insert_data_error(
      insert_data_result.error_message.data,
      insert_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "insert data update failed: %.*s\n",
                 static_cast<int>(insert_data_error.size()),
                 insert_data_error.data());
    return 640;
  }
  if (state.mutation_calls < 1 || !state.inserted_row) {
    std::fprintf(stderr, "insert data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(insert_data_json.size()),
                 insert_data_json.data(),
                 static_cast<int>(insert_data_profile.size()),
                 insert_data_profile.data());
    return 641;
  }
  if (insert_data_json.find(R"("inserted":1)") == std::string_view::npos ||
      insert_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "insert data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(insert_data_json.size()),
                 insert_data_json.data(),
                 static_cast<int>(insert_data_profile.size()),
                 insert_data_profile.data());
    return 642;
  }
  xpod_qlever_adapter_release_result(adapter, &insert_data_result);

  xpod_qlever_query_request insert_data_verify_request = {};
  insert_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result insert_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &insert_data_verify_request, &insert_data_verify_result);
  std::string_view insert_data_verify_json(
      insert_data_verify_result.result_json.data,
      insert_data_verify_result.result_json.size);
  std::string_view insert_data_verify_error(
      insert_data_verify_result.error_message.data,
      insert_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "insert data verification query failed: %.*s\n",
                 static_cast<int>(insert_data_verify_error.size()),
                 insert_data_verify_error.data());
    return 643;
  }
  if (insert_data_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "insert data verification missing inserted row json=%.*s\n",
                 static_cast<int>(insert_data_verify_json.size()),
                 insert_data_verify_json.data());
    return 644;
  }
  xpod_qlever_adapter_release_result(adapter, &insert_data_verify_result);

  xpod_qlever_query_request delete_data_request = {};
  delete_data_request.sparql = bytes("DELETE DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result delete_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_data_request, &delete_data_result);
  std::string_view delete_data_json(
      delete_data_result.result_json.data,
      delete_data_result.result_json.size);
  std::string_view delete_data_profile(
      delete_data_result.profile_json.data,
      delete_data_result.profile_json.size);
  std::string_view delete_data_error(
      delete_data_result.error_message.data,
      delete_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete data update failed: %.*s\n",
                 static_cast<int>(delete_data_error.size()),
                 delete_data_error.data());
    return 645;
  }
  if (state.mutation_calls < 2 || state.inserted_row) {
    std::fprintf(stderr, "delete data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_data_json.size()),
                 delete_data_json.data(),
                 static_cast<int>(delete_data_profile.size()),
                 delete_data_profile.data());
    return 646;
  }
  if (delete_data_json.find(R"("deleted":1)") == std::string_view::npos ||
      delete_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "delete data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_data_json.size()),
                 delete_data_json.data(),
                 static_cast<int>(delete_data_profile.size()),
                 delete_data_profile.data());
    return 647;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_data_result);

  xpod_qlever_query_request delete_data_verify_request = {};
  delete_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result delete_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_data_verify_request, &delete_data_verify_result);
  std::string_view delete_data_verify_json(
      delete_data_verify_result.result_json.data,
      delete_data_verify_result.result_json.size);
  std::string_view delete_data_verify_error(
      delete_data_verify_result.error_message.data,
      delete_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete data verification query failed: %.*s\n",
                 static_cast<int>(delete_data_verify_error.size()),
                 delete_data_verify_error.data());
    return 648;
  }
  if (delete_data_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "delete data verification still returned deleted row json=%.*s\n",
                 static_cast<int>(delete_data_verify_json.size()),
                 delete_data_verify_json.data());
    return 649;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_data_verify_result);

  xpod_qlever_query_request literal_insert_data_request = {};
  literal_insert_data_request.sparql = bytes(
      "INSERT DATA { <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result literal_insert_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_insert_data_request, &literal_insert_data_result);
  std::string_view literal_insert_data_json(
      literal_insert_data_result.result_json.data,
      literal_insert_data_result.result_json.size);
  std::string_view literal_insert_data_profile(
      literal_insert_data_result.profile_json.data,
      literal_insert_data_result.profile_json.size);
  std::string_view literal_insert_data_error(
      literal_insert_data_result.error_message.data,
      literal_insert_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal insert data update failed: %.*s\n",
                 static_cast<int>(literal_insert_data_error.size()),
                 literal_insert_data_error.data());
    return 650;
  }
  if (state.mutation_calls < 3 || !state.inserted_literal_row) {
    std::fprintf(stderr, "literal insert data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_insert_data_json.size()),
                 literal_insert_data_json.data(),
                 static_cast<int>(literal_insert_data_profile.size()),
                 literal_insert_data_profile.data());
    return 651;
  }
  if (literal_insert_data_json.find(R"("inserted":1)") == std::string_view::npos ||
      literal_insert_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "literal insert data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_insert_data_json.size()),
                 literal_insert_data_json.data(),
                 static_cast<int>(literal_insert_data_profile.size()),
                 literal_insert_data_profile.data());
    return 652;
  }
  xpod_qlever_adapter_release_result(adapter, &literal_insert_data_result);

  xpod_qlever_query_request literal_insert_data_verify_request = {};
  literal_insert_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result literal_insert_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_insert_data_verify_request, &literal_insert_data_verify_result);
  std::string_view literal_insert_data_verify_json(
      literal_insert_data_verify_result.result_json.data,
      literal_insert_data_verify_result.result_json.size);
  std::string_view literal_insert_data_verify_error(
      literal_insert_data_verify_result.error_message.data,
      literal_insert_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal insert data verification query failed: %.*s\n",
                 static_cast<int>(literal_insert_data_verify_error.size()),
                 literal_insert_data_verify_error.data());
    return 653;
  }
  if (literal_insert_data_verify_json.find("literal-value") == std::string_view::npos) {
    std::fprintf(stderr, "literal insert data verification missing inserted row json=%.*s\n",
                 static_cast<int>(literal_insert_data_verify_json.size()),
                 literal_insert_data_verify_json.data());
    return 654;
  }
  xpod_qlever_adapter_release_result(adapter, &literal_insert_data_verify_result);

  xpod_qlever_query_request literal_delete_data_request = {};
  literal_delete_data_request.sparql = bytes(
      "DELETE DATA { <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result literal_delete_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_delete_data_request, &literal_delete_data_result);
  std::string_view literal_delete_data_json(
      literal_delete_data_result.result_json.data,
      literal_delete_data_result.result_json.size);
  std::string_view literal_delete_data_profile(
      literal_delete_data_result.profile_json.data,
      literal_delete_data_result.profile_json.size);
  std::string_view literal_delete_data_error(
      literal_delete_data_result.error_message.data,
      literal_delete_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal delete data update failed: %.*s\n",
                 static_cast<int>(literal_delete_data_error.size()),
                 literal_delete_data_error.data());
    return 655;
  }
  if (state.mutation_calls < 4 || state.inserted_literal_row) {
    std::fprintf(stderr, "literal delete data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_delete_data_json.size()),
                 literal_delete_data_json.data(),
                 static_cast<int>(literal_delete_data_profile.size()),
                 literal_delete_data_profile.data());
    return 656;
  }
  if (literal_delete_data_json.find(R"("deleted":1)") == std::string_view::npos ||
      literal_delete_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "literal delete data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(literal_delete_data_json.size()),
                 literal_delete_data_json.data(),
                 static_cast<int>(literal_delete_data_profile.size()),
                 literal_delete_data_profile.data());
    return 657;
  }
  xpod_qlever_adapter_release_result(adapter, &literal_delete_data_result);

  xpod_qlever_query_request literal_delete_data_verify_request = {};
  literal_delete_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result literal_delete_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &literal_delete_data_verify_request, &literal_delete_data_verify_result);
  std::string_view literal_delete_data_verify_json(
      literal_delete_data_verify_result.result_json.data,
      literal_delete_data_verify_result.result_json.size);
  std::string_view literal_delete_data_verify_error(
      literal_delete_data_verify_result.error_message.data,
      literal_delete_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "literal delete data verification query failed: %.*s\n",
                 static_cast<int>(literal_delete_data_verify_error.size()),
                 literal_delete_data_verify_error.data());
    return 658;
  }
  if (literal_delete_data_verify_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "literal delete data verification still returned deleted row json=%.*s\n",
                 static_cast<int>(literal_delete_data_verify_json.size()),
                 literal_delete_data_verify_json.data());
    return 659;
  }
  xpod_qlever_adapter_release_result(adapter, &literal_delete_data_verify_result);

  xpod_qlever_query_request prefixed_insert_data_request = {};
  prefixed_insert_data_request.sparql = bytes(
      "PREFIX ex: <urn:> INSERT DATA { ex:inserted ex:p ex:o }");
  xpod_qlever_query_result prefixed_insert_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &prefixed_insert_data_request, &prefixed_insert_data_result);
  std::string_view prefixed_insert_data_json(
      prefixed_insert_data_result.result_json.data,
      prefixed_insert_data_result.result_json.size);
  std::string_view prefixed_insert_data_profile(
      prefixed_insert_data_result.profile_json.data,
      prefixed_insert_data_result.profile_json.size);
  std::string_view prefixed_insert_data_error(
      prefixed_insert_data_result.error_message.data,
      prefixed_insert_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "prefixed insert data update failed: %.*s\n",
                 static_cast<int>(prefixed_insert_data_error.size()),
                 prefixed_insert_data_error.data());
    return 660;
  }
  if (state.mutation_calls < 5 || !state.inserted_row) {
    std::fprintf(stderr, "prefixed insert data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(prefixed_insert_data_json.size()),
                 prefixed_insert_data_json.data(),
                 static_cast<int>(prefixed_insert_data_profile.size()),
                 prefixed_insert_data_profile.data());
    return 661;
  }
  if (prefixed_insert_data_json.find(R"("inserted":1)") == std::string_view::npos ||
      prefixed_insert_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "prefixed insert data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(prefixed_insert_data_json.size()),
                 prefixed_insert_data_json.data(),
                 static_cast<int>(prefixed_insert_data_profile.size()),
                 prefixed_insert_data_profile.data());
    return 662;
  }
  xpod_qlever_adapter_release_result(adapter, &prefixed_insert_data_result);

  xpod_qlever_query_request prefixed_insert_data_verify_request = {};
  prefixed_insert_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result prefixed_insert_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &prefixed_insert_data_verify_request, &prefixed_insert_data_verify_result);
  std::string_view prefixed_insert_data_verify_json(
      prefixed_insert_data_verify_result.result_json.data,
      prefixed_insert_data_verify_result.result_json.size);
  std::string_view prefixed_insert_data_verify_error(
      prefixed_insert_data_verify_result.error_message.data,
      prefixed_insert_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "prefixed insert data verification query failed: %.*s\n",
                 static_cast<int>(prefixed_insert_data_verify_error.size()),
                 prefixed_insert_data_verify_error.data());
    return 663;
  }
  if (prefixed_insert_data_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "prefixed insert data verification missing inserted row json=%.*s\n",
                 static_cast<int>(prefixed_insert_data_verify_json.size()),
                 prefixed_insert_data_verify_json.data());
    return 664;
  }
  xpod_qlever_adapter_release_result(adapter, &prefixed_insert_data_verify_result);

  xpod_qlever_query_request prefixed_delete_data_request = {};
  prefixed_delete_data_request.sparql = bytes(
      "PREFIX ex: <urn:> DELETE DATA { ex:inserted ex:p ex:o }");
  xpod_qlever_query_result prefixed_delete_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &prefixed_delete_data_request, &prefixed_delete_data_result);
  std::string_view prefixed_delete_data_json(
      prefixed_delete_data_result.result_json.data,
      prefixed_delete_data_result.result_json.size);
  std::string_view prefixed_delete_data_profile(
      prefixed_delete_data_result.profile_json.data,
      prefixed_delete_data_result.profile_json.size);
  std::string_view prefixed_delete_data_error(
      prefixed_delete_data_result.error_message.data,
      prefixed_delete_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "prefixed delete data update failed: %.*s\n",
                 static_cast<int>(prefixed_delete_data_error.size()),
                 prefixed_delete_data_error.data());
    return 665;
  }
  if (state.mutation_calls < 6 || state.inserted_row) {
    std::fprintf(stderr, "prefixed delete data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(prefixed_delete_data_json.size()),
                 prefixed_delete_data_json.data(),
                 static_cast<int>(prefixed_delete_data_profile.size()),
                 prefixed_delete_data_profile.data());
    return 666;
  }
  if (prefixed_delete_data_json.find(R"("deleted":1)") == std::string_view::npos ||
      prefixed_delete_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "prefixed delete data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(prefixed_delete_data_json.size()),
                 prefixed_delete_data_json.data(),
                 static_cast<int>(prefixed_delete_data_profile.size()),
                 prefixed_delete_data_profile.data());
    return 667;
  }
  xpod_qlever_adapter_release_result(adapter, &prefixed_delete_data_result);

  xpod_qlever_query_request prefixed_delete_data_verify_request = {};
  prefixed_delete_data_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result prefixed_delete_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &prefixed_delete_data_verify_request, &prefixed_delete_data_verify_result);
  std::string_view prefixed_delete_data_verify_json(
      prefixed_delete_data_verify_result.result_json.data,
      prefixed_delete_data_verify_result.result_json.size);
  std::string_view prefixed_delete_data_verify_error(
      prefixed_delete_data_verify_result.error_message.data,
      prefixed_delete_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "prefixed delete data verification query failed: %.*s\n",
                 static_cast<int>(prefixed_delete_data_verify_error.size()),
                 prefixed_delete_data_verify_error.data());
    return 668;
  }
  if (prefixed_delete_data_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "prefixed delete data verification still returned deleted row json=%.*s\n",
                 static_cast<int>(prefixed_delete_data_verify_json.size()),
                 prefixed_delete_data_verify_json.data());
    return 669;
  }
  xpod_qlever_adapter_release_result(adapter, &prefixed_delete_data_verify_result);

  xpod_qlever_query_request sequence_update_request = {};
  sequence_update_request.sparql = bytes(
      "INSERT DATA { <urn:inserted> <urn:p> <urn:o> }; "
      "DELETE DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result sequence_update_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &sequence_update_request, &sequence_update_result);
  std::string_view sequence_update_json(
      sequence_update_result.result_json.data,
      sequence_update_result.result_json.size);
  std::string_view sequence_update_profile(
      sequence_update_result.profile_json.data,
      sequence_update_result.profile_json.size);
  std::string_view sequence_update_error(
      sequence_update_result.error_message.data,
      sequence_update_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "sequence update failed: %.*s\n",
                 static_cast<int>(sequence_update_error.size()),
                 sequence_update_error.data());
    return 670;
  }
  if (state.mutation_calls < 8 || state.inserted_row) {
    std::fprintf(stderr, "sequence update did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(sequence_update_json.size()),
                 sequence_update_json.data(),
                 static_cast<int>(sequence_update_profile.size()),
                 sequence_update_profile.data());
    return 671;
  }
  if (sequence_update_json.find(R"("inserted":1)") == std::string_view::npos ||
      sequence_update_json.find(R"("deleted":1)") == std::string_view::npos ||
      sequence_update_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "sequence update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(sequence_update_json.size()),
                 sequence_update_json.data(),
                 static_cast<int>(sequence_update_profile.size()),
                 sequence_update_profile.data());
    return 672;
  }
  xpod_qlever_adapter_release_result(adapter, &sequence_update_result);

  xpod_qlever_query_request sequence_update_verify_request = {};
  sequence_update_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result sequence_update_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &sequence_update_verify_request, &sequence_update_verify_result);
  std::string_view sequence_update_verify_json(
      sequence_update_verify_result.result_json.data,
      sequence_update_verify_result.result_json.size);
  std::string_view sequence_update_verify_error(
      sequence_update_verify_result.error_message.data,
      sequence_update_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "sequence update verification query failed: %.*s\n",
                 static_cast<int>(sequence_update_verify_error.size()),
                 sequence_update_verify_error.data());
    return 673;
  }
  if (sequence_update_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "sequence update verification still returned deleted row json=%.*s\n",
                 static_cast<int>(sequence_update_verify_json.size()),
                 sequence_update_verify_json.data());
    return 674;
  }
  xpod_qlever_adapter_release_result(adapter, &sequence_update_verify_result);

  xpod_qlever_query_request multi_triple_insert_request = {};
  multi_triple_insert_request.sparql = bytes(
      "INSERT DATA { <urn:inserted> <urn:p> <urn:o> . <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result multi_triple_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &multi_triple_insert_request, &multi_triple_insert_result);
  std::string_view multi_triple_insert_json(
      multi_triple_insert_result.result_json.data,
      multi_triple_insert_result.result_json.size);
  std::string_view multi_triple_insert_profile(
      multi_triple_insert_result.profile_json.data,
      multi_triple_insert_result.profile_json.size);
  std::string_view multi_triple_insert_error(
      multi_triple_insert_result.error_message.data,
      multi_triple_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "multi triple insert update failed: %.*s\n",
                 static_cast<int>(multi_triple_insert_error.size()),
                 multi_triple_insert_error.data());
    return 675;
  }
  if (state.mutation_calls < 9 ||
      !state.inserted_row ||
      !state.inserted_literal_row) {
    std::fprintf(stderr, "multi triple insert did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(multi_triple_insert_json.size()),
                 multi_triple_insert_json.data(),
                 static_cast<int>(multi_triple_insert_profile.size()),
                 multi_triple_insert_profile.data());
    return 676;
  }
  if (multi_triple_insert_json.find(R"("inserted":2)") == std::string_view::npos ||
      multi_triple_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "multi triple insert result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(multi_triple_insert_json.size()),
                 multi_triple_insert_json.data(),
                 static_cast<int>(multi_triple_insert_profile.size()),
                 multi_triple_insert_profile.data());
    return 677;
  }
  xpod_qlever_adapter_release_result(adapter, &multi_triple_insert_result);

  xpod_qlever_query_request multi_triple_delete_request = {};
  multi_triple_delete_request.sparql = bytes(
      "DELETE DATA { <urn:inserted> <urn:p> <urn:o> . <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result multi_triple_delete_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &multi_triple_delete_request, &multi_triple_delete_result);
  std::string_view multi_triple_delete_json(
      multi_triple_delete_result.result_json.data,
      multi_triple_delete_result.result_json.size);
  std::string_view multi_triple_delete_profile(
      multi_triple_delete_result.profile_json.data,
      multi_triple_delete_result.profile_json.size);
  std::string_view multi_triple_delete_error(
      multi_triple_delete_result.error_message.data,
      multi_triple_delete_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "multi triple delete update failed: %.*s\n",
                 static_cast<int>(multi_triple_delete_error.size()),
                 multi_triple_delete_error.data());
    return 678;
  }
  if (state.mutation_calls < 10 ||
      state.inserted_row ||
      state.inserted_literal_row) {
    std::fprintf(stderr, "multi triple delete did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(multi_triple_delete_json.size()),
                 multi_triple_delete_json.data(),
                 static_cast<int>(multi_triple_delete_profile.size()),
                 multi_triple_delete_profile.data());
    return 679;
  }
  if (multi_triple_delete_json.find(R"("deleted":2)") == std::string_view::npos ||
      multi_triple_delete_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "multi triple delete result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(multi_triple_delete_json.size()),
                 multi_triple_delete_json.data(),
                 static_cast<int>(multi_triple_delete_profile.size()),
                 multi_triple_delete_profile.data());
    return 680;
  }
  xpod_qlever_adapter_release_result(adapter, &multi_triple_delete_result);

  xpod_qlever_query_request multi_triple_delete_verify_iri_request = {};
  multi_triple_delete_verify_iri_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result multi_triple_delete_verify_iri_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &multi_triple_delete_verify_iri_request, &multi_triple_delete_verify_iri_result);
  std::string_view multi_triple_delete_verify_iri_json(
      multi_triple_delete_verify_iri_result.result_json.data,
      multi_triple_delete_verify_iri_result.result_json.size);
  std::string_view multi_triple_delete_verify_iri_error(
      multi_triple_delete_verify_iri_result.error_message.data,
      multi_triple_delete_verify_iri_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "multi triple delete iri verification query failed: %.*s\n",
                 static_cast<int>(multi_triple_delete_verify_iri_error.size()),
                 multi_triple_delete_verify_iri_error.data());
    return 681;
  }
  if (multi_triple_delete_verify_iri_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "multi triple delete verification still returned iri row json=%.*s\n",
                 static_cast<int>(multi_triple_delete_verify_iri_json.size()),
                 multi_triple_delete_verify_iri_json.data());
    return 682;
  }
  xpod_qlever_adapter_release_result(adapter, &multi_triple_delete_verify_iri_result);

  xpod_qlever_query_request multi_triple_delete_verify_literal_request = {};
  multi_triple_delete_verify_literal_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result multi_triple_delete_verify_literal_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &multi_triple_delete_verify_literal_request, &multi_triple_delete_verify_literal_result);
  std::string_view multi_triple_delete_verify_literal_json(
      multi_triple_delete_verify_literal_result.result_json.data,
      multi_triple_delete_verify_literal_result.result_json.size);
  std::string_view multi_triple_delete_verify_literal_error(
      multi_triple_delete_verify_literal_result.error_message.data,
      multi_triple_delete_verify_literal_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "multi triple delete literal verification query failed: %.*s\n",
                 static_cast<int>(multi_triple_delete_verify_literal_error.size()),
                 multi_triple_delete_verify_literal_error.data());
    return 683;
  }
  if (multi_triple_delete_verify_literal_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "multi triple delete verification still returned literal row json=%.*s\n",
                 static_cast<int>(multi_triple_delete_verify_literal_json.size()),
                 multi_triple_delete_verify_literal_json.data());
    return 684;
  }
  xpod_qlever_adapter_release_result(adapter, &multi_triple_delete_verify_literal_result);

  xpod_qlever_query_request named_graph_insert_request = {};
  named_graph_insert_request.sparql = bytes(
      "INSERT DATA { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> <urn:o> } }");
  xpod_qlever_query_result named_graph_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &named_graph_insert_request, &named_graph_insert_result);
  std::string_view named_graph_insert_json(
      named_graph_insert_result.result_json.data,
      named_graph_insert_result.result_json.size);
  std::string_view named_graph_insert_profile(
      named_graph_insert_result.profile_json.data,
      named_graph_insert_result.profile_json.size);
  std::string_view named_graph_insert_error(
      named_graph_insert_result.error_message.data,
      named_graph_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "named graph insert data update failed: %.*s\n",
                 static_cast<int>(named_graph_insert_error.size()),
                 named_graph_insert_error.data());
    return 685;
  }
  if (state.mutation_calls < 11 || !state.inserted_graph_row) {
    std::fprintf(stderr, "named graph insert data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_insert_json.size()),
                 named_graph_insert_json.data(),
                 static_cast<int>(named_graph_insert_profile.size()),
                 named_graph_insert_profile.data());
    return 686;
  }
  if (named_graph_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      named_graph_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "named graph insert data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_insert_json.size()),
                 named_graph_insert_json.data(),
                 static_cast<int>(named_graph_insert_profile.size()),
                 named_graph_insert_profile.data());
    return 687;
  }
  xpod_qlever_adapter_release_result(adapter, &named_graph_insert_result);

  xpod_qlever_query_request named_graph_insert_verify_request = {};
  named_graph_insert_verify_request.sparql = bytes(
      "SELECT ?o WHERE { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> ?o } }");
  xpod_qlever_query_result named_graph_insert_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &named_graph_insert_verify_request, &named_graph_insert_verify_result);
  std::string_view named_graph_insert_verify_json(
      named_graph_insert_verify_result.result_json.data,
      named_graph_insert_verify_result.result_json.size);
  std::string_view named_graph_insert_verify_profile(
      named_graph_insert_verify_result.profile_json.data,
      named_graph_insert_verify_result.profile_json.size);
  std::string_view named_graph_insert_verify_error(
      named_graph_insert_verify_result.error_message.data,
      named_graph_insert_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "named graph insert data verification query failed: %.*s\n",
                 static_cast<int>(named_graph_insert_verify_error.size()),
                 named_graph_insert_verify_error.data());
    return 688;
  }
  if (named_graph_insert_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "named graph insert verification missing inserted row json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_insert_verify_json.size()),
                 named_graph_insert_verify_json.data(),
                 static_cast<int>(named_graph_insert_verify_profile.size()),
                 named_graph_insert_verify_profile.data());
    return 689;
  }
  xpod_qlever_adapter_release_result(adapter, &named_graph_insert_verify_result);

  xpod_qlever_query_request named_graph_delete_request = {};
  named_graph_delete_request.sparql = bytes(
      "DELETE DATA { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> <urn:o> } }");
  xpod_qlever_query_result named_graph_delete_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &named_graph_delete_request, &named_graph_delete_result);
  std::string_view named_graph_delete_json(
      named_graph_delete_result.result_json.data,
      named_graph_delete_result.result_json.size);
  std::string_view named_graph_delete_profile(
      named_graph_delete_result.profile_json.data,
      named_graph_delete_result.profile_json.size);
  std::string_view named_graph_delete_error(
      named_graph_delete_result.error_message.data,
      named_graph_delete_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "named graph delete data update failed: %.*s\n",
                 static_cast<int>(named_graph_delete_error.size()),
                 named_graph_delete_error.data());
    return 690;
  }
  if (state.mutation_calls < 12 || state.inserted_graph_row) {
    std::fprintf(stderr, "named graph delete data did not call backend mutation callback json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_delete_json.size()),
                 named_graph_delete_json.data(),
                 static_cast<int>(named_graph_delete_profile.size()),
                 named_graph_delete_profile.data());
    return 691;
  }
  if (named_graph_delete_json.find(R"("deleted":1)") == std::string_view::npos ||
      named_graph_delete_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "named graph delete data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(named_graph_delete_json.size()),
                 named_graph_delete_json.data(),
                 static_cast<int>(named_graph_delete_profile.size()),
                 named_graph_delete_profile.data());
    return 692;
  }
  xpod_qlever_adapter_release_result(adapter, &named_graph_delete_result);


  xpod_qlever_query_request delete_where_seed_request = {};
  delete_where_seed_request.sparql = bytes(
      "INSERT DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result delete_where_seed_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_where_seed_request, &delete_where_seed_result);
  std::string_view delete_where_seed_error(
      delete_where_seed_result.error_message.data,
      delete_where_seed_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete where seed insert failed: %.*s\n",
                 static_cast<int>(delete_where_seed_error.size()),
                 delete_where_seed_error.data());
    return 695;
  }
  if (!state.inserted_row) {
    std::fprintf(stderr, "delete where seed insert did not create row\n");
    return 696;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_where_seed_result);

  xpod_qlever_query_request delete_where_request = {};
  delete_where_request.sparql = bytes(
      "DELETE WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result delete_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_where_request, &delete_where_result);
  std::string_view delete_where_json(
      delete_where_result.result_json.data,
      delete_where_result.result_json.size);
  std::string_view delete_where_profile(
      delete_where_result.profile_json.data,
      delete_where_result.profile_json.size);
  std::string_view delete_where_error(
      delete_where_result.error_message.data,
      delete_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete where update failed: %.*s\n",
                 static_cast<int>(delete_where_error.size()),
                 delete_where_error.data());
    return 697;
  }
  if (state.inserted_row) {
    std::fprintf(stderr, "delete where did not delete seeded row json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_where_json.size()),
                 delete_where_json.data(),
                 static_cast<int>(delete_where_profile.size()),
                 delete_where_profile.data());
    return 698;
  }
  if (delete_where_json.find(R"("deleted":1)") == std::string_view::npos ||
      delete_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "delete where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_where_json.size()),
                 delete_where_json.data(),
                 static_cast<int>(delete_where_profile.size()),
                 delete_where_profile.data());
    return 699;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_where_result);

  xpod_qlever_query_request delete_where_verify_request = {};
  delete_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result delete_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_where_verify_request, &delete_where_verify_result);
  std::string_view delete_where_verify_json(
      delete_where_verify_result.result_json.data,
      delete_where_verify_result.result_json.size);
  std::string_view delete_where_verify_error(
      delete_where_verify_result.error_message.data,
      delete_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete where verification query failed: %.*s\n",
                 static_cast<int>(delete_where_verify_error.size()),
                 delete_where_verify_error.data());
    return 700;
  }
  if (delete_where_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "delete where verification still returned row json=%.*s\n",
                 static_cast<int>(delete_where_verify_json.size()),
                 delete_where_verify_json.data());
    return 701;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_where_verify_result);

  xpod_qlever_query_request delete_where_filter_seed_request = {};
  delete_where_filter_seed_request.sparql = bytes(
      "INSERT DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result delete_where_filter_seed_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_where_filter_seed_request, &delete_where_filter_seed_result);
  std::string_view delete_where_filter_seed_error(
      delete_where_filter_seed_result.error_message.data,
      delete_where_filter_seed_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete where filter seed insert failed: %.*s\n",
                 static_cast<int>(delete_where_filter_seed_error.size()),
                 delete_where_filter_seed_error.data());
    return 702;
  }
  if (!state.inserted_row) {
    std::fprintf(stderr, "delete where filter seed insert did not create row\n");
    return 703;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_where_filter_seed_result);

  xpod_qlever_query_request delete_where_filter_request = {};
  delete_where_filter_request.sparql = bytes(
      "DELETE { <urn:inserted> <urn:p> ?o } "
      "WHERE { <urn:inserted> <urn:p> ?o FILTER(?o = <urn:o>) }");
  xpod_qlever_query_result delete_where_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &delete_where_filter_request, &delete_where_filter_result);
  std::string_view delete_where_filter_json(
      delete_where_filter_result.result_json.data,
      delete_where_filter_result.result_json.size);
  std::string_view delete_where_filter_profile(
      delete_where_filter_result.profile_json.data,
      delete_where_filter_result.profile_json.size);
  std::string_view delete_where_filter_error(
      delete_where_filter_result.error_message.data,
      delete_where_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "delete where filter update failed: %.*s\n",
                 static_cast<int>(delete_where_filter_error.size()),
                 delete_where_filter_error.data());
    return 704;
  }
  if (state.inserted_row) {
    std::fprintf(stderr, "delete where filter did not delete seeded row json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_where_filter_json.size()),
                 delete_where_filter_json.data(),
                 static_cast<int>(delete_where_filter_profile.size()),
                 delete_where_filter_profile.data());
    return 705;
  }
  if (delete_where_filter_json.find(R"("deleted":1)") == std::string_view::npos ||
      delete_where_filter_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "delete where filter result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(delete_where_filter_json.size()),
                 delete_where_filter_json.data(),
                 static_cast<int>(delete_where_filter_profile.size()),
                 delete_where_filter_profile.data());
    return 706;
  }
  xpod_qlever_adapter_release_result(adapter, &delete_where_filter_result);

  xpod_qlever_query_request variable_insert_where_request = {};
  variable_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted> <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }");
  xpod_qlever_query_result variable_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &variable_insert_where_request, &variable_insert_where_result);
  std::string_view variable_insert_where_json(
      variable_insert_where_result.result_json.data,
      variable_insert_where_result.result_json.size);
  std::string_view variable_insert_where_profile(
      variable_insert_where_result.profile_json.data,
      variable_insert_where_result.profile_json.size);
  std::string_view variable_insert_where_error(
      variable_insert_where_result.error_message.data,
      variable_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "variable insert where update failed: %.*s\n",
                 static_cast<int>(variable_insert_where_error.size()),
                 variable_insert_where_error.data());
    return 717;
  }
  if (!state.inserted_row) {
    std::fprintf(stderr, "variable insert where did not insert WHERE-bound row json=%.*s profile=%.*s\n",
                 static_cast<int>(variable_insert_where_json.size()),
                 variable_insert_where_json.data(),
                 static_cast<int>(variable_insert_where_profile.size()),
                 variable_insert_where_profile.data());
    return 718;
  }
  if (variable_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      variable_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "variable insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(variable_insert_where_json.size()),
                 variable_insert_where_json.data(),
                 static_cast<int>(variable_insert_where_profile.size()),
                 variable_insert_where_profile.data());
    return 719;
  }
  xpod_qlever_adapter_release_result(adapter, &variable_insert_where_result);

  xpod_qlever_query_request variable_insert_where_verify_request = {};
  variable_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }");
  xpod_qlever_query_result variable_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &variable_insert_where_verify_request,
      &variable_insert_where_verify_result);
  std::string_view variable_insert_where_verify_json(
      variable_insert_where_verify_result.result_json.data,
      variable_insert_where_verify_result.result_json.size);
  std::string_view variable_insert_where_verify_error(
      variable_insert_where_verify_result.error_message.data,
      variable_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "variable insert where verification query failed: %.*s\n",
                 static_cast<int>(variable_insert_where_verify_error.size()),
                 variable_insert_where_verify_error.data());
    return 720;
  }
  if (variable_insert_where_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "variable insert where verification missing row json=%.*s\n",
                 static_cast<int>(variable_insert_where_verify_json.size()),
                 variable_insert_where_verify_json.data());
    return 721;
  }
  xpod_qlever_adapter_release_result(adapter, &variable_insert_where_verify_result);

  xpod_qlever_query_request variable_insert_where_cleanup_request = {};
  variable_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:inserted> <urn:p> <urn:o> }");
  xpod_qlever_query_result variable_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &variable_insert_where_cleanup_request,
      &variable_insert_where_cleanup_result);
  std::string_view variable_insert_where_cleanup_json(
      variable_insert_where_cleanup_result.result_json.data,
      variable_insert_where_cleanup_result.result_json.size);
  std::string_view variable_insert_where_cleanup_profile(
      variable_insert_where_cleanup_result.profile_json.data,
      variable_insert_where_cleanup_result.profile_json.size);
  std::string_view variable_insert_where_cleanup_error(
      variable_insert_where_cleanup_result.error_message.data,
      variable_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "variable insert where cleanup failed: %.*s\n",
                 static_cast<int>(variable_insert_where_cleanup_error.size()),
                 variable_insert_where_cleanup_error.data());
    return 737;
  }
  if (state.inserted_row ||
      variable_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      variable_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "variable insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(variable_insert_where_cleanup_json.size()),
                 variable_insert_where_cleanup_json.data(),
                 static_cast<int>(variable_insert_where_cleanup_profile.size()),
                 variable_insert_where_cleanup_profile.data());
    return 738;
  }
  xpod_qlever_adapter_release_result(adapter, &variable_insert_where_cleanup_result);

  xpod_qlever_query_request bind_insert_where_request = {};
  bind_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-bind> <urn:p> ?copy } "
      "WHERE { <urn:s> <urn:p> ?o BIND(<urn:bind-copy> AS ?copy) }");
  xpod_qlever_query_result bind_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &bind_insert_where_request, &bind_insert_where_result);
  std::string_view bind_insert_where_json(
      bind_insert_where_result.result_json.data,
      bind_insert_where_result.result_json.size);
  std::string_view bind_insert_where_profile(
      bind_insert_where_result.profile_json.data,
      bind_insert_where_result.profile_json.size);
  std::string_view bind_insert_where_error(
      bind_insert_where_result.error_message.data,
      bind_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "bind insert where update failed: %.*s\n",
                 static_cast<int>(bind_insert_where_error.size()),
                 bind_insert_where_error.data());
    return 702;
  }
  if (!state.inserted_bind_row) {
    std::fprintf(stderr, "bind insert where did not insert bound row json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_insert_where_json.size()),
                 bind_insert_where_json.data(),
                 static_cast<int>(bind_insert_where_profile.size()),
                 bind_insert_where_profile.data());
    return 703;
  }
  if (bind_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      bind_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "bind insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(bind_insert_where_json.size()),
                 bind_insert_where_json.data(),
                 static_cast<int>(bind_insert_where_profile.size()),
                 bind_insert_where_profile.data());
    return 704;
  }
  xpod_qlever_adapter_release_result(adapter, &bind_insert_where_result);

  xpod_qlever_query_request bind_insert_where_verify_request = {};
  bind_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-bind> <urn:p> ?o }");
  xpod_qlever_query_result bind_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &bind_insert_where_verify_request,
      &bind_insert_where_verify_result);
  std::string_view bind_insert_where_verify_json(
      bind_insert_where_verify_result.result_json.data,
      bind_insert_where_verify_result.result_json.size);
  std::string_view bind_insert_where_verify_error(
      bind_insert_where_verify_result.error_message.data,
      bind_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "bind insert where verification query failed: %.*s\n",
                 static_cast<int>(bind_insert_where_verify_error.size()),
                 bind_insert_where_verify_error.data());
    return 705;
  }
  if (bind_insert_where_verify_json.find("urn:bind-copy") == std::string_view::npos) {
    std::fprintf(stderr, "bind insert where verification missing row json=%.*s\n",
                 static_cast<int>(bind_insert_where_verify_json.size()),
                 bind_insert_where_verify_json.data());
    return 706;
  }
  xpod_qlever_adapter_release_result(adapter, &bind_insert_where_verify_result);

  xpod_qlever_query_request iri_bind_insert_where_request = {};
  iri_bind_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-iri-bind> <urn:p> ?copy } "
      "WHERE { <urn:s> <urn:p> ?o BIND(IRI(\"urn:bind-copy\") AS ?copy) }");
  xpod_qlever_query_result iri_bind_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &iri_bind_insert_where_request, &iri_bind_insert_where_result);
  std::string_view iri_bind_insert_where_json(
      iri_bind_insert_where_result.result_json.data,
      iri_bind_insert_where_result.result_json.size);
  std::string_view iri_bind_insert_where_profile(
      iri_bind_insert_where_result.profile_json.data,
      iri_bind_insert_where_result.profile_json.size);
  std::string_view iri_bind_insert_where_error(
      iri_bind_insert_where_result.error_message.data,
      iri_bind_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "iri bind insert where update failed: %.*s\n",
                 static_cast<int>(iri_bind_insert_where_error.size()),
                 iri_bind_insert_where_error.data());
    return 707;
  }
  if (!state.inserted_iri_bind_row) {
    std::fprintf(stderr, "iri bind insert where did not insert bound row json=%.*s profile=%.*s\n",
                 static_cast<int>(iri_bind_insert_where_json.size()),
                 iri_bind_insert_where_json.data(),
                 static_cast<int>(iri_bind_insert_where_profile.size()),
                 iri_bind_insert_where_profile.data());
    return 708;
  }
  if (iri_bind_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      iri_bind_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "iri bind insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(iri_bind_insert_where_json.size()),
                 iri_bind_insert_where_json.data(),
                 static_cast<int>(iri_bind_insert_where_profile.size()),
                 iri_bind_insert_where_profile.data());
    return 709;
  }
  xpod_qlever_adapter_release_result(adapter, &iri_bind_insert_where_result);

  xpod_qlever_query_request iri_bind_insert_where_verify_request = {};
  iri_bind_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-iri-bind> <urn:p> ?o }");
  xpod_qlever_query_result iri_bind_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &iri_bind_insert_where_verify_request,
      &iri_bind_insert_where_verify_result);
  std::string_view iri_bind_insert_where_verify_json(
      iri_bind_insert_where_verify_result.result_json.data,
      iri_bind_insert_where_verify_result.result_json.size);
  std::string_view iri_bind_insert_where_verify_error(
      iri_bind_insert_where_verify_result.error_message.data,
      iri_bind_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "iri bind insert where verification query failed: %.*s\n",
                 static_cast<int>(iri_bind_insert_where_verify_error.size()),
                 iri_bind_insert_where_verify_error.data());
    return 710;
  }
  if (iri_bind_insert_where_verify_json.find("urn:bind-copy") == std::string_view::npos) {
    std::fprintf(stderr, "iri bind insert where verification missing row json=%.*s\n",
                 static_cast<int>(iri_bind_insert_where_verify_json.size()),
                 iri_bind_insert_where_verify_json.data());
    return 711;
  }
  xpod_qlever_adapter_release_result(adapter, &iri_bind_insert_where_verify_result);

  xpod_qlever_query_request str_bind_insert_where_request = {};
  str_bind_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-str-bind> <urn:p> ?label } "
      "WHERE { <urn:s> <urn:p> ?o BIND(STR(?o) AS ?label) }");
  xpod_qlever_query_result str_bind_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &str_bind_insert_where_request, &str_bind_insert_where_result);
  std::string_view str_bind_insert_where_json(
      str_bind_insert_where_result.result_json.data,
      str_bind_insert_where_result.result_json.size);
  std::string_view str_bind_insert_where_profile(
      str_bind_insert_where_result.profile_json.data,
      str_bind_insert_where_result.profile_json.size);
  std::string_view str_bind_insert_where_error(
      str_bind_insert_where_result.error_message.data,
      str_bind_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "str bind insert where update failed: %.*s\n",
                 static_cast<int>(str_bind_insert_where_error.size()),
                 str_bind_insert_where_error.data());
    return 712;
  }
  if (!state.inserted_str_bind_row) {
    std::fprintf(stderr, "str bind insert where did not insert bound row json=%.*s profile=%.*s\n",
                 static_cast<int>(str_bind_insert_where_json.size()),
                 str_bind_insert_where_json.data(),
                 static_cast<int>(str_bind_insert_where_profile.size()),
                 str_bind_insert_where_profile.data());
    return 713;
  }
  if (str_bind_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      str_bind_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "str bind insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(str_bind_insert_where_json.size()),
                 str_bind_insert_where_json.data(),
                 static_cast<int>(str_bind_insert_where_profile.size()),
                 str_bind_insert_where_profile.data());
    return 714;
  }
  xpod_qlever_adapter_release_result(adapter, &str_bind_insert_where_result);

  xpod_qlever_query_request str_bind_insert_where_verify_request = {};
  str_bind_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-str-bind> <urn:p> ?o }");
  xpod_qlever_query_result str_bind_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &str_bind_insert_where_verify_request,
      &str_bind_insert_where_verify_result);
  std::string_view str_bind_insert_where_verify_json(
      str_bind_insert_where_verify_result.result_json.data,
      str_bind_insert_where_verify_result.result_json.size);
  std::string_view str_bind_insert_where_verify_error(
      str_bind_insert_where_verify_result.error_message.data,
      str_bind_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "str bind insert where verification query failed: %.*s\n",
                 static_cast<int>(str_bind_insert_where_verify_error.size()),
                 str_bind_insert_where_verify_error.data());
    return 715;
  }
  if (str_bind_insert_where_verify_json.find(R"("value":"urn:o")") == std::string_view::npos) {
    std::fprintf(stderr, "str bind insert where verification missing literal row json=%.*s\n",
                 static_cast<int>(str_bind_insert_where_verify_json.size()),
                 str_bind_insert_where_verify_json.data());
    return 716;
  }
  xpod_qlever_adapter_release_result(adapter, &str_bind_insert_where_verify_result);

  xpod_qlever_query_request blank_insert_where_request = {};
  blank_insert_where_request.sparql = bytes(
      "INSERT { _:whereBlank <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }");
  xpod_qlever_query_result blank_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_insert_where_request, &blank_insert_where_result);
  std::string_view blank_insert_where_json(
      blank_insert_where_result.result_json.data,
      blank_insert_where_result.result_json.size);
  std::string_view blank_insert_where_profile(
      blank_insert_where_result.profile_json.data,
      blank_insert_where_result.profile_json.size);
  std::string_view blank_insert_where_error(
      blank_insert_where_result.error_message.data,
      blank_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank insert where update failed: %.*s\n",
                 static_cast<int>(blank_insert_where_error.size()),
                 blank_insert_where_error.data());
    return 739;
  }
  if (!state.inserted_blank_row) {
    std::fprintf(stderr, "blank insert where did not insert WHERE-bound blank row json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_insert_where_json.size()),
                 blank_insert_where_json.data(),
                 static_cast<int>(blank_insert_where_profile.size()),
                 blank_insert_where_profile.data());
    return 740;
  }
  if (blank_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      blank_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "blank insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_insert_where_json.size()),
                 blank_insert_where_json.data(),
                 static_cast<int>(blank_insert_where_profile.size()),
                 blank_insert_where_profile.data());
    return 741;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_insert_where_result);

  xpod_qlever_query_request blank_insert_where_verify_request = {};
  blank_insert_where_verify_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:p> <urn:o> }");
  xpod_qlever_query_result blank_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_insert_where_verify_request,
      &blank_insert_where_verify_result);
  std::string_view blank_insert_where_verify_json(
      blank_insert_where_verify_result.result_json.data,
      blank_insert_where_verify_result.result_json.size);
  std::string_view blank_insert_where_verify_error(
      blank_insert_where_verify_result.error_message.data,
      blank_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank insert where verification query failed: %.*s\n",
                 static_cast<int>(blank_insert_where_verify_error.size()),
                 blank_insert_where_verify_error.data());
    return 742;
  }
  if (blank_insert_where_verify_json.find(R"("type":"bnode")") == std::string_view::npos) {
    std::fprintf(stderr, "blank insert where verification missing blank node json=%.*s\n",
                 static_cast<int>(blank_insert_where_verify_json.size()),
                 blank_insert_where_verify_json.data());
    return 743;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_insert_where_verify_result);

  xpod_qlever_query_request optional_insert_where_request = {};
  optional_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?tail } "
      "WHERE { <urn:s> <urn:p> ?o OPTIONAL { ?o <urn:p2> ?tail } }");
  xpod_qlever_query_result optional_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &optional_insert_where_request, &optional_insert_where_result);
  std::string_view optional_insert_where_json(
      optional_insert_where_result.result_json.data,
      optional_insert_where_result.result_json.size);
  std::string_view optional_insert_where_profile(
      optional_insert_where_result.profile_json.data,
      optional_insert_where_result.profile_json.size);
  std::string_view optional_insert_where_error(
      optional_insert_where_result.error_message.data,
      optional_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional insert where update failed: %.*s\n",
                 static_cast<int>(optional_insert_where_error.size()),
                 optional_insert_where_error.data());
    return 749;
  }
  if (!state.inserted_optional_tail_row) {
    std::fprintf(stderr, "optional insert where did not insert optional-bound row json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_insert_where_json.size()),
                 optional_insert_where_json.data(),
                 static_cast<int>(optional_insert_where_profile.size()),
                 optional_insert_where_profile.data());
    return 750;
  }
  if (optional_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      optional_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "optional insert where result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_insert_where_json.size()),
                 optional_insert_where_json.data(),
                 static_cast<int>(optional_insert_where_profile.size()),
                 optional_insert_where_profile.data());
    return 751;
  }
  xpod_qlever_adapter_release_result(adapter, &optional_insert_where_result);

  xpod_qlever_query_request optional_insert_where_verify_request = {};
  optional_insert_where_verify_request.sparql = bytes(
      "SELECT ?tail WHERE { <urn:modified> <urn:p> ?tail }");
  xpod_qlever_query_result optional_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &optional_insert_where_verify_request,
      &optional_insert_where_verify_result);
  std::string_view optional_insert_where_verify_json(
      optional_insert_where_verify_result.result_json.data,
      optional_insert_where_verify_result.result_json.size);
  std::string_view optional_insert_where_verify_error(
      optional_insert_where_verify_result.error_message.data,
      optional_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional insert where verification query failed: %.*s\n",
                 static_cast<int>(optional_insert_where_verify_error.size()),
                 optional_insert_where_verify_error.data());
    return 752;
  }
  if (optional_insert_where_verify_json.find("urn:tail") == std::string_view::npos) {
    std::fprintf(stderr, "optional insert where verification missing optional row json=%.*s\n",
                 static_cast<int>(optional_insert_where_verify_json.size()),
                 optional_insert_where_verify_json.data());
    return 753;
  }
  xpod_qlever_adapter_release_result(adapter, &optional_insert_where_verify_result);

  xpod_qlever_query_request optional_insert_where_cleanup_request = {};
  optional_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:tail> }");
  xpod_qlever_query_result optional_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &optional_insert_where_cleanup_request,
      &optional_insert_where_cleanup_result);
  std::string_view optional_insert_where_cleanup_json(
      optional_insert_where_cleanup_result.result_json.data,
      optional_insert_where_cleanup_result.result_json.size);
  std::string_view optional_insert_where_cleanup_profile(
      optional_insert_where_cleanup_result.profile_json.data,
      optional_insert_where_cleanup_result.profile_json.size);
  std::string_view optional_insert_where_cleanup_error(
      optional_insert_where_cleanup_result.error_message.data,
      optional_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional insert where cleanup failed: %.*s\n",
                 static_cast<int>(optional_insert_where_cleanup_error.size()),
                 optional_insert_where_cleanup_error.data());
    return 754;
  }
  if (state.inserted_optional_tail_row ||
      optional_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      optional_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "optional insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_insert_where_cleanup_json.size()),
                 optional_insert_where_cleanup_json.data(),
                 static_cast<int>(optional_insert_where_cleanup_profile.size()),
                 optional_insert_where_cleanup_profile.data());
    return 755;
  }
  xpod_qlever_adapter_release_result(adapter, &optional_insert_where_cleanup_result);

  xpod_qlever_query_request optional_missing_insert_where_request = {};
  optional_missing_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?tail } "
      "WHERE { <urn:s> <urn:p> ?o OPTIONAL { ?o <urn:missing-p> ?tail } }");
  xpod_qlever_query_result optional_missing_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &optional_missing_insert_where_request,
      &optional_missing_insert_where_result);
  std::string_view optional_missing_insert_where_json(
      optional_missing_insert_where_result.result_json.data,
      optional_missing_insert_where_result.result_json.size);
  std::string_view optional_missing_insert_where_profile(
      optional_missing_insert_where_result.profile_json.data,
      optional_missing_insert_where_result.profile_json.size);
  std::string_view optional_missing_insert_where_error(
      optional_missing_insert_where_result.error_message.data,
      optional_missing_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional missing insert where update failed: %.*s\n",
                 static_cast<int>(optional_missing_insert_where_error.size()),
                 optional_missing_insert_where_error.data());
    return 756;
  }
  if (state.inserted_optional_tail_row ||
      optional_missing_insert_where_json.find(R"("inserted":0)") == std::string_view::npos ||
      optional_missing_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "optional missing insert where inserted unbound row json=%.*s profile=%.*s\n",
                 static_cast<int>(optional_missing_insert_where_json.size()),
                 optional_missing_insert_where_json.data(),
                 static_cast<int>(optional_missing_insert_where_profile.size()),
                 optional_missing_insert_where_profile.data());
    return 757;
  }
  xpod_qlever_adapter_release_result(adapter, &optional_missing_insert_where_result);

  xpod_qlever_query_request optional_missing_insert_where_verify_request = {};
  optional_missing_insert_where_verify_request.sparql = bytes(
      "SELECT ?tail WHERE { <urn:modified> <urn:p> ?tail }");
  xpod_qlever_query_result optional_missing_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &optional_missing_insert_where_verify_request,
      &optional_missing_insert_where_verify_result);
  std::string_view optional_missing_insert_where_verify_json(
      optional_missing_insert_where_verify_result.result_json.data,
      optional_missing_insert_where_verify_result.result_json.size);
  std::string_view optional_missing_insert_where_verify_error(
      optional_missing_insert_where_verify_result.error_message.data,
      optional_missing_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "optional missing insert where verification query failed: %.*s\n",
                 static_cast<int>(optional_missing_insert_where_verify_error.size()),
                 optional_missing_insert_where_verify_error.data());
    return 758;
  }
  if (optional_missing_insert_where_verify_json.find(R"("bindings":[])") == std::string_view::npos) {
    std::fprintf(stderr, "optional missing insert where verification found row json=%.*s\n",
                 static_cast<int>(optional_missing_insert_where_verify_json.size()),
                 optional_missing_insert_where_verify_json.data());
    return 759;
  }
  xpod_qlever_adapter_release_result(adapter, &optional_missing_insert_where_verify_result);

  xpod_qlever_query_request blank_insert_data_request = {};
  blank_insert_data_request.sparql = bytes(
      "INSERT DATA { _:blank <urn:p> <urn:o> }");
  xpod_qlever_query_result blank_insert_data_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_insert_data_request, &blank_insert_data_result);
  std::string_view blank_insert_data_json(
      blank_insert_data_result.result_json.data,
      blank_insert_data_result.result_json.size);
  std::string_view blank_insert_data_profile(
      blank_insert_data_result.profile_json.data,
      blank_insert_data_result.profile_json.size);
  std::string_view blank_insert_data_error(
      blank_insert_data_result.error_message.data,
      blank_insert_data_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank insert data update failed: %.*s\n",
                 static_cast<int>(blank_insert_data_error.size()),
                 blank_insert_data_error.data());
    return 717;
  }
  if (!state.inserted_blank_row) {
    std::fprintf(stderr, "blank insert data did not insert row json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_insert_data_json.size()),
                 blank_insert_data_json.data(),
                 static_cast<int>(blank_insert_data_profile.size()),
                 blank_insert_data_profile.data());
    return 718;
  }
  if (blank_insert_data_json.find(R"("inserted":1)") == std::string_view::npos ||
      blank_insert_data_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "blank insert data result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_insert_data_json.size()),
                 blank_insert_data_json.data(),
                 static_cast<int>(blank_insert_data_profile.size()),
                 blank_insert_data_profile.data());
    return 719;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_insert_data_result);

  xpod_qlever_query_request blank_insert_data_verify_request = {};
  blank_insert_data_verify_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:p> <urn:o> }");
  xpod_qlever_query_result blank_insert_data_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_insert_data_verify_request,
      &blank_insert_data_verify_result);
  std::string_view blank_insert_data_verify_json(
      blank_insert_data_verify_result.result_json.data,
      blank_insert_data_verify_result.result_json.size);
  std::string_view blank_insert_data_verify_profile(
      blank_insert_data_verify_result.profile_json.data,
      blank_insert_data_verify_result.profile_json.size);
  std::string_view blank_insert_data_verify_error(
      blank_insert_data_verify_result.error_message.data,
      blank_insert_data_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank insert data verification query failed: %.*s\n",
                 static_cast<int>(blank_insert_data_verify_error.size()),
                 blank_insert_data_verify_error.data());
    return 720;
  }
  if (blank_insert_data_verify_json.find(R"("type":"bnode")") == std::string_view::npos) {
    std::fprintf(stderr, "blank insert data verification missing blank node json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_insert_data_verify_json.size()),
                 blank_insert_data_verify_json.data(),
                 static_cast<int>(blank_insert_data_verify_profile.size()),
                 blank_insert_data_verify_profile.data());
    return 721;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_insert_data_verify_result);

  xpod_qlever_query_request named_graph_delete_verify_request = {};
  named_graph_delete_verify_request.sparql = bytes(
      "SELECT ?o WHERE { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> ?o } }");
  xpod_qlever_query_result named_graph_delete_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &named_graph_delete_verify_request, &named_graph_delete_verify_result);
  std::string_view named_graph_delete_verify_json(
      named_graph_delete_verify_result.result_json.data,
      named_graph_delete_verify_result.result_json.size);
  std::string_view named_graph_delete_verify_error(
      named_graph_delete_verify_result.error_message.data,
      named_graph_delete_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "named graph delete data verification query failed: %.*s\n",
                 static_cast<int>(named_graph_delete_verify_error.size()),
                 named_graph_delete_verify_error.data());
    return 693;
  }
  if (named_graph_delete_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "named graph delete data verification still returned deleted row json=%.*s\n",
                 static_cast<int>(named_graph_delete_verify_json.size()),
                 named_graph_delete_verify_json.data());
    return 694;
  }
  xpod_qlever_adapter_release_result(adapter, &named_graph_delete_verify_result);

  xpod_qlever_adapter_release_result(adapter, &result);

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
  if (count_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
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
  if (having_count_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "having count missing value 2 json=%.*s profile=%.*s\n",
                 static_cast<int>(having_count_json.size()),
                 having_count_json.data(),
                 static_cast<int>(having_count_profile.size()),
                 having_count_profile.data());
    return 109;
  }
  if (having_count_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
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
  if (scalar_count_json.find(R"("value":"13")") == std::string_view::npos) {
    std::fprintf(stderr, "scalar count missing value 13 json=%.*s profile=%.*s\n",
                 static_cast<int>(scalar_count_json.size()),
                 scalar_count_json.data(),
                 static_cast<int>(scalar_count_profile.size()),
                 scalar_count_profile.data());
    return 102;
  }
  if (scalar_count_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
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

  xpod_qlever_query_request distinct_scalar_count_request = {};
  distinct_scalar_count_request.sparql = bytes(
      "SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { ?s ?p ?o }");
  xpod_qlever_query_result distinct_scalar_count_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &distinct_scalar_count_request, &distinct_scalar_count_result);
  std::string_view distinct_scalar_count_json(
      distinct_scalar_count_result.result_json.data,
      distinct_scalar_count_result.result_json.size);
  std::string_view distinct_scalar_count_profile(
      distinct_scalar_count_result.profile_json.data,
      distinct_scalar_count_result.profile_json.size);
  std::string_view distinct_scalar_count_error(
      distinct_scalar_count_result.error_message.data,
      distinct_scalar_count_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "distinct scalar count query failed: %.*s\n",
                 static_cast<int>(distinct_scalar_count_error.size()),
                 distinct_scalar_count_error.data());
    return 169;
  }
  if (distinct_scalar_count_json.find(R"("head":{"vars":["count"]})") == std::string_view::npos) {
    std::fprintf(stderr, "distinct scalar count head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(distinct_scalar_count_json.size()),
                 distinct_scalar_count_json.data(),
                 static_cast<int>(distinct_scalar_count_profile.size()),
                 distinct_scalar_count_profile.data());
    return 170;
  }
  if (distinct_scalar_count_json.find(R"("value":"7")") == std::string_view::npos) {
    std::fprintf(stderr, "distinct scalar count missing value 7 json=%.*s profile=%.*s\n",
                 static_cast<int>(distinct_scalar_count_json.size()),
                 distinct_scalar_count_json.data(),
                 static_cast<int>(distinct_scalar_count_profile.size()),
                 distinct_scalar_count_profile.data());
    return 171;
  }
  if (distinct_scalar_count_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
    std::fprintf(stderr, "distinct scalar count missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(distinct_scalar_count_json.size()),
                 distinct_scalar_count_json.data(),
                 static_cast<int>(distinct_scalar_count_profile.size()),
                 distinct_scalar_count_profile.data());
    return 172;
  }
  if (distinct_scalar_count_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "distinct scalar count missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(distinct_scalar_count_json.size()),
                 distinct_scalar_count_json.data(),
                 static_cast<int>(distinct_scalar_count_profile.size()),
                 distinct_scalar_count_profile.data());
    return 173;
  }
  if (int code = assert_native_shape_profile(
          "group aggregate", distinct_scalar_count_profile, "GroupBy", 1210)) {
    return code;
  }
  xpod_qlever_adapter_release_result(adapter, &distinct_scalar_count_result);
  if (kRelationalShapesOnly) {
    xpod_qlever_adapter_destroy(adapter);
    return 0;
  }

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

  xpod_qlever_query_request group_concat_request = {};
  group_concat_request.sparql = bytes(
      "SELECT (GROUP_CONCAT(STR(?s); separator=\",\") AS ?labels) WHERE { ?s ?p ?o }");
  xpod_qlever_query_result group_concat_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &group_concat_request, &group_concat_result);
  std::string_view group_concat_json(
      group_concat_result.result_json.data,
      group_concat_result.result_json.size);
  std::string_view group_concat_profile(
      group_concat_result.profile_json.data,
      group_concat_result.profile_json.size);
  std::string_view group_concat_error(
      group_concat_result.error_message.data,
      group_concat_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "group concat query failed: %.*s\n",
                 static_cast<int>(group_concat_error.size()),
                 group_concat_error.data());
    return 300;
  }
  if (group_concat_json.find(R"("head":{"vars":["labels"]})") == std::string_view::npos) {
    std::fprintf(stderr, "group concat head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(group_concat_json.size()),
                 group_concat_json.data(),
                 static_cast<int>(group_concat_profile.size()),
                 group_concat_profile.data());
    return 301;
  }
  if (group_concat_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "group concat missing label urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(group_concat_json.size()),
                 group_concat_json.data(),
                 static_cast<int>(group_concat_profile.size()),
                 group_concat_profile.data());
    return 302;
  }
  if (group_concat_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "group concat missing label urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(group_concat_json.size()),
                 group_concat_json.data(),
                 static_cast<int>(group_concat_profile.size()),
                 group_concat_profile.data());
    return 303;
  }
  if (group_concat_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "group concat missing label urn:o json=%.*s profile=%.*s\n",
                 static_cast<int>(group_concat_json.size()),
                 group_concat_json.data(),
                 static_cast<int>(group_concat_profile.size()),
                 group_concat_profile.data());
    return 304;
  }
  if (group_concat_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "group concat missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(group_concat_json.size()),
                 group_concat_json.data(),
                 static_cast<int>(group_concat_profile.size()),
                 group_concat_profile.data());
    return 305;
  }
  xpod_qlever_adapter_release_result(adapter, &group_concat_result);

  xpod_qlever_query_request sample_aggregate_request = {};
  sample_aggregate_request.sparql = bytes(
      "SELECT (SAMPLE(?o) AS ?sample) WHERE { <urn:s> <urn:p> ?o }");
  xpod_qlever_query_result sample_aggregate_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &sample_aggregate_request, &sample_aggregate_result);
  std::string_view sample_aggregate_json(
      sample_aggregate_result.result_json.data,
      sample_aggregate_result.result_json.size);
  std::string_view sample_aggregate_profile(
      sample_aggregate_result.profile_json.data,
      sample_aggregate_result.profile_json.size);
  std::string_view sample_aggregate_error(
      sample_aggregate_result.error_message.data,
      sample_aggregate_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "sample aggregate query failed: %.*s\n",
                 static_cast<int>(sample_aggregate_error.size()),
                 sample_aggregate_error.data());
    return 306;
  }
  if (sample_aggregate_json.find(R"("head":{"vars":["sample"]})") == std::string_view::npos) {
    std::fprintf(stderr, "sample aggregate head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(sample_aggregate_json.size()),
                 sample_aggregate_json.data(),
                 static_cast<int>(sample_aggregate_profile.size()),
                 sample_aggregate_profile.data());
    return 307;
  }
  if (sample_aggregate_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "sample aggregate missing urn:o json=%.*s profile=%.*s\n",
                 static_cast<int>(sample_aggregate_json.size()),
                 sample_aggregate_json.data(),
                 static_cast<int>(sample_aggregate_profile.size()),
                 sample_aggregate_profile.data());
    return 308;
  }
  if (sample_aggregate_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "sample aggregate missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(sample_aggregate_json.size()),
                 sample_aggregate_json.data(),
                 static_cast<int>(sample_aggregate_profile.size()),
                 sample_aggregate_profile.data());
    return 309;
  }
  xpod_qlever_adapter_release_result(adapter, &sample_aggregate_result);

  xpod_qlever_query_request numeric_aggregate_request = {};
  numeric_aggregate_request.sparql = bytes(
      "SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s ?p ?o BIND(2 AS ?n) }");
  xpod_qlever_query_result numeric_aggregate_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &numeric_aggregate_request, &numeric_aggregate_result);
  std::string_view numeric_aggregate_json(
      numeric_aggregate_result.result_json.data,
      numeric_aggregate_result.result_json.size);
  std::string_view numeric_aggregate_profile(
      numeric_aggregate_result.profile_json.data,
      numeric_aggregate_result.profile_json.size);
  std::string_view numeric_aggregate_error(
      numeric_aggregate_result.error_message.data,
      numeric_aggregate_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "numeric aggregate query failed: %.*s\n",
                 static_cast<int>(numeric_aggregate_error.size()),
                 numeric_aggregate_error.data());
    return 310;
  }
  if (numeric_aggregate_json.find(R"("head":{"vars":["sum","avg"]})") == std::string_view::npos) {
    std::fprintf(stderr, "numeric aggregate head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(numeric_aggregate_json.size()),
                 numeric_aggregate_json.data(),
                 static_cast<int>(numeric_aggregate_profile.size()),
                 numeric_aggregate_profile.data());
    return 311;
  }
  if (numeric_aggregate_json.find(R"("value":"26")") == std::string_view::npos) {
    std::fprintf(stderr, "numeric aggregate missing sum value 26 json=%.*s profile=%.*s\n",
                 static_cast<int>(numeric_aggregate_json.size()),
                 numeric_aggregate_json.data(),
                 static_cast<int>(numeric_aggregate_profile.size()),
                 numeric_aggregate_profile.data());
    return 312;
  }
  if (numeric_aggregate_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "numeric aggregate missing avg value 2 json=%.*s profile=%.*s\n",
                 static_cast<int>(numeric_aggregate_json.size()),
                 numeric_aggregate_json.data(),
                 static_cast<int>(numeric_aggregate_profile.size()),
                 numeric_aggregate_profile.data());
    return 313;
  }
  if (numeric_aggregate_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos) {
    std::fprintf(stderr, "numeric aggregate missing integer datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(numeric_aggregate_json.size()),
                 numeric_aggregate_json.data(),
                 static_cast<int>(numeric_aggregate_profile.size()),
                 numeric_aggregate_profile.data());
    return 314;
  }
  if (numeric_aggregate_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "numeric aggregate missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(numeric_aggregate_json.size()),
                 numeric_aggregate_json.data(),
                 static_cast<int>(numeric_aggregate_profile.size()),
                 numeric_aggregate_profile.data());
    return 315;
  }
  xpod_qlever_adapter_release_result(adapter, &numeric_aggregate_result);

  xpod_qlever_query_request stored_numeric_aggregate_request = {};
  stored_numeric_aggregate_request.sparql = bytes(
      "SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s <urn:num> ?n }");
  xpod_qlever_query_result stored_numeric_aggregate_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_numeric_aggregate_request, &stored_numeric_aggregate_result);
  std::string_view stored_numeric_aggregate_json(
      stored_numeric_aggregate_result.result_json.data,
      stored_numeric_aggregate_result.result_json.size);
  std::string_view stored_numeric_aggregate_profile(
      stored_numeric_aggregate_result.profile_json.data,
      stored_numeric_aggregate_result.profile_json.size);
  std::string_view stored_numeric_aggregate_error(
      stored_numeric_aggregate_result.error_message.data,
      stored_numeric_aggregate_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored numeric aggregate query failed: %.*s\n",
                 static_cast<int>(stored_numeric_aggregate_error.size()),
                 stored_numeric_aggregate_error.data());
    return 316;
  }
  if (stored_numeric_aggregate_json.find(R"("head":{"vars":["sum","avg"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric aggregate head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_aggregate_json.size()),
                 stored_numeric_aggregate_json.data(),
                 static_cast<int>(stored_numeric_aggregate_profile.size()),
                 stored_numeric_aggregate_profile.data());
    return 317;
  }
  if (stored_numeric_aggregate_json.find(R"("value":"3")") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric aggregate missing sum value 3 json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_aggregate_json.size()),
                 stored_numeric_aggregate_json.data(),
                 static_cast<int>(stored_numeric_aggregate_profile.size()),
                 stored_numeric_aggregate_profile.data());
    return 318;
  }
  if (stored_numeric_aggregate_json.find(R"("value":"1.5")") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric aggregate missing avg value 1.5 json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_aggregate_json.size()),
                 stored_numeric_aggregate_json.data(),
                 static_cast<int>(stored_numeric_aggregate_profile.size()),
                 stored_numeric_aggregate_profile.data());
    return 319;
  }
  if (stored_numeric_aggregate_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos ||
      stored_numeric_aggregate_json.find("http://www.w3.org/2001/XMLSchema#decimal") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric aggregate missing numeric datatypes json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_aggregate_json.size()),
                 stored_numeric_aggregate_json.data(),
                 static_cast<int>(stored_numeric_aggregate_profile.size()),
                 stored_numeric_aggregate_profile.data());
    return 320;
  }
  if (stored_numeric_aggregate_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric aggregate missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_aggregate_json.size()),
                 stored_numeric_aggregate_json.data(),
                 static_cast<int>(stored_numeric_aggregate_profile.size()),
                 stored_numeric_aggregate_profile.data());
    return 321;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_numeric_aggregate_result);

  xpod_qlever_query_request stored_numeric_filter_request = {};
  stored_numeric_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n > 1) } ORDER BY ?s");
  xpod_qlever_query_result stored_numeric_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_numeric_filter_request, &stored_numeric_filter_result);
  std::string_view stored_numeric_filter_json(
      stored_numeric_filter_result.result_json.data,
      stored_numeric_filter_result.result_json.size);
  std::string_view stored_numeric_filter_profile(
      stored_numeric_filter_result.profile_json.data,
      stored_numeric_filter_result.profile_json.size);
  std::string_view stored_numeric_filter_error(
      stored_numeric_filter_result.error_message.data,
      stored_numeric_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored numeric filter query failed: %.*s\n",
                 static_cast<int>(stored_numeric_filter_error.size()),
                 stored_numeric_filter_error.data());
    return 322;
  }
  if (stored_numeric_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_filter_json.size()),
                 stored_numeric_filter_json.data(),
                 static_cast<int>(stored_numeric_filter_profile.size()),
                 stored_numeric_filter_profile.data());
    return 323;
  }
  if (stored_numeric_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric filter missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_filter_json.size()),
                 stored_numeric_filter_json.data(),
                 static_cast<int>(stored_numeric_filter_profile.size()),
                 stored_numeric_filter_profile.data());
    return 324;
  }
  if (stored_numeric_filter_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "stored numeric filter leaked urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_filter_json.size()),
                 stored_numeric_filter_json.data(),
                 static_cast<int>(stored_numeric_filter_profile.size()),
                 stored_numeric_filter_profile.data());
    return 325;
  }
  if (stored_numeric_filter_profile.find("Filter") == std::string_view::npos ||
      stored_numeric_filter_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric filter missing Filter/OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_numeric_filter_json.size()),
                 stored_numeric_filter_json.data(),
                 static_cast<int>(stored_numeric_filter_profile.size()),
                 stored_numeric_filter_profile.data());
    return 326;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_numeric_filter_result);

  xpod_qlever_query_request stored_double_aggregate_request = {};
  stored_double_aggregate_request.sparql = bytes(
      "SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s <urn:double> ?n }");
  xpod_qlever_query_result stored_double_aggregate_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_aggregate_request, &stored_double_aggregate_result);
  std::string_view stored_double_aggregate_json(
      stored_double_aggregate_result.result_json.data,
      stored_double_aggregate_result.result_json.size);
  std::string_view stored_double_aggregate_profile(
      stored_double_aggregate_result.profile_json.data,
      stored_double_aggregate_result.profile_json.size);
  std::string_view stored_double_aggregate_error(
      stored_double_aggregate_result.error_message.data,
      stored_double_aggregate_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double aggregate query failed: %.*s\n",
                 static_cast<int>(stored_double_aggregate_error.size()),
                 stored_double_aggregate_error.data());
    return 327;
  }
  if (stored_double_aggregate_json.find(R"("head":{"vars":["sum","avg"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double aggregate head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_aggregate_json.size()),
                 stored_double_aggregate_json.data(),
                 static_cast<int>(stored_double_aggregate_profile.size()),
                 stored_double_aggregate_profile.data());
    return 328;
  }
  if (stored_double_aggregate_json.find(R"("value":"4")") == std::string_view::npos) {
    std::fprintf(stderr, "stored double aggregate missing sum value 4 json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_aggregate_json.size()),
                 stored_double_aggregate_json.data(),
                 static_cast<int>(stored_double_aggregate_profile.size()),
                 stored_double_aggregate_profile.data());
    return 329;
  }
  if (stored_double_aggregate_json.find(R"("value":"2")") == std::string_view::npos) {
    std::fprintf(stderr, "stored double aggregate missing avg value 2 json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_aggregate_json.size()),
                 stored_double_aggregate_json.data(),
                 static_cast<int>(stored_double_aggregate_profile.size()),
                 stored_double_aggregate_profile.data());
    return 330;
  }
  if (stored_double_aggregate_json.find("http://www.w3.org/2001/XMLSchema#decimal") == std::string_view::npos) {
    std::fprintf(stderr, "stored double aggregate missing double datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_aggregate_json.size()),
                 stored_double_aggregate_json.data(),
                 static_cast<int>(stored_double_aggregate_profile.size()),
                 stored_double_aggregate_profile.data());
    return 331;
  }
  if (stored_double_aggregate_profile.find("GroupBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored double aggregate missing GroupBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_aggregate_json.size()),
                 stored_double_aggregate_json.data(),
                 static_cast<int>(stored_double_aggregate_profile.size()),
                 stored_double_aggregate_profile.data());
    return 332;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_aggregate_result);

  xpod_qlever_query_request stored_double_filter_request = {};
  stored_double_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n > 2) } ORDER BY ?s");
  xpod_qlever_query_result stored_double_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_filter_request, &stored_double_filter_result);
  std::string_view stored_double_filter_json(
      stored_double_filter_result.result_json.data,
      stored_double_filter_result.result_json.size);
  std::string_view stored_double_filter_profile(
      stored_double_filter_result.profile_json.data,
      stored_double_filter_result.profile_json.size);
  std::string_view stored_double_filter_error(
      stored_double_filter_result.error_message.data,
      stored_double_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double filter query failed: %.*s\n",
                 static_cast<int>(stored_double_filter_error.size()),
                 stored_double_filter_error.data());
    return 333;
  }
  if (stored_double_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_filter_json.size()),
                 stored_double_filter_json.data(),
                 static_cast<int>(stored_double_filter_profile.size()),
                 stored_double_filter_profile.data());
    return 334;
  }
  if (stored_double_filter_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored double filter missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_filter_json.size()),
                 stored_double_filter_json.data(),
                 static_cast<int>(stored_double_filter_profile.size()),
                 stored_double_filter_profile.data());
    return 335;
  }
  if (stored_double_filter_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "stored double filter leaked urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_filter_json.size()),
                 stored_double_filter_json.data(),
                 static_cast<int>(stored_double_filter_profile.size()),
                 stored_double_filter_profile.data());
    return 336;
  }
  if (stored_double_filter_profile.find("Filter") == std::string_view::npos ||
      stored_double_filter_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored double filter missing Filter/OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_filter_json.size()),
                 stored_double_filter_json.data(),
                 static_cast<int>(stored_double_filter_profile.size()),
                 stored_double_filter_profile.data());
    return 337;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_filter_result);

  xpod_qlever_query_request stored_double_order_request = {};
  stored_double_order_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:double> ?n } ORDER BY DESC(?n) LIMIT 1");
  xpod_qlever_query_result stored_double_order_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_order_request, &stored_double_order_result);
  std::string_view stored_double_order_json(
      stored_double_order_result.result_json.data,
      stored_double_order_result.result_json.size);
  std::string_view stored_double_order_profile(
      stored_double_order_result.profile_json.data,
      stored_double_order_result.profile_json.size);
  std::string_view stored_double_order_error(
      stored_double_order_result.error_message.data,
      stored_double_order_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double order query failed: %.*s\n",
                 static_cast<int>(stored_double_order_error.size()),
                 stored_double_order_error.data());
    return 338;
  }
  if (stored_double_order_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double order head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_order_json.size()),
                 stored_double_order_json.data(),
                 static_cast<int>(stored_double_order_profile.size()),
                 stored_double_order_profile.data());
    return 339;
  }
  if (stored_double_order_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored double order missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_order_json.size()),
                 stored_double_order_json.data(),
                 static_cast<int>(stored_double_order_profile.size()),
                 stored_double_order_profile.data());
    return 340;
  }
  if (stored_double_order_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "stored double order leaked urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_order_json.size()),
                 stored_double_order_json.data(),
                 static_cast<int>(stored_double_order_profile.size()),
                 stored_double_order_profile.data());
    return 341;
  }
  if (stored_double_order_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored double order missing OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_order_json.size()),
                 stored_double_order_json.data(),
                 static_cast<int>(stored_double_order_profile.size()),
                 stored_double_order_profile.data());
    return 342;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_order_result);

  xpod_qlever_query_request stored_numeric_projection_request = {};
  stored_numeric_projection_request.sparql = bytes(
      "SELECT ?i ?d WHERE { <urn:s> <urn:num> ?i . <urn:s> <urn:double> ?d }");
  xpod_qlever_query_result stored_numeric_projection_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_numeric_projection_request, &stored_numeric_projection_result);
  std::string_view stored_numeric_projection_json(
      stored_numeric_projection_result.result_json.data,
      stored_numeric_projection_result.result_json.size);
  std::string_view stored_numeric_projection_error(
      stored_numeric_projection_result.error_message.data,
      stored_numeric_projection_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored numeric projection query failed: %.*s\n",
                 static_cast<int>(stored_numeric_projection_error.size()),
                 stored_numeric_projection_error.data());
    return 343;
  }
  if (stored_numeric_projection_json.find(R"("head":{"vars":["i","d"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric projection head mismatch json=%.*s\n",
                 static_cast<int>(stored_numeric_projection_json.size()),
                 stored_numeric_projection_json.data());
    return 344;
  }
  if (stored_numeric_projection_json.find(R"("value":"1")") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric projection missing integer value 1 json=%.*s\n",
                 static_cast<int>(stored_numeric_projection_json.size()),
                 stored_numeric_projection_json.data());
    return 345;
  }
  if (stored_numeric_projection_json.find(R"("value":"1.5")") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric projection missing double value 1.5 json=%.*s\n",
                 static_cast<int>(stored_numeric_projection_json.size()),
                 stored_numeric_projection_json.data());
    return 346;
  }
  if (stored_numeric_projection_json.find("http://www.w3.org/2001/XMLSchema#int") == std::string_view::npos ||
      stored_numeric_projection_json.find("http://www.w3.org/2001/XMLSchema#decimal") == std::string_view::npos) {
    std::fprintf(stderr, "stored numeric projection missing numeric datatypes json=%.*s\n",
                 static_cast<int>(stored_numeric_projection_json.size()),
                 stored_numeric_projection_json.data());
    return 347;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_numeric_projection_result);

  xpod_qlever_query_request stored_double_arithmetic_request = {};
  stored_double_arithmetic_request.sparql = bytes(
      "SELECT ?s ?m WHERE { ?s <urn:double> ?n BIND((?n + 1) AS ?m) } ORDER BY ?s");
  xpod_qlever_query_result stored_double_arithmetic_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_arithmetic_request, &stored_double_arithmetic_result);
  std::string_view stored_double_arithmetic_json(
      stored_double_arithmetic_result.result_json.data,
      stored_double_arithmetic_result.result_json.size);
  std::string_view stored_double_arithmetic_profile(
      stored_double_arithmetic_result.profile_json.data,
      stored_double_arithmetic_result.profile_json.size);
  std::string_view stored_double_arithmetic_error(
      stored_double_arithmetic_result.error_message.data,
      stored_double_arithmetic_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double arithmetic query failed: %.*s\n",
                 static_cast<int>(stored_double_arithmetic_error.size()),
                 stored_double_arithmetic_error.data());
    return 348;
  }
  if (stored_double_arithmetic_json.find(R"("head":{"vars":["s","m"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double arithmetic head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_arithmetic_json.size()),
                 stored_double_arithmetic_json.data(),
                 static_cast<int>(stored_double_arithmetic_profile.size()),
                 stored_double_arithmetic_profile.data());
    return 349;
  }
  if (stored_double_arithmetic_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored double arithmetic missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_arithmetic_json.size()),
                 stored_double_arithmetic_json.data(),
                 static_cast<int>(stored_double_arithmetic_profile.size()),
                 stored_double_arithmetic_profile.data());
    return 350;
  }
  if (stored_double_arithmetic_json.find(R"("value":"3.5")") == std::string_view::npos) {
    std::fprintf(stderr, "stored double arithmetic missing value 3.5 json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_arithmetic_json.size()),
                 stored_double_arithmetic_json.data(),
                 static_cast<int>(stored_double_arithmetic_profile.size()),
                 stored_double_arithmetic_profile.data());
    return 351;
  }
  if (stored_double_arithmetic_json.find("http://www.w3.org/2001/XMLSchema#decimal") == std::string_view::npos) {
    std::fprintf(stderr, "stored double arithmetic missing double datatype json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_arithmetic_json.size()),
                 stored_double_arithmetic_json.data(),
                 static_cast<int>(stored_double_arithmetic_profile.size()),
                 stored_double_arithmetic_profile.data());
    return 352;
  }
  if (stored_double_arithmetic_profile.find("BIND") == std::string_view::npos ||
      stored_double_arithmetic_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored double arithmetic missing BIND/OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_arithmetic_json.size()),
                 stored_double_arithmetic_json.data(),
                 static_cast<int>(stored_double_arithmetic_profile.size()),
                 stored_double_arithmetic_profile.data());
    return 353;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_arithmetic_result);

  xpod_qlever_query_request stored_bool_projection_request = {};
  stored_bool_projection_request.sparql = bytes(
      "SELECT ?flag WHERE { <urn:s> <urn:flag> ?flag }");
  xpod_qlever_query_result stored_bool_projection_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_bool_projection_request, &stored_bool_projection_result);
  std::string_view stored_bool_projection_json(
      stored_bool_projection_result.result_json.data,
      stored_bool_projection_result.result_json.size);
  std::string_view stored_bool_projection_error(
      stored_bool_projection_result.error_message.data,
      stored_bool_projection_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored bool projection query failed: %.*s\n",
                 static_cast<int>(stored_bool_projection_error.size()),
                 stored_bool_projection_error.data());
    return 354;
  }
  if (stored_bool_projection_json.find(R"("head":{"vars":["flag"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool projection head mismatch json=%.*s\n",
                 static_cast<int>(stored_bool_projection_json.size()),
                 stored_bool_projection_json.data());
    return 355;
  }
  if (stored_bool_projection_json.find(R"("value":"true")") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool projection missing true value json=%.*s\n",
                 static_cast<int>(stored_bool_projection_json.size()),
                 stored_bool_projection_json.data());
    return 356;
  }
  if (stored_bool_projection_json.find("http://www.w3.org/2001/XMLSchema#boolean") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool projection missing boolean datatype json=%.*s\n",
                 static_cast<int>(stored_bool_projection_json.size()),
                 stored_bool_projection_json.data());
    return 357;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_bool_projection_result);

  xpod_qlever_query_request stored_bool_filter_request = {};
  stored_bool_filter_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag) } ORDER BY ?s");
  xpod_qlever_query_result stored_bool_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_bool_filter_request, &stored_bool_filter_result);
  std::string_view stored_bool_filter_json(
      stored_bool_filter_result.result_json.data,
      stored_bool_filter_result.result_json.size);
  std::string_view stored_bool_filter_profile(
      stored_bool_filter_result.profile_json.data,
      stored_bool_filter_result.profile_json.size);
  std::string_view stored_bool_filter_error(
      stored_bool_filter_result.error_message.data,
      stored_bool_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored bool filter query failed: %.*s\n",
                 static_cast<int>(stored_bool_filter_error.size()),
                 stored_bool_filter_error.data());
    return 358;
  }
  if (stored_bool_filter_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool filter head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_filter_json.size()),
                 stored_bool_filter_json.data(),
                 static_cast<int>(stored_bool_filter_profile.size()),
                 stored_bool_filter_profile.data());
    return 359;
  }
  if (stored_bool_filter_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool filter missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_filter_json.size()),
                 stored_bool_filter_json.data(),
                 static_cast<int>(stored_bool_filter_profile.size()),
                 stored_bool_filter_profile.data());
    return 360;
  }
  if (stored_bool_filter_json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "stored bool filter leaked urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_filter_json.size()),
                 stored_bool_filter_json.data(),
                 static_cast<int>(stored_bool_filter_profile.size()),
                 stored_bool_filter_profile.data());
    return 361;
  }
  if (stored_bool_filter_profile.find("Filter") == std::string_view::npos ||
      stored_bool_filter_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool filter missing Filter/OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_filter_json.size()),
                 stored_bool_filter_json.data(),
                 static_cast<int>(stored_bool_filter_profile.size()),
                 stored_bool_filter_profile.data());
    return 362;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_bool_filter_result);

  xpod_qlever_query_request stored_int_constant_request = {};
  stored_int_constant_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:num> 1 } ORDER BY ?s");
  xpod_qlever_query_result stored_int_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_int_constant_request, &stored_int_constant_result);
  std::string_view stored_int_constant_json(
      stored_int_constant_result.result_json.data,
      stored_int_constant_result.result_json.size);
  std::string_view stored_int_constant_profile(
      stored_int_constant_result.profile_json.data,
      stored_int_constant_result.profile_json.size);
  std::string_view stored_int_constant_error(
      stored_int_constant_result.error_message.data,
      stored_int_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored int constant query failed: %.*s\n",
                 static_cast<int>(stored_int_constant_error.size()),
                 stored_int_constant_error.data());
    return 363;
  }
  if (stored_int_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored int constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_constant_json.size()),
                 stored_int_constant_json.data(),
                 static_cast<int>(stored_int_constant_profile.size()),
                 stored_int_constant_profile.data());
    return 364;
  }
  if (stored_int_constant_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "stored int constant missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_constant_json.size()),
                 stored_int_constant_json.data(),
                 static_cast<int>(stored_int_constant_profile.size()),
                 stored_int_constant_profile.data());
    return 365;
  }
  if (stored_int_constant_json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "stored int constant leaked urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_constant_json.size()),
                 stored_int_constant_json.data(),
                 static_cast<int>(stored_int_constant_profile.size()),
                 stored_int_constant_profile.data());
    return 366;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_int_constant_result);

  xpod_qlever_query_request stored_double_constant_request = {};
  stored_double_constant_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:double> 2.5 } ORDER BY ?s");
  xpod_qlever_query_result stored_double_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_constant_request, &stored_double_constant_result);
  std::string_view stored_double_constant_json(
      stored_double_constant_result.result_json.data,
      stored_double_constant_result.result_json.size);
  std::string_view stored_double_constant_profile(
      stored_double_constant_result.profile_json.data,
      stored_double_constant_result.profile_json.size);
  std::string_view stored_double_constant_error(
      stored_double_constant_result.error_message.data,
      stored_double_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double constant query failed: %.*s\n",
                 static_cast<int>(stored_double_constant_error.size()),
                 stored_double_constant_error.data());
    return 367;
  }
  if (stored_double_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_constant_json.size()),
                 stored_double_constant_json.data(),
                 static_cast<int>(stored_double_constant_profile.size()),
                 stored_double_constant_profile.data());
    return 368;
  }
  if (stored_double_constant_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored double constant missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_constant_json.size()),
                 stored_double_constant_json.data(),
                 static_cast<int>(stored_double_constant_profile.size()),
                 stored_double_constant_profile.data());
    return 369;
  }
  if (stored_double_constant_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "stored double constant leaked urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_constant_json.size()),
                 stored_double_constant_json.data(),
                 static_cast<int>(stored_double_constant_profile.size()),
                 stored_double_constant_profile.data());
    return 370;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_constant_result);

  xpod_qlever_query_request stored_bool_constant_request = {};
  stored_bool_constant_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:flag> true } ORDER BY ?s");
  xpod_qlever_query_result stored_bool_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_bool_constant_request, &stored_bool_constant_result);
  std::string_view stored_bool_constant_json(
      stored_bool_constant_result.result_json.data,
      stored_bool_constant_result.result_json.size);
  std::string_view stored_bool_constant_profile(
      stored_bool_constant_result.profile_json.data,
      stored_bool_constant_result.profile_json.size);
  std::string_view stored_bool_constant_error(
      stored_bool_constant_result.error_message.data,
      stored_bool_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored bool constant query failed: %.*s\n",
                 static_cast<int>(stored_bool_constant_error.size()),
                 stored_bool_constant_error.data());
    return 371;
  }
  if (stored_bool_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_constant_json.size()),
                 stored_bool_constant_json.data(),
                 static_cast<int>(stored_bool_constant_profile.size()),
                 stored_bool_constant_profile.data());
    return 372;
  }
  if (stored_bool_constant_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool constant missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_constant_json.size()),
                 stored_bool_constant_json.data(),
                 static_cast<int>(stored_bool_constant_profile.size()),
                 stored_bool_constant_profile.data());
    return 373;
  }
  if (stored_bool_constant_json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "stored bool constant leaked urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_constant_json.size()),
                 stored_bool_constant_json.data(),
                 static_cast<int>(stored_bool_constant_profile.size()),
                 stored_bool_constant_profile.data());
    return 374;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_bool_constant_result);

  xpod_qlever_query_request stored_int_values_constant_request = {};
  stored_int_values_constant_request.sparql = bytes(
      "SELECT ?s WHERE { VALUES ?n { 1 } ?s <urn:num> ?n } ORDER BY ?s");
  xpod_qlever_query_result stored_int_values_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_int_values_constant_request, &stored_int_values_constant_result);
  std::string_view stored_int_values_constant_json(
      stored_int_values_constant_result.result_json.data,
      stored_int_values_constant_result.result_json.size);
  std::string_view stored_int_values_constant_profile(
      stored_int_values_constant_result.profile_json.data,
      stored_int_values_constant_result.profile_json.size);
  std::string_view stored_int_values_constant_error(
      stored_int_values_constant_result.error_message.data,
      stored_int_values_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored int VALUES constant query failed: %.*s\n",
                 static_cast<int>(stored_int_values_constant_error.size()),
                 stored_int_values_constant_error.data());
    return 375;
  }
  if (stored_int_values_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored int VALUES constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_values_constant_json.size()),
                 stored_int_values_constant_json.data(),
                 static_cast<int>(stored_int_values_constant_profile.size()),
                 stored_int_values_constant_profile.data());
    return 376;
  }
  if (stored_int_values_constant_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "stored int VALUES constant missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_values_constant_json.size()),
                 stored_int_values_constant_json.data(),
                 static_cast<int>(stored_int_values_constant_profile.size()),
                 stored_int_values_constant_profile.data());
    return 377;
  }
  if (stored_int_values_constant_json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "stored int VALUES constant leaked urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_int_values_constant_json.size()),
                 stored_int_values_constant_json.data(),
                 static_cast<int>(stored_int_values_constant_profile.size()),
                 stored_int_values_constant_profile.data());
    return 378;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_int_values_constant_result);

  xpod_qlever_query_request stored_double_values_constant_request = {};
  stored_double_values_constant_request.sparql = bytes(
      "SELECT ?s WHERE { VALUES ?n { 2.5 } ?s <urn:double> ?n } ORDER BY ?s");
  xpod_qlever_query_result stored_double_values_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_double_values_constant_request, &stored_double_values_constant_result);
  std::string_view stored_double_values_constant_json(
      stored_double_values_constant_result.result_json.data,
      stored_double_values_constant_result.result_json.size);
  std::string_view stored_double_values_constant_profile(
      stored_double_values_constant_result.profile_json.data,
      stored_double_values_constant_result.profile_json.size);
  std::string_view stored_double_values_constant_error(
      stored_double_values_constant_result.error_message.data,
      stored_double_values_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored double VALUES constant query failed: %.*s\n",
                 static_cast<int>(stored_double_values_constant_error.size()),
                 stored_double_values_constant_error.data());
    return 379;
  }
  if (stored_double_values_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored double VALUES constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_values_constant_json.size()),
                 stored_double_values_constant_json.data(),
                 static_cast<int>(stored_double_values_constant_profile.size()),
                 stored_double_values_constant_profile.data());
    return 380;
  }
  if (stored_double_values_constant_json.find("urn:literal-s") == std::string_view::npos) {
    std::fprintf(stderr, "stored double VALUES constant missing urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_values_constant_json.size()),
                 stored_double_values_constant_json.data(),
                 static_cast<int>(stored_double_values_constant_profile.size()),
                 stored_double_values_constant_profile.data());
    return 381;
  }
  if (stored_double_values_constant_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "stored double VALUES constant leaked urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_double_values_constant_json.size()),
                 stored_double_values_constant_json.data(),
                 static_cast<int>(stored_double_values_constant_profile.size()),
                 stored_double_values_constant_profile.data());
    return 382;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_double_values_constant_result);

  xpod_qlever_query_request stored_bool_values_constant_request = {};
  stored_bool_values_constant_request.sparql = bytes(
      "SELECT ?s WHERE { VALUES ?flag { true } ?s <urn:flag> ?flag } ORDER BY ?s");
  xpod_qlever_query_result stored_bool_values_constant_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_bool_values_constant_request, &stored_bool_values_constant_result);
  std::string_view stored_bool_values_constant_json(
      stored_bool_values_constant_result.result_json.data,
      stored_bool_values_constant_result.result_json.size);
  std::string_view stored_bool_values_constant_profile(
      stored_bool_values_constant_result.profile_json.data,
      stored_bool_values_constant_result.profile_json.size);
  std::string_view stored_bool_values_constant_error(
      stored_bool_values_constant_result.error_message.data,
      stored_bool_values_constant_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored bool VALUES constant query failed: %.*s\n",
                 static_cast<int>(stored_bool_values_constant_error.size()),
                 stored_bool_values_constant_error.data());
    return 383;
  }
  if (stored_bool_values_constant_json.find(R"("head":{"vars":["s"]})") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool VALUES constant head mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_values_constant_json.size()),
                 stored_bool_values_constant_json.data(),
                 static_cast<int>(stored_bool_values_constant_profile.size()),
                 stored_bool_values_constant_profile.data());
    return 384;
  }
  if (stored_bool_values_constant_json.find("urn:s") == std::string_view::npos) {
    std::fprintf(stderr, "stored bool VALUES constant missing urn:s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_values_constant_json.size()),
                 stored_bool_values_constant_json.data(),
                 static_cast<int>(stored_bool_values_constant_profile.size()),
                 stored_bool_values_constant_profile.data());
    return 385;
  }
  if (stored_bool_values_constant_json.find("urn:literal-s") != std::string_view::npos) {
    std::fprintf(stderr, "stored bool VALUES constant leaked urn:literal-s json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_bool_values_constant_json.size()),
                 stored_bool_values_constant_json.data(),
                 static_cast<int>(stored_bool_values_constant_profile.size()),
                 stored_bool_values_constant_profile.data());
    return 386;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_bool_values_constant_result);

  if (int code = expect_select_s_pair_result(
          adapter,
          "stored int multi-row VALUES constant",
          "SELECT ?s WHERE { VALUES ?n { 1 2 } ?s <urn:num> ?n } ORDER BY ?s",
          471)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored double multi-row VALUES constant",
          "SELECT ?s WHERE { VALUES ?n { 1.5 2.5 } ?s <urn:double> ?n } ORDER BY ?s",
          479)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored bool multi-row VALUES constant",
          "SELECT ?s WHERE { VALUES ?flag { true false } ?s <urn:flag> ?flag } ORDER BY ?s",
          487)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored int multi-column VALUES constant",
          "SELECT ?s WHERE { VALUES (?s ?n) { (<urn:s> 1) (<urn:literal-s> 2) } ?s <urn:num> ?n } ORDER BY ?s",
          495)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored bool multi-column VALUES constant",
          "SELECT ?s WHERE { VALUES (?s ?flag) { (<urn:s> true) (<urn:literal-s> false) } ?s <urn:flag> ?flag } ORDER BY ?s",
          503)) {
    return code;
  }

  if (int code = expect_select_s_result(
          adapter,
          "stored int equals filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n = 1) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          411)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored int not-equals filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n != 1) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          415)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored double equals filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n = 2.5) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          419)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored double not-equals filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n != 2.5) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          423)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored bool equals filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag = true) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          427)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored bool not-equals filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag != true) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          431)) {
    return code;
  }

  if (int code = expect_select_s_pair_result(
          adapter,
          "stored int multi-value IN filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n IN (1, 2)) } ORDER BY ?s",
          435)) {
    return code;
  }
  if (int code = expect_select_s_empty_result(
          adapter,
          "stored int multi-value NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n NOT IN (1, 2)) } ORDER BY ?s",
          443)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored double multi-value IN filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n IN (1.5, 2.5)) } ORDER BY ?s",
          447)) {
    return code;
  }
  if (int code = expect_select_s_empty_result(
          adapter,
          "stored double multi-value NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n NOT IN (1.5, 2.5)) } ORDER BY ?s",
          455)) {
    return code;
  }
  if (int code = expect_select_s_pair_result(
          adapter,
          "stored bool multi-value IN filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag IN (true, false)) } ORDER BY ?s",
          459)) {
    return code;
  }
  if (int code = expect_select_s_empty_result(
          adapter,
          "stored bool multi-value NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag NOT IN (true, false)) } ORDER BY ?s",
          467)) {
    return code;
  }

  if (int code = expect_select_s_result(
          adapter,
          "stored int IN filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n IN (1)) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          387)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored int NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n NOT IN (1)) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          391)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored double IN filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n IN (2.5)) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          395)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored double NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n NOT IN (2.5)) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          399)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored bool IN filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag IN (true)) } ORDER BY ?s",
          "urn:s",
          "urn:literal-s",
          403)) {
    return code;
  }
  if (int code = expect_select_s_result(
          adapter,
          "stored bool NOT IN filter",
          "SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag NOT IN (true)) } ORDER BY ?s",
          "urn:literal-s",
          "urn:s",
          407)) {
    return code;
  }

  xpod_qlever_query_request blank_link_request = {};
  blank_link_request.sparql = bytes(
      "INSERT DATA { _:link <urn:p> <urn:o> . <urn:blank-object-holder> <urn:p> _:link }");
  xpod_qlever_query_result blank_link_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_link_request, &blank_link_result);
  std::string_view blank_link_json(
      blank_link_result.result_json.data,
      blank_link_result.result_json.size);
  std::string_view blank_link_profile(
      blank_link_result.profile_json.data,
      blank_link_result.profile_json.size);
  std::string_view blank_link_error(
      blank_link_result.error_message.data,
      blank_link_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank link update failed: %.*s\n",
                 static_cast<int>(blank_link_error.size()),
                 blank_link_error.data());
    return 520;
  }
  if (!state.inserted_blank_link_row) {
    std::fprintf(stderr, "blank link update did not insert object blank row json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_link_json.size()),
                 blank_link_json.data(),
                 static_cast<int>(blank_link_profile.size()),
                 blank_link_profile.data());
    return 521;
  }
  if (blank_link_json.find(R"("inserted":2)") == std::string_view::npos ||
      blank_link_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "blank link update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_link_json.size()),
                 blank_link_json.data(),
                 static_cast<int>(blank_link_profile.size()),
                 blank_link_profile.data());
    return 522;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_link_result);

  xpod_qlever_query_request blank_link_verify_request = {};
  blank_link_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:blank-object-holder> <urn:p> ?o }");
  xpod_qlever_query_result blank_link_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &blank_link_verify_request, &blank_link_verify_result);
  std::string_view blank_link_verify_json(
      blank_link_verify_result.result_json.data,
      blank_link_verify_result.result_json.size);
  std::string_view blank_link_verify_profile(
      blank_link_verify_result.profile_json.data,
      blank_link_verify_result.profile_json.size);
  std::string_view blank_link_verify_error(
      blank_link_verify_result.error_message.data,
      blank_link_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "blank link verification query failed: %.*s\n",
                 static_cast<int>(blank_link_verify_error.size()),
                 blank_link_verify_error.data());
    return 523;
  }
  if (blank_link_verify_json.find(R"("type":"bnode")") == std::string_view::npos) {
    std::fprintf(stderr, "blank link verification missing blank node json=%.*s profile=%.*s\n",
                 static_cast<int>(blank_link_verify_json.size()),
                 blank_link_verify_json.data(),
                 static_cast<int>(blank_link_verify_profile.size()),
                 blank_link_verify_profile.data());
    return 524;
  }
  xpod_qlever_adapter_release_result(adapter, &blank_link_verify_result);

  xpod_qlever_query_request graph_modify_source_request = {};
  graph_modify_source_request.sparql = bytes(
      "INSERT DATA { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> <urn:o> } }");
  xpod_qlever_query_result graph_modify_source_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &graph_modify_source_request, &graph_modify_source_result);
  std::string_view graph_modify_source_json(
      graph_modify_source_result.result_json.data,
      graph_modify_source_result.result_json.size);
  std::string_view graph_modify_source_profile(
      graph_modify_source_result.profile_json.data,
      graph_modify_source_result.profile_json.size);
  std::string_view graph_modify_source_error(
      graph_modify_source_result.error_message.data,
      graph_modify_source_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "graph modify source insert failed: %.*s\n",
                 static_cast<int>(graph_modify_source_error.size()),
                 graph_modify_source_error.data());
    return 530;
  }
  if (!state.inserted_graph_row ||
      graph_modify_source_json.find(R"("inserted":1)") == std::string_view::npos ||
      graph_modify_source_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "graph modify source insert mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_modify_source_json.size()),
                 graph_modify_source_json.data(),
                 static_cast<int>(graph_modify_source_profile.size()),
                 graph_modify_source_profile.data());
    return 531;
  }
  xpod_qlever_adapter_release_result(adapter, &graph_modify_source_result);

  xpod_qlever_query_request graph_modify_request = {};
  graph_modify_request.sparql = bytes(
      "DELETE { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> ?o } } "
      "INSERT { GRAPH <urn:g> { <urn:modified-graph> <urn:p> ?o } } "
      "WHERE { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> ?o } }");
  xpod_qlever_query_result graph_modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &graph_modify_request, &graph_modify_result);
  std::string_view graph_modify_json(
      graph_modify_result.result_json.data,
      graph_modify_result.result_json.size);
  std::string_view graph_modify_profile(
      graph_modify_result.profile_json.data,
      graph_modify_result.profile_json.size);
  std::string_view graph_modify_error(
      graph_modify_result.error_message.data,
      graph_modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "graph modify update failed: %.*s\n",
                 static_cast<int>(graph_modify_error.size()),
                 graph_modify_error.data());
    return 532;
  }
  if (state.inserted_graph_row || !state.modified_graph_row) {
    std::fprintf(stderr, "graph modify update did not move graph row json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_modify_json.size()),
                 graph_modify_json.data(),
                 static_cast<int>(graph_modify_profile.size()),
                 graph_modify_profile.data());
    return 533;
  }
  if (graph_modify_json.find(R"("inserted":1)") == std::string_view::npos ||
      graph_modify_json.find(R"("deleted":1)") == std::string_view::npos ||
      graph_modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "graph modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_modify_json.size()),
                 graph_modify_json.data(),
                 static_cast<int>(graph_modify_profile.size()),
                 graph_modify_profile.data());
    return 534;
  }
  xpod_qlever_adapter_release_result(adapter, &graph_modify_result);

  xpod_qlever_query_request graph_modify_verify_request = {};
  graph_modify_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:g> WHERE { ?s <urn:p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result graph_modify_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &graph_modify_verify_request, &graph_modify_verify_result);
  std::string_view graph_modify_verify_json(
      graph_modify_verify_result.result_json.data,
      graph_modify_verify_result.result_json.size);
  std::string_view graph_modify_verify_profile(
      graph_modify_verify_result.profile_json.data,
      graph_modify_verify_result.profile_json.size);
  std::string_view graph_modify_verify_error(
      graph_modify_verify_result.error_message.data,
      graph_modify_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "graph modify verification query failed: %.*s\n",
                 static_cast<int>(graph_modify_verify_error.size()),
                 graph_modify_verify_error.data());
    return 535;
  }
  if (graph_modify_verify_json.find("urn:modified-graph") == std::string_view::npos ||
      graph_modify_verify_json.find("urn:inserted-graph") != std::string_view::npos) {
    std::fprintf(stderr, "graph modify verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(graph_modify_verify_json.size()),
                 graph_modify_verify_json.data(),
                 static_cast<int>(graph_modify_verify_profile.size()),
                 graph_modify_verify_profile.data());
    return 536;
  }
  xpod_qlever_adapter_release_result(adapter, &graph_modify_verify_result);

  xpod_qlever_query_request with_modify_source_request = {};
  with_modify_source_request.sparql = bytes(
      "INSERT DATA { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> <urn:o> } }");
  xpod_qlever_query_result with_modify_source_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &with_modify_source_request, &with_modify_source_result);
  std::string_view with_modify_source_json(
      with_modify_source_result.result_json.data,
      with_modify_source_result.result_json.size);
  std::string_view with_modify_source_profile(
      with_modify_source_result.profile_json.data,
      with_modify_source_result.profile_json.size);
  std::string_view with_modify_source_error(
      with_modify_source_result.error_message.data,
      with_modify_source_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "WITH modify source insert failed: %.*s\n",
                 static_cast<int>(with_modify_source_error.size()),
                 with_modify_source_error.data());
    return 537;
  }
  if (!state.inserted_graph_row ||
      with_modify_source_json.find(R"("inserted":1)") == std::string_view::npos ||
      with_modify_source_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "WITH modify source insert mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(with_modify_source_json.size()),
                 with_modify_source_json.data(),
                 static_cast<int>(with_modify_source_profile.size()),
                 with_modify_source_profile.data());
    return 538;
  }
  xpod_qlever_adapter_release_result(adapter, &with_modify_source_result);

  xpod_qlever_query_request with_modify_request = {};
  with_modify_request.sparql = bytes(
      "WITH <urn:g> "
      "DELETE { <urn:inserted-graph> <urn:p> ?o } "
      "INSERT { <urn:with-modified-graph> <urn:p> ?o } "
      "WHERE { <urn:inserted-graph> <urn:p> ?o }");
  xpod_qlever_query_result with_modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &with_modify_request, &with_modify_result);
  std::string_view with_modify_json(
      with_modify_result.result_json.data,
      with_modify_result.result_json.size);
  std::string_view with_modify_profile(
      with_modify_result.profile_json.data,
      with_modify_result.profile_json.size);
  std::string_view with_modify_error(
      with_modify_result.error_message.data,
      with_modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "WITH modify update failed: %.*s\n",
                 static_cast<int>(with_modify_error.size()),
                 with_modify_error.data());
    return 539;
  }
  if (state.inserted_graph_row || !state.modified_with_graph_row) {
    std::fprintf(stderr, "WITH modify update did not move graph row json=%.*s profile=%.*s\n",
                 static_cast<int>(with_modify_json.size()),
                 with_modify_json.data(),
                 static_cast<int>(with_modify_profile.size()),
                 with_modify_profile.data());
    return 540;
  }
  if (with_modify_json.find(R"("inserted":1)") == std::string_view::npos ||
      with_modify_json.find(R"("deleted":1)") == std::string_view::npos ||
      with_modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "WITH modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(with_modify_json.size()),
                 with_modify_json.data(),
                 static_cast<int>(with_modify_profile.size()),
                 with_modify_profile.data());
    return 541;
  }
  xpod_qlever_adapter_release_result(adapter, &with_modify_result);

  xpod_qlever_query_request with_modify_verify_request = {};
  with_modify_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:g> WHERE { ?s <urn:p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result with_modify_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &with_modify_verify_request, &with_modify_verify_result);
  std::string_view with_modify_verify_json(
      with_modify_verify_result.result_json.data,
      with_modify_verify_result.result_json.size);
  std::string_view with_modify_verify_profile(
      with_modify_verify_result.profile_json.data,
      with_modify_verify_result.profile_json.size);
  std::string_view with_modify_verify_error(
      with_modify_verify_result.error_message.data,
      with_modify_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "WITH modify verification query failed: %.*s\n",
                 static_cast<int>(with_modify_verify_error.size()),
                 with_modify_verify_error.data());
    return 542;
  }
  if (with_modify_verify_json.find("urn:with-modified-graph") == std::string_view::npos ||
      with_modify_verify_json.find("urn:inserted-graph") != std::string_view::npos) {
    std::fprintf(stderr, "WITH modify verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(with_modify_verify_json.size()),
                 with_modify_verify_json.data(),
                 static_cast<int>(with_modify_verify_profile.size()),
                 with_modify_verify_profile.data());
    return 543;
  }
  xpod_qlever_adapter_release_result(adapter, &with_modify_verify_result);

  state.using_rows_enabled = true;

  xpod_qlever_query_request using_modify_request = {};
  using_modify_request.sparql = bytes(
      "DELETE { GRAPH <urn:g> { ?s <urn:using-p> ?o } } "
      "INSERT { GRAPH <urn:g> { <urn:using-modified-graph> <urn:using-p> ?o } } "
      "USING <urn:g> "
      "WHERE { ?s <urn:using-p> ?o }");
  xpod_qlever_query_result using_modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_modify_request, &using_modify_result);
  std::string_view using_modify_json(
      using_modify_result.result_json.data,
      using_modify_result.result_json.size);
  std::string_view using_modify_profile(
      using_modify_result.profile_json.data,
      using_modify_result.profile_json.size);
  std::string_view using_modify_error(
      using_modify_result.error_message.data,
      using_modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING modify update failed: %.*s\n",
                 static_cast<int>(using_modify_error.size()),
                 using_modify_error.data());
    return 722;
  }
  if (!state.deleted_using_source_row || !state.modified_using_graph_row) {
    std::fprintf(stderr, "USING modify update did not move graph row json=%.*s profile=%.*s\n",
                 static_cast<int>(using_modify_json.size()),
                 using_modify_json.data(),
                 static_cast<int>(using_modify_profile.size()),
                 using_modify_profile.data());
    return 723;
  }
  if (using_modify_json.find(R"("inserted":1)") == std::string_view::npos ||
      using_modify_json.find(R"("deleted":1)") == std::string_view::npos ||
      using_modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "USING modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_modify_json.size()),
                 using_modify_json.data(),
                 static_cast<int>(using_modify_profile.size()),
                 using_modify_profile.data());
    return 724;
  }
  xpod_qlever_adapter_release_result(adapter, &using_modify_result);

  xpod_qlever_query_request using_modify_verify_request = {};
  using_modify_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:g> WHERE { ?s <urn:using-p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result using_modify_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_modify_verify_request, &using_modify_verify_result);
  std::string_view using_modify_verify_json(
      using_modify_verify_result.result_json.data,
      using_modify_verify_result.result_json.size);
  std::string_view using_modify_verify_profile(
      using_modify_verify_result.profile_json.data,
      using_modify_verify_result.profile_json.size);
  std::string_view using_modify_verify_error(
      using_modify_verify_result.error_message.data,
      using_modify_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING modify verification query failed: %.*s\n",
                 static_cast<int>(using_modify_verify_error.size()),
                 using_modify_verify_error.data());
    return 725;
  }
  if (using_modify_verify_json.find("urn:using-modified-graph") == std::string_view::npos ||
      using_modify_verify_json.find("urn:using-source") != std::string_view::npos ||
      using_modify_verify_json.find("urn:using-noise") != std::string_view::npos) {
    std::fprintf(stderr, "USING modify verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_modify_verify_json.size()),
                 using_modify_verify_json.data(),
                 static_cast<int>(using_modify_verify_profile.size()),
                 using_modify_verify_profile.data());
    return 726;
  }
  xpod_qlever_adapter_release_result(adapter, &using_modify_verify_result);

  state.using_named_rows_enabled = true;

  xpod_qlever_query_request using_named_modify_request = {};
  using_named_modify_request.sparql = bytes(
      "DELETE { GRAPH ?g { ?s <urn:using-named-p> ?o } } "
      "INSERT { GRAPH ?g { <urn:using-named-modified> <urn:using-named-p> ?o } } "
      "USING NAMED <urn:g> "
      "USING NAMED <urn:other-g> "
      "WHERE { GRAPH ?g { ?s <urn:using-named-p> ?o } }");
  xpod_qlever_query_result using_named_modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_named_modify_request, &using_named_modify_result);
  std::string_view using_named_modify_json(
      using_named_modify_result.result_json.data,
      using_named_modify_result.result_json.size);
  std::string_view using_named_modify_profile(
      using_named_modify_result.profile_json.data,
      using_named_modify_result.profile_json.size);
  std::string_view using_named_modify_error(
      using_named_modify_result.error_message.data,
      using_named_modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING NAMED modify update failed: %.*s\n",
                 static_cast<int>(using_named_modify_error.size()),
                 using_named_modify_error.data());
    return 727;
  }
  if (!state.deleted_using_named_source_g_row ||
      !state.deleted_using_named_source_other_row ||
      !state.modified_using_named_g_row ||
      !state.modified_using_named_other_row) {
    std::fprintf(stderr, "USING NAMED modify update did not move graph rows json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_modify_json.size()),
                 using_named_modify_json.data(),
                 static_cast<int>(using_named_modify_profile.size()),
                 using_named_modify_profile.data());
    return 728;
  }
  if (using_named_modify_json.find(R"("inserted":2)") == std::string_view::npos ||
      using_named_modify_json.find(R"("deleted":2)") == std::string_view::npos ||
      using_named_modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "USING NAMED modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_modify_json.size()),
                 using_named_modify_json.data(),
                 static_cast<int>(using_named_modify_profile.size()),
                 using_named_modify_profile.data());
    return 729;
  }
  xpod_qlever_adapter_release_result(adapter, &using_named_modify_result);

  xpod_qlever_query_request using_named_g_verify_request = {};
  using_named_g_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:g> WHERE { ?s <urn:using-named-p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result using_named_g_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_named_g_verify_request, &using_named_g_verify_result);
  std::string_view using_named_g_verify_json(
      using_named_g_verify_result.result_json.data,
      using_named_g_verify_result.result_json.size);
  std::string_view using_named_g_verify_profile(
      using_named_g_verify_result.profile_json.data,
      using_named_g_verify_result.profile_json.size);
  std::string_view using_named_g_verify_error(
      using_named_g_verify_result.error_message.data,
      using_named_g_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING NAMED modify g verification query failed: %.*s\n",
                 static_cast<int>(using_named_g_verify_error.size()),
                 using_named_g_verify_error.data());
    return 730;
  }
  if (using_named_g_verify_json.find("urn:using-named-modified") == std::string_view::npos ||
      using_named_g_verify_json.find("urn:using-named-source-g") != std::string_view::npos ||
      using_named_g_verify_json.find("urn:using-named-noise") != std::string_view::npos) {
    std::fprintf(stderr, "USING NAMED modify g verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_g_verify_json.size()),
                 using_named_g_verify_json.data(),
                 static_cast<int>(using_named_g_verify_profile.size()),
                 using_named_g_verify_profile.data());
    return 731;
  }
  xpod_qlever_adapter_release_result(adapter, &using_named_g_verify_result);

  xpod_qlever_query_request using_named_other_verify_request = {};
  using_named_other_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:other-g> WHERE { ?s <urn:using-named-p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result using_named_other_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_named_other_verify_request, &using_named_other_verify_result);
  std::string_view using_named_other_verify_json(
      using_named_other_verify_result.result_json.data,
      using_named_other_verify_result.result_json.size);
  std::string_view using_named_other_verify_profile(
      using_named_other_verify_result.profile_json.data,
      using_named_other_verify_result.profile_json.size);
  std::string_view using_named_other_verify_error(
      using_named_other_verify_result.error_message.data,
      using_named_other_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING NAMED modify other graph verification query failed: %.*s\n",
                 static_cast<int>(using_named_other_verify_error.size()),
                 using_named_other_verify_error.data());
    return 732;
  }
  if (using_named_other_verify_json.find("urn:using-named-modified") == std::string_view::npos ||
      using_named_other_verify_json.find("urn:using-named-source-other") != std::string_view::npos ||
      using_named_other_verify_json.find("urn:using-named-noise") != std::string_view::npos) {
    std::fprintf(stderr, "USING NAMED modify other graph verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_other_verify_json.size()),
                 using_named_other_verify_json.data(),
                 static_cast<int>(using_named_other_verify_profile.size()),
                 using_named_other_verify_profile.data());
    return 733;
  }
  xpod_qlever_adapter_release_result(adapter, &using_named_other_verify_result);

  xpod_qlever_query_request using_named_disjoint_request = {};
  using_named_disjoint_request.sparql = bytes(
      "DELETE { GRAPH <urn:third-g> { <urn:using-named-noise> <urn:using-named-p> ?o } } "
      "INSERT { GRAPH <urn:third-g> { <urn:using-named-disallowed-modified> <urn:using-named-p> ?o } } "
      "USING NAMED <urn:g> "
      "WHERE { GRAPH <urn:third-g> { <urn:using-named-noise> <urn:using-named-p> ?o } }");
  xpod_qlever_query_result using_named_disjoint_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &using_named_disjoint_request, &using_named_disjoint_result);
  std::string_view using_named_disjoint_json(
      using_named_disjoint_result.result_json.data,
      using_named_disjoint_result.result_json.size);
  std::string_view using_named_disjoint_profile(
      using_named_disjoint_result.profile_json.data,
      using_named_disjoint_result.profile_json.size);
  std::string_view using_named_disjoint_error(
      using_named_disjoint_result.error_message.data,
      using_named_disjoint_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "USING NAMED disjoint modify failed: %.*s\n",
                 static_cast<int>(using_named_disjoint_error.size()),
                 using_named_disjoint_error.data());
    return 734;
  }
  if (using_named_disjoint_json.find(R"("inserted":0)") == std::string_view::npos ||
      using_named_disjoint_json.find(R"("deleted":0)") == std::string_view::npos ||
      using_named_disjoint_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "USING NAMED disjoint modify result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_disjoint_json.size()),
                 using_named_disjoint_json.data(),
                 static_cast<int>(using_named_disjoint_profile.size()),
                 using_named_disjoint_profile.data());
    return 735;
  }
  if (using_named_disjoint_json.find("using-named-disallowed-modified") != std::string_view::npos) {
    std::fprintf(stderr, "USING NAMED disjoint modify leaked forbidden mutation json=%.*s profile=%.*s\n",
                 static_cast<int>(using_named_disjoint_json.size()),
                 using_named_disjoint_json.data(),
                 static_cast<int>(using_named_disjoint_profile.size()),
                 using_named_disjoint_profile.data());
    return 736;
  }
  xpod_qlever_adapter_release_result(adapter, &using_named_disjoint_result);

  xpod_qlever_query_request join_modify_request = {};
  join_modify_request.sparql = bytes(
      "DELETE { <urn:s> <urn:p> ?o } "
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o . ?o <urn:p2> ?tail }");
  xpod_qlever_query_result join_modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &join_modify_request, &join_modify_result);
  std::string_view join_modify_json(
      join_modify_result.result_json.data,
      join_modify_result.result_json.size);
  std::string_view join_modify_profile(
      join_modify_result.profile_json.data,
      join_modify_result.profile_json.size);
  std::string_view join_modify_error(
      join_modify_result.error_message.data,
      join_modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "join modify update failed: %.*s\n",
                 static_cast<int>(join_modify_error.size()),
                 join_modify_error.data());
    return 744;
  }
  if (!state.deleted_base_row || !state.modified_row) {
    std::fprintf(stderr, "join modify update did not apply delete+insert json=%.*s profile=%.*s\n",
                 static_cast<int>(join_modify_json.size()),
                 join_modify_json.data(),
                 static_cast<int>(join_modify_profile.size()),
                 join_modify_profile.data());
    return 745;
  }
  if (join_modify_json.find(R"("inserted":1)") == std::string_view::npos ||
      join_modify_json.find(R"("deleted":1)") == std::string_view::npos ||
      join_modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "join modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(join_modify_json.size()),
                 join_modify_json.data(),
                 static_cast<int>(join_modify_profile.size()),
                 join_modify_profile.data());
    return 746;
  }
  xpod_qlever_adapter_release_result(adapter, &join_modify_result);

  xpod_qlever_query_request join_modify_cleanup_request = {};
  join_modify_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }; "
      "INSERT DATA { <urn:s> <urn:p> <urn:o> }");
  xpod_qlever_query_result join_modify_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &join_modify_cleanup_request, &join_modify_cleanup_result);
  std::string_view join_modify_cleanup_json(
      join_modify_cleanup_result.result_json.data,
      join_modify_cleanup_result.result_json.size);
  std::string_view join_modify_cleanup_profile(
      join_modify_cleanup_result.profile_json.data,
      join_modify_cleanup_result.profile_json.size);
  std::string_view join_modify_cleanup_error(
      join_modify_cleanup_result.error_message.data,
      join_modify_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "join modify cleanup failed: %.*s\n",
                 static_cast<int>(join_modify_cleanup_error.size()),
                 join_modify_cleanup_error.data());
    return 747;
  }
  if (state.deleted_base_row || state.modified_row ||
      join_modify_cleanup_json.find(R"("inserted":1)") == std::string_view::npos ||
      join_modify_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      join_modify_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "join modify cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(join_modify_cleanup_json.size()),
                 join_modify_cleanup_json.data(),
                 static_cast<int>(join_modify_cleanup_profile.size()),
                 join_modify_cleanup_profile.data());
    return 748;
  }
  xpod_qlever_adapter_release_result(adapter, &join_modify_cleanup_result);

  xpod_qlever_query_request minus_insert_where_request = {};
  minus_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o MINUS { ?o <urn:missing-p> ?tail } }");
  xpod_qlever_query_result minus_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &minus_insert_where_request, &minus_insert_where_result);
  std::string_view minus_insert_where_json(
      minus_insert_where_result.result_json.data,
      minus_insert_where_result.result_json.size);
  std::string_view minus_insert_where_profile(
      minus_insert_where_result.profile_json.data,
      minus_insert_where_result.profile_json.size);
  std::string_view minus_insert_where_error(
      minus_insert_where_result.error_message.data,
      minus_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "minus insert where update failed: %.*s\n",
                 static_cast<int>(minus_insert_where_error.size()),
                 minus_insert_where_error.data());
    return 760;
  }
  if (!state.modified_row ||
      minus_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      minus_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "minus insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(minus_insert_where_json.size()),
                 minus_insert_where_json.data(),
                 static_cast<int>(minus_insert_where_profile.size()),
                 minus_insert_where_profile.data());
    return 761;
  }
  xpod_qlever_adapter_release_result(adapter, &minus_insert_where_result);

  xpod_qlever_query_request minus_insert_where_verify_request = {};
  minus_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result minus_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &minus_insert_where_verify_request,
      &minus_insert_where_verify_result);
  std::string_view minus_insert_where_verify_json(
      minus_insert_where_verify_result.result_json.data,
      minus_insert_where_verify_result.result_json.size);
  std::string_view minus_insert_where_verify_error(
      minus_insert_where_verify_result.error_message.data,
      minus_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "minus insert where verification query failed: %.*s\n",
                 static_cast<int>(minus_insert_where_verify_error.size()),
                 minus_insert_where_verify_error.data());
    return 762;
  }
  if (minus_insert_where_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "minus insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(minus_insert_where_verify_json.size()),
                 minus_insert_where_verify_json.data());
    return 763;
  }
  xpod_qlever_adapter_release_result(adapter, &minus_insert_where_verify_result);

  xpod_qlever_query_request minus_insert_where_cleanup_request = {};
  minus_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result minus_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &minus_insert_where_cleanup_request,
      &minus_insert_where_cleanup_result);
  std::string_view minus_insert_where_cleanup_json(
      minus_insert_where_cleanup_result.result_json.data,
      minus_insert_where_cleanup_result.result_json.size);
  std::string_view minus_insert_where_cleanup_profile(
      minus_insert_where_cleanup_result.profile_json.data,
      minus_insert_where_cleanup_result.profile_json.size);
  std::string_view minus_insert_where_cleanup_error(
      minus_insert_where_cleanup_result.error_message.data,
      minus_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "minus insert where cleanup failed: %.*s\n",
                 static_cast<int>(minus_insert_where_cleanup_error.size()),
                 minus_insert_where_cleanup_error.data());
    return 764;
  }
  if (state.modified_row ||
      minus_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      minus_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "minus insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(minus_insert_where_cleanup_json.size()),
                 minus_insert_where_cleanup_json.data(),
                 static_cast<int>(minus_insert_where_cleanup_profile.size()),
                 minus_insert_where_cleanup_profile.data());
    return 765;
  }
  xpod_qlever_adapter_release_result(adapter, &minus_insert_where_cleanup_result);

  xpod_qlever_query_request union_insert_where_request = {};
  union_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { { <urn:s> <urn:p> ?o } UNION { <urn:missing-s> <urn:p> ?o } }");
  xpod_qlever_query_result union_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_insert_where_request, &union_insert_where_result);
  std::string_view union_insert_where_json(
      union_insert_where_result.result_json.data,
      union_insert_where_result.result_json.size);
  std::string_view union_insert_where_profile(
      union_insert_where_result.profile_json.data,
      union_insert_where_result.profile_json.size);
  std::string_view union_insert_where_error(
      union_insert_where_result.error_message.data,
      union_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union insert where update failed: %.*s\n",
                 static_cast<int>(union_insert_where_error.size()),
                 union_insert_where_error.data());
    return 766;
  }
  if (!state.modified_row ||
      union_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      union_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "union insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(union_insert_where_json.size()),
                 union_insert_where_json.data(),
                 static_cast<int>(union_insert_where_profile.size()),
                 union_insert_where_profile.data());
    return 767;
  }
  xpod_qlever_adapter_release_result(adapter, &union_insert_where_result);

  xpod_qlever_query_request union_insert_where_verify_request = {};
  union_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result union_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_insert_where_verify_request,
      &union_insert_where_verify_result);
  std::string_view union_insert_where_verify_json(
      union_insert_where_verify_result.result_json.data,
      union_insert_where_verify_result.result_json.size);
  std::string_view union_insert_where_verify_error(
      union_insert_where_verify_result.error_message.data,
      union_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union insert where verification query failed: %.*s\n",
                 static_cast<int>(union_insert_where_verify_error.size()),
                 union_insert_where_verify_error.data());
    return 768;
  }
  if (union_insert_where_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "union insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(union_insert_where_verify_json.size()),
                 union_insert_where_verify_json.data());
    return 769;
  }
  xpod_qlever_adapter_release_result(adapter, &union_insert_where_verify_result);

  xpod_qlever_query_request union_insert_where_cleanup_request = {};
  union_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result union_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_insert_where_cleanup_request,
      &union_insert_where_cleanup_result);
  std::string_view union_insert_where_cleanup_json(
      union_insert_where_cleanup_result.result_json.data,
      union_insert_where_cleanup_result.result_json.size);
  std::string_view union_insert_where_cleanup_profile(
      union_insert_where_cleanup_result.profile_json.data,
      union_insert_where_cleanup_result.profile_json.size);
  std::string_view union_insert_where_cleanup_error(
      union_insert_where_cleanup_result.error_message.data,
      union_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union insert where cleanup failed: %.*s\n",
                 static_cast<int>(union_insert_where_cleanup_error.size()),
                 union_insert_where_cleanup_error.data());
    return 770;
  }
  if (state.modified_row ||
      union_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      union_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "union insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(union_insert_where_cleanup_json.size()),
                 union_insert_where_cleanup_json.data(),
                 static_cast<int>(union_insert_where_cleanup_profile.size()),
                 union_insert_where_cleanup_profile.data());
    return 771;
  }
  xpod_qlever_adapter_release_result(adapter, &union_insert_where_cleanup_result);

  xpod_qlever_query_request union_branch_local_insert_where_request = {};
  union_branch_local_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { { <urn:s> <urn:p> ?o } UNION { <urn:o> <urn:p2> ?tail } }");
  xpod_qlever_query_result union_branch_local_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_branch_local_insert_where_request,
      &union_branch_local_insert_where_result);
  std::string_view union_branch_local_insert_where_json(
      union_branch_local_insert_where_result.result_json.data,
      union_branch_local_insert_where_result.result_json.size);
  std::string_view union_branch_local_insert_where_profile(
      union_branch_local_insert_where_result.profile_json.data,
      union_branch_local_insert_where_result.profile_json.size);
  std::string_view union_branch_local_insert_where_error(
      union_branch_local_insert_where_result.error_message.data,
      union_branch_local_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union branch-local insert where update failed: %.*s\n",
                 static_cast<int>(union_branch_local_insert_where_error.size()),
                 union_branch_local_insert_where_error.data());
    return 772;
  }
  if (!state.modified_row ||
      union_branch_local_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      union_branch_local_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "union branch-local insert where did not skip unbound template row json=%.*s profile=%.*s\n",
                 static_cast<int>(union_branch_local_insert_where_json.size()),
                 union_branch_local_insert_where_json.data(),
                 static_cast<int>(union_branch_local_insert_where_profile.size()),
                 union_branch_local_insert_where_profile.data());
    return 773;
  }
  xpod_qlever_adapter_release_result(
      adapter, &union_branch_local_insert_where_result);

  xpod_qlever_query_request union_branch_local_verify_request = {};
  union_branch_local_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result union_branch_local_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_branch_local_verify_request,
      &union_branch_local_verify_result);
  std::string_view union_branch_local_verify_json(
      union_branch_local_verify_result.result_json.data,
      union_branch_local_verify_result.result_json.size);
  std::string_view union_branch_local_verify_error(
      union_branch_local_verify_result.error_message.data,
      union_branch_local_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union branch-local insert where verification query failed: %.*s\n",
                 static_cast<int>(union_branch_local_verify_error.size()),
                 union_branch_local_verify_error.data());
    return 774;
  }
  if (union_branch_local_verify_json.find("urn:o") == std::string_view::npos ||
      union_branch_local_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "union branch-local insert where verification mismatch json=%.*s\n",
                 static_cast<int>(union_branch_local_verify_json.size()),
                 union_branch_local_verify_json.data());
    return 775;
  }
  xpod_qlever_adapter_release_result(adapter, &union_branch_local_verify_result);

  xpod_qlever_query_request union_branch_local_cleanup_request = {};
  union_branch_local_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result union_branch_local_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &union_branch_local_cleanup_request,
      &union_branch_local_cleanup_result);
  std::string_view union_branch_local_cleanup_json(
      union_branch_local_cleanup_result.result_json.data,
      union_branch_local_cleanup_result.result_json.size);
  std::string_view union_branch_local_cleanup_profile(
      union_branch_local_cleanup_result.profile_json.data,
      union_branch_local_cleanup_result.profile_json.size);
  std::string_view union_branch_local_cleanup_error(
      union_branch_local_cleanup_result.error_message.data,
      union_branch_local_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "union branch-local insert where cleanup failed: %.*s\n",
                 static_cast<int>(union_branch_local_cleanup_error.size()),
                 union_branch_local_cleanup_error.data());
    return 776;
  }
  if (state.modified_row ||
      union_branch_local_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      union_branch_local_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "union branch-local insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(union_branch_local_cleanup_json.size()),
                 union_branch_local_cleanup_json.data(),
                 static_cast<int>(union_branch_local_cleanup_profile.size()),
                 union_branch_local_cleanup_profile.data());
    return 777;
  }
  xpod_qlever_adapter_release_result(adapter, &union_branch_local_cleanup_result);

  xpod_qlever_query_request exists_insert_where_request = {};
  exists_insert_where_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o FILTER EXISTS { ?o <urn:p2> ?tail } }");
  xpod_qlever_query_result exists_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_insert_where_request, &exists_insert_where_result);
  std::string_view exists_insert_where_json(
      exists_insert_where_result.result_json.data,
      exists_insert_where_result.result_json.size);
  std::string_view exists_insert_where_profile(
      exists_insert_where_result.profile_json.data,
      exists_insert_where_result.profile_json.size);
  std::string_view exists_insert_where_error(
      exists_insert_where_result.error_message.data,
      exists_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists insert where update failed: %.*s\n",
                 static_cast<int>(exists_insert_where_error.size()),
                 exists_insert_where_error.data());
    return 778;
  }
  if (!state.modified_row ||
      exists_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      exists_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_insert_where_json.size()),
                 exists_insert_where_json.data(),
                 static_cast<int>(exists_insert_where_profile.size()),
                 exists_insert_where_profile.data());
    return 779;
  }
  xpod_qlever_adapter_release_result(adapter, &exists_insert_where_result);

  xpod_qlever_query_request exists_insert_where_verify_request = {};
  exists_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result exists_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_insert_where_verify_request,
      &exists_insert_where_verify_result);
  std::string_view exists_insert_where_verify_json(
      exists_insert_where_verify_result.result_json.data,
      exists_insert_where_verify_result.result_json.size);
  std::string_view exists_insert_where_verify_error(
      exists_insert_where_verify_result.error_message.data,
      exists_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists insert where verification query failed: %.*s\n",
                 static_cast<int>(exists_insert_where_verify_error.size()),
                 exists_insert_where_verify_error.data());
    return 780;
  }
  if (exists_insert_where_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "exists insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(exists_insert_where_verify_json.size()),
                 exists_insert_where_verify_json.data());
    return 781;
  }
  xpod_qlever_adapter_release_result(adapter, &exists_insert_where_verify_result);

  xpod_qlever_query_request exists_insert_where_cleanup_request = {};
  exists_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result exists_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_insert_where_cleanup_request,
      &exists_insert_where_cleanup_result);
  std::string_view exists_insert_where_cleanup_json(
      exists_insert_where_cleanup_result.result_json.data,
      exists_insert_where_cleanup_result.result_json.size);
  std::string_view exists_insert_where_cleanup_profile(
      exists_insert_where_cleanup_result.profile_json.data,
      exists_insert_where_cleanup_result.profile_json.size);
  std::string_view exists_insert_where_cleanup_error(
      exists_insert_where_cleanup_result.error_message.data,
      exists_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists insert where cleanup failed: %.*s\n",
                 static_cast<int>(exists_insert_where_cleanup_error.size()),
                 exists_insert_where_cleanup_error.data());
    return 782;
  }
  if (state.modified_row ||
      exists_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      exists_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_insert_where_cleanup_json.size()),
                 exists_insert_where_cleanup_json.data(),
                 static_cast<int>(exists_insert_where_cleanup_profile.size()),
                 exists_insert_where_cleanup_profile.data());
    return 783;
  }
  xpod_qlever_adapter_release_result(adapter, &exists_insert_where_cleanup_result);

  xpod_qlever_query_request not_exists_insert_where_request = {};
  not_exists_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-literal> <urn:p> ?o } "
      "WHERE { <urn:literal-s> <urn:p> ?o FILTER NOT EXISTS { ?o <urn:p2> ?tail } }");
  xpod_qlever_query_result not_exists_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_insert_where_request,
      &not_exists_insert_where_result);
  std::string_view not_exists_insert_where_json(
      not_exists_insert_where_result.result_json.data,
      not_exists_insert_where_result.result_json.size);
  std::string_view not_exists_insert_where_profile(
      not_exists_insert_where_result.profile_json.data,
      not_exists_insert_where_result.profile_json.size);
  std::string_view not_exists_insert_where_error(
      not_exists_insert_where_result.error_message.data,
      not_exists_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists insert where update failed: %.*s\n",
                 static_cast<int>(not_exists_insert_where_error.size()),
                 not_exists_insert_where_error.data());
    return 784;
  }
  if (!state.inserted_literal_row ||
      not_exists_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      not_exists_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists insert where did not insert retained rows json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_insert_where_json.size()),
                 not_exists_insert_where_json.data(),
                 static_cast<int>(not_exists_insert_where_profile.size()),
                 not_exists_insert_where_profile.data());
    return 785;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_insert_where_result);

  xpod_qlever_query_request not_exists_insert_where_verify_request = {};
  not_exists_insert_where_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result not_exists_insert_where_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_insert_where_verify_request,
      &not_exists_insert_where_verify_result);
  std::string_view not_exists_insert_where_verify_json(
      not_exists_insert_where_verify_result.result_json.data,
      not_exists_insert_where_verify_result.result_json.size);
  std::string_view not_exists_insert_where_verify_error(
      not_exists_insert_where_verify_result.error_message.data,
      not_exists_insert_where_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists insert where verification query failed: %.*s\n",
                 static_cast<int>(not_exists_insert_where_verify_error.size()),
                 not_exists_insert_where_verify_error.data());
    return 786;
  }
  if (not_exists_insert_where_verify_json.find("literal-value") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(not_exists_insert_where_verify_json.size()),
                 not_exists_insert_where_verify_json.data());
    return 787;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_insert_where_verify_result);

  xpod_qlever_query_request not_exists_insert_where_cleanup_request = {};
  not_exists_insert_where_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result not_exists_insert_where_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_insert_where_cleanup_request,
      &not_exists_insert_where_cleanup_result);
  std::string_view not_exists_insert_where_cleanup_json(
      not_exists_insert_where_cleanup_result.result_json.data,
      not_exists_insert_where_cleanup_result.result_json.size);
  std::string_view not_exists_insert_where_cleanup_profile(
      not_exists_insert_where_cleanup_result.profile_json.data,
      not_exists_insert_where_cleanup_result.profile_json.size);
  std::string_view not_exists_insert_where_cleanup_error(
      not_exists_insert_where_cleanup_result.error_message.data,
      not_exists_insert_where_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists insert where cleanup failed: %.*s\n",
                 static_cast<int>(not_exists_insert_where_cleanup_error.size()),
                 not_exists_insert_where_cleanup_error.data());
    return 788;
  }
  if (state.inserted_literal_row ||
      not_exists_insert_where_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      not_exists_insert_where_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_insert_where_cleanup_json.size()),
                 not_exists_insert_where_cleanup_json.data(),
                 static_cast<int>(not_exists_insert_where_cleanup_profile.size()),
                 not_exists_insert_where_cleanup_profile.data());
    return 789;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_insert_where_cleanup_result);

  xpod_qlever_query_request not_exists_known_empty_insert_where_request = {};
  not_exists_known_empty_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-literal> <urn:p> ?o } "
      "WHERE { <urn:literal-s> <urn:p> ?o FILTER NOT EXISTS { ?o <urn:missing-p> ?tail } }");
  xpod_qlever_query_result not_exists_known_empty_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_known_empty_insert_where_request,
      &not_exists_known_empty_insert_where_result);
  std::string_view not_exists_known_empty_insert_where_json(
      not_exists_known_empty_insert_where_result.result_json.data,
      not_exists_known_empty_insert_where_result.result_json.size);
  std::string_view not_exists_known_empty_insert_where_profile(
      not_exists_known_empty_insert_where_result.profile_json.data,
      not_exists_known_empty_insert_where_result.profile_json.size);
  std::string_view not_exists_known_empty_insert_where_error(
      not_exists_known_empty_insert_where_result.error_message.data,
      not_exists_known_empty_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists known-empty insert where update failed: %.*s\n",
                 static_cast<int>(not_exists_known_empty_insert_where_error.size()),
                 not_exists_known_empty_insert_where_error.data());
    return 790;
  }
  if (!state.inserted_literal_row ||
      not_exists_known_empty_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      not_exists_known_empty_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists known-empty insert where did not insert retained rows json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_known_empty_insert_where_json.size()),
                 not_exists_known_empty_insert_where_json.data(),
                 static_cast<int>(not_exists_known_empty_insert_where_profile.size()),
                 not_exists_known_empty_insert_where_profile.data());
    return 791;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_known_empty_insert_where_result);

  xpod_qlever_query_request not_exists_known_empty_verify_request = {};
  not_exists_known_empty_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result not_exists_known_empty_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_known_empty_verify_request,
      &not_exists_known_empty_verify_result);
  std::string_view not_exists_known_empty_verify_json(
      not_exists_known_empty_verify_result.result_json.data,
      not_exists_known_empty_verify_result.result_json.size);
  std::string_view not_exists_known_empty_verify_error(
      not_exists_known_empty_verify_result.error_message.data,
      not_exists_known_empty_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists known-empty insert where verification query failed: %.*s\n",
                 static_cast<int>(not_exists_known_empty_verify_error.size()),
                 not_exists_known_empty_verify_error.data());
    return 792;
  }
  if (not_exists_known_empty_verify_json.find("literal-value") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists known-empty insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(not_exists_known_empty_verify_json.size()),
                 not_exists_known_empty_verify_json.data());
    return 793;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_known_empty_verify_result);

  xpod_qlever_query_request not_exists_known_empty_cleanup_request = {};
  not_exists_known_empty_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result not_exists_known_empty_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_exists_known_empty_cleanup_request,
      &not_exists_known_empty_cleanup_result);
  std::string_view not_exists_known_empty_cleanup_json(
      not_exists_known_empty_cleanup_result.result_json.data,
      not_exists_known_empty_cleanup_result.result_json.size);
  std::string_view not_exists_known_empty_cleanup_profile(
      not_exists_known_empty_cleanup_result.profile_json.data,
      not_exists_known_empty_cleanup_result.profile_json.size);
  std::string_view not_exists_known_empty_cleanup_error(
      not_exists_known_empty_cleanup_result.error_message.data,
      not_exists_known_empty_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-exists known-empty insert where cleanup failed: %.*s\n",
                 static_cast<int>(not_exists_known_empty_cleanup_error.size()),
                 not_exists_known_empty_cleanup_error.data());
    return 794;
  }
  if (state.inserted_literal_row ||
      not_exists_known_empty_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      not_exists_known_empty_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-exists known-empty insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_exists_known_empty_cleanup_json.size()),
                 not_exists_known_empty_cleanup_json.data(),
                 static_cast<int>(not_exists_known_empty_cleanup_profile.size()),
                 not_exists_known_empty_cleanup_profile.data());
    return 795;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_exists_known_empty_cleanup_result);

  xpod_qlever_query_request negated_exists_insert_where_request = {};
  negated_exists_insert_where_request.sparql = bytes(
      "INSERT { <urn:inserted-literal> <urn:p> ?o } "
      "WHERE { <urn:literal-s> <urn:p> ?o FILTER(!EXISTS { ?o <urn:p2> ?tail }) }");
  xpod_qlever_query_result negated_exists_insert_where_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &negated_exists_insert_where_request,
      &negated_exists_insert_where_result);
  std::string_view negated_exists_insert_where_json(
      negated_exists_insert_where_result.result_json.data,
      negated_exists_insert_where_result.result_json.size);
  std::string_view negated_exists_insert_where_profile(
      negated_exists_insert_where_result.profile_json.data,
      negated_exists_insert_where_result.profile_json.size);
  std::string_view negated_exists_insert_where_error(
      negated_exists_insert_where_result.error_message.data,
      negated_exists_insert_where_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "negated exists insert where update failed: %.*s\n",
                 static_cast<int>(negated_exists_insert_where_error.size()),
                 negated_exists_insert_where_error.data());
    return 796;
  }
  if (!state.inserted_literal_row ||
      negated_exists_insert_where_json.find(R"("inserted":1)") == std::string_view::npos ||
      negated_exists_insert_where_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "negated exists insert where did not insert retained rows json=%.*s profile=%.*s\n",
                 static_cast<int>(negated_exists_insert_where_json.size()),
                 negated_exists_insert_where_json.data(),
                 static_cast<int>(negated_exists_insert_where_profile.size()),
                 negated_exists_insert_where_profile.data());
    return 797;
  }
  xpod_qlever_adapter_release_result(
      adapter, &negated_exists_insert_where_result);

  xpod_qlever_query_request negated_exists_verify_request = {};
  negated_exists_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:inserted-literal> <urn:p> ?o }");
  xpod_qlever_query_result negated_exists_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &negated_exists_verify_request,
      &negated_exists_verify_result);
  std::string_view negated_exists_verify_json(
      negated_exists_verify_result.result_json.data,
      negated_exists_verify_result.result_json.size);
  std::string_view negated_exists_verify_error(
      negated_exists_verify_result.error_message.data,
      negated_exists_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "negated exists insert where verification query failed: %.*s\n",
                 static_cast<int>(negated_exists_verify_error.size()),
                 negated_exists_verify_error.data());
    return 798;
  }
  if (negated_exists_verify_json.find("literal-value") == std::string_view::npos) {
    std::fprintf(stderr, "negated exists insert where verification missing retained row json=%.*s\n",
                 static_cast<int>(negated_exists_verify_json.size()),
                 negated_exists_verify_json.data());
    return 799;
  }
  xpod_qlever_adapter_release_result(
      adapter, &negated_exists_verify_result);

  xpod_qlever_query_request negated_exists_cleanup_request = {};
  negated_exists_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:inserted-literal> <urn:p> \"literal-value\" }");
  xpod_qlever_query_result negated_exists_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &negated_exists_cleanup_request,
      &negated_exists_cleanup_result);
  std::string_view negated_exists_cleanup_json(
      negated_exists_cleanup_result.result_json.data,
      negated_exists_cleanup_result.result_json.size);
  std::string_view negated_exists_cleanup_profile(
      negated_exists_cleanup_result.profile_json.data,
      negated_exists_cleanup_result.profile_json.size);
  std::string_view negated_exists_cleanup_error(
      negated_exists_cleanup_result.error_message.data,
      negated_exists_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "negated exists insert where cleanup failed: %.*s\n",
                 static_cast<int>(negated_exists_cleanup_error.size()),
                 negated_exists_cleanup_error.data());
    return 800;
  }
  if (state.inserted_literal_row ||
      negated_exists_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      negated_exists_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "negated exists insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(negated_exists_cleanup_json.size()),
                 negated_exists_cleanup_json.data(),
                 static_cast<int>(negated_exists_cleanup_profile.size()),
                 negated_exists_cleanup_profile.data());
    return 801;
  }
  xpod_qlever_adapter_release_result(
      adapter, &negated_exists_cleanup_result);

  xpod_qlever_query_request in_filter_insert_request = {};
  in_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o FILTER(?o IN (<urn:o>, <urn:tail>)) }");
  xpod_qlever_query_result in_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &in_filter_insert_request,
      &in_filter_insert_result);
  std::string_view in_filter_insert_json(
      in_filter_insert_result.result_json.data,
      in_filter_insert_result.result_json.size);
  std::string_view in_filter_insert_profile(
      in_filter_insert_result.profile_json.data,
      in_filter_insert_result.profile_json.size);
  std::string_view in_filter_insert_error(
      in_filter_insert_result.error_message.data,
      in_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "in-filter insert where failed: %.*s\n",
                 static_cast<int>(in_filter_insert_error.size()),
                 in_filter_insert_error.data());
    return 802;
  }
  if (!state.modified_row ||
      in_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      in_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "in-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_insert_json.size()),
                 in_filter_insert_json.data(),
                 static_cast<int>(in_filter_insert_profile.size()),
                 in_filter_insert_profile.data());
    return 803;
  }
  xpod_qlever_adapter_release_result(
      adapter, &in_filter_insert_result);

  xpod_qlever_query_request in_filter_verify_request = {};
  in_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result in_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &in_filter_verify_request,
      &in_filter_verify_result);
  std::string_view in_filter_verify_json(
      in_filter_verify_result.result_json.data,
      in_filter_verify_result.result_json.size);
  std::string_view in_filter_verify_profile(
      in_filter_verify_result.profile_json.data,
      in_filter_verify_result.profile_json.size);
  std::string_view in_filter_verify_error(
      in_filter_verify_result.error_message.data,
      in_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "in-filter insert where verification failed: %.*s\n",
                 static_cast<int>(in_filter_verify_error.size()),
                 in_filter_verify_error.data());
    return 804;
  }
  if (in_filter_verify_json.find("urn:o") == std::string_view::npos ||
      in_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "in-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_verify_json.size()),
                 in_filter_verify_json.data(),
                 static_cast<int>(in_filter_verify_profile.size()),
                 in_filter_verify_profile.data());
    return 805;
  }
  xpod_qlever_adapter_release_result(
      adapter, &in_filter_verify_result);

  xpod_qlever_query_request in_filter_cleanup_request = {};
  in_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result in_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &in_filter_cleanup_request,
      &in_filter_cleanup_result);
  std::string_view in_filter_cleanup_json(
      in_filter_cleanup_result.result_json.data,
      in_filter_cleanup_result.result_json.size);
  std::string_view in_filter_cleanup_profile(
      in_filter_cleanup_result.profile_json.data,
      in_filter_cleanup_result.profile_json.size);
  std::string_view in_filter_cleanup_error(
      in_filter_cleanup_result.error_message.data,
      in_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "in-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(in_filter_cleanup_error.size()),
                 in_filter_cleanup_error.data());
    return 806;
  }
  if (state.modified_row ||
      in_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      in_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "in-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(in_filter_cleanup_json.size()),
                 in_filter_cleanup_json.data(),
                 static_cast<int>(in_filter_cleanup_profile.size()),
                 in_filter_cleanup_profile.data());
    return 807;
  }
  xpod_qlever_adapter_release_result(
      adapter, &in_filter_cleanup_result);

  xpod_qlever_query_request not_in_filter_insert_request = {};
  not_in_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o FILTER(?o NOT IN (<urn:tail>)) }");
  xpod_qlever_query_result not_in_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_in_filter_insert_request,
      &not_in_filter_insert_result);
  std::string_view not_in_filter_insert_json(
      not_in_filter_insert_result.result_json.data,
      not_in_filter_insert_result.result_json.size);
  std::string_view not_in_filter_insert_profile(
      not_in_filter_insert_result.profile_json.data,
      not_in_filter_insert_result.profile_json.size);
  std::string_view not_in_filter_insert_error(
      not_in_filter_insert_result.error_message.data,
      not_in_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-in-filter insert where failed: %.*s\n",
                 static_cast<int>(not_in_filter_insert_error.size()),
                 not_in_filter_insert_error.data());
    return 808;
  }
  if (!state.modified_row ||
      not_in_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      not_in_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-in-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_insert_json.size()),
                 not_in_filter_insert_json.data(),
                 static_cast<int>(not_in_filter_insert_profile.size()),
                 not_in_filter_insert_profile.data());
    return 809;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_in_filter_insert_result);

  xpod_qlever_query_request not_in_filter_verify_request = {};
  not_in_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result not_in_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_in_filter_verify_request,
      &not_in_filter_verify_result);
  std::string_view not_in_filter_verify_json(
      not_in_filter_verify_result.result_json.data,
      not_in_filter_verify_result.result_json.size);
  std::string_view not_in_filter_verify_profile(
      not_in_filter_verify_result.profile_json.data,
      not_in_filter_verify_result.profile_json.size);
  std::string_view not_in_filter_verify_error(
      not_in_filter_verify_result.error_message.data,
      not_in_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-in-filter insert where verification failed: %.*s\n",
                 static_cast<int>(not_in_filter_verify_error.size()),
                 not_in_filter_verify_error.data());
    return 810;
  }
  if (not_in_filter_verify_json.find("urn:o") == std::string_view::npos ||
      not_in_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "not-in-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_verify_json.size()),
                 not_in_filter_verify_json.data(),
                 static_cast<int>(not_in_filter_verify_profile.size()),
                 not_in_filter_verify_profile.data());
    return 811;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_in_filter_verify_result);

  xpod_qlever_query_request not_in_filter_cleanup_request = {};
  not_in_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result not_in_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_in_filter_cleanup_request,
      &not_in_filter_cleanup_result);
  std::string_view not_in_filter_cleanup_json(
      not_in_filter_cleanup_result.result_json.data,
      not_in_filter_cleanup_result.result_json.size);
  std::string_view not_in_filter_cleanup_profile(
      not_in_filter_cleanup_result.profile_json.data,
      not_in_filter_cleanup_result.profile_json.size);
  std::string_view not_in_filter_cleanup_error(
      not_in_filter_cleanup_result.error_message.data,
      not_in_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-in-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(not_in_filter_cleanup_error.size()),
                 not_in_filter_cleanup_error.data());
    return 812;
  }
  if (state.modified_row ||
      not_in_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      not_in_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-in-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_in_filter_cleanup_json.size()),
                 not_in_filter_cleanup_json.data(),
                 static_cast<int>(not_in_filter_cleanup_profile.size()),
                 not_in_filter_cleanup_profile.data());
    return 813;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_in_filter_cleanup_result);

  xpod_qlever_query_request or_filter_insert_request = {};
  or_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o FILTER(?o = <urn:tail> || ?o = <urn:o>) }");
  xpod_qlever_query_result or_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &or_filter_insert_request,
      &or_filter_insert_result);
  std::string_view or_filter_insert_json(
      or_filter_insert_result.result_json.data,
      or_filter_insert_result.result_json.size);
  std::string_view or_filter_insert_profile(
      or_filter_insert_result.profile_json.data,
      or_filter_insert_result.profile_json.size);
  std::string_view or_filter_insert_error(
      or_filter_insert_result.error_message.data,
      or_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "or-filter insert where failed: %.*s\n",
                 static_cast<int>(or_filter_insert_error.size()),
                 or_filter_insert_error.data());
    return 828;
  }
  if (!state.modified_row ||
      or_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      or_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "or-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(or_filter_insert_json.size()),
                 or_filter_insert_json.data(),
                 static_cast<int>(or_filter_insert_profile.size()),
                 or_filter_insert_profile.data());
    return 829;
  }
  xpod_qlever_adapter_release_result(
      adapter, &or_filter_insert_result);

  xpod_qlever_query_request or_filter_verify_request = {};
  or_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result or_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &or_filter_verify_request,
      &or_filter_verify_result);
  std::string_view or_filter_verify_json(
      or_filter_verify_result.result_json.data,
      or_filter_verify_result.result_json.size);
  std::string_view or_filter_verify_profile(
      or_filter_verify_result.profile_json.data,
      or_filter_verify_result.profile_json.size);
  std::string_view or_filter_verify_error(
      or_filter_verify_result.error_message.data,
      or_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "or-filter insert where verification failed: %.*s\n",
                 static_cast<int>(or_filter_verify_error.size()),
                 or_filter_verify_error.data());
    return 830;
  }
  if (or_filter_verify_json.find("urn:o") == std::string_view::npos ||
      or_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "or-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(or_filter_verify_json.size()),
                 or_filter_verify_json.data(),
                 static_cast<int>(or_filter_verify_profile.size()),
                 or_filter_verify_profile.data());
    return 831;
  }
  xpod_qlever_adapter_release_result(
      adapter, &or_filter_verify_result);

  xpod_qlever_query_request or_filter_cleanup_request = {};
  or_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result or_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &or_filter_cleanup_request,
      &or_filter_cleanup_result);
  std::string_view or_filter_cleanup_json(
      or_filter_cleanup_result.result_json.data,
      or_filter_cleanup_result.result_json.size);
  std::string_view or_filter_cleanup_profile(
      or_filter_cleanup_result.profile_json.data,
      or_filter_cleanup_result.profile_json.size);
  std::string_view or_filter_cleanup_error(
      or_filter_cleanup_result.error_message.data,
      or_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "or-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(or_filter_cleanup_error.size()),
                 or_filter_cleanup_error.data());
    return 832;
  }
  if (state.modified_row ||
      or_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      or_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "or-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(or_filter_cleanup_json.size()),
                 or_filter_cleanup_json.data(),
                 static_cast<int>(or_filter_cleanup_profile.size()),
                 or_filter_cleanup_profile.data());
    return 833;
  }
  xpod_qlever_adapter_release_result(
      adapter, &or_filter_cleanup_result);

  xpod_qlever_query_request nested_or_filter_insert_request = {};
  nested_or_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER((?o = <urn:tail> && ?s = <urn:literal-s>) || ?o = <urn:o>) }");
  xpod_qlever_query_result nested_or_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_or_filter_insert_request,
      &nested_or_filter_insert_result);
  std::string_view nested_or_filter_insert_json(
      nested_or_filter_insert_result.result_json.data,
      nested_or_filter_insert_result.result_json.size);
  std::string_view nested_or_filter_insert_profile(
      nested_or_filter_insert_result.profile_json.data,
      nested_or_filter_insert_result.profile_json.size);
  std::string_view nested_or_filter_insert_error(
      nested_or_filter_insert_result.error_message.data,
      nested_or_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-or-filter insert where failed: %.*s\n",
                 static_cast<int>(nested_or_filter_insert_error.size()),
                 nested_or_filter_insert_error.data());
    return 834;
  }
  if (!state.modified_row ||
      nested_or_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      nested_or_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "nested-or-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_or_filter_insert_json.size()),
                 nested_or_filter_insert_json.data(),
                 static_cast<int>(nested_or_filter_insert_profile.size()),
                 nested_or_filter_insert_profile.data());
    return 835;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_or_filter_insert_result);

  xpod_qlever_query_request nested_or_filter_verify_request = {};
  nested_or_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result nested_or_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_or_filter_verify_request,
      &nested_or_filter_verify_result);
  std::string_view nested_or_filter_verify_json(
      nested_or_filter_verify_result.result_json.data,
      nested_or_filter_verify_result.result_json.size);
  std::string_view nested_or_filter_verify_profile(
      nested_or_filter_verify_result.profile_json.data,
      nested_or_filter_verify_result.profile_json.size);
  std::string_view nested_or_filter_verify_error(
      nested_or_filter_verify_result.error_message.data,
      nested_or_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-or-filter insert where verification failed: %.*s\n",
                 static_cast<int>(nested_or_filter_verify_error.size()),
                 nested_or_filter_verify_error.data());
    return 836;
  }
  if (nested_or_filter_verify_json.find("urn:o") == std::string_view::npos ||
      nested_or_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "nested-or-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_or_filter_verify_json.size()),
                 nested_or_filter_verify_json.data(),
                 static_cast<int>(nested_or_filter_verify_profile.size()),
                 nested_or_filter_verify_profile.data());
    return 837;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_or_filter_verify_result);

  xpod_qlever_query_request nested_or_filter_cleanup_request = {};
  nested_or_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result nested_or_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_or_filter_cleanup_request,
      &nested_or_filter_cleanup_result);
  std::string_view nested_or_filter_cleanup_json(
      nested_or_filter_cleanup_result.result_json.data,
      nested_or_filter_cleanup_result.result_json.size);
  std::string_view nested_or_filter_cleanup_profile(
      nested_or_filter_cleanup_result.profile_json.data,
      nested_or_filter_cleanup_result.profile_json.size);
  std::string_view nested_or_filter_cleanup_error(
      nested_or_filter_cleanup_result.error_message.data,
      nested_or_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-or-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(nested_or_filter_cleanup_error.size()),
                 nested_or_filter_cleanup_error.data());
    return 838;
  }
  if (state.modified_row ||
      nested_or_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      nested_or_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "nested-or-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_or_filter_cleanup_json.size()),
                 nested_or_filter_cleanup_json.data(),
                 static_cast<int>(nested_or_filter_cleanup_profile.size()),
                 nested_or_filter_cleanup_profile.data());
    return 839;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_or_filter_cleanup_result);

  xpod_qlever_query_request not_filter_insert_request = {};
  not_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o FILTER(!(?o = <urn:tail>)) }");
  xpod_qlever_query_result not_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_filter_insert_request,
      &not_filter_insert_result);
  std::string_view not_filter_insert_json(
      not_filter_insert_result.result_json.data,
      not_filter_insert_result.result_json.size);
  std::string_view not_filter_insert_profile(
      not_filter_insert_result.profile_json.data,
      not_filter_insert_result.profile_json.size);
  std::string_view not_filter_insert_error(
      not_filter_insert_result.error_message.data,
      not_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-filter insert where failed: %.*s\n",
                 static_cast<int>(not_filter_insert_error.size()),
                 not_filter_insert_error.data());
    return 840;
  }
  if (!state.modified_row ||
      not_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      not_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(not_filter_insert_json.size()),
                 not_filter_insert_json.data(),
                 static_cast<int>(not_filter_insert_profile.size()),
                 not_filter_insert_profile.data());
    return 841;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_filter_insert_result);

  xpod_qlever_query_request not_filter_verify_request = {};
  not_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result not_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_filter_verify_request,
      &not_filter_verify_result);
  std::string_view not_filter_verify_json(
      not_filter_verify_result.result_json.data,
      not_filter_verify_result.result_json.size);
  std::string_view not_filter_verify_profile(
      not_filter_verify_result.profile_json.data,
      not_filter_verify_result.profile_json.size);
  std::string_view not_filter_verify_error(
      not_filter_verify_result.error_message.data,
      not_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-filter insert where verification failed: %.*s\n",
                 static_cast<int>(not_filter_verify_error.size()),
                 not_filter_verify_error.data());
    return 842;
  }
  if (not_filter_verify_json.find("urn:o") == std::string_view::npos ||
      not_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "not-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_filter_verify_json.size()),
                 not_filter_verify_json.data(),
                 static_cast<int>(not_filter_verify_profile.size()),
                 not_filter_verify_profile.data());
    return 843;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_filter_verify_result);

  xpod_qlever_query_request not_filter_cleanup_request = {};
  not_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result not_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &not_filter_cleanup_request,
      &not_filter_cleanup_result);
  std::string_view not_filter_cleanup_json(
      not_filter_cleanup_result.result_json.data,
      not_filter_cleanup_result.result_json.size);
  std::string_view not_filter_cleanup_profile(
      not_filter_cleanup_result.profile_json.data,
      not_filter_cleanup_result.profile_json.size);
  std::string_view not_filter_cleanup_error(
      not_filter_cleanup_result.error_message.data,
      not_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "not-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(not_filter_cleanup_error.size()),
                 not_filter_cleanup_error.data());
    return 844;
  }
  if (state.modified_row ||
      not_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      not_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "not-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(not_filter_cleanup_json.size()),
                 not_filter_cleanup_json.data(),
                 static_cast<int>(not_filter_cleanup_profile.size()),
                 not_filter_cleanup_profile.data());
    return 845;
  }
  xpod_qlever_adapter_release_result(
      adapter, &not_filter_cleanup_result);

  xpod_qlever_query_request exists_or_filter_insert_request = {};
  exists_or_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER(?o = <urn:tail> || EXISTS { ?o <urn:p2> ?tail }) }");
  xpod_qlever_query_result exists_or_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_or_filter_insert_request,
      &exists_or_filter_insert_result);
  std::string_view exists_or_filter_insert_json(
      exists_or_filter_insert_result.result_json.data,
      exists_or_filter_insert_result.result_json.size);
  std::string_view exists_or_filter_insert_profile(
      exists_or_filter_insert_result.profile_json.data,
      exists_or_filter_insert_result.profile_json.size);
  std::string_view exists_or_filter_insert_error(
      exists_or_filter_insert_result.error_message.data,
      exists_or_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-or-filter insert where failed: %.*s\n",
                 static_cast<int>(exists_or_filter_insert_error.size()),
                 exists_or_filter_insert_error.data());
    return 846;
  }
  if (!state.modified_row ||
      exists_or_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      exists_or_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists-or-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_or_filter_insert_json.size()),
                 exists_or_filter_insert_json.data(),
                 static_cast<int>(exists_or_filter_insert_profile.size()),
                 exists_or_filter_insert_profile.data());
    return 847;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_or_filter_insert_result);

  xpod_qlever_query_request exists_or_filter_verify_request = {};
  exists_or_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result exists_or_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_or_filter_verify_request,
      &exists_or_filter_verify_result);
  std::string_view exists_or_filter_verify_json(
      exists_or_filter_verify_result.result_json.data,
      exists_or_filter_verify_result.result_json.size);
  std::string_view exists_or_filter_verify_profile(
      exists_or_filter_verify_result.profile_json.data,
      exists_or_filter_verify_result.profile_json.size);
  std::string_view exists_or_filter_verify_error(
      exists_or_filter_verify_result.error_message.data,
      exists_or_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-or-filter insert where verification failed: %.*s\n",
                 static_cast<int>(exists_or_filter_verify_error.size()),
                 exists_or_filter_verify_error.data());
    return 848;
  }
  if (exists_or_filter_verify_json.find("urn:o") == std::string_view::npos ||
      exists_or_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "exists-or-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_or_filter_verify_json.size()),
                 exists_or_filter_verify_json.data(),
                 static_cast<int>(exists_or_filter_verify_profile.size()),
                 exists_or_filter_verify_profile.data());
    return 849;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_or_filter_verify_result);

  xpod_qlever_query_request exists_or_filter_cleanup_request = {};
  exists_or_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result exists_or_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_or_filter_cleanup_request,
      &exists_or_filter_cleanup_result);
  std::string_view exists_or_filter_cleanup_json(
      exists_or_filter_cleanup_result.result_json.data,
      exists_or_filter_cleanup_result.result_json.size);
  std::string_view exists_or_filter_cleanup_profile(
      exists_or_filter_cleanup_result.profile_json.data,
      exists_or_filter_cleanup_result.profile_json.size);
  std::string_view exists_or_filter_cleanup_error(
      exists_or_filter_cleanup_result.error_message.data,
      exists_or_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-or-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(exists_or_filter_cleanup_error.size()),
                 exists_or_filter_cleanup_error.data());
    return 850;
  }
  if (state.modified_row ||
      exists_or_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      exists_or_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists-or-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_or_filter_cleanup_json.size()),
                 exists_or_filter_cleanup_json.data(),
                 static_cast<int>(exists_or_filter_cleanup_profile.size()),
                 exists_or_filter_cleanup_profile.data());
    return 851;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_or_filter_cleanup_result);

  xpod_qlever_query_request exists_and_filter_insert_request = {};
  exists_and_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER(?o = <urn:o> && EXISTS { ?o <urn:p2> ?tail }) }");
  xpod_qlever_query_result exists_and_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_and_filter_insert_request,
      &exists_and_filter_insert_result);
  std::string_view exists_and_filter_insert_json(
      exists_and_filter_insert_result.result_json.data,
      exists_and_filter_insert_result.result_json.size);
  std::string_view exists_and_filter_insert_profile(
      exists_and_filter_insert_result.profile_json.data,
      exists_and_filter_insert_result.profile_json.size);
  std::string_view exists_and_filter_insert_error(
      exists_and_filter_insert_result.error_message.data,
      exists_and_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-and-filter insert where failed: %.*s\n",
                 static_cast<int>(exists_and_filter_insert_error.size()),
                 exists_and_filter_insert_error.data());
    return 852;
  }
  if (!state.modified_row ||
      exists_and_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      exists_and_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists-and-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_and_filter_insert_json.size()),
                 exists_and_filter_insert_json.data(),
                 static_cast<int>(exists_and_filter_insert_profile.size()),
                 exists_and_filter_insert_profile.data());
    return 853;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_and_filter_insert_result);

  xpod_qlever_query_request exists_and_filter_verify_request = {};
  exists_and_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result exists_and_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_and_filter_verify_request,
      &exists_and_filter_verify_result);
  std::string_view exists_and_filter_verify_json(
      exists_and_filter_verify_result.result_json.data,
      exists_and_filter_verify_result.result_json.size);
  std::string_view exists_and_filter_verify_profile(
      exists_and_filter_verify_result.profile_json.data,
      exists_and_filter_verify_result.profile_json.size);
  std::string_view exists_and_filter_verify_error(
      exists_and_filter_verify_result.error_message.data,
      exists_and_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-and-filter insert where verification failed: %.*s\n",
                 static_cast<int>(exists_and_filter_verify_error.size()),
                 exists_and_filter_verify_error.data());
    return 854;
  }
  if (exists_and_filter_verify_json.find("urn:o") == std::string_view::npos ||
      exists_and_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "exists-and-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_and_filter_verify_json.size()),
                 exists_and_filter_verify_json.data(),
                 static_cast<int>(exists_and_filter_verify_profile.size()),
                 exists_and_filter_verify_profile.data());
    return 855;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_and_filter_verify_result);

  xpod_qlever_query_request exists_and_filter_cleanup_request = {};
  exists_and_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result exists_and_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &exists_and_filter_cleanup_request,
      &exists_and_filter_cleanup_result);
  std::string_view exists_and_filter_cleanup_json(
      exists_and_filter_cleanup_result.result_json.data,
      exists_and_filter_cleanup_result.result_json.size);
  std::string_view exists_and_filter_cleanup_profile(
      exists_and_filter_cleanup_result.profile_json.data,
      exists_and_filter_cleanup_result.profile_json.size);
  std::string_view exists_and_filter_cleanup_error(
      exists_and_filter_cleanup_result.error_message.data,
      exists_and_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "exists-and-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(exists_and_filter_cleanup_error.size()),
                 exists_and_filter_cleanup_error.data());
    return 856;
  }
  if (state.modified_row ||
      exists_and_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      exists_and_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "exists-and-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(exists_and_filter_cleanup_json.size()),
                 exists_and_filter_cleanup_json.data(),
                 static_cast<int>(exists_and_filter_cleanup_profile.size()),
                 exists_and_filter_cleanup_profile.data());
    return 857;
  }
  xpod_qlever_adapter_release_result(
      adapter, &exists_and_filter_cleanup_result);

  xpod_qlever_query_request nested_exists_filter_insert_request = {};
  nested_exists_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER(((?o = <urn:o>) && EXISTS { ?o <urn:p2> ?tail }) || "
      "(?o = <urn:missing>)) }");
  xpod_qlever_query_result nested_exists_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_exists_filter_insert_request,
      &nested_exists_filter_insert_result);
  std::string_view nested_exists_filter_insert_json(
      nested_exists_filter_insert_result.result_json.data,
      nested_exists_filter_insert_result.result_json.size);
  std::string_view nested_exists_filter_insert_profile(
      nested_exists_filter_insert_result.profile_json.data,
      nested_exists_filter_insert_result.profile_json.size);
  std::string_view nested_exists_filter_insert_error(
      nested_exists_filter_insert_result.error_message.data,
      nested_exists_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-exists-filter insert where failed: %.*s\n",
                 static_cast<int>(nested_exists_filter_insert_error.size()),
                 nested_exists_filter_insert_error.data());
    return 858;
  }
  if (!state.modified_row ||
      nested_exists_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      nested_exists_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "nested-exists-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_exists_filter_insert_json.size()),
                 nested_exists_filter_insert_json.data(),
                 static_cast<int>(nested_exists_filter_insert_profile.size()),
                 nested_exists_filter_insert_profile.data());
    return 859;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_exists_filter_insert_result);

  xpod_qlever_query_request nested_exists_filter_verify_request = {};
  nested_exists_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result nested_exists_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_exists_filter_verify_request,
      &nested_exists_filter_verify_result);
  std::string_view nested_exists_filter_verify_json(
      nested_exists_filter_verify_result.result_json.data,
      nested_exists_filter_verify_result.result_json.size);
  std::string_view nested_exists_filter_verify_profile(
      nested_exists_filter_verify_result.profile_json.data,
      nested_exists_filter_verify_result.profile_json.size);
  std::string_view nested_exists_filter_verify_error(
      nested_exists_filter_verify_result.error_message.data,
      nested_exists_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-exists-filter insert where verification failed: %.*s\n",
                 static_cast<int>(nested_exists_filter_verify_error.size()),
                 nested_exists_filter_verify_error.data());
    return 860;
  }
  if (nested_exists_filter_verify_json.find("urn:o") == std::string_view::npos ||
      nested_exists_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "nested-exists-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_exists_filter_verify_json.size()),
                 nested_exists_filter_verify_json.data(),
                 static_cast<int>(nested_exists_filter_verify_profile.size()),
                 nested_exists_filter_verify_profile.data());
    return 861;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_exists_filter_verify_result);

  xpod_qlever_query_request nested_exists_filter_cleanup_request = {};
  nested_exists_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result nested_exists_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_exists_filter_cleanup_request,
      &nested_exists_filter_cleanup_result);
  std::string_view nested_exists_filter_cleanup_json(
      nested_exists_filter_cleanup_result.result_json.data,
      nested_exists_filter_cleanup_result.result_json.size);
  std::string_view nested_exists_filter_cleanup_profile(
      nested_exists_filter_cleanup_result.profile_json.data,
      nested_exists_filter_cleanup_result.profile_json.size);
  std::string_view nested_exists_filter_cleanup_error(
      nested_exists_filter_cleanup_result.error_message.data,
      nested_exists_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "nested-exists-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(nested_exists_filter_cleanup_error.size()),
                 nested_exists_filter_cleanup_error.data());
    return 862;
  }
  if (state.modified_row ||
      nested_exists_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      nested_exists_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "nested-exists-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(nested_exists_filter_cleanup_json.size()),
                 nested_exists_filter_cleanup_json.data(),
                 static_cast<int>(nested_exists_filter_cleanup_profile.size()),
                 nested_exists_filter_cleanup_profile.data());
    return 863;
  }
  xpod_qlever_adapter_release_result(
      adapter, &nested_exists_filter_cleanup_result);

  xpod_qlever_query_request two_exists_filter_insert_request = {};
  two_exists_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER(EXISTS { ?o <urn:p2> ?tail } || "
      "EXISTS { ?o <urn:missing-p> ?tail2 }) }");
  xpod_qlever_query_result two_exists_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &two_exists_filter_insert_request,
      &two_exists_filter_insert_result);
  std::string_view two_exists_filter_insert_json(
      two_exists_filter_insert_result.result_json.data,
      two_exists_filter_insert_result.result_json.size);
  std::string_view two_exists_filter_insert_profile(
      two_exists_filter_insert_result.profile_json.data,
      two_exists_filter_insert_result.profile_json.size);
  std::string_view two_exists_filter_insert_error(
      two_exists_filter_insert_result.error_message.data,
      two_exists_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "two-exists-filter insert where failed: %.*s\n",
                 static_cast<int>(two_exists_filter_insert_error.size()),
                 two_exists_filter_insert_error.data());
    return 864;
  }
  if (!state.modified_row ||
      two_exists_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      two_exists_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "two-exists-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(two_exists_filter_insert_json.size()),
                 two_exists_filter_insert_json.data(),
                 static_cast<int>(two_exists_filter_insert_profile.size()),
                 two_exists_filter_insert_profile.data());
    return 865;
  }
  xpod_qlever_adapter_release_result(
      adapter, &two_exists_filter_insert_result);

  xpod_qlever_query_request two_exists_filter_verify_request = {};
  two_exists_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result two_exists_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &two_exists_filter_verify_request,
      &two_exists_filter_verify_result);
  std::string_view two_exists_filter_verify_json(
      two_exists_filter_verify_result.result_json.data,
      two_exists_filter_verify_result.result_json.size);
  std::string_view two_exists_filter_verify_profile(
      two_exists_filter_verify_result.profile_json.data,
      two_exists_filter_verify_result.profile_json.size);
  std::string_view two_exists_filter_verify_error(
      two_exists_filter_verify_result.error_message.data,
      two_exists_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "two-exists-filter insert where verification failed: %.*s\n",
                 static_cast<int>(two_exists_filter_verify_error.size()),
                 two_exists_filter_verify_error.data());
    return 866;
  }
  if (two_exists_filter_verify_json.find("urn:o") == std::string_view::npos ||
      two_exists_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "two-exists-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(two_exists_filter_verify_json.size()),
                 two_exists_filter_verify_json.data(),
                 static_cast<int>(two_exists_filter_verify_profile.size()),
                 two_exists_filter_verify_profile.data());
    return 867;
  }
  xpod_qlever_adapter_release_result(
      adapter, &two_exists_filter_verify_result);

  xpod_qlever_query_request two_exists_filter_cleanup_request = {};
  two_exists_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result two_exists_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &two_exists_filter_cleanup_request,
      &two_exists_filter_cleanup_result);
  std::string_view two_exists_filter_cleanup_json(
      two_exists_filter_cleanup_result.result_json.data,
      two_exists_filter_cleanup_result.result_json.size);
  std::string_view two_exists_filter_cleanup_profile(
      two_exists_filter_cleanup_result.profile_json.data,
      two_exists_filter_cleanup_result.profile_json.size);
  std::string_view two_exists_filter_cleanup_error(
      two_exists_filter_cleanup_result.error_message.data,
      two_exists_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "two-exists-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(two_exists_filter_cleanup_error.size()),
                 two_exists_filter_cleanup_error.data());
    return 868;
  }
  if (state.modified_row ||
      two_exists_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      two_exists_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "two-exists-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(two_exists_filter_cleanup_json.size()),
                 two_exists_filter_cleanup_json.data(),
                 static_cast<int>(two_exists_filter_cleanup_profile.size()),
                 two_exists_filter_cleanup_profile.data());
    return 869;
  }
  xpod_qlever_adapter_release_result(
      adapter, &two_exists_filter_cleanup_result);

  xpod_qlever_query_request unbound_or_filter_insert_request = {};
  unbound_or_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { <urn:s> <urn:p> ?o "
      "FILTER(((?o = <urn:o>) && EXISTS { ?o <urn:p2> ?tail }) || "
      "(?s = <urn:missing>)) }");
  xpod_qlever_query_result unbound_or_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &unbound_or_filter_insert_request,
      &unbound_or_filter_insert_result);
  std::string_view unbound_or_filter_insert_json(
      unbound_or_filter_insert_result.result_json.data,
      unbound_or_filter_insert_result.result_json.size);
  std::string_view unbound_or_filter_insert_profile(
      unbound_or_filter_insert_result.profile_json.data,
      unbound_or_filter_insert_result.profile_json.size);
  std::string_view unbound_or_filter_insert_error(
      unbound_or_filter_insert_result.error_message.data,
      unbound_or_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "unbound-or-filter insert where failed: %.*s\n",
                 static_cast<int>(unbound_or_filter_insert_error.size()),
                 unbound_or_filter_insert_error.data());
    return 870;
  }
  if (!state.modified_row ||
      unbound_or_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      unbound_or_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "unbound-or-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(unbound_or_filter_insert_json.size()),
                 unbound_or_filter_insert_json.data(),
                 static_cast<int>(unbound_or_filter_insert_profile.size()),
                 unbound_or_filter_insert_profile.data());
    return 871;
  }
  xpod_qlever_adapter_release_result(
      adapter, &unbound_or_filter_insert_result);

  xpod_qlever_query_request unbound_or_filter_verify_request = {};
  unbound_or_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result unbound_or_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &unbound_or_filter_verify_request,
      &unbound_or_filter_verify_result);
  std::string_view unbound_or_filter_verify_json(
      unbound_or_filter_verify_result.result_json.data,
      unbound_or_filter_verify_result.result_json.size);
  std::string_view unbound_or_filter_verify_profile(
      unbound_or_filter_verify_result.profile_json.data,
      unbound_or_filter_verify_result.profile_json.size);
  std::string_view unbound_or_filter_verify_error(
      unbound_or_filter_verify_result.error_message.data,
      unbound_or_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "unbound-or-filter insert where verification failed: %.*s\n",
                 static_cast<int>(unbound_or_filter_verify_error.size()),
                 unbound_or_filter_verify_error.data());
    return 872;
  }
  if (unbound_or_filter_verify_json.find("urn:o") == std::string_view::npos ||
      unbound_or_filter_verify_json.find("urn:tail") != std::string_view::npos) {
    std::fprintf(stderr, "unbound-or-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(unbound_or_filter_verify_json.size()),
                 unbound_or_filter_verify_json.data(),
                 static_cast<int>(unbound_or_filter_verify_profile.size()),
                 unbound_or_filter_verify_profile.data());
    return 873;
  }
  xpod_qlever_adapter_release_result(
      adapter, &unbound_or_filter_verify_result);

  xpod_qlever_query_request unbound_or_filter_cleanup_request = {};
  unbound_or_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result unbound_or_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &unbound_or_filter_cleanup_request,
      &unbound_or_filter_cleanup_result);
  std::string_view unbound_or_filter_cleanup_json(
      unbound_or_filter_cleanup_result.result_json.data,
      unbound_or_filter_cleanup_result.result_json.size);
  std::string_view unbound_or_filter_cleanup_profile(
      unbound_or_filter_cleanup_result.profile_json.data,
      unbound_or_filter_cleanup_result.profile_json.size);
  std::string_view unbound_or_filter_cleanup_error(
      unbound_or_filter_cleanup_result.error_message.data,
      unbound_or_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "unbound-or-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(unbound_or_filter_cleanup_error.size()),
                 unbound_or_filter_cleanup_error.data());
    return 874;
  }
  if (state.modified_row ||
      unbound_or_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      unbound_or_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "unbound-or-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(unbound_or_filter_cleanup_json.size()),
                 unbound_or_filter_cleanup_json.data(),
                 static_cast<int>(unbound_or_filter_cleanup_profile.size()),
                 unbound_or_filter_cleanup_profile.data());
    return 875;
  }
  xpod_qlever_adapter_release_result(
      adapter, &unbound_or_filter_cleanup_result);

  xpod_qlever_query_request strstarts_update_filter_insert_request = {};
  strstarts_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { ?s <urn:p> ?o FILTER(STRSTARTS(STR(?s), \"urn:s\")) }");
  xpod_qlever_query_result strstarts_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strstarts_update_filter_insert_request,
      &strstarts_update_filter_insert_result);
  std::string_view strstarts_update_filter_insert_json(
      strstarts_update_filter_insert_result.result_json.data,
      strstarts_update_filter_insert_result.result_json.size);
  std::string_view strstarts_update_filter_insert_profile(
      strstarts_update_filter_insert_result.profile_json.data,
      strstarts_update_filter_insert_result.profile_json.size);
  std::string_view strstarts_update_filter_insert_error(
      strstarts_update_filter_insert_result.error_message.data,
      strstarts_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where failed: %.*s\n",
                 static_cast<int>(strstarts_update_filter_insert_error.size()),
                 strstarts_update_filter_insert_error.data());
    return 876;
  }
  if (!state.modified_row ||
      strstarts_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      strstarts_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_update_filter_insert_json.size()),
                 strstarts_update_filter_insert_json.data(),
                 static_cast<int>(strstarts_update_filter_insert_profile.size()),
                 strstarts_update_filter_insert_profile.data());
    return 877;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strstarts_update_filter_insert_result);

  xpod_qlever_query_request strstarts_update_filter_verify_request = {};
  strstarts_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result strstarts_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strstarts_update_filter_verify_request,
      &strstarts_update_filter_verify_result);
  std::string_view strstarts_update_filter_verify_json(
      strstarts_update_filter_verify_result.result_json.data,
      strstarts_update_filter_verify_result.result_json.size);
  std::string_view strstarts_update_filter_verify_profile(
      strstarts_update_filter_verify_result.profile_json.data,
      strstarts_update_filter_verify_result.profile_json.size);
  std::string_view strstarts_update_filter_verify_error(
      strstarts_update_filter_verify_result.error_message.data,
      strstarts_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(strstarts_update_filter_verify_error.size()),
                 strstarts_update_filter_verify_error.data());
    return 878;
  }
  if (strstarts_update_filter_verify_json.find("urn:o") == std::string_view::npos ||
      strstarts_update_filter_verify_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_update_filter_verify_json.size()),
                 strstarts_update_filter_verify_json.data(),
                 static_cast<int>(strstarts_update_filter_verify_profile.size()),
                 strstarts_update_filter_verify_profile.data());
    return 879;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strstarts_update_filter_verify_result);

  xpod_qlever_query_request strstarts_update_filter_cleanup_request = {};
  strstarts_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result strstarts_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strstarts_update_filter_cleanup_request,
      &strstarts_update_filter_cleanup_result);
  std::string_view strstarts_update_filter_cleanup_json(
      strstarts_update_filter_cleanup_result.result_json.data,
      strstarts_update_filter_cleanup_result.result_json.size);
  std::string_view strstarts_update_filter_cleanup_profile(
      strstarts_update_filter_cleanup_result.profile_json.data,
      strstarts_update_filter_cleanup_result.profile_json.size);
  std::string_view strstarts_update_filter_cleanup_error(
      strstarts_update_filter_cleanup_result.error_message.data,
      strstarts_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(strstarts_update_filter_cleanup_error.size()),
                 strstarts_update_filter_cleanup_error.data());
    return 880;
  }
  if (state.modified_row ||
      strstarts_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      strstarts_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "STRSTARTS update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strstarts_update_filter_cleanup_json.size()),
                 strstarts_update_filter_cleanup_json.data(),
                 static_cast<int>(strstarts_update_filter_cleanup_profile.size()),
                 strstarts_update_filter_cleanup_profile.data());
    return 881;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strstarts_update_filter_cleanup_result);

  xpod_qlever_query_request contains_update_filter_insert_request = {};
  contains_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:tail> } "
      "WHERE { ?s <urn:p> ?o FILTER(CONTAINS(STR(?s), \"literal\")) }");
  xpod_qlever_query_result contains_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &contains_update_filter_insert_request,
      &contains_update_filter_insert_result);
  std::string_view contains_update_filter_insert_json(
      contains_update_filter_insert_result.result_json.data,
      contains_update_filter_insert_result.result_json.size);
  std::string_view contains_update_filter_insert_profile(
      contains_update_filter_insert_result.profile_json.data,
      contains_update_filter_insert_result.profile_json.size);
  std::string_view contains_update_filter_insert_error(
      contains_update_filter_insert_result.error_message.data,
      contains_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "CONTAINS update-filter insert where failed: %.*s\n",
                 static_cast<int>(contains_update_filter_insert_error.size()),
                 contains_update_filter_insert_error.data());
    return 882;
  }
  if (!state.inserted_optional_tail_row ||
      contains_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      contains_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_update_filter_insert_json.size()),
                 contains_update_filter_insert_json.data(),
                 static_cast<int>(contains_update_filter_insert_profile.size()),
                 contains_update_filter_insert_profile.data());
    return 883;
  }
  xpod_qlever_adapter_release_result(
      adapter, &contains_update_filter_insert_result);

  xpod_qlever_query_request contains_update_filter_verify_request = {};
  contains_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result contains_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &contains_update_filter_verify_request,
      &contains_update_filter_verify_result);
  std::string_view contains_update_filter_verify_json(
      contains_update_filter_verify_result.result_json.data,
      contains_update_filter_verify_result.result_json.size);
  std::string_view contains_update_filter_verify_profile(
      contains_update_filter_verify_result.profile_json.data,
      contains_update_filter_verify_result.profile_json.size);
  std::string_view contains_update_filter_verify_error(
      contains_update_filter_verify_result.error_message.data,
      contains_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "CONTAINS update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(contains_update_filter_verify_error.size()),
                 contains_update_filter_verify_error.data());
    return 884;
  }
  if (contains_update_filter_verify_json.find("urn:tail") == std::string_view::npos ||
      contains_update_filter_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_update_filter_verify_json.size()),
                 contains_update_filter_verify_json.data(),
                 static_cast<int>(contains_update_filter_verify_profile.size()),
                 contains_update_filter_verify_profile.data());
    return 885;
  }
  xpod_qlever_adapter_release_result(
      adapter, &contains_update_filter_verify_result);

  xpod_qlever_query_request contains_update_filter_cleanup_request = {};
  contains_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:tail> }");
  xpod_qlever_query_result contains_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &contains_update_filter_cleanup_request,
      &contains_update_filter_cleanup_result);
  std::string_view contains_update_filter_cleanup_json(
      contains_update_filter_cleanup_result.result_json.data,
      contains_update_filter_cleanup_result.result_json.size);
  std::string_view contains_update_filter_cleanup_profile(
      contains_update_filter_cleanup_result.profile_json.data,
      contains_update_filter_cleanup_result.profile_json.size);
  std::string_view contains_update_filter_cleanup_error(
      contains_update_filter_cleanup_result.error_message.data,
      contains_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "CONTAINS update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(contains_update_filter_cleanup_error.size()),
                 contains_update_filter_cleanup_error.data());
    return 886;
  }
  if (state.inserted_optional_tail_row ||
      contains_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      contains_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "CONTAINS update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(contains_update_filter_cleanup_json.size()),
                 contains_update_filter_cleanup_json.data(),
                 static_cast<int>(contains_update_filter_cleanup_profile.size()),
                 contains_update_filter_cleanup_profile.data());
    return 887;
  }
  xpod_qlever_adapter_release_result(
      adapter, &contains_update_filter_cleanup_result);

  xpod_qlever_query_request strends_update_filter_insert_request = {};
  strends_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:tail> } "
      "WHERE { ?s <urn:p> ?o FILTER(STRENDS(STR(?s), \"literal-s\")) }");
  xpod_qlever_query_result strends_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strends_update_filter_insert_request,
      &strends_update_filter_insert_result);
  std::string_view strends_update_filter_insert_json(
      strends_update_filter_insert_result.result_json.data,
      strends_update_filter_insert_result.result_json.size);
  std::string_view strends_update_filter_insert_profile(
      strends_update_filter_insert_result.profile_json.data,
      strends_update_filter_insert_result.profile_json.size);
  std::string_view strends_update_filter_insert_error(
      strends_update_filter_insert_result.error_message.data,
      strends_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRENDS update-filter insert where failed: %.*s\n",
                 static_cast<int>(strends_update_filter_insert_error.size()),
                 strends_update_filter_insert_error.data());
    return 888;
  }
  if (!state.inserted_optional_tail_row ||
      strends_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      strends_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "STRENDS update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_update_filter_insert_json.size()),
                 strends_update_filter_insert_json.data(),
                 static_cast<int>(strends_update_filter_insert_profile.size()),
                 strends_update_filter_insert_profile.data());
    return 889;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strends_update_filter_insert_result);

  xpod_qlever_query_request strends_update_filter_verify_request = {};
  strends_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result strends_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strends_update_filter_verify_request,
      &strends_update_filter_verify_result);
  std::string_view strends_update_filter_verify_json(
      strends_update_filter_verify_result.result_json.data,
      strends_update_filter_verify_result.result_json.size);
  std::string_view strends_update_filter_verify_profile(
      strends_update_filter_verify_result.profile_json.data,
      strends_update_filter_verify_result.profile_json.size);
  std::string_view strends_update_filter_verify_error(
      strends_update_filter_verify_result.error_message.data,
      strends_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRENDS update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(strends_update_filter_verify_error.size()),
                 strends_update_filter_verify_error.data());
    return 890;
  }
  if (strends_update_filter_verify_json.find("urn:tail") == std::string_view::npos ||
      strends_update_filter_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "STRENDS update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_update_filter_verify_json.size()),
                 strends_update_filter_verify_json.data(),
                 static_cast<int>(strends_update_filter_verify_profile.size()),
                 strends_update_filter_verify_profile.data());
    return 891;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strends_update_filter_verify_result);

  xpod_qlever_query_request strends_update_filter_cleanup_request = {};
  strends_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:tail> }");
  xpod_qlever_query_result strends_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &strends_update_filter_cleanup_request,
      &strends_update_filter_cleanup_result);
  std::string_view strends_update_filter_cleanup_json(
      strends_update_filter_cleanup_result.result_json.data,
      strends_update_filter_cleanup_result.result_json.size);
  std::string_view strends_update_filter_cleanup_profile(
      strends_update_filter_cleanup_result.profile_json.data,
      strends_update_filter_cleanup_result.profile_json.size);
  std::string_view strends_update_filter_cleanup_error(
      strends_update_filter_cleanup_result.error_message.data,
      strends_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "STRENDS update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(strends_update_filter_cleanup_error.size()),
                 strends_update_filter_cleanup_error.data());
    return 892;
  }
  if (state.inserted_optional_tail_row ||
      strends_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      strends_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "STRENDS update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(strends_update_filter_cleanup_json.size()),
                 strends_update_filter_cleanup_json.data(),
                 static_cast<int>(strends_update_filter_cleanup_profile.size()),
                 strends_update_filter_cleanup_profile.data());
    return 893;
  }
  xpod_qlever_adapter_release_result(
      adapter, &strends_update_filter_cleanup_result);

  xpod_qlever_query_request lcase_update_filter_insert_request = {};
  lcase_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { ?s <urn:p> ?o FILTER(LCASE(STR(?s)) = \"urn:s\") }");
  xpod_qlever_query_result lcase_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_update_filter_insert_request,
      &lcase_update_filter_insert_result);
  std::string_view lcase_update_filter_insert_json(
      lcase_update_filter_insert_result.result_json.data,
      lcase_update_filter_insert_result.result_json.size);
  std::string_view lcase_update_filter_insert_profile(
      lcase_update_filter_insert_result.profile_json.data,
      lcase_update_filter_insert_result.profile_json.size);
  std::string_view lcase_update_filter_insert_error(
      lcase_update_filter_insert_result.error_message.data,
      lcase_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE update-filter insert where failed: %.*s\n",
                 static_cast<int>(lcase_update_filter_insert_error.size()),
                 lcase_update_filter_insert_error.data());
    return 894;
  }
  if (!state.modified_row ||
      lcase_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      lcase_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_update_filter_insert_json.size()),
                 lcase_update_filter_insert_json.data(),
                 static_cast<int>(lcase_update_filter_insert_profile.size()),
                 lcase_update_filter_insert_profile.data());
    return 895;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_update_filter_insert_result);

  xpod_qlever_query_request lcase_update_filter_verify_request = {};
  lcase_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result lcase_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_update_filter_verify_request,
      &lcase_update_filter_verify_result);
  std::string_view lcase_update_filter_verify_json(
      lcase_update_filter_verify_result.result_json.data,
      lcase_update_filter_verify_result.result_json.size);
  std::string_view lcase_update_filter_verify_profile(
      lcase_update_filter_verify_result.profile_json.data,
      lcase_update_filter_verify_result.profile_json.size);
  std::string_view lcase_update_filter_verify_error(
      lcase_update_filter_verify_result.error_message.data,
      lcase_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(lcase_update_filter_verify_error.size()),
                 lcase_update_filter_verify_error.data());
    return 896;
  }
  if (lcase_update_filter_verify_json.find("urn:o") == std::string_view::npos ||
      lcase_update_filter_verify_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "LCASE update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_update_filter_verify_json.size()),
                 lcase_update_filter_verify_json.data(),
                 static_cast<int>(lcase_update_filter_verify_profile.size()),
                 lcase_update_filter_verify_profile.data());
    return 897;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_update_filter_verify_result);

  xpod_qlever_query_request lcase_update_filter_cleanup_request = {};
  lcase_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result lcase_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_update_filter_cleanup_request,
      &lcase_update_filter_cleanup_result);
  std::string_view lcase_update_filter_cleanup_json(
      lcase_update_filter_cleanup_result.result_json.data,
      lcase_update_filter_cleanup_result.result_json.size);
  std::string_view lcase_update_filter_cleanup_profile(
      lcase_update_filter_cleanup_result.profile_json.data,
      lcase_update_filter_cleanup_result.profile_json.size);
  std::string_view lcase_update_filter_cleanup_error(
      lcase_update_filter_cleanup_result.error_message.data,
      lcase_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(lcase_update_filter_cleanup_error.size()),
                 lcase_update_filter_cleanup_error.data());
    return 898;
  }
  if (state.modified_row ||
      lcase_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      lcase_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_update_filter_cleanup_json.size()),
                 lcase_update_filter_cleanup_json.data(),
                 static_cast<int>(lcase_update_filter_cleanup_profile.size()),
                 lcase_update_filter_cleanup_profile.data());
    return 899;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_update_filter_cleanup_result);

  xpod_qlever_query_request ucase_update_filter_insert_request = {};
  ucase_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { ?s <urn:p> ?o FILTER(UCASE(STR(?s)) = \"URN:S\") }");
  xpod_qlever_query_result ucase_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &ucase_update_filter_insert_request,
      &ucase_update_filter_insert_result);
  std::string_view ucase_update_filter_insert_json(
      ucase_update_filter_insert_result.result_json.data,
      ucase_update_filter_insert_result.result_json.size);
  std::string_view ucase_update_filter_insert_profile(
      ucase_update_filter_insert_result.profile_json.data,
      ucase_update_filter_insert_result.profile_json.size);
  std::string_view ucase_update_filter_insert_error(
      ucase_update_filter_insert_result.error_message.data,
      ucase_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "UCASE update-filter insert where failed: %.*s\n",
                 static_cast<int>(ucase_update_filter_insert_error.size()),
                 ucase_update_filter_insert_error.data());
    return 900;
  }
  if (!state.modified_row ||
      ucase_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      ucase_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "UCASE update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_update_filter_insert_json.size()),
                 ucase_update_filter_insert_json.data(),
                 static_cast<int>(ucase_update_filter_insert_profile.size()),
                 ucase_update_filter_insert_profile.data());
    return 901;
  }
  xpod_qlever_adapter_release_result(
      adapter, &ucase_update_filter_insert_result);

  xpod_qlever_query_request ucase_update_filter_verify_request = {};
  ucase_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result ucase_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &ucase_update_filter_verify_request,
      &ucase_update_filter_verify_result);
  std::string_view ucase_update_filter_verify_json(
      ucase_update_filter_verify_result.result_json.data,
      ucase_update_filter_verify_result.result_json.size);
  std::string_view ucase_update_filter_verify_profile(
      ucase_update_filter_verify_result.profile_json.data,
      ucase_update_filter_verify_result.profile_json.size);
  std::string_view ucase_update_filter_verify_error(
      ucase_update_filter_verify_result.error_message.data,
      ucase_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "UCASE update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(ucase_update_filter_verify_error.size()),
                 ucase_update_filter_verify_error.data());
    return 902;
  }
  if (ucase_update_filter_verify_json.find("urn:o") == std::string_view::npos ||
      ucase_update_filter_verify_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "UCASE update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_update_filter_verify_json.size()),
                 ucase_update_filter_verify_json.data(),
                 static_cast<int>(ucase_update_filter_verify_profile.size()),
                 ucase_update_filter_verify_profile.data());
    return 903;
  }
  xpod_qlever_adapter_release_result(
      adapter, &ucase_update_filter_verify_result);

  xpod_qlever_query_request ucase_update_filter_cleanup_request = {};
  ucase_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result ucase_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &ucase_update_filter_cleanup_request,
      &ucase_update_filter_cleanup_result);
  std::string_view ucase_update_filter_cleanup_json(
      ucase_update_filter_cleanup_result.result_json.data,
      ucase_update_filter_cleanup_result.result_json.size);
  std::string_view ucase_update_filter_cleanup_profile(
      ucase_update_filter_cleanup_result.profile_json.data,
      ucase_update_filter_cleanup_result.profile_json.size);
  std::string_view ucase_update_filter_cleanup_error(
      ucase_update_filter_cleanup_result.error_message.data,
      ucase_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "UCASE update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(ucase_update_filter_cleanup_error.size()),
                 ucase_update_filter_cleanup_error.data());
    return 904;
  }
  if (state.modified_row ||
      ucase_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      ucase_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "UCASE update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(ucase_update_filter_cleanup_json.size()),
                 ucase_update_filter_cleanup_json.data(),
                 static_cast<int>(ucase_update_filter_cleanup_profile.size()),
                 ucase_update_filter_cleanup_profile.data());
    return 905;
  }
  xpod_qlever_adapter_release_result(
      adapter, &ucase_update_filter_cleanup_result);

  xpod_qlever_query_request regex_update_filter_insert_request = {};
  regex_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:tail> } "
      "WHERE { ?s <urn:p> ?o FILTER(REGEX(STR(?s), \"^urn:literal\")) }");
  xpod_qlever_query_result regex_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &regex_update_filter_insert_request,
      &regex_update_filter_insert_result);
  std::string_view regex_update_filter_insert_json(
      regex_update_filter_insert_result.result_json.data,
      regex_update_filter_insert_result.result_json.size);
  std::string_view regex_update_filter_insert_profile(
      regex_update_filter_insert_result.profile_json.data,
      regex_update_filter_insert_result.profile_json.size);
  std::string_view regex_update_filter_insert_error(
      regex_update_filter_insert_result.error_message.data,
      regex_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "REGEX update-filter insert where failed: %.*s\n",
                 static_cast<int>(regex_update_filter_insert_error.size()),
                 regex_update_filter_insert_error.data());
    return 906;
  }
  if (!state.inserted_optional_tail_row ||
      regex_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      regex_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "REGEX update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(regex_update_filter_insert_json.size()),
                 regex_update_filter_insert_json.data(),
                 static_cast<int>(regex_update_filter_insert_profile.size()),
                 regex_update_filter_insert_profile.data());
    return 907;
  }
  xpod_qlever_adapter_release_result(
      adapter, &regex_update_filter_insert_result);

  xpod_qlever_query_request regex_update_filter_verify_request = {};
  regex_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result regex_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &regex_update_filter_verify_request,
      &regex_update_filter_verify_result);
  std::string_view regex_update_filter_verify_json(
      regex_update_filter_verify_result.result_json.data,
      regex_update_filter_verify_result.result_json.size);
  std::string_view regex_update_filter_verify_profile(
      regex_update_filter_verify_result.profile_json.data,
      regex_update_filter_verify_result.profile_json.size);
  std::string_view regex_update_filter_verify_error(
      regex_update_filter_verify_result.error_message.data,
      regex_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "REGEX update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(regex_update_filter_verify_error.size()),
                 regex_update_filter_verify_error.data());
    return 908;
  }
  if (regex_update_filter_verify_json.find("urn:tail") == std::string_view::npos ||
      regex_update_filter_verify_json.find("urn:o") != std::string_view::npos) {
    std::fprintf(stderr, "REGEX update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(regex_update_filter_verify_json.size()),
                 regex_update_filter_verify_json.data(),
                 static_cast<int>(regex_update_filter_verify_profile.size()),
                 regex_update_filter_verify_profile.data());
    return 909;
  }
  xpod_qlever_adapter_release_result(
      adapter, &regex_update_filter_verify_result);

  xpod_qlever_query_request regex_update_filter_cleanup_request = {};
  regex_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:tail> }");
  xpod_qlever_query_result regex_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &regex_update_filter_cleanup_request,
      &regex_update_filter_cleanup_result);
  std::string_view regex_update_filter_cleanup_json(
      regex_update_filter_cleanup_result.result_json.data,
      regex_update_filter_cleanup_result.result_json.size);
  std::string_view regex_update_filter_cleanup_profile(
      regex_update_filter_cleanup_result.profile_json.data,
      regex_update_filter_cleanup_result.profile_json.size);
  std::string_view regex_update_filter_cleanup_error(
      regex_update_filter_cleanup_result.error_message.data,
      regex_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "REGEX update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(regex_update_filter_cleanup_error.size()),
                 regex_update_filter_cleanup_error.data());
    return 910;
  }
  if (state.inserted_optional_tail_row ||
      regex_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      regex_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "REGEX update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(regex_update_filter_cleanup_json.size()),
                 regex_update_filter_cleanup_json.data(),
                 static_cast<int>(regex_update_filter_cleanup_profile.size()),
                 regex_update_filter_cleanup_profile.data());
    return 911;
  }
  xpod_qlever_adapter_release_result(
      adapter, &regex_update_filter_cleanup_result);

  xpod_qlever_query_request lcase_not_update_filter_insert_request = {};
  lcase_not_update_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> ?o } "
      "WHERE { ?s <urn:p> ?o FILTER((?s IN (<urn:s>, <urn:literal-s>)) && LCASE(STR(?s)) != \"urn:literal-s\") }");
  xpod_qlever_query_result lcase_not_update_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_not_update_filter_insert_request,
      &lcase_not_update_filter_insert_result);
  std::string_view lcase_not_update_filter_insert_json(
      lcase_not_update_filter_insert_result.result_json.data,
      lcase_not_update_filter_insert_result.result_json.size);
  std::string_view lcase_not_update_filter_insert_profile(
      lcase_not_update_filter_insert_result.profile_json.data,
      lcase_not_update_filter_insert_result.profile_json.size);
  std::string_view lcase_not_update_filter_insert_error(
      lcase_not_update_filter_insert_result.error_message.data,
      lcase_not_update_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where failed: %.*s\n",
                 static_cast<int>(lcase_not_update_filter_insert_error.size()),
                 lcase_not_update_filter_insert_error.data());
    return 912;
  }
  if (!state.modified_row ||
      lcase_not_update_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      lcase_not_update_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_not_update_filter_insert_json.size()),
                 lcase_not_update_filter_insert_json.data(),
                 static_cast<int>(lcase_not_update_filter_insert_profile.size()),
                 lcase_not_update_filter_insert_profile.data());
    return 913;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_not_update_filter_insert_result);

  xpod_qlever_query_request lcase_not_update_filter_verify_request = {};
  lcase_not_update_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result lcase_not_update_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_not_update_filter_verify_request,
      &lcase_not_update_filter_verify_result);
  std::string_view lcase_not_update_filter_verify_json(
      lcase_not_update_filter_verify_result.result_json.data,
      lcase_not_update_filter_verify_result.result_json.size);
  std::string_view lcase_not_update_filter_verify_profile(
      lcase_not_update_filter_verify_result.profile_json.data,
      lcase_not_update_filter_verify_result.profile_json.size);
  std::string_view lcase_not_update_filter_verify_error(
      lcase_not_update_filter_verify_result.error_message.data,
      lcase_not_update_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where verification failed: %.*s\n",
                 static_cast<int>(lcase_not_update_filter_verify_error.size()),
                 lcase_not_update_filter_verify_error.data());
    return 914;
  }
  if (lcase_not_update_filter_verify_json.find("urn:o") == std::string_view::npos ||
      lcase_not_update_filter_verify_json.find("literal-value") != std::string_view::npos) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_not_update_filter_verify_json.size()),
                 lcase_not_update_filter_verify_json.data(),
                 static_cast<int>(lcase_not_update_filter_verify_profile.size()),
                 lcase_not_update_filter_verify_profile.data());
    return 915;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_not_update_filter_verify_result);

  xpod_qlever_query_request lcase_not_update_filter_cleanup_request = {};
  lcase_not_update_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result lcase_not_update_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_not_update_filter_cleanup_request,
      &lcase_not_update_filter_cleanup_result);
  std::string_view lcase_not_update_filter_cleanup_json(
      lcase_not_update_filter_cleanup_result.result_json.data,
      lcase_not_update_filter_cleanup_result.result_json.size);
  std::string_view lcase_not_update_filter_cleanup_profile(
      lcase_not_update_filter_cleanup_result.profile_json.data,
      lcase_not_update_filter_cleanup_result.profile_json.size);
  std::string_view lcase_not_update_filter_cleanup_error(
      lcase_not_update_filter_cleanup_result.error_message.data,
      lcase_not_update_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(lcase_not_update_filter_cleanup_error.size()),
                 lcase_not_update_filter_cleanup_error.data());
    return 916;
  }
  if (state.modified_row ||
      lcase_not_update_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      lcase_not_update_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "LCASE not-equals update-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(lcase_not_update_filter_cleanup_json.size()),
                 lcase_not_update_filter_cleanup_json.data(),
                 static_cast<int>(lcase_not_update_filter_cleanup_profile.size()),
                 lcase_not_update_filter_cleanup_profile.data());
    return 917;
  }
  xpod_qlever_adapter_release_result(
      adapter, &lcase_not_update_filter_cleanup_result);

  xpod_qlever_query_request typed_in_filter_insert_request = {};
  typed_in_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:o> } "
      "WHERE { <urn:s> <urn:num> ?n FILTER(?n IN (1, 2)) }");
  xpod_qlever_query_result typed_in_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_in_filter_insert_request,
      &typed_in_filter_insert_result);
  std::string_view typed_in_filter_insert_json(
      typed_in_filter_insert_result.result_json.data,
      typed_in_filter_insert_result.result_json.size);
  std::string_view typed_in_filter_insert_profile(
      typed_in_filter_insert_result.profile_json.data,
      typed_in_filter_insert_result.profile_json.size);
  std::string_view typed_in_filter_insert_error(
      typed_in_filter_insert_result.error_message.data,
      typed_in_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed in-filter insert where failed: %.*s\n",
                 static_cast<int>(typed_in_filter_insert_error.size()),
                 typed_in_filter_insert_error.data());
    return 814;
  }
  if (!state.modified_row ||
      typed_in_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      typed_in_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed in-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_in_filter_insert_json.size()),
                 typed_in_filter_insert_json.data(),
                 static_cast<int>(typed_in_filter_insert_profile.size()),
                 typed_in_filter_insert_profile.data());
    return 815;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_in_filter_insert_result);

  xpod_qlever_query_request typed_in_filter_verify_request = {};
  typed_in_filter_verify_request.sparql = bytes(
      "SELECT ?o WHERE { <urn:modified> <urn:p> ?o }");
  xpod_qlever_query_result typed_in_filter_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_in_filter_verify_request,
      &typed_in_filter_verify_result);
  std::string_view typed_in_filter_verify_json(
      typed_in_filter_verify_result.result_json.data,
      typed_in_filter_verify_result.result_json.size);
  std::string_view typed_in_filter_verify_profile(
      typed_in_filter_verify_result.profile_json.data,
      typed_in_filter_verify_result.profile_json.size);
  std::string_view typed_in_filter_verify_error(
      typed_in_filter_verify_result.error_message.data,
      typed_in_filter_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed in-filter insert where verification failed: %.*s\n",
                 static_cast<int>(typed_in_filter_verify_error.size()),
                 typed_in_filter_verify_error.data());
    return 816;
  }
  if (typed_in_filter_verify_json.find("urn:o") == std::string_view::npos) {
    std::fprintf(stderr, "typed in-filter insert where verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_in_filter_verify_json.size()),
                 typed_in_filter_verify_json.data(),
                 static_cast<int>(typed_in_filter_verify_profile.size()),
                 typed_in_filter_verify_profile.data());
    return 817;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_in_filter_verify_result);

  xpod_qlever_query_request typed_in_filter_cleanup_request = {};
  typed_in_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result typed_in_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_in_filter_cleanup_request,
      &typed_in_filter_cleanup_result);
  std::string_view typed_in_filter_cleanup_json(
      typed_in_filter_cleanup_result.result_json.data,
      typed_in_filter_cleanup_result.result_json.size);
  std::string_view typed_in_filter_cleanup_profile(
      typed_in_filter_cleanup_result.profile_json.data,
      typed_in_filter_cleanup_result.profile_json.size);
  std::string_view typed_in_filter_cleanup_error(
      typed_in_filter_cleanup_result.error_message.data,
      typed_in_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed in-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(typed_in_filter_cleanup_error.size()),
                 typed_in_filter_cleanup_error.data());
    return 818;
  }
  if (state.modified_row ||
      typed_in_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      typed_in_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed in-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_in_filter_cleanup_json.size()),
                 typed_in_filter_cleanup_json.data(),
                 static_cast<int>(typed_in_filter_cleanup_profile.size()),
                 typed_in_filter_cleanup_profile.data());
    return 819;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_in_filter_cleanup_result);

  xpod_qlever_query_request typed_greater_filter_insert_request = {};
  typed_greater_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:o> } "
      "WHERE { ?s <urn:num> ?n FILTER(?n > 1) }");
  xpod_qlever_query_result typed_greater_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_greater_filter_insert_request,
      &typed_greater_filter_insert_result);
  std::string_view typed_greater_filter_insert_json(
      typed_greater_filter_insert_result.result_json.data,
      typed_greater_filter_insert_result.result_json.size);
  std::string_view typed_greater_filter_insert_profile(
      typed_greater_filter_insert_result.profile_json.data,
      typed_greater_filter_insert_result.profile_json.size);
  std::string_view typed_greater_filter_insert_error(
      typed_greater_filter_insert_result.error_message.data,
      typed_greater_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed greater-filter insert where failed: %.*s\n",
                 static_cast<int>(typed_greater_filter_insert_error.size()),
                 typed_greater_filter_insert_error.data());
    return 820;
  }
  if (!state.modified_row ||
      typed_greater_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      typed_greater_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed greater-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_greater_filter_insert_json.size()),
                 typed_greater_filter_insert_json.data(),
                 static_cast<int>(typed_greater_filter_insert_profile.size()),
                 typed_greater_filter_insert_profile.data());
    return 821;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_greater_filter_insert_result);

  xpod_qlever_query_request typed_greater_filter_cleanup_request = {};
  typed_greater_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result typed_greater_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_greater_filter_cleanup_request,
      &typed_greater_filter_cleanup_result);
  std::string_view typed_greater_filter_cleanup_json(
      typed_greater_filter_cleanup_result.result_json.data,
      typed_greater_filter_cleanup_result.result_json.size);
  std::string_view typed_greater_filter_cleanup_profile(
      typed_greater_filter_cleanup_result.profile_json.data,
      typed_greater_filter_cleanup_result.profile_json.size);
  std::string_view typed_greater_filter_cleanup_error(
      typed_greater_filter_cleanup_result.error_message.data,
      typed_greater_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed greater-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(typed_greater_filter_cleanup_error.size()),
                 typed_greater_filter_cleanup_error.data());
    return 822;
  }
  if (state.modified_row ||
      typed_greater_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      typed_greater_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed greater-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_greater_filter_cleanup_json.size()),
                 typed_greater_filter_cleanup_json.data(),
                 static_cast<int>(typed_greater_filter_cleanup_profile.size()),
                 typed_greater_filter_cleanup_profile.data());
    return 823;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_greater_filter_cleanup_result);

  xpod_qlever_query_request typed_and_filter_insert_request = {};
  typed_and_filter_insert_request.sparql = bytes(
      "INSERT { <urn:modified> <urn:p> <urn:o> } "
      "WHERE { ?s <urn:num> ?n FILTER(?n > 1 && ?s = <urn:literal-s>) }");
  xpod_qlever_query_result typed_and_filter_insert_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_and_filter_insert_request,
      &typed_and_filter_insert_result);
  std::string_view typed_and_filter_insert_json(
      typed_and_filter_insert_result.result_json.data,
      typed_and_filter_insert_result.result_json.size);
  std::string_view typed_and_filter_insert_profile(
      typed_and_filter_insert_result.profile_json.data,
      typed_and_filter_insert_result.profile_json.size);
  std::string_view typed_and_filter_insert_error(
      typed_and_filter_insert_result.error_message.data,
      typed_and_filter_insert_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed and-filter insert where failed: %.*s\n",
                 static_cast<int>(typed_and_filter_insert_error.size()),
                 typed_and_filter_insert_error.data());
    return 824;
  }
  if (!state.modified_row ||
      typed_and_filter_insert_json.find(R"("inserted":1)") == std::string_view::npos ||
      typed_and_filter_insert_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed and-filter insert where did not insert retained row json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_and_filter_insert_json.size()),
                 typed_and_filter_insert_json.data(),
                 static_cast<int>(typed_and_filter_insert_profile.size()),
                 typed_and_filter_insert_profile.data());
    return 825;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_and_filter_insert_result);

  xpod_qlever_query_request typed_and_filter_cleanup_request = {};
  typed_and_filter_cleanup_request.sparql = bytes(
      "DELETE DATA { <urn:modified> <urn:p> <urn:o> }");
  xpod_qlever_query_result typed_and_filter_cleanup_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &typed_and_filter_cleanup_request,
      &typed_and_filter_cleanup_result);
  std::string_view typed_and_filter_cleanup_json(
      typed_and_filter_cleanup_result.result_json.data,
      typed_and_filter_cleanup_result.result_json.size);
  std::string_view typed_and_filter_cleanup_profile(
      typed_and_filter_cleanup_result.profile_json.data,
      typed_and_filter_cleanup_result.profile_json.size);
  std::string_view typed_and_filter_cleanup_error(
      typed_and_filter_cleanup_result.error_message.data,
      typed_and_filter_cleanup_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "typed and-filter insert where cleanup failed: %.*s\n",
                 static_cast<int>(typed_and_filter_cleanup_error.size()),
                 typed_and_filter_cleanup_error.data());
    return 826;
  }
  if (state.modified_row ||
      typed_and_filter_cleanup_json.find(R"("deleted":1)") == std::string_view::npos ||
      typed_and_filter_cleanup_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "typed and-filter insert where cleanup mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(typed_and_filter_cleanup_json.size()),
                 typed_and_filter_cleanup_json.data(),
                 static_cast<int>(typed_and_filter_cleanup_profile.size()),
                 typed_and_filter_cleanup_profile.data());
    return 827;
  }
  xpod_qlever_adapter_release_result(
      adapter, &typed_and_filter_cleanup_result);

  xpod_qlever_query_request modify_request = {};
  modify_request.sparql = bytes(
      "DELETE { <urn:s> <urn:p> ?o } INSERT { <urn:modified> <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }");
  xpod_qlever_query_result modify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &modify_request, &modify_result);
  std::string_view modify_json(
      modify_result.result_json.data,
      modify_result.result_json.size);
  std::string_view modify_profile(
      modify_result.profile_json.data,
      modify_result.profile_json.size);
  std::string_view modify_error(
      modify_result.error_message.data,
      modify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "modify update failed: %.*s\n",
                 static_cast<int>(modify_error.size()),
                 modify_error.data());
    return 525;
  }
  if (!state.deleted_base_row || !state.modified_row) {
    std::fprintf(stderr, "modify update did not apply delete+insert json=%.*s profile=%.*s\n",
                 static_cast<int>(modify_json.size()),
                 modify_json.data(),
                 static_cast<int>(modify_profile.size()),
                 modify_profile.data());
    return 526;
  }
  if (modify_json.find(R"("inserted":1)") == std::string_view::npos ||
      modify_json.find(R"("deleted":1)") == std::string_view::npos ||
      modify_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "modify update result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(modify_json.size()),
                 modify_json.data(),
                 static_cast<int>(modify_profile.size()),
                 modify_profile.data());
    return 527;
  }
  xpod_qlever_adapter_release_result(adapter, &modify_result);

  xpod_qlever_query_request modify_verify_request = {};
  modify_verify_request.sparql = bytes(
      "SELECT ?s WHERE { ?s <urn:p> <urn:o> } ORDER BY ?s");
  xpod_qlever_query_result modify_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &modify_verify_request, &modify_verify_result);
  std::string_view modify_verify_json(
      modify_verify_result.result_json.data,
      modify_verify_result.result_json.size);
  std::string_view modify_verify_profile(
      modify_verify_result.profile_json.data,
      modify_verify_result.profile_json.size);
  std::string_view modify_verify_error(
      modify_verify_result.error_message.data,
      modify_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "modify verification query failed: %.*s\n",
                 static_cast<int>(modify_verify_error.size()),
                 modify_verify_error.data());
    return 528;
  }
  if (modify_verify_json.find("urn:modified") == std::string_view::npos ||
      modify_verify_json.find("urn:s") != std::string_view::npos) {
    std::fprintf(stderr, "modify verification mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(modify_verify_json.size()),
                 modify_verify_json.data(),
                 static_cast<int>(modify_verify_profile.size()),
                 modify_verify_profile.data());
    return 529;
  }
  xpod_qlever_adapter_release_result(adapter, &modify_verify_result);

  xpod_qlever_query_request clear_graph_seed_request = {};
  clear_graph_seed_request.sparql = bytes(
      "INSERT DATA { GRAPH <urn:clear-g> { <urn:clear-target> <urn:p> <urn:o> } }");
  xpod_qlever_query_result clear_graph_seed_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &clear_graph_seed_request, &clear_graph_seed_result);
  std::string_view clear_graph_seed_json(
      clear_graph_seed_result.result_json.data,
      clear_graph_seed_result.result_json.size);
  std::string_view clear_graph_seed_profile(
      clear_graph_seed_result.profile_json.data,
      clear_graph_seed_result.profile_json.size);
  std::string_view clear_graph_seed_error(
      clear_graph_seed_result.error_message.data,
      clear_graph_seed_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "clear graph seed insert failed: %.*s\n",
                 static_cast<int>(clear_graph_seed_error.size()),
                 clear_graph_seed_error.data());
    return 924;
  }
  if (!state.clear_graph_row ||
      clear_graph_seed_json.find(R"("inserted":1)") == std::string_view::npos ||
      clear_graph_seed_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "clear graph seed insert mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(clear_graph_seed_json.size()),
                 clear_graph_seed_json.data(),
                 static_cast<int>(clear_graph_seed_profile.size()),
                 clear_graph_seed_profile.data());
    return 925;
  }
  xpod_qlever_adapter_release_result(adapter, &clear_graph_seed_result);

  xpod_qlever_query_request clear_graph_request = {};
  clear_graph_request.sparql = bytes("CLEAR GRAPH <urn:clear-g>");
  xpod_qlever_query_result clear_graph_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &clear_graph_request, &clear_graph_result);
  std::string_view clear_graph_json(
      clear_graph_result.result_json.data,
      clear_graph_result.result_json.size);
  std::string_view clear_graph_profile(
      clear_graph_result.profile_json.data,
      clear_graph_result.profile_json.size);
  std::string_view clear_graph_error(
      clear_graph_result.error_message.data,
      clear_graph_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "clear graph update failed: %.*s\n",
                 static_cast<int>(clear_graph_error.size()),
                 clear_graph_error.data());
    return 918;
  }
  if (state.clear_graph_row ||
      clear_graph_json.find(R"("deleted":1)") == std::string_view::npos ||
      clear_graph_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "clear graph result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(clear_graph_json.size()),
                 clear_graph_json.data(),
                 static_cast<int>(clear_graph_profile.size()),
                 clear_graph_profile.data());
    return 919;
  }
  xpod_qlever_adapter_release_result(adapter, &clear_graph_result);

  xpod_qlever_query_request clear_graph_verify_request = {};
  clear_graph_verify_request.sparql = bytes(
      "SELECT ?s FROM <urn:clear-g> WHERE { ?s <urn:p> <urn:o> }");
  xpod_qlever_query_result clear_graph_verify_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &clear_graph_verify_request, &clear_graph_verify_result);
  std::string_view clear_graph_verify_json(
      clear_graph_verify_result.result_json.data,
      clear_graph_verify_result.result_json.size);
  std::string_view clear_graph_verify_profile(
      clear_graph_verify_result.profile_json.data,
      clear_graph_verify_result.profile_json.size);
  std::string_view clear_graph_verify_error(
      clear_graph_verify_result.error_message.data,
      clear_graph_verify_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "clear graph verification failed: %.*s\n",
                 static_cast<int>(clear_graph_verify_error.size()),
                 clear_graph_verify_error.data());
    return 920;
  }
  if (clear_graph_verify_json.find("urn:clear-target") != std::string_view::npos) {
    std::fprintf(stderr, "clear graph verification still returned cleared row json=%.*s profile=%.*s\n",
                 static_cast<int>(clear_graph_verify_json.size()),
                 clear_graph_verify_json.data(),
                 static_cast<int>(clear_graph_verify_profile.size()),
                 clear_graph_verify_profile.data());
    return 921;
  }
  xpod_qlever_adapter_release_result(adapter, &clear_graph_verify_result);

  xpod_qlever_query_request drop_silent_graph_request = {};
  drop_silent_graph_request.sparql = bytes("DROP SILENT GRAPH <urn:clear-g>");
  xpod_qlever_query_result drop_silent_graph_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &drop_silent_graph_request, &drop_silent_graph_result);
  std::string_view drop_silent_graph_json(
      drop_silent_graph_result.result_json.data,
      drop_silent_graph_result.result_json.size);
  std::string_view drop_silent_graph_profile(
      drop_silent_graph_result.profile_json.data,
      drop_silent_graph_result.profile_json.size);
  std::string_view drop_silent_graph_error(
      drop_silent_graph_result.error_message.data,
      drop_silent_graph_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "drop silent graph update failed: %.*s\n",
                 static_cast<int>(drop_silent_graph_error.size()),
                 drop_silent_graph_error.data());
    return 922;
  }
  if (drop_silent_graph_json.find(R"("deleted":0)") == std::string_view::npos ||
      drop_silent_graph_profile.find("Update") == std::string_view::npos) {
    std::fprintf(stderr, "drop silent graph result mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(drop_silent_graph_json.size()),
                 drop_silent_graph_json.data(),
                 static_cast<int>(drop_silent_graph_profile.size()),
                 drop_silent_graph_profile.data());
    return 923;
  }
  xpod_qlever_adapter_release_result(adapter, &drop_silent_graph_result);

  state.time_rows_enabled = true;
  xpod_qlever_query_request stored_datetime_order_request = {};
  stored_datetime_order_request.sparql = bytes(
      "SELECT ?s ?time WHERE { ?s <urn:time> ?time } ORDER BY ?time");
  xpod_qlever_query_result stored_datetime_order_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &stored_datetime_order_request, &stored_datetime_order_result);
  std::string_view stored_datetime_order_json(
      stored_datetime_order_result.result_json.data,
      stored_datetime_order_result.result_json.size);
  std::string_view stored_datetime_order_profile(
      stored_datetime_order_result.profile_json.data,
      stored_datetime_order_result.profile_json.size);
  std::string_view stored_datetime_order_error(
      stored_datetime_order_result.error_message.data,
      stored_datetime_order_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "stored dateTime order query failed: %.*s\n",
                 static_cast<int>(stored_datetime_order_error.size()),
                 stored_datetime_order_error.data());
    return 934;
  }
  const size_t early_pos = stored_datetime_order_json.find("urn:time-early");
  const size_t late_pos = stored_datetime_order_json.find("urn:time-late");
  if (early_pos == std::string_view::npos ||
      late_pos == std::string_view::npos ||
      !(early_pos < late_pos)) {
    std::fprintf(stderr,
                 "stored dateTime order mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_datetime_order_json.size()),
                 stored_datetime_order_json.data(),
                 static_cast<int>(stored_datetime_order_profile.size()),
                 stored_datetime_order_profile.data());
    return 935;
  }
  if (stored_datetime_order_profile.find("OrderBy") == std::string_view::npos) {
    std::fprintf(stderr,
                 "stored dateTime order missing OrderBy profile json=%.*s profile=%.*s\n",
                 static_cast<int>(stored_datetime_order_json.size()),
                 stored_datetime_order_json.data(),
                 static_cast<int>(stored_datetime_order_profile.size()),
                 stored_datetime_order_profile.data());
    return 936;
  }
  if (int code = assert_native_shape_profile(
          "stored dateTime order",
          stored_datetime_order_profile,
          "OrderBy",
          1270)) {
    return code;
  }
  xpod_qlever_adapter_release_result(adapter, &stored_datetime_order_result);

  xpod_qlever_query_request inline_datetime_filter_request = {};
  inline_datetime_filter_request.sparql = bytes(
      "SELECT ?s ?time WHERE { "
      "?s <urn:time> ?time "
      "FILTER(?time >= \"2026-08-28T11:45:00Z\"^^"
      "<http://www.w3.org/2001/XMLSchema#dateTime>) "
      "} ORDER BY ?s");
  xpod_qlever_query_result inline_datetime_filter_result = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &inline_datetime_filter_request, &inline_datetime_filter_result);
  std::string_view inline_datetime_filter_json(
      inline_datetime_filter_result.result_json.data,
      inline_datetime_filter_result.result_json.size);
  std::string_view inline_datetime_filter_profile(
      inline_datetime_filter_result.profile_json.data,
      inline_datetime_filter_result.profile_json.size);
  std::string_view inline_datetime_filter_error(
      inline_datetime_filter_result.error_message.data,
      inline_datetime_filter_result.error_message.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(stderr, "inline dateTime filter query failed: %.*s\n",
                 static_cast<int>(inline_datetime_filter_error.size()),
                 inline_datetime_filter_error.data());
    return 937;
  }
  if (inline_datetime_filter_json.find("urn:time-late") ==
          std::string_view::npos ||
      inline_datetime_filter_json.find(kTimeLateLexical) ==
          std::string_view::npos ||
      inline_datetime_filter_json.find("urn:time-early") !=
          std::string_view::npos ||
      inline_datetime_filter_json.find(kTimeEarlyLexical) !=
          std::string_view::npos) {
    std::fprintf(stderr,
                 "inline dateTime filter mismatch json=%.*s profile=%.*s\n",
                 static_cast<int>(inline_datetime_filter_json.size()),
                 inline_datetime_filter_json.data(),
                 static_cast<int>(inline_datetime_filter_profile.size()),
                 inline_datetime_filter_profile.data());
    return 938;
  }
  if (int code = assert_native_shape_profile(
          "inline dateTime filter",
          inline_datetime_filter_profile,
          "Filter",
          1300)) {
    return code;
  }
  xpod_qlever_adapter_release_result(adapter, &inline_datetime_filter_result);

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
const relationalShapesOnly = hasFlag('--relational-shapes-only');
const externalSmokeSource = readArg('--external-smoke-source');
const runArguments = readArgs('--run-arg');

const smokeSourcePath = externalSmokeSource
  ? path.resolve(externalSmokeSource)
  : path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke.cpp');
const smokeObjectPath = path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke.o');
const smokeBinaryPath = path.join(runtimeBuildDir, 'xpod_qlever_real_runtime_smoke');
const linkLinePath = path.join(qleverBuildDir, 'CMakeFiles/qlever-server.dir/link.txt');

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
const runArgs = [smokeBinaryPath, ...runArguments];

if (dryRun) {
  const dryRunPlan = makeSmokePlan(
    qleverSource,
    qleverBuildDir,
    linkLinePath,
    smokeSourcePath,
    smokeObjectPath,
    smokeBinaryPath,
    adapterBuildDir,
  );
  const payload = {
    fullEngineArgs,
    realAdapterArgs,
    libraryBuildArgs,
    smokeSourcePath,
    smokeObjectPath,
    smokeBinaryPath,
    compileArgs: dryRunPlan.compileArgs,
    linkLinePath,
    linkArgs: dryRunPlan.linkArgs,
    runArgs,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log('[qlever-real-runtime] full engine:', [process.execPath, ...fullEngineArgs].join(' '));
    console.log('[qlever-real-runtime] real adapter:', [process.execPath, ...realAdapterArgs].join(' '));
    console.log('[qlever-real-runtime] libraries:', ['cmake', ...libraryBuildArgs].join(' '));
    console.log('[qlever-real-runtime] compile:', [dryRunPlan.compiler, ...dryRunPlan.compileArgs].join(' '));
    console.log('[qlever-real-runtime] link:', [dryRunPlan.compiler, ...dryRunPlan.linkArgs].join(' '));
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
  if (!externalSmokeSource) {
    writeSmokeSource(smokeSourcePath, relationalShapesOnly);
  } else if (!fileExists(smokeSourcePath)) {
    fail(`external smoke source does not exist: ${smokeSourcePath}`);
  }
  fs.mkdirSync(runtimeBuildDir, { recursive: true });
  if (!configureOnly) {
    const runtimePlan = makeSmokePlan(
      qleverSource,
      qleverBuildDir,
      linkLinePath,
      smokeSourcePath,
      smokeObjectPath,
      smokeBinaryPath,
      adapterBuildDir,
    );
    execFileSync(runtimePlan.compiler, runtimePlan.compileArgs, { cwd: qleverBuildDir, stdio: 'inherit' });
    execFileSync(runtimePlan.compiler, runtimePlan.linkArgs, {
      cwd: qleverBuildDir,
      stdio: 'inherit',
    });
    execFileSync(smokeBinaryPath, runArguments, {
      cwd: runtimeBuildDir,
      stdio: 'inherit',
    });
  }
} catch (error) {
  fail('real upstream QLever runtime smoke failed', error);
}

console.log(`[qlever-real-runtime] OK: ran ${smokeBinaryPath}`);
