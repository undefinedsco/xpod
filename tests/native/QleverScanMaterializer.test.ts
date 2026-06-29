import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const materializerHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever scan materializer', () => {
  it('materializes Xpod quad batches into QLever permutation row order', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan materializer check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-materializer-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'scan_materializer_smoke.cpp');
      const binary = path.join(root, 'scan_materializer_smoke');
      await writeFile(smoke, `
#include "XpodQleverScanMaterializer.hpp"

int main() {
  xpod_rdf_quad_key rows[2] = {
    {10, 20, 30, 40},
    {11, 21, 31, 41},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;

  xpod::qlever::ScanRowBuffer buffer;
  xpod::qlever::appendBatch(buffer, Permutation::Enum::POS, batch);

  if (buffer.width != 3) return 1;
  if (buffer.rows.size() != 6) return 2;
  if (buffer.rows[0] != 20 || buffer.rows[1] != 30 || buffer.rows[2] != 10) return 3;
  if (buffer.rows[3] != 21 || buffer.rows[4] != 31 || buffer.rows[5] != 11) return 4;

  xpod::qlever::ScanRowBuffer ops;
  xpod::qlever::appendBatch(ops, Permutation::Enum::OPS, batch);
  if (ops.rows[0] != 30 || ops.rows[1] != 20 || ops.rows[2] != 10) return 5;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(materializerHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
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
