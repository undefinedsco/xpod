import { expect, it } from 'vitest';
import { inspectQleverSdkSourceOriginals } from '../../scripts/lib/independent-admission/qlever-sdk-source';
it('requires the related SDK issuer and never accepts master JSON as source custody', () => {
  for (const value of [null, {}, {masterReference: {path: 'materials.json', sha256: 'a'.repeat(64), bytes: 10}, sourceQualified: true, originFacts: {sourceSha: 'a'.repeat(40), target: 'linux-x64'}, readOriginal: () => Buffer.from('{}') }]) {
    const actual = inspectQleverSdkSourceOriginals(value);
    expect(actual.verified).toBe(false);
    expect(actual.facts.sdkSourceCompletenessVerified).toBe(false);
    expect(actual.pending).toContain('QLever SDK source: issued related SDK originals required');
  }
});
