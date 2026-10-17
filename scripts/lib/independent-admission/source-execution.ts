import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyCliInputSet } from './source-rules';
import { collectedArtifactView, publicationMaterialView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { verifyModuleSourceOriginals, type ModuleSourceMaterialView } from './module-source-admission';
import type { CollectedArtifactCapability } from './artifact-contract';

export interface BuildArchiveMember { path: string; type: string; size: number; mode: number; sha256: string }
export interface CliExecutionInput {
  producer: any;
  /** Supplied by the controlled acquired-artifact view. No callback is an origin authority by itself. */
  readProducerOriginal(name: string, maximumBytes: number): Buffer;
  readTracked(name: string): Buffer;
  trackedPaths: readonly string[];
  archiveMembers(product: 'cli' | 'client'): readonly BuildArchiveMember[];
  readArchiveMember(product: 'cli' | 'client', name: string, maximumBytes: number): Buffer;
}
export interface CliExecutionFacts {
  actualOwnedCommandClosureVerified: boolean;
  controlledBuildDerivationVerified: boolean;
  pending: string[];
  scope: 'controlled approved commands, original inputs/outputs and owned groups; no escaped-session or reproducible-compilation attestation';
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error('Independent CLI execution: ' + reason); };
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes('\\')
  && !name.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const scope = 'controlled approved commands, original inputs/outputs and owned groups; no escaped-session or reproducible-compilation attestation' as const;

/** Computes structural execution facts from originals. Only the surrounding
 * controlled acquisition/origin adapter can qualify these as product admission. */
export function verifyCliBuildExecution(input: CliExecutionInput): CliExecutionFacts {
  return verifyExecution(input, []);
}

function verifyExecution(input: CliExecutionInput, graphs: PortableBundleGraph[]): CliExecutionFacts {
  const pending = (reason: string): CliExecutionFacts => ({ actualOwnedCommandClosureVerified: false, controlledBuildDerivationVerified: false, pending: [reason], scope });
  const producer = input.producer;
  if (producer?.schemaVersion !== 1 || producer.kind !== 'cli-publication-preparation-producer') return pending('execution-producer-schema-unreviewed');
  if (producer.buildPhases === undefined) return pending('execution-originals-missing: historical producer has no owned command/build phase originals');
  const read = (name: string, max: number) => {
    if (!safe(name)) fail('unsafe original path');
    const bytes = input.readProducerOriginal(name, max);
    if (!Buffer.isBuffer(bytes) || bytes.length > max) fail('original byte budget exceeded');
    return bytes;
  };
  const reference = (ref: any, max = 4 * 1024 * 1024): Buffer => {
    if (!ref || !/^[a-f0-9]{64}$/u.test(ref.sha256 ?? '')) fail('invalid original reference');
    const bytes = read(ref.path, max); if (hash(bytes) !== ref.sha256) fail('original reference digest mismatch'); return bytes;
  };
  const inventory = JSON.parse(reference(producer.inventory).toString());
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files)) fail('producer inventory missing');
  const rows = new Map<string, any>();
  for (const row of inventory.files) {
    if (!safe(row?.path) || rows.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '')) fail('invalid producer inventory');
    rows.set(row.path, row);
  }
  const bound = (ref: any, max?: number): Buffer => {
    const bytes = reference(ref, max), row = rows.get(ref.path);
    if (!row || row.sha256 !== ref.sha256 || row.bytes !== bytes.length) fail('original absent from producer inventory'); return bytes;
  };
  const named = (name: string, max?: number) => { const row = rows.get(name); if (!row) fail('required original missing: ' + name); return bound(row, max); };
  const source = JSON.parse(bound(producer.sourceInputs).toString());
  if (source.schemaVersion !== 1 || !Array.isArray(source.files) || canonical(source.context) !== canonical(producer.context)) fail('source input context mismatch');
  const rules = verifyCliInputSet(source.files, source.generatedBuildManifest, input.readTracked, input.trackedPaths);
  if (!rules.sourceInputSetVerified || !rules.generatedBuildManifestVerified) return pending(rules.pending ?? 'source-input-policy-unreviewed');
  for (const row of source.files) {
    const bytes = input.readTracked(row.path);
    if (row.bytes !== bytes.length || row.sha256 !== hash(bytes)) fail('source input differs from tracked source');
  }
  const cleanup = JSON.parse(named('cleanup.json').toString());
  if (cleanup.schemaVersion !== 1 || cleanup.kind !== 'cli-publication-owned-command-cleanup') return pending('owned-cleanup-schema-unreviewed');
  if (cleanup.success !== true || cleanup.sourceAbsent !== true || cleanup.rawLimitPerStream !== 262144 || cleanup.timeoutMs !== 180000) fail('owned cleanup failed or budget mismatch');
  const buildRoot = cleanup.source;
  if (typeof buildRoot !== 'string' || !path.posix.isAbsolute(buildRoot) || path.posix.normalize(buildRoot) !== buildRoot
    || !/\/\.test-data\/xpod-cli-publication-builds\/case-[A-Za-z0-9]+$/u.test(buildRoot)) fail('invalid owned build root');
  const commands = cleanup.commandOutcomes;
  if (!Array.isArray(commands) || commands.length !== 10) fail('exact ten approved commands required');
  const producerSource = input.readTracked('scripts/check-cli-publication.cjs').toString();
  const declaration = producerSource.match(/const PATCHES = \[([^\]]*)\];/u);
  if (!declaration) fail('reviewed patch declaration absent');
  const patches = [...declaration![1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
  if (patches.length !== 4) fail('reviewed patch sequence changed');
  const cliRoot = buildRoot + '/packages/xpod-cli', clientRoot = buildRoot + '/packages/xpod-client';
  const preparedArgs = commands[9]?.args;
  const inputFile = preparedArgs?.[1];
  if (typeof inputFile !== 'string' || !path.posix.isAbsolute(inputFile) || path.posix.normalize(inputFile) !== inputFile || !inputFile.endsWith('/input.json')) fail('preparation input coordinate mismatch');
  const evidenceRoot = inputFile.slice(0, -'/input.json'.length);
  const recipe = [
    { args: ['install', '--ignore-scripts', '--frozen-lockfile'], cwd: buildRoot },
    ...patches.map(name => ({ args: ['scripts/' + name], cwd: buildRoot })),
    { args: ['run', 'build:tools'], cwd: cliRoot }, { args: ['run', 'build'], cwd: clientRoot }, { args: ['run', 'build'], cwd: cliRoot },
    { args: ['pm', 'pack', '--ignore-scripts', '--filename', evidenceRoot + '/cli.tgz'], cwd: cliRoot },
    { args: ['scripts/prepare-cli-publication.ts', inputFile], cwd: buildRoot },
  ];
  for (const [index, command] of commands.entries()) {
    const label = 'phase-' + String(index).padStart(3, '0');
    if (command.receipt?.path !== label + '.receipt.json') fail('command receipt sequence mismatch');
    const original = JSON.parse(bound(command.receipt, 65536).toString());
    const { phase, receipt, ...claimed } = command;
    if (canonical(claimed) !== canonical(original) || phase !== 'bun ' + recipe[index].args.join(' ')) fail('command summary differs from original');
    if (original.command !== 'bun' || canonical(original.args) !== canonical(recipe[index].args) || original.cwd !== recipe[index].cwd) fail('unapproved command/cwd');
    if (original.code !== 0 || original.signal !== null || original.spawnError !== null || original.failure !== null
      || original.actualWait !== true || original.actualClose !== true || original.groupAbsent !== true
      || original.rawClosed !== true || original.rawClosedBeforeHash !== true || original.rawComplete !== true
      || canonical(original.pipeEOF) !== '[true,true]' || original.rawBudgetPerStream !== 262144) fail('command actual closure/success unverified');
    if (!Array.isArray(original.raw) || original.raw.length !== 2) fail('raw stdout/stderr originals required');
    for (const [stream, raw] of original.raw.entries()) {
      if (raw.path !== label + (stream === 0 ? '.stdout.raw.log' : '.stderr.raw.log') || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || raw.bytes > 262144) fail('invalid command raw coordinate/budget');
      const bytes = bound(raw, 262144); if (bytes.length !== raw.bytes) fail('command raw size mismatch');
    }
  }
  if (!Array.isArray(producer.buildPhases) || producer.buildPhases.length !== 3) fail('three approved build snapshots required');
  const expectedInputs = source.files.map((row: any) => {
    const bytes = row.path === 'package.json' ? Buffer.from(JSON.stringify(source.generatedBuildManifest, null, 2)) : input.readTracked(row.path);
    return { path: row.path, buildPath: row.path === 'packages/xpod-cli/publication.bun.lock' ? 'bun.lock' : row.path,
      bytes: bytes.length, sha256: hash(bytes) };
  }).sort((a: any, b: any) => a.path.localeCompare(b.path));
  const generated = Buffer.from(JSON.stringify(source.generatedBuildManifest, null, 2));
  const copiedInputs = new Set<string>(source.files.map((row: any) => row.path));
  const roles = ['cli-build-tools', 'client-build', 'cli-build'] as const;
  for (const [index, ref] of producer.buildPhases.entries()) {
    const label = 'phase-00' + (index + 5), role = roles[index];
    if (ref.role !== role || ref.path !== label + '.build.json') fail('build snapshot sequence mismatch');
    const snapshot = JSON.parse(bound(ref).toString());
    if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'cli-publication-build-phase' || snapshot.role !== role
      || canonical(snapshot.command) !== canonical(commands[index + 5].receipt)
      || canonical(snapshot.inputsBefore) !== canonical(expectedInputs) || canonical(snapshot.inputsAfter) !== canonical(expectedInputs)
      || snapshot.generatedBuildManifest?.bytes !== generated.length || snapshot.generatedBuildManifest.sha256 !== hash(generated)) fail('build input/command snapshot mismatch');
    if (!Array.isArray(snapshot.outputs) || !snapshot.outputs.length || !Array.isArray(snapshot.metafiles)) fail('compiled output/metafile inventory missing');
    const outputPaths = new Set<string>();
    for (const row of snapshot.outputs) {
      if (!safe(row?.path) || outputPaths.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '') || !Number.isInteger(row.mode)) fail('invalid build output inventory');
      outputPaths.add(row.path);
      const product = role === 'client-build' ? 'client' : 'cli';
      const member = input.archiveMembers(product).find(member => member.path === 'package/dist/' + row.path && member.type === 'file');
      if (!member || member.size > 8 * 1024 * 1024 || member.size !== row.bytes || member.sha256 !== row.sha256 || member.mode !== row.mode) fail('build output differs from final archive');
      const bytes = input.readArchiveMember(product, member!.path, Math.max(member!.size, 1));
      if (bytes.length !== member!.size || hash(bytes) !== row.sha256) fail('archive member original differs from output');
    }
    if (role !== 'cli-build-tools') {
      const product = role === 'client-build' ? 'client' : 'cli';
      const members = input.archiveMembers(product).filter(row => row.type === 'file' && row.path.startsWith('package/dist/'));
      if (members.length !== outputPaths.size || members.some(row => !outputPaths.has(row.path.slice('package/dist/'.length)))) fail('compiled output exact set mismatch');
    }
    const verifyMetafile = (bytes: Buffer, outputName: string, entryPoint: string, product: 'cli' | 'client', originalPath: string) => {
      const metadata = JSON.parse(bytes.toString());
      if (!metadata.inputs || !Object.keys(metadata.inputs).length || !metadata.outputs
        || Object.keys(metadata.outputs).length !== 1) fail('compiled metafile graph absent');
      const output = metadata.outputs['./' + outputName];
      const recorded = snapshot.outputs.find((row: any) => row.path === outputName);
      if (!output || !recorded || output.bytes !== recorded.bytes || output.entryPoint !== entryPoint || !output.inputs) fail('metafile compiled output binding mismatch');
      const graphInputs: PortableBundleInput[] = [];
      for (const [name, row] of Object.entries(metadata.inputs) as Array<[string, any]>) {
        if (!Number.isSafeInteger(row?.bytes) || row.bytes < 0) fail('invalid metafile input size');
        const trackedName = name.startsWith('src/') ? 'packages/xpod-' + product + '/' + name
          : product === 'cli' && name.startsWith('../../src/') ? name.slice(6) : null;
        if (trackedName && input.readTracked(trackedName).length !== row.bytes) fail('metafile tracked input byte mismatch');
        const trackedBytes = trackedName && copiedInputs.has(trackedName) ? input.readTracked(trackedName) : undefined;
        graphInputs.push(Object.freeze({ path: name, bytes: row.bytes, ...(trackedBytes ? { sourcePath: trackedName!, sha256: hash(trackedBytes) } : {}),
          ...(Object.prototype.hasOwnProperty.call(output.inputs, name) ? { bytesInOutput: output.inputs[name].bytesInOutput } : {}) }));
      }
      for (const [name, row] of Object.entries(output.inputs) as Array<[string, any]>) {
        if (!Object.prototype.hasOwnProperty.call(metadata.inputs, name) || !Number.isSafeInteger(row?.bytesInOutput) || row.bytesInOutput < 0) fail('metafile contributing input missing');
      }
      graphs.push(Object.freeze({ role, product, path: 'dist/' + outputName, bytes: recorded.bytes, sha256: recorded.sha256,
        inputs: Object.freeze(graphInputs), inputUniverseComplete: graphInputs.every(row => row.sha256 !== undefined),
        metafile: Object.freeze({ path: originalPath, bytes: bytes.length, sha256: hash(bytes) }), readMetafile: () => Buffer.from(bytes),
        readInputOriginalRange(name: string, offset: number, length: number): Buffer {
          const row = graphInputs.find(row => row.path === name);
          if (!row?.sourcePath || !row.sha256) return fail('bundle input original unresolved');
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
            || length > 65536 || offset > row.bytes - length) return fail('bundle input range bound');
          const original = input.readTracked(row.sourcePath);
          if (original.length !== row.bytes || hash(original) !== row.sha256) return fail('bundle input original changed');
          return Buffer.from(original.subarray(offset, offset + length));
        } }));
    };
    if (role === 'client-build') {
      const row = snapshot.outputs.find((row: any) => row.path === 'inputs.json');
      if (!row) fail('runtime client metafile absent from output archive');
      verifyMetafile(input.readArchiveMember('client', 'package/dist/inputs.json', 4 * 1024 * 1024), 'library.cjs', 'src/index.ts', 'client', 'dist/inputs.json');
    }
    const expectedMetafiles = role === 'client-build' ? [] : role === 'cli-build-tools'
      ? ['build-tools-cjs-inputs.json', 'build-tools-esm-inputs.json']
      : ['build-tools-cjs-inputs.json', 'build-tools-esm-inputs.json', 'client-inputs.json', 'npm-entry-inputs.json', 'output-inputs.json'];
    if (snapshot.metafiles.length !== expectedMetafiles.length) fail('metafile exact set mismatch');
    for (const name of expectedMetafiles) {
      const row = snapshot.metafiles.find((row: any) => row.path === name);
      if (!row || row.original?.path !== label + '.metafiles/' + name || row.original.sha256 !== row.sha256) fail('metafile original binding missing');
      const bytes = bound(row.original); if (bytes.length !== row.bytes) fail('metafile size mismatch');
      const output = name === 'npm-entry-inputs.json' ? ['xpod.mjs', 'src/npm-entry.ts']
        : name === 'client-inputs.json' ? ['client.cjs', 'src/client.ts']
        : name === 'output-inputs.json' ? ['output.mjs', 'src/lib/output.ts']
        : name === 'build-tools-cjs-inputs.json' ? ['build-tools.cjs', 'src/build-tools.ts'] : ['build-tools.mjs', 'src/build-tools.ts'];
      verifyMetafile(bytes, output[0], output[1], 'cli', row.original.path);
    }
  }
  // Preparation JSON must be the actual supervised, hash-closed stdout original.
  const preparation = JSON.parse(bound(producer.preparation).toString());
  if (canonical(JSON.parse(named('phase-009.stdout.raw.log', 262144).toString())) !== canonical(preparation)) fail('preparation differs from command original stdout');
  return { actualOwnedCommandClosureVerified: true, controlledBuildDerivationVerified: true, pending: [], scope };
}


