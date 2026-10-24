import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {assertLegalFileIdentity, type LegalFileIdentity} from './legal-file-custody';
import {inspectRetainedDebianGpgvExit,inspectDebianSignaturePolicyOriginals} from './debian-signature-policy-bridge';
import {hashSignatureControllerFile, readSignatureOriginal, assertSignatureOriginalSet} from './qlever-signature-original-custody';
import {debianReleaseKeyPolicies,debianSignatureFamilyForSdkProfile,type DebianReleaseFamily, inspectDebianPublicKeyOriginal, extractDebianSignedRelease} from './qlever-debian-signature-policy';

type Ref = {path: string; bytes: number; sha256: string};
type Stage = {name: string; receipt: Ref; supervisionReceipt: Ref};
type Collection = {schemaVersion: number; kind: string; indexOriginals: {inRelease: Ref; sources: Ref; verificationStage: Stage}[]};
type Master = {identity?:{sdkProfile?:unknown};kind: string; debianSources?: Ref; stages: Stage[]};
type CommandOutcome = {code: number; signal: unknown; actualWait: boolean; actualClose: boolean; groupAbsent: boolean; rawComplete: boolean; rawClosedBeforeHash: boolean; pipeEOF: boolean[]; failure: unknown; spawnError: unknown; raw: Ref[]};
const {runPublicationCommand} = createRequire(import.meta.url)('../afs-publication-command.cjs') as {
  runPublicationCommand(command: string, args: string[], options: {cwd: string; env: Record<string, string>; evidence: string; label: string; timeoutMs: number; rawLimit: number}): Promise<CommandOutcome>;
};
type SdkView = NonNullable<ReturnType<typeof qleverSdkOriginalsView>>;
/** Structural reader view supplied by a genuine private collector. It is not
 * a capability: this module never mints one from JSON or copied SDK data. */
export type DebianSignatureReader = Readonly<{
  members: readonly Readonly<{path: string; bytes: number; sha256: string}>[];
  readOriginal(path: string, maximum: number): Buffer;
  masterReference: Readonly<{path: string; bytes: number; sha256: string}>;
  originFacts: Readonly<{sourceSha?: string; target?: string; producerJobId: number;
    originals: readonly Readonly<{name: string; bytes: number; sha256: string}>[]}>;
  metadataOriginals: readonly Readonly<{name: string; data: Buffer}>[];
  kind: 'qlever-linux-sdk-originals' | 'candidate-service-native-runtime-originals';
  sdkProfile?: unknown;
}>;
export type DebianSignaturePrerequisites = Readonly<{
  indexInRelease: readonly Readonly<{
    sha256: string;
    sourceOriginal: Readonly<{path: string; bytes: number; sha256: string}>;
    signedIndexMatches: readonly Readonly<{path: string; form: string}>[];
  }>[];
}>;
export type DebianSignatureCoreResult = Readonly<{
  facts: Readonly<Record<string, unknown>>;
  pending: readonly string[];
  retainedDirectory?: string;
  assertCurrent?: () => void;
}>;
/** Bounded signature core. Inputs must already be genuine private reader views;
 * this function issues no SDK observation and writes no SDK WeakMap. */
export async function inspectDebianSignatureCore(input: {
  reader: DebianSignatureReader;
  prerequisites: DebianSignaturePrerequisites;
  remainingMs: number;
  check(cost?: number): void;
  current(): void;
}): Promise<DebianSignatureCoreResult> {
  return observeSignatureCore({
    reader: input.reader,
    prerequisites: input.prerequisites,
    remainingMs: input.remainingMs,
    check: input.check,
    current: input.current,
    persist: undefined,
  });
}
const saved = new WeakMap<object, {view: SdkView; facts: Readonly<Record<string, unknown>>; guards: readonly LegalFileIdentity[]; originals: readonly LegalFileIdentity[]; directory: string}>();
export function qleverSdkDebianSignatureObservation(capability: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!capability || typeof capability !== 'object') return undefined; const record = saved.get(capability); if (!record) return undefined;
  need(qleverSdkOriginalsView(capability) === record.view, 'signature SDK custody changed');
  for (const guard of record.guards) assertLegalFileIdentity(guard); assertSignatureOriginalSet(record.directory, record.originals); return record.facts;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function need(value: unknown, why: string): asserts value {if (!value) throw Error('SDK Debian signature: ' + why);}

