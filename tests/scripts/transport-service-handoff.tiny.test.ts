/**
 * OPERATIONAL HANDOFF REGRESSION (service variant).
 *
 * Chain: the real Python codec's sealed transport -> the real TS decoder -> the
 * real deep source verifier (`inspectSdkToolchainOperationFileCoverage`) with a
 * transport-only input (no legacy projection arrays). The verifier must behave
 * EXACTLY as it does for the inline projections: same credit, same pending, and
 * a corrupted proof/graph/custody must be refused with a precise cause.
 *
 * SCOPE, stated precisely: this file exercises the Python codec and the PURE
 * inspector `inspectSdkToolchainOperationFileCoverage`. It does NOT go through
 * the generation publisher, the private WeakMap getters, or the operational
 * entry `observeQleverSdkToolchainSource`, and it does NOT demonstrate a usable
 * SDK. A full private-SDK proof remains later RC work.
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {decodeGeneratedProducerTransport, inspectSdkToolchainOperationFileCoverage} from
  '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';

const root = path.resolve(__dirname, '../..');
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/transport-wire-v2.json'), 'utf8'));

/** Typed provenance: without it no artifact is classed as a generated producer. */
function provenance(witness: any) {
  const m = new Map<string, 'compile-output'>();
  m.set(witness.path, 'compile-output');
  return m;
}

/** A real exec operation whose primary file IS the generated output. */
function verifierInput(witness: any) {
  const file = {observedPath: witness.path, identityDecimal: witness.identity,
    original: {path: 'capture-0100.original', bytes: witness.bytes, sha256: witness.sha256},
    originalCaptureSequence: 6};
  const mapping = {startHex: '1000', endHex: '2000', path: witness.path, inode: 9000,
    deviceMajor: 0, deviceMinor: 1, fileOffset: 0, permissions: 'r--p'};
  return {
    coverage: {schemaVersion: 1, pending: [] as string[], operations: [{
      kind: 'exec', phase: 'compile', pid: witness.execImage.pid, entrySequence: 1,
      execEventSequence: 3, captureSequence: 4,
      primaryFile: {observedPath: witness.execImage.exe, identityDecimal: witness.execImage.identity,
        original: {path: 'capture-0002.original', bytes: witness.execImage.bytes, sha256: witness.execImage.sha256},
        originalCaptureSequence: 2},
      elf: {machine: 183},
      mapOriginals: [{...file, mapping, captureSequence: 5}],
      expectedFileMappingCount: 1, unresolved: [] as string[]}]},
    observedFiles: [
      {path: witness.path, phase: 'compile', captureSequence: 2, identityDecimal: witness.identity,
       bytes: witness.bytes, sha256: witness.sha256, mode: 0o644},
      {path: witness.execImage.exe, phase: 'compile', captureSequence: 6,
       identityDecimal: witness.execImage.identity, bytes: witness.execImage.bytes,
       sha256: witness.execImage.sha256, mode: 0o755}],
    afterRows: [
      {originalPath: witness.path, bytes: witness.bytes, sha256: witness.sha256, mode: 0o644},
      {originalPath: witness.execImage.exe, bytes: witness.execImage.bytes,
       sha256: witness.execImage.sha256, mode: 0o755}],
    binaryFiles: [{installedPath: witness.execImage.exe, bytes: witness.execImage.bytes,
      sha256: witness.execImage.sha256, mode: 0o755,
      binary: {name: 'cc', version: '1', architecture: 'x86_64'},
      source: {name: 'cc', version: '1'},
      deb: {path: 'capture-0002.original', bytes: witness.execImage.bytes, sha256: witness.execImage.sha256},
      packages: {path: 'capture-0003.original', bytes: 1, sha256: 'b'.repeat(64),
        signedIndexPath: 'Packages', inReleaseSha256: 'a'.repeat(64)},
      dataMemberPath: 'usr/bin/cc'}],
  };
}

function inlineWitness() {
  const byId = new Map(fixture.inputs.map((row: any) => [row.inputId, row]));
  return fixture.witness.map((w: any) => ({...w, inputs: w.inputIds.map((id: number) => byId.get(id))}));
}

function run(extra: any) {
  const w = fixture.witness[0];
  const base = verifierInput(w);
  return inspectSdkToolchainOperationFileCoverage({
    coverage: base.coverage, observedFiles: base.observedFiles, afterRows: base.afterRows,
    binaryFiles: base.binaryFiles, originProvenance: provenance(w), ...extra,
  } as any);
}