export interface PortableBundleInput {
  readonly path: string; readonly bytes: number; readonly sha256?: string;
  readonly sourcePath?: string; readonly bytesInOutput?: number;
}
export interface PortableBundleGraph {
  readonly role: string; readonly product: 'cli' | 'client';
  readonly path: string; readonly bytes: number; readonly sha256: string;
  readonly inputs: readonly PortableBundleInput[];
  readonly inputUniverseComplete: boolean;
  readonly metafile: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readMetafile(): Buffer;
  readInputOriginalRange(name: string, offset: number, length: number): Buffer;
}
export interface PortableSourceMaterialView {
  readonly identity: { readonly sourceSha: string; readonly package: string; readonly version: string; readonly archiveSha256: string };
  readonly outputs: readonly PortableBundleGraph[];
  readonly dependencySnapshotVerified: boolean;
  readonly dependencyOriginals?: Pick<ModuleSourceMaterialView, 'dependencyRows' | 'dependencyOriginalIdentity' | 'readDependencyOriginal' | 'readDependencyOriginalRange'>;
  readonly pending: readonly string[];
}
const portableIssued = new WeakMap<object, PortableSourceMaterialView>();
const portableReaderGroups = new WeakMap<object, { readable: boolean; compact(): void }>();
/** The coordinator calls this only after both related products finish all gates.
 * One shared lease revokes both products' original readers, preserving facts. */