/** The retained controller keyring this SDK artifact actually verified with.
 *
 * The producer preserves the exact Debian keyring it ran gpgv against
 * (`/usr/share/keyrings/debian-archive-keyring.gpg`) inside
 * `inner/debian-source/indexes/`, and the receiver roots it. Feeding THAT
 * retained original to the reviewed gpgv core, and then requiring the resulting
 * VALIDSIG primary+signing fingerprints to equal the frozen reviewed policy,
 * is a strictly stronger anchor than re-downloading the same keys: the keyring
 * is the same private byte identity the producer used, and the policy check on
 * the signature proves the reviewed key validated THIS InRelease.
 *
 * No binary key parser is introduced (no second, weaker decoder): the existing
 * gpgv core remains the only signature authority. */
export function inspectRetainedControllerKeyring(reader: DebianSignatureReader, collection: Collection,
  members: ReadonlyMap<string, Readonly<{path: string; bytes: number; sha256: string}>>):
  Readonly<{ref: Ref; bytes: Buffer; identities: readonly Ref[]}> | undefined {
  // EVERY index row must name a retained keyring, and ALL of them must be the
  // exact same original. The producer acquires one keyring per collection and
  // reuses it for every suite, so an artifact that named two different keyrings
  // would otherwise let this adapter verify some suites with one trust root and
  // silently ignore the rest. Bind all identities or refuse.
  const identities: Ref[] = [];
  const seen = new Set<string>();
  for (const entry of collection.indexOriginals) {
    const ref = (entry as {keyring?: Ref}).keyring;
    need(ref, 'every index row must carry its retained keyring original');
    need(typeof ref.path === 'string' && ref.path.length > 0 && Number.isSafeInteger(ref.bytes)
      && ref.bytes > 0 && /^[a-f0-9]{64}$/u.test(String(ref.sha256)), 'typed retained keyring reference required');
    const key = ref.path + '\0' + ref.bytes + '\0' + ref.sha256;
    if (seen.has(key)) continue;
    seen.add(key);
    const actual = members.get(ref.path);
    need(actual && actual.bytes === ref.bytes && actual.sha256 === ref.sha256, 'retained keyring original reference differs');
    need(ref.bytes <= 4 * 1024 ** 2, 'retained keyring original bound');
    identities.push(Object.freeze({path: ref.path, bytes: ref.bytes, sha256: ref.sha256}));
  }
  need(identities.length > 0, 'retained controller keyring original unavailable');
  // Distinct paths are allowed only if they are byte-identical originals; two
  // different trust roots would make "one keyring for every suite" unsound.
  const first = identities[0]!;
  for (const row of identities)
    need(row.sha256 === first.sha256 && row.bytes === first.bytes,
      'all index rows must bind one identical retained keyring original');
  const bytes = reader.readOriginal(first.path, 4 * 1024 ** 2);
  need(bytes.length === first.bytes && hash(bytes) === first.sha256, 'retained keyring original bytes differ');
  return Object.freeze({ref: first, bytes, identities: Object.freeze(identities)});
}

/** Materialize the retained keyring into the owned observation directory and
 * guard its exact identity for the whole observation.
 *
 * There is deliberately NO second clock here. `check` is the SAME monotonic
 * budget owned by `observeSignatureCore` (`performance.now() < deadline`); a
 * private wall-clock reading would be a different domain entirely (Date.now()
 * is ~1.7e12 while performance.now() is process-relative), which made this
 * function always throw in real execution. Routing every wait through `check`
 * keeps one monotonic clock source and adds no new allowance. */
