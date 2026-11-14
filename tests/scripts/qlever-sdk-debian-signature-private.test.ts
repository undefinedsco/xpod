import {expect, it, vi} from 'vitest';
import {observeQleverSdkDebianSignatureOriginals, qleverSdkDebianSignatureObservation} from '../../scripts/lib/independent-admission/qlever-sdk-debian-signature';

it('never turns serialized SDK/key/status approvals into controller signature authority', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('unexpected network'));
  try {
    for (const value of [null, {}, {official: true, originFacts: {target: 'linux-x64'}, masterReference: {path: 'materials.json'}, readOriginal: () => Buffer.from('{}'), status: 'VALIDSIG'}]) {
      expect(qleverSdkDebianSignatureObservation(value)).toBeUndefined();
      const report = await observeQleverSdkDebianSignatureOriginals(value);
      expect(report.facts.sdkDebianOfficialSignatureAndSuiteVerified).not.toBe(true);
      expect(report.pending).toEqual(['SDK Debian signature: issued related SDK originals required']);
    }
    expect(network).not.toHaveBeenCalled();
  } finally {network.mockRestore();}
});
