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
import {DEBIAN_BOOKWORM_KEYS, inspectDebianPublicKeyOriginal, extractDebianSignedRelease} from './qlever-debian-signature-policy';

type Ref = {path: string; bytes: number; sha256: string};
type Stage = {name: string; receipt: Ref; supervisionReceipt: Ref};
type Collection = {schemaVersion: number; kind: string; indexOriginals: {inRelease: Ref; sources: Ref; verificationStage: Stage}[]};
type Master = {kind: string; debianSources?: Ref; stages: Stage[]};
type CommandOutcome = {code: number; signal: unknown; actualWait: boolean; actualClose: boolean; groupAbsent: boolean; rawComplete: boolean; rawClosedBeforeHash: boolean; pipeEOF: boolean[]; failure: unknown; spawnError: unknown; raw: Ref[]};
const {runPublicationCommand} = createRequire(import.meta.url)('../afs-publication-command.cjs') as {
  runPublicationCommand(command: string, args: string[], options: {cwd: string; env: Record<string, string>; evidence: string; label: string; timeoutMs: number; rawLimit: number}): Promise<CommandOutcome>;
};
type SdkView = NonNullable<ReturnType<typeof qleverSdkOriginalsView>>;
const saved = new WeakMap<object, {view: SdkView; facts: Readonly<Record<string, unknown>>; guards: readonly LegalFileIdentity[]; originals: readonly LegalFileIdentity[]; directory: string}>();
const attempts = new WeakMap<object, {started: number; count: number; active: boolean}>();
export function qleverSdkDebianSignatureObservation(capability: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!capability || typeof capability !== 'object') return undefined; const record = saved.get(capability); if (!record) return undefined;
  need(qleverSdkOriginalsView(capability) === record.view, 'signature SDK custody changed');
  for (const guard of record.guards) assertLegalFileIdentity(guard); assertSignatureOriginalSet(record.directory, record.originals); return record.facts;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function need(value: unknown, why: string): asserts value {if (!value) throw Error('SDK Debian signature: ' + why);}
/** One fixed official acquisition, with no caller URL/transport or trust callback.
 * Buffers remain local to this observation. No public registration mints facts. */
async function officialKeys(deadline: number, directory: string, check: () => void) {
  const originals: Ref[] = [], packets: Buffer[] = [], guards: LegalFileIdentity[] = []; let total = 0;
  for (const policy of DEBIAN_BOOKWORM_KEYS) {
    check(); const url = 'https://ftp-master.debian.org/keys/' + policy.file;
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(15000, Math.floor(deadline - performance.now()))))});
    need(response.status === 200 && !response.redirected && response.body && response.url === url, 'fixed official key response unavailable');
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {for (;;) {check(); const row = await reader.read(); if (row.done) break; size += row.value.length; total += row.value.length; need(size <= 32768 && total <= 98304, 'official key byte bound'); chunks.push(Buffer.from(row.value));}}
    finally {await reader.cancel().catch(() => {});}
    const bytes = Buffer.concat(chunks), packet = inspectDebianPublicKeyOriginal(bytes, policy);
    const file = path.join(directory, policy.file); fs.writeFileSync(file, bytes, {flag: 'wx', mode: 0o400});
    guards.push(readSignatureOriginal(file, {bytes: bytes.length, sha256: hash(bytes)}, 32768, check).identity);
    originals.push({path: policy.file, bytes: bytes.length, sha256: hash(bytes)}); packets.push(packet);
  }
  const keyring = Buffer.concat(packets); fs.writeFileSync(path.join(directory, 'reviewed-keys.gpg'), keyring, {flag: 'wx', mode: 0o400});
  const keyIdentity = readSignatureOriginal(path.join(directory, 'reviewed-keys.gpg'), {bytes: keyring.length, sha256: hash(keyring)}, 98304, check).identity; guards.push(keyIdentity);
  return {originals, keyringSha256: hash(keyring), keyIdentity, guards};
}

/** Independently verify actual private SDK InRelease with a trusted controller
 * OS tool. This grants only the signature/suite leaf, never SDK/source approval.
 * Mac/absent tool fails closed. Candidate keyring and SDK gpgv are never used. */
