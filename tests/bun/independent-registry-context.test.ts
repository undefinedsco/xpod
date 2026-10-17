import { expect, it } from 'bun:test';
import { observeRegistryArtifact, registryArtifactView } from '../../scripts/lib/independent-admission/registry-context';

it('serialized registry or producer reports cannot issue registry custody authority', async () => {
  const forged = { status: 'readback-only', package: '@undefineds.co/xpod-client', version: '1.0.0',
    artifactCustodyVerified: true, archive: { sha256: 'a'.repeat(64), bytes: 42 },
    identity: { sourceSha: 'b'.repeat(40), package: '@undefineds.co/xpod-client', version: '1.0.0' } };
  for (const input of [{ ...forged, identity: { ...forged.identity, package: '@undefineds.co/xpod-api-linux-x64', target: 'linux-x64', archiveBytes: 400 * 1024 ** 2 } }, forged, JSON.parse(JSON.stringify(forged)), {}, null, true]) {
    expect(registryArtifactView(input)).toBeUndefined();
    await expect(observeRegistryArtifact(input)).rejects.toThrow('collected artifact capability');
  }
});
