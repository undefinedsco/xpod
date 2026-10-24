import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {observeSdkGitInputApplicability, selectSdkGitSourcePaths} from '../../scripts/lib/independent-admission/candidate-service-sdk-git-grants';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const budget = () => ({check() {}, remainingMs: () => 1000, remainingReadBytes: () => 1024 * 1024, reserveBytes() {}, chargeReadBytes() {}});
const artifact = {identity: {sourceSha: 'a'.repeat(40)}, members: [{path: '/out/tool', bytes: 1, sha256: sha('x')}]};
const member = (path: string, value: string, mode = 0o644) => ({path, mode, bytes: value.length, sha256: sha(value)});

describe('pure selected source path helper', () => {
  test('selects direct source and ancestor notices only', () => {
    const result = selectSdkGitSourcePaths({memberPath: '/opt/qlever-sdk/source/src/main.c', postpatchPaths: ['LICENSE', 'src/main.c', 'src/NOTICE', 'docs/LICENSE', 'src/other.c']});
    expect(result.kind).toBe('source-file');
    expect(result.sourcePaths).toEqual(['src/main.c']);
    expect(result.noticePaths).toEqual(['LICENSE', 'src/NOTICE']);
  });

  test('generated reads keep every contributing source and collisions deduplicate', () => {
    const result = selectSdkGitSourcePaths({memberPath: '/out/tool', postpatchPaths: ['LICENSE', 'src/a.c', 'src/b.c', 'src/LICENSE'], generatedPostpatchPaths: ['src/a.c', 'src/a.c', 'src/b.c']});
    expect(result.kind).toBe('generated-source-reads');
    expect(result.sourcePaths).toEqual(['src/a.c', 'src/b.c']);
    expect(result.noticePaths).toEqual(['LICENSE', 'src/LICENSE']);
    expect(result.path).toBeUndefined();
  });

  test('rejects escapes, unknown generated paths, and differing paths', () => {
    expect(() => selectSdkGitSourcePaths({memberPath: undefined, postpatchPaths: ['../escape']})).toThrow();
    expect(() => selectSdkGitSourcePaths({memberPath: undefined, postpatchPaths: ['a.c'], generatedPostpatchPaths: ['other.c']})).toThrow();
    expect(() => selectSdkGitSourcePaths({memberPath: undefined, postpatchPaths: ['a.c', 'a.c']})).toThrow();
  });
});

describe('actual adapter refuses forged private capabilities', () => {
  test('plain/copied handles never reach selected reads', async () => {
    for (const handles of [{sdkOriginals: {}, source: {}, sdkAdmission: {}}, {sdkOriginals: Object.create(null), source: {}, sdkAdmission: {}}]) {
      await expect(observeSdkGitInputApplicability({...handles, input: {...member('src/a.c', 'a'), path: '/opt/qlever-sdk/source/src/a.c'},
        artifact: artifact as any, memberPath: '/out/tool', sourceSha: 'a'.repeat(40), budget: budget(), verifyGrant: () => true, declarations: () => []} as any)).rejects.toThrow();
    }
  });

});
