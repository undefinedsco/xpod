import {expect, it, vi} from 'vitest';

// Rejection protocol only. These fixtures cannot mint a production SDK/source
// capability or authenticate Debian signatures. Full byte math is tested in
// the Python ar/Packages/ZIP fixtures, independently of this private entry.
const f = vi.hoisted(() => ({sdk: {}, source: {}, view: undefined as unknown, input: undefined as unknown,
  signature: undefined as unknown, index: undefined as unknown, sourceView: undefined as unknown}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals', () => ({qleverSdkOriginalsView: (cap: unknown) => cap === f.sdk ? f.view : undefined}));
vi.mock('../../scripts/lib/independent-admission/source-context', () => ({derivedSourceView: (cap: unknown) => cap === f.source ? f.sourceView : undefined, assertDerivedSourceCurrent: () => {}}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-source', () => ({sdkVerifiedInputOriginalView: (cap: unknown) => cap === f.sdk ? f.input : undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-index', () => ({qleverSdkDebianIndexObservation: (cap: unknown) => cap === f.sdk ? f.index : undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-signature', () => ({qleverSdkDebianSignatureObservation: (cap: unknown) => cap === f.sdk ? f.signature : undefined}));
import {observeQleverSdkDebianBinaryOriginals, qleverSdkDebianBinaryObservation} from '../../scripts/lib/independent-admission/qlever-sdk-debian-binary';

it('rejects JSON signature/package/list declarations before any command or archive scan', async () => {
  const report = await observeQleverSdkDebianBinaryOriginals({identity: {}, official: true, packagesVerified: true}, {sourceSha: 'a'.repeat(40)});
  expect(report.pending[0]).toContain('same live SDK/source/installed-shard/signature/index');
  expect(report.facts.sdkWholeToolchainVerified).toBe(false);
  expect(qleverSdkDebianBinaryObservation({files: [], sdkSelectedDebianBinaryFilesVerified: true})).toBeUndefined();
});

it('fails closed when a same-SDK fixture lacks an independent signature or installed input observation', async () => {
  f.view = {originFacts: {sourceSha: 'a'.repeat(40)}};
  f.sourceView = {sourceSha: 'a'.repeat(40)};
  f.signature = {sdkDebianOfficialSignatureAndSuiteVerified: true};
  f.index = [{}];
  f.input = undefined;
  const report = await observeQleverSdkDebianBinaryOriginals(f.sdk, f.source);
  expect(report.pending[0]).toContain('same live SDK/source/installed-shard/signature/index');
  expect(qleverSdkDebianBinaryObservation(f.sdk)).toBeUndefined();
});
