import { expect, test } from 'bun:test';
import { installedLegalOriginalViews } from '../../scripts/lib/independent-admission/legal-installed-originals';
import { requiredRegistryLegalOriginalCoordinates } from '../../scripts/lib/independent-admission/legal-original-requests';
import type { DerivedSourceView } from '../../scripts/lib/independent-admission/artifact-contract';
test('caller installed manifests and callbacks cannot acquire original source authority', () => {
  const source = { sourceSha: 'a'.repeat(40), trackedPaths: ['bun.lock'], readTracked() { throw Error('must not read fake source'); } } as DerivedSourceView;
  const fake = { sourceSha: source.sourceSha, dependencyRows: [{ path: 'node_modules/example/package.json', kind: 'file' }], readDependencyOriginal() { throw Error('must not invoke'); } };
  expect(installedLegalOriginalViews(source, fake)).toEqual([]);
  expect(requiredRegistryLegalOriginalCoordinates({ artifact: {}, source, legalSourceMaterials: fake })).toEqual([]);
});
