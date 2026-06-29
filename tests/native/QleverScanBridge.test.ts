import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever scan bridge', () => {
  it('builds an Xpod physical scan request from a QLever permutation and triple key pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-bridge-'));
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

      const smoke = path.join(root, 'scan_bridge_smoke.cpp');
      const binary = path.join(root, 'scan_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverScanBridge.hpp"

int main() {
  xpod_rdf_snapshot snapshot = {};
  xpod::qlever::TripleKeyPattern pattern = {};
  pattern.has_subject = true;
  pattern.subject = 11;
  pattern.has_object = true;
  pattern.object = 33;

  xpod::qlever::ScanRequestInput input = {};
  input.snapshot = &snapshot;
  input.permutation = Permutation::Enum::SOP;
  input.pattern = pattern;
  input.limit = 100;
  input.offset = 7;
  input.batch_size = 64;
  input.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;

  xpod_rdf_scan_request request = xpod::qlever::makeScanRequest(input);
  if (request.snapshot.snapshot_token.data != snapshot.snapshot_token.data) return 1;
  if (request.permutation != XPOD_RDF_PERM_SOPG) return 2;
  if (!request.pattern.has_subject || request.pattern.subject != 11) return 3;
  if (request.pattern.has_predicate) return 4;
  if (!request.pattern.has_object || request.pattern.object != 33) return 5;
  if (request.pattern.has_graph) return 6;
  if (request.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) return 7;
  if (request.order.kind != XPOD_RDF_SCAN_ORDER_NATIVE) return 8;
  if (request.limit != 100 || request.offset != 7) return 9;
  if (request.batch_size != 64) return 10;
  if (request.needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 11;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(bridgeHeader),
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
