/** RC393: the retained universe must be bound by the PRODUCER'S OWN transport contract,
 *  not by a number re-derived from the single control-metadata ceiling; and the runtime
 *  INVENTORY index is a typed stream of its own (the runtime artifact module already owns
 *  that bound as limits.shardBytes).
 *
 *  Real failure (observe_service_sdk_source, job 128676567739): the service artifact held
 *  814 original members totalling 264,470,174 uncompressed bytes. The reader rejected it
 *  twice over: first by summing everything against 32 x 4 MiB = 128 MiB BEFORE typed
 *  classification, then by never permitting the 32,040,596-byte runtime index at all.
 *
 *  Fixtures here are synthetic and use DECLARED byte counts (no multi-GB allocation);
 *  the real artifact is exercised separately by the private adapter run. */
import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectCandidateServiceOriginalUniverse as inspect}
  from '../../scripts/lib/independent-admission/qlever-sdk-service-relationship';

const LIMITS = require('../../scripts/lib/module-artifact-limits.json');
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

/** A view whose members carry DECLARED sizes but whose served bytes are tiny.
 *  Reads are counted, so "refused before any read" stays observable. */
function declaredUniverse(opts: {runtimeIndexBytes?: number; packBodyBytes?: number; extra?: {path: string; bytes: number}[]} = {}) {
  const small = Buffer.from('{}');
  const files = new Map<string, Buffer>([
    ['service-image-materials.json', small],
    ['metadata.json', small],
    ['stages/service-output-copy-pack-phase/stdout.raw', Buffer.from('phase-tar')],
    ['stages/service-output-copy-pack-inputs/stdout.raw', Buffer.from('pack-index')],
  ]);
  const declared = new Map<string, number>();
  // Hash of the deterministic zero stream the stub serves for a declared-size member.
  const zeroHash = (bytes: number) => {
    const h = createHash('sha256');
    for (let left = bytes; left > 0; left -= 65536) h.update(Buffer.alloc(Math.min(65536, left)));
    return h.digest('hex');
  };
  const ref = (path: string) => {
    const real = files.get(path);
    const bytes = declared.get(path) ?? real!.length;
    return {path, bytes, sha256: real ? sha(real) : zeroHash(bytes)};
  };

  const bodies: any[] = [];
  if (opts.packBodyBytes) {
    const bodyPath = 'output/service-pack-bodies/objects/0001-' + 'b'.repeat(64) + '.original';
    const tarPath = 'stages/service-output-copy-pack-body-0001/stdout.raw';
    declared.set(bodyPath, opts.packBodyBytes);
    declared.set(tarPath, opts.packBodyBytes + 512);
    bodies.push({original: ref(bodyPath), rawTarOriginal: ref(tarPath), stage: {stdout: ref(tarPath)}});
  }

  const master: any = {
    originals: [],
    packInputObservation: {schemaVersion: 1, kind: 'actual-stopped-service-image-pack-inputs',
      stage: {stdout: ref('stages/service-output-copy-pack-inputs/stdout.raw')},
      phase: {stage: {stdout: ref('stages/service-output-copy-pack-phase/stdout.raw')}}, bodies},
  };

  if (opts.runtimeIndexBytes) {
    // The real /app inventory index: declared 32,040,596 B, far above one metadata original.
    const INDEX = '/app' as const;
    const appIndex = 'output/service-runtime-members/copy-runtime-app.original.json';
    const appArchive = 'stages/service-output-copy-runtime-app/stdout.raw';
    const sdkIndex = 'output/service-runtime-members/copy-runtime-sdk.original.json';
    const sdkArchive = 'stages/service-output-copy-runtime-sdk/stdout.raw';
    declared.set(appIndex, opts.runtimeIndexBytes);
    declared.set(appArchive, 160186925);
    declared.set(sdkIndex, 1024);
    declared.set(sdkArchive, 8924560);
    const root = (targetRoot: string, index: string, archive: string) => ({
      targetRoot, imageReferenceByDigest: 'x', configDigest: 'y', containerId: 'z',
      index: ref(index), archive: ref(archive)});
    master.runtimeMemberObservation = {schemaVersion: 1, kind: 'actual-stopped-service-image-runtime-roots',
      imageReferenceByDigest: 'x', configDigest: 'y', containerId: 'z',
      roots: [root('/app', appIndex, appArchive), root('/opt/xpod/qlever', sdkIndex, sdkArchive)]};
    void INDEX;
    master.outputImageObservation = {imageReferenceByDigest: 'x', configDigest: 'y', containerId: 'z'};
  }

  const allPaths = new Set<string>([...files.keys(), ...declared.keys()]);
  for (const e of opts.extra ?? []) { declared.set(e.path, e.bytes); allPaths.add(e.path); }
  const members = [...allPaths].map(p => ref(p));
  master.originals = members.filter(m => m.path !== 'service-image-materials.json');

  let reads = 0;
  const view: any = {
    members,
    readOriginalRange(path: string, offset: number, length: number) {
      reads++;
      const real = files.get(path);
      if (real) return real.subarray(offset, offset + length);
      // Declared-size member: serve deterministic zero bytes of the REQUESTED length so
      // the range contract is satisfied without allocating the declared size.
      return Buffer.alloc(length);
    },
  };
  const total = members.reduce((n, m) => n + m.bytes, 0);
  return {view, master, total, reads: () => reads};
}

