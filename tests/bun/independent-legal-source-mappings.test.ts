import { expect, test } from 'bun:test';
import { inspectTranspiledLegalMappings } from '../../scripts/lib/independent-admission/legal-source-mappings';
import type { CollectedArtifactView, DerivedSourceView } from '../../scripts/lib/independent-admission/artifact-contract';
test('JSON compiler mapping and read callbacks cannot establish private source/output authority', () => {
  const artifact = { identity: { sourceSha: 'a'.repeat(40) }, members: [] } as unknown as CollectedArtifactView;
  const source = { sourceSha: 'a'.repeat(40), trackedPaths: [], readTracked() { throw Error('must not call'); } } as DerivedSourceView;
  const fake = { sourceSha: source.sourceSha, transpiledOutputs: [{ path: 'src/main.js', sourcePath: 'src/main.ts' }], readDependencyOriginal() { throw Error('must not call'); } };
  expect(inspectTranspiledLegalMappings(artifact, source, fake, () => { throw Error('must not call'); })).toEqual({ sourceScopedOutputs: [], coveredOutputs: [], compilerOriginals: [], pending: [] });
});
