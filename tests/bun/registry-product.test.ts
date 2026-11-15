import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { registryReadbackBudget, verifyRegistryProduct, type RegistryProductInput } from '../../scripts/verify-registry-product';

function tar(name = '@example/product', version = '1.2.3', data = Buffer.from(JSON.stringify({ name, version }))) {
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header[156] = 48;
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]));
}
const archive = tar();
const input: RegistryProductInput = { registry: 'https://registry.example/', package: '@example/product', version: '1.2.3', expected: {
  bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
} };
const metadata = (patch = {}) => ({ name: input.package, version: input.version, dist: { integrity: input.expected.integrity, tarball: 'https://cdn.example/product.tgz' }, ...patch });
function fetcher(fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => fn(String(url), init!)) as typeof fetch;
}
const standard = (meta = metadata(), bytes = archive) => fetcher((url) => url.endsWith('.tgz') ? new Response(bytes) : Response.json(meta));

test('exact metadata, streamed bytes and strict tar identity give readback-only authority', async () => {
  const result = await verifyRegistryProduct(input, { fetch: standard() });
  expect(result.status).toBe('readback-only');
  expect(result).toMatchObject({ releaseQualified: false, sourceVerified: false, nativeAdmission: false, legalClearance: false, consumerValidated: false });
  expect('archive' in result && result.archive).toEqual(input.expected);
});

test('metadata 404 is bounded and explicitly not-published-blocked', async () => {
  let cancelled = false;
  const result = await verifyRegistryProduct(input, { fetch: fetcher(() => new Response('missing', { status: 404 })) });
  expect(result.status).toBe('not-published-blocked');
  expect(result.releaseQualified).toBe(false);
  await expect(verifyRegistryProduct(input, { metadataMaxBytes: 4, fetch: fetcher(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; },
  }), { status: 404 })) })).rejects.toThrow('exceeds bound');
  expect(cancelled).toBe(true);
});

test('expected identity and digest inputs reject before any network request', async () => {
  let requests = 0;
  const transport = fetcher(() => { requests++; return new Response(); });
  for (const changed of [
    { ...input, version: 'latest' }, { ...input, version: '^1.2.3' }, { ...input, package: '../product' },
    { ...input, registry: 'http://registry.example/' }, { ...input, registry: 'https://user@registry.example/' },
    { ...input, registry: 'https://registry.example:444/' }, { ...input, registry: 'https://registry.example/?token=x' },
    { ...input, expected: { ...input.expected, bytes: 0 } }, { ...input, expected: { ...input.expected, sha256: 'placeholder' } },
    { ...input, expected: { ...input.expected, integrity: 'sha512-invalid' } },
  ]) await expect(verifyRegistryProduct(changed, { fetch: transport })).rejects.toThrow();
  expect(requests).toBe(0);
});

test('metadata identity, version and SRI conflicts fail before downloading archive', async () => {
  for (const meta of [metadata({ name: 'other' }), metadata({ version: '1.2.4' }), metadata({ dist: { ...metadata().dist, integrity: 'sha512-wrong' } })]) {
    let requests = 0;
    await expect(verifyRegistryProduct(input, { fetch: fetcher(() => { requests++; return Response.json(meta); }) })).rejects.toThrow('conflict');
    expect(requests).toBe(1);
  }
});

test('token follows only the original origin across manual metadata and tar redirects', async () => {
  const calls: Array<{ url: string; token: string | null }> = [];
  const transport = fetcher((url, init) => {
    expect(init.method).toBe('GET'); expect(init.redirect).toBe('manual'); expect(init.signal instanceof AbortSignal).toBe(true);
    calls.push({ url, token: new Headers(init.headers).get('authorization') });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://mirror.example/meta' } });
    if (calls.length === 2) return Response.json(metadata({ dist: { ...metadata().dist, tarball: 'https://registry.example/product.tgz' } }));
    if (calls.length === 3) return new Response(null, { status: 307, headers: { location: 'https://cdn.example/product.tgz' } });
    return new Response(archive);
  });
  expect((await verifyRegistryProduct(input, { fetch: transport, token: 'private-test-token' })).status).toBe('readback-only');
  expect(calls.map(c => c.token)).toEqual(['Bearer private-test-token', null, 'Bearer private-test-token', null]);
});