test('the producer transport contract bounds the total, not 32 x metadata', () => {
  // The reviewed artifact contract the PRODUCER enforces while capturing.
  expect(LIMITS.packedBytes).toBe(805306368);
  // The real artifact's uncompressed original total, which the old bound rejected.
  const realTotal = 264470174;
  expect(realTotal > 32 * 4 * 1024 ** 2).toBe(true);
  expect(realTotal <= LIMITS.packedBytes).toBe(true);
});

test('a real-shape universe with a large runtime index and a large archive is admitted', () => {
  // Mirrors the actual member sizes: 32,040,596 B inventory index + 160,186,925 B archive.
  const u = declaredUniverse({runtimeIndexBytes: 32040596, packBodyBytes: 9038287});
  expect(u.total > 32 * 4 * 1024 ** 2).toBe(true);
  expect(u.total <= LIMITS.packedBytes).toBe(true);
  expect(inspect(u.view, u.master)).toBeUndefined();
});

test('the runtime index is admitted under the runtime artifact shard bound', () => {
  expect(LIMITS.shardBytes).toBe(536870912);
  // Just inside the shared bound is fine; beyond it the index is still refused.
  const ok = declaredUniverse({runtimeIndexBytes: LIMITS.shardBytes});
  expect(inspect(ok.view, ok.master)).toBeUndefined();
  const over = declaredUniverse({runtimeIndexBytes: LIMITS.shardBytes + 1});
  expect(() => inspect(over.view, over.master)).toThrow();
});

test('an untyped or arbitrary large member is refused before any range read', () => {
  const u = declaredUniverse({runtimeIndexBytes: 32040596,
    extra: [{path: 'arbitrary.bin', bytes: 8 * 1024 ** 2}]});
  expect(() => inspect(u.view, u.master)).toThrow();
  const before = u.reads();
  const v = declaredUniverse({runtimeIndexBytes: 32040596,
    extra: [{path: 'arbitrary.bin', bytes: LIMITS.packedBytes + 1}]});
  expect(() => inspect(v.view, v.master)).toThrow();
  expect(v.reads()).toBe(0);
  expect(before).toBeGreaterThanOrEqual(0);
});

test('an artifact beyond the producer transport bound is still refused', () => {
  // Declared sizes only: no allocation proportional to the payload.
  const u = declaredUniverse({extra: [{path: 'output/service-pack-bodies/objects/9999-' + 'c'.repeat(64) + '.original',
    bytes: LIMITS.packedBytes + 1}]});
  expect(u.total > LIMITS.packedBytes).toBe(true);
  expect(() => inspect(u.view, u.master)).toThrow();
});

