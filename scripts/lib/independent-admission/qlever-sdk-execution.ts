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
  const observations = []; let previousEnd = input.jobWindow.start;
  for (const [name, command] of [['configure', ['bash', '/components/qlever/scripts/build-module-runtime-sdk.sh', 'prepare-only']],
    ['compile', ['bash', '/components/qlever/scripts/build-qlever-runtime-sdk.sh', 'build-prepared']]] as const) {
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
    const expectedInputs = name === 'compile' ? [input.master.inputs?.before, input.master.inputs?.symlinks?.before] : [];
    need(expectedInputs.every(Boolean) && Array.isArray(stage.inputs) && isDeepStrictEqual(stage.inputs, expectedInputs) && Array.isArray(stage.outputs) && stage.outputs.length === 0, 'compile before-input/source-link binding differs');
    for (const value of expectedInputs) ref(value);
    observations.push(Object.freeze({name, receipt: ref(stage.receipt), stdout: ref(stage.stdout), stderr: ref(stage.stderr), supervisionReceipt: ref(stage.supervisionReceipt), supervisionRaw: original, inputs: Object.freeze(expectedInputs.map(ref)), start, end})); previousEnd = end;
  }
  input.check(); return Object.freeze({verified: true as const, scope: 'SDK configure/compile actual closed process and retained before-input references' as const, stages: Object.freeze(observations), rawBytes});
}
