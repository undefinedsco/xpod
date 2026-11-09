import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { verifyLegalAdmission, verifyMitGrantText, verifyApacheGrantText, verifyIscGrantText, explicitLicenseConflicts } from '../../scripts/lib/independent-admission/legal-admission';
import type { AdmissionContext } from '../../scripts/lib/independent-admission';
const template = readFileSync(new URL('../../packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt', import.meta.url));
const normative = template.toString().slice(template.toString().indexOf('Permission is hereby granted'));
test('actual normative grant with preserved holder is recognized without metadata approval', () => {
  const original = Buffer.from('MIT License\n\nCopyright (c) 2025 Example Authors\n\n' + normative);
  expect(verifyMitGrantText(original, template)).toBe(true);
  expect(verifyMitGrantText(readFileSync(new URL('../../LICENSE', import.meta.url)), template)).toBe(true);
  expect(verifyMitGrantText(Buffer.from(original.toString().replaceAll('\n', '\r\n')), template)).toBe(true);
});
test('metadata labels, standard placeholders, modified terms and arbitrary templates do not establish a grant', () => {
  expect(verifyMitGrantText(Buffer.from('MIT'), template)).toBe(false);
  expect(verifyMitGrantText(template, template)).toBe(false);
  expect(verifyMitGrantText(Buffer.from('Copyright (c) 2025 Example Authors\n' + normative + '\nNo commercial distribution.'), template)).toBe(false);
  expect(verifyMitGrantText(Buffer.from('Copyright (c) 2025 Example Authors\n' + normative), Buffer.from(normative))).toBe(false);
});
test('JSON legal clearance and callbacks cannot replace real artifact/source capabilities', () => {
  const context = { collectedArtifact: { status: 'verified' }, derivedSource: { sourceSha: 'a'.repeat(40) },
    readOriginal() { throw Error('untrusted callback must not run'); }, readTracked() { throw Error('untrusted callback must not run'); } } as unknown as AdmissionContext;
  const result = verifyLegalAdmission({ legalClearance: true, status: 'passed', license: 'MIT' }, context);
  expect(result.status).toBe('pending'); expect(result.facts.legalQualified).toBe(false);
  expect(result.facts.artifactCustodyVerified || result.facts.immutableSourceVerified).toBe(false);
});

test('explicit non-MIT SPDX or license overrides prevent this grant qualification', () => {
  expect(explicitLicenseConflicts(Buffer.from('// SPDX-License-Identifier: GPL-3.0-only\nexport const x = 1;'))).toEqual([
    'Explicit SPDX expression requires another grant adapter: GPL-3.0-only',
  ]);
  expect(explicitLicenseConflicts(Buffer.from('/* SPDX-License-Identifier: Apache-2.0 */'))).toHaveLength(1);
  expect(explicitLicenseConflicts(Buffer.from('// SPDX-License-Identifier: MIT OR Apache-2.0'))).toHaveLength(1);
  expect(explicitLicenseConflicts(Buffer.from('/* @license Custom-Permission */'))).toHaveLength(1);
  expect(explicitLicenseConflicts(Buffer.from('// Licensed under the Apache License, Version 2.0'))).toHaveLength(1);
  expect(explicitLicenseConflicts(Buffer.from('// Licensed under the MIT License.'))).toEqual([]);
  expect(explicitLicenseConflicts(Buffer.from('/* SPDX-License-Identifier: MIT */\n/** @license MIT */'))).toEqual([]);
  expect(explicitLicenseConflicts(Buffer.from('// See the license documentation for details.'))).toEqual([]);
});

