import { expect, it } from 'bun:test';
import { collectRegistryPeerArtifact, collectedArtifactView } from '../../scripts/lib/independent-admission/artifact-collector';
import { publicationPeerInputPlanView } from '../../scripts/lib/independent-admission/peer-input-plan';

it('serialized lock plans cannot request downloads or issue artifact custody', async () => {
  const plan = { status: 'collection-planned', requests: [{ requestKey: 'jose@5.10.0', package: 'jose', version: '5.10.0' }] };
  expect(publicationPeerInputPlanView(plan)).toBeUndefined();
  expect(collectedArtifactView(plan)).toBeUndefined();
  await expect(collectRegistryPeerArtifact({ plan, requestKey: 'jose@5.10.0' })).rejects.toThrow('real immutable');
});