test('redirect targets and hop count never weaken HTTPS credentials or ports', async () => {
  for (const location of ['http://cdn.example/a', 'https://user:pass@cdn.example/a', 'https://cdn.example:444/a', 'https://cdn.example/a#x', '']) {
    let requests = 0;
    await expect(verifyRegistryProduct(input, { fetch: fetcher(() => { requests++; return new Response(null, { status: 302, headers: { location } }); }) })).rejects.toThrow();
    expect(requests).toBe(1);
  }
  let requests = 0;
  await expect(verifyRegistryProduct(input, { fetch: fetcher(() => { requests++; return new Response(null, { status: 308, headers: { location: '/again' } }); }) })).rejects.toThrow('redirect limit');
  expect(requests).toBe(4);
});

test('bad or mismatched Content-Length is rejected for metadata and tar', async () => {
  for (const length of ['-1', 'oops', '9007199254740993', String(1024 * 1024 + 1), '1']) {
    await expect(verifyRegistryProduct(input, { fetch: fetcher(() => new Response('{}', { headers: { 'content-length': length } })) })).rejects.toThrow('Content-Length');
  }
  await expect(verifyRegistryProduct(input, { fetch: fetcher(url => url.endsWith('.tgz')
    ? new Response(archive, { headers: { 'content-length': String(archive.length + 1) } }) : Response.json(metadata())) })).rejects.toThrow('Content-Length');
});

test('streaming limits apply without Content-Length and same-size byte conflicts fail', async () => {
  await expect(verifyRegistryProduct(input, { metadataMaxBytes: 2, fetch: standard() })).rejects.toThrow('exceeds bound');
  await expect(verifyRegistryProduct(input, { fetch: standard(metadata(), Buffer.alloc(archive.length + 1)) })).rejects.toThrow('exceeds bound');
  await expect(verifyRegistryProduct(input, { fetch: standard(metadata(), Buffer.alloc(archive.length)) })).rejects.toThrow('bytes conflict');
  await expect(verifyRegistryProduct({ ...input, expected: { ...input.expected, sha256: 'f'.repeat(64) } }, { fetch: standard() })).rejects.toThrow('bytes conflict');
  const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  await expect(verifyRegistryProduct({ ...input, expected: { ...input.expected, integrity } }, { fetch: standard(metadata({ dist: { ...metadata().dist, integrity } })) })).rejects.toThrow('bytes conflict');
});

test('hashed tar still needs correct basic package identity', async () => {
  const bytes = tar('foreign-package');
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  await expect(verifyRegistryProduct({ ...input, expected }, { fetch: standard(metadata({ dist: { ...metadata().dist, integrity: expected.integrity } }), bytes) })).rejects.toThrow('archive package identity');
});

test('one deadline bounds stalled transport and stalled streamed bodies', async () => {
  // Keep the tiny test event loop live: AbortSignal.timeout itself is unrefed.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await expect(verifyRegistryProduct(input, { timeoutMs: 20, fetch: fetcher(() => new Promise(() => {})) })).rejects.toThrow();
    await expect(verifyRegistryProduct(input, { timeoutMs: 20, fetch: fetcher(() => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }))) })).rejects.toThrow();
  } finally { clearInterval(keepAlive); }
});

test('empty metadata 404 remains explicitly blocked', async () => {
  const result = await verifyRegistryProduct(input, { fetch: fetcher(() => new Response(null, { status: 404 })) });
  expect(result.status).toBe('not-published-blocked');
});

test('redirect cancellation cannot stall the deadline and final URL omits query credentials', async () => {
  let calls = 0;
  const transport = fetcher(() => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), {
      status: 302, headers: { location: 'https://mirror.example/meta?signature=private' },
    });
    if (calls === 2) return Response.json(metadata({ dist: { ...metadata().dist, tarball: 'https://cdn.example/product.tgz?token=private' } }));
    return new Response(archive);
  });
  const result = await verifyRegistryProduct(input, { fetch: transport, timeoutMs: 100 });
  expect(result).toMatchObject({ status: 'readback-only', metadataURL: 'https://mirror.example/meta', archiveURL: 'https://cdn.example/product.tgz' });
  expect(JSON.stringify(result)).not.toContain('private');
});

