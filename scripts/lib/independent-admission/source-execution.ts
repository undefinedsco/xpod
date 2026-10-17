import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyCliInputSet } from './source-rules';

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
    const verifyMetafile = (bytes: Buffer, outputName: string, entryPoint: string, product: 'cli' | 'client') => {
      const metadata = JSON.parse(bytes.toString());
      if (!metadata.inputs || !Object.keys(metadata.inputs).length || !metadata.outputs
        || Object.keys(metadata.outputs).length !== 1) fail('compiled metafile graph absent');
      const output = metadata.outputs['./' + outputName];
      const recorded = snapshot.outputs.find((row: any) => row.path === outputName);
      if (!output || !recorded || output.bytes !== recorded.bytes || output.entryPoint !== entryPoint || !output.inputs) fail('metafile compiled output binding mismatch');
      for (const [name, row] of Object.entries(metadata.inputs) as Array<[string, any]>) {
        if (!Number.isSafeInteger(row?.bytes) || row.bytes < 0) fail('invalid metafile input size');
        const trackedName = name.startsWith('src/') ? 'packages/xpod-' + product + '/' + name
          : product === 'cli' && name.startsWith('../../src/') ? name.slice(6) : null;
        if (trackedName && input.readTracked(trackedName).length !== row.bytes) fail('metafile tracked input byte mismatch');
      }
      for (const [name, row] of Object.entries(output.inputs) as Array<[string, any]>) {
        if (!Object.prototype.hasOwnProperty.call(metadata.inputs, name) || !Number.isSafeInteger(row?.bytesInOutput) || row.bytesInOutput < 0) fail('metafile contributing input missing');
      }
    };
    if (role === 'client-build') {
      const row = snapshot.outputs.find((row: any) => row.path === 'inputs.json');
      if (!row) fail('runtime client metafile absent from output archive');
      verifyMetafile(input.readArchiveMember('client', 'package/dist/inputs.json', 4 * 1024 * 1024), 'library.cjs', 'src/index.ts', 'client');
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
      verifyMetafile(bytes, output[0], output[1], 'cli');
    }
  }
  // Preparation JSON must be the actual supervised, hash-closed stdout original.
  const preparation = JSON.parse(bound(producer.preparation).toString());
  if (canonical(JSON.parse(named('phase-009.stdout.raw.log', 262144).toString())) !== canonical(preparation)) fail('preparation differs from command original stdout');
  return { actualOwnedCommandClosureVerified: true, controlledBuildDerivationVerified: true, pending: [], scope };
}