export function officialKeys(directory: string, check: () => void,
  retained: Readonly<{ref: Ref; bytes: Buffer}>) {
  check();
  const keyring = path.join(directory, 'reviewed-keys.gpg');
  fs.writeFileSync(keyring, retained.bytes, {flag: 'wx', mode: 0o400});
  const keyIdentity = readSignatureOriginal(keyring,
    {bytes: retained.bytes.length, sha256: hash(retained.bytes)}, 4 * 1024 ** 2, check).identity;
  return {originals: Object.freeze([retained.ref]), keyringSha256: retained.ref.sha256, keyIdentity,
    guards: Object.freeze([keyIdentity])};
}
/** Core: same controller gpgv/key policy/retries for SDK and native readers.
 * No WeakMap write happens here. */
async function observeSignatureCore(input: {
  reader: DebianSignatureReader;
  prerequisites: DebianSignaturePrerequisites;
  remainingMs: number;
  check(cost?: number): void;
  current(): void;
  persist?: (value: {facts: Readonly<Record<string, unknown>>;
    guards: readonly LegalFileIdentity[]; originals: readonly LegalFileIdentity[];
    directory: string}) => void;
}) {
  const {reader, prerequisites, remainingMs} = input;
  const called = performance.now(), facts: Record<string, unknown> = {}, pending: string[] = []; let retainedDirectory: string | undefined; let activeGroup: {started: number; count: number; active: boolean} | undefined;
  let assertCurrent: (() => void) | undefined;
  try {
    need(Number.isFinite(remainingMs) && remainingMs >= 1 && performance.now() < called + Math.min(remainingMs, 120000), 'shared source deadline expired');
    const deadline = called + Math.min(remainingMs, 120000);
    const check = () => {input.check(); need(performance.now() < deadline, 'shared source deadline expired');};
    need(process.platform === 'linux' && fs.existsSync('/usr/bin/gpgv'), 'trusted Linux controller /usr/bin/gpgv unavailable');
    const executable = fs.realpathSync('/usr/bin/gpgv'), tool = hashSignatureControllerFile(executable, check);
    const members = new Map(reader.members.map(row => [row.path, row]));
    const read = (reference: Ref, maximum = 4 * 1024 ** 2) => {check(); const actual = members.get(reference?.path);
      need(actual && actual.bytes === reference.bytes && actual.sha256 === reference.sha256 && actual.bytes <= maximum, 'same SDK original reference required');
      const bytes = reader.readOriginal(actual.path, maximum); need(bytes.length === actual.bytes && hash(bytes) === actual.sha256, 'SDK original bytes differ'); return bytes;};
    const master = JSON.parse(read(reader.masterReference, 8 * 1024 ** 2).toString()) as Master;
    need((master.kind === 'qlever-linux-sdk-originals' || master.kind === 'candidate-service-native-runtime-originals') && master.debianSources && Array.isArray(master.stages), 'actual Debian collection unavailable');
    const family = debianSignatureFamilyForSdkProfile(master.identity?.sdkProfile);
    const declared = reader.sdkProfile;
    need(declared === undefined ? family === 'bookworm' : debianSignatureFamilyForSdkProfile(declared) === family, 'private reader/master profile differs');
    if (reader.kind === 'candidate-service-native-runtime-originals') need(declared === 'service-trixie' && master.identity?.sdkProfile === 'service-trixie', 'native service-trixie profile required');
    const collection = JSON.parse(read(master.debianSources).toString()) as Collection;
    need(collection.schemaVersion === 1 && collection.kind === 'qlever-sdk-exact-debian-source-originals' && Array.isArray(collection.indexOriginals) && collection.indexOriginals.length > 0 && collection.indexOriginals.length <= 32, 'bounded actual index set required');
    const jobs = reader.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row => {
      const original = reader.originFacts.originals.find(value => value.name === row.name);
      need(original?.sha256 === hash(row.data) && original.bytes === row.data.length, 'actual job API bytes differ');
      return (JSON.parse(row.data.toString()) as {jobs: {id: number; started_at: string; completed_at: string}[]}).jobs;
    }).filter(row => row.id === reader.originFacts.producerJobId);
    need(jobs.length === 1, 'unique actual SDK job required'); const jobStart = Date.parse(jobs[0]!.started_at), jobEnd = Date.parse(jobs[0]!.completed_at);
    need(Number.isFinite(jobStart) && Number.isFinite(jobEnd) && jobStart <= jobEnd, 'actual job window required');
    const root = fileURLToPath(new URL('../../../.test-data/debian-controller-signatures/', import.meta.url));
    fs.mkdirSync(root, {recursive: true, mode: 0o700}); const free = fs.statfsSync(root, {bigint: true}); need(free.bavail * free.bsize >= 1024n ** 3n + 16n * 1024n ** 2n, 'controller signature free floor');
    retainedDirectory = fs.mkdtempSync(path.join(root, 'observation-')); fs.mkdirSync(path.join(retainedDirectory, 'empty-home'), {mode: 0o700});
    const checksumRows = prerequisites.indexInRelease;
    need(checksumRows.length, 'prior private Debian index checksum observation required');
    need(collection.indexOriginals.every(entry => checksumRows.some(row => row.sha256 === entry.inRelease.sha256 && row.sourceOriginal.path === entry.sources.path && row.sourceOriginal.bytes === entry.sources.bytes && row.sourceOriginal.sha256 === entry.sources.sha256)), 'private checksum index originals differ');
    // LOCAL ADAPTER: verify with the RETAINED private keyring THIS SDK artifact
    // actually used. The reviewed gpgv core plus the frozen VALIDSIG policy
    // fingerprints below are the trust decision; no verification-time network.
    const retained = inspectRetainedControllerKeyring(reader, collection, members);
    need(retained, 'retained controller keyring original unavailable');
    const keys = officialKeys(retainedDirectory, check, retained);
    const keyring = path.join(retainedDirectory, 'reviewed-keys.gpg');
    const keyIdentity = keys.keyIdentity, originalGuards = [...keys.guards];
    const env = {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GNUPGHOME: path.join(retainedDirectory, 'empty-home')};
    const command = async (label: string, args: string[], permitUnknownCosignature = false) => {check(); assertLegalFileIdentity(tool.identity); assertLegalFileIdentity(keyIdentity);
      let outcome: CommandOutcome;
      try {outcome = await runPublicationCommand(executable, args, {cwd: retainedDirectory!, env, evidence: retainedDirectory!, label,
        timeoutMs: Math.max(1, Math.min(15000, Math.floor(deadline - performance.now()))), rawLimit: 65536});} catch (error) {
        const failed = error && typeof error === 'object' && 'outcome' in error ? (error as {outcome: CommandOutcome}).outcome : undefined;
        if (!permitUnknownCosignature || failed?.code !== 2) throw error; outcome = failed;
      }
      check(); assertLegalFileIdentity(tool.identity); assertLegalFileIdentity(keyIdentity);
      need((outcome.code === 0 || permitUnknownCosignature && outcome.code === 2) && !outcome.failure && !outcome.spawnError && !outcome.signal && outcome.actualWait && outcome.actualClose && outcome.groupAbsent && outcome.rawComplete && outcome.rawClosedBeforeHash && outcome.pipeEOF?.every(Boolean), 'controller gpgv execution did not close');
      const raw = ['stdout', 'stderr'].map((kind, index) => {
        const reference = outcome.raw[index], file = path.join(retainedDirectory!, label + '.' + kind + '.raw.log');
        need(reference?.path === path.basename(file) && reference.bytes <= 65536, 'controller closed raw role differs');
        const observed = readSignatureOriginal(file, reference, 65536, check); originalGuards.push(observed.identity); return observed.bytes;
      });
      const receiptBytes = Buffer.from(JSON.stringify(outcome, null, 2) + '\n');
      originalGuards.push(readSignatureOriginal(path.join(retainedDirectory!, label + '.receipt.json'), {bytes: receiptBytes.length, sha256: hash(receiptBytes)}, 65536, check).identity);
      return {status: raw[0]!, exit: outcome.code};};
    const {status: version} = await command('controller-gpgv-version', ['--version']); need(/^gpgv \(GnuPG\) 2\./u.test(version.toString()), 'reviewed controller gpgv major required');
    const observations = [], seen = new Set<string>(); let releaseBytes = 0;
    for (const [index, entry] of collection.indexOriginals.entries()) {
      check(); if (seen.has(entry.inRelease.path)) continue; seen.add(entry.inRelease.path);
      const stage = entry.verificationStage; need(master.stages.filter(row => isDeepStrictEqual(row, stage)).length === 1 && /^debian-index-[0-9]+$/u.test(stage.name), 'actual acquisition stage differs');
      const receipt = JSON.parse(read(stage.receipt).toString()) as Record<string, unknown>, supervision = JSON.parse(read(stage.supervisionReceipt).toString()) as Record<string, unknown>;
      const acquisition = Date.parse(String(supervision.startedUTC)), closed = Date.parse(String(supervision.closedUTC));
      need(jobStart <= acquisition && acquisition <= closed && closed <= jobEnd && receipt.actualWait === true && inspectRetainedDebianGpgvExit(receipt.exit, supervision.exit) === receipt.exit && receipt.signal === null && supervision.actualWait === true && supervision.signal === null && supervision.ownedGroupAbsentAfterWait === true, 'actual acquisition outside closed SDK job');
      const original = read(entry.inRelease); releaseBytes += original.length; need(releaseBytes <= 8 * 1024 ** 2, 'retained Release aggregate bound');
      const freeNow = fs.statfsSync(retainedDirectory, {bigint: true}); need(freeNow.bavail * freeNow.bsize >= 1024n ** 3n + BigInt(original.length) * 2n + 512n * 1024n, 'controller signature remaining floor');
      const source = path.join(retainedDirectory, 'inrelease-' + index + '.original'); fs.writeFileSync(source, original, {flag: 'wx', mode: 0o400});
      const sourceIdentity = readSignatureOriginal(source, {bytes: original.length, sha256: hash(original)}, 4 * 1024 ** 2, check).identity; originalGuards.push(sourceIdentity);
      const bodyPath = path.join(retainedDirectory, 'signed-body-' + index + '.original');
      const {status, exit} = await command('controller-gpgv-' + index, ['--homedir', env.GNUPGHOME, '--keyring', keyring, '--status-fd', '1', '--output', bodyPath, source], true); assertLegalFileIdentity(sourceIdentity);
      const indexPaths = checksumRows.filter(row => row.sha256 === entry.inRelease.sha256).flatMap(row => row.signedIndexMatches.map(match => match.path));
      const signedBody = extractDebianSignedRelease(original);
      const body = readSignatureOriginal(bodyPath, {bytes: signedBody.length, sha256: hash(signedBody)}, 4 * 1024 ** 2, check); originalGuards.push(body.identity);
      const classified = inspectDebianSignaturePolicyOriginals({inRelease: original, status, plaintext: body.bytes, acquisitionUTC: acquisition, indexPaths, exit,family});
      observations.push(Object.freeze({inRelease: entry.inRelease, acquisitionUTC: acquisition, ...classified}));
    }
    check(); input.current(); need(hashSignatureControllerFile(executable, check).sha256 === tool.sha256, 'controller custody changed');
    facts.sdkDebianSignatureOriginals = Object.freeze({scope: 'controller-OS-gpgv-reviewed-'+family+'-keys-and-actual-job-suite',family, executable, executableSha256: tool.sha256,
      version: version.toString(), keys: Object.freeze(keys.originals), keyringSha256: keys.keyringSha256,
      keyringOriginal: retained.ref,
      keyringIndexIdentities: retained.identities,
      keySourceScope: 'retained private controller keyring from this SDK artifact; every index row bound to one identical original; reviewed by the frozen VALIDSIG primary/signing fingerprint policy',
      keyLifecycleScope: 'fixed-reviewed-key-snapshot-and-expiration-policy; not independent current revocation proof',
      observations: Object.freeze(observations), retainedDirectory});
    const guards = [tool.identity, ...originalGuards];
    check(); input.current(); assertSignatureOriginalSet(retainedDirectory, originalGuards); for (const guard of guards) assertLegalFileIdentity(guard); check(); facts.sdkDebianOfficialSignatureAndSuiteVerified = true;
    const freeze = (value: unknown): void => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}};
    const heldDirectory = retainedDirectory;
    const heldGuards = Object.freeze([...guards]), heldOriginals = Object.freeze([...originalGuards]);
    assertCurrent = () => {
      input.current();
      for (const guard of heldGuards) assertLegalFileIdentity(guard);
      assertSignatureOriginalSet(heldDirectory, heldOriginals);
    };
    freeze(facts); input.persist?.({facts, guards: Object.freeze(guards), originals: Object.freeze(originalGuards), directory: retainedDirectory});
  } catch (error) {pending.push((error as Error).message);} finally {if (activeGroup) activeGroup.active = false;}
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending), ...(assertCurrent ? {assertCurrent} : {}), ...(retainedDirectory ? {retainedDirectory} : {})});
}

