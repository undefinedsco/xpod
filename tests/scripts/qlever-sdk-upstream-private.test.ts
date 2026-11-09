import { expect, it } from 'vitest';
import { observeQleverSdkUpstreamGitOriginals, assertSdkUpstreamCollectionProjection } from '../../scripts/lib/independent-admission/qlever-sdk-upstream-source';
import { sdkVerifiedInputOriginalView } from '../../scripts/lib/independent-admission/qlever-sdk-source';
it('does not reconstruct Git source or actual input-original facts from serialized declarations', async () => {
  const json = {verified: true, sourceSha: '1'.repeat(40), commit: '2'.repeat(40), sdkUpstreamGitCommitTreePreimageClosureVerified: true};
  expect(sdkVerifiedInputOriginalView(json)).toBeUndefined();
  const result = await observeQleverSdkUpstreamGitOriginals(json, json, 120000);
  expect(result.facts).toEqual({}); expect(result.pending).toEqual(['SDK upstream source: same issued SDK and immutable source required']);
});

it('requires the complete original inner collection after exact reference rooting', () => {
  const original = {schemaVersion: 1, sourceRoot: '/opt/qlever-sdk/source', hookWindows: {beforeEndedUnixNs: '1', afterEndedUnixNs: '2'},
    lock: {path: 'upstream-source/lock.json', bytes: 4, sha256: 'a'.repeat(64)},
    phaseBindings: {compile: {inputs: [{path: 'inputs-before.json', bytes: 5, sha256: 'b'.repeat(64)}]}}};
  const root = {...original, lock: {...original.lock, path: 'inner/' + original.lock.path}, phaseBindings: {compile: {inputs: [{...original.phaseBindings.compile.inputs[0], path: 'inner/inputs-before.json'}]}}, innerMaterials: {path: 'inner/upstream-source/final-materials.json', bytes: 1, sha256: 'c'.repeat(64)}};
  expect(() => assertSdkUpstreamCollectionProjection(root, original)).not.toThrow();
  expect(() => assertSdkUpstreamCollectionProjection({...root, hookWindows: {beforeEndedUnixNs: '0', afterEndedUnixNs: '2'}}, original)).toThrow();
  expect(() => assertSdkUpstreamCollectionProjection({...root, extraApproval: true}, original)).toThrow();
  expect(() => assertSdkUpstreamCollectionProjection({...root, lock: {...root.lock, bytes: 5}}, original)).toThrow();
});
