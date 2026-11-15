/**
 * Unified operational regression: the composite source-causality placeholder
 * and its archive-not-applicable contract.
 *
 * SCOPE — SET-COMPOSITION unit semantics of `observeQleverSdkSourceAdmission`.
 * This is NOT real SDK qualification, NOT signature verification, NOT artifact
 * acceptance and NOT release evidence. The subordinate protocol observers are
 * fixture mocks; the mechanical byte inspection is the real production function
 * reading the real Debian receiver fixture. No production export is added, no
 * production guard is relaxed, and the compiler/SDK/candidate gates stay
 * independent and mandatory.
 *
 * TWO CONTRACTS UNDER TEST
 *  1. The composite token
 *     `qlever-sdk-generated-input-and-full-toolchain-source-causality-not-yet-verified`
 *     is added unconditionally by `inspectQleverSdkSourceOriginals()` and must be
 *     retired only by the aggregate's closed-axis rule, never by a waiver.
 *  2. The real private leaf has a SUPPORTED archive-not-applicable branch: when no
 *     signed-Debian tool origin exists at all it marks archive coverage verified
 *     with an explicit not-applicable scope and deliberately emits NO archive
 *     coordinates. A retirement rule keyed on an archive COUNT wrongly refuses it.
 *
 * The `COMPLETE_AXES_POSITIVE` case is EXPECTED TO FAIL on old S: S has no
 * retirement rule at all, so the composite token always remains. That is the
 * genuine red baseline, not a skip and not an accepted-failure marker. On the
 * proposed Q aggregate every case below passes.
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {expect,it,vi} from 'vitest';

const COMPOSITE = 'qlever-sdk-generated-input-and-full-toolchain-source-causality-not-yet-verified';

/** Fixture state. Subordinate observers return stable, identity-preserving
 *  observation objects, exactly as production compares them; nothing here is
 *  real private authority or an artifact capability. */
const fixture = vi.hoisted(() => {
  return {
    sdkOriginals: {} as object,
    source: {sourceSha: 'a'.repeat(40)} as object,
    // subordinate axes, each independently switchable
    generation: undefined as undefined | Readonly<Record<string, unknown>>,
    toolchain: undefined as undefined | Readonly<Record<string, unknown>>,
    toolchainLive: true,
    tools: undefined as undefined | Readonly<Record<string, unknown>>,
    signatureVerified: true,
    binaryVerified: true,
    signatureFacts: Object.freeze({sdkDebianOfficialSignatureAndSuiteVerified: true}) as Readonly<Record<string, unknown>>,
    binaryFiles: Object.freeze([]) as readonly unknown[],
    binaryScope: 'fixture',
    binaryObservation: undefined as undefined | Readonly<{files: readonly unknown[]; scope: string; unresolved: readonly unknown[]; assertCurrent(): void}>,
    calls: [] as string[],
  };
});

vi.mock('../../scripts/lib/independent-admission/source-context', () => ({
  derivedSourceView: () => fixture.source,
  assertDerivedSourceCurrent: () => {},
  bindDerivedSourceBudget: () => {},
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals', () => ({
  qleverSdkOriginalsView: () => fixture.sdkOriginals,
}));

// Mechanical input ownership is supplied here; the real serializer still runs.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-inputs', () => ({
  inspectSdkInputOwnership: () => ({
    requiredSources: [{name: 'foo', version: '1.0'}],
    unresolvedInputs: [],
    unresolvedSymlinkOriginalTargets: [],
  }),
}));
// The build-execution original is an independent axis; this fixture observes no
// process execution, so it is reported as an explicit typed unobserved phase.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-execution', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../scripts/lib/independent-admission/qlever-sdk-execution');
  return {...actual, inspectSdkBuildExecution: () => { throw new (actual.SdkTrackedPhaseOriginalsUnobserved as new (e?: unknown) => Error)(undefined); }};
});
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-symlinks', () => ({
  inspectSdkSymlinkOriginals: () => ({unresolved: [], links: []}),
}));

vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-index', () => ({
  observeQleverSdkDebianIndexOriginals: async () => {
    fixture.calls.push('index');
    return {facts: {sdkDebianInReleaseSourcesDscChecksumChainVerified: true},
            pending: ['qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified']};
  },
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-signature', () => {
  // Production compares the getter result with the reported `facts` object by
  // IDENTITY, so this fixture reports and returns one stable object.
  const failed = Object.freeze({}) as Readonly<Record<string, unknown>>;
  return {
    observeQleverSdkDebianSignatureOriginals: async () => {
      fixture.calls.push('signature');
      return fixture.signatureVerified
        ? {facts: fixture.signatureFacts, pending: []}
        : {facts: failed, pending: ['fixture-signature-not-verified']};
    },
    qleverSdkDebianSignatureObservation: () => (fixture.signatureVerified ? fixture.signatureFacts : undefined),
  };
});
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-binary', () => {
  // Production compares `facts.sdkDebianBinaryFiles` and `…Scope` with the
  // getter's fields, so both sides must be the same stable values.
  return {
    observeQleverSdkDebianBinaryOriginals: async () => {
      fixture.calls.push('binary');
      return fixture.binaryVerified
        ? {facts: {sdkSelectedDebianBinaryFilesVerified: true,
                   sdkDebianBinaryFiles: fixture.binaryFiles,
                   sdkDebianBinaryScope: fixture.binaryScope},
           pending: []}
        : {facts: {sdkSelectedDebianBinaryFilesVerified: false}, pending: ['fixture-binary-not-verified']};
    },
    qleverSdkDebianBinaryObservation: () => fixture.binaryObservation,
  };
});
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-generation', () => ({
  observeQleverSdkGeneratedInputOriginals: async () => {
    fixture.calls.push('generation');
    return {facts: fixture.generation ?? {}, pending: []};
  },
  qleverSdkExecutionOriginalObservation: () => fixture.generation,
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-upstream-source', () => ({
  observeQleverSdkUpstreamGitOriginals: async () => {
    fixture.calls.push('upstream');
    return {facts: {sdkUpstreamGitCommitTreePreimageClosureVerified: true,
                    sdkUpstreamReviewedPatchProjectionVerified: true,
                    sdkSelectedUpstreamInputOriginalsVerified: true}, pending: []};
  },
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-observed-tools', () => ({
  observeQleverSdkObservedToolOriginals: async () => {
    fixture.calls.push('tools');
    const current = fixture.tools;
    return current
      ? {facts: current, pending: [], assertCurrent: () => {
          if (fixture.tools !== current) throw Error('tool observation custody changed');
        }}
      : {facts: {}, pending: []};
  },
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-toolchain-source', () => ({
  observeQleverSdkToolchainSourceOriginals: async () => {
    fixture.calls.push('toolchain');
    const current = fixture.toolchain;
    return current
      ? {facts: current, pending: [], assertCurrent: () => {
          if (!fixture.toolchainLive || fixture.toolchain !== current) throw Error('toolchain custody changed');
        }}
      : {facts: {}, pending: []};
  },
}));

import {inspectQleverSdkSourceOriginals, observeQleverSdkSourceAdmission, qleverSdkSourceAdmissionView} from '../../scripts/lib/independent-admission/qlever-sdk-source';

