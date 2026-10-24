import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {candidateServiceSdkInputContributions, inspectSdkGeneratedInputContributions} from '../../scripts/lib/independent-admission/candidate-service-sdk-input-contributions';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const row = (path: string, value: string, mode = 0o644, captures = 1) => ({path, bytes: value.length, sha256: sha(value), mode, captures});
const snapshotRow = (observedPath: string, value: string, mode: number) => ({observedPath, identity: [1, 2, 0o100000 | mode, value.length, 5, 6], original: {path: 'capture-0000.original', bytes: value.length, sha256: sha(value)}});
const binaryRow = (installedPath: string, value: string, mode: number, name = 'cc', version = '1.0-1') => ({installedPath, bytes: value.length, sha256: sha(value), mode,
  binary: {name, version, architecture: 'amd64'}, source: {name, version}});
function execution(overrides: Record<string, unknown> = {}) {
  const postpatch = [row('/opt/qlever-sdk/source/src/a.c', 'alpha')];
  return {
    output: {path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')},
    execution: {
      outputs: [{path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')}],
      postpatchSourceReadSnapshotsMatched: postpatch.length,
      dependencySourceReadCaptures: [],
      unresolvedSourceReadPaths: [],
      toolchainFileSnapshots: [],
      observedSourceReadCaptures: postpatch.reduce((sum, item) => sum + item.captures, 0),
      ...overrides,
    },
    postpatch,
  };
}
describe('pure contribution projection', () => {
  test('exact output path/bytes/sha is retained with source reads', () => {
    const input = execution();
    const result = inspectSdkGeneratedInputContributions(input);
    expect('verified' in result).toBe(false);
    expect(result.exactOutput).toEqual(input.output);
    expect(result.postpatchSourceReads).toEqual([{...row('/opt/qlever-sdk/source/src/a.c', 'alpha')}]);
    expect(result.dependencySourceReads).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.scope).toContain('no legal or source authority');
  });

  test('wrong output path is refused even with the same hash', () => {
    const input = execution();
    expect(() => inspectSdkGeneratedInputContributions({...input, output: {...input.output, path: '/opt/qlever-sdk/build/other.o'}})).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({...input, output: {...input.output, sha256: sha('other')}})).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({...input, output: {...input.output, bytes: 9}})).toThrow();
  });

  test('missing source captures and count mismatch are rejected', () => {
    const input = execution({postpatchSourceReadSnapshotsMatched: 2});
    expect(() => inspectSdkGeneratedInputContributions(input)).toThrow();
    const empty = execution({postpatchSourceReadSnapshotsMatched: 0, observedSourceReadCaptures: 0});
    const result = inspectSdkGeneratedInputContributions({...empty, postpatch: []});
    expect(result.postpatchSourceReads).toEqual([]);
    expect(result.pending).toContain('qlever-sdk-complete-phase-source-read-inventory-empty');
  });

  test('dependency rows are retained and counted with postpatch', () => {
    const dependency = row('/opt/qlever-sdk/dependencies/fsst/src/fsst.cpp', 'dep');
    const input = execution({dependencySourceReadCaptures: [dependency], observedSourceReadCaptures: 2});
    const result = inspectSdkGeneratedInputContributions(input);
    expect(result.dependencySourceReads).toEqual([dependency]);
  });

  test('conflicting duplicate and unsafe rows are rejected', () => {
    const input = execution();
    const conflict = [input.postpatch[0], {...input.postpatch[0], sha256: sha('x')}];
    expect(() => inspectSdkGeneratedInputContributions({...input, postpatch: conflict, execution: {...input.execution, postpatchSourceReadSnapshotsMatched: 2}})).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({...input, postpatch: [{...input.postpatch[0], path: '../escape'}]})).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({...input, postpatch: [{...input.postpatch[0], mode: 0o10000}]})).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({...input, postpatch: [{...input.postpatch[0], captures: 2}]})).toThrow();
  });

  test('signed Debian mapping requires all four fields and retains coordinates', () => {
    const snapshot = snapshotRow('/usr/bin/cc', 'compiler', 0o755);
    const binary = binaryRow('/usr/bin/cc', 'compiler', 0o755, 'gcc-12', '12.2.0');
    const result = inspectSdkGeneratedInputContributions({...execution({toolchainFileSnapshots: [snapshot]}), binaryFiles: [binary]});
    expect(result.debianSourceInputs).toHaveLength(1);
    expect(result.debianSourceInputs[0]).toEqual({installedPath: '/usr/bin/cc', observedPath: '/usr/bin/cc', bytes: 8, sha256: sha('compiler'), mode: 0o755,
      binary: {name: 'gcc-12', version: '12.2.0', architecture: 'amd64'}, source: {name: 'gcc-12', version: '12.2.0'}});
    expect(result.pending).toEqual([]);
    for (const [label, changed] of [['bytes', 9], ['sha256', sha('other')], ['mode', 0o644]] as const) {
      const row = label === 'bytes' ? {...binary, bytes: changed}
        : label === 'sha256' ? {...binary, sha256: changed}
          : {...binary, mode: changed};
      expect(() => inspectSdkGeneratedInputContributions({...execution({toolchainFileSnapshots: [snapshot]}), binaryFiles: [row]})).toThrow();
    }
    const movedInstalled = inspectSdkGeneratedInputContributions({...execution({toolchainFileSnapshots: [snapshot]}), binaryFiles: [{...binary, installedPath: '/usr/bin/cc1'}]});
    expect(movedInstalled.pending).toContain('qlever-sdk-toolchain-snapshot-unmapped:/usr/bin/cc:' + sha('compiler'));
    const moved = snapshotRow('/usr/bin/other', 'compiler', 0o755);
    const unmapped = inspectSdkGeneratedInputContributions({...execution({toolchainFileSnapshots: [moved]}), binaryFiles: [binary]});
    expect(unmapped.pending).toContain('qlever-sdk-toolchain-snapshot-unmapped:/usr/bin/other:' + sha('compiler'));
  });

  test('distinct snapshots retained and identical rows deduplicated', () => {
    const a = snapshotRow('/usr/bin/cc', 'compiler', 0o755), b = snapshotRow('/usr/bin/ld', 'linker', 0o755);
    const binaries = [binaryRow('/usr/bin/cc', 'compiler', 0o755), binaryRow('/usr/bin/ld', 'linker', 0o755)];
    const result = inspectSdkGeneratedInputContributions({...execution({toolchainFileSnapshots: [a, b, {...a}], observedSourceReadCaptures: 1}), binaryFiles: binaries});
    expect(result.debianSourceInputs.map(item => item.observedPath)).toEqual(['/usr/bin/cc', '/usr/bin/ld']);
    expect(result.debianSourceInputs[0].source).toEqual({name: 'cc', version: '1.0-1'});
    expect(Object.isFrozen(result.debianSourceInputs[0])).toBe(true);
    expect(Object.isFrozen(result.debianSourceInputs[0].source)).toBe(true);
  });

  test('toolchain snapshots without a mapping stay concrete pending and deep freeze holds', () => {
    const input = execution({toolchainFileSnapshots: [snapshotRow('/usr/bin/cc', 'compiler', 0o755)]});
    const result = inspectSdkGeneratedInputContributions(input);
    expect(result.pending).toContain('qlever-sdk-toolchain-snapshot-unmapped:/usr/bin/cc:' + sha('compiler'));
    expect(result.debianSourceInputs).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.postpatchSourceReads[0])).toBe(true);
    expect(() => {(result.postpatchSourceReads[0] as any).bytes = 999;}).toThrow();
    expect(() => {(result.pending as any).push('x');}).toThrow();
  });

  test('verified true and caller getters cannot be injected', () => {
    const input = execution();
    expect((inspectSdkGeneratedInputContributions({...input, execution: {...input.execution, verified: true}} as any) as any).verified).toBeUndefined();
    const forged = Object.defineProperty({}, 'execution', {get: () => execution().execution});
    expect(() => inspectSdkGeneratedInputContributions(forged as any)).toThrow();
  });
  test('plain/copies cannot stand in for private SDK admission or execution', () => {
    const input = execution();
    const fakeBudget = {check() {}, remainingMs: () => 1000, reserveBytes() {}, chargeReadBytes() {}};
    const plainCopy = {sdkOriginals: {files: []}, sdkAdmission: {}, source: {}, output: input.output, budget: fakeBudget};
    expect(() => candidateServiceSdkInputContributions(plainCopy as any)).toThrow();
    expect(() => candidateServiceSdkInputContributions({...plainCopy, sdkOriginals: Object.create(null)} as any)).toThrow();
    expect(() => candidateServiceSdkInputContributions(null as any)).toThrow();
  });
});
