import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inspectSdkBuildExecution, SdkTrackedPhaseOriginalsUnobserved } from '../../scripts/lib/independent-admission/qlever-sdk-execution';
function fixture(generation = false, prepared = false) {
  const rows = new Map<string, Buffer>(), hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const put = (path: string, value: object | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); rows.set(path, bytes); return {path, bytes: bytes.length, sha256: hash(bytes)}; };
  const inputs: any = {before: put('inner/inputs-before.json', {}), symlinks: {before: put('inner/symlinks-before.json', {})}};
  const generationMetadata = generation ? {before: put('inner/generation/before/inventory.json', {schemaVersion: 1, files: []}), after: put('inner/generation/after/inventory.json', {schemaVersion: 1, files: []})} : undefined;
  const generationMaterials = generationMetadata ? put('generation-collection.json', {schemaVersion: 1, kind: 'qlever-sdk-cmake-generation-originals', beforeMetadata: generationMetadata.before, afterMetadata: generationMetadata.after}) : undefined;
  if (generationMetadata) {
    inputs.generationMetadata = generationMetadata;
    const innerRef = (value: any) => ({...value, path: value.path.slice('inner/'.length)});
    put('inner/build-inner.json', {schemaVersion: 1, kind: 'qlever-linux-sdk-inner-originals', generationMetadata: {before: innerRef(generationMetadata.before), after: innerRef(generationMetadata.after)}});
  }
  let preparedReference: any;
  const stages = (prepared ? ['source-prepare', 'configure', 'compile'] : ['configure', 'compile']).map((name, index) => {
    const root = 'inner/stages/' + name, command = ['bash', '/components/qlever/scripts/' + (name === 'compile' || prepared && name === 'configure' ? 'build-qlever-runtime-sdk.sh' : 'build-module-runtime-sdk.sh'), name === 'compile' ? 'build-prepared' : name === 'source-prepare' ? 'source-only' : prepared ? 'configure-prepared' : 'prepare-only'];
    const stdout = put(root + '/stdout.raw', Buffer.alloc(70000, 65)), stderr = put(root + '/stderr.raw', Buffer.alloc(0)), supervisionRaw = put(root + '.raw.log', Buffer.from('closed'));
    const start = 10000 + index * 10000;
    const receipt = put(root + '/command.receipt.json', {schemaVersion: 1, command, pid: 42, pgid: 41, actualWait: true, exit: 0, signal: null, rawClosedBeforeHash: true, startedUnixNs: (start + 1000) * 1e6, completedUnixNs: (start + 2000) * 1e6,
      stdout: {...stdout, path: 'stdout.raw'}, stderr: {...stderr, path: 'stderr.raw'}});
    const supervisionReceipt = put(root + '.receipt.json', {command: ['/usr/bin/python3', '-B', '/components/qlever/scripts/sdk-command-materials.py', '--exec-child', '/opt/qlever-sdk/materials/stages/' + name, JSON.stringify(command)], pid: 41, pgid: 41, actualWait: true, exit: 0, signal: null, ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true,
      rawSHA256: supervisionRaw.sha256, resourceStop: null, supervisorError: null, elapsedSeconds: 3, cleanupErrors: [], ownedGroupMembers: [], startedUTC: new Date(start).toISOString(), closedUTC: new Date(start + 3000).toISOString()});
    return {name, receipt, stdout, stderr, supervisionReceipt, supervisionRaw, inputs: name === 'compile' ? [inputs.before, inputs.symlinks.before, ...(generationMetadata ? [generationMetadata.before] : [])] : [], outputs: []};
  });
  const identity = {sourceSha: 'a'.repeat(40)}, executionOwners: any = {};
  if (prepared) {
    preparedReference = put('inner/source-prepared.json', {schemaVersion: 1, identity, deadlineUnix: 200, stages: [{...stages[0], ...Object.fromEntries(['receipt', 'stdout', 'stderr', 'supervisionReceipt', 'supervisionRaw'].map(key => [key, {...(stages[0] as any)[key], path: (stages[0] as any)[key].path.slice(6)}]))}]});
    stages[1]!.inputs = [preparedReference];
    executionOwners.sourcePrepare = put('inner/owner-source-prepare.guard.json', {schemaVersion: 1, kind: 'linux-kernel-owned-subreaper-guard-original',
      command: ['python3', '/components/qlever/scripts/sdk-inner-materials.py', 'prepare'], guardPid: 1, topCommandPid: 2, pidNamespace: 'pid:[10]', topCommandPidNamespace: 'pid:[10]',
      topCommandActualWait: true, topCommandReturnCode: 0, reason: null, error: null, observedSignals: [], cleanup: {actualEchild: true, signalledPidfds: []},
      globalDeadlineUnix: 200, startedUnixNs: '10000000000', completedUnixNs: '13000000000'});
  }
  const input = {master: {stages, inputs, identity, executionOwners, ...(generationMaterials ? {generationMaterials} : {})}, members: [...rows].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)})), jobWindow: {start: 0, end: 40000}, check() {},
    readOriginal(path: string, maximum: number) { const bytes = rows.get(path)!; if (bytes.length > maximum) throw Error('large metadata'); return bytes; },
    readRange(path: string, offset: number, length: number) { expect(length).toBeLessThanOrEqual(65536); return rows.get(path)!.subarray(offset, offset + length); }};
  const mutate = (path: string, fn: (value: any) => void) => { const value = JSON.parse(rows.get(path)!.toString()); fn(value); const bytes = Buffer.from(JSON.stringify(value)); rows.set(path, bytes); const ref = {path, bytes: bytes.length, sha256: hash(bytes)}; Object.assign(input.members.find(row => row.path === path)!, ref); for (const value of Object.values(executionOwners) as any[]) if (value.path === path) Object.assign(value, ref); if (preparedReference?.path === path) Object.assign(preparedReference, ref); for (const stage of stages) for (const key of ['receipt', 'supervisionReceipt'] as const) if (stage[key]?.path === path) Object.assign(stage[key], ref); };
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

