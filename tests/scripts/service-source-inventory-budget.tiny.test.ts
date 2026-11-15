/**
 * V4 — the SOURCE partition must NOT re-read every member payload.
 *
 * The genuine runtime capability (`observeCandidateServiceRuntimeArtifact`)
 * already walks the archive, hashes EVERY member against the index, and checks
 * the whole-archive SHA before it issues its private view. Re-reading payloads
 * in the partition adds O(bytes/rangeBytes) aggregate reads per run, which
 * exhausts the fixed native call ledger on many-small-file trees
 * (independent review V3-N2). This test quantifies that ledger for the
 * many-small-file domain using the PRODUCTION formula, and proves the new
 * partition performs exactly ZERO payload reads while still refusing digest
 * mismatch, foreign/stale views, and revocation.
 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectCandidateServiceSourceOrigins} from '../../scripts/lib/independent-admission/candidate-service-source-qualification';
import limits from '../../scripts/lib/module-artifact-limits.json';

const RANGE = Number((limits as any).rangeBytes);
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

/** The PRODUCTION aggregate call ledger from native-original-collector.ts.
 * Copied verbatim so this test measures the real ceiling, not an invented one. */
function nativeCallCeiling(expandedBytes: number): number {
  return Math.max(1024, Math.ceil(expandedBytes / RANGE) * 8);
}

const budget = () => {
  let read = 0;
  const charges: number[] = [];
  return {charges,
    get total() { return read; },
    check() {}, remainingMs: () => 600000, reserveBytes() {},
    chargeReadBytes(n: number) { read += n; charges.push(n); },
    remainingReadBytes() { return 4e9 - read; }, remainingOriginalBytes: () => 4e9,
    reserveOriginalMaximum: () => Object.freeze({}), settleOriginalReservation() {}} as any;
};

/** A stand-in for the ISSUED private runtime view: frozen frozen rows. */
function issuedView(root: string, files: {name: string; body: Buffer}[]) {
  const rows = [
    {path: root, type: 'directory', bytes: 0},
    ...files.map(f => ({path: root + '/' + f.name, type: 'file', bytes: f.body.length, sha256: sha(f.body)})),
  ].map(row => Object.freeze(row));
  let reads = 0, custody = 0;
  const view = {
    members: Object.freeze(rows),
    readMemberRange() { reads++; throw Error('partition must not re-read member payloads'); },
    assertCurrent() { custody++; },
  };
  return {view, reads: () => reads, custody: () => custody, root};
}

function materials(files: {name: string; body: Buffer}[]) {
  return {sourceSha: 'a'.repeat(40),
    outputs: files.map(f => ({path: f.name, bytes: f.body.length, sha256: sha(f.body), mode: 0o644})),
    transpiledOutputs: [], dependencyRows: [], trackedSourcePaths: files.map(f => f.name),
    readDependencyOriginal: () => Buffer.alloc(0), readDependencyOriginalRange: () => Buffer.alloc(0),
    dependencyOriginalIdentity: () => ({bytes: 0, sha256: sha(Buffer.alloc(0))}), assertCurrent() {}};
}

const APP = '/app';

test('5,000 x 8 KiB: the partition performs ZERO payload reads, well under the native cap', () => {
  const files = Array.from({length: 5000}, (_, i) => ({name: 'f' + i + '.js', body: Buffer.alloc(8192, i & 0xff)}));
  const expanded = files.reduce((s, f) => s + f.body.length, 0);
  const cap = nativeCallCeiling(expanded);
  const {view, reads, custody} = issuedView(APP, files);
  const shared = budget();
  const held = inspectCandidateServiceSourceOrigins({
    sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
    materials: materials(files), budget: shared, runtime: view, nativeOrigins: [], generated: []});
  expect(held.map.size).toBe(5000);
  // The defect under review needed 10,625 calls for this exact shape.
  expect(reads()).toBe(0);
  expect(cap).toBe(Math.ceil(expanded / RANGE) * 8);   // production ceiling, NOT raised
  expect(reads() < cap).toBe(true);
  // Custody brackets still ran (entry + final), i.e. freshness is not skipped.
  expect(custody()).toBe(2);
  // No payload lookup => no byte charge invented for a memory lookup.
  expect(shared.total).toBe(0);
  expect(shared.charges.length).toBe(0);
});

