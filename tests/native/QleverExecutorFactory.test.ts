import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverExecutor.cpp');
const bridgeSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever executor factory', () => {
  it('uses the upstream bridge executor branch when QLever support is compiled in', async () => {
    expect(hasCxx(), 'c++ compiler is required for native executor factory check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-executor-factory-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');

      const smoke = path.join(root, 'enabled_executor_smoke.cpp');
      const binary = path.join(root, 'enabled_executor_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;

  xpod_qlever_adapter_config config = {};
  config.backend = &backend;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  xpod_qlever_query_result result = {};
  xpod_rdf_bytes query = {"SELECT * WHERE { ?s ?p ?o }", 27};
  xpod_rdf_status status = xpod_qlever_adapter_query(adapter, query, &result);
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (error.find("upstream QLever bridge") == std::string_view::npos) return 3;

  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
        '-I', path.join(qleverSource, 'src'),
        adapterSource,
        executorSource,
        bridgeSource,
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
