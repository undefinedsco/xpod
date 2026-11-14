/** Focused text-slice test: native original license notices are observed from
 * real reviewed templates and actual fixtures only. This never exercises
 * private origin/wrapper applicability or mints a grant/registry capability. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { LEGAL_GRANT_TEMPLATE_PATHS } from '../../scripts/lib/independent-admission/legal-admission';
import { inspectNativeOriginalLicenseNotices } from '../../scripts/lib/independent-admission/candidate-service-native-license-text';

const source = (name: string) => readFileSync(new URL('../../' + name, import.meta.url));
const templates = Object.freeze({ mit: source(LEGAL_GRANT_TEMPLATE_PATHS.mit), isc: source(LEGAL_GRANT_TEMPLATE_PATHS.isc),
  apache: source(LEGAL_GRANT_TEMPLATE_PATHS.apache) });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const retainedOf = (...rows: Buffer[]) => rows.map(bytes => ({ bytes: bytes.length, sha256: sha256(bytes) }));
const mitOriginal = source('LICENSE');
const iscOriginal = source('packages/xpod-cli/licenses/native/collection/objects/f025ccfb7dfb6bdfedc75ca0f67acc69e6fb4998143d834f7c2f38a29989680f.txt');
const apacheOriginal = gunzipSync(source('tests/fixtures/legal-originals/typescript-5.5.4.LICENSE.txt.gz'));

function input(overrides: Partial<Parameters<typeof inspectNativeOriginalLicenseNotices>[0]> = {}) {
  const grant = overrides.grant ?? mitOriginal;
  const notices = overrides.notices ?? [{ path: 'native/LICENSE', bytes: mitOriginal }];
  return { declaredLicense: 'MIT', grant, notices, retained: retainedOf(grant, ...notices.map(row => row.bytes)),
    sourceTexts: [] as Buffer[], templates, check: () => {}, ...overrides };
}

test('real MIT original with retained bytes and notices yields no pending text conclusions', () => {
  expect(mitOriginal.toString()).toContain('undefineds.co');
  expect(inspectNativeOriginalLicenseNotices(input())).toEqual([]);
});

test('real ISC and Apache originals pass the existing parsed-grant predicate', () => {
  const isc = input({ declaredLicense: 'ISC', grant: iscOriginal, notices: [{ path: 'native/LICENSE', bytes: iscOriginal }] });
  expect(inspectNativeOriginalLicenseNotices(isc)).toEqual([]);
  const apache = input({ declaredLicense: 'Apache-2.0', grant: apacheOriginal, notices: [{ path: 'native/NOTICE', bytes: apacheOriginal }] });
  expect(inspectNativeOriginalLicenseNotices(apache)).toEqual([]);
});

test('other declared licenses and absent declarations stay pending instead of guessing permission', () => {
  for (const declaredLicense of ['MPL-2.0', 'MIT OR Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'Unlicense']) {
    const pending = inspectNativeOriginalLicenseNotices(input({ declaredLicense }));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('another explicit grant adapter');
    expect(/permission granted|public domain/i.test(pending.join(' '))).toBe(false);
  }
  const absent = inspectNativeOriginalLicenseNotices(input({ declaredLicense: '' }));
  expect(absent.join(' ')).toContain('Declared license missing');
  // A public-domain label is never interpreted as a grant either.
  expect(inspectNativeOriginalLicenseNotices(input({ declaredLicense: 'Public Domain' })).join(' ')).toContain('not a public-domain guess');
});

test('grant bytes absent from retained originals stay pending', () => {
  const pending = inspectNativeOriginalLicenseNotices(input({ retained: [] }));
  expect(pending).toHaveLength(2);
  expect(pending.join(' ')).toContain('Normative grant actual SHA-256/byte length absent from retained originals');
  expect(pending.join(' ')).toContain('Original notice native/LICENSE actual SHA-256/byte length absent');
});

test('tampered notice bytes are reported against the real retained hash', () => {
  const tampered = Buffer.from(mitOriginal.toString().replace('undefineds.co', 'someone-else'));
  const pending = inspectNativeOriginalLicenseNotices(input({ notices: [{ path: 'native/LICENSE', bytes: tampered }],
    retained: retainedOf(mitOriginal, mitOriginal) }));
  expect(pending).toHaveLength(1);
  expect(pending[0]).toContain('Original notice native/LICENSE actual SHA-256/byte length absent');
});

test('missing notices are pending, duplicate paths are rejected', () => {
  expect(inspectNativeOriginalLicenseNotices(input({ notices: [] })).join(' ')).toContain('Original license notice missing');
  expect(() => inspectNativeOriginalLicenseNotices(input({ notices: [{ path: 'native/LICENSE', bytes: mitOriginal }, { path: 'native/LICENSE', bytes: mitOriginal }] })))
    .toThrow('duplicate original notice path');
});

test('notice paths must be canonical repository-relative paths', () => {
  for (const bad of ['/abs/LICENSE', '../LICENSE', 'native/../LICENSE', 'native//LICENSE', 'native/./LICENSE', 'native\\LICENSE', 'native/\u0000LICENSE', '']) {
    expect(() => inspectNativeOriginalLicenseNotices(input({ notices: [{ path: bad, bytes: mitOriginal }] }))).toThrow('canonical relative notice path');
  }
});

test('explicit license conflicts in source texts are reported per input', () => {
  const sourceTexts = [Buffer.from('export const x = 1;\n'), Buffer.from('// SPDX-License-Identifier: MPL-2.0\nexport const y = 2;\n')];
  const pending = inspectNativeOriginalLicenseNotices(input({ sourceTexts }));
  expect(pending).toHaveLength(1);
  expect(pending[0]).toContain('Source text 1 contains an explicit conflicting license');
  expect(pending[0]).toContain('MPL-2.0');
  // Conflicts are also detected inside the grant text itself.
  const grant = Buffer.from(mitOriginal.toString() + '\n// SPDX-License-Identifier: GPL-3.0-only\n');
  expect(inspectNativeOriginalLicenseNotices(input({ grant, retained: retainedOf(grant) })).join(' '))
    .toContain('Grant text contains an explicit conflicting license');
});

test('parent cancellation is propagated unchanged from every check point', () => {
  let calls = 0;
  const cancel = () => { calls++; if (calls === 3) throw new Error('parent budget exhausted'); };
  expect(() => inspectNativeOriginalLicenseNotices(input({ check: cancel }))).toThrow('parent budget exhausted');
  expect(calls).toBe(3);
  expect(() => inspectNativeOriginalLicenseNotices({ ...input(), check: undefined as any })).toThrow('shared parent check required');
});
