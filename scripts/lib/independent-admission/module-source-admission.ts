import type {OriginalReadBudget} from './artifact-contract';
import {inspectModuleNativeBuildOriginals,type ModuleNativeBuildOriginalView} from './module-native-build-originals';
import {inspectSourceOriginalTar} from './source-original-tar';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView,assertCollectedPublicationCustody } from './artifact-collector';
import { derivedSourceView,assertDerivedSourceCurrent } from './source-context';
import { githubOriginFacts, githubOriginOriginals, type GitHubOriginObservation } from './github-origin';
import { inspectModuleSourcePhases } from './module-source-phases';

const MiB = 1024 ** 2;
const limits = JSON.parse(readFileSync(new URL('../module-artifact-limits.json', import.meta.url), 'utf8'));
const fail = (message: string): never => { throw new Error('Module source originals: ' + message); };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.startsWith('/')
  && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const sensitive = (name: string) => name.toLowerCase().split('/').some(part => ['.test-data', '.git', '.env', '.env.local', '.env.cloud', '.env.server', 'credentials.json', '.npmrc', '.netrc', '.ssh'].includes(part));
type Row = { path: string; archive: string; kind: 'file' | 'symlink'; bytes?: number; sha256?: string; mode?: number; target?: string; executable?: string; version?: string };
type Reference = { path: string; bytes: number; sha256: string };
export interface ModuleSourceMaterialView {
  readonly sourceSha: string;
  readonly nativeBuildOriginals?: ModuleNativeBuildOriginalView;
  readonly dependencyRows: readonly Readonly<Row>[];
  readonly trackedSourcePaths: readonly string[];
  readonly outputs: readonly Readonly<Reference & { mode: number }>[];
  readonly scope: 'controlled-recipe-input-universe';
  readonly transpiledOutputs: readonly { readonly path: string; readonly sourcePath: string }[];
  readDependencyOriginal(name: string, maximumBytes: number): Buffer;
  dependencyOriginalIdentity(name: string): Readonly<{ bytes: number; sha256: string }>;
  readDependencyOriginalRange(name: string, offset: number, length: number): Buffer;
  compactOriginalReaders(): void;
}
const issued = new WeakMap<object, ModuleSourceMaterialView>();
export function compactModuleSourceMaterials(value: unknown): void {
  const view = moduleSourceMaterialView(value);
  if (!view) return fail('issued module source materials capability required');
  view.compactOriginalReaders();
}
export function moduleSourceMaterialView(value: unknown): ModuleSourceMaterialView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}

/** Same existing source material capability; optional product means exact handle. */
export function moduleNativeBuildOriginals(value:unknown,product?:unknown):ModuleNativeBuildOriginalView|undefined {
 const native=moduleSourceMaterialView(value)?.nativeBuildOriginals;if(native){native.assertCurrent();if(product!==undefined)native.assertProduct(product);}return native;
}

/** Structural byte checker; callbacks confer no custody. Only the operational
 * wrapper below issues a view after immutable source/origin/phase validation. */
