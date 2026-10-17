import {afsConsumerRegisteredShards} from './afs-consumer-shard-registration';
import {productConsumerOriginalLimits} from './product-consumer-limits';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ArchiveProductConsumerOriginalManifest } from './archive-consumer-originals';
import type { RegistryConsumerOriginalManifest } from './registry-consumer-originals';
import type { CollectedArtifactIdentity, CollectedArtifactMember } from './artifact-contract';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw Error('Registry consumer originals: ' + reason); };
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes('\\')
  && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..');

/** Pure original-byte validation. Only a separate controlled GitHub observer
 * plus real collector/readback handles can issue a consumer capability. */
export function verifyRegistryConsumerOriginalBundle(input: {
  manifest: RegistryConsumerOriginalManifest|ArchiveProductConsumerOriginalManifest;
  stage:'prepublish'|'postpublish';
  portableExpectations?:{labels:readonly string[];profiles:readonly string[];installations:number};
  productMembers:readonly CollectedArtifactMember[];
  inventory: readonly CollectedArtifactMember[];
  product: Readonly<CollectedArtifactIdentity>;
  tools: readonly Readonly<CollectedArtifactIdentity>[];
  consumer: { sourceSha: string; runHeadSha: string; runId: number; runAttempt: number; target?: string };
  readOriginal(path: string, maximumBytes: number): Buffer;
  readOriginalRange?(path:string,offset:number,length:number):Buffer;
}) {
  const manifest = input.manifest;
  const afs=/^@undefineds\.co\/xpod-afs-(?:linux|darwin)-(?:x64|arm64)$/u.test(input.product.package);
  const limits=productConsumerOriginalLimits(afs?'afs':'api');
  if (manifest?.schemaVersion !== 1 || manifest.kind !== (input.stage==='prepublish'?'archive-product-consumer-originals':'registry-installed-product-consumer-originals')
    || (input.stage==='prepublish'&&(!('stage' in manifest)||manifest.stage!=='prepublish'||manifest.transport!=='collected-product-archives'))
    || !isDeepStrictEqual(manifest.product, input.product) || manifest.sourceSha !== input.product.sourceSha
    || input.consumer.sourceSha !== input.product.sourceSha || manifest.consumer.runHeadSha !== input.consumer.runHeadSha
    || manifest.consumer.runId !== input.consumer.runId || manifest.consumer.runAttempt !== input.consumer.runAttempt
    || manifest.consumer.target !== input.product.target || input.consumer.target !== input.product.target
    || !isDeepStrictEqual(manifest.tools, input.tools)) fail('source/product/tool/run identity mismatch');
  if (!Array.isArray(manifest.originals) || !manifest.originals.length || manifest.originals.length > limits.originalMembers) fail('bounded original inventory required');
  const originals = new Map<string, CollectedArtifactMember>(); let total = 0;
  const actual = new Map(input.inventory.map(row => [row.path, row]));
  for (const row of manifest.originals) {
    if (!row || !safe(row.path) || originals.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.bytes > limits.memberBytes || !/^[a-f0-9]{64}$/u.test(row.sha256) || !actual.has(row.path) || actual.get(row.path)!.bytes!==row.bytes || actual.get(row.path)!.sha256!==row.sha256) fail('exact original member mismatch');
    total += row.bytes; originals.set(row.path, row);
  }
  if (total > limits.originalBytes || input.inventory.length !== originals.size + 1
    || !actual.has(input.stage==='prepublish'?'archive-consumer.manifest.json':'registry-consumer.manifest.json')) fail('complete bounded original inventory required');
  const read = (name: string, maximum = 16 * 1024 ** 2): Buffer => {
    const row = originals.get(name);
    if (!row || row.bytes > maximum) return fail('registered bounded original missing: ' + name);
    const bytes = input.readOriginal(name, maximum);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail('original changed: ' + name);
    return bytes;
  };
  const toolShards=afs?afsConsumerRegisteredShards({sourceSha:input.product.sourceSha,result:JSON.parse(read('result.json',2*1024**2).toString()),originals,read}):new Set<string>();
  // Hash every retained original, including installer locks/inventories and
  // helper diagnostics that the admission report itself does not parse.
  for (const row of originals.values()) {
    if(row.bytes<=limits.smallMemberBytes){read(row.path);continue;}
    if(!afs||!toolShards.has(row.path)||!input.readOriginalRange)fail('large original is outside the fixed verifier-tool archive roles');
    const digest=createHash('sha256');
    for(let offset=0;offset<row.bytes;offset+=65536){const length=Math.min(65536,row.bytes-offset),bytes=input.readOriginalRange!(row.path,offset,length);if(bytes.length!==length)fail('short verifier-tool original range');digest.update(bytes);}
    if(digest.digest('hex')!==row.sha256)fail('verifier-tool original changed');
  }
  if (manifest.result.path !== 'result.json' || !isDeepStrictEqual(originals.get('result.json'), manifest.result)) fail('exact result reference required');
  const closedCommand = (directory: string, label: string) => {
    const prefix=directory?directory+'/':'';
    const row = JSON.parse(read(prefix + label + '.receipt.json', 1024 * 1024).toString());
    if (row.code !== 0 || row.signal !== null || row.spawnError !== null || row.actualWait !== true || row.actualClose !== true
      || row.groupAbsent !== true || row.rawClosed !== true || row.rawClosedBeforeHash !== true || row.rawComplete !== true
      || row.failure !== null || !Array.isArray(row.pipeEOF) || row.pipeEOF.length !== 2 || !row.pipeEOF.every((value: unknown) => value === true)
      || !Array.isArray(row.raw) || row.raw.length !== 2) fail('actual supervisor closure incomplete');
    for (const [index, stream] of ['stdout', 'stderr'].entries()) {
      const reference = row.raw[index], name = label + '.' + stream + '.raw.log';
      const actual = read(prefix + name);
      if (reference.path !== name || reference.bytes !== actual.length || reference.sha256 !== hash(actual)) fail('both exact supervisor raw streams required');
    }
    return row;
  };
  const producer = closedCommand('producer-supervision', 'registry-consumer');
  if (!Array.isArray(producer.args) || producer.args.length !== 1 || typeof producer.args[0] !== 'string'
    || !producer.args[0].endsWith('/scripts/run-independent-publication.ts')) fail('fixed consumer producer command required');
  const binding = JSON.parse(read('consumer-product-binding.json', 1024 * 1024).toString());
  if (!isDeepStrictEqual(binding, { product: input.product, tools: input.tools })) fail('product/tool original binding mismatch');
  const result = JSON.parse(read('result.json', 2 * 1024 ** 2).toString());
  if (input.product.target === undefined) {
    if (result.stage !== input.stage || result.baseVerified!==true || result.fullVerified!==true || result.allProfilesVerified !== true || result.registryInstallVerified !== (input.stage==='postpublish')
      || !isDeepStrictEqual(result.identity, input.product) || !Array.isArray(result.profiles) || result.profiles.length !== 2
      || result.profiles.some((row: any) => row.verified !== true || !Array.isArray(row.pending) || row.pending.length)
      || !input.portableExpectations || !isDeepStrictEqual(result.profiles.map((row:any)=>row.profile),input.portableExpectations.profiles)) fail('portable registry fixed profiles incomplete');
    const receipts = [...originals.keys()].filter(name => !name.includes('/') && name.endsWith('.receipt.json'));
    if(!isDeepStrictEqual(receipts.map(name=>name.slice(0,-'.receipt.json'.length)).sort(),[...input.portableExpectations!.labels].sort()))fail('exact fixed portable command original set required');
    for (const name of receipts) {
      const label = name.slice(0, -'.receipt.json'.length);
      // The portable observer owns root-level receipts. Use the same parser
      // with an explicit empty-directory sentinel, without accepting traversal.
      closedCommand('',label);
    }
    for (let index = 0; index < input.portableExpectations!.installations; index++) if (!receipts.includes(`profile-${index}-registry-install.receipt.json`)
      || !originals.has(`profile-${index}-installed-inventory.json`) || !originals.has(`profile-${index}-bun.lock`)) fail('all Node/Bun registry installations required');
  } else {
    const module = input.product.package.match(/^@undefineds\.co\/xpod-(api|css|afs)-(?:linux|darwin)-(?:x64|arm64)$/u)?.[1];
    if (!module || result.kind !== module + '-public-cli-consumer' || result.status !== 'passed'
      || result.transport !== (input.stage==='postpublish'?'production-npm-registry':'collected-product-archives') || result.sourceSha !== input.product.sourceSha
      || result.realConsumerValidated !== true || result.forcedCleanup !== false || result.signal !== null
      || result.processGroupsUnknown !== false || result.ownedTemporaryRootRemoved !== true || result.driverSourcesUnchanged !== true) fail('matching-host registry module lifecycle incomplete');
    closedCommand('central-supervision', 'module-registry-consumer');
    const required = ['runtime-version', 'runtime-target', 'probe', 'normal-cli-install', 'install-' + module,
      'list-' + module, module + '-service', ...(module === 'api' ? ['pglite', 'api-rdf'] : []), 'remove-' + module];
    const labels = ['node', 'bun'].flatMap(runtime => required.map(name => runtime + '-' + name));
    if (!Array.isArray(result.records) || result.records.length !== labels.length || labels.some(label => result.records.filter((row: any) => row.label === label).length !== 1)) fail('complete module profile command originals required');
    const [platform, arch] = input.product.target.split('-');
    for (const runtime of ['node', 'bun']) {
      const installedManifest=read(runtime+'-installed-package.json');
      const expectedManifest=input.productMembers.find(row=>row.path==='package.json');
      if(!expectedManifest||hash(installedManifest)!==expectedManifest.sha256||installedManifest.length!==expectedManifest.bytes)fail('actual installed module manifest differs');
      const target = result.installedVerification?.[runtime]?.actualRuntimeTarget;
      if (!isDeepStrictEqual(target, { platform, arch }) || result.installedVerification[runtime].fullInventoryVerified !== true
        || result.installedVerification[runtime].nativeTargetVerification?.target !== input.product.target) fail('actual installed native runtime target mismatch');
      if (!originals.has(runtime + '-registry-package.json') || !originals.has(runtime + '-registry-bun.lock')
        || !originals.has(runtime + '-registry-tools.json')) fail('actual registry tool installation originals required');
    }
    for (const row of result.records) {
      if (row.status !== 'passed' || row.returncode !== 0 || row.waitStatus !== 'known' || row.rawClosed !== true
        || row.rawClosedBeforeHash !== true || row.rawEligible !== true || row.ownedGroupAbsent !== true || row.rawHandlesClosed !== true
        || !Array.isArray(row.raw) || row.raw.length !== 2) fail('module command closure incomplete');
      for (const [index, stream] of ['stdout', 'stderr'].entries()) {
        const reference = row.raw[index], name = row.label + '.' + stream + '.raw.log', body = read(name);
        if (reference.path !== name || reference.bytes !== body.length || reference.sha256 !== hash(body) || reference.sizeIsFinal !== true) fail('module command raw reference mismatch');
      }
    }
  }
  return Object.freeze({ status: 'originals-verified' as const, result,
    scope: 'original-byte consistency only; controlled GitHub origin and registry capabilities remain required' as const });
}
