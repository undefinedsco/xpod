import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import limits from '../module-artifact-limits.json';
type Ref = Readonly<{path: string; bytes: number; sha256: string}>;
function need(value: unknown, why: string): asserts value { if (!value) throw Error('SDK build execution: ' + why); }
/** Actual configure/build process mechanics. No compiler, source or signature
 * authority is inferred from a successful process. Readers are private SDK ZIP readers. */
export function inspectSdkBuildExecution(input: {master: any; members: readonly Ref[]; jobWindow: {start: number; end: number};
  readOriginal(path: string, maximum: number): Buffer; readRange(path: string, offset: number, length: number): Buffer; check(): void}) {
  const members = new Map(input.members.map(row => [row.path, row])); let rawBytes = 0;
  const ref = (value: any): Ref => { input.check(); const row = members.get(value?.path); need(row && row.bytes === value.bytes && row.sha256 === value.sha256, 'same SDK original reference required'); return row; };
  const json = (value: any) => { const row = ref(value); need(row.bytes <= limits.metadataBytes, 'bounded command metadata required');
    const bytes = input.readOriginal(row.path, limits.metadataBytes); need(bytes.length === row.bytes && createHash('sha256').update(bytes).digest('hex') === row.sha256, 'command metadata bytes differ'); return JSON.parse(bytes.toString()); };
  const raw = (value: any) => { const row = ref(value); rawBytes += row.bytes;
    need(row.bytes <= 256 * 1024 ** 2 && rawBytes <= limits.sourceMaterialBytes, 'closed raw byte budget'); const hash = createHash('sha256');
    for (let at = 0; at < row.bytes; at += limits.rangeBytes) { input.check(); const count = Math.min(limits.rangeBytes, row.bytes - at), bytes = input.readRange(row.path, at, count); need(bytes.length === count, 'truncated closed raw'); hash.update(bytes); }
    need(hash.digest('hex') === row.sha256, 'closed raw bytes differ'); return row;
  };
  need(Array.isArray(input.master.stages), 'actual SDK stages unavailable');
  need(Number.isFinite(input.jobWindow.start) && Number.isFinite(input.jobWindow.end) && input.jobWindow.start <= input.jobWindow.end, 'actual SDK job window required');
  let generationMetadataOriginals: Readonly<{collection: Ref; before: Ref; after: Ref}> | undefined;
  if (input.master.inputs?.generationMetadata !== undefined) {
    const pair = input.master.inputs.generationMetadata;
    need(pair && typeof pair === 'object' && isDeepStrictEqual(Object.keys(pair).sort(), ['after', 'before']), 'exact generation metadata before/after pair required');
    const innerRef = members.get('inner/build-inner.json'); need(innerRef, 'actual inner build original required for generation seal');
    const inner = json(innerRef);
    const rootRef = (value: any) => value && {...value, path: 'inner/' + value.path};
    need(inner.schemaVersion === 1 && inner.kind === 'qlever-linux-sdk-inner-originals'
      && isDeepStrictEqual(pair, {before: rootRef(inner.generationMetadata?.before), after: rootRef(inner.generationMetadata?.after)}), 'inner/master generation metadata seal differs');
    const collectionRef = ref(input.master.generationMaterials);
    need(collectionRef.path === 'generation-collection.json', 'fixed generation collection original required');
    const generation = json(collectionRef);
    need(generation.schemaVersion === 1 && generation.kind === 'qlever-sdk-cmake-generation-originals'
      && isDeepStrictEqual(pair.before, generation.beforeMetadata) && isDeepStrictEqual(pair.after, generation.afterMetadata), 'generation input/collection metadata seal differs');
    need(ref(pair.before).path === 'inner/generation/before/inventory.json' && ref(pair.after).path === 'inner/generation/after/inventory.json', 'fixed generation metadata phases required');
    for (const original of [pair.before, pair.after]) { const metadata = json(original); need(metadata.schemaVersion === 1 && Array.isArray(metadata.files), 'actual generation metadata inventory required'); }
    generationMetadataOriginals = Object.freeze({collection: collectionRef, before: ref(pair.before), after: ref(pair.after)});
  }
  const preparedMode = input.master.executionOwners?.sourcePrepare !== undefined || input.master.stages.some((stage: any) => stage.name === 'source-prepare');
  let preparedReference: Ref | undefined;
  if (preparedMode) {
    const ownerReference = ref(input.master.executionOwners?.sourcePrepare);
    need(ownerReference.path === 'inner/owner-source-prepare.guard.json', 'fixed sourcePrepare owner role required');
    const owner = json(ownerReference), cleanup = owner.cleanup;
    need(owner.schemaVersion === 1 && owner.kind === 'linux-kernel-owned-subreaper-guard-original'
      && isDeepStrictEqual(owner.command, ['python3', '/components/qlever/scripts/sdk-inner-materials.py', 'prepare'])
      && owner.guardPid === 1 && Number.isSafeInteger(owner.topCommandPid) && owner.topCommandPid > 1
      && /^pid:\[[0-9]+\]$/u.test(owner.pidNamespace) && owner.topCommandPidNamespace === owner.pidNamespace
      && owner.topCommandActualWait === true && owner.topCommandReturnCode === 0 && owner.reason === null && owner.error === null
      && isDeepStrictEqual(owner.observedSignals, []) && cleanup?.actualEchild === true && isDeepStrictEqual(cleanup.signalledPidfds, []), 'actual sourcePrepare owner closure differs');
    preparedReference = ref(members.get('inner/source-prepared.json'));
    const prepared = json(preparedReference), sourceStages = input.master.stages.filter((stage: any) => stage.name === 'source-prepare');
    const rootStage = (stage: any) => ({...stage, ...Object.fromEntries(['receipt', 'stdout', 'stderr', 'supervisionReceipt', 'supervisionRaw'].map(key => [key, stage[key] && {...stage[key], path: 'inner/' + stage[key].path}])),
      inputs: stage.inputs?.map((row: any) => ({...row, path: 'inner/' + row.path})), outputs: stage.outputs?.map((row: any) => ({...row, path: 'inner/' + row.path}))});
    need(prepared.schemaVersion === 1 && isDeepStrictEqual(prepared.identity, input.master.identity) && prepared.deadlineUnix === owner.globalDeadlineUnix
      && Number.isFinite(prepared.deadlineUnix) && sourceStages.length === 1 && Array.isArray(prepared.stages) && isDeepStrictEqual(prepared.stages.map(rootStage), sourceStages), 'same prepared source stage/identity/deadline seal differs');
    const receipt = json(sourceStages[0].receipt), supervision = json(sourceStages[0].supervisionReceipt);
    need(typeof owner.startedUnixNs === 'string' && /^[0-9]+$/u.test(owner.startedUnixNs)
      && typeof owner.completedUnixNs === 'string' && /^[0-9]+$/u.test(owner.completedUnixNs), 'actual sourcePrepare owner nanosecond window required');
    const ownerStart = BigInt(owner.startedUnixNs), ownerEnd = BigInt(owner.completedUnixNs);
    const rawStart = Date.parse(supervision.startedUTC), rawEnd = Date.parse(supervision.closedUTC);
    need([rawStart, rawEnd].every(Number.isFinite)
      && BigInt(Math.ceil(input.jobWindow.start * 1e6)) <= ownerStart && ownerStart <= ownerEnd
      && ownerEnd <= BigInt(Math.floor(input.jobWindow.end * 1e6))
      && ownerStart <= BigInt(Math.floor(rawStart * 1e6)) && BigInt(Math.ceil(rawEnd * 1e6)) <= ownerEnd
      && ownerStart <= BigInt(receipt.startedUnixNs) && BigInt(receipt.completedUnixNs) <= ownerEnd
      && ownerEnd <= BigInt(Math.floor(prepared.deadlineUnix * 1e9)), 'sourcePrepare owner/job/raw window differs');
  }
  const recipes: [string, string[]][] = [
    ...(preparedMode ? [['source-prepare', ['bash', '/components/qlever/scripts/build-module-runtime-sdk.sh', 'source-only']]] as [string, string[]][] : []),
    ['configure', preparedMode ? ['bash', '/components/qlever/scripts/build-qlever-runtime-sdk.sh', 'configure-prepared'] : ['bash', '/components/qlever/scripts/build-module-runtime-sdk.sh', 'prepare-only']],
    ['compile', ['bash', '/components/qlever/scripts/build-qlever-runtime-sdk.sh', 'build-prepared']],
  ];
  const observations = []; let previousEnd = input.jobWindow.start;
  for (const [name, command] of recipes) {
    const candidates = input.master.stages.filter((row: any) => row.name === name); need(candidates.length === 1, 'unique actual ' + name + ' stage required');
    const stage = candidates[0], root = 'inner/stages/' + name;
    for (const [key, suffix] of [['receipt', '/command.receipt.json'], ['stdout', '/stdout.raw'], ['stderr', '/stderr.raw'], ['supervisionReceipt', '.receipt.json'], ['supervisionRaw', '.raw.log']]) need(stage[key!]?.path === root + suffix, 'fixed ' + name + ' original role differs');
    const actual = json(stage.receipt), supervision = json(stage.supervisionReceipt);
    need(actual.schemaVersion === 1 && isDeepStrictEqual(actual.command, command) && actual.actualWait === true && actual.exit === 0 && actual.signal === null && actual.rawClosedBeforeHash === true
      && Number.isSafeInteger(actual.pid) && actual.pid > 0 && actual.pgid === supervision.pgid && supervision.pid === supervision.pgid && Number.isSafeInteger(supervision.pid) && supervision.pid > 0, 'actual configure/build argv/wait/exit/group differs');
    for (const field of ['stdout', 'stderr']) { const row = raw(stage[field]); need(actual[field]?.path === field + '.raw' && actual[field]?.bytes === row.bytes && actual[field]?.sha256 === row.sha256, 'actual command dual raw reference differs'); }
    const original = raw(stage.supervisionRaw), argv = supervision.command;
    need(Array.isArray(argv) && argv.length === 6 && isDeepStrictEqual(argv.slice(0, 5), ['/usr/bin/python3', '-B', '/components/qlever/scripts/sdk-command-materials.py', '--exec-child', '/opt/qlever-sdk/materials/stages/' + name])
      && isDeepStrictEqual(JSON.parse(argv[5]), command), 'fixed owned command supervisor differs');
    const start = Date.parse(supervision.startedUTC), end = Date.parse(supervision.closedUTC), actualStart = Math.floor(Number(actual.startedUnixNs) / 1e6), actualEnd = Math.floor(Number(actual.completedUnixNs) / 1e6);
    need(supervision.actualWait === true && supervision.exit === 0 && supervision.signal === null && supervision.ownedGroupAbsentAfterWait === true && supervision.rawClosedBeforeHash === true && supervision.rawSHA256 === original.sha256
      && supervision.resourceStop === null && supervision.supervisorError === null && Number.isFinite(supervision.elapsedSeconds) && supervision.elapsedSeconds >= 0
      && Array.isArray(supervision.cleanupErrors) && !supervision.cleanupErrors.length && Array.isArray(supervision.ownedGroupMembers) && !supervision.ownedGroupMembers.length
      && [start, end, actualStart, actualEnd].every(Number.isFinite) && previousEnd <= start && start <= actualStart && actualStart <= actualEnd && actualEnd <= end && end <= input.jobWindow.end, 'configure/build supervision/raw/order/window did not close');
    const expectedInputs = name === 'compile' ? [input.master.inputs?.before, input.master.inputs?.symlinks?.before, ...(generationMetadataOriginals ? [generationMetadataOriginals.before] : [])] : name === 'configure' && preparedReference ? [preparedReference] : [];
    need(expectedInputs.every(Boolean) && Array.isArray(stage.inputs) && isDeepStrictEqual(stage.inputs, expectedInputs) && Array.isArray(stage.outputs) && stage.outputs.length === 0, 'compile before-input/source-link binding differs');
    for (const value of expectedInputs) ref(value);
    observations.push(Object.freeze({name, receipt: ref(stage.receipt), stdout: ref(stage.stdout), stderr: ref(stage.stderr), supervisionReceipt: ref(stage.supervisionReceipt), supervisionRaw: original, inputs: Object.freeze(expectedInputs.map(ref)), start, end})); previousEnd = end;
  }
  input.check(); return Object.freeze({verified: true as const, scope: 'SDK configure/compile actual closed process and retained before-input references' as const, stages: Object.freeze(observations), rawBytes, generationMetadataReferenceSealVerified: generationMetadataOriginals !== undefined, generationMetadataOriginals});
}
