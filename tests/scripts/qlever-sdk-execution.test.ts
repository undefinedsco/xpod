import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inspectSdkBuildExecution } from '../../scripts/lib/independent-admission/qlever-sdk-execution';
function fixture() {
  const rows = new Map<string, Buffer>(), hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const put = (path: string, value: object | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); rows.set(path, bytes); return {path, bytes: bytes.length, sha256: hash(bytes)}; };
  const inputs = {before: put('inner/inputs-before.json', {}), symlinks: {before: put('inner/symlinks-before.json', {})}};
  const stages = ['configure', 'compile'].map((name, index) => {
    const root = 'inner/stages/' + name, command = ['bash', '/components/qlever/scripts/' + (index ? 'build-qlever-runtime-sdk.sh' : 'build-module-runtime-sdk.sh'), index ? 'build-prepared' : 'prepare-only'];
    const stdout = put(root + '/stdout.raw', Buffer.alloc(70000, 65)), stderr = put(root + '/stderr.raw', Buffer.alloc(0)), supervisionRaw = put(root + '.raw.log', Buffer.from('closed'));
    const start = 10000 + index * 10000;
    const receipt = put(root + '/command.receipt.json', {schemaVersion: 1, command, pid: 42, pgid: 41, actualWait: true, exit: 0, signal: null, rawClosedBeforeHash: true, startedUnixNs: (start + 1000) * 1e6, completedUnixNs: (start + 2000) * 1e6,
      stdout: {...stdout, path: 'stdout.raw'}, stderr: {...stderr, path: 'stderr.raw'}});
    const supervisionReceipt = put(root + '.receipt.json', {command: ['/usr/bin/python3', '-B', '/components/qlever/scripts/sdk-command-materials.py', '--exec-child', '/opt/qlever-sdk/materials/stages/' + name, JSON.stringify(command)], pid: 41, pgid: 41, actualWait: true, exit: 0, signal: null, ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true,
      rawSHA256: supervisionRaw.sha256, resourceStop: null, supervisorError: null, elapsedSeconds: 3, cleanupErrors: [], ownedGroupMembers: [], startedUTC: new Date(start).toISOString(), closedUTC: new Date(start + 3000).toISOString()});
    return {name, receipt, stdout, stderr, supervisionReceipt, supervisionRaw, inputs: index ? [inputs.before, inputs.symlinks.before] : [], outputs: []};
  });
  const input = {master: {stages, inputs}, members: [...rows].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)})), jobWindow: {start: 0, end: 40000}, check() {},
    readOriginal(path: string, maximum: number) { const bytes = rows.get(path)!; if (bytes.length > maximum) throw Error('large metadata'); return bytes; },
    readRange(path: string, offset: number, length: number) { expect(length).toBeLessThanOrEqual(65536); return rows.get(path)!.subarray(offset, offset + length); }};
  const mutate = (path: string, fn: (value: any) => void) => { const value = JSON.parse(rows.get(path)!.toString()); fn(value); const bytes = Buffer.from(JSON.stringify(value)); rows.set(path, bytes); const ref = {path, bytes: bytes.length, sha256: hash(bytes)}; Object.assign(input.members.find(row => row.path === path)!, ref); for (const stage of stages) for (const key of ['receipt', 'supervisionReceipt'] as const) if (stage[key].path === path) Object.assign(stage[key], ref); };
  return {input, rows, mutate};
}
it('positively verifies actual SDK configure/compile closed process and exact before inputs', () => {
  const value = inspectSdkBuildExecution(fixture().input); expect(value.verified).toBe(true); expect(value.stages.map(row => row.name)).toEqual(['configure', 'compile']); expect(value.rawBytes).toBe(140012);
});
it('rejects self-consistent failure, false recipe, wrong ordering, missing before binding and changed raw', () => {
  for (const modify of [
    (x: ReturnType<typeof fixture>) => x.mutate('inner/stages/compile/command.receipt.json', value => {value.exit = 1;}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/stages/compile/command.receipt.json', value => {value.command[2] = 'prepare-only';}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/stages/compile.receipt.json', value => {value.ownedGroupAbsentAfterWait = false;}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/stages/compile.receipt.json', value => {value.startedUTC = new Date(0).toISOString();}),
    (x: ReturnType<typeof fixture>) => {x.input.master.stages[1]!.inputs = [];},
    (x: ReturnType<typeof fixture>) => {x.rows.set('inner/stages/compile/stdout.raw', Buffer.from('changed'));},
    (x: ReturnType<typeof fixture>) => {x.input.jobWindow.end = 22000;},
  ]) { const value = fixture(); modify(value); expect(() => inspectSdkBuildExecution(value.input)).toThrow(); }
});