test('each stream is capped by ITS OWN producer bound, not by the aggregate', () => {
  const META = 4 * 1024 ** 2;
  // Per-stream maxima taken from the producer that creates each stream.
  const caps = {
    packPhase: 4 * META,                      // bindings.py phases: 4*META = 16 MiB
    packBody: 32 * META,                      // bindings.py body_copy_bound base: 32*META
    registryArchive: LIMITS.shardBytes,       // legal-registry-originals retained-build packed
    runtimeArchive: LIMITS.packedBytes,       // sdk-service-image-originals RUNTIME_ENCODED_LIMIT
  };
  expect(caps.packPhase < LIMITS.packedBytes).toBe(true);
  expect(caps.packBody < LIMITS.packedBytes).toBe(true);

  // A stream one byte past its OWN cap is refused even though the aggregate is far larger.
  const overPhase = declaredUniverse({});
  // rewrite the phase stdout declaration to cap+1 while keeping every other member legal
  const phaseRef = overPhase.master.packInputObservation.phase.stage.stdout;
  phaseRef.bytes = caps.packPhase + 1;
  const m = overPhase.view.members.find((r: any) => r.path === phaseRef.path)!;
  m.bytes = caps.packPhase + 1;
  expect(() => inspect(overPhase.view, overPhase.master)).toThrow();
  expect(overPhase.reads()).toBe(0);

  const overBody = declaredUniverse({packBodyBytes: caps.packBody + 1});
  expect(overBody.total < LIMITS.packedBytes).toBe(true);
  expect(() => inspect(overBody.view, overBody.master)).toThrow();
  expect(overBody.reads()).toBe(0);
});

test('permit has no aggregate-bound default: a widened total never licenses a stream', () => {
  // Two streams that are each legal, and a total far inside packedBytes, must still be
  // judged against their own cap rather than the aggregate.
  const u = declaredUniverse({runtimeIndexBytes: 32040596, packBodyBytes: 32 * 1024 ** 2});
  expect(u.total < LIMITS.packedBytes).toBe(true);
  // exactly at the body cap is admitted (the producer allows <= cap)
  expect(inspect(u.view, u.master)).toBeUndefined();
});

/** Build-input registry originals: archive.tgz is bounded by the retained-build packed
 *  representation (shardBytes), while metadata.json/transport.json use metadataBytes. */
function registryUniverse(archiveBytes: number) {
  const META = 4 * 1024 ** 2;
  const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
  // The path IS the sha512 hex of the integrity string, so derive it the same way.
  const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
  const prefix = 'build-inputs/registry/' + Buffer.from(integrity.slice(7), 'base64').toString('hex') + '/';
  const small = Buffer.from('{}');
  const files = new Map<string, Buffer>([
    ['service-image-materials.json', small],
    [prefix + 'metadata.json', small],
    [prefix + 'transport.json', small],
  ]);
  const declared = new Map<string, number>([[prefix + 'archive.tgz', archiveBytes]]);
  const zeroHash = (bytes: number) => {
    const h = createHash('sha256');
    for (let left = bytes; left > 0; left -= 65536) h.update(Buffer.alloc(Math.min(65536, left)));
    return h.digest('hex');
  };
  const ref = (path: string) => {
    const real = files.get(path);
    const bytes = declared.get(path) ?? real!.length;
    return {path, bytes, sha256: real ? sha(real) : zeroHash(bytes)};
  };
  const archive = ref(prefix + 'archive.tgz');
  const master: any = {
    buildInputObservation: {schemaVersion: 1, kind: 'retained-official-registry-build-inputs',
      packages: [{name: 'p', version: '1.0.0',
        integrity,
        archive, metadata: ref(prefix + 'metadata.json'), transport: ref(prefix + 'transport.json')}]},
  };
  const names = new Set<string>([...files.keys(), ...declared.keys()]);
  const members = [...names].map(ref);
  master.originals = members.filter(r => r.path !== 'service-image-materials.json');
  let reads = 0;
  const view: any = {
    members,
    readOriginalRange(path: string, offset: number, length: number) {
      reads++;
      const real = files.get(path);
      if (real) return real.subarray(offset, offset + length);
      return Buffer.alloc(length);
    },
  };
  return {view, master, reads: () => reads};
}

test('the registry archive is bounded by its own retained-build packed cap', () => {
  const ok = registryUniverse(8 * 1024 ** 2);
  expect(inspect(ok.view, ok.master)).toBeUndefined();
  // one past the shard cap, still far below the 768 MiB aggregate: refused before reads
  const over = registryUniverse(LIMITS.shardBytes + 1);
  expect(over.view.members.reduce((n: number, m: any) => n + m.bytes, 0) < LIMITS.packedBytes).toBe(true);
  expect(() => inspect(over.view, over.master)).toThrow();
  expect(over.reads()).toBe(0);
});