export async function observeQleverSdkDebianSignatureOriginals(capability: unknown, remainingMs = 120000) {
  const called = performance.now(), facts: Record<string, unknown> = {}, pending: string[] = []; let retainedDirectory: string | undefined; let activeGroup: {started: number; count: number; active: boolean} | undefined;
  try {
    const sdk = qleverSdkOriginalsView(capability); need(sdk && capability && typeof capability === 'object', 'issued related SDK originals required');
    need(Number.isFinite(remainingMs) && remainingMs >= 1 && performance.now() < called + Math.min(remainingMs, 120000), 'shared source deadline expired');
    const cached = qleverSdkDebianSignatureObservation(capability);
    if (cached) {need(performance.now() < called + Math.min(remainingMs, 120000), 'shared source deadline expired'); return Object.freeze({facts: cached, pending: Object.freeze([] as string[])});}
    const group = attempts.get(capability) ?? {started: performance.now(), count: 0, active: false}; attempts.set(capability, group);
    need(!group.active && group.count < 3, 'signature observation group attempts exhausted or active');
    const deadline = Math.min(called + Math.min(remainingMs, 120000), group.started + 120000);
    group.count++; group.active = true; activeGroup = group;
    const check = () => need(performance.now() < deadline, 'shared source deadline expired');
    need(process.platform === 'linux' && fs.existsSync('/usr/bin/gpgv'), 'trusted Linux controller /usr/bin/gpgv unavailable');
    const executable = fs.realpathSync('/usr/bin/gpgv'), tool = hashSignatureControllerFile(executable, check);
    const members = new Map(sdk.members.map(row => [row.path, row]));
    const read = (reference: Ref, maximum = 4 * 1024 ** 2) => {check(); const actual = members.get(reference?.path);
      need(actual && actual.bytes === reference.bytes && actual.sha256 === reference.sha256 && actual.bytes <= maximum, 'same SDK original reference required');
      const bytes = sdk.readOriginal(actual.path, maximum); need(bytes.length === actual.bytes && hash(bytes) === actual.sha256, 'SDK original bytes differ'); return bytes;};
    const master = JSON.parse(read(sdk.masterReference, 8 * 1024 ** 2).toString()) as Master;
    need(master.kind === 'qlever-linux-sdk-originals' && master.debianSources && Array.isArray(master.stages), 'actual Debian collection unavailable');
    const collection = JSON.parse(read(master.debianSources).toString()) as Collection;
    need(collection.schemaVersion === 1 && collection.kind === 'qlever-sdk-exact-debian-source-originals' && Array.isArray(collection.indexOriginals) && collection.indexOriginals.length > 0 && collection.indexOriginals.length <= 32, 'bounded actual index set required');
    const jobs = sdk.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row => {
      const original = sdk.originFacts.originals.find(value => value.name === row.name);
      need(original?.sha256 === hash(row.data) && original.bytes === row.data.length, 'actual job API bytes differ');
      return (JSON.parse(row.data.toString()) as {jobs: {id: number; started_at: string; completed_at: string}[]}).jobs;
    }).filter(row => row.id === sdk.originFacts.producerJobId);
    need(jobs.length === 1, 'unique actual SDK job required'); const jobStart = Date.parse(jobs[0]!.started_at), jobEnd = Date.parse(jobs[0]!.completed_at);
    need(Number.isFinite(jobStart) && Number.isFinite(jobEnd) && jobStart <= jobEnd, 'actual job window required');
    const root = fileURLToPath(new URL('../../../.test-data/debian-controller-signatures/', import.meta.url));
    fs.mkdirSync(root, {recursive: true, mode: 0o700}); const free = fs.statfsSync(root, {bigint: true}); need(free.bavail * free.bsize >= 1024n ** 3n + 16n * 1024n ** 2n, 'controller signature free floor');
    retainedDirectory = fs.mkdtempSync(path.join(root, 'observation-')); fs.mkdirSync(path.join(retainedDirectory, 'empty-home'), {mode: 0o700});
    const {qleverSdkDebianIndexObservation} = await import('./qlever-sdk-debian-index');
    const checksumRows = qleverSdkDebianIndexObservation(capability); need(checksumRows?.length, 'prior private Debian index checksum observation required');
    need(collection.indexOriginals.every(entry => checksumRows.some(row => row.inReleaseSha256 === entry.inRelease.sha256 && row.sourceOriginal.path === entry.sources.path && row.sourceOriginal.bytes === entry.sources.bytes && row.sourceOriginal.sha256 === entry.sources.sha256)), 'private checksum index originals differ');
    const keys = await officialKeys(deadline, retainedDirectory, check), keyring = path.join(retainedDirectory, 'reviewed-keys.gpg');
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
      const indexPaths = checksumRows.filter(row => row.inReleaseSha256 === entry.inRelease.sha256).flatMap(row => row.observation.signedIndexMatches.map(match => match.path));
      const signedBody = extractDebianSignedRelease(original);
      const body = readSignatureOriginal(bodyPath, {bytes: signedBody.length, sha256: hash(signedBody)}, 4 * 1024 ** 2, check); originalGuards.push(body.identity);
      const classified = inspectDebianSignaturePolicyOriginals({inRelease: original, status, plaintext: body.bytes, acquisitionUTC: acquisition, indexPaths, exit});
      observations.push(Object.freeze({inRelease: entry.inRelease, acquisitionUTC: acquisition, ...classified}));
    }
    check(); need(qleverSdkDebianIndexObservation(capability) === checksumRows && qleverSdkOriginalsView(capability) === sdk && hashSignatureControllerFile(executable, check).sha256 === tool.sha256, 'SDK/controller custody changed');
    facts.sdkDebianSignatureOriginals = Object.freeze({scope: 'controller-OS-gpgv-reviewed-Bookworm-keys-and-actual-job-suite', executable, executableSha256: tool.sha256,
      version: version.toString(), keys: Object.freeze(keys.originals), keyringSha256: keys.keyringSha256, keyLifecycleScope: 'fixed-reviewed-key-snapshot-and-expiration-policy; not independent current revocation proof', observations: Object.freeze(observations), retainedDirectory});
    const guards = [tool.identity, ...originalGuards];
    check(); assertSignatureOriginalSet(retainedDirectory, originalGuards); for (const guard of guards) assertLegalFileIdentity(guard); check(); facts.sdkDebianOfficialSignatureAndSuiteVerified = true;
    const freeze = (value: unknown): void => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}};
    freeze(facts); saved.set(capability, {view: sdk, facts, guards: Object.freeze(guards), originals: Object.freeze(originalGuards), directory: retainedDirectory});
  } catch (error) {pending.push((error as Error).message);} finally {if (activeGroup) activeGroup.active = false;}
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(pending), ...(retainedDirectory ? {retainedDirectory} : {})});
}