async function verifyBytes(bytes: Buffer, limits = {}, chunkSize = 1, identity = input) {
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  return verifyRegistryProduct({ ...identity, expected }, { limits, fetch: fetcher(url => {
    if (!url.endsWith('.tgz')) return Response.json({ name: identity.package, version: identity.version, dist: { ...metadata().dist, integrity: expected.integrity } });
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }));
  }) });
}

test('known API packed size is admitted by budget only, without allocating/downloading it', () => {
  expect(registryReadbackBudget(467665989).packedBytes).toBe(1024 ** 3);
  expect(() => registryReadbackBudget(467665989, { packedBytes: 256 * 1024 ** 2 })).toThrow('packed byte budget');
  expect(() => registryReadbackBudget(1, { expandedBytes: Infinity })).toThrow('invalid resource');
  expect(() => registryReadbackBudget(1, { surprise: 1 } as never)).toThrow('unknown resource budget');
  expect(() => registryReadbackBudget(1, { freeFloorBytes: 1 })).toThrow('invalid resource');
  expect(registryReadbackBudget(1, { freeFloorBytes: 2 * 1024 ** 3 }).freeFloorBytes).toBe(2 * 1024 ** 3);
});

test('one-byte transport chunks and bounded expansion/manifest/member budgets', async () => {
  expect((await verifyBytes(archive)).status).toBe('readback-only');
  await expect(verifyBytes(archive, { expandedBytes: 512 })).rejects.toThrow('expanded byte budget');
  await expect(verifyBytes(archive, { manifestBytes: 1 })).rejects.toThrow('manifest byte budget');
  const raw = gunzipSync(archive);
  const duplicate = gzipSync(Buffer.concat([raw.subarray(0, 1024), raw]));
  await expect(verifyBytes(duplicate, { members: 1 })).rejects.toThrow('member budget');
  await expect(verifyBytes(duplicate)).rejects.toThrow('Duplicate tar entry');
});

test('single streaming parser rejects corrupt gzip, checksum, special members and incomplete/end data', async () => {
  const raw = gunzipSync(archive);
  const checksum = Buffer.from(raw); checksum[0] ^= 1;
  const special = Buffer.from(raw); special[156] = 50; special.fill(32, 148, 156);
  special.write([...special.subarray(0, 512)].reduce((a,b) => a+b,0).toString(8).padStart(6,'0') + '\0 ',148);
  const trailer = Buffer.from(raw); trailer[trailer.length - 1] = 1;
  for (const bytes of [archive.subarray(0, archive.length - 5), gzipSync(checksum), gzipSync(special), gzipSync(raw.subarray(0, 700)), gzipSync(trailer), gzipSync(raw.subarray(0, raw.length - 1))]) {
    await expect(verifyBytes(bytes)).rejects.toThrow();
  }
});

test('shared file inspector rejects invalid budgets and an already aborted deadline before opening a file', async () => {
  const { inspectTarballFile } = createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');
  await expect(inspectTarballFile('/nonexistent', undefined)).rejects.toThrow('Invalid tar inspection budget');
  await expect(inspectTarballFile('/nonexistent', { ...registryReadbackBudget(1), manifestBytes: 16 * 1024 ** 2 + 1 })).rejects.toThrow('Invalid tar inspection budget');
  const controller = new AbortController(); controller.abort(new Error('inspection deadline'));
  const limits = registryReadbackBudget(1);
  await expect(inspectTarballFile('/nonexistent', limits, controller.signal)).rejects.toThrow('inspection deadline');
});