it('seals the new exact third generation input without granting generated IO closure to legacy records', () => {
  expect(inspectSdkBuildExecution(fixture().input).generationMetadataReferenceSealVerified).toBe(false);
  const current = inspectSdkBuildExecution(fixture(true).input);
  expect(current.generationMetadataReferenceSealVerified).toBe(true);
  expect(current.stages[1]!.inputs).toHaveLength(3);
  for (const modify of [
    (x: ReturnType<typeof fixture>) => {x.input.master.stages[1]!.inputs.pop();},
    (x: ReturnType<typeof fixture>) => {x.input.master.stages[1]!.inputs.push(x.input.master.inputs.before);},
    (x: ReturnType<typeof fixture>) => {x.input.master.inputs.generationMetadata.after = x.input.master.inputs.generationMetadata.before;},
    (x: ReturnType<typeof fixture>) => {delete x.input.master.generationMaterials;},
    (x: ReturnType<typeof fixture>) => {x.input.master.inputs.generationMetadata = null;},
    (x: ReturnType<typeof fixture>) => {x.input.master.stages[1]!.inputs.reverse();},
    (x: ReturnType<typeof fixture>) => x.mutate('inner/build-inner.json', value => {value.generationMetadata.after = value.generationMetadata.before;}),
  ]) { const value = fixture(true); modify(value); expect(() => inspectSdkBuildExecution(value.input)).toThrow(); }
  const legacyExtra = fixture(); legacyExtra.input.master.stages[1]!.inputs.push(legacyExtra.input.master.inputs.before);
  expect(() => inspectSdkBuildExecution(legacyExtra.input)).toThrow();
});

