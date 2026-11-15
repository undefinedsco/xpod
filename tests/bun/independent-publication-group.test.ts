import { expect, test } from 'bun:test';
import { validatePublicationGroupSelectors } from '../../scripts/lib/independent-admission/publication-group';
const selector = { module: 'client' as const, sourceSha: 'a'.repeat(40), runHeadSha: 'b'.repeat(40), runId: 1, runAttempt: 1, artifactId: 2, artifactSha256: 'c'.repeat(64) };
test('group factory selectors never accept versions tags approvals or filesystem transport', () => {
  expect(() => validatePublicationGroupSelectors([selector])).not.toThrow();
  for (const extra of [{ version: '1.0.0' }, { tag: 'latest' }, { approved: true }, { path: '/tmp/archive' }]) {
    expect(() => validatePublicationGroupSelectors([{ ...selector, ...extra } as any])).toThrow('unknown');
  }
  expect(() => validatePublicationGroupSelectors([selector, selector])).toThrow('duplicate');
  expect(() => validatePublicationGroupSelectors([{ ...selector, target: 'darwin-arm64' } as any])).toThrow('target');
});