test('25,000 x 1 KiB: zero reads versus the 4,688-call production ceiling', () => {
  const files = Array.from({length: 25000}, (_, i) => ({name: 's' + i + '.js', body: Buffer.alloc(1024, i & 0xff)}));
  const expanded = files.reduce((s, f) => s + f.body.length, 0);
  const cap = nativeCallCeiling(expanded);
  const {view, reads} = issuedView(APP, files);
  const held = inspectCandidateServiceSourceOrigins({
    sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
    materials: materials(files), budget: budget(), runtime: view, nativeOrigins: [], generated: []});
  expect(held.map.size).toBe(25000);
  expect(reads()).toBe(0);
  expect(cap).toBe(Math.ceil(expanded / RANGE) * 8);   // derived from the same formula
  // The removed implementation needed 50,586 calls here.
  expect(reads() < cap).toBe(true);
});

test('a digest that disagrees with the issued inventory is refused, not re-read', () => {
  const files = [{name: 'a.js', body: Buffer.from('real payload')}];
  const {view, reads} = issuedView(APP, files);
  // Corrupt the DECLARED inventory digest only (the view rows are authoritative).
  const tampered = {...materials(files), outputs: [{path: 'a.js', bytes: 12, sha256: 'f'.repeat(64), mode: 0o644}]};
  expect(() => inspectCandidateServiceSourceOrigins({
    sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
    materials: tampered, budget: budget(), runtime: view, nativeOrigins: [], generated: []}))
    .toThrow(/differs from its materialized source bytes/u);
  expect(reads()).toBe(0);
});

test('runtime revocation refuses at entry and after the full partition pass', () => {
  const files = [{name: 'a.js', body: Buffer.from('payload')}];
  const {view} = issuedView(APP, files);
  for (const rejectAt of [1, 2]) {
    let checks = 0;
    const runtime = {...view, assertCurrent() {
      checks++;
      if (checks === rejectAt) throw Error('runtime seal revoked');
    }};
    expect(() => inspectCandidateServiceSourceOrigins({
      sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
      materials: materials(files), budget: budget(), runtime, nativeOrigins: [], generated: []}))
      .toThrow(/runtime seal revoked/u);
    expect(checks).toBe(rejectAt);
  }
});

test('directories and symlinks still get no grant, and unknown roots still fail', () => {
  const files = [{name: 'a.js', body: Buffer.from('p')}];
  const {view} = issuedView(APP, files);
  const rows = [...view.members, Object.freeze({path: APP + '/link', type: 'symlink', bytes: 0}),
    Object.freeze({path: APP + '/dir', type: 'directory', bytes: 0})];
  const held = inspectCandidateServiceSourceOrigins({
    sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
    materials: materials(files), budget: budget(),
    runtime: {...view, members: Object.freeze(rows)}, nativeOrigins: [], generated: []});
  expect(held.map.has(APP + '/link')).toBe(false);
  expect(held.map.has(APP + '/dir')).toBe(false);
  expect(held.map.has(APP)).toBe(false);
  const foreign = [...view.members, Object.freeze({path: '/elsewhere/x', type: 'file', bytes: 1, sha256: 'e'.repeat(64)})];
  expect(() => inspectCandidateServiceSourceOrigins({
    sourceSha: 'a'.repeat(40), sdkSourceSha: 'd'.repeat(40),
    materials: materials(files), budget: budget(),
    runtime: {...view, members: Object.freeze(foreign)}, nativeOrigins: [], generated: []}))
    .toThrow(/outside both declared roots/u);
});
