import {selectSdkControllerHelperGroup} from './sdk-controller-helper-groups';
import { inspectRetainedDebianGpgvExit } from './debian-signature-policy-bridge';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import limits from '../module-artifact-limits.json';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { captureLegalFileIdentity, assertLegalFileIdentity } from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw Error('SDK Debian index originals: ' + reason); };
function need(value: unknown, reason: string): asserts value { if (!value) fail(reason); }
const same = isDeepStrictEqual;
const ROOT = '/opt/qlever-sdk/materials';
const LOCAL_HELPERS = [
  ['sdk-debian-index-bindings.py', 'ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13'],
  ['sdk-debian-index-observer.py', 'e5c632f9357c59be5401dcfd5e7d7daec2d9cf9fc54dae22f400bac21d8f5074'],
  ['sdk-zip-originals.py', '304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8'],
] as const;

export type QleverSdkDebianIndexObservation = Readonly<{inReleaseSha256: string;
  sourceOriginal: Readonly<{path: string; bytes: number; sha256: string}>;
  observation: Readonly<{signedIndexMatches: readonly Readonly<{path: string; form: string}>[]}>}>;
const indexObservations = new WeakMap<object, Readonly<{sdk: NonNullable<ReturnType<typeof qleverSdkOriginalsView>>;
  rows: readonly QleverSdkDebianIndexObservation[]}>>();
/** Same successfully observed SDK only; metadata reader must remain active.
 * This is not a serialized approval or an independent signature authority. */
export function qleverSdkDebianIndexObservation(capability: unknown): readonly QleverSdkDebianIndexObservation[] | undefined {
  if (!capability || typeof capability !== 'object') return undefined;
  const value = indexObservations.get(capability);
  if (!value || qleverSdkOriginalsView(capability) !== value.sdk) return undefined;
  const master = value.sdk.masterReference, bytes = value.sdk.readOriginal(master.path, 8 * 1024 ** 2);
  need(bytes.length === master.bytes && hash(bytes) === master.sha256, 'active index observation inventory custody differs');
  return value.rows;
}

/** No new issuer: the same independently acquired SDK originals capability is
 * mandatory. Returned checksum facts do not grant OpenPGP/keyring authority. */
