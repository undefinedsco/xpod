import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { collectedRuntimeMembers } from '../../scripts/lib/independent-admission/runtime-member-input';
import { inspectRuntimeGraph, verifyCollectedRuntimeClosure } from '../../scripts/lib/independent-admission/runtime-closure';
import type { CollectedArtifactView } from '../../scripts/lib/independent-admission/artifact-contract';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Byte-reader fixture exercises a structural adapter. It issues no private
 * artifact, source, origin or admission capability. */
function input(contents: Record<string, Buffer>) {
  const reads: string[] = [];
  const view: CollectedArtifactView = { identity: { sourceSha: 'a'.repeat(40), package: 'fixture', version: '1.0.0', archiveSha256: 'b'.repeat(64), integrity: 'sha512-fixture', archiveBytes: 1 },
    members: Object.entries(contents).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes), mode: 0o644 })), producerOriginals: [],
    readMember(name, maximum) { reads.push(name); const bytes = contents[name]; if (!bytes || bytes.length > maximum) throw Error('fixture bound'); return Buffer.from(bytes); },
    readProducerOriginal() { throw Error('not an issuer'); } };
  return { view, reads };
}
test('collected byte adapter reads large canonical manifest and requested JS without touching unused provenance', () => {
  const manifest = Buffer.from(JSON.stringify({ name: 'fixture', version: '1.0.0', inventory: 'x'.repeat(8 * 1024 ** 2 + 128) }));
  const f = input({ 'package.json': manifest, 'index.mjs': Buffer.from('throw Error("candidate must not execute");'),
    'provenance/large.tar': Buffer.from('untouched original') });
  const members = collectedRuntimeMembers(f.view);
  expect(f.reads.length).toBe(0);
  expect(JSON.parse(members[0].content.toString()).name).toBe('fixture');
  expect(members[1].content.toString()).toContain('must not execute');
  expect(f.reads).toEqual(['package.json', 'index.mjs']);
});
test('actual requested member tampering fails its byte identity check', () => {
  const f = input({ 'package.json': Buffer.from('{"name":"fixture","version":"1.0.0"}'), 'index.mjs': Buffer.from('export {};') });
  f.view.readMember = () => Buffer.from('tampered');
  expect(() => collectedRuntimeMembers(f.view)[1].content).toThrow('original digest mismatch');
});
test('native format scans use real bound header bytes without loading a large executable as JS', () => {
  const f = input({ 'package.json': Buffer.from('{"name":"fixture","version":"1.0.0"}') });
  const header = Buffer.alloc(64); header.write('ELF', 1); header[0] = 127; header[4] = 2; header[5] = 1; header[6] = 1;
  header.writeUInt16LE(2, 16); header.writeUInt16LE(62, 18); header.writeUInt32LE(1, 20); header.writeUInt16LE(64, 52);
  (f.view.members as any[]).push({ path: 'qlever', bytes: 256 * 1024 ** 2, sha256: 'c'.repeat(64), mode: 0o755 });
  const ranges: number[] = [];
  f.view.readBoundMemberRange = (name, offset, length) => { expect(name).toBe('qlever'); expect(offset).toBe(0); ranges.push(length); return header.subarray(0, length); };
  const members = collectedRuntimeMembers(f.view);
  const result = inspectRuntimeGraph(members, 'linux-x64');
  expect(result.nativeMembers).toEqual(['package/qlever']);
  expect(f.reads).toEqual(['package.json']); expect(ranges).toEqual([2, 64]);
  inspectRuntimeGraph(members, 'linux-x64');
  expect(ranges).toEqual([2, 64]); // Node/Bun share this one immutable observation, not a second header reservation.
  header.writeUInt16LE(183, 18);
  expect(() => inspectRuntimeGraph(collectedRuntimeMembers(f.view), 'linux-x64')).toThrow('format/target mismatch');
});
test('file/directory collisions and over-budget scripts fail before arbitrary reads', () => {
  const collision = input({ 'package.json': Buffer.from('{}'), 'node_modules/a': Buffer.from('x'), 'node_modules/a/index.mjs': Buffer.from('x') });
  expect(() => collectedRuntimeMembers(collision.view)).toThrow('file/directory conflict');
  const f = input({ 'package.json': Buffer.from('{}') });
  (f.view.members as any[]).push({ path: 'huge.mjs', bytes: 17 * 1024 ** 2, sha256: 'd'.repeat(64), mode: 0o644 });
  expect(() => collectedRuntimeMembers(f.view)[1].content).toThrow('bounded-runtime-member-reader-required:huge.mjs');
  expect(f.reads.length).toBe(0);
});
test('serialized source/producer/consumer claims cannot enter operational collected runtime analysis', () => {
  let invoked = false;
  const result = verifyCollectedRuntimeClosure({ allProfilesVerified: true, nativeAccepted: true }, {
    sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40), package: 'fixture', version: '1.0.0',
    collectedArtifact: { members: [], verified: true }, derivedSource: { verified: true }, consumerObservation: { allProfilesVerified: true },
    readOriginal() { invoked = true; throw Error('must not execute'); }, readTracked() { invoked = true; throw Error('must not execute'); },
  });
  expect(result.pending).toEqual(['controlled-runtime-publication-materials-required']);
  expect(result.facts.runtimeClosureVerified).toBe(false); expect(invoked).toBe(false);
});