export function verifyModuleSourceOriginals(input: {
  materials: any; producer: any; inventory: readonly Reference[];
  members: readonly (Reference & { mode: number })[];
  trackedPaths: readonly string[];
  readTrackedObject(name: string): { mode: string; bytes: Buffer };
  readOriginal(name: string, maximumBytes: number,budget?:OriginalReadBudget): Buffer;
  readRange(name: string, offset: number, length: number,budget?:OriginalReadBudget): Buffer;
  budget?:OriginalReadBudget;
  compilerOriginal?: Buffer;
}): Omit<ModuleSourceMaterialView, 'sourceSha'> {
  const deadline = Date.now() + limits.timeoutMs;
  const verificationBudget:OriginalReadBudget={remainingMilliseconds:()=>Math.min(deadline-Date.now(),input.budget?.remainingMilliseconds()??Infinity)};
  const checkDeadline = () => { const remaining=verificationBudget.remainingMilliseconds();if (!Number.isFinite(remaining)||remaining<=0) return fail('verification deadline'); };
  const m = input.materials, producer = input.producer;
  if (m?.schemaVersion !== 1 || m.kind !== 'module-source-build-originals'
    || !isDeepStrictEqual(m.phases, producer.phases) || !isDeepStrictEqual(m.archive, producer.archive)) return fail('build/archive receipt binding');
  const originalMap = new Map(input.inventory.map(row => [row.path, row]));
  const bound = new Set<string>();
  let total = 0, itemCount = 0;
  const reference = (ref: Reference, pattern: RegExp, limit: number) => {
    const actual = originalMap.get(ref?.path);
    if (!ref || !pattern.test(ref.path) || !actual || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > limit
      || actual.bytes !== ref.bytes || actual.sha256 !== ref.sha256 || !/^[a-f0-9]{64}$/u.test(ref.sha256) || bound.has(ref.path)) return fail('original inventory reference');
    bound.add(ref.path); total += ref.bytes;
    if (total > limits.sourceMaterialBytes) return fail('original total byte bound');
  };
  const json = (ref: Reference) => {
    const bytes = input.readOriginal(ref.path, limits.metadataBytes,verificationBudget);
    if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) return fail('metadata digest');
    return JSON.parse(bytes.toString());
  };
  const locations = new Map<string, { archive: string; offset: number; bytes: number }>();
  const groups = new Map<string, Row[]>();
  for (const domain of ['source', 'dependencies', 'toolchain']) {
    const group = m[domain];
    if (!Array.isArray(group?.archives) || !group.archives.length || !Array.isArray(group.inventories) || !group.inventories.length
      || group.archives.length > 32 || group.inventories.length > 64) return fail('complete sharded input group required');
    const archives = new Map<string, Reference>();
    let domainBytes = 0;
    for (const ref of group.archives) {
      reference(ref, new RegExp(`^source-materials/${domain}-[0-9]{4}\\.tar$`, 'u'), limits.shardBytes);
      domainBytes += ref.bytes; archives.set(ref.path, ref);
    }
    if (domainBytes > limits[domain === 'dependencies' ? 'dependencyBytes' : domain === 'toolchain' ? 'toolchainBytes' : 'sourceBytes']) return fail('input domain byte bound');
    const rows = new Map<string, Row>();
    for (const ref of group.inventories) {
      reference(ref, new RegExp(`^source-materials/${domain}-inventory-[0-9]{4}\\.json$`, 'u'), limits.metadataBytes);
      const values = json(ref);
      if (!Array.isArray(values)) return fail('inventory array required');
      for (const row of values) {
        if (++itemCount > limits.sourceMembers || !safe(row?.path) || (sensitive(row.path) && !(domain === 'source' && row.path === '.github/tooling/legacy-root-verifier/.npmrc')) || rows.has(row.path) || !archives.has(row.archive)
          || !['file', 'symlink'].includes(row.kind)) return fail('input item path/type');
        if (row.kind === 'file' && (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)
          || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777)) return fail('input ordinary file identity');
        if (row.kind === 'symlink' && (typeof row.target !== 'string' || !row.target || path.posix.isAbsolute(row.target)
          || !safe(path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.target))))) return fail('input link escape');
        if (domain === 'dependencies' && !row.path.split('/').includes('node_modules')) return fail('dependency root mismatch');
        rows.set(row.path, Object.freeze({ ...row }));
      }
    }
    const seen = new Set<string>();
    for (const [name, ref] of archives) {
      const observed=inspectSourceOriginalTar({archive:ref,rows,readRange:(name,offset,length)=>input.readRange(name,offset,length,verificationBudget),check:checkDeadline});
      for(const member of observed.seen){if(seen.has(member))return fail('duplicate tar original');seen.add(member);}
      for(const [member,location] of observed.locations)locations.set(member,location);
    }
    if (seen.size !== rows.size) return fail('missing tar original');
    groups.set(domain, [...rows.values()]);
  }
  for (const domain of ['source', 'dependencies', 'toolchain']) {
    const refs = m.revalidation?.[domain];
    if (!Array.isArray(refs) || !refs.length || refs.length > 64) return fail('post-build input originals revalidation required');
    const observed: Row[] = [];
    for (const ref of refs) {
      reference(ref, new RegExp(`^source-materials/${domain}-inventory-[0-9]{4}\\.json$`, 'u'), limits.metadataBytes);
      const rows = json(ref); if (!Array.isArray(rows)) return fail('post-build input inventory array'); observed.push(...rows);
    }
    if (!isDeepStrictEqual(observed, groups.get(domain))) return fail('post-build actual inputs changed');
  }
  const sources = groups.get('source')!;
  if (!isDeepStrictEqual(sources.map(row => row.path).sort(), [...input.trackedPaths].sort())) return fail('complete immutable Git tree required');
  for (const row of sources) {
    const object = input.readTrackedObject(row.path);
    if (row.kind === 'symlink' ? object.mode !== '120000' || object.bytes.toString() !== row.target
      : !['100644', '100755'].includes(object.mode) || object.bytes.length !== row.bytes || hash(object.bytes) !== row.sha256
        || row.mode !== (object.mode === '100755' ? 0o755 : 0o644)) return fail('input differs from immutable Git object');
  }
  const tools = groups.get('toolchain')!;
  if (!isDeepStrictEqual(tools.map(row => row.path).sort(), ['bun', 'git', 'node', 'python3'])
    || tools.some(row => row.kind !== 'file' || typeof row.executable !== 'string' || !row.executable.startsWith('/') || typeof row.version !== 'string' || !row.version)) return fail('actual compiler tool originals required');
  const outputs: (Reference & { mode: number })[] = [];
  if (!Array.isArray(m.outputs) || !m.outputs.length || m.outputs.length > 64) return fail('output inventories missing');
  for (const ref of m.outputs) {
    reference(ref, /^source-materials\/outputs-[0-9]{4}\.json$/u, limits.metadataBytes);
    const rows = json(ref); if (!Array.isArray(rows)) return fail('output inventory array'); outputs.push(...rows);
  }
  const sort = (rows: readonly any[]) => rows.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode })).sort((a, b) => a.path.localeCompare(b.path));
  if (!isDeepStrictEqual(sort(outputs), sort(input.members))) return fail('actual build output differs from product archive');
  const transpiledOutputs: { path: string; sourcePath: string }[] = [];
  if (input.compilerOriginal) {
    const boundCompiler = outputs.find(row => row.path === 'provenance/compiler.json');
    if (!boundCompiler || boundCompiler.bytes !== input.compilerOriginal.length || boundCompiler.sha256 !== hash(input.compilerOriginal)) return fail('compiler output mapping original binding');
    const compiler = JSON.parse(input.compilerOriginal.toString());
    if (!Array.isArray(compiler.compiledSources)) return fail('actual compiler mapping missing');
    const sourceRows = new Map(sources.map(row => [row.path, row]));
    const outputRows = new Map(outputs.map(row => [row.path, row]));
    const mapped = new Set<string>();
    for (const row of compiler.compiledSources) {
      const from = sourceRows.get(row?.source), to = outputRows.get(row?.output);
      if (!from || from.kind !== 'file' || !to || from.sha256 !== row.sourceSHA256 || to.sha256 !== row.outputSHA256 || mapped.has(row.output)) return fail('compiler mapping differs from real input/output');
      mapped.add(row.output); transpiledOutputs.push(Object.freeze({ path: row.output, sourcePath: row.source }));
    }
  }
  const dependencies = groups.get('dependencies')!;
  const links = new Map([...sources, ...dependencies].map(row => [row.path, row]));
  let readable = true;
  const resolveDependency = (name: string) => {
    if (!readable) return fail('source original readers compacted');
    if (!safe(name) || !name.split('/').includes('node_modules')) return fail('dependency read bound');
    let resolved = name;
    for (let hops = 0; hops < 64; hops++) {
      const parts = resolved.split('/'); let changed = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), row = links.get(prefix);
        if (row?.kind === 'symlink') {
          resolved = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), row.target!, ...parts.slice(i)));
          if (!safe(resolved)) return fail('dependency link escape'); changed = true; break;
        }
      }
      if (changed) continue;
      const location = locations.get(resolved), row = links.get(resolved);
      if (!location || !row || row.kind !== 'file') return fail('dependency original missing');
      return { location, row };
    }
    return fail('dependency link cycle');
  };
  const readDependencyRange = (location: { archive: string; offset: number; bytes: number }, offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
      || length > limits.rangeBytes || offset > location.bytes - length) return fail('dependency range bound');
    const bytes = input.readRange(location.archive, location.offset + offset, length);
    if (bytes.length !== length) return fail('dependency original truncated');
    return bytes;
  };
  return Object.freeze({ compactOriginalReaders() { readable = false; locations.clear(); }, dependencyRows: Object.freeze(dependencies), trackedSourcePaths: Object.freeze([...input.trackedPaths]),
    outputs: Object.freeze(outputs.map(row => Object.freeze({ ...row }))), transpiledOutputs: Object.freeze(transpiledOutputs), scope: 'controlled-recipe-input-universe' as const,
    dependencyOriginalIdentity(name: string) {
      const { location, row } = resolveDependency(name);
      return Object.freeze({ bytes: location.bytes, sha256: row.sha256! });
    },
    readDependencyOriginalRange(name: string, offset: number, length: number): Buffer {
      const { location } = resolveDependency(name);
      return readDependencyRange(location, offset, length);
    },
    readDependencyOriginal(name: string, maximumBytes: number): Buffer {
      const { location, row } = resolveDependency(name);
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > limits.metadataBytes
        || location.bytes > maximumBytes) return fail('dependency read bound');
      const bytes = Buffer.alloc(location.bytes);
      for (let offset = 0; offset < bytes.length; offset += limits.rangeBytes) {
        readDependencyRange(location, offset, Math.min(limits.rangeBytes, bytes.length - offset)).copy(bytes, offset);
      }
      if (hash(bytes) !== row.sha256) return fail('dependency original changed'); return bytes;
    } });
}

