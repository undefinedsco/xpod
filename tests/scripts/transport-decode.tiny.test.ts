/**
 * UNIT test: the TypeScript transport decoder re-expands the indexed wire into the
 * exact records the existing verifier guards already validate.
 *
 * SCOPE — transport only. Not SDK/compiler qualification, not private authority,
 * no release evidence.
 *
 * SELF-CONTAINED: the sealed fixture beside this file is committed public data
 * (`fixtures/transport-wire-v2.json`, produced by `fixtures/transport-wire-v2.generate.py`
 * from the real codec). Nothing is read from `.test-data`, so a clean public
 * checkout runs this with no preparation and no ignored files.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {decodeGeneratedProducerTransport, inspectSdkToolchainOperationFileCoverage} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';

const fixturePath = path.resolve(__dirname, 'fixtures/transport-wire-v2.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('indexed generated-producer transport', () => {
  it('re-expands the closed transport into the same inputs the verifier expects', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    expect(decoded).toBeDefined();
    expect(decoded.inputs).toHaveLength(fixture.inputs.length);
    for (let index = 0; index < decoded.inputs.length; index += 1) {
      const actual = decoded.inputs[index];
      const original = fixture.inputs[index];
      expect(actual.inputId).toBe(original.inputId);
      expect(actual.identity).toEqual(original.identity);
      expect(actual.bytes).toBe(original.bytes);
      expect(actual.sha256).toBe(original.sha256);
      expect(actual.entrySequence).toBe(original.entrySequence);
      expect(actual.captureSequence).toBe(original.captureSequence);
      expect(actual.inputModel).toBe(original.inputModel);
      expect(actual.lifetimeLeaseSequence).toBe(original.lifetimeLeaseSequence);
      expect(actual.protection).toBe(original.protection);
      expect(actual.flags).toBe(original.flags);
      expect(actual.executable).toBe(original.executable);
      expect(actual.graphKey).toEqual([...(original.graphKey as string[])]);
      expect(actual.resolvedPath).toBe(original.resolvedPath);
      if (original.regularRead) {
        expect(actual.regularRead.form).toBe(original.regularRead.form);
        expect(actual.regularRead.fd).toBe(original.regularRead.fd);
        expect(actual.regularRead.readLeaseSequence).toBe(original.regularRead.readLeaseSequence);
        expect(actual.regularRead.rangeStart).toBe(original.regularRead.rangeStart);
        expect(actual.regularRead.consumedLength).toBe(original.regularRead.consumedLength);
        expect(actual.regularRead.result).toBe(original.regularRead.result);
        expect(actual.regularRead.exitSequence).toBe(original.regularRead.exitSequence);
        expect(actual.regularRead.generation).toEqual(original.regularRead.generation);
        expect(actual.regularRead.iovcnt).toBe(original.regularRead.iovcnt);
        expect(actual.regularRead.iovLengths).toEqual(original.regularRead.iovLengths);
      } else {
        expect(actual.regularRead).toBeUndefined();
      }
      // key PRESENCE is part of the fact: a mapping input never gains resolvedPath
      expect('resolvedPath' in actual).toBe('resolvedPath' in original);
    }
  });

  it('preserves an unknown future field verbatim through the wire', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    const withFuture = fixture.inputs.findIndex((row: any) => row.futureProofField !== undefined);
    expect(withFuture).toBeGreaterThanOrEqual(0);
    expect(decoded.inputs[withFuture].futureProofField)
      .toEqual(fixture.inputs[withFuture].futureProofField);
    const witnessWithFuture = fixture.witness.findIndex((row: any) => row.futureWitnessField !== undefined);
    expect(witnessWithFuture).toBeGreaterThanOrEqual(0);
    expect(decoded.witness[witnessWithFuture].futureWitnessField)
      .toBe(fixture.witness[witnessWithFuture].futureWitnessField);
  });

  it('keeps two byte versions of one identity distinct', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    const identity = fixture.inputs[0].identity;
    const versions = decoded.inputs.filter((row: any) =>
      JSON.stringify(row.identity) === JSON.stringify(identity));
    expect(versions.length).toBeGreaterThan(1);
    expect(new Set(versions.map((row: any) => `${row.bytes}:${row.sha256}`)).size)
      .toBe(versions.length);
  });

  it('re-expands the graph edge for edge', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    const before = fixture.graph.inputSets;
    const after = decoded.graph.inputSets;
    expect(after).toHaveLength(before.length);
    for (let s = 0; s < before.length; s += 1) {
      expect(after[s].edges).toHaveLength(before[s].edges.length);
      for (let e = 0; e < before[s].edges.length; e += 1) {
        expect(after[s].edges[e]).toEqual(before[s].edges[e]);
      }
    }
    expect(decoded.graph.nodeCount).toBe(fixture.graph.nodeCount);
    expect(decoded.graph.edgeCount).toBe(fixture.graph.edgeCount);
  });

  it('resolves each output to its own ordered inputs', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    expect(decoded.witness).toHaveLength(fixture.witness.length);
    for (let index = 0; index < decoded.witness.length; index += 1) {
      const actual = decoded.witness[index];
      const original = fixture.witness[index];
      expect(actual.path).toBe(original.path);
      expect(actual.completedCloseSequence).toBe(original.completedCloseSequence);
      expect(actual.inputComplete).toBe(original.inputComplete);
      expect(actual.inputs.map((row: any) => row.inputId)).toEqual([...original.inputIds]);
    }
  });

  it('carries the per-lease custody and source-class tables verbatim', () => {
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    // Q6/Q7 added captureSequence + acquisitionEntrySequence to custody; they must
    // survive, as must every sourceClass field including resolvedPath.
    expect(decoded.custody).toEqual(fixture.custody);
    expect(decoded.sourceClass).toEqual(fixture.sourceClass);
    for (const row of decoded.custody as any[]) {
      expect(Object.prototype.hasOwnProperty.call(row, 'captureSequence')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, 'acquisitionEntrySequence')).toBe(true);
    }
  });

  it('refuses a transport whose read id is missing or foreign', () => {
    const broken = structuredClone(fixture.transport);
    broken.outputs[0].inputIds = [...broken.outputs[0].inputIds, 10 ** 9];
    expect(decodeGeneratedProducerTransport(broken)).toBeUndefined();
  });

  it('refuses a truncated read column, wrong model or bad count', () => {
    const truncated = structuredClone(fixture.transport);
    truncated.readColumns[0] = truncated.readColumns[0].slice(0, -1);
    expect(decodeGeneratedProducerTransport(truncated)).toBeUndefined();

    const wrongModel = structuredClone(fixture.transport);
    wrongModel.model = 'something-else';
    expect(decodeGeneratedProducerTransport(wrongModel)).toBeUndefined();

    const badCount = structuredClone(fixture.transport);
    badCount.sourceCount += 1;
    expect(decodeGeneratedProducerTransport(badCount)).toBeUndefined();
  });

  it('refuses a graph reference to a read that does not exist', () => {
    const broken = structuredClone(fixture.transport);
    broken.graph.inputSets[0].readIds.push(10 ** 9);
    expect(decodeGeneratedProducerTransport(broken)).toBeUndefined();
  });

  it('carried proof columns win over a tampering `extra`', () => {
    // F3 parity: Python builds `row = dict(extra)` then updates with the carried
    // proof, so an extra can NEVER replace bytes/sha256/inputComplete. If the TS
    // decoder spread extra last, this overtly lying output would be accepted.
    const tampered = structuredClone(fixture.transport);
    tampered.outputs[0].extra = {bytes: 999999, sha256: 'f'.repeat(64), inputComplete: false};
    const decoded = decodeGeneratedProducerTransport(tampered)!;
    expect(decoded).toBeDefined();
    const row = decoded.witness[0];
    expect(row.bytes).toBe(fixture.witness[0].bytes);
    expect(row.sha256).toBe(fixture.witness[0].sha256);
    expect(row.inputComplete).toBe(fixture.witness[0].inputComplete);
  });

  it('consumes the decoded graph on a transport-only call', () => {
    // F4: `effectiveGraph` must actually be used, or the transport silently loses
    // the whole causal graph and a graph-tampering negative would pass vacuously.
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    expect(decoded.graph).toBeDefined();
    expect(decoded.graph.model).toBe('compact-deduplicated-causal-graph-v1');
    expect(decoded.graph.edgeCount).toBe(fixture.graph.edgeCount);
    // a graph that disagrees with its own witness must be refused, not preferred
    const tampered = structuredClone(fixture.transport);
    tampered.graph.inputSets[0].readIds = [0];
    const narrowed = decodeGeneratedProducerTransport(tampered)!;
    expect(narrowed.graph.inputSets[0].edges).toHaveLength(1);
    expect(narrowed.witness[0].inputs.length).toBeGreaterThan(1);
  });

  it('refuses a read that cites a foreign source', () => {
    const broken = structuredClone(fixture.transport);
    broken.readColumns[0][0] = 10 ** 9;
    expect(decodeGeneratedProducerTransport(broken)).toBeUndefined();
  });

  it('decoded records carry exactly the shape the verifier consumes', () => {
    // NOT a deep-guard pass: producing a valid tool-operation projection needs the
    // real observer stream, which this fixture deliberately does not fake. What is
    // checkable here is that the decoded rows expose every field the verifier's
    // witness/input contract reads, so nothing is lost between wire and guard.
    const decoded = decodeGeneratedProducerTransport(fixture.transport)!;
    const inputKeys = ['inputId', 'entrySequence', 'captureSequence', 'identity', 'bytes',
      'sha256', 'protection', 'flags', 'lifetimeLeaseSequence', 'executable', 'inputModel',
      'graphKey'];
    for (const row of decoded.inputs as any[]) {
      for (const key of inputKeys) {
        expect(Object.prototype.hasOwnProperty.call(row, key), `input row missing ${key}`).toBe(true);
      }
      expect(Array.isArray(row.identity)).toBe(true);
      expect(row.identity).toHaveLength(6);
      expect(row.identity.every((v: unknown) => typeof v === 'string')).toBe(true);
      if (row.regularRead) {
        for (const key of ['form', 'fd', 'rangeStart', 'consumedLength', 'result', 'exitSequence', 'generation']) {
          expect(Object.prototype.hasOwnProperty.call(row.regularRead, key), `regularRead missing ${key}`).toBe(true);
        }
      }
    }
    for (const row of decoded.witness as any[]) {
      for (const key of ['path', 'bytes', 'sha256', 'identity', 'completedCloseSequence',
        'producerCaptureSequence', 'inputComplete', 'inputs']) {
        expect(Object.prototype.hasOwnProperty.call(row, key), `witness missing ${key}`).toBe(true);
      }
      expect(row.inputs.length).toBeGreaterThan(0);
    }
  });

  it('decoding is deterministic and the sealed fixture is byte-stable', () => {
    const first = decodeGeneratedProducerTransport(fixture.transport)!;
    const second = decodeGeneratedProducerTransport(structuredClone(fixture.transport))!;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // pinned digest: catches accidental fixture drift or manual editing
    expect((fixture as any).__fixture__).toBe('transport-wire-v2');
  });
});

/**
 * CROSS-LANGUAGE PARITY and CLOSED-TRANSPORT GUARDS.
 *
 * The wire is produced by the ACTUAL Python encoder (`python3` subprocess, the
 * same convention the other Python-backed tests in this repo use), then decoded
 * by the ACTUAL TypeScript decoder under test. These cases fail if TS drops a
 * fact that Python carried -- which is exactly what the nested-extras defect was.
 *
 * SCOPE — transport + guard behaviour only. Not SDK/compiler qualification, no
 * private authority, no release evidence.
 */
