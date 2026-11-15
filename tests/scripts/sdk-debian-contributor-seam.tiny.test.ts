import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectSdkGeneratedInputContributions} from '../../scripts/lib/independent-admission/candidate-service-sdk-input-contributions';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Real producer row shape (SdkDebianSourceInput) must not be dropped. */
function debianRow() {
  return {
    installedPath: '/opt/xpod/qlever/lib/libsqlite3.so',
    observedPath: '/opt/xpod/qlever/lib/libsqlite3.so',
    bytes: 3, sha256: sha('lib'), mode: 0o644,
    binary: {name: 'libsqlite3-0', version: '3.46.1-1', architecture: 'amd64'},
    source: {name: 'sqlite3', version: '3.46.1-1'},
  };
}
function execution() {
  return {
    outputs: [{path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')}],
    postpatchSourceReadSnapshotsMatched: 1,
    dependencySourceReadCaptures: [], unresolvedSourceReadPaths: [],
    toolchainFileSnapshots: [{
      observedPath: '/opt/xpod/qlever/lib/libsqlite3.so',
      identity: [1, 2, 0o100000 | 0o644, 3, 5, 6],
      original: {path: 'capture-0000.original', bytes: 3, sha256: sha('lib')},
    }],
    observedSourceReadCaptures: 1,
  };
}
const postpatch = [{path: '/opt/qlever-sdk/source/x.c', bytes: 3, sha256: sha('abc'), mode: 0o644, captures: 1}];
describe('signed-Debian contributors survive the production seam', () => {
  test('nonempty producer-shaped Debian rows are returned immutably', () => {
    const result = inspectSdkGeneratedInputContributions({
      output: {path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')},
      execution: execution(), postpatch, binaryFiles: [debianRow()],
    });
    expect(result.debianSourceInputs).toHaveLength(1);
    expect(result.debianSourceInputs[0].source).toEqual({name: 'sqlite3', version: '3.46.1-1'});
    expect(Object.isFrozen(result.debianSourceInputs[0])).toBe(true);
    expect(Object.isFrozen(result.debianSourceInputs[0].source)).toBe(true);
    expect(() => {(result.debianSourceInputs[0] as any).bytes = 9;}).toThrow();
  });
  test('empty Debian contributor set stays empty (nothing dropped silently)', () => {
    const result = inspectSdkGeneratedInputContributions({
      output: {path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')},
      execution: execution(), postpatch, binaryFiles: [],
    });
    expect(result.debianSourceInputs).toEqual([]);
  });
  test('tampered Debian row is refused or stays pending, never silently covered', () => {
    // hash mismatch must not silently drop or accept: it is refused (critical)
    expect(() => inspectSdkGeneratedInputContributions({
      output: {path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')},
      execution: execution(), postpatch, binaryFiles: [{...debianRow(), sha256: '0'.repeat(64)}],
    })).toThrow();
    expect(() => inspectSdkGeneratedInputContributions({
      output: {path: '/opt/qlever-sdk/build/out.o', bytes: 3, sha256: sha('obj')},
      execution: execution(), postpatch, binaryFiles: [{...debianRow(), mode: 0o10000}],
    })).toThrow();
  });
});
