import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { exactVersion } from './independent-release-plan';
const { inspectTarballFile, MANIFEST_MAX_BYTES } = createRequire(import.meta.url)('./workspace-package-payload.cjs');

export interface RegistryProductInput {
  registry: string;
  package: string;
  version: string;
  expected: { sha256: string; integrity: string; bytes: number };
}
interface Dependencies {
  fetch?: typeof fetch;
  token?: string;
  timeoutMs?: number;
  metadataMaxBytes?: number;
  limits?: Partial<ReadbackLimits>;
}
const METADATA_MAX = MANIFEST_MAX_BYTES + 64 * 1024;
export interface ReadbackLimits { packedBytes: number; expandedBytes: number; members: number; manifestBytes: number; freeFloorBytes: number }
const DEFAULT_LIMITS: ReadbackLimits = { packedBytes: 1024 ** 3, expandedBytes: 4 * 1024 ** 3, members: 100000, manifestBytes: MANIFEST_MAX_BYTES, freeFloorBytes: 1152 * 1024 ** 2 };
export function registryReadbackBudget(bytes: number, overrides: Partial<ReadbackLimits> = {}) {
  for (const key of Object.keys(overrides)) if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key)) fail('unknown resource budget');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as Array<keyof ReadbackLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || (key === 'freeFloorBytes' ? limits[key] < DEFAULT_LIMITS[key] : limits[key] > DEFAULT_LIMITS[key])) fail('invalid resource budget');
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.packedBytes) fail('packed byte budget exceeded');
  return limits;
}
const fail = (message: string): never => { throw new Error('Registry readback: ' + message); };
function secureURL(value: string, base?: URL): URL {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) fail('unsafe URL');
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) fail('unsafe URL');
  return url;
}
/** GET-only byte comparison. Does not publish, promote, install, or grant admission. */
export async function verifyRegistryProduct(input: RegistryProductInput, dependencies: Dependencies = {}) {
  const registry = secureURL(input.registry);
  if (registry.href !== input.registry || registry.search || !registry.pathname.endsWith('/')) fail('canonical registry URL required');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(input.package) || !exactVersion(input.version)) fail('exact package/version required');
  const expected = input.expected;
  const limits = registryReadbackBudget(expected?.bytes, dependencies.limits);
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(expected.integrity)
    || 'sha512-' + Buffer.from(expected.integrity.slice(7), 'base64').toString('base64') !== expected.integrity
    || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) fail('bounded original SHA256/SRI/bytes required');
  const timeout = dependencies.timeoutMs ?? 30_000;
  const metadataMax = dependencies.metadataMaxBytes ?? METADATA_MAX;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000
    || !Number.isSafeInteger(metadataMax) || metadataMax < 1 || metadataMax > METADATA_MAX
    || (dependencies.token !== undefined && (!dependencies.token || /[\r\n]/u.test(dependencies.token)))) fail('invalid transport limits/token');
  const signal = AbortSignal.timeout(timeout);
  const transport = dependencies.fetch ?? fetch;
  async function wait<T>(pending: Promise<T>): Promise<T> {
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([pending, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  const cancel = (response: Response) => { void response.body?.cancel().catch(() => {}); };
  async function request(start: URL): Promise<{ response: Response; url: URL }> {
    let url = start;
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      const response = await wait(transport(url.href, { method: 'GET', redirect: 'manual', signal,
        headers: url.origin === registry.origin && dependencies.token ? { Authorization: 'Bearer ' + dependencies.token } : {} }));
      if (response.redirected) { cancel(response); fail('automatic redirect forbidden'); }
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
      const location = response.headers.get('location');
      cancel(response);
      if (!location || hop === 3) return fail('invalid redirect or redirect limit');
      url = secureURL(location, url);
    }
    return fail('redirect limit');
  }
  async function body(response: Response, bound: number) {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > bound)) {
      cancel(response); fail('invalid or oversized Content-Length');
    }
    if (!response.body) {
      if (response.status === 404 && (length === null || Number(length) === 0)) {
        return { data: Buffer.alloc(0), bytes: 0, sha256: createHash('sha256').digest('hex'), integrity: 'sha512-' + createHash('sha512').digest('base64') };
      }
      return fail('missing response body');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    const sha = createHash('sha256'), sri = createHash('sha512');
    let bytes = 0;
    try {
      while (true) {
        const chunk = await wait(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > bound) fail('streamed body exceeds bound');
        const data = Buffer.from(chunk.value);
        chunks.push(data); sha.update(data); sri.update(data);
      }
      if (length !== null && Number(length) !== bytes) fail('Content-Length differs from actual bytes');
      return { data: Buffer.concat(chunks), bytes, sha256: sha.digest('hex'), integrity: 'sha512-' + sri.digest('base64') };
    } finally {
      // Do not await a hostile underlying stream's cancellation indefinitely.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const authority = { releaseQualified: false, sourceVerified: false, nativeAdmission: false, legalClearance: false, consumerValidated: false } as const;
  const identity = { schemaVersion: 1, kind: 'registry-exact-product-readback', registry: registry.href, package: input.package, version: input.version, ...authority };
  const metadataRequest = await request(new URL(encodeURIComponent(input.package) + '/' + encodeURIComponent(input.version), registry));
  const { response } = metadataRequest;
  const safeFinalURL = (url: URL) => url.origin + url.pathname;
  const metadataURL = safeFinalURL(metadataRequest.url);
  if (response.status === 404) {
    // Bound even error bodies; a missing version is a blocker, never a pass.
    await body(response, metadataMax);
    return { ...identity, status: 'not-published-blocked' as const, metadataURL };
  }
  if (response.status !== 200) { cancel(response); fail('metadata HTTP status ' + response.status); }
  const metadataBody = await body(response, metadataMax);
  const archiveURL = (() => {
    const metadata = JSON.parse(metadataBody.data.toString('utf8'));
    if (metadata?.name !== input.package || metadata.version !== input.version || metadata.dist?.integrity !== expected.integrity) fail('metadata exact identity/integrity conflict');
    return secureURL(metadata.dist.tarball);
  })();
  // Drop the full metadata buffer/object before inspecting the archive manifest.
  // Garbage collection timing is runtime controlled, not an RSS guarantee.
  metadataBody.data = Buffer.alloc(0);
  const archiveRequest = await request(archiveURL);
  const archive = archiveRequest.response;
  if (archive.status !== 200) { cancel(archive); fail('archive HTTP status ' + archive.status); }
  // Temporary transport spool only: bounded disk, no payload extraction or persistent cache.
  let directory: string | undefined;
  try {
    const parent = resolve('.test-data/registry-readback');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(parent, 'readback-'));
    const file = join(directory, 'archive.tgz');
    const ensureDisk = async (remaining: number) => {
      const stats = await statfs(directory!);
      if (stats.bavail * stats.bsize < remaining + limits.freeFloorBytes) fail('disk free floor/budget exceeded');
    };
    await ensureDisk(expected.bytes);
    const length = archive.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== expected.bytes)) { cancel(archive); fail('invalid or oversized Content-Length'); }
    if (!archive.body) fail('missing response body');
    // Open before locking the response: an open failure leaves the body cancellable.
    const handle = await open(file, 'wx', 0o600);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const sha = createHash('sha256'), sri = createHash('sha512');
    let bytes = 0;
    try {
      reader = archive.body!.getReader();
      while (true) {
        const chunk = await wait(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > expected.bytes) fail('streamed body exceeds bound');
        await ensureDisk(expected.bytes - bytes + chunk.value.byteLength);
        sha.update(chunk.value); sri.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.length) {
          const written = await handle.write(chunk.value, offset, chunk.value.length - offset);
          if (!written.bytesWritten) fail('short disk write');
          offset += written.bytesWritten;
        }
      }
    } finally {
      try {
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally { await handle.close(); }
    }
    const downloaded = { bytes, sha256: sha.digest('hex'), integrity: 'sha512-' + sri.digest('base64') };
    if (bytes !== expected.bytes || downloaded.sha256 !== expected.sha256 || downloaded.integrity !== expected.integrity) fail('published archive bytes conflict with original');
    const inspected = await inspectTarballFile(file, limits, signal);
    if (inspected.manifest.name !== input.package || inspected.manifest.version !== input.version) fail('archive package identity conflict');
    return { ...identity, status: 'readback-only' as const, metadataURL, archiveURL: safeFinalURL(archiveRequest.url),
      metadata: { bytes: metadataBody.bytes, sha256: metadataBody.sha256 }, archive: downloaded,
      inspection: { members: inspected.members, expandedBytes: inspected.expandedBytes }, budgets: limits };
  } finally {
    cancel(archive);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