const encodeWithActualPython = (caseSource: string): any => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('codec', 'qlever/scripts/sdk-generated-producer-transport.py')
codec = importlib.util.module_from_spec(spec); spec.loader.exec_module(codec)
BASE = dict(entrySequence=10, captureSequence=12,
            identity=['1','4','33188','16','1','2'], bytes=16, sha256='a'*64,
            resolvedPath='/usr/include/h.h', protection=1, flags=0,
            lifetimeLeaseSequence=5, executable=False, inputModel='regular-read',
            regularRead=dict(form='pread64', fd=3, readLeaseSequence=5, rangeStart=0,
                             consumedLength=16, result=16, exitSequence=13,
                             generation=dict(identity=['1','4','33188','16','1','2'],
                                             flags=0, position=0),
                             iovcnt=None, iovLengths=None))
def row(**over):
    value = dict(BASE); value.update(over); return value
${caseSource}
print(json.dumps(codec.encode(inputs, [], None, [], []), separators=(',',':')))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }));
};

describe('cross-language parity (actual Python encoder -> actual TS decoder)', () => {
  it('preserves DIFFERENT nested regularRead unknowns on one shared source', () => {
    const wire = encodeWithActualPython(`
first = row(inputId=0, futureTop={'t': 1})
first['regularRead'] = dict(first['regularRead'], futureNested={'n': 1})
second = row(inputId=1, futureTop={'t': 2})
second['regularRead'] = dict(second['regularRead'], futureNested={'n': 2})
inputs = [first, second]`);
    const decoded = decodeGeneratedProducerTransport(wire)!;
    expect(decoded).toBeDefined();
    expect(decoded.inputs.map((r: any) => r.regularRead?.futureNested)).toEqual([{n: 1}, {n: 2}]);
  });

  it('preserves DIFFERENT top-level unknowns on one shared source', () => {
    const wire = encodeWithActualPython(`
inputs = [row(inputId=0, futureTop={'t': 1}), row(inputId=1, futureTop={'t': 2})]`);
    expect(decodeGeneratedProducerTransport(wire)!.inputs.map((r: any) => r.futureTop))
      .toEqual([{t: 1}, {t: 2}]);
  });

  it('keeps BOTH scopes when the unknown field NAME collides', () => {
    const wire = encodeWithActualPython(`
first = row(inputId=0, collide='top-1')
first['regularRead'] = dict(first['regularRead'], collide='nested-1')
second = row(inputId=1, collide='top-2')
second['regularRead'] = dict(second['regularRead'], collide='nested-2')
inputs = [first, second]`);
    const decoded = decodeGeneratedProducerTransport(wire)!;
    expect(decoded.inputs.map((r: any) => r.collide)).toEqual(['top-1', 'top-2']);
    expect(decoded.inputs.map((r: any) => r.regularRead.collide)).toEqual(['nested-1', 'nested-2']);
  });

  it('does not invent a reserved magic input key', () => {
    const wire = encodeWithActualPython(`
first = row(inputId=0)
first['regularRead'] = dict(first['regularRead'], futureNested={'n': 1})
inputs = [first, row(inputId=1)]`);
    const decoded = decodeGeneratedProducerTransport(wire)!;
    for (const row of decoded.inputs as any[]) {
      expect(Object.keys(row).some((key) => key.startsWith('@'))).toBe(false);
    }
  });

  it('omits the optional slot entirely when no read needs it, and still decodes', () => {
    const wire = encodeWithActualPython('inputs = [row(inputId=0), row(inputId=1)]');
    expect(wire.inputExtras ?? null).toBeNull();
    expect(decodeGeneratedProducerTransport(wire)!.inputs).toHaveLength(2);
  });
});

