import { expect, it } from 'vitest';
import { inspectQleverSdkSourceOriginals, observeQleverSdkSourceAdmission, qleverSdkSourceAdmissionView } from '../../scripts/lib/independent-admission/qlever-sdk-source';
it('requires the related SDK issuer and never accepts master JSON as source custody', () => {
  for (const value of [null, {}, {masterReference: {path: 'materials.json', sha256: 'a'.repeat(64), bytes: 10}, sourceQualified: true, originFacts: {sourceSha: 'a'.repeat(40), target: 'linux-x64'}, readOriginal: () => Buffer.from('{}') }]) {
    const actual = inspectQleverSdkSourceOriginals(value);
    expect(actual.verified).toBe(false);
    expect(actual.facts.sdkSourceCompletenessVerified).toBe(false);
    expect(actual.pending).toContain('QLever SDK source: issued related SDK originals required');
  }
});

it('rejects structural complete results and actual incomplete admission results', async () => {
  const sdkOriginals = {}, source = {}, input = {sdkOriginals, source};
  let calls = 0;
  const fake = Object.freeze({verified: true, pending: [], facts: {sdkSourceCompletenessVerified: true}, assertCurrent: () => { calls++; }});
  expect(qleverSdkSourceAdmissionView(fake, input)).toBeUndefined();
  expect(qleverSdkSourceAdmissionView(JSON.parse(JSON.stringify(fake)), input)).toBeUndefined();
  const actual = await observeQleverSdkSourceAdmission(input);
  expect(actual.verified).toBe(false);
  expect(qleverSdkSourceAdmissionView(actual, input)).toBeUndefined();
  expect(qleverSdkSourceAdmissionView({...actual, verified: true}, input)).toBeUndefined();
  expect(qleverSdkSourceAdmissionView(actual, {sdkOriginals: {}, source})).toBeUndefined();
  expect(calls).toBe(0);
});