test('stream inspector shares traversal rejection with buffer parser', async () => {
  const raw = gunzipSync(archive);
  raw.fill(0, 0, 100); raw.write('../escape'); raw.fill(32,148,156);
  raw.write([...raw.subarray(0,512)].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0') + '\0 ',148);
  await expect(verifyBytes(gzipSync(raw))).rejects.toThrow('Unsafe tar path traversal');
});

test('16MiB shared manifest budget covers real CSS sized 8MB fixture in split chunks; old 1MiB rejects', async () => {
  // Same scale as retained CSS metadata; portable fixture, no original product dependency.
  const fixture = { name: input.package, version: input.version, xpodModule: { files: [{ path: 'payload', sha256: '0'.repeat(64), padding: '' }] } };
  fixture.xpodModule.files[0].padding = 'x'.repeat(8244019 - Buffer.byteLength(JSON.stringify(fixture)));
  const data = Buffer.from(JSON.stringify(fixture));
  expect(data.length).toBe(8244019);
  const manifest = JSON.parse(data.toString());
  const bytes = tar(manifest.name, manifest.version, data);
  const identity = { ...input, package: manifest.name, version: manifest.version };
  expect((await verifyBytes(bytes, {}, 4093, identity)).status).toBe('readback-only');
  await expect(verifyBytes(bytes, { manifestBytes: 1024 ** 2 }, 4093, identity)).rejects.toThrow('manifest byte budget');
  expect(registryReadbackBudget(1).manifestBytes).toBe(16 * 1024 ** 2);
  expect(() => registryReadbackBudget(1, { manifestBytes: 16 * 1024 ** 2 + 1 })).toThrow('invalid resource budget');
});

test('full CSS sized metadata reaches archive readback while old HTTP bound blocks at one request', async () => {
  const fixture = { name: input.package, version: input.version, xpodModule: { files: [{ path: 'payload', padding: 'x'.repeat(8244019) }] } };
  const data = Buffer.from(JSON.stringify(fixture));
  const bytes = tar(input.package, input.version, data);
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  const full = { ...fixture, dist: { integrity: expected.integrity, tarball: 'https://cdn.example/product.tgz' } };
  let calls = 0;
  const transport = fetcher(url => { calls++; return url.endsWith('.tgz') ? new Response(bytes) : Response.json(full); });
  expect((await verifyRegistryProduct({ ...input, expected }, { fetch: transport })).status).toBe('readback-only');
  expect(calls).toBe(2); calls = 0;
  await expect(verifyRegistryProduct({ ...input, expected }, { fetch: transport, metadataMaxBytes: 1024 ** 2 })).rejects.toThrow('exceeds bound');
  expect(calls).toBe(1);
  await expect(verifyRegistryProduct(input, { fetch: transport, metadataMaxBytes: 16 * 1024 ** 2 + 65537 })).rejects.toThrow('invalid transport limits');
  expect(calls).toBe(1);
  await expect(verifyRegistryProduct(input, { fetch: fetcher(() => new Response('{}', { headers: { 'content-length': String(16 * 1024 ** 2 + 65537) } })) })).rejects.toThrow('Content-Length');
});

test('real mkdir EEXIST cancels acquired archive response and preserves foreign blocker', async () => {
  // chdir is synchronous and restored before this test yields to other tests except its own awaited work.
  const original = process.cwd();
  const directory = await mkdtemp(join(original, '.test-data/registry-fs-failure-'));
  let calls = 0, cancelled = false;
  try {
    await mkdir(join(directory, '.test-data'));
    const blocker = join(directory, '.test-data/registry-readback');
    await writeFile(blocker, 'owned blocker');
    process.chdir(directory);
    await expect(verifyRegistryProduct(input, { fetch: fetcher(url => {
      calls++;
      return url.endsWith('.tgz') ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : Response.json(metadata());
    }) })).rejects.toThrow('EEXIST');
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
    expect(await readFile(blocker, 'utf8')).toBe('owned blocker');
  } finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
});

test('real exclusive open failure cancels unlocked body and removes only its own spool directory', async () => {
  const original = process.cwd(), directory = await mkdtemp(join(original, '.test-data/registry-open-failure-'));
  let cancelled = false, injected = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const actualBody = response.body!;
  Object.defineProperty(response, 'body', { get() {
    if (!injected) {
      injected = true;
      const parent = join(directory, '.test-data/registry-readback');
      const owned = readdirSync(parent).find(name => name.startsWith('readback-'))!;
      writeFileSync(join(parent, owned, 'archive.tgz'), 'exclusive-open blocker');
    }
    return actualBody;
  } });
  try {
    process.chdir(directory);
    await expect(verifyRegistryProduct(input, { fetch: fetcher(url => url.endsWith('.tgz') ? response : Response.json(metadata())) })).rejects.toThrow('EEXIST');
    expect(cancelled).toBe(true);
    expect(actualBody.locked).toBe(false);
    expect(readdirSync(join(directory, '.test-data/registry-readback'))).toEqual([]);
  } finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
});
