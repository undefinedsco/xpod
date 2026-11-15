import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runtimeArchiveExecutable, stageBundledBun } from '../scripts/bun-runtime-material';
import { fixtureZip, hash, makeRuntimeFixture } from './bun-runtime-fixture';

test('tiny archive admission rejects digest, traversal, symlink and non-executable modes', () => {
  const executable = Buffer.from('not an executable; selection fixture only');
  for (const [name, mode] of [['../bun', 0o100755], ['bun-darwin-aarch64/bun', 0o120755], ['bun-darwin-aarch64/bun', 0o100644]] as const) {
    const archive = fixtureZip(name, mode);
    expect(() => runtimeArchiveExecutable(archive, { version: 'fixture', target: 'darwin-arm64', sourceCommit: 'fixture',
      archiveSha256: hash(archive), executableSha256: hash(executable), entry: 'bun-darwin-aarch64/bun' })).toThrow();
  }
  expect(() => runtimeArchiveExecutable(fixtureZip(), { version: 'fixture', target: 'darwin-arm64', sourceCommit: 'fixture',
    archiveSha256: '0'.repeat(64), executableSha256: hash(executable), entry: 'bun-darwin-aarch64/bun' })).toThrow('digest');
});

test('preview retains pending authority; release, wrong target and changed authority fail closed', () => {
  const base = path.resolve(import.meta.dir, '../../.test-data/bun-runtime-material');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  try {
    const input = makeRuntimeFixture(root), output = path.join(root, 'output');
    stageBundledBun(root, output, input);
    expect(statSync(path.join(output, 'bin/bun')).mode & 0o777).toBe(0o755);
    const receipt = JSON.parse(readFileSync(path.join(output, 'licenses/bun/receipt.json'), 'utf8'));
    expect(receipt.legalComplete).toBe(false); expect(receipt.releaseQualified).toBe(false);
    // Preview never claims the reviewed set either.
    expect(receipt.declaredMaterialSetVerified).toBe(false); expect(receipt.legalStatus).toBe('not-assessed');
    const descriptor = JSON.parse(readFileSync(input, 'utf8'));
    writeFileSync(input, JSON.stringify({ ...descriptor, mode: 'release' }));
    expect(() => stageBundledBun(root, output, input)).toThrow('incomplete');
    writeFileSync(input, JSON.stringify({ ...descriptor, target: 'linux-x64' }));
    expect(() => stageBundledBun(root, output, input)).toThrow('target');
    writeFileSync(input, JSON.stringify({ ...descriptor, authoritySha256: '0'.repeat(64) }));
    expect(() => stageBundledBun(root, output, input)).toThrow('authority digest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release receipt admits the reviewed declared set without claiming legal completeness', () => {
  const base = path.resolve(import.meta.dir, '../../.test-data/bun-runtime-material');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'release-'));
  try {
    const input = makeRuntimeFixture(root), output = path.join(root, 'output');
    const descriptorBytes = readFileSync(input, 'utf8');
    const descriptor = JSON.parse(descriptorBytes);
    // Build a genuinely admissible release set: verified assessment, named
    // reviewer, root LICENSE matching the pin, and license/source/relink originals.
    const materials: Record<string, Buffer> = {
      'license.original': Buffer.from('fixture root license\n'),
      'source.original': Buffer.from('fixture build entry\n'),
      'relink.original': Buffer.from('fixture relink instructions\n'),
      'assessment.original': Buffer.from('{"fixture":true}\n'),
    };
    for (const [name, bytes] of Object.entries(materials)) {
      writeFileSync(path.join(root, name), bytes);
    }
    const license = Buffer.from('fixture root license\n');
    const pinDir = path.join(root, 'packages/xpod-cli/licenses/javascript/generated/1.4.2');
    const pin = JSON.parse(readFileSync(path.join(pinDir, 'index.json'), 'utf8'));
    pin.files = [{ sourcePath: 'LICENSE.md', object: 'license.original', sha256: hash(license),
      provenance: { sourceUrl: 'https://example.invalid/LICENSE.md' } }];
    writeFileSync(path.join(pinDir, 'index.json'), JSON.stringify(pin));

    const authority = {
      schemaVersion: 1, version: '1.4.2', target: 'darwin-arm64',
      sourceCommit: pin.provenance.bunCommit, executableSha256: pin.provenance.compiler.executableSha256,
      assessment: { status: 'verified', reviewer: 'fixture reviewer',
        applicableRequirements: ['license', 'source', 'relink'],
        findings: ['fixture declares a reviewed material set only'] },
      files: [
        { path: 'license.original', sha256: hash(materials['license.original']), sourceUrl: 'https://example.invalid/LICENSE.md', kind: 'license' },
        { path: 'source.original', sha256: hash(materials['source.original']), sourceUrl: 'https://example.invalid/build.ts', kind: 'source' },
        { path: 'relink.original', sha256: hash(materials['relink.original']), sourceUrl: 'https://example.invalid/webkit.ts', kind: 'relink' },
        { path: 'assessment.original', sha256: hash(materials['assessment.original']), sourceUrl: 'https://example.invalid/tag', kind: 'assessment' },
      ],
    };
    const authorityBytes = Buffer.from(JSON.stringify(authority));
    writeFileSync(path.join(root, 'authority.json'), authorityBytes);
    writeFileSync(input, JSON.stringify({ ...descriptor, mode: 'release', authoritySha256: hash(authorityBytes) }));

    stageBundledBun(root, output, input);
    const receipt = JSON.parse(readFileSync(path.join(output, 'licenses/bun/receipt.json'), 'utf8'));
    // The engineering admission did happen...
    expect(receipt.mode).toBe('release');
    expect(receipt.releaseQualified).toBe(true);
    expect(receipt.declaredMaterialSetVerified).toBe(true);
    expect(receipt.qualificationBasis).toMatch(/not an assessment of whole-binary legal coverage/u);
    // ...but whole-binary legal completeness is NOT proven by it.
    expect(receipt.legalComplete).toBe(false);
    expect(receipt.legalStatus).toBe('not-assessed');

    // A changed source/relink original is still refused, not silently admitted.
    writeFileSync(path.join(root, 'relink.original'), 'tampered relink\n');
    expect(() => stageBundledBun(root, path.join(root, 'output2'), input)).toThrow('material digest mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
