import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectNativeArchiveInputApplicability} from '../../scripts/lib/independent-admission/candidate-service-native-archive-applicability';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Pure parser-mechanics positive/negative only; no qualification is claimed. */
function scenario(includeNotice: boolean, tamperNotice = false) {
  const source = {path: 'x.c', type: 'file', bytes: 3, sha256: sha('abc')};
  const license = includeNotice ? {path: 'LICENSE', type: 'file', bytes: 4, sha256: sha('MIT\n')} : undefined;
  const members = [source, ...(license ? [license] : [])];
  const texts = [{path: 'x.c', bytes: 3, sha256: sha('abc'), text: Buffer.from('abc')},
    ...(license ? [{path: 'LICENSE', bytes: 4, sha256: tamperNotice ? sha('BAD\n') : sha('MIT\n'), text: Buffer.from(tamperNotice ? 'BAD\n' : 'MIT\n')}] : [])];
  const artifact = {identity: {sourceSha: 'a'.repeat(40)}, members: [{path: '/app/x', bytes: 3, sha256: sha('abc')}, ...(license ? [{path: '/app/LICENSE', bytes: 4, sha256: sha('MIT\n')}] : [])]};
  return inspectNativeArchiveInputApplicability({original: source as any, memberPath: '/app/x', sourceSha: 'a'.repeat(40),
    members: members as any, texts: texts as any, artifact: artifact as any, check() {}, chargeReadBytes() {},
    verifyGrant: bytes => bytes.toString().includes('MIT'), declarations: () => []});
}
describe('actual selected dependency source + ancestor notice applicability', () => {
  test('source with retained ancestor notice is covered', () => {
    expect(scenario(true)).toEqual({covered: true, pending: []});
  });
  test('missing ancestor notice is not covered', () => {
    const result = scenario(false);
    expect(result.covered).toBe(false);
    expect(result.pending.length).toBeGreaterThan(0);
  });
  test('tampered notice bytes are rejected', () => {
    expect(() => scenario(true, true)).toThrow();
  });
});
