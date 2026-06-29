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
  backend.backend_user_data = &calls;
  backend.scan_permutation = scan;

  xpod::rdf::PhysicalBackend physical(&backend);
  if (!physical.valid()) return 1;

  xpod_rdf_scan_request request = {};
  if (physical.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_OK) return 2;
  if (calls != 1) return 3;

  xpod_rdf_backend_v1 missing = {};
  missing.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  xpod::rdf::PhysicalBackend unsupported(&missing);
  if (unsupported.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_UNSUPPORTED) return 4;

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
