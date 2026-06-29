import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const facadeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever adapter physical backend facade', () => {
  it('wraps the native C ABI callback table for internal C++ adapter code', async () => {
    expect(hasCxx(), 'c++ compiler is required for native facade check').toBe(true);
    expect(existsSync(facadeHeader)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-facade-'));
    try {
      const source = path.join(root, 'check.cpp');
      const binary = path.join(root, 'check');
      await writeFile(source, `
#include "XpodPhysicalBackend.hpp"

static xpod_rdf_status lookup_one(
    void* backend_user_data,
    const xpod_rdf_term*,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_key) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1000;
  *out_key = 42;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status lookup_terms(
    void* backend_user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 10;
  for (size_t i = 0; i < term_count; ++i) {
    out_keys[i] = terms[i].value.size + 100;
    out_statuses[i] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 100;
  for (size_t i = 0; i < key_count; ++i) {
    out_terms[i].kind = XPOD_RDF_TERM_IRI;
    out_terms[i].value = {nullptr, keys[i] - 100};
    out_statuses[i] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1;
  (void)request;
  (void)on_batch;
  (void)callback_user_data;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  int calls = 0;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &calls;
  backend.lookup_terms = lookup_terms;
  backend.resolve_terms = resolve_terms;
  backend.scan_permutation = scan;

  xpod::rdf::PhysicalBackend physical(&backend);
  if (!physical.valid()) return 1;

  xpod_rdf_term terms[2] = {};
  terms[0].kind = XPOD_RDF_TERM_IRI;
  terms[0].value = {"abcd", 4};
  terms[1].kind = XPOD_RDF_TERM_LITERAL;
  terms[1].value = {"xy", 2};
  xpod_rdf_term_key keys[2] = {};
  xpod_rdf_status term_statuses[2] = {};
  xpod_rdf_snapshot snapshot = {};
  if (physical.lookupTerms(terms, 2, snapshot, keys, term_statuses) != XPOD_RDF_STATUS_OK) return 2;
  if (keys[0] != 104 || keys[1] != 102) return 3;
  if (term_statuses[0] != XPOD_RDF_STATUS_OK || term_statuses[1] != XPOD_RDF_STATUS_OK) return 4;

  xpod_rdf_term resolved[2] = {};
  if (physical.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_OK) return 5;
  if (resolved[0].value.size != 4 || resolved[1].value.size != 2) return 6;

  xpod_rdf_scan_request request = {};
  if (physical.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_OK) return 7;
  if (calls != 111) return 8;

  xpod_rdf_backend_v1 truncated = {};
  truncated.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  truncated.struct_size = offsetof(xpod_rdf_backend_v1, lookup_term);
  truncated.backend_user_data = &calls;
  truncated.lookup_term = lookup_one;
  xpod::rdf::PhysicalBackend truncated_physical(&truncated);
  xpod_rdf_term_key lookup_key = 0;
  if (truncated_physical.lookupTerm(terms[0], snapshot, lookup_key) != XPOD_RDF_STATUS_UNSUPPORTED) return 12;
  if (lookup_key != 0) return 13;
  if (calls != 111) return 14;

  xpod_rdf_backend_v1 missing = {};
  missing.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  missing.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend unsupported(&missing);
  if (unsupported.lookupTerms(terms, 2, snapshot, keys, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 9;
  if (unsupported.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 10;
  if (unsupported.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_UNSUPPORTED) return 11;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(facadeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        source,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
