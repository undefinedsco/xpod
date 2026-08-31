import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const physicalBackendHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodPhysicalBackend.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever Id codec over Xpod term keys', () => {
  it('uses backend callbacks to encode and decode QLever ValueId bits', async () => {
    expect(hasCxx(), 'c++ compiler is required for native QLever id codec check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-id-codec-'));
    try {
      const smoke = path.join(root, 'id_codec_smoke.cpp');
      const binary = path.join(root, 'id_codec_smoke');
      await writeFile(smoke, `
#include "XpodPhysicalBackend.hpp"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_OPAQUE;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;

  xpod::rdf::PhysicalBackend physical(&backend);
  uint64_t bits = 0;
  if (physical.encodeQleverId(23, bits) != XPOD_RDF_STATUS_OK) return 1;
  if (bits != 1023) return 2;

  xpod_rdf_term_key term = 0;
  if (physical.decodeQleverId(bits, term) != XPOD_RDF_STATUS_OK) return 3;
  if (term != 23) return 4;
  int32_t compare = 99;
  if (physical.compareQleverIds(1001, 1002, compare) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 5;
  if (compare != 99) return 6;

  xpod_rdf_backend_v1 direct = {};
  direct.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  direct.struct_size = sizeof(xpod_rdf_backend_v1);
  direct.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend directPhysical(&direct);
  if (directPhysical.preservesQleverTermOrder()) return 7;
  if (directPhysical.encodeQleverId(77, bits) != XPOD_RDF_STATUS_OK) return 8;
  if (bits != 77) return 9;
  if (directPhysical.decodeQleverId(88, term) != XPOD_RDF_STATUS_OK) return 10;
  if (term != 88) return 11;
  if (directPhysical.compareQleverIds(77, 88, compare) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 12;

  direct.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED;
  xpod::rdf::PhysicalBackend orderedDirectPhysical(&direct);
  if (!orderedDirectPhysical.preservesQleverTermOrder()) return 13;
  if (orderedDirectPhysical.compareQleverIds(77, 88, compare) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 14;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(physicalBackendHeader),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
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