test('central exact source bindings are derived from canonical layout and genuine bytes', async () => {
  const { deriveExactSourceGrantDeclaration } = await import('../../scripts/lib/independent-admission/legal-admission');
  const { createHash } = await import('node:crypto');
  const blobs: Record<string, Buffer> = { 'packages/xpod-client/index.js': Buffer.from('export const x=1;'), LICENSE: Buffer.from('actual notice') };
  const members = [['index.js', blobs['packages/xpod-client/index.js']!], ['LICENSE', blobs.LICENSE!]].map(([path, bytes]) => ({ path: path as string,
    bytes: (bytes as Buffer).length, sha256: createHash('sha256').update(bytes as Buffer).digest('hex'), mode: 0o644 }));
  const source = { trackedPaths: Object.keys(blobs), readTracked: (name: string) => blobs[name]! };
  const derived = deriveExactSourceGrantDeclaration(members, source, 'packages/xpod-client');
  expect(derived.pending).toEqual([]);
  expect(derived.evidence?.files).toEqual([{ path: 'index.js', sourcePath: 'packages/xpod-client/index.js', grantSourcePath: 'LICENSE' },
    { path: 'LICENSE', sourcePath: 'LICENSE', grantSourcePath: 'LICENSE' }]);
  expect(deriveExactSourceGrantDeclaration([{ ...members[0]!, sha256: 'a'.repeat(64) }], source, 'packages/xpod-client').evidence).toBeUndefined();
});


test('Apache canonical original needs both complete normative text and original manifest application', () => {
  const apache = readFileSync(new URL('../../packages/xpod-cli/licenses/native/collection/objects/cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30.txt', import.meta.url));
  expect(verifyApacheGrantText(apache, apache, 'Apache-2.0')).toBe(true);
  expect(verifyApacheGrantText(apache, apache, undefined)).toBe(false);
  expect(verifyApacheGrantText(Buffer.from('Apache-2.0'), apache, 'Apache-2.0')).toBe(false);
  expect(verifyApacheGrantText(Buffer.from(apache.toString() + '\nNo commercial use.'), apache, 'Apache-2.0')).toBe(false);
});

// Existing retained upstream original; framing is presentation, normative grant
// and original holder remain byte-preserved by the admission caller.
test('actual retained Inrupt MIT original permits its unmodified framing and holder', () => {
  const original = readFileSync(new URL('../../packages/xpod-cli/licenses/javascript/objects/844fb3d1fcba1b7b2c04887fa108174167fe4ba40e5a4c6e67490c3b71731b49.txt', import.meta.url));
  expect(verifyMitGrantText(original, template)).toBe(true);
  expect(verifyMitGrantText(Buffer.from(original.toString().replace('Copyright Inrupt Inc.', 'Copyright')), template)).toBe(false);
  expect(verifyMitGrantText(Buffer.from(original.toString().replace('Copyright Inrupt Inc.', 'Copyright [fullname]')), template)).toBe(false);
  expect(verifyMitGrantText(Buffer.from(original.toString().replace('Permission is hereby granted', 'Permission may be granted')), template)).toBe(false);
});

test('existing original ISC grant is distinct from MIT and preserves complete normative terms', () => {
  const original = readFileSync(new URL('../../packages/xpod-cli/licenses/native/collection/objects/b29f8b01452350c20dd1af16ef83b598fea3053578ccc1c7a0ef40e57be2620f.txt', import.meta.url));
  expect(verifyIscGrantText(original, original, 'ISC')).toBe(true);
  expect(verifyIscGrantText(original, original, 'MIT')).toBe(false);
  expect(verifyMitGrantText(original, template)).toBe(false);
  expect(verifyIscGrantText(Buffer.from(original.toString().replace('Copyright © 2015, Simonas Kazlauskas', 'Copyright [fullname]')), original, 'ISC')).toBe(false);
  expect(verifyIscGrantText(Buffer.from(original.toString().replace('with or without', 'only with')), original, 'ISC')).toBe(false);
  expect(explicitLicenseConflicts(Buffer.from('// SPDX-License-Identifier: Artistic-2.0'), 'ISC')).toHaveLength(1);
  const ansi = readFileSync(new URL('../../packages/xpod-cli/licenses/javascript/objects/b3eb9d2e054a43a3064af17332fb1839a7dadb205c5371af4789616afb1a117f.txt', import.meta.url));
  expect(explicitLicenseConflicts(ansi, 'ISC')).toHaveLength(1);
  expect(explicitLicenseConflicts(Buffer.from('// Licensed under the ISC License.'), 'ISC')).toEqual([]);
});
