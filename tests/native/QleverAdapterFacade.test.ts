import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const publicHeader = path.join(repoRoot, 'native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h');
const facadeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/include/xpod_qlever_adapter.h');
const facadeSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp');

function requireCompiler(name: 'c++'): string {
  try {
    execFileSync('/usr/bin/env', [name, '--version'], { stdio: 'ignore' });
    return name;
  } catch {
    throw new Error(`${name} compiler is required for native QLever adapter facade syntax check`);
  }
}

describe('native QLever adapter facade', () => {
  it('declares a C ABI facade without exposing QLever or C++ types', () => {
    expect(existsSync(facadeHeader)).toBe(true);
    const header = readFileSync(facadeHeader, 'utf8');

    expect(header).toContain('#include "xpod_rdf_physical_backend.h"');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_qlever_adapter_config');
    expect(header).toContain('xpod_qlever_adapter_create');
    expect(header).toContain('xpod_qlever_adapter_destroy');
    expect(header).toContain('xpod_qlever_adapter_abi_version');

    expect(header).not.toMatch(/std::|namespace\s+|template\s*</);
    expect(header).not.toMatch(/IndexImpl|PermutationPtr|RuntimeInformation/);
  });

  it('compiles the facade translation unit against the physical backend ABI', async () => {
    expect(existsSync(publicHeader)).toBe(true);
    expect(existsSync(facadeSource)).toBe(true);

    const cxx = requireCompiler('c++');
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-'));
    try {
      const smoke = path.join(root, 'adapter_smoke.cpp');
      await writeFile(smoke, `#include <stddef.h>\n#include "native/postgres/qlever_adapter/include/xpod_qlever_adapter.h"\nint main() {\n  xpod_qlever_adapter_config config;\n  config.backend = nullptr;\n  config.memory_limit_bytes = 0;\n  config.enable_runtime_profile = 1;\n  return xpod_qlever_adapter_abi_version() == XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION ? 0 : 1;\n}\n`, 'utf8');

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', repoRoot,
        '-fsyntax-only',
        facadeSource,
      ], { stdio: 'pipe' });

      execFileSync(cxx, [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', repoRoot,
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-fsyntax-only',
        smoke,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes the QLever adapter facade in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter facade');
  });
});
