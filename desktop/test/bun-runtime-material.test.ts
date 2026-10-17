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
    const descriptor = JSON.parse(readFileSync(input, 'utf8'));
    writeFileSync(input, JSON.stringify({ ...descriptor, mode: 'release' }));
    expect(() => stageBundledBun(root, output, input)).toThrow('incomplete');
    writeFileSync(input, JSON.stringify({ ...descriptor, target: 'linux-x64' }));
    expect(() => stageBundledBun(root, output, input)).toThrow('target');
    writeFileSync(input, JSON.stringify({ ...descriptor, authoritySha256: '0'.repeat(64) }));
    expect(() => stageBundledBun(root, output, input)).toThrow('authority digest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
