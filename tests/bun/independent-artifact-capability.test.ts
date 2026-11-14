import { describe, expect, it } from 'bun:test';
import { collectedArtifactView, collectAdmissionArtifact } from '../../scripts/lib/independent-admission/artifact-collector';
import { derivedSourceView, deriveAdmissionSource } from '../../scripts/lib/independent-admission/source-context';
import { nativeMaterialView, collectNativeMaterialContext } from '../../scripts/lib/independent-admission/native-context';

describe('central collected artifact capability', () => {
  it('does not recognize serialized custody, hashes or approval fields', () => {
    for (const value of [null, {}, { archiveSha256: 'a'.repeat(64), sourceQualified: true }, JSON.parse('{}')]) {
      expect(collectedArtifactView(value)).toBeUndefined();
    }
  });
  it('rejects offline origin assertions before reading caller paths', async () => {
    await expect(collectAdmissionArtifact({ githubOrigin: { passed: true }, acquisitionRoot: '/does-not-exist',
      projectionOutput: '/does-not-exist', product: 'cli' })).rejects.toThrow('controlled origin observation required');
  });
  it('cannot derive source authority from JSON or arbitrary read callbacks', () => {
    expect(derivedSourceView({ sourceSha: 'a'.repeat(40), readTracked: () => Buffer.from('fake') })).toBeUndefined();
    expect(() => deriveAdmissionSource({} as any, '/does-not-exist')).toThrow('collected artifact capability required');
  });
  it('cannot mint native material authority from arbitrary roots or callbacks', () => {
    expect(nativeMaterialView({ verified: true, productRoot: '/fake', verify: () => true })).toBeUndefined();
    expect(() => collectNativeMaterialContext({} as any, { productRoot: '/fake', materialsRoot: '/fake' })).toThrow('collected artifact capability required');
  });
});
