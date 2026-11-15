import { expect, it } from 'vitest';
import { inspectAfsVerifierRuntimeOriginals } from '../../scripts/lib/independent-admission/afs-verifier-runtime-originals';
it('requires the official private target issuer even for self-consistent executable and version JSON', () => {
  const executable = {sha256: 'a'.repeat(64), bytes: 42};
  const original = {target: 'darwin-arm64', version: '1.4.2', executableSha256: executable.sha256, executableBytes: executable.bytes, verified: true, readChecksums: () => Buffer.from('fabricated')};
  for (const value of [undefined, [], [original], [JSON.parse(JSON.stringify(original))]]) {
    const actual = inspectAfsVerifierRuntimeOriginals({target: 'darwin-arm64', executable, originals: value});
    expect(actual.verified).toBe(false);
    expect(actual.pending).toContain('afs-fresh-target-Bun-official-original-missing-or-ambiguous');
  }
});