const MAX_SIGNATURE_ATTEMPTS = 3;
const attempts = new WeakMap<object, {started: number; count: number; active: boolean}>();
/** SDK wrapper: resolves the genuine private view, calls the same core, then
 * owns cache/guards/attempts; never mints custody from structural input. */
export async function observeQleverSdkDebianSignatureOriginals(capability: unknown, remainingMs = 120000) {
  const called = performance.now(), facts: Record<string, unknown> = {}, pending: string[] = []; let retainedDirectory: string | undefined; let activeGroup: {started: number; count: number; active: boolean} | undefined;
  try {
    const sdk = qleverSdkOriginalsView(capability); need(sdk && capability && typeof capability === 'object', 'issued related SDK originals required');
    const cached = qleverSdkDebianSignatureObservation(capability);
    if (cached) {need(performance.now() < called + Math.min(remainingMs, 120000), 'shared source deadline expired'); return Object.freeze({facts: cached, pending: Object.freeze([] as string[])});}
    const group = attempts.get(capability) ?? {started: performance.now(), count: 0, active: false}; attempts.set(capability, group);
    need(!group.active && group.count < MAX_SIGNATURE_ATTEMPTS, 'signature observation group attempts exhausted or active');
    group.count++; group.active = true; activeGroup = group;
    const {qleverSdkDebianIndexObservation} = await import('./qlever-sdk-debian-index');
    const checksumRows = qleverSdkDebianIndexObservation(capability);
    need(checksumRows?.length, 'prior private Debian index checksum observation required');
    const result = await observeSignatureCore({
      reader: sdk as unknown as DebianSignatureReader,
      prerequisites: {indexInRelease: checksumRows.map(row => ({sha256: row.inReleaseSha256, sourceOriginal: row.sourceOriginal, signedIndexMatches: row.observation.signedIndexMatches}))},
      remainingMs,
      check: () => need(performance.now() < called + Math.min(remainingMs, 120000) && performance.now() < group.started + 120000, 'shared source deadline expired'),
      current: () => need(qleverSdkOriginalsView(capability) === sdk && qleverSdkDebianIndexObservation(capability) === checksumRows, 'SDK/index custody changed'),
      persist: value => saved.set(capability as object, {view: sdk, facts: value.facts, guards: value.guards, originals: value.originals, directory: value.directory}),
    });
    retainedDirectory = result.retainedDirectory;
    Object.assign(facts, result.facts);
    pending.push(...result.pending);
  } catch (error) {pending.push((error as Error).message);} finally {if (activeGroup) activeGroup.active = false;}
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending), ...(retainedDirectory ? {retainedDirectory} : {})});
}