export function inspectModuleSourceAdmission(input: { artifact: unknown; source: unknown; origin: unknown }) {
  const startedAt=performance.now();
  const operationBudget:OriginalReadBudget={remainingMilliseconds:()=>limits.timeoutMs-(performance.now()-startedAt)};
  const phases = inspectModuleSourcePhases(input);
  if (phases.status !== 'observed') return phases;
  const artifact = collectedArtifactView(input.artifact)!, source = derivedSourceView(input.source)!;
  const producer = JSON.parse(artifact.readProducerOriginal('producer.receipt.json', MiB).toString());
  if (producer.status !== 'controlled-preview-materials') return fail('producer did not finish controlled production');
  const ref = producer.sourceMaterials;
  if (ref === undefined) return { status: 'pending' as const, sourceQualified: false as const, reason: 'restorable-module-build-originals-missing' };
  if (ref?.path !== 'source-materials/materials.json' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > limits.metadataBytes) return fail('master original reference');
  const bytes = artifact.readProducerOriginal(ref.path, limits.metadataBytes,operationBudget);
  if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) return fail('master original digest');
  const materials = JSON.parse(bytes.toString());
  const origin = githubOriginFacts(input.origin)!;
  const jobs = githubOriginOriginals(input.origin as GitHubOriginObservation).find(row => row.name === 'jobs.original.json');
  const job = jobs && JSON.parse(jobs.data.toString()).jobs.find((row: any) => row.id === origin.producerJobId);
  if (!job) return fail('observed source producer job missing');
  const receipts = producer.phases.map((phase: any) => JSON.parse(artifact.readProducerOriginal(phase.receipt.path, MiB).toString()));
  const revalidatedStart = Date.parse(materials.revalidation?.startedUTC), revalidatedClosed = Date.parse(materials.revalidation?.closedUTC);
  const started = Date.parse(materials.capturedInputsStartedUTC), closed = Date.parse(materials.capturedInputsClosedUTC), outputs = Date.parse(materials.capturedOutputsClosedUTC);
  if (![started, closed, outputs, revalidatedStart, revalidatedClosed].every(Number.isFinite) || started < Date.parse(receipts[0].closedUTC)
    || revalidatedStart < Date.parse(receipts[receipts.length - 1].closedUTC) || revalidatedClosed < revalidatedStart || outputs < revalidatedClosed
    || closed < started || closed > Date.parse(receipts[1].startedUTC) || outputs < Date.parse(receipts[receipts.length - 1].closedUTC) || outputs > Date.parse(job.completed_at)) return fail('actual build input/output capture window');
  const ranged = artifact as typeof artifact & { readProducerOriginalRange?: (name: string, offset: number, length: number,budget?:OriginalReadBudget) => Buffer };
  const git = source as typeof source & { readTrackedGitObject?: (name: string) => { mode: string; bytes: Buffer } };
  if (!ranged.readProducerOriginalRange || !git.readTrackedGitObject) return { status: 'pending' as const, sourceQualified: false as const, reason: 'original-range-and-Git-object-capabilities-required' };
  const checked = verifyModuleSourceOriginals({ materials, producer, inventory: artifact.producerOriginals,
    members: artifact.members, trackedPaths: source.trackedPaths, readTrackedObject: git.readTrackedGitObject,
    readOriginal:artifact.readProducerOriginal,readRange:ranged.readProducerOriginalRange,budget:operationBudget,
    ...(artifact.members.some(row => row.path === 'provenance/compiler.json')
      ? { compilerOriginal: artifact.readMember('provenance/compiler.json', limits.metadataBytes) } : {}) });
  let native:ReturnType<typeof inspectModuleNativeBuildOriginals>;
  if(producer.nativeBuildOriginals!==undefined){
    if(phases.module!=='api'||!artifact.readMemberRange)return fail('controlled native product range capability required');
    const declarations=['packages/xpod-api/scripts/inngest-controlled-build-policy.json','packages/xpod-api/scripts/inngest-controlled-materials-contract.json','scripts/lib/inngest-controlled-build.py','packages/xpod-api/scripts/controlled-native-material.ts'];
    for(const name of declarations)if(!source.readTracked(name).equals(readFileSync(new URL('../../../'+name,import.meta.url))))return fail('controlled native declaration differs from reviewed controller bytes');
    const policy=JSON.parse(source.readTracked(declarations[0]!).toString()),contract=JSON.parse(source.readTracked(declarations[1]!).toString());
    native=inspectModuleNativeBuildOriginals({remainingMilliseconds:limits.timeoutMs-(performance.now()-startedAt),producer,inventory:artifact.producerOriginals,productMembers:artifact.members,identity:artifact.identity,policy,contract,
      jobWindow:{start:Date.parse(job.started_at),end:Date.parse(job.completed_at)},readOriginal:artifact.readProducerOriginal,readRange:ranged.readProducerOriginalRange,
      readProduct:artifact.readMember,readProductRange:artifact.readMemberRange,
      assertCurrent(){if(collectedArtifactView(input.artifact)!==artifact||derivedSourceView(input.source)!==source)return fail('retained native source/product handles revoked');assertCollectedPublicationCustody(input.artifact);assertDerivedSourceCurrent(input.source);},
      assertProduct(value){if(value!==input.artifact)return fail('exact original controlled product handle required');},
    });
  }
  const capability = Object.freeze({}); issued.set(capability, Object.freeze({ ...checked, sourceSha: source.sourceSha,...(native?{nativeBuildOriginals:native.view}:{}),
    compactOriginalReaders(){checked.compactOriginalReaders();native?.compact();},
  }));
  return { status: 'verified' as const, sourceQualified: true as const, reason: 'controlled-module-source-and-build-originals-verified',
    module: phases.module, target: phases.target, sourceSha: source.sourceSha, materials: capability,
    nativeSourceVerified: false as const,
    scope: 'controlled JS/TS recipe, restorable Git/dependency/compiler originals and exact product outputs; native source/SDK admission remains separate; no reproducible compilation attestation' };
}
