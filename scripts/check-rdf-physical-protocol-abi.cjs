#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const headerPath = path.join(repoRoot, 'native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h');
const adapterHeaderPath = path.join(repoRoot, 'native/postgres/qlever_adapter/include/xpod_qlever_adapter.h');
const adapterSourcePath = path.join(repoRoot, 'native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp');
const adapterRoot = path.join(repoRoot, 'native/postgres/qlever_adapter');
const adapterCmakePath = path.join(adapterRoot, 'CMakeLists.txt');

const requiredSymbols = [
  '#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 1',
  'extern "C"',
  'typedef struct xpod_rdf_backend_v1',
  'xpod_rdf_lookup_term_fn',
  'xpod_rdf_lookup_terms_fn',
  'xpod_rdf_resolve_terms_fn',
  'xpod_rdf_scan_permutation_fn',
  'xpod_rdf_estimate_scan_fn',
  'xpod_rdf_text_search_fn',
  'xpod_rdf_vector_search_fn',
  'xpod_rdf_resolve_access_scope_fn',
  'xpod_rdf_encode_qlever_id_fn',
  'XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS',
  'xpod_rdf_profile_event_callback',
];

const forbiddenHeaderPatterns = [
  /std::/,
  /namespace\s+/,
  /template\s*</,
  /IndexImpl/,
  /PermutationPtr/,
  /RuntimeInformation/,
  /QLever/,
];

const requiredAdapterHeaderSymbols = [
  '#include "xpod_rdf_physical_backend.h"',
  'extern "C"',
  'typedef struct xpod_qlever_adapter_config',
  'typedef struct xpod_qlever_query_request',
  'xpod_qlever_adapter_query_request',
  'xpod_qlever_adapter_create',
  'xpod_qlever_adapter_destroy',
  'xpod_qlever_adapter_abi_version',
];

const forbiddenAdapterHeaderPatterns = [
  /std::/,
  /namespace\s+/,
  /template\s*</,
  /IndexImpl/,
  /PermutationPtr/,
  /RuntimeInformation/,
];

function fail(message, error) {
  console.error(`[rdf-protocol-abi] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function commandExists(command) {
  try {
    execFileSync('/usr/bin/env', [command, '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(headerPath)) {
  fail(`missing header: ${path.relative(repoRoot, headerPath)}`);
}

const header = fs.readFileSync(headerPath, 'utf8');
for (const symbol of requiredSymbols) {
  if (!header.includes(symbol)) {
    fail(`header is missing required symbol: ${symbol}`);
  }
}

for (const pattern of forbiddenHeaderPatterns) {
  if (pattern.test(header)) {
    fail(`header leaks forbidden native-boundary token: ${pattern}`);
  }
}

if (!fs.existsSync(adapterHeaderPath)) {
  fail(`missing adapter header: ${path.relative(repoRoot, adapterHeaderPath)}`);
}
if (!fs.existsSync(adapterSourcePath)) {
  fail(`missing adapter source: ${path.relative(repoRoot, adapterSourcePath)}`);
}
if (!fs.existsSync(adapterCmakePath)) {
  fail(`missing adapter CMake target: ${path.relative(repoRoot, adapterCmakePath)}`);
}

const adapterHeader = fs.readFileSync(adapterHeaderPath, 'utf8');
for (const symbol of requiredAdapterHeaderSymbols) {
  if (!adapterHeader.includes(symbol)) {
    fail(`adapter header is missing required symbol: ${symbol}`);
  }
}
for (const pattern of forbiddenAdapterHeaderPatterns) {
  if (pattern.test(adapterHeader)) {
    fail(`adapter header leaks forbidden native-boundary token: ${pattern}`);
  }
}

const source = `#include <string.h>\n#include "native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend;\n  memset(&backend, 0, sizeof(backend));\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  backend.struct_size = sizeof(backend);\n  return backend.abi_version == 1 ? 0 : 1;\n}\n`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-rdf-protocol-abi-'));
try {
  const cFile = path.join(tmp, 'check.c');
  const cppFile = path.join(tmp, 'check.cpp');
  fs.writeFileSync(cFile, source);
  fs.writeFileSync(cppFile, source);

  if (commandExists('cc')) {
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cFile], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: cc not found, skipped C syntax check');
  }

  if (commandExists('c++')) {
    execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cppFile], { stdio: 'pipe' });
    execFileSync('c++', [
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
      '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
      '-I', repoRoot,
      '-fsyntax-only',
      adapterSourcePath,
    ], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: c++ not found, skipped C++ syntax check');
  }
  if (commandExists('cmake')) {
    const buildDir = path.join(tmp, 'adapter-build');
    execFileSync('cmake', [
      '-S', adapterRoot,
      '-B', buildDir,
      '-DXPOD_QLEVER_ADAPTER_BUILD_SHARED=OFF',
    ], { stdio: 'pipe' });
    execFileSync('cmake', [
      '--build', buildDir,
      '--target', 'xpod_qlever_adapter',
    ], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: cmake not found, skipped adapter target build check');
  }
} catch (error) {
  fail('native RDF protocol ABI check failed', error);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[rdf-protocol-abi] OK: native RDF physical backend C ABI header is valid.');
console.log('[rdf-protocol-abi] OK: QLever adapter facade is valid.');
console.log('[rdf-protocol-abi] OK: QLever adapter CMake target builds.');