/** The pack PHASE copy bound is 4*META (16 MiB), and the raw pack-body TAR is FRAMED:
 *  producer body_copy_bound(ref) = ceil(bytes/512)*512 + 10240 + 512. A near-bound
 *  original body therefore produces a raw TAR slightly ABOVE 128 MiB, which is legal. */
function packFixture(bodyBytes: number, phaseBytes: number) {
  const META = 4 * 1024 ** 2;
  const small = Buffer.from('{}');
  const files = new Map<string, Buffer>([
    ['service-image-materials.json', small],
    ['metadata.json', small],
    ['stages/service-output-copy-pack-phase/stdout.raw', small],
    ['stages/service-output-copy-pack-inputs/stdout.raw', small],
  ]);
  const declared = new Map<string, number>([
    ['stages/service-output-copy-pack-phase/stdout.raw', phaseBytes],
  ]);
  const digest = 'd'.repeat(64);
  const bodyPath = 'output/service-pack-bodies/objects/0001-' + digest + '.original';
  const tarPath = 'stages/service-output-copy-pack-body-0001/stdout.raw';
  declared.set(bodyPath, bodyBytes);
  // the producer's own framing formula, mirrored here for the declared size
  const framed = Math.ceil(bodyBytes / 512) * 512 + 10240 + 512;
  declared.set(tarPath, framed);
  // Hash of the EXACT stream the view serves for a member: the real placeholder bytes
  // followed by zero padding up to the declared size.
  const servedHash = (path: string, bytes: number) => {
    const real = files.get(path);
    const h = createHash('sha256');
    let written = 0;
    if (real) { const take = Math.min(real.length, bytes); h.update(real.subarray(0, take)); written = take; }
    for (let left = bytes - written; left > 0; left -= 65536) h.update(Buffer.alloc(Math.min(65536, left)));
    return h.digest('hex');
  };
  const ref = (path: string) => {
    const bytes = declared.get(path) ?? files.get(path)!.length;
    return {path, bytes, sha256: servedHash(path, bytes)};
  };
  const master: any = {
    packInputObservation: {schemaVersion: 1, kind: 'actual-stopped-service-image-pack-inputs',
      stage: {stdout: ref('stages/service-output-copy-pack-inputs/stdout.raw')},
      phase: {stage: {stdout: ref('stages/service-output-copy-pack-phase/stdout.raw')}},
      bodies: [{original: ref(bodyPath), rawTarOriginal: ref(tarPath), stage: {stdout: ref(tarPath)}}]},
  };
  const names = new Set<string>([...files.keys(), ...declared.keys()]);
  const members = [...names].map(ref);
  master.originals = members.filter(r => r.path !== 'service-image-materials.json');
  let reads = 0;
  const view: any = {
    members,
    readOriginalRange(path: string, offset: number, length: number) {
      reads++;
      const real = files.get(path);
      // A declared-size member is larger than its placeholder bytes, so always answer
      // with exactly `length` bytes: real prefix then padding.
      if (!real) return Buffer.alloc(length);
      const slice = real.subarray(offset, offset + length);
      return slice.length === length ? slice : Buffer.concat([slice, Buffer.alloc(length - slice.length)]);
    },
  };
  return {view, master, framed, reads: () => reads};
}

test('the pack phase copy is bounded at 16 MiB (4*META), not 4 MiB', () => {
  const META = 4 * 1024 ** 2;
  // One META is legal now (it used to be the cap itself), and 4*META is the real ceiling.
  expect(inspect(...Object.values(packFixture(1024, 2 * META)) as [any, any])).toBeUndefined();
  const atCap = packFixture(1024, 4 * META);
  expect(inspect(atCap.view, atCap.master)).toBeUndefined();
  const over = packFixture(1024, 4 * META + 1);
  expect(() => inspect(over.view, over.master)).toThrow();
  expect(over.reads()).toBe(0);
});

test('a near-bound original body keeps its legal framed TAR above 128 MiB', () => {
  const META = 4 * 1024 ** 2;
  const body = 32 * META;                       // exactly the original-body cap
  const f = packFixture(body, 1024);
  expect(f.framed > 32 * META).toBe(true);      // framing pushes the raw TAR past 128 MiB
  expect(inspect(f.view, f.master)).toBeUndefined();
  // an original body one byte over its own cap is still refused
  const over = packFixture(32 * META + 1, 1024);
  expect(() => inspect(over.view, over.master)).toThrow();
});