export async function observeQleverSdkDebianIndexOriginals(capability: unknown, remainingMilliseconds = limits.timeoutMs) {
  if (capability && typeof capability === 'object') indexObservations.delete(capability);
  const pending = new Set<string>(), facts: Record<string, unknown> = {};
  try {
    const sdk = qleverSdkOriginalsView(capability); need(sdk, 'issued related SDK originals required');
    need(Number.isFinite(remainingMilliseconds) && remainingMilliseconds > 0, 'SDK source observation window exhausted');
    const deadline = performance.now() + Math.min(remainingMilliseconds, limits.timeoutMs);
    const check = () => need(performance.now() < deadline, 'aggregate SDK source/index deadline exceeded');
    const members = new Map(sdk.members.map(row => [row.path, row]));
    const ref = (value: any) => {
      check(); const row = members.get(value?.path);
      need(row && row.bytes === value.bytes && row.sha256 === value.sha256, 'same SDK ZIP original reference required'); return row;
    };
    const read = (value: any, maximum: number = limits.metadataBytes) => {
      const row = ref(value); need(row.bytes <= maximum && maximum <= 8 * 1024 ** 2, 'bounded index metadata/raw required');
      const bytes = sdk.readOriginal(row.path, maximum);
      need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'registered metadata/raw bytes differ'); return bytes;
    };
    const json = (value: any) => JSON.parse(read(value).toString('utf8'));
    const master = JSON.parse(read(sdk.masterReference, 8 * 1024 ** 2).toString('utf8'));
    need(master.kind === 'qlever-linux-sdk-originals' && master.identity?.sourceSha === sdk.originFacts.sourceSha && master.identity?.target === sdk.originFacts.target, 'actual SDK master identity differs');
    if (!master.debianSources) return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(['qlever-sdk-Debian-index-originals-unavailable'])});
    const collection = json(master.debianSources);
    need(collection.kind === 'qlever-sdk-exact-debian-source-originals' && collection.schemaVersion === 1 && Array.isArray(collection.packages) && collection.packages.length > 0
      && collection.packages.length <= 4096 && Array.isArray(collection.indexOriginals) && collection.indexOriginals.length > 0 && collection.indexOriginals.length <= limits.sourceMaterialFiles, 'actual Debian collection/index references required');
    for (const item of collection.packages) {
      need(Array.isArray(item.files) && item.files.length <= 4096, 'source original file count bound');
      need(typeof item.name === 'string' && typeof item.version === 'string' && /^inner\/debian-source\/package-[0-9]{4}\/[^/]+\.dsc$/u.test(item.dsc?.path), 'registered exact dsc group required');
      const group = item.dsc.path.slice(0, item.dsc.path.lastIndexOf('/') + 1);
      for (const original of [item.dsc, ...item.files]) { ref(original); need(original.path.startsWith(group) && !original.path.slice(group.length).includes('/'), 'registered source group member required'); }
    }
    const apiRows = sdk.metadataOriginals.filter(row => /^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name));
    const jobs = apiRows.flatMap(row => {
      const expected = sdk.originFacts.originals.find(item => item.name === row.name);
      need(expected && row.data.length === expected.bytes && hash(row.data) === expected.sha256, 'SDK job API original differs');
      return JSON.parse(row.data.toString()).jobs;
    }).filter((row: any) => row.id === sdk.originFacts.producerJobId);
    need(jobs.length === 1, 'unique actual SDK producer job required');
    const jobStart = Date.parse(jobs[0].started_at), jobEnd = Date.parse(jobs[0].completed_at);
    need(Number.isFinite(jobStart) && Number.isFinite(jobEnd) && jobStart <= jobEnd, 'actual SDK job window required');
    const helperDigests=new Map<string,string>();
    const helpers = LOCAL_HELPERS.map(([name]) => {
      const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url));
      const identity = captureLegalFileIdentity(file); need(identity.size <= BigInt(limits.metadataBytes), 'reviewed fixed controller helper differs'); helperDigests.set(name,hash(readFileSync(file)));return identity;
    });
    selectSdkControllerHelperGroup(REVIEWED_HELPER_GROUPS,helperDigests);helpers.forEach(assertLegalFileIdentity);
    const { moduleSourcePhasePolicy } = await import('./module-source-phases');
    const limitsFile = fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url));
    const limitsIdentity = captureLegalFileIdentity(limitsFile);
    need(hash(readFileSync(limitsFile)) === moduleSourcePhasePolicy.limits, 'reviewed shared limit authority differs');
    const python = realpathSync('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python);
    const stages: unknown[] = [], checksums: unknown[] = [], covered = new Set<string>(); let indexBytes = 0;
    need(Array.isArray(master.stages), 'actual SDK stage originals unavailable');
    const seenIndexes = new Set<string>();
    for (const index of collection.indexOriginals) {
      check(); const release = ref(index.inRelease), sources = ref(index.sources), keyring = ref(index.keyring), stage = index.verificationStage;
      need(!seenIndexes.has(sources.path), 'duplicate actual Sources original'); seenIndexes.add(sources.path);
      indexBytes += sources.bytes + release.bytes + keyring.bytes;
      need(indexBytes <= limits.sourceBytes && sources.bytes <= limits.shardBytes, 'aggregate retained Debian index domain bound');
      need([release, sources, keyring].every(row => row.path.startsWith('inner/debian-source/indexes/')) && /^debian-index-[0-9]+$/u.test(stage?.name)
        && master.stages.filter((row: any) => row.name === stage.name && same(row, stage)).length === 1, 'actual exported gpgv stage must match SDK master');
      const base = 'inner/stages/' + stage.name;
      for (const [field, name] of [['receipt', base + '/command.receipt.json'], ['stdout', base + '/stdout.raw'], ['stderr', base + '/stderr.raw'],
        ['supervisionReceipt', base + '.receipt.json'], ['supervisionRaw', base + '.raw.log']]) need(stage[field!]?.path === name, 'fixed gpgv raw/receipt role required');
      const actual = json(stage.receipt), supervision = json(stage.supervisionReceipt);
      const unclassified = stage.classification === 'unclassified-producer-gpgv-originals';
      need(stage.classification === undefined || unclassified, 'fixed gpgv retention classification differs');
      const command = ['gpgv', ...(unclassified ? ['--status-fd', '1'] : []), '--keyring', ROOT + '/' + keyring.path.slice('inner/'.length), ROOT + '/' + release.path.slice('inner/'.length)];
      const retainedExit = inspectRetainedDebianGpgvExit(actual.exit, supervision.exit);
      need(unclassified || retainedExit === 0, 'legacy gpgv requires actual closed exit zero');
      need(same(actual.command, command) && actual.schemaVersion === 1 && actual.actualWait === true && actual.exit === retainedExit && actual.signal === null && actual.rawClosedBeforeHash === true
        && Number.isSafeInteger(actual.pid) && actual.pid > 0 && actual.pgid === supervision.pgid && supervision.pid === supervision.pgid && Number.isSafeInteger(supervision.pid) && supervision.pid > 0, 'actual gpgv argv/wait/exit/group differs');
      for (const field of ['stdout', 'stderr']) {
        const bytes = read(stage[field]);
        need(actual[field]?.path === field + '.raw' && actual[field]?.bytes === bytes.length && actual[field]?.sha256 === hash(bytes), 'actual gpgv dual raw reference differs');
      }
      const supervisorRaw = read(stage.supervisionRaw), argv = supervision.command;
      need(Array.isArray(argv) && argv.length === 6 && argv[0] === '/usr/bin/python3' && argv[1] === '-B' && argv[2] === '/components/qlever/scripts/sdk-command-materials.py'
        && argv[3] === '--exec-child' && argv[4] === ROOT + '/stages/' + stage.name && same(JSON.parse(argv[5]), command), 'fixed SDK command supervisor argv differs');
      const started = Date.parse(supervision.startedUTC), closed = Date.parse(supervision.closedUTC), actualStart = Math.floor(Number(actual.startedUnixNs) / 1e6), actualEnd = Math.floor(Number(actual.completedUnixNs) / 1e6);
      need(supervision.actualWait === true && supervision.exit === retainedExit && supervision.signal === null && supervision.ownedGroupAbsentAfterWait === true && supervision.rawClosedBeforeHash === true
        && supervision.rawSHA256 === hash(supervisorRaw) && supervision.resourceStop === null && supervision.supervisorError === null
        && Number.isFinite(supervision.elapsedSeconds) && supervision.elapsedSeconds >= 0
        && Array.isArray(supervision.cleanupErrors) && supervision.cleanupErrors.length === 0 && Array.isArray(supervision.ownedGroupMembers) && supervision.ownedGroupMembers.length === 0
        && [started, closed, actualStart, actualEnd].every(Number.isFinite) && jobStart <= started && started <= actualStart && actualStart <= actualEnd && actualEnd <= closed && closed <= jobEnd, 'actual gpgv supervision/raw/window did not close');
      // Hash the exact keyring/InRelease originals; stderr text is never taken
      // as cryptographic verification, and this does not bless the keyring.
      read(release); read(keyring);
      const remaining = Math.floor(deadline - performance.now()); need(remaining > 0, 'index observer window exhausted');
      const plan = Buffer.from(JSON.stringify({remainingMilliseconds: remaining, inRelease: release, sources, packages: collection.packages}));
      need(plan.length <= limits.metadataBytes, 'bounded fixed controller plan required');
      for (const identity of [...helpers, pythonIdentity, limitsIdentity]) assertLegalFileIdentity(identity);
      const result = await sdk.withArchiveFile(async archive => {
        need(archive.identity.bytes === sdk.archive.bytes && archive.identity.sha256 === sdk.archive.sha256, 'same retained SDK ZIP required');
        check();
        let bytes: Buffer;
        try { bytes = execFileSync(python, ['-I', '-S', '-B', helpers[1]!.path, archive.path], {input: plan, maxBuffer: limits.metadataBytes, stdio: ['pipe', 'pipe', 'pipe'],
          timeout: Math.max(1, Math.floor(deadline - performance.now())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}}); } catch (error) {
          const stderr = (error as {stderr?: Buffer}).stderr?.toString().trim().split('\n').pop()?.slice(0, 1024);
          return fail('bounded fixed ZIP index observer failed' + (stderr ? ': ' + stderr : ''));
        }
        return JSON.parse(bytes.toString());
      }, {check, remainingMs: () => deadline - performance.now()});
      for (const identity of [...helpers, pythonIdentity, limitsIdentity]) assertLegalFileIdentity(identity);
      need(qleverSdkOriginalsView(capability) === sdk && result.scope === 'checksum-mechanics-only-not-OpenPGP-or-keyring-authority'
        && result.inReleaseSha256 === release.sha256 && same(result.original, {bytes: sources.bytes, sha256: sources.sha256}) && Array.isArray(result.packages), 'private index checksum observation binding differs');
      for (const item of result.packages) covered.add(item.name + '\0' + item.version);
      stages.push(Object.freeze({classification: 'unclassified-producer-gpgv-originals', actualExit: retainedExit, inRelease: release, keyring, receipt: ref(stage.receipt), stdout: ref(stage.stdout), stderr: ref(stage.stderr), supervisionReceipt: ref(stage.supervisionReceipt), supervisionRaw: ref(stage.supervisionRaw)}));
      checksums.push(Object.freeze({sourceOriginal: sources, observation: Object.freeze(result)}));
    }
    need(collection.packages.every((item: any) => covered.has(item.name + '\0' + item.version)), 'exact dsc/source tuple absent from all authenticated-byte index observations');
    check(); need(qleverSdkOriginalsView(capability) === sdk, 'SDK index custody revoked');
    const projection = Object.freeze(checksums.map((item: any) => {
      need(Array.isArray(item.observation.signedIndexMatches) && item.observation.signedIndexMatches.length > 0, 'actual signed index matches required');
      const matches = Object.freeze(item.observation.signedIndexMatches.map((match: any) => {
        need(typeof match.path === 'string' && ['plain', 'original-compressed', 'decoded-plain'].includes(match.form), 'actual signed index match shape differs');
        return Object.freeze({path: match.path, form: match.form});
      }));
      return Object.freeze({inReleaseSha256: item.observation.inReleaseSha256,
        sourceOriginal: Object.freeze({path: item.sourceOriginal.path, bytes: item.sourceOriginal.bytes, sha256: item.sourceOriginal.sha256}),
        observation: Object.freeze({signedIndexMatches: matches})});
    }));
    need(Buffer.byteLength(JSON.stringify(projection)) <= limits.metadataBytes, 'private index projection metadata bound');
    check(); need(qleverSdkOriginalsView(capability) === sdk, 'SDK index projection custody changed');
    indexObservations.set(capability as object, Object.freeze({sdk, rows: projection}));
    facts.sdkDebianIndexChecksumBindings = Object.freeze(checksums); facts.sdkGpgvClosedExecutionOriginals = Object.freeze(stages);
    facts.sdkDebianInReleaseSourcesDscChecksumChainVerified = true;
    pending.add('qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified');
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze([...pending])});
}

const REVIEWED_HELPER_GROUPS=Object.freeze([LOCAL_HELPERS,Object.freeze(LOCAL_HELPERS.map(([name,sha])=>Object.freeze([name,name==='sdk-zip-originals.py'?'86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10':sha] as const)))])