const root = path.resolve(__dirname, '../..');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Real Debian receiver fixture + the real mechanical inspector. */
function mechanicalOriginals(temporary: string) {
  const info = JSON.parse(execFileSync('/usr/bin/python3', ['-B', 'qlever/tests/sdk_source_composite_fixture.py', temporary], {cwd: root, encoding: 'utf8'}));
  const originals = new Map<string, Buffer>();
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name + '/');
      else originals.set(name, readFileSync(path.join(directory, entry.name)));
    }
  };
  visit(info.root);
  const reference = (name: string) => {
    const bytes = originals.get(name)!;
    return {path: name, bytes: bytes.length, sha256: sha(bytes)};
  };
  const master = JSON.parse(originals.get('materials.json')!.toString());
  const afterName = master.inputs.after.path;
  const after = JSON.parse(originals.get(afterName)!.toString());
  after.files ??= [];
  originals.set(afterName, Buffer.from(JSON.stringify(after)));
  master.inputs.after = reference(afterName);
  // The master is itself an original: its bytes must carry the updated reference,
  // otherwise the reader sees a ref/byte mismatch instead of the defect under test.
  const previousMaster = originals.get('materials.json')!;
  originals.set('materials.json', Buffer.from(JSON.stringify(master)));
  if (originals.get('materials.json')!.equals(previousMaster)) throw Error('fixture master mutation was not applied');
  const jobsData = Buffer.from(JSON.stringify({jobs: [{id: 17, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z'}]}));
  const view = {
    masterReference: reference('materials.json'),
    originFacts: {sourceSha: 'a'.repeat(40), target: 'linux-x64', producerJobId: 17,
                  originals: [{name: 'jobs.original.json', bytes: jobsData.length, sha256: sha(jobsData)}]},
    metadataOriginals: [{name: 'jobs.original.json', data: jobsData}],
    members: [...originals.keys()].map(reference),
    readOriginal: (name: string) => originals.get(name),
    readOriginalRange: (name: string, offset: number, length: number) => originals.get(name)!.subarray(offset, offset + length),
  };
  const capability = Object.freeze(Object.create(null));
  fixture.sdkOriginals = view;
  fixture.source = {sourceSha: 'a'.repeat(40)};
  return {capability, view, info, originals};
}

/** Every subordinate axis genuinely complete (as far as this fixture can express). */
function completeAxes() {
  fixture.signatureVerified = true;
  fixture.binaryVerified = true;
  fixture.binaryObservation = Object.freeze({files: fixture.binaryFiles, scope: fixture.binaryScope,
                                              unresolved: Object.freeze([]), assertCurrent: () => {}});
  fixture.toolchainLive = true;
  fixture.generation = Object.freeze({
    sdkActualConfigureCompileTrackedWaitVerified: true,
    sdkGeneratedInputIoClosureVerified: true,
    sdkGeneratedInputIoClosureExceptDependencyOriginVerified: true,
  });
  fixture.tools = Object.freeze({sdkObservedToolAfterShardBytesVerified: true, sdkObservedToolsSignedDebianBinaryBytesVerified: true});
  // A genuinely verified signed-Debian toolchain reports a NON-EMPTY operation
  // set and one source-archive coordinate per signed tool source tuple; these are
  // the same facts the real leaf emits when it computes closures from the join.
  fixture.toolchain = Object.freeze({
    sdkToolchainSourceClosureVerified: true,
    sdkToolchainOperationCount: 3,
    sdkToolchainGeneratedProducerCreditedCount: 0,
    sdkToolchainSourceArchiveCoordinates: Object.freeze([
      Object.freeze({name: 'libfoo', version: '1.0'}),
    ]),
    sdkToolchainSourceArchiveScope: 'same-SDK signed Sources to complete DSC/archive byte sets for actual signed tool files only',
  });
  fixture.calls = [];
}

it('COMPLETE_AXES_POSITIVE: all real axes complete must admit, but an unconditional composite placeholder blocks it', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability, view} = mechanicalOriginals(temporary);
    completeAxes();
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});

    // The mechanical producer really ran and really reports complete Debian custody.
    expect(admission.facts.debianDscAndAllSourceArchiveBytesVerified, String(admission.pending)).toBe(true);
    expect(admission.facts.sdkOwnedDebianInputSourceArchivesComplete).toBe(true);
    // Every required axis is satisfied on this fixture...
    expect(admission.facts.sdkSourceRequiredAxes).toEqual({
      inputOriginals: true, preparedDependencySources: true, configureCompileExecution: true,
      ownedDebianSourceArchives: true, upstreamGitPreimages: true, reviewedPatchProjection: true,
      selectedUpstreamInputOriginals: true, generatedInputIoClosure: true, toolchainSourceClosure: true,
    });
    // ...and yet admission is refused, with the composite placeholder as the residue.
    expect(Object.keys(view).length).toBeGreaterThan(0);
    expect(admission.pending, `unexpected leftover pending: ${JSON.stringify(admission.pending)}`).toEqual([]);
    expect(admission.facts.sdkSourceCompletenessVerified, `leftover pending: ${JSON.stringify(admission.pending)}`).toBe(true);
    expect(admission.verified, `blocked only by: ${JSON.stringify(admission.pending)}`).toBe(true);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('MISSING_REAL_AXIS_NEGATIVE: a genuinely incomplete subordinate axis stays refused', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    completeAxes();
    // The toolchain source closure is a real requirement: without it no admission.
    fixture.toolchain = Object.freeze({sdkToolchainSourceClosureVerified: false});
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect(admission.verified).toBe(false);
    expect((admission.facts.sdkSourceRequiredAxes as any).toolchainSourceClosure).toBe(false);
    expect(admission.facts.sdkSourceCompletenessVerified).toBe(false);
    // The composite placeholder names exactly "generated input closure AND full
    // toolchain source causality not yet verified", so while EITHER constituent
    // obligation is unmet it must still be present. This is what separates a
    // legitimate retirement (derive from the real axes) from a waiver (delete the
    // placeholder outright): a waiver would drop the token here too.
    expect(admission.pending).toContain(COMPOSITE);
    // Generated-input closure is likewise load-bearing on its own.
    completeAxes();
    fixture.generation = Object.freeze({sdkActualConfigureCompileTrackedWaitVerified: true,
                                        sdkGeneratedInputIoClosureVerified: false,
                                        sdkGeneratedInputIoClosureExceptDependencyOriginVerified: true});
    const noGeneration = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect(noGeneration.verified).toBe(false);
    expect((noGeneration.facts.sdkSourceRequiredAxes as any).generatedInputIoClosure).toBe(false);
    expect(noGeneration.pending).toContain(COMPOSITE);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('UNEXPECTED_INDEPENDENT_PENDING_NEGATIVE: an unrelated pending still refuses admission', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    completeAxes();
    // A signature axis that is honestly unverified contributes its own pending.
    fixture.signatureVerified = false;
    fixture.binaryObservation = undefined;
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect(admission.verified).toBe(false);
    expect(admission.pending).toContain('fixture-signature-not-verified');
    expect(admission.pending).toContain('qlever-sdk-Debian-binary-signature-prerequisite-unverified');
    expect(admission.facts.sdkSelectedDebianBinaryFilesVerified).toBe(false);
    // This refusal must survive independently of the composite placeholder:
    // the genuine per-axis obligation is what keeps it closed.
    expect(admission.facts.sdkSourceRequiredAxes).not.toEqual(
      expect.objectContaining({ownedDebianSourceArchives: true}));
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('WRONG_OR_STALE_HANDLE_NEGATIVE: the issued admission is identity-sensitive', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    completeAxes();
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    // The sealed view is gated on exactly `verified` and nothing looser: it can
    // resolve only for this very object, through these very two handles. On the
    // current source `verified` is false solely because of the composite
    // placeholder, so the genuine handle is withheld too -- the invariant below
    // states that relation without encoding today's defect value.
    const genuine = qleverSdkSourceAdmissionView(admission, {sdkOriginals: capability, source: fixture.source});
    expect(Boolean(genuine)).toBe(admission.verified);
    // Caller JSON, structural copies, relabelled copies and wrong handles never resolve.
    expect(qleverSdkSourceAdmissionView(JSON.parse(JSON.stringify({...admission, verified: true})), {sdkOriginals: capability, source: fixture.source})).toBeUndefined();
    expect(qleverSdkSourceAdmissionView({...admission, verified: true}, {sdkOriginals: capability, source: fixture.source})).toBeUndefined();
    expect(qleverSdkSourceAdmissionView(admission, {sdkOriginals: {}, source: fixture.source})).toBeUndefined();
    expect(qleverSdkSourceAdmissionView(admission, {sdkOriginals: capability, source: {sourceSha: 'a'.repeat(40)}})).toBeUndefined();
    expect(qleverSdkSourceAdmissionView(undefined, {sdkOriginals: capability, source: fixture.source})).toBeUndefined();
    // A changed subordinate observation invalidates the previously issued handle.
    fixture.toolchainLive = false;
    expect(() => admission.assertCurrent()).toThrow('toolchain custody changed');
    fixture.toolchainLive = true;
    admission.assertCurrent();
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('REQUIRED_ARCHIVE_GAP_NEGATIVE: a genuinely unverified archive join must refuse', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    completeAxes();
    // The leaf's own failure shape: toolchain source closure is NOT verified and
    // it carries the real archive-join pending. This is a genuine unmet
    // obligation and must stay refused -- the point is that removing the
    // aggregate archive-count proxy must not open a real archive gap.
    fixture.toolchain = Object.freeze({
      sdkToolchainSourceClosureVerified: false,
      sdkToolchainOperationCount: 3,
      sdkToolchainSourceArchiveCoordinates: Object.freeze([Object.freeze({name: 'libfoo', version: '1.0'})]),
    });
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect((admission.facts.sdkSourceRequiredAxes as any).toolchainSourceClosure).toBe(false);
    expect(admission.verified).toBe(false);
    expect(admission.pending).toContain(COMPOSITE);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('NONVACUOUS_OPERATION_COUNTER_NEGATIVE: missing or empty toolchainOperations must refuse', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    // Missing counter: the aggregate cannot prove nonvacuity.
    completeAxes();
    fixture.toolchain = Object.freeze({sdkToolchainSourceClosureVerified: true});
    const absent = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect(absent.verified).toBe(false);
    expect(absent.pending).toContain(COMPOSITE);

    // Explicitly zero: likewise vacuous.
    completeAxes();
    fixture.toolchain = Object.freeze({
      sdkToolchainSourceClosureVerified: true,
      sdkToolchainOperationCount: 0,
      sdkToolchainSourceArchiveCoordinates: Object.freeze([Object.freeze({name: 'libfoo', version: '1.0'})]),
    });
    const empty = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect(empty.verified).toBe(false);
    expect(empty.pending).toContain(COMPOSITE);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

it('ARCHIVE_NOT_APPLICABLE: a verified toolchain with no signed-Debian tool origin is not an unmet obligation', async () => {
  mkdirSync(path.join(root, '.test-data'), {recursive: true});
  const temporary = mkdtempSync(path.join(root, '.test-data/sdk-source-composite-'));
  try {
    const {capability} = mechanicalOriginals(temporary);
    completeAxes();
    // EXACT shape the real Q leaf returns on its supported n/a branch: archive
    // coverage verified, explicit not-applicable scope, and NO coordinates.
    fixture.toolchain = Object.freeze({
      sdkToolchainSourceClosureVerified: true,
      sdkToolchainOperationCount: 3,
      sdkToolchainExactSourceArchiveCoverageVerified: true,
      sdkToolchainSourceArchiveScope: 'not applicable: no signed-Debian tool origin in this SDK',
    });
    const admission = await observeQleverSdkSourceAdmission({sdkOriginals: capability, source: fixture.source, remainingMilliseconds: 10000});
    expect((admission.facts.sdkSourceRequiredAxes as any).toolchainSourceClosure,
      'the closed toolchain axis already carries the leaf private join').toBe(true);
    expect((admission.facts as any).sdkToolchainSourceArchiveCoordinates,
      'the leaf deliberately emits no coordinates on the n/a branch').toBeUndefined();
    expect(admission.pending, `leftover pending: ${JSON.stringify(admission.pending)}`).toEqual([]);
    expect(admission.verified,
      `blocked by: ${JSON.stringify(admission.pending)}`).toBe(true);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});
