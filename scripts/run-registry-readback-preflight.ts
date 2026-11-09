import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRegistryProduct } from './verify-registry-product';

const authority = { published: false, candidatePlanGenerated: false, releaseQualified: false,
  sourceVerified: false, nativeAdmission: false, legalClearance: false, consumerValidated: false } as const;
/** Manual opt-in report only. Output location and authority cannot be supplied by input. */
export async function runRegistryReadbackPreflight(environment: NodeJS.ProcessEnv = process.env, transport?: typeof fetch): Promise<number> {
  const raw = environment.REGISTRY_READBACK_INPUT ?? '';
  if (environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || raw === '') return 0;
  let result: Record<string, unknown>;
  let exit = 1;
  try {
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('input bound');
    const input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'expected,package,registry,version'
      || !input.expected || typeof input.expected !== 'object' || Array.isArray(input.expected)
      || Object.keys(input.expected).sort().join(',') !== 'bytes,integrity,sha256') throw new Error('input keys');
    const readback = await verifyRegistryProduct(input, { fetch: transport });
    if (readback.status !== 'readback-only' && readback.status !== 'not-published-blocked') throw new Error('unexpected report');
    result = { ...readback, ...authority };
    exit = readback.status === 'readback-only' ? 0 : 2;
  } catch {
    // Never serialize input or exception messages: URLs or unexpected fields may contain secrets.
    result = { schemaVersion: 1, kind: 'registry-exact-product-readback', status: 'readback-failed', ...authority };
  }
  const directory = resolve('.test-data/independent-release-prepare');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, 'registry-readback.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRegistryReadbackPreflight().then(code => { process.exitCode = code; }, () => {
    process.stderr.write('Registry readback report could not be preserved.\n'); process.exitCode = 1;
  });
}
