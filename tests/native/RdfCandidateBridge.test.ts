import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodCandidateBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('native RDF candidate bridge', () => {
  it('materializes text and vector candidate batches from the physical backend', async () => {
    expect(hasCxx(), 'c++ compiler is required for native candidate bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-candidate-bridge-'));
    try {
      const source = path.join(root, 'candidate_bridge_smoke.cpp');
      const binary = path.join(root, 'candidate_bridge_smoke');
      await writeFile(source, `
#include "XpodCandidateBridge.hpp"

static xpod_rdf_status text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request->limit != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate rows[2] = {};
  rows[0].has_retrieval_point = 1;
  rows[0].retrieval_point = 11;
  rows[0].has_resource_term = 1;
  rows[0].resource_term = 101;
  rows[0].score = 0.75;
  rows[0].range.start_line = 3;
  rows[0].range.end_line = 5;
  rows[0].scorer = {"pg-ts-rank-cd", 13};
  rows[1].has_source_node = 1;
  rows[1].source_node = 22;
  rows[1].score = 0.25;
  rows[1].scorer = {"pg-ts-rank-cd", 13};
  xpod_rdf_candidate_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.scanned_rows = 9;
  batch.scorer = {"pg-ts-rank-cd", 13};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request->dimensions != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.has_retrieval_point = 1;
  row.retrieval_point = 33;
  row.score = 0.9;
  row.scorer = {"vector-cosine", 13};
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 4;
  batch.scorer = {"vector-cosine", 13};
  return on_batch(callback_user_data, &batch);
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.text_search = text_search;
  backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_text_search_request text_request = {};
  text_request.limit = 2;
  xpod::rdf::CandidateBuffer text;
  if (xpod::rdf::executeTextSearchToCandidates(physical, text_request, text) != XPOD_RDF_STATUS_OK) return 1;
  if (text.rows.size() != 2 || text.scanned_rows != 9) return 2;
  if (!text.rows[0].has_retrieval_point || text.rows[0].retrieval_point != 11) return 3;
  if (!text.rows[0].has_resource_term || text.rows[0].resource_term != 101) return 4;
  if (text.rows[0].range.start_line != 3 || text.rows[0].range.end_line != 5) return 5;
  if (text.rows[0].score != 0.75) return 6;
  if (text.rows[0].scorer != "pg-ts-rank-cd") return 11;

  double vector_values[2] = {0.1, 0.2};
  xpod_rdf_vector_search_request vector_request = {};
  vector_request.vector = vector_values;
  vector_request.dimensions = 2;
  xpod::rdf::CandidateBuffer vector;
  if (xpod::rdf::executeVectorSearchToCandidates(physical, vector_request, vector) != XPOD_RDF_STATUS_OK) return 7;
  if (vector.rows.size() != 1 || vector.scanned_rows != 4) return 8;
  if (!vector.rows[0].has_retrieval_point || vector.rows[0].retrieval_point != 33) return 9;
  if (vector.rows[0].score != 0.9) return 10;
  if (vector.rows[0].scorer != "vector-cosine") return 12;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(bridgeHeader),
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