it('binds closed sourcePrepare before configure-prepared and retains exact compile inputs', () => {
  const value = fixture(true, true); const result = inspectSdkBuildExecution(value.input);
  expect(result.stages.map(stage => stage.name)).toEqual(['source-prepare', 'configure', 'compile']);
  expect(result.stages[2]!.inputs).toHaveLength(3);
  for (const change of [
    (x: ReturnType<typeof fixture>) => {delete x.input.master.executionOwners.sourcePrepare;},
    (x: ReturnType<typeof fixture>) => {x.input.master.stages[1]!.inputs = [];},
    (x: ReturnType<typeof fixture>) => x.mutate('inner/source-prepared.json', row => {row.deadlineUnix++;}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/owner-source-prepare.guard.json', row => {row.cleanup.actualEchild = false;}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/owner-source-prepare.guard.json', row => {row.startedUnixNs = '1'; row.completedUnixNs = '50000000000';}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/owner-source-prepare.guard.json', row => {row.startedUnixNs = '11000000000';}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/owner-source-prepare.guard.json', row => {row.completedUnixNs = '12000000000';}),
    (x: ReturnType<typeof fixture>) => x.mutate('inner/stages/source-prepare/command.receipt.json', row => {row.command[2] = 'configure-prepared';}),
  ]) { const x = fixture(true, true); change(x); expect(() => inspectSdkBuildExecution(x.input)).toThrow(); }
});

function trackedFixture(){
 const value=fixture(true,true),put=(path:string,row:any)=>{const bytes=Buffer.from(JSON.stringify(row)),ref={path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};value.rows.set(path,bytes);const existing=value.input.members.find(item=>item.path===path);if(existing)Object.assign(existing,ref);else value.input.members.push(ref);return ref;};
 for(const stage of value.input.master.stages.filter(row=>row.name!=='source-prepare') as any[]){
  const actual=JSON.parse(value.rows.get(stage.receipt.path)!.toString());actual.actualExecutable='/usr/bin/bash';actual.startedUnixNs=String(actual.startedUnixNs);actual.completedUnixNs=String(actual.completedUnixNs);stage.receipt=put(stage.receipt.path,actual);
  stage.closureKind='ptrace-tracked-phase-v1';delete stage.supervisionReceipt;delete stage.supervisionRaw;
  stage.rawTraceShards=[put('inner/toolchain-execution/'+stage.name+'.trace.jsonl',{schemaFixtureOnly:true})];
  stage.trackingReceipt=put('inner/stages/'+stage.name+'/tracking.receipt.json',{schemaVersion:1,kind:'sdk-observer-tracked-phase-original',phase:stage.name,command:actual.command,observerPid:40,actualRootPid:actual.pid,actualRootReturnCode:0,actualTrackedWait:true,trackedProcessesClosed:true,deadlineMonotonic:200,startedUnixNs:actual.startedUnixNs,completedUnixNs:actual.completedUnixNs,waitReferences:[{pid:actual.pid,sequence:1,returnCode:0,phase:stage.name}]});
 }
 return {value,put};
}
it('recognizes only the complete typed envelope as unobserved, never as closed-group approval',()=>{
 expect(()=>inspectSdkBuildExecution(trackedFixture().value.input)).toThrow(SdkTrackedPhaseOriginalsUnobserved);
 for(const change of [
  (x:ReturnType<typeof trackedFixture>)=>{(x.value.input.master.stages[1] as any).closureKind='caller-approved';},
  (x:ReturnType<typeof trackedFixture>)=>{(x.value.input.master.stages[1] as any).closureKind=undefined;},
  (x:ReturnType<typeof trackedFixture>)=>x.value.mutate('inner/stages/configure/command.receipt.json',row=>{row.signal=9;}),
  (x:ReturnType<typeof trackedFixture>)=>{x.value.input.readRange=()=>{throw Error('revoked original reader');};},
 ]){const x=trackedFixture();change(x);let caught:unknown;try{inspectSdkBuildExecution(x.value.input);}catch(error){caught=error;}expect(caught).toBeInstanceOf(Error);expect(caught).not.toBeInstanceOf(SdkTrackedPhaseOriginalsUnobserved);}
 const legacy=fixture();legacy.mutate('inner/stages/compile/command.receipt.json',row=>{row.exit=1;});
 let caught:unknown;try{inspectSdkBuildExecution(legacy.input);}catch(error){caught=error;}expect(caught).toBeInstanceOf(Error);expect(caught).not.toBeInstanceOf(SdkTrackedPhaseOriginalsUnobserved);
});