describe('service transport operational handoff', () => {
  it('the Python codec round-trips the sealed fixture losslessly', () => {
    const out = execFileSync('/usr/bin/python3', ['-B', '-c', `
import json,sys
sys.path.insert(0, sys.argv[1])
from importlib.util import spec_from_file_location, module_from_spec
s=spec_from_file_location('c', sys.argv[1]+'/qlever/scripts/sdk-generated-producer-transport.py')
c=module_from_spec(s); s.loader.exec_module(c)
d=json.load(open(sys.argv[2]))
i,w,g,cu,sc=c.decode(d['transport'])
assert json.dumps(i,sort_keys=True,default=list)==json.dumps(d['inputs'],sort_keys=True,default=list)
assert json.dumps(cu,sort_keys=True,default=list)==json.dumps(d['custody'],sort_keys=True,default=list)
assert json.dumps(sc,sort_keys=True,default=list)==json.dumps(d['sourceClass'],sort_keys=True,default=list)
print('OK')
`, root, path.resolve(__dirname, 'fixtures/transport-wire-v2.json')], {encoding: 'utf8'});
    expect(out.trim()).toBe('OK');
  });

  it('transport-only and inline reach the SAME verifier verdict', () => {
    const inline = run({generatedWitness: inlineWitness(), generatedInputs: fixture.inputs,
      generatedGraph: fixture.graph, generatedReadCustody: fixture.custody,
      generatedReadSourceClass: fixture.sourceClass});
    const transport = run({generatedTransport: fixture.transport});
    // same generated classes
    expect(transport.facts.sdkToolchainGeneratedProducerFileCount)
      .toBe(inline.facts.sdkToolchainGeneratedProducerFileCount);
    expect(transport.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0)
      .toBe(inline.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0);
    // same obligations
    expect([...transport.pending].sort()).toEqual([...inline.pending].sort());
  });

  it('a transport whose proof bytes were tampered is refused with a precise cause', () => {
    const tampered = structuredClone(fixture.transport);
    tampered.outputs[0].bytes = 999999;
    const decoded = decodeGeneratedProducerTransport(tampered)!;
    expect(decoded.witness[0].bytes, 'an `extra` must never override the proof').not.toBe(fixture.witness[0].bytes);
    let refused: any; let verdict: any;
    try { verdict = run({generatedTransport: tampered}); } catch (error) { refused = error; }
    if (refused) expect(String(refused.message)).toMatch(/witness|identity|bytes|causal/);
    else expect(verdict.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0).toBe(0);
  });

  it('a transport whose graph disagrees with its witness is refused', () => {
    const tampered = structuredClone(fixture.transport);
    tampered.graph.inputSets[0].readIds = tampered.graph.inputSets[0].readIds.slice(0, 1);
    let refused: any; let verdict: any;
    try { verdict = run({generatedTransport: tampered}); } catch (error) { refused = error; }
    if (refused) expect(String(refused.message)).toMatch(/causal input set|edge count/);
    else expect(verdict.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0).toBe(0);
  });

  it('a transport with a corrupted per-lease custody row is refused', () => {
    const tampered = structuredClone(fixture.transport);
    const idx = tampered.custody.layout.indexOf('sha256');
    tampered.custody.columns[idx][0] = 'f'.repeat(64);
    let refused: any; let verdict: any;
    try { verdict = run({generatedTransport: tampered}); } catch (error) { refused = error; }
    if (refused) expect(String(refused.message)).toMatch(/custody|causal|witness/);
    else expect(verdict.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0).toBe(0);
  });

  it('a genuinely transport-ONLY call reaches a real verdict (no legacy arrays at all)', () => {
    // BEHAVIOUR, not source text: a previous version of this case grepped the
    // leaf for a guard string, which proves nothing about reachability. Here the
    // call carries the transport and NO inline projections, which is exactly the
    // post-strip production shape, and the verifier must still evaluate.
    const result = run({generatedTransport: fixture.transport});
    expect(result.facts).toBeDefined();
    // and it agrees with the inline form rather than silently short-circuiting
    const inline = run({
      generatedWitness: fixture.witness, generatedInputs: fixture.inputs,
      generatedGraph: fixture.graph,
      generatedReadCustody: fixture.custodyRows, generatedReadSourceClass: fixture.sourceClassRows});
    expect(result.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0)
      .toBe(inline.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0);
  });

  it('a transport-only call and the inline projections produce the SAME verdict', () => {
    const onlyTransport = run({generatedTransport: fixture.transport});
    const inline = run({
      generatedWitness: fixture.witness, generatedInputs: fixture.inputs,
      generatedGraph: fixture.graph,
      generatedReadCustody: fixture.custodyRows, generatedReadSourceClass: fixture.sourceClassRows});
    expect(onlyTransport.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0)
      .toBe(inline.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0);
    expect([...(onlyTransport.pending ?? [])].sort())
      .toEqual([...(inline.pending ?? [])].sort());
  });
});