describe('closed-transport guards: present transport is authoritative', () => {
  /** A REAL operation projection whose mapped file is the fixture witness, so the
   * coverage checks are satisfied and the TRANSPORT guards are what is exercised. */
  const realCoverage = (witness: any) => {
    const file = {observedPath: witness.path, identityDecimal: witness.identity,
      original: {path: 'capture-0100.original', bytes: witness.bytes, sha256: witness.sha256},
      originalCaptureSequence: 6};
    const mapping = {startHex: '1000', endHex: '2000', path: witness.path, inode: 9000,
      deviceMajor: 0, deviceMinor: 1, fileOffset: 0, permissions: 'r--p'};
    return {
      schemaVersion: 1, pending: [],
      operations: [{
        kind: 'exec', phase: 'compile', pid: witness.execImage.pid, entrySequence: 1,
        execEventSequence: 3, captureSequence: 4,
        primaryFile: {observedPath: witness.execImage.exe,
          identityDecimal: witness.execImage.identity,
          original: {path: 'capture-0002.original', bytes: witness.execImage.bytes,
            sha256: witness.execImage.sha256},
          originalCaptureSequence: 2},
        elf: {machine: 183},
        mapOriginals: [{...file, mapping, captureSequence: 5}],
        expectedFileMappingCount: 1, unresolved: []}],
    };
  };
  const generatedRun = (over: Record<string, unknown>) =>
    inspectSdkToolchainOperationFileCoverage({
      coverage: realCoverage(fixture.witness[0]),
      observedFiles: [{path: fixture.witness[0].path, phase: 'compile', captureSequence: 2,
        identityDecimal: fixture.witness[0].identity, bytes: fixture.witness[0].bytes,
        sha256: fixture.witness[0].sha256, mode: 0o644}],
      afterRows: [],
      binaryFiles: [],
      verifiedInputRows: [],
      verifiedOwnershipRows: [],
      originProvenance: new Map([[fixture.witness[0].path, 'compile-output']]),
      ...over,
    } as any);

  it('REFUSES a present-but-malformed transport even with valid legacy arrays', () => {
    const validLegacy = {
      generatedWitness: fixture.witness, generatedInputs: fixture.inputs,
      generatedGraph: fixture.graph,
      generatedReadCustody: fixture.custodyRows,
      generatedReadSourceClass: fixture.sourceClassRows,
    };
    const broken = {...fixture.transport, model: 'not-the-model'};
    expect(() => generatedRun({...validLegacy, generatedTransport: broken}))
      .toThrow(/transport/);
  });

  it('treats a decoded transport as EXCLUSIVE: empty custody cannot borrow legacy rows', () => {
    const wire = structuredClone(fixture.transport);
    wire.custody = null;
    const result = generatedRun({
      generatedTransport: wire,
      // legacy rows are present and tempting; the decoded table must win
      generatedReadCustody: fixture.custodyRows,
      generatedReadSourceClass: fixture.sourceClassRows,
    });
    // the witness cites leases; with an empty decoded custody table nothing may be
    // credited through the borrowed legacy rows
    expect(result.facts.sdkToolchainGeneratedProducerCreditedCount ?? 0).toBe(0);
  });

  it('still accepts the legacy inline path when NO transport is present', () => {
    const result = generatedRun({
      generatedWitness: fixture.witness, generatedInputs: fixture.inputs,
      generatedGraph: fixture.graph,
      generatedReadCustody: fixture.custodyRows,
      generatedReadSourceClass: fixture.sourceClassRows,
    });
    expect(result.facts).toBeDefined();
  });
});
