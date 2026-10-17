import { describe, expect, it } from 'bun:test';
import { githubOriginFacts, githubOriginOriginals, observeAgentFsNativeGitHubOrigin, observeModuleProductGitHubOrigin, observeCliGitHubOrigin } from '../../scripts/lib/independent-admission/github-origin';

describe('controlled GitHub origin capability', () => {
  it('does not grant origin authority to offline JSON, hashes or cloned tokens', () => {
    for (const value of [undefined, null, {}, { passed: true }, { sourceSha: 'a'.repeat(40), sha256: 'b'.repeat(64) }, JSON.parse('{}')]) {
      expect(githubOriginFacts(value)).toBeUndefined();
    }
    expect(() => githubOriginOriginals({} as any)).toThrow('unknown observation capability');
  });
  it('rejects invalid coordinates before any transport', async () => {
    await expect(observeCliGitHubOrigin({ schemaVersion: 1, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      runId: 1, runAttempt: 0, artifactId: 1, artifactSha256: 'b'.repeat(64) })).rejects.toThrow('exact coordinates');
  });
  it('native observations reject unknown targets and extra selectors before transport', async () => {
    const tuple = { schemaVersion: 1 as const, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      runId: 1, runAttempt: 1, artifactId: 1, artifactSha256: 'b'.repeat(64) };
    await expect(observeAgentFsNativeGitHubOrigin(tuple, 'linux-riscv64')).rejects.toThrow('unsupported native target');
    await expect(observeAgentFsNativeGitHubOrigin({ ...tuple, workflowSha256: 'c'.repeat(64) } as any, 'linux-x64')).rejects.toThrow('unknown origin coordinate');
    await expect(observeAgentFsNativeGitHubOrigin(tuple, 'darwin-arm64', { fetch: () => {} } as any)).rejects.toThrow('invalid transport options');
  });
  it('module observations use canonical coverage before transport', async () => {
    const tuple = { schemaVersion: 1 as const, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      runId: 1, runAttempt: 1, artifactId: 1, artifactSha256: 'b'.repeat(64) };
    await expect(observeModuleProductGitHubOrigin(tuple, 'css', 'linux-x64')).rejects.toThrow('no declared native source');
    await expect(observeModuleProductGitHubOrigin(tuple, 'api', 'linux-riscv64')).rejects.toThrow('Unsupported product target');
    await expect(observeModuleProductGitHubOrigin(tuple, 'api', 'linux-x64', { fetch: () => {} } as any)).rejects.toThrow('invalid transport options');
  });
  it('has no caller transport or workflow policy override', async () => {
    const tuple = { schemaVersion: 1 as const, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      runId: 1, runAttempt: 1, artifactId: 1, artifactSha256: 'b'.repeat(64) };
    await expect(observeCliGitHubOrigin(tuple, { fetch: () => {} } as any)).rejects.toThrow('invalid transport options');
    await expect(observeCliGitHubOrigin(tuple, { token: 'bad\ntoken' })).rejects.toThrow('invalid transport options');
  });
});
