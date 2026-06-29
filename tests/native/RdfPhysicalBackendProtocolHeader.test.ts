import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const headerPath = path.join(repoRoot, 'native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h');

function compiler(name: 'cc' | 'c++'): string | null {
  try {
    execFileSync('/usr/bin/env', [name, '--version'], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

describe('native RDF physical backend protocol header', () => {
  it('exists and exposes a native-first C ABI boundary', () => {
    expect(existsSync(headerPath)).toBe(true);
    const header = readFileSync(headerPath, 'utf8');

    expect(header).toContain('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 1');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_rdf_backend_v1');
    expect(header).toContain('xpod_rdf_lookup_terms_fn');
    expect(header).toContain('xpod_rdf_resolve_terms_fn');
    expect(header).toContain('xpod_rdf_scan_permutation_fn');
    expect(header).toContain('xpod_rdf_source_scope source_scope');
    expect(header).toContain('xpod_rdf_estimate_source_scope_fn');
    expect(header).toContain('xpod_rdf_text_search_fn');
    expect(header).toContain('xpod_rdf_vector_search_fn');
    expect(header).toContain('xpod_rdf_encode_qlever_id_fn');
    expect(header).toContain('XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS');
    expect(header).toContain('XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED');
    expect(header).toContain('xpod_rdf_qlever_term_ordering qlever_term_ordering');
    expect(header).toContain('xpod_rdf_profile_event_callback');

    expect(header).not.toMatch(/std::|namespace\s+|template\s*</);
    expect(header).not.toMatch(/IndexImpl|PermutationPtr|RuntimeInformation|QLever/);
  });

  it('is consumable from C and C++ without exposing C++ ABI', async () => {
    const cc = compiler('cc');
    const cxx = compiler('c++');
    expect(cc, 'cc compiler is required for native ABI syntax check').toBeTruthy();
    expect(cxx, 'c++ compiler is required for native ABI syntax check').toBeTruthy();

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-protocol-'));
    try {
      const source = `#include <string.h>\n#include "native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend;\n  memset(&backend, 0, sizeof(backend));\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  return backend.abi_version == 1 ? 0 : 1;\n}\n`;
      const cFile = path.join(root, 'check.c');
      const cppFile = path.join(root, 'check.cpp');
      await writeFile(cFile, source, 'utf8');
      await writeFile(cppFile, source, 'utf8');

      execFileSync(cc!, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cFile], { stdio: 'pipe' });
      execFileSync(cxx!, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cppFile], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('has a repository ABI check command for the native protocol header', () => {
    const scriptPath = path.join(repoRoot, 'scripts/check-rdf-physical-protocol-abi.cjs');
    expect(existsSync(scriptPath)).toBe(true);
    execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, stdio: 'pipe' });
  });

});