export function compactPortableSourceMaterials(artifact: unknown): void {
  if (!portableSourceMaterialView(artifact)) return fail('issued portable source materials capability required');
  const group = portableReaderGroups.get(artifact as object);
  if (!group) return fail('portable original reader group absent');
  if (group.readable) { group.readable = false; group.compact(); }
}
export function portableSourceMaterialView(artifact: unknown): PortableSourceMaterialView | undefined {
  return artifact !== null && typeof artifact === 'object' && collectedArtifactView(artifact) ? portableIssued.get(artifact) : undefined;
}

/** Operational issuer: arbitrary structural callbacks and serialized reports can
 * never register portable source materials. Both archives and immutable Git must
 * be independently issued capabilities before the one execution verification. */
export function verifyCollectedCliBuildExecution(input: {
  artifact: CollectedArtifactCapability; source: unknown; relatedArtifacts?: readonly CollectedArtifactCapability[];
}): CliExecutionFacts {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source);
  if (!artifact || !source || source.sourceSha !== artifact.identity.sourceSha) return fail('private collected archives and exact derived source required');
  const materials = publicationMaterialView(input.artifact);
  if (!materials) return fail('private publication producer originals required');
  const original = materials.readOriginal(materials.producerReceipt.path, 4 * 1024 ** 2);
  if (original.length !== materials.producerReceipt.bytes || hash(original) !== materials.producerReceipt.sha256) return fail('publication producer original binding mismatch');
  const producer = JSON.parse(original.toString());
  const caps = [input.artifact, ...(input.relatedArtifacts ?? [])];
  const products = new Map<'cli' | 'client', { cap: CollectedArtifactCapability; view: NonNullable<ReturnType<typeof collectedArtifactView>> }>();
  for (const role of ['cli', 'client'] as const) {
    const expected = producer.products?.[role];
    for (const cap of caps) {
      const view = collectedArtifactView(cap);
      if (view && expected && view.identity.sourceSha === source.sourceSha && view.identity.package === expected.package
        && view.identity.version === expected.version && view.identity.archiveSha256 === expected.archive?.sha256) products.set(role, { cap, view });
    }
  }
  if (products.size !== 2) return fail('exact controlled CLI and client archives required');
  const graphs: PortableBundleGraph[] = [];
  const facts = verifyExecution({ producer, readProducerOriginal: materials.readOriginal,
    readTracked: source.readTracked, trackedPaths: source.trackedPaths,
    archiveMembers: role => products.get(role)!.view.members.map(row => ({ path: 'package/' + row.path, type: 'file', size: row.bytes, mode: row.mode, sha256: row.sha256 })),
    readArchiveMember: (role, name, maximum) => {
      if (!name.startsWith('package/')) return fail('unexpected controlled archive root');
      return products.get(role)!.view.readMember(name.slice(8), maximum);
    } }, graphs);
  if (!facts.controlledBuildDerivationVerified) return facts;
  let snapshot: ReturnType<typeof verifyModuleSourceOriginals> | undefined;
  let observedBuildRoot: string | undefined;
  const portableSourceFiles = new Map<string, Buffer>();
  if (producer.sourceMaterials !== undefined) {
    if (!artifact.readProducerOriginalRange) return fail('portable source materials bounded range reader required');
    const ref = producer.sourceMaterials;
    if (ref.path !== 'source-materials/materials.json') return fail('portable source master path');
    const raw = materials.readOriginal(ref.path, 4 * 1024 ** 2);
    if (raw.length !== ref.bytes || hash(raw) !== ref.sha256) return fail('portable source master binding');
    const master = JSON.parse(raw.toString());
    const sourceInputs = JSON.parse(materials.readOriginal(producer.sourceInputs.path, 4 * 1024 ** 2).toString());
    const actualSources = new Map<string, { mode: string; bytes: Buffer }>();
    for (const row of sourceInputs.files) {
      const name = row.path === 'packages/xpod-cli/publication.bun.lock' ? 'bun.lock' : row.path;
      const bytes = row.path === 'package.json' ? Buffer.from(JSON.stringify(sourceInputs.generatedBuildManifest, null, 2)) : source.readTracked(row.path);
      // The source snapshot's Git bytes and generated manifest were verified by
      // the one execution check above. File mode is observed in its tar row.
      actualSources.set(name, { mode: '100644', bytes });
    }
    // Preserve executable Git mode where supplied by the private derived view.
    for (const row of sourceInputs.files) if (source.readTrackedGitObject && row.path !== 'package.json') {
      const name = row.path === 'packages/xpod-cli/publication.bun.lock' ? 'bun.lock' : row.path;
      const object = source.readTrackedGitObject(row.path);
      actualSources.set(name, object);
    }
    const initial = JSON.parse(materials.readOriginal('source-materials-inputs.json', 4 * 1024 ** 2).toString());
    for (const domain of ['source', 'dependencies', 'toolchain']) if (canonical(initial[domain]) !== canonical(master[domain])) return fail('portable captured before/after original custody differs');
    for (const [name, object] of actualSources) portableSourceFiles.set(name, object.bytes);
    const cleanup = JSON.parse(materials.readOriginal('cleanup.json', 4 * 1024 ** 2).toString());
    observedBuildRoot = cleanup.source;
    for (const action of ['before', 'after']) {
      const label = 'source-capture-' + action;
      const receipt = JSON.parse(materials.readOriginal(label + '.receipt.json', 65536).toString());
      const expectedArgs = ['-I', '-B', cleanup.source + '/scripts/lib/module-source-materials.py', 'portable-' + action,
        cleanup.source, path.posix.dirname(receipt.args?.[6] ?? ''), receipt.args?.[6]];
      if (receipt.command !== 'python3' || receipt.cwd !== cleanup.source || canonical(receipt.args) !== canonical(expectedArgs)
        || !expectedArgs[6]?.endsWith('/' + label + '.request.json') || receipt.code !== 0 || receipt.signal !== null
        || receipt.failure !== null || receipt.spawnError !== null || receipt.actualWait !== true || receipt.actualClose !== true || receipt.groupAbsent !== true
        || receipt.rawComplete !== true || receipt.rawClosedBeforeHash !== true || receipt.rawClosed !== true
        || canonical(receipt.pipeEOF) !== '[true,true]' || receipt.raw?.length !== 2) return fail('portable source capture actual closure mismatch');
      const request = JSON.parse(materials.readOriginal(label + '.request.json', 4 * 1024 ** 2).toString());
      if (action === 'before' ? canonical(request.sourcePaths.slice().sort()) !== canonical([...actualSources.keys()].sort())
        : canonical(request.phases) !== canonical(master.phases) || canonical(request.archive) !== canonical(master.archive)) return fail('portable capture request binding');
      const result = JSON.parse(materials.readOriginal(label + '.stdout.raw.log', 262144).toString());
      const expectedResult = action === 'after' ? producer.sourceMaterials : artifact.producerOriginals.find(row => row.path === 'source-materials-inputs.json');
      if (!expectedResult || result.path !== expectedResult.path || result.bytes !== expectedResult.bytes || result.sha256 !== expectedResult.sha256) return fail('portable capture original stdout binding');
      for (const [stream, ref] of receipt.raw.entries()) {
        if (ref.path !== label + (stream === 0 ? '.stdout.raw.log' : '.stderr.raw.log')) return fail('portable capture raw coordinate');
        const bytes = materials.readOriginal(ref.path, 262144);
        if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) return fail('portable capture raw binding');
      }
    }
    snapshot = verifyModuleSourceOriginals({ materials: master, producer: { phases: producer.buildPhases, archive: { kind: 'cli-client-dist-inventories' } },
      inventory: artifact.producerOriginals, members: [...products].flatMap(([role, row]) => row.view.members.filter(member => member.path.startsWith('dist/')).map(member => ({ ...member, path: role + '/' + member.path }))),
      trackedPaths: [...actualSources.keys()], readTrackedObject: name => actualSources.get(name) ?? fail('portable copied source absent'),
      readOriginal: materials.readOriginal, readRange: artifact.readProducerOriginalRange });
  }
  const completeGraphs = graphs.map(graph => {
    const inputs = graph.inputs.map(row => {
      if (row.sha256 || !snapshot) return row;
      const resolved = portableMetafileInputPath(graph.product, row.path, observedBuildRoot);
      if (!resolved || !safe(resolved)) return row;
      if (!resolved.split('/').includes('node_modules')) {
        const original = portableSourceFiles.get(resolved);
        if (!original) return row;
        if (original.length !== row.bytes) return fail('metafile copied source input byte mismatch');
        return Object.freeze({ ...row, sourcePath: resolved, sha256: hash(original) });
      }
      let original: Readonly<{ bytes: number; sha256: string }>;
      try { original = snapshot.dependencyOriginalIdentity(resolved); }
      catch (error) { if (error instanceof Error && error.message.includes('dependency original missing')) return row; throw error; }
      if (original.bytes !== row.bytes) return fail('metafile dependency input byte mismatch');
      return Object.freeze({ ...row, sourcePath: resolved, sha256: original.sha256 });
    });
    return Object.freeze({ ...graph, inputs: Object.freeze(inputs), inputUniverseComplete: inputs.every(row => row.sha256 !== undefined),
      readInputOriginalRange(name: string, offset: number, length: number): Buffer {
        const row = inputs.find(row => row.path === name);
        if (!row?.sha256 || !row.sourcePath) return fail('bundle input original unresolved');
        if (row.sourcePath.split('/').includes('node_modules')) return snapshot!.readDependencyOriginalRange(row.sourcePath, offset, length);
        const original = portableSourceFiles.get(row.sourcePath);
        if (original) {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 65536 || offset > row.bytes - length) return fail('bundle input range bound');
          return Buffer.from(original.subarray(offset, offset + length));
        }
        return graph.readInputOriginalRange(name, offset, length);
      } });
  });
  const group = { readable: true, compact() { snapshot?.compactOriginalReaders(); portableSourceFiles.clear(); } };
  const assertReadable = () => { if (!group.readable) return fail('portable source original readers compacted'); };
  for (const [role, product] of products) {
    portableReaderGroups.set(product.cap, group);
    const outputs = Object.freeze(completeGraphs.filter(graph => graph.product === role).map(graph => Object.freeze({ ...graph,
      readMetafile() { assertReadable(); return graph.readMetafile(); },
      readInputOriginalRange(name: string, offset: number, length: number) { assertReadable(); return graph.readInputOriginalRange(name, offset, length); },
    })));
    portableIssued.set(product.cap, Object.freeze({ identity: Object.freeze({ ...product.view.identity }), outputs, dependencySnapshotVerified: snapshot !== undefined, dependencyOriginals: snapshot,
      pending: Object.freeze([...(snapshot ? [] : ['portable-source-capture-originals-missing']), ...outputs.flatMap(row => row.inputUniverseComplete ? [] : ['bundle-input-originals-unresolved:' + row.path])]) }));
  }
  return facts;
}


/** Path interpretation only; this does not assert that an input exists. Every
 * returned dependency path must still resolve to the verified snapshot bytes. */
export function portableMetafileInputPath(product: 'cli' | 'client', name: string, observedBuildRoot?: string): string | undefined {
  if (typeof name !== 'string' || !name || /[\\\u0000-\u001f\u007f]/u.test(name)) return undefined;
  let relative: string;
  if (path.posix.isAbsolute(name)) {
    if (!observedBuildRoot || !name.startsWith(observedBuildRoot + '/')) return undefined;
    relative = name.slice(observedBuildRoot.length + 1);
  } else relative = path.posix.join('packages/xpod-' + product, name);
  const resolved = path.posix.normalize(relative);
  return safe(resolved) ? resolved : undefined;
}
