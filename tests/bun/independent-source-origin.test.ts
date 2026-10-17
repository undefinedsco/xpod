import { describe, expect, it } from 'bun:test';
import { githubOriginFacts, githubOriginOriginals, observeCliGitHubOrigin } from '../../scripts/lib/independent-admission/github-origin';

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
  it('has no caller transport or workflow policy override', async () => {
    const tuple = { schemaVersion: 1 as const, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
      runId: 1, runAttempt: 1, artifactId: 1, artifactSha256: 'b'.repeat(64) };
    await expect(observeCliGitHubOrigin(tuple, { fetch: () => {} } as any)).rejects.toThrow('invalid transport options');
    await expect(observeCliGitHubOrigin(tuple, { token: 'bad\ntoken' })).rejects.toThrow('invalid transport options');
  });
});
