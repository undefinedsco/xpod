import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {validateSelectedObservation} from '../../scripts/lib/independent-admission/qlever-sdk-fetchcontent';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const b64 = (v: string) => Buffer.from(v).toString('base64');
const record = (path: string, value: string, mode = 0o644) => ({path, bytes: value.length, sha256: sha(value), mode});
const records = new Map<string, ReturnType<typeof record>>([
  ['/opt/qlever-sdk/dependencies/demo/a.c', record('/opt/qlever-sdk/dependencies/demo/a.c', 'alpha')],
]);
function observation(overrides: any = {}) {
  return {
    kind: 'k', declaredSourceByteClosureVerified: true, overallSourceAuthorityVerified: false,
    dependencies: [], pending: [],
    selectedOriginals: [{path: '/opt/qlever-sdk/dependencies/demo/a.c', bytes: 5, sha256: sha('alpha'), mode: 0o644, base64: b64('alpha'), requested: true}],
    ...overrides,
  };
}
const paths = ['/opt/qlever-sdk/dependencies/demo/a.c'];
describe('selected helper observation is closed and strict (no ||true bypass)', () => {
  test('genuine requested row + ancestor notice validates', () => {
    const notice = {path: '/opt/qlever-sdk/dependencies/demo/LICENSE', bytes: 4, sha256: sha('MIT\n'), mode: 0o644, base64: b64('MIT\n'), requested: false};
    expect(validateSelectedObservation(observation({selectedOriginals: [...observation().selectedOriginals, notice]}), 'k', paths, records)).toBe(true);
  });
  test('wrong kind or flags are rejected', () => {
    for (const bad of [{kind: 'other'}, {declaredSourceByteClosureVerified: false}, {overallSourceAuthorityVerified: true}]) {
      expect(() => validateSelectedObservation(observation(bad), 'k', paths, records)).toThrow();
    }
  });
  test('tampered bytes, digest, mode, extra, missing and bad requested flag rejected', () => {
    const row = observation().selectedOriginals[0];
    const cases = [
      {...row, base64: b64('bravo'), bytes: 5, sha256: sha('alpha')},              // tampered bytes
      {...row, sha256: '0'.repeat(64)},                                             // tampered digest
      {...row, mode: 0o755},                                                        // wrong mode
      {...row, bytes: 6},                                                           // wrong size
      {...row, requested: false},                                                   // flag flip
      {...row, path: '/opt/qlever-sdk/dependencies/demo/b.c'},                       // different path
    ];
    for (const bad of cases) expect(() => validateSelectedObservation(observation({selectedOriginals: [bad]}), 'k', paths, records)).toThrow();
    expect(() => validateSelectedObservation(observation({selectedOriginals: []}), 'k', paths, records)).toThrow();
    const duplicate = [row, {...row, path: '/opt/qlever-sdk/dependencies/demo/LICENSE', requested: false, bytes: 4, sha256: sha('MIT\n'), base64: b64('MIT\n')}, row];
    expect(() => validateSelectedObservation(observation({selectedOriginals: duplicate}), 'k', paths, records)).toThrow();
  });
  test('non-notice automatic row is rejected', () => {
    const sneaky = {path: '/opt/qlever-sdk/dependencies/demo/b.c', bytes: 4, sha256: sha('beta'), mode: 0o644, base64: b64('beta'), requested: false};
    expect(() => validateSelectedObservation(observation({selectedOriginals: [...observation().selectedOriginals, sneaky]}), 'k', paths, records)).toThrow();
  });
});
